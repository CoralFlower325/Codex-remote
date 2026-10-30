[CmdletBinding()]
param(
  [switch]$Unregister,
  [switch]$NoStart,
  [ValidateSet("auto", "http2", "quic")]
  [string]$TunnelProtocol = "http2"
)

$ErrorActionPreference = "Stop"
$ServerTaskName = "CodexRemote"
$TunnelTaskName = "CodexRemoteTunnel"

if ($env:OS -ne "Windows_NT") {
  throw "This script is only supported on Windows."
}

if ($Unregister) {
  foreach ($taskName in @($ServerTaskName, $TunnelTaskName)) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  Write-Host "Removed Codex Remote scheduled tasks."
  return
}

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
foreach ($taskName in @($ServerTaskName, $TunnelTaskName)) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing -and $existing.Actions.WorkingDirectory -ne $Root) {
    throw "Scheduled task $taskName belongs to another checkout."
  }
}
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser

function Register-CodexRemoteTask {
  param(
    [string]$TaskName,
    [string]$Executable,
    [string]$Arguments,
    [string]$Description
  )

  $action = New-ScheduledTaskAction `
    -Execute (Join-Path $env:WINDIR "System32\wscript.exe") `
    -Argument "//B //Nologo `"$(Join-Path $PSScriptRoot 'run-hidden-windows.vbs')`" `"$Executable`" `"$(Join-Path $PSScriptRoot 'background-task-windows.mjs')`" $Arguments" `
    -WorkingDirectory $Root
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description $Description `
    -Force | Out-Null
  if (-not $NoStart) { Start-ScheduledTask -TaskName $TaskName }
  Write-Host "Installed background scheduled task $TaskName."
}

$entryPoint = Join-Path $Root "dist-server\server\index.js"
if (-not (Test-Path $entryPoint)) {
  throw "Build output is missing. Run npm run build first."
}
if ((Test-Path (Join-Path $Root "data\cloudflared-token")) -and
    -not (Test-Path (Join-Path $Root "dist-server\server\cli\tunnel-supervisor.js"))) {
  throw "Tunnel supervisor build is missing. Run npm run build first."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "node was not found in PATH."
}

Register-CodexRemoteTask `
  -TaskName $ServerTaskName `
  -Executable $node.Source `
  -Arguments "server" `
  -Description "Codex Remote local server"

$tokenFile = Join-Path $Root "data\cloudflared-token"
if (Test-Path $tokenFile) {
  $cloudflaredPath = Join-Path $env:ProgramFiles "cloudflared\cloudflared.exe"
  if (-not (Test-Path $cloudflaredPath)) {
    $cloudflaredPath = Join-Path ${env:ProgramFiles(x86)} "cloudflared\cloudflared.exe"
  }
  if (-not (Test-Path $cloudflaredPath)) {
    $cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
    if (-not $cloudflaredCommand) {
      throw "cloudflared is required for the tunnel task."
    }
    $cloudflaredPath = $cloudflaredCommand.Source
  }

  Register-CodexRemoteTask `
    -TaskName $TunnelTaskName `
    -Executable $node.Source `
    -Arguments "tunnel `"$cloudflaredPath`" $TunnelProtocol" `
    -Description "Codex Remote Cloudflare Tunnel"
}

$port = if ($env:PORT) { $env:PORT } else { "4545" }
Write-Host "Open: http://127.0.0.1:$port"
Write-Host "Remove with: npm run uninstall-task:windows"
