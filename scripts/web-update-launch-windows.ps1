param([Parameter(Mandatory = $true)][string]$Request)
$ErrorActionPreference = "Stop"
$config = [IO.File]::ReadAllText($Request, [Text.Encoding]::UTF8) | ConvertFrom-Json
$job = Split-Path -Parent $Request
function Quote-Argument([string]$value) {
  '"' + [regex]::Replace([regex]::Replace($value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
$entry = Join-Path $job "scripts\web-update-worker.mjs"
$line = (Quote-Argument $config.node) + ' ' + (Quote-Argument $entry) + ' ' + (Quote-Argument $Request)
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
# WMI owns the new process, independently of the Remote scheduled task's tree.
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $line; CurrentDirectory = $job; ProcessStartupInformation = $startup
}
if ($result.ReturnValue -ne 0) { throw "Independent update launch failed: $($result.ReturnValue)" }
Write-Output $result.ProcessId
