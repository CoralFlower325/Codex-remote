[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName "CodexRemote" -ErrorAction SilentlyContinue
$tunnel = Get-ScheduledTask -TaskName "CodexRemoteTunnel" -ErrorAction SilentlyContinue
$entry = Join-Path $Root "dist-server\server\index.js"
$backend = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) })
@{
  installed = [bool]$task
  running = [bool]($backend.Count -gt 0)
  enabled = [bool]($task -and $task.State -ne "Disabled")
  conflict = [bool](($task -and $task.Actions.WorkingDirectory -ne $Root) -or
    ($tunnel -and $tunnel.Actions.WorkingDirectory -ne $Root))
  tunnelManaged = [bool](Test-Path -LiteralPath (Join-Path $Root "data\cloudflared-token"))
} | ConvertTo-Json -Compress
