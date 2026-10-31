param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][ValidateSet("Server", "Tunnel")][string]$Target
)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$taskName = if ($Target -eq "Server") { "CodexRemote" } else { "CodexRemoteTunnel" }
$role = if ($Target -eq "Server") { "server" } else { "tunnel" }
$task = Get-ScheduledTask -TaskName $taskName
if ([IO.Path]::GetFullPath($task.Actions.WorkingDirectory).TrimEnd('\') -ne $Root) { throw "Service belongs to another installation." }
if ($task.State -eq "Disabled") { throw "Service is explicitly disabled. Start Remote first." }
$entry = Join-Path $Root "dist-server\server\index.js"
$supervisor = Join-Path $Root "dist-server\server\cli\tunnel-supervisor.js"
$token = Join-Path $Root "data\cloudflared-token"
$background = Join-Path $Root "scripts\background-task-windows.mjs"
$watcher = Join-Path $Root "scripts\watch-network-windows.ps1"
if ($Target -eq "Tunnel" -and -not (Test-Path -LiteralPath $token)) { throw "No managed tunnel." }
function Get-OwnedProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'cloudflared.exe' OR Name = 'powershell.exe'" |
    Where-Object {
      $line = $_.CommandLine
      $line -and (
        ($_.Name -eq "node.exe" -and $line.Contains($background) -and $line -match "(?:^|\s)`"?$role`"?(?:\s|$)") -or
        ($Target -eq "Server" -and $_.Name -eq "node.exe" -and $line.Contains($entry)) -or
        ($Target -eq "Tunnel" -and (
          ($_.Name -eq "node.exe" -and $line.Contains($supervisor)) -or
          ($_.Name -eq "cloudflared.exe" -and $line.Contains($token)) -or
          ($_.Name -eq "powershell.exe" -and $line.Contains($watcher))
        ))
      )
    }
}
$owned = @(Get-OwnedProcesses)
Stop-ScheduledTask -TaskName $taskName
foreach ($item in $owned) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.ProcessId)"
  if ($current -and $current.CommandLine -eq $item.CommandLine) { Stop-Process -Id $item.ProcessId -ErrorAction SilentlyContinue }
}
$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
  $remaining = @(Get-OwnedProcesses)
  if (-not $remaining) { break }
  Start-Sleep -Milliseconds 300
} while ([DateTime]::UtcNow -lt $deadline)
if ($remaining) { throw "Owned service process is still exiting." }
Start-ScheduledTask -TaskName $taskName
