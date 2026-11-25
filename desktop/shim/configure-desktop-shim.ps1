param(
  [Parameter(Mandatory = $true)]
  [string]$Directory
)

$ErrorActionPreference = 'Stop'
$Directory = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $key) { throw 'Current user environment key is unavailable.' }

try {
  $path = [Environment]::ExpandEnvironmentVariables([string]$key.GetValue('Path', ''))
  $entries = @($path.Split(';', [StringSplitOptions]::RemoveEmptyEntries))
  $present = $entries | Where-Object { $_.TrimEnd('\', '/') -ieq $Directory }
  if (-not $present) {
    $key.SetValue('Path', ((@($Directory) + $entries) -join ';'),
      [Microsoft.Win32.RegistryValueKind]::ExpandString)
  }
  $key.SetValue('CODEX_CLI_PATH', 'codex-remote-cli.exe',
    [Microsoft.Win32.RegistryValueKind]::String)
} finally {
  $key.Close()
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CodexRemoteEnvironmentBroadcast {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint message, UIntPtr wParam, string lParam,
    uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[void][CodexRemoteEnvironmentBroadcast]::SendMessageTimeout(
  [IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
