[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [Parameter(Mandatory = $true)]
  [ValidateSet("Status", "Start", "Stop", "Repair")]
  [string]$Action
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$envPath = Join-Path $Root ".env"
if (-not (Test-Path -LiteralPath $envPath)) { throw "The selected installation has no .env file." }

function Read-DotEnv {
  param([string]$Path)
  $values = @{}
  foreach ($line in [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)) {
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
  return $values
}

function Get-TunnelConfig {
  $values = Read-DotEnv $envPath
  $managedValue = [string]$values["SSH_TUNNEL_MANAGED"]
  if ($managedValue -notmatch '^(?i:1|true|yes|on)$') {
    return @{ managed = $false }
  }
  $hostName = [string]$values["SSH_TUNNEL_HOST"]
  $userName = [string]$values["SSH_TUNNEL_USER"]
  $keyPath = [string]$values["SSH_TUNNEL_KEY"]
  $taskName = [string]$values["SSH_TUNNEL_TASK"]
  if (-not $taskName) { $taskName = "CodexRemoteDomesticTunnel" }
  $remotePort = 14545
  $localPortValue = [string]$values["PORT"]
  if (-not $localPortValue) { $localPortValue = "4545" }
  $localPort = 4545
  if ([string]$values["SSH_TUNNEL_LOCAL_PORT"]) {
    $localPortValue = [string]$values["SSH_TUNNEL_LOCAL_PORT"]
  }
  if ([string]$values["SSH_TUNNEL_REMOTE_PORT"]) {
    if (-not [int]::TryParse([string]$values["SSH_TUNNEL_REMOTE_PORT"], [ref]$remotePort)) {
      throw "SSH_TUNNEL_REMOTE_PORT is invalid."
    }
  }
  if (-not [int]::TryParse($localPortValue, [ref]$localPort)) {
    throw "SSH_TUNNEL_LOCAL_PORT or PORT is invalid."
  }
  if (-not $hostName -or -not $userName -or -not $keyPath) {
    throw "Managed SSH tunnel requires host, user and key path."
  }
  if ($hostName -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$') {
    throw "SSH_TUNNEL_HOST is invalid."
  }
  if ($userName -notmatch '^[A-Za-z_][A-Za-z0-9_-]*$') {
    throw "SSH_TUNNEL_USER is invalid."
  }
  if ($taskName -notmatch '^CodexRemote[A-Za-z0-9_-]{1,80}$') {
    throw "SSH_TUNNEL_TASK is invalid."
  }
  if ($remotePort -lt 1 -or $remotePort -gt 65535 -or $localPort -lt 1 -or $localPort -gt 65535) {
    throw "SSH tunnel ports must be from 1 to 65535."
  }
  if (-not (Test-Path -LiteralPath $keyPath)) {
    throw "SSH private key was not found at the configured path."
  }
  return @{
    managed = $true
    host = $hostName
    user = $userName
    key = $keyPath
    taskName = $taskName
    remotePort = $remotePort
    localPort = $localPort
  }
}

function Get-SshExecutable {
  $candidate = Join-Path $env:WINDIR "System32\OpenSSH\ssh.exe"
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  $command = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "OpenSSH ssh.exe is required."
}

function Get-Task {
  param([string]$Name)
  return Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
}

function Test-LegacyTask {
  param($Task, $Config)
  if (-not $Task) { return $false }
  $keyPath = [IO.Path]::GetFullPath($Config.key)
  foreach ($action in @($Task.Actions)) {
    if ([IO.Path]::GetFileName([string]$action.Execute) -ne "ssh.exe") { continue }
    $arguments = [string]$action.Arguments
    if (($arguments.Contains($keyPath) -or $arguments.Contains($Config.key)) -and
        $arguments.Contains($Config.host) -and
        $arguments.Contains("-R 127.0.0.1:$($Config.remotePort):127.0.0.1:$($Config.localPort)")) {
      return $true
    }
  }
  return $false
}

function Get-ManagerPaths {
  $data = Join-Path $Root "data\codex-remote-manager"
  return @{
    data = $data
    supervisor = Join-Path $data "ssh-tunnel-supervisor.ps1"
    log = Join-Path $Root "data\ssh-tunnel.log"
    sshLog = Join-Path $Root "data\ssh-tunnel-ssh.log"
  }
}

function Test-SupervisedTask {
  param($Task, $Config)
  if (-not $Task) { return $false }
  $paths = Get-ManagerPaths
  foreach ($action in @($Task.Actions)) {
    $arguments = [string]$action.Arguments
    if ($arguments.Length -gt 0 -and $arguments.Contains($paths.supervisor) -and
        $arguments.Contains($Root)) {
      return $true
    }
  }
  return $false
}

function Get-OwnedTask {
  param($Config)
  $task = Get-Task $Config.taskName
  if (-not $task) { return $null }
  if (-not (Test-LegacyTask $task $Config) -and -not (Test-SupervisedTask $task $Config)) {
    throw "Scheduled task $($Config.taskName) belongs to another configuration."
  }
  return $task
}

function Get-SshProcesses {
  param($Config)
  $forward = "-R 127.0.0.1:$($Config.remotePort):127.0.0.1:$($Config.localPort)"
  $keyPath = [IO.Path]::GetFullPath($Config.key)
  return @(Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $line = [string]$_.CommandLine
      ($line.Contains($keyPath) -or $line.Contains($Config.key)) -and
      $line.Contains($Config.host) -and $line.Contains($forward)
    })
}

function Get-SupervisorProcesses {
  $paths = Get-ManagerPaths
  return @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $line = [string]$_.CommandLine
      $line.Length -gt 0 -and $line.Contains($paths.supervisor) -and $line.Contains($Root)
    })
}

