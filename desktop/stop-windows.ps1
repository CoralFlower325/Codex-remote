[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$rootPrefix = $root.TrimEnd('\') + '\'
$tasks = @(
  Get-ScheduledTask -TaskName "CodexRemote" -ErrorAction SilentlyContinue
  Get-ScheduledTask -TaskName "CodexRemoteTunnel" -ErrorAction SilentlyContinue
)
$ssh = @{ managed = $false; taskName = "CodexRemoteDomesticTunnel"; key = ""; host = ""; remotePort = 14545; localPort = 4545 }
$envPath = Join-Path $root ".env"
if (Test-Path -LiteralPath $envPath) {
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines($envPath, [Text.Encoding]::UTF8)) {
    $match = [regex]::Match($line, '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$')
    if (-not $match.Success) { continue }
    $value = $match.Groups[2].Value
    if ($value.Length -ge 2 -and (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$match.Groups[1].Value] = $value
  }
  $ssh.managed = [string]$values["SSH_TUNNEL_MANAGED"] -match '^(?i:1|true|yes|on)$'
  if ($values["SSH_TUNNEL_TASK"]) { $ssh.taskName = [string]$values["SSH_TUNNEL_TASK"] }
  $ssh.key = [string]$values["SSH_TUNNEL_KEY"]
  $ssh.host = [string]$values["SSH_TUNNEL_HOST"]
  $local = [string]$values["SSH_TUNNEL_LOCAL_PORT"]
  if (-not $local) { $local = [string]$values["PORT"] }
  if ($local) { [void][int]::TryParse($local, [ref]$ssh.localPort) }
  $remote = [string]$values["SSH_TUNNEL_REMOTE_PORT"]
  if ($remote) { [void][int]::TryParse($remote, [ref]$ssh.remotePort) }
}
$sshTask = if ($ssh.managed) { Get-ScheduledTask -TaskName $ssh.taskName -ErrorAction SilentlyContinue } else { $null }
$sshTaskOwned = $false
if ($sshTask) {
  foreach ($action in @($sshTask.Actions)) {
    $arguments = [string]$action.Arguments
    $keyPath = if ($ssh.key) { [IO.Path]::GetFullPath($ssh.key) } else { "" }
    if ($keyPath -and ($arguments.Contains($keyPath) -or $arguments.Contains($ssh.key)) -and
        $arguments.Contains($ssh.host) -and
        $arguments.Contains("-R 127.0.0.1:$($ssh.remotePort):127.0.0.1:$($ssh.localPort)")) {
      $sshTaskOwned = $true
    }
    if ($arguments.Contains((Join-Path $root "data\codex-remote-manager\ssh-tunnel-supervisor.ps1"))) {
      $sshTaskOwned = $true
    }
  }
  if (-not $sshTaskOwned) { throw "Scheduled task $($ssh.taskName) belongs to another configuration." }
  $tasks += $sshTask
}

foreach ($task in $tasks) {
  if ($task -and $task.TaskName -eq $ssh.taskName) { continue }
  $owner = [IO.Path]::GetFullPath($task.Actions.WorkingDirectory).TrimEnd('\')
  if ($owner -ne $root) {
    throw "Scheduled task $($task.TaskName) belongs to another installation: $owner"
  }
}

function Get-OwnedProcesses {
  Get-CimInstance Win32_Process -Filter "Name LIKE 'node%.exe' OR Name = 'cloudflared.exe' OR Name = 'powershell.exe' OR Name = 'wscript.exe' OR Name = 'ssh.exe'" |
    Where-Object {
      $line = $_.CommandLine
      if (-not $line) { return $false }
      $keyPath = if ($ssh.key) { [IO.Path]::GetFullPath($ssh.key) } else { "" }
      $ownedSsh = $_.Name -eq "ssh.exe" -and $keyPath -and
        ($line.Contains($keyPath) -or $line.Contains($ssh.key)) -and
        $line.Contains($ssh.host) -and
        $line.Contains("-R 127.0.0.1:$($ssh.remotePort):127.0.0.1:$($ssh.localPort)")
      if (-not $line.Contains($rootPrefix) -and -not $ownedSsh) { return $false }
      ($_.Name -like "node*.exe" -and $line -match '(?:^|\s)"?server"? (?:\s|$)') -or
        ($_.Name -like "node*.exe" -and $line -match '(?:^|\s)"?tunnel"?(?:\s|$)') -or
        ($_.Name -like "node*.exe" -and $line.Contains((Join-Path $root "dist-server\server\cli\tunnel-supervisor.js"))) -or
        ($_.Name -eq "cloudflared.exe" -and $line.Contains((Join-Path $root "data\cloudflared-token"))) -or
        ($_.Name -eq "powershell.exe" -and $line.Contains((Join-Path $root "scripts\watch-network-windows.ps1"))) -or
        ($_.Name -eq "powershell.exe" -and $line.Contains((Join-Path $root "data\codex-remote-manager\ssh-tunnel-supervisor.ps1"))) -or
        $ownedSsh -or
        ($_.Name -eq "wscript.exe" -and $line.Contains((Join-Path $root "scripts\run-hidden-windows.vbs")))
    }
}

$owned = @(Get-OwnedProcesses)
foreach ($task in $tasks) {
  Disable-ScheduledTask -TaskName $task.TaskName | Out-Null
  Stop-ScheduledTask -TaskName $task.TaskName
}

foreach ($item in $owned) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.ProcessId)" -ErrorAction SilentlyContinue
  if ($current -and $current.CommandLine -eq $item.CommandLine) {
    Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$deadline = [DateTime]::UtcNow.AddSeconds(20)
do {
  $remaining = @(Get-OwnedProcesses)
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 300
} while ([DateTime]::UtcNow -lt $deadline)

if ($remaining.Count -gt 0) {
  throw "Remote processes are still exiting: $($remaining.ProcessId -join ', ')"
}

@{ stopped = $true; tasks = @($tasks.TaskName) } | ConvertTo-Json -Compress
