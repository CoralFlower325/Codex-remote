[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$WorkerPid
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  [Console]::Error.WriteLine("terminal-job: Windows is required")
  exit 2
}

$native = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public sealed class CodexTerminalJob : IDisposable
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const uint ProcessSetQuota = 0x0100;
    private const uint ProcessTerminate = 0x0001;
    private const uint ProcessQueryLimitedInformation = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JobObjectExtendedLimitInformation information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr handle;

    private CodexTerminalJob(IntPtr value)
    {
        handle = value;
    }

    public static CodexTerminalJob Attach(int processId)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");

        try
        {
            var information = new JobObjectExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformationClass,
                ref information,
                (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation))))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            }

            IntPtr process = OpenProcess(
                ProcessSetQuota | ProcessTerminate | ProcessQueryLimitedInformation,
                false,
                processId);
            if (process == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed");

            try
            {
                if (!AssignProcessToJobObject(job, process))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");

                bool attached;
                if (!IsProcessInJob(process, job, out attached))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "IsProcessInJob failed");
                if (!attached)
                    throw new InvalidOperationException("Worker was not attached to the terminal job");
            }
            finally
            {
                CloseHandle(process);
            }

            var result = new CodexTerminalJob(job);
            job = IntPtr.Zero;
            return result;
        }
        finally
        {
            if (job != IntPtr.Zero)
                CloseHandle(job);
        }
    }

    public void Dispose()
    {
        if (handle == IntPtr.Zero)
            return;
        CloseHandle(handle);
        handle = IntPtr.Zero;
    }
}
'@

$job = $null
try {
  Add-Type -TypeDefinition $native -Language CSharp | Out-Null
  $job = [CodexTerminalJob]::Attach($WorkerPid)
  [Console]::Out.WriteLine("READY")
  [Console]::Out.Flush()

  while ($true) {
    $command = [Console]::In.ReadLine()
    if ($null -eq $command -or $command -eq "STOP") {
      break
    }
  }
}
catch {
  $message = $_.Exception.Message -replace "[\r\n]+", " "
  [Console]::Error.WriteLine("terminal-job: $message")
  exit 1
}
finally {
  if ($null -ne $job) {
    $job.Dispose()
  }
}

exit 0
