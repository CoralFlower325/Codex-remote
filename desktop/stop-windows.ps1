[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$rootPrefix = $root.TrimEnd('\') + '\'
$tasks = @(
  Get-ScheduledTask -TaskName "CodexRemote" -ErrorAction SilentlyContinue
  Get-ScheduledTask -TaskName "CodexRemoteTunnel" -ErrorAction SilentlyContinue
)

foreach ($task in $tasks) {
  $owner = [IO.Path]::GetFullPath($task.Actions.WorkingDirectory).TrimEnd('\')
  if ($owner -ne $root) {
    throw "Scheduled task $($task.TaskName) belongs to another installation: $owner"
  }
}

function Get-OwnedProcesses {
  Get-CimInstance Win32_Process -Filter "Name LIKE 'node%.exe' OR Name = 'cloudflared.exe' OR Name = 'powershell.exe' OR Name = 'wscript.exe'" |
    Where-Object {
      $line = $_.CommandLine
      if (-not $line -or -not $line.Contains($rootPrefix)) { return $false }
      ($_.Name -like "node*.exe" -and $line -match '(?:^|\s)"?server"? (?:\s|$)') -or
        ($_.Name -like "node*.exe" -and $line -match '(?:^|\s)"?tunnel"?(?:\s|$)') -or
        ($_.Name -like "node*.exe" -and $line.Contains((Join-Path $root "dist-server\server\cli\tunnel-supervisor.js"))) -or
        ($_.Name -eq "cloudflared.exe" -and $line.Contains((Join-Path $root "data\cloudflared-token"))) -or
        ($_.Name -eq "powershell.exe" -and $line.Contains((Join-Path $root "scripts\watch-network-windows.ps1"))) -or
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
