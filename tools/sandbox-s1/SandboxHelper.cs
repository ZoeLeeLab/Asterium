// S1 developer experiment, compiled with the existing Windows .NET Framework csc.
// No production imports, elevation request, native fallback or operation retry.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class SandboxHelper
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 262144 };
    private static readonly object OutputLock = new object();
    private static readonly ManualResetEvent Cancel = new ManualResetEvent(false);
    private static readonly List<IntPtr> Allocations = new List<IntPtr>();
    private static IntPtr Job;
    private static IntPtr ChildInput;
    private static int OutputBytes;
    private static bool OutputExceeded;
    private static bool ChildStarted;
    private static TestTokenIdentity.Snapshot VerifiedTestIdentity;
    private static string VerifiedTestDirectory;

    public sealed class Request
    {
        public int version { get; set; }
        public int ownerPid { get; set; }
        public string id { get; set; }
        public string runDirectory { get; set; }
        public string executable { get; set; }
        public string[] args { get; set; }
        public string profile { get; set; }
        public string runtimeKind { get; set; }
        public string expectedIdentityProfile { get; set; }
        public bool probeLegacyQuery { get; set; }
        public bool identityOnly { get; set; }
        public bool allowNetwork { get; set; }
        public int timeoutMs { get; set; }
    }

    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            bool requireTestToken = args.Length > 0 && args[0] == "--require-test-token";
            if (requireTestToken) { string[] remaining = new string[args.Length - 1]; Array.Copy(args, 1, remaining, 0, remaining.Length); args = remaining; }
            if (requireTestToken && args.Length >= 2 && args[0] == "--fixture") { VerifiedTestDirectory = Path.GetFullPath(args[1]); string[] remaining = new string[args.Length - 2]; Array.Copy(args, 2, remaining, 0, remaining.Length); args = remaining; }
            bool elevated = TokenInt(GetCurrentProcess(), 20) != 0;
            if (requireTestToken)
            {
                if (elevated) throw new InvalidOperationException("S1_ELEVATED_HELPER_REFUSED");
                VerifiedTestIdentity = TestTokenIdentity.Current();
            }
            if (args.Length == 1 && args[0] == "--status")
            {
                Emit(new { elevated = elevated, architecture = "x64", productionConnected = false, testIdentity = VerifiedTestIdentity });
                return 0;
            }
            // This check precedes profile creation, ACL edits and process creation.
            if (elevated) throw new InvalidOperationException("S1_ELEVATED_HELPER_REFUSED");
            if (args.Length == 2 && args[0] == "--cleanup")
            {
                Request saved = ReadRequest(args[1]);
                Cleanup(saved);
                Emit(new { type = "cleaned", profile = ProfileName(saved) });
                return 0;
            }
            if (args.Length != 0) throw new InvalidOperationException("S1_INVALID_ARGUMENTS");
            string line = Console.ReadLine();
            if (line == null || line.Length > 65536) throw new InvalidOperationException("S1_INVALID_REQUEST");
            Request request = Json.Deserialize<Request>(line);
            Validate(request);
            // The request is also a recovery journal, written before OS mutations.
            string journal = Path.Combine(request.runDirectory, "request.json");
            if (File.Exists(journal)) throw new InvalidOperationException("S1_RUN_ALREADY_USED");
            File.WriteAllText(journal, Json.Serialize(request), new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(request.runDirectory, "helper-state.json"), Json.Serialize(new { pid = Process.GetCurrentProcess().Id, startTicks = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks }), new UTF8Encoding(false));
            Execute(request);
            return 0;
        }
        catch (Exception error)
        {
            Emit(new { type = "error", code = error.Message, cause = error.InnerException == null ? null : error.InnerException.Message, started = ChildStarted, win32 = error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : 0 });
            return 1;
        }
    }

    private static Request ReadRequest(string directory)
    {
        NoReparse(directory);
        Request request = Json.Deserialize<Request>(File.ReadAllText(Path.Combine(directory, "request.json")));
        Validate(request, false);
        if (!String.Equals(Path.GetFullPath(directory), request.runDirectory, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("S1_RECOVERY_PATH_MISMATCH");
        return request;
    }

    private static string ProfileName(Request request) { return "Asterium.S1." + request.id; }

    private static void Validate(Request request) { Validate(request, true); }

    private static void Validate(Request request, bool validateTree)
    {
        if (request == null || request.version != 1 || request.ownerPid <= 0 || request.id == null || !System.Text.RegularExpressions.Regex.IsMatch(request.id, "^[a-f0-9]{32}$") ||
            (request.profile != "lpac" && request.profile != "appcontainer") || request.timeoutMs < 100 || request.timeoutMs > 120000 || request.args == null || request.args.Length > 128)
            throw new InvalidOperationException("S1_INVALID_REQUEST");
        if (request.expectedIdentityProfile != null && request.expectedIdentityProfile != "lpac" && request.expectedIdentityProfile != "appcontainer") throw new InvalidOperationException("S1_INVALID_IDENTITY_EXPECTATION");
        // Old LPAC journals remain cleanable. No current request can launch LPAC.
        if (validateTree && request.profile != "appcontainer") throw new InvalidOperationException("S1_PROFILE_NOT_SUPPORTED");
        if (request.runtimeKind != null && request.runtimeKind != "node" && request.runtimeKind != "python" && request.runtimeKind != "electron") throw new InvalidOperationException("S1_INVALID_RUNTIME_KIND");
        if (request.runtimeKind == "electron" && !String.Equals(Path.GetFileName(request.executable), "electron.exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("S1_INVALID_ELECTRON_RUNTIME");
        string helperDirectory = Path.GetDirectoryName(typeof(SandboxHelper).Assembly.Location);
        string expected = Path.Combine(helperDirectory, "runs", request.id);
        if (!String.Equals(Path.GetFullPath(request.runDirectory), expected, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("S1_PATH_OUTSIDE_EVIDENCE");
        if (VerifiedTestIdentity != null && !String.Equals(request.runDirectory, VerifiedTestDirectory, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("S1_TEST_FIXTURE_MISMATCH");
        NoReparse(request.runDirectory);
        Dictionary<string, object> owner = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(request.runDirectory, "s1-owner.json")));
        if (!owner.ContainsKey("id") || (string)owner["id"] != request.id) throw new InvalidOperationException("S1_INVALID_OWNER");
        string runtime = Path.Combine(request.runDirectory, "runtime") + Path.DirectorySeparatorChar;
        string powerShell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        if (request.executable == null || !Path.IsPathRooted(request.executable) ||
            (!Path.GetFullPath(request.executable).StartsWith(runtime, StringComparison.OrdinalIgnoreCase) && !String.Equals(request.executable, powerShell, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("S1_EXECUTABLE_NOT_ALLOWED");
        NoReparse(request.executable);
        foreach (string argument in request.args) if (argument == null || argument.IndexOf('\0') >= 0) throw new InvalidOperationException("S1_INVALID_ARGUMENT");
        if (validateTree) foreach (string name in new string[] { "workspace", "runtime", "temp" }) CheckTree(Path.Combine(request.runDirectory, name));
    }

    private static void NoReparse(string value)
    {
        string full = Path.GetFullPath(value);
        string cursor = Path.GetPathRoot(full);
        foreach (string component in full.Substring(cursor.Length).Split(Path.DirectorySeparatorChar))
        {
            if (component.Length == 0) continue;
            cursor = Path.Combine(cursor, component);
            if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("S1_REPARSE_PATH");
        }
    }

    private static void CheckTree(string directory)
    {
        NoReparse(directory);
        foreach (string entry in Directory.GetFileSystemEntries(directory))
        {
            if ((File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("S1_REPARSE_PATH");
            if (Directory.Exists(entry)) CheckTree(entry);
            else
            {
                using (FileStream file = File.Open(entry, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    BY_HANDLE_FILE_INFORMATION info;
                    Check(GetFileInformationByHandle(file.SafeFileHandle, out info), "S1_FILE_ID_FAILED");
                    if (info.NumberOfLinks != 1) throw new InvalidOperationException("S1_HARDLINK_NOT_SUPPORTED");
                }
            }
        }
    }

    private static void Execute(Request request)
    {
        IntPtr profileSid = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero;
        IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
        IntPtr inputRead = IntPtr.Zero;
        IntPtr owner = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        Thread stdout = null, stderr = null;
        bool createdProfile = false;
        string reason = "exited";
        uint exitCode = 1;
        Exception failure = null;
        AppContainerIdentity.Snapshot identity = null;
        object legacyQuery = null;
        try
        {
            owner = OpenProcess(0x100000, false, request.ownerPid);
            Check(owner != IntPtr.Zero && WaitForSingleObject(owner, 0) == 0x102, "S1_OWNER_UNAVAILABLE");
            // A unique profile prevents previous experiments sharing authority.
            int hr = CreateAppContainerProfile(ProfileName(request), "Asterium S1 PoC", "Disposable developer-only experiment", IntPtr.Zero, 0, out profileSid);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            createdProfile = true;
            SecurityIdentifier sid = new SecurityIdentifier(profileSid);
            Grant(request.runDirectory, sid, FileSystemRights.ReadAndExecute, false);
            GrantTree(Path.Combine(request.runDirectory, "workspace"), sid, FileSystemRights.Modify);
            GrantTree(Path.Combine(request.runDirectory, "runtime"), sid, FileSystemRights.ReadAndExecute);
            GrantTree(Path.Combine(request.runDirectory, "temp"), sid, FileSystemRights.Modify);

            Job = CreateJobObject(IntPtr.Zero, null);
            Check(Job != IntPtr.Zero, "S1_JOB_CREATE_FAILED");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = 0x2000 | 0x8 | 0x200; // KILL_ON_CLOSE, ACTIVE_PROCESS, JOB_MEMORY; no breakaway.
            limits.BasicLimitInformation.ActiveProcessLimit = 16;
            limits.JobMemoryLimit = new UIntPtr(512UL * 1024 * 1024);
            Check(SetInformationJobObject(Job, 9, ref limits, (uint)Marshal.SizeOf(limits)), "S1_JOB_LIMIT_FAILED");

            Pipe(out outputRead, out outputWrite); Pipe(out errorRead, out errorWrite); Pipe(out inputRead, out ChildInput);
            Check(SetHandleInformation(outputRead, 1, 0) && SetHandleInformation(errorRead, 1, 0) && SetHandleInformation(ChildInput, 1, 0), "S1_PIPE_HANDLE_FAILED");
            IntPtr size = IntPtr.Zero;
            int count = 3;
            InitializeProcThreadAttributeList(IntPtr.Zero, count, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, count, 0, ref size), "S1_ATTRIBUTES_FAILED");
            List<IntPtr> capabilitySids = new List<IntPtr>();
            try
            {
                // Network OFF has zero capability SIDs. ON permits public/private
                // networking, not a destination allowlist; no loopback exemption.
                if (request.allowNetwork)
                {
                    foreach (string value in new string[] { "S-1-15-3-1", "S-1-15-3-3" })
                    {
                        IntPtr capability;
                        Check(ConvertStringSidToSid(value, out capability), "S1_CAPABILITY_FAILED");
                        capabilitySids.Add(capability);
                    }
                }
                IntPtr capabilities = IntPtr.Zero;
                if (capabilitySids.Count != 0)
                {
                    capabilities = Allocate(Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)) * capabilitySids.Count);
                    for (int i = 0; i < capabilitySids.Count; i++) Marshal.StructureToPtr(new SID_AND_ATTRIBUTES { Sid = capabilitySids[i], Attributes = 4 }, IntPtr.Add(capabilities, i * Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES))), false);
                }
                SECURITY_CAPABILITIES security = new SECURITY_CAPABILITIES { AppContainerSid = profileSid, Capabilities = capabilities, CapabilityCount = (uint)capabilitySids.Count };
                Attribute(attributes, 0x20009, Store(security), Marshal.SizeOf(security));
                Attribute(attributes, 0x20002, StoreHandles(new IntPtr[] { inputRead, outputWrite, errorWrite }), 3 * IntPtr.Size);
                // Atomic assignment at creation avoids the helper-death race before AssignProcessToJobObject.
                Attribute(attributes, 0x2000D, StoreHandles(new IntPtr[] { Job }), IntPtr.Size);
                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(startup);
                startup.StartupInfo.dwFlags = 0x100;
                startup.StartupInfo.hStdInput = inputRead; startup.StartupInfo.hStdOutput = outputWrite; startup.StartupInfo.hStdError = errorWrite;
                startup.lpAttributeList = attributes;
                StringBuilder command = new StringBuilder(Quote(request.executable));
                foreach (string argument in request.args) command.Append(" ").Append(Quote(argument));
                if (command.Length >= 32767) throw new InvalidOperationException("S1_COMMAND_TOO_LONG");
                IntPtr environment = Marshal.StringToHGlobalUni(EnvironmentBlock(request));
                try
                {
                    Check(CreateProcess(request.executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x400 | 0x4 | 0x08000000, environment, Path.Combine(request.runDirectory, "workspace"), ref startup, out process), "S1_PROCESS_START_FAILED");
                }
                finally { Marshal.FreeHGlobal(environment); }
            }
            finally { foreach (IntPtr capability in capabilitySids) LocalFree(capability); }
            Close(ref outputWrite); Close(ref errorWrite); Close(ref inputRead);
            bool inJob;
            Check(IsProcessInJob(process.hProcess, Job, out inJob) && inJob, "S1_JOB_VERIFY_FAILED");
            if (TokenInt(process.hProcess, 29) != 1 || TokenInt(process.hProcess, 20) != 0) throw new InvalidOperationException("S1_TOKEN_VERIFY_FAILED");
            identity = AppContainerIdentity.Verify(process.hProcess, profileSid, request.profile);
            // An extra negative-test expectation can only reject; it can NEVER
            // replace the configured profile's mandatory verification above.
            if (request.expectedIdentityProfile != null && identity.observedProfile != request.expectedIdentityProfile) throw new InvalidOperationException("S1_IDENTITY_PROFILE_MISMATCH");
            legacyQuery = request.probeLegacyQuery ? AppContainerIdentity.ProbeLegacyQuery(process.hProcess) : null;
            if (!request.identityOnly)
            {
                stdout = Pump(outputRead, "stdout"); outputRead = IntPtr.Zero;
                stderr = Pump(errorRead, "stderr"); errorRead = IntPtr.Zero;
                Thread input = new Thread(ControlLoop); input.IsBackground = true; input.Start();
                Check(ResumeThread(process.hThread) != UInt32.MaxValue, "S1_RESUME_FAILED");
                ChildStarted = true;
                Emit(new { type = "ready", pid = process.dwProcessId, helperPid = Process.GetCurrentProcess().Id, profile = request.profile, profileName = ProfileName(request), appContainer = true, elevated = false, inJob = true, network = request.allowNetwork ? "allowed" : "blocked", testIdentity = VerifiedTestIdentity, identity = identity, legacyQuery = legacyQuery });
                Stopwatch elapsed = Stopwatch.StartNew();
                uint wait;
                while ((wait = WaitForSingleObject(process.hProcess, 25)) == 0x102)
                {
                    if (Cancel.WaitOne(0)) { reason = OutputExceeded ? "output_limit" : "cancelled"; break; }
                    if (WaitForSingleObject(owner, 0) != 0x102) { reason = "owner_exited"; break; }
                    if (elapsed.ElapsedMilliseconds >= request.timeoutMs) { reason = "timeout"; break; }
                }
                if (wait != 0 && wait != 0x102) throw new Win32Exception(Marshal.GetLastWin32Error(), "S1_PROCESS_WAIT_FAILED");
                if (OutputExceeded) reason = "output_limit";
            }
            // Even normal parent exit closes ALL descendants before ACL/profile cleanup.
            Check(TerminateJobObject(Job, 1), "S1_JOB_TERMINATE_FAILED");
            Check(WaitForSingleObject(process.hProcess, 5000) == 0, "S1_PROCESS_CLEANUP_TIMEOUT");
            Check(GetExitCodeProcess(process.hProcess, out exitCode), "S1_EXIT_CODE_FAILED");
            WaitForEmptyJob();
            if ((stdout != null && !stdout.Join(5000)) || (stderr != null && !stderr.Join(5000))) throw new InvalidOperationException("S1_OUTPUT_CLEANUP_TIMEOUT");
        }
        catch (Exception error) { failure = error; }
        finally
        {
            if (Job != IntPtr.Zero) TerminateJobObject(Job, 1);
            Close(ref Job); // KILL_ON_JOB_CLOSE is a second, kernel-enforced cleanup path.
            Close(ref ChildInput); Close(ref inputRead); Close(ref outputWrite); Close(ref errorWrite); Close(ref outputRead); Close(ref errorRead);
            Close(ref process.hThread); Close(ref process.hProcess);
            Close(ref owner);
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            foreach (IntPtr allocation in Allocations) Marshal.FreeHGlobal(allocation);
            if (profileSid != IntPtr.Zero) FreeSid(profileSid);
            if (createdProfile)
            {
                try { Cleanup(request); }
                catch (Exception cleanupError) { failure = new InvalidOperationException("S1_CLEANUP_FAILED:" + cleanupError.Message, failure); }
            }
        }
        if (failure != null) throw failure;
        if (request.identityOnly)
        {
            Emit(new { type = "identity_result", identity = identity, legacyQuery = legacyQuery, testIdentity = VerifiedTestIdentity, profile = request.profile, started = false, cleanup = "confirmed" });
            return;
        }
        Emit(new { type = "result", succeeded = reason == "exited" && exitCode == 0, reason = reason, exitCode = exitCode, started = ChildStarted, cleanup = "confirmed", profile = request.profile, network = request.allowNetwork ? "allowed" : "blocked" });
    }

    private static void ControlLoop()
    {
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (line.Length > 100000) break;
                Dictionary<string, object> message = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
                if ((string)message["type"] == "cancel") break;
                if ((string)message["type"] != "stdin") break;
                byte[] bytes = Convert.FromBase64String((string)message["data"]);
                if (bytes.Length > 65536) break;
                uint written;
                if (!WriteFile(ChildInput, bytes, (uint)bytes.Length, out written, IntPtr.Zero) || written != bytes.Length) break;
            }
        }
        catch { /* Broken input/owner EOF is cancellation, never a new launch. */ }
        Cancel.Set();
    }

    private static Thread Pump(IntPtr handle, string kind)
    {
        Thread thread = new Thread(delegate()
        {
            try
            {
                using (FileStream stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 4096, false))
                {
                    byte[] buffer = new byte[4096]; int count;
                    while ((count = stream.Read(buffer, 0, buffer.Length)) != 0)
                    {
                        if (Interlocked.Add(ref OutputBytes, count) > 65536) { OutputExceeded = true; Cancel.Set(); continue; }
                        Emit(new { type = kind, data = Convert.ToBase64String(buffer, 0, count) });
                    }
                }
            }
            catch { Cancel.Set(); }
        });
        thread.IsBackground = true; thread.Start(); return thread;
    }

    private static string EnvironmentBlock(Request request)
    {
        string system = Environment.GetFolderPath(Environment.SpecialFolder.System);
        string windows = Directory.GetParent(system).FullName;
        string temp = Path.Combine(request.runDirectory, "temp");
        SortedDictionary<string, string> environment = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        environment["SystemRoot"] = windows; environment["WINDIR"] = windows;
        environment["SystemDrive"] = Path.GetPathRoot(windows).TrimEnd('\\');
        environment["PATH"] = Path.Combine(request.runDirectory, "runtime") + ";" + system;
        environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
        environment["TEMP"] = temp; environment["TMP"] = temp;
        environment["USERPROFILE"] = temp; environment["HOME"] = temp; environment["APPDATA"] = temp; environment["LOCALAPPDATA"] = temp;
        // A fixed test runtime selector, never arbitrary inherited environment.
        if (request.runtimeKind == "electron") environment["ELECTRON_RUN_AS_NODE"] = "1";
        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> pair in environment) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
        return block.Append('\0').ToString();
    }

    private static void GrantTree(string directory, SecurityIdentifier sid, FileSystemRights rights)
    {
        Grant(directory, sid, rights, true);
        foreach (string entry in Directory.GetFileSystemEntries(directory))
        {
            NoReparse(entry);
            if (Directory.Exists(entry)) GrantTree(entry, sid, rights);
            else
            {
                FileSecurity security = File.GetAccessControl(entry, AccessControlSections.Access);
                security.AddAccessRule(new FileSystemAccessRule(sid, rights, AccessControlType.Allow));
                File.SetAccessControl(entry, security);
            }
        }
    }

    private static void Grant(string directory, SecurityIdentifier sid, FileSystemRights rights, bool inherit)
    {
        NoReparse(directory);
        DirectorySecurity security = Directory.GetAccessControl(directory, AccessControlSections.Access);
        security.AddAccessRule(new FileSystemAccessRule(sid, rights, inherit ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(directory, security);
    }

    private static void Cleanup(Request request)
    {
        string stateFile = Path.Combine(request.runDirectory, "helper-state.json");
        if (File.Exists(stateFile))
        {
            Dictionary<string, object> state = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(stateFile));
            int pid = Convert.ToInt32(state["pid"]);
            if (pid != Process.GetCurrentProcess().Id)
            {
                try
                {
                    using (Process previous = Process.GetProcessById(pid))
                        if (previous.StartTime.ToUniversalTime().Ticks == Convert.ToInt64(state["startTicks"]) && !previous.HasExited) throw new InvalidOperationException("S1_HELPER_STILL_RUNNING");
                }
                catch (ArgumentException) { /* The original helper has exited. */ }
            }
        }
        IntPtr sid;
        int hr = DeriveAppContainerSidFromAppContainerName(ProfileName(request), out sid);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        try { RevokeTree(request.runDirectory, new SecurityIdentifier(sid)); }
        finally { FreeSid(sid); }
        for (int attempt = 0; attempt < 3; attempt++)
        {
            hr = DeleteAppContainerProfile(ProfileName(request));
            if (hr == 0) return;
            Thread.Sleep(100);
        }
        Marshal.ThrowExceptionForHR(hr);
    }

    private static void RevokeTree(string directory, SecurityIdentifier sid)
    {
        NoReparse(directory);
        DirectorySecurity security = Directory.GetAccessControl(directory, AccessControlSections.Access);
        security.PurgeAccessRules(sid); Directory.SetAccessControl(directory, security);
        foreach (string entry in Directory.GetFileSystemEntries(directory))
        {
            // Do not follow links a test/child created. The link itself is not a new grant.
            if ((File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0) continue;
            if (Directory.Exists(entry)) RevokeTree(entry, sid);
            else
            {
                FileSecurity fileSecurity = File.GetAccessControl(entry, AccessControlSections.Access);
                fileSecurity.PurgeAccessRules(sid); File.SetAccessControl(entry, fileSecurity);
            }
        }
    }

    private static void WaitForEmptyJob()
    {
        Stopwatch elapsed = Stopwatch.StartNew();
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
        do
        {
            Check(QueryInformationJobObject(Job, 1, out accounting, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero), "S1_JOB_QUERY_FAILED");
            if (accounting.ActiveProcesses == 0) return;
            Thread.Sleep(25);
        } while (elapsed.ElapsedMilliseconds < 5000);
        throw new InvalidOperationException("S1_JOB_CLEANUP_TIMEOUT");
    }

    private static int TokenInt(IntPtr process, int tokenClass)
    {
        IntPtr token;
        Check(OpenProcessToken(process, 8, out token), "S1_TOKEN_OPEN_FAILED");
        try { int result, length; Check(GetTokenInformation(token, tokenClass, out result, 4, out length), "S1_TOKEN_QUERY_FAILED:" + tokenClass); return result; }
        finally { CloseHandle(token); }
    }

    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1).Append('"');
            else result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static void Emit(object value) { lock (OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
    private static void Check(bool success, string code) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), code); }
    private static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    private static IntPtr Allocate(int size) { IntPtr value = Marshal.AllocHGlobal(size); Allocations.Add(value); return value; }
    private static IntPtr Store(object value) { IntPtr buffer = Allocate(Marshal.SizeOf(value)); Marshal.StructureToPtr(value, buffer, false); return buffer; }
    private static IntPtr StoreHandles(IntPtr[] handles) { IntPtr buffer = Allocate(handles.Length * IntPtr.Size); Marshal.Copy(handles, 0, buffer, handles.Length); return buffer; }
    private static void Attribute(IntPtr list, int name, IntPtr value, int size) { Check(UpdateProcThreadAttribute(list, 0, new IntPtr(name), value, new IntPtr(size), IntPtr.Zero, IntPtr.Zero), "S1_ATTRIBUTE_SET_FAILED"); }
    private static void Pipe(out IntPtr read, out IntPtr write) { SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES { Length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), InheritHandle = true }; Check(CreatePipe(out read, out write, ref attributes, 0), "S1_PIPE_CREATE_FAILED"); }

    [StructLayout(LayoutKind.Sequential)] private struct SECURITY_ATTRIBUTES { public int Length; public IntPtr SecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] private struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid, Capabilities; public uint CapabilityCount, Reserved; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential)] private struct BY_HANDLE_FILE_INFORMATION { public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime; public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow; }

    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returned);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertStringSidToSidW")] private static extern bool ConvertStringSidToSid(string value, out IntPtr sid);
    [DllImport("advapi32.dll")] private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")] private static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool WriteFile(IntPtr file, byte[] data, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
}