function Stop-OwnedTunnel {
  param($Config)
  $task = Get-OwnedTask $Config
  if ($task) {
    Disable-ScheduledTask -TaskName $Config.taskName | Out-Null
    Stop-ScheduledTask -TaskName $Config.taskName
  }
  foreach ($item in @(Get-SupervisorProcesses)) {
    Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
  }
  foreach ($item in @(Get-SshProcesses $Config)) {
    Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  do {
    if (-not (Get-SshProcesses $Config) -and -not (Get-SupervisorProcesses)) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "The SSH tunnel did not stop."
}

function Install-OwnedTunnel {
  param($Config)
  $existing = Get-OwnedTask $Config
  if ($existing) { Stop-OwnedTunnel $Config }
  $paths = Get-ManagerPaths
  New-Item -ItemType Directory -Path $paths.data -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "ssh-tunnel-supervisor.ps1") `
    -Destination $paths.supervisor -Force
  $wrapper = Join-Path $Root "scripts\run-hidden-windows.vbs"
  if (-not (Test-Path -LiteralPath $wrapper)) {
    throw "The selected installation does not include the hidden Windows launcher."
  }
  $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
  $actionArguments = "//B //Nologo `"$wrapper`" `"$powershell`" `"-NoProfile`" `"-ExecutionPolicy`" `"Bypass`" " +
    "`"-File`" `"$($paths.supervisor)`" `"-Root`" `"$Root`""
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR "System32\wscript.exe") `
    -Argument $actionArguments -WorkingDirectory $Root
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  Register-ScheduledTask -TaskName $Config.taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description "Codex Remote managed SSH reverse tunnel" -Force | Out-Null
}

function Start-OwnedTunnel {
  param($Config)
  $task = Get-OwnedTask $Config
  if (-not (Test-SupervisedTask $task $Config)) {
    Install-OwnedTunnel $Config
  }
  Enable-ScheduledTask -TaskName $Config.taskName | Out-Null
  Start-ScheduledTask -TaskName $Config.taskName
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $task = Get-Task $Config.taskName
    if ($task -and $task.State -eq "Running" -and @(Get-SshProcesses $Config).Count -gt 0) { return }
    if ($task -and $task.State -eq "Ready") { Start-ScheduledTask -TaskName $Config.taskName }
    Start-Sleep -Milliseconds 300
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "The managed SSH tunnel did not become ready."
}

$config = Get-TunnelConfig
if (-not $config.managed) {
  @{ configured = $false; managed = $false; ready = $false } | ConvertTo-Json -Compress
  return
}
$task = Get-Task $config.taskName
$supervised = Test-SupervisedTask $task $config
$legacy = Test-LegacyTask $task $config
$conflict = $false
if ($task -and -not $supervised -and -not $legacy) {
  $conflict = $true
}
if ($Action -in @("Start", "Stop", "Repair")) {
  if ($Action -eq "Stop") { Stop-OwnedTunnel $config }
  elseif ($Action -eq "Start") { Start-OwnedTunnel $config }
  else { Install-OwnedTunnel $config; Start-OwnedTunnel $config }
  $task = Get-Task $config.taskName
  $supervised = Test-SupervisedTask $task $config
  $legacy = Test-LegacyTask $task $config
  $conflict = $false
}
$sshRunning = @(Get-SshProcesses $config).Count -gt 0
$supervisorRunning = @(Get-SupervisorProcesses).Count -gt 0
@{
  configured = $true
  managed = $true
  installed = [bool]$task
  enabled = [bool]($task -and $task.State -ne "Disabled")
  taskState = if ($task) { [string]$task.State } else { "" }
  running = [bool]($sshRunning -and $task -and $task.State -eq "Running")
  sshRunning = $sshRunning
  supervisorRunning = $supervisorRunning
  ready = [bool]$sshRunning
  supervised = [bool]$supervised
  legacy = [bool]($legacy -and -not $supervised)
  conflict = [bool]$conflict
} | ConvertTo-Json -Compress
