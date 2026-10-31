param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][ValidateSet("Status", "Start", "Stop")][string]$Action
)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$task = Get-ScheduledTask -TaskName "CodexRemote" -ErrorAction SilentlyContinue
$conflict = [bool]($task -and [IO.Path]::GetFullPath($task.Actions.WorkingDirectory).TrimEnd('\') -ne $Root)
$entry = Join-Path $Root "dist-server\server\index.js"
$background = Join-Path $Root "scripts\background-task-windows.mjs"
function Get-OwnedProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -and ($_.CommandLine.Contains($entry) -or
      ($_.CommandLine.Contains($background) -and $_.CommandLine -match '(?:^|\s)"?server"?(?:\s|$)'))
  })
}
$owned = @(Get-OwnedProcesses)
$backends = @($owned | Where-Object { $_.CommandLine.Contains($entry) })
if ($Action -eq "Status") {
  @{ installed = [bool]$task; conflict = $conflict; enabled = [bool]($task -and $task.State -ne "Disabled");
     running = [bool]$backends.Count; pids = @($backends | ForEach-Object { [int]$_.ProcessId }) } |
    ConvertTo-Json -Compress
  return
}
if (-not $task -or $conflict) { throw "Remote service is absent or belongs to another installation." }
if ($Action -eq "Stop") {
  Disable-ScheduledTask -TaskName "CodexRemote" | Out-Null
  Stop-ScheduledTask -TaskName "CodexRemote"
  foreach ($item in $owned) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.ProcessId)"
    if ($current -and $current.CommandLine -eq $item.CommandLine) {
      Stop-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    }
  }
} else {
  if ($backends.Count) { throw "Old backend has not exited." }
  Enable-ScheduledTask -TaskName "CodexRemote" | Out-Null
  Start-ScheduledTask -TaskName "CodexRemote"
}
