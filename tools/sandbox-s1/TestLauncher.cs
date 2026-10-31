// Explicit S1 test adapter only. Always launches the fixed sibling helper.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class S1TestLauncher
{
    private static int Main(string[] args)
    {
        IntPtr token = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero, jobPointer = IntPtr.Zero, job = IntPtr.Zero;
        IntPtr station = IntPtr.Zero, desktop = IntPtr.Zero;
        IntPtr[] stdio = new IntPtr[3];
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool started = false;
        try
        {
            // Only these three helper operations exist. No arbitrary executable,
            // command, credential, shell or native-operation forwarding API.
            if (!((args.Length == 1 && args[0] == "--status") || (args.Length == 2 && (args[0] == "--cleanup" || args[0] == "--fixture")))) throw new InvalidOperationException("S1_TEST_LAUNCHER_INVALID_ARGUMENTS");
            string directory = Path.GetDirectoryName(typeof(S1TestLauncher).Assembly.Location);
            string executable = Path.Combine(directory, "SandboxHelper.exe");
            if ((File.GetAttributes(executable) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("S1_TEST_HELPER_REPARSE");
            token = TestTokenIdentity.Create(); // Throws unless ALL identity checks pass.
            string fixture = args.Length == 2 ? ValidateFixture(directory, args[1]) : null;
            if (fixture != null) PrepareOwner(fixture, new SecurityIdentifier(TestTokenIdentity.User(token)));
            string desktopName = CreatePrivateDesktop(token, out station, out desktop);
            job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "S1_TEST_JOB_FAILED");
            JOB_LIMITS limits = new JOB_LIMITS(); limits.Basic.Flags = 0x2000;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)), "S1_TEST_JOB_LIMIT_FAILED");
            for (int i = 0; i < 3; i++)
                Check(DuplicateHandle(TestTokenIdentity.GetCurrentProcess(), GetStdHandle(-10 - i), TestTokenIdentity.GetCurrentProcess(), out stdio[i], 0, true, 2), "S1_TEST_STDIO_FAILED");
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "S1_TEST_ATTRIBUTES_FAILED");
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size); Marshal.Copy(stdio, 0, handles, 3);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "S1_TEST_HANDLE_LIST_FAILED");
            jobPointer = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobPointer, job);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobPointer, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "S1_TEST_JOB_LIST_FAILED");
            STARTUPINFOEX startup = new STARTUPINFOEX(); startup.Info.cb = Marshal.SizeOf(startup); startup.Info.Flags = 0x100;
            startup.Info.Desktop = desktopName;
            startup.Info.Input = stdio[0]; startup.Info.Output = stdio[1]; startup.Info.Error = stdio[2]; startup.Attributes = attributes;
            StringBuilder command = new StringBuilder(Quote(executable)).Append(" --require-test-token");
            if (fixture != null) command.Append(" --fixture ").Append(Quote(fixture));
            if (args[0] != "--fixture") foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            Check(CreateProcessAsUser(token, executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x4 | 0x08000000, IntPtr.Zero, directory, ref startup, out process), "S1_TEST_HELPER_CREATE_FAILED");
            IntPtr actual = TestTokenIdentity.Open(process.Process, 8);
            try
            {
                TestTokenIdentity.Require(actual); // Verify the suspended process, not only the candidate token.
                if (TestTokenIdentity.User(actual) != TestTokenIdentity.User(token)) throw new InvalidOperationException("S1_TEST_CHILD_USER_CHANGED");
            }
            finally { TestTokenIdentity.CloseHandle(actual); }
            bool inJob; Check(IsProcessInJob(process.Process, job, out inJob) && inJob, "S1_TEST_CHILD_JOB_FAILED");
            Check(ResumeThread(process.Thread) != UInt32.MaxValue, "S1_TEST_RESUME_FAILED"); started = true;
            uint wait = WaitForSingleObject(process.Process, 130000);
            if (wait != 0) throw new InvalidOperationException("S1_TEST_HELPER_WAIT_FAILED");
            uint exitCode; Check(GetExitCodeProcess(process.Process, out exitCode), "S1_TEST_EXIT_CODE_FAILED");
            if (exitCode != 0) throw new InvalidOperationException("S1_TEST_HELPER_EXIT:" + exitCode);
            return 0;
        }
        catch (Exception error)
        {
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { type = "error", code = error.Message, started = started, testLauncher = true, win32 = error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : 0 }));
            return 1;
        }
        finally
        {
            // No unverified process is ever resumed. Closing the outer Job also
            // protects cancellation of the launcher itself (nested helper Job).
            if (job != IntPtr.Zero) { TerminateJobObject(job, 1); TestTokenIdentity.CloseHandle(job); }
            if (process.Process != IntPtr.Zero) TestTokenIdentity.CloseHandle(process.Process);
            if (process.Thread != IntPtr.Zero) TestTokenIdentity.CloseHandle(process.Thread);
            foreach (IntPtr handle in stdio) if (handle != IntPtr.Zero) TestTokenIdentity.CloseHandle(handle);
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobPointer != IntPtr.Zero) Marshal.FreeHGlobal(jobPointer);
            if (token != IntPtr.Zero) TestTokenIdentity.CloseHandle(token);
            if (desktop != IntPtr.Zero) CloseDesktop(desktop);
            if (station != IntPtr.Zero) CloseWindowStation(station);
        }
    }

    // A UAC-disabled interactive desktop can be admin-only. Use disposable test
    // objects, never edit winsta0/default ACLs or change the machine UAC policy.
    private static string CreatePrivateDesktop(IntPtr token, out IntPtr station, out IntPtr desktop)
    {
        station = IntPtr.Zero; desktop = IntPtr.Zero;
        string name = "AsteriumS1_" + Guid.NewGuid().ToString("N");
        IntPtr descriptor;
        string sddl = "D:P(A;;GA;;;" + TestTokenIdentity.User(token) + ")(A;;GA;;;SY)(A;;GA;;;BU)(A;;GA;;;AC)(A;;GA;;;S-1-15-2-2)S:(ML;;NW;;;LW)";
        Check(ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, IntPtr.Zero), "S1_TEST_DESKTOP_SECURITY_FAILED");
        IntPtr original = GetProcessWindowStation();
        try
        {
            SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES { Length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), Descriptor = descriptor };
            station = CreateWindowStation(name, 1, 0xF037F, ref security);
            Check(station != IntPtr.Zero, "S1_TEST_STATION_CREATE_FAILED");
            Check(SetProcessWindowStation(station), "S1_TEST_STATION_SELECT_FAILED");
            desktop = CreateDesktop("Test", IntPtr.Zero, IntPtr.Zero, 0, 0xF01FF, ref security);
            Check(desktop != IntPtr.Zero, "S1_TEST_DESKTOP_CREATE_FAILED");
            return name + "\\Test";
        }
        finally
        {
            bool restored = SetProcessWindowStation(original);
            LocalFree(descriptor);
            if (!restored) throw new Win32Exception(Marshal.GetLastWin32Error(), "S1_TEST_STATION_RESTORE_FAILED");
        }
    }

    private static string ValidateFixture(string directory, string value)
    {
        string full = Path.GetFullPath(value);
        string id = Path.GetFileName(full);
        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-f0-9]{32}$") || !String.Equals(full, Path.Combine(directory, "runs", id), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("S1_TEST_FIXTURE_OUTSIDE_EVIDENCE");
        string cursor = Path.GetPathRoot(full);
        foreach (string part in full.Substring(cursor.Length).Split(Path.DirectorySeparatorChar))
        {
            cursor = Path.Combine(cursor, part);
            if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("S1_TEST_FIXTURE_REPARSE");
        }
        var owner = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(File.ReadAllText(Path.Combine(full, "s1-owner.json")));
        if (!owner.ContainsKey("id") || (string)owner["id"] != id) throw new InvalidOperationException("S1_TEST_FIXTURE_OWNER_FAILED");
        return full;
    }

    private static void PrepareOwner(string directory, SecurityIdentifier user)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) return;
        // Only this disposable fixture. No access-rule widening or integrity
        // label edits; newly admin-created files become owned by the same user.
        DirectorySecurity security = new DirectorySecurity(); security.SetOwner(user); Directory.SetAccessControl(directory, security);
        foreach (string entry in Directory.GetFileSystemEntries(directory))
        {
            if ((File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0) continue;
            if (Directory.Exists(entry)) PrepareOwner(entry, user);
            else
            {
                using (FileStream file = File.Open(entry, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    FILE_INFORMATION info; Check(GetFileInformationByHandle(file.SafeFileHandle, out info), "S1_TEST_FILE_ID_FAILED");
                    if (info.Links != 1) throw new InvalidOperationException("S1_TEST_HARDLINK_NOT_SUPPORTED");
                }
                FileSecurity fileSecurity = new FileSecurity(); fileSecurity.SetOwner(user); File.SetAccessControl(entry, fileSecurity);
            }
        }
    }

    private static string Quote(string value)
    {
        StringBuilder text = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes).Append(c); slashes = 0;
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }
    private static void Check(bool success, string code) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), code); }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO { public int cb; public string Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags; public ushort Show, ReservedCount; public IntPtr ReservedBytes, Input, Output, Error; }
    [StructLayout(LayoutKind.Sequential)] private struct STARTUPINFOEX { public STARTUPINFO Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { public IntPtr Process, Thread; public uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] private struct SECURITY_ATTRIBUTES { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [StructLayout(LayoutKind.Sequential)] private struct FILE_INFORMATION { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [StructLayout(LayoutKind.Sequential)] private struct BASIC_LIMITS { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct JOB_LIMITS { public BASIC_LIMITS Basic; public IO_COUNTERS IO; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessAsUserW")] private static extern bool CreateProcessAsUser(IntPtr token, string executable, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref JOB_LIMITS limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FILE_INFORMATION info);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr handle);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW")] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, IntPtr size);
    [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateWindowStationW")] private static extern IntPtr CreateWindowStation(string name, uint flags, uint access, ref SECURITY_ATTRIBUTES security);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateDesktopW")] private static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, uint flags, uint access, ref SECURITY_ATTRIBUTES security);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern bool CloseWindowStation(IntPtr station);
}
