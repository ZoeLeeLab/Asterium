using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// Local transport only. The Electron parent owns all business logic and decisions.
public static class ClaudePipeHost {
    private static readonly object OutputLock = new object();
    private static readonly ConcurrentDictionary<string, StreamWriter> Writers = new ConcurrentDictionary<string, StreamWriter>();
    private static readonly ConcurrentDictionary<string, NamedPipeServerStream> Pipes = new ConcurrentDictionary<string, NamedPipeServerStream>();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
    private static volatile bool Stopped;
    private static string PipeName;
    private static uint CliPid;
    private static readonly ManualResetEventSlim Bound = new ManualResetEventSlim(false);
    public static int Main(string[] args) {
        if (args.Length == 2 && args[0] == "--hook") return Hook(args[1]);
        if (args.Length != 1 || !args[0].StartsWith("asterium-claude-", StringComparison.Ordinal) || args[0].Length > 100 || args[0].IndexOfAny(new char[] {'/', '\\'}) >= 0) return 2;
        PipeName = args[0];
        try {
            Console.InputEncoding = new System.Text.UTF8Encoding(false);
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            var first = CreatePipe();
            Task.Run(() => Accept(first));
            Output(new { type = "ready", access = first.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Access) });
            string line;
            while ((line = ReadBoundedLine(Console.In)) != null) {
                var message = Json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(line);
                object kind, pid;
                if (message.TryGetValue("type", out kind) && Convert.ToString(kind) == "bind" && message.TryGetValue("cliPid", out pid)) {
                    if (Bound.IsSet) throw new IOException("IPC_ALREADY_BOUND");
                    CliPid = Convert.ToUInt32(pid); if (CliPid == 0) throw new IOException("INVALID_CLI_PID"); Bound.Set(); continue;
                }
                object id, payload;
                if (!message.TryGetValue("connectionId", out id) || !message.TryGetValue("payload", out payload)) continue;
                StreamWriter writer;
                if (Writers.TryGetValue(Convert.ToString(id), out writer)) {
                    lock (writer) { writer.WriteLine(Json.Serialize(payload)); writer.Flush(); }
                }
            }
            return 0;
        } catch { return 3; }
        finally { Stopped = true; foreach (var pipe in Pipes.Values) pipe.Dispose(); }
    }
    private static int Hook(string name) {
        try {
            if (!name.StartsWith("asterium-claude-", StringComparison.Ordinal) || name.IndexOfAny(new char[] {'/', '\\'}) >= 0) return 2;
            Console.InputEncoding = new System.Text.UTF8Encoding(false);
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            var input = Console.In.ReadToEnd();
            if (input.Length > 1048576) return 2;
            using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut)) {
                pipe.Connect(5000);
                using (var reader = new StreamReader(pipe, new System.Text.UTF8Encoding(false), false, 4096, true))
                using (var writer = new StreamWriter(pipe, new System.Text.UTF8Encoding(false), 4096, true)) {
                    writer.WriteLine(Json.Serialize(new { id = 1, action = "hook", input = Json.DeserializeObject(input) })); writer.Flush();
                    var line = ReadBoundedLine(reader);
                    if (line == null) return 2;
                    var reply = Json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(line);
                    object result;
                    if (!reply.TryGetValue("result", out result) || reply.ContainsKey("error")) return 2;
                    Console.WriteLine(Json.Serialize(result)); return 0;
                }
            }
        } catch { return 2; }
    }
    private static NamedPipeServerStream CreatePipe() {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        // Explicitly reject network logons even if the same account is used over SMB.
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        return new NamedPipeServerStream(PipeName, PipeDirection.InOut, 16, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, security);
    }
    private static void Accept(NamedPipeServerStream pipe) {
        try {
            while (!Stopped) {
                pipe.WaitForConnection();
                var connected = pipe;
                var id = Guid.NewGuid().ToString("N");
                Pipes[id] = connected;
                Task.Run(() => Serve(id, connected));
                pipe = CreatePipe();
            }
        } catch { if (!Stopped) { Output(new { type = "error", code = "CLAUDE_PIPE_ACCEPT_FAILED" }); Environment.Exit(4); } }
        finally { pipe.Dispose(); }
    }
    private static void Serve(string id, NamedPipeServerStream pipe) {
        try {
            uint client;
            if (!Bound.Wait(5000) || !GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out client) || !IsDescendant(client, CliPid)) {
                Output(new { type = "rejected", code = "CLAUDE_PIPE_WRONG_PROCESS_TREE" }); return;
            }
            using (var reader = new StreamReader(pipe, new System.Text.UTF8Encoding(false), false, 4096, true))
            using (var writer = new StreamWriter(pipe, new System.Text.UTF8Encoding(false), 4096, true)) {
                Writers[id] = writer;
                string line;
                while (!Stopped && (line = ReadBoundedLine(reader)) != null) Output(new { connectionId = id, payload = new JavaScriptSerializer { MaxJsonLength = 1048576 }.DeserializeObject(line) });
            }
        } catch { /* A closed client must never become an approval. */ }
        finally {
            StreamWriter writer; NamedPipeServerStream existing;
            Writers.TryRemove(id, out writer); Pipes.TryRemove(id, out existing);
            pipe.Dispose(); Output(new { type = "disconnected", connectionId = id });
        }
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientPid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ProcessEntry {
        public uint size, usage, processId;
        public UIntPtr heap;
        public uint moduleId, threadCount, parentId;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string executable;
    }
    private static bool IsDescendant(uint client, uint expected) {
        var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) return false;
        try {
            var parents = new System.Collections.Generic.Dictionary<uint, uint>();
            var entry = new ProcessEntry { size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32FirstW(snapshot, ref entry)) do { parents[entry.processId] = entry.parentId; } while (Process32NextW(snapshot, ref entry));
            for (int depth = 0; depth < 64 && client != 0; depth++) {
                if (client == expected) return true;
                uint next; if (!parents.TryGetValue(client, out next) || next == client) return false;
                client = next;
            }
            return false;
        } finally { CloseHandle(snapshot); }
    }
    private static string ReadBoundedLine(TextReader reader) {
        var buffer = new System.Text.StringBuilder();
        int next;
        while ((next = reader.Read()) >= 0) {
            if (next == '\n') return buffer.ToString().TrimEnd('\r');
            if (buffer.Length >= 1048576) throw new IOException("IPC_FRAME_TOO_LARGE");
            buffer.Append((char)next);
        }
        return buffer.Length == 0 ? null : buffer.ToString();
    }
    private static void Output(object value) {
        lock (OutputLock) { Console.WriteLine(new JavaScriptSerializer { MaxJsonLength = 1048576 }.Serialize(value)); Console.Out.Flush(); }
    }
}
