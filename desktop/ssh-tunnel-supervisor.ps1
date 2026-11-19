[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Root
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$envPath = Join-Path $Root ".env"
$log = Join-Path $Root "data\ssh-tunnel.log"
$sshLog = Join-Path $Root "data\ssh-tunnel-ssh.log"

function Write-Log {
  param([string]$Message)
  try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $log) -Force | Out-Null
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1MB) {
      Move-Item -LiteralPath $log -Destination "$log.1" -Force
    }
    Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
  } catch { }
}

function Read-DotEnv {
  $values = @{}
  foreach ($line in [System.IO.File]::ReadAllLines($envPath, [System.Text.Encoding]::UTF8)) {
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

function Get-Config {
  $values = Read-DotEnv
  $remotePort = 14545
  $localPort = 4545
  if ([string]$values["PORT"]) {
    if (-not [int]::TryParse([string]$values["PORT"], [ref]$localPort)) { throw "PORT is invalid." }
  }
  if ([string]$values["SSH_TUNNEL_LOCAL_PORT"] -and
      -not [int]::TryParse([string]$values["SSH_TUNNEL_LOCAL_PORT"], [ref]$localPort)) {
    throw "SSH_TUNNEL_LOCAL_PORT is invalid."
  }
  if ([string]$values["SSH_TUNNEL_REMOTE_PORT"] -and
      -not [int]::TryParse([string]$values["SSH_TUNNEL_REMOTE_PORT"], [ref]$remotePort)) {
    throw "SSH_TUNNEL_REMOTE_PORT is invalid."
  }
  return @{
    host = [string]$values["SSH_TUNNEL_HOST"]
    user = [string]$values["SSH_TUNNEL_USER"]
    key = [string]$values["SSH_TUNNEL_KEY"]
    remotePort = $remotePort
    localPort = $localPort
  }
}

function Quote-Argument {
  param([string]$Value)
  if ($Value.Contains('"')) { throw "SSH arguments may not contain quotes." }
  return '"' + $Value + '"'
}

$ssh = Join-Path $env:WINDIR "System32\OpenSSH\ssh.exe"
if (-not (Test-Path -LiteralPath $ssh)) {
  $command = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if (-not $command) {
    Write-Log "OpenSSH ssh.exe is unavailable."
    exit 2
  }
  $ssh = $command.Source
}

while ($true) {
  try {
    $config = Get-Config
    if (-not $config.host -or -not $config.user -or -not $config.key -or
        -not (Test-Path -LiteralPath $config.key)) {
      throw "Managed SSH tunnel configuration is incomplete."
    }
    if ((Test-Path -LiteralPath $sshLog) -and (Get-Item -LiteralPath $sshLog).Length -gt 1MB) {
      Move-Item -LiteralPath $sshLog -Destination "$sshLog.1" -Force
    }
    $arguments = @(
      "-N",
      "-i", (Quote-Argument $config.key),
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "ConnectTimeout=15",
      "-E", (Quote-Argument $sshLog),
      "-R", "127.0.0.1:$($config.remotePort):127.0.0.1:$($config.localPort)",
      "$($config.user)@$($config.host)"
    ) -join " "
    Write-Log "Starting SSH reverse tunnel to $($config.host):$($config.remotePort)."
    $child = Start-Process -FilePath $ssh -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $child.WaitForExit()
    Write-Log "SSH reverse tunnel exited with code $($child.ExitCode); restarting in 2 seconds."
  } catch {
    Write-Log "Supervisor error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 2
}
