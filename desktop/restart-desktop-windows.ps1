[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$ExecutablePath
)

$ErrorActionPreference = "Stop"
$record = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
if (-not $record -or -not $record.ExecutablePath -or
    [string]::Equals($record.ExecutablePath, $ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -eq $false -or
    $record.CommandLine -match "--type=") {
  throw "Desktop process identity changed; refusing to stop it."
}

$process = Get-Process -Id $ProcessId -ErrorAction Stop
$closed = $process.CloseMainWindow()
if ($closed -and $process.WaitForExit(5000)) {
  exit 0
}
& taskkill.exe /PID $ProcessId /T /F | Out-Null
if (-not $process.WaitForExit(5000)) {
  throw "Desktop process did not exit."
}
