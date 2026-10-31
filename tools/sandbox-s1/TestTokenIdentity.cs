// Shared ONLY by the two S1 test executables. Not an application permission API.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

internal static class TestTokenIdentity
{
    internal sealed class Snapshot
    {
        public bool elevated { get; set; }
        public bool filtered { get; set; }
        public int integrityRid { get; set; }
        public bool adminGroupsEnabled { get; set; }
        public bool privilegePolicyPassed { get; set; }
        public bool uiAccess { get; set; }
        public bool sandboxInert { get; set; }
        public bool verified { get; set; }
    }

    internal static IntPtr Open(IntPtr process, uint rights)
    {
        IntPtr token; Check(OpenProcessToken(process, rights, out token), "S1_TEST_TOKEN_OPEN_FAILED"); return token;
    }

    internal static int Number(IntPtr token, int infoClass)
    {
        int result, returned;
        Check(GetTokenInformationNumber(token, infoClass, out result, 4, out returned), "S1_TEST_TOKEN_QUERY_FAILED");
        return result;
    }

    internal static IntPtr Buffer(IntPtr token, int infoClass)
    {
        int length;
        GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out length);
        if (length <= 0 || length > 1024 * 1024) throw new InvalidOperationException("S1_TEST_TOKEN_SIZE_FAILED");
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try { Check(GetTokenInformation(token, infoClass, buffer, length, out length), "S1_TEST_TOKEN_QUERY_FAILED"); return buffer; }
        catch { Marshal.FreeHGlobal(buffer); throw; }
    }

    internal static string User(IntPtr token)
    {
        IntPtr buffer = Buffer(token, 1);
        try { return new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value; }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal static Snapshot Read(IntPtr token)
    {
        Snapshot value = new Snapshot();
        value.elevated = Number(token, 20) != 0;
        value.filtered = Number(token, 21) != 0;
        value.uiAccess = Number(token, 26) != 0;
        value.sandboxInert = Number(token, 15) != 0;
        IntPtr label = Buffer(token, 25);
        try
        {
            string sid = new SecurityIdentifier(Marshal.ReadIntPtr(label)).Value;
            value.integrityRid = Int32.Parse(sid.Substring(sid.LastIndexOf('-') + 1));
        }
        finally { Marshal.FreeHGlobal(label); }
        IntPtr groups = Buffer(token, 2);
        try
        {
            int count = Marshal.ReadInt32(groups);
            int offset = Marshal.OffsetOf(typeof(GROUPS_HEADER), "First").ToInt32();
            for (int i = 0; i < count; i++)
            {
                SID_AND_ATTRIBUTES group = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(groups, offset + i * Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES))), typeof(SID_AND_ATTRIBUTES));
                if (AdminGroup(new SecurityIdentifier(group.Sid).Value) && (group.Attributes & 0x10) == 0) value.adminGroupsEnabled = true;
            }
        }
        finally { Marshal.FreeHGlobal(groups); }
        value.privilegePolicyPassed = true;
        IntPtr privileges = Buffer(token, 3);
        try
        {
            int count = Marshal.ReadInt32(privileges);
            for (int i = 0; i < count; i++)
            {
                LUID_AND_ATTRIBUTES privilege = (LUID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(privileges, 4 + i * Marshal.SizeOf(typeof(LUID_AND_ATTRIBUTES))), typeof(LUID_AND_ATTRIBUTES));
                StringBuilder name = new StringBuilder(256); int length = name.Capacity;
                Check(LookupPrivilegeName(null, ref privilege.Luid, name, ref length), "S1_TEST_PRIVILEGE_QUERY_FAILED");
                // Reject even disabled extra privileges: they could be re-enabled.
                if (name.ToString() != "SeChangeNotifyPrivilege") value.privilegePolicyPassed = false;
            }
        }
        finally { Marshal.FreeHGlobal(privileges); }
        value.verified = !value.elevated && value.filtered && value.integrityRid == 8192 && !value.adminGroupsEnabled && value.privilegePolicyPassed && !value.uiAccess && !value.sandboxInert;
        return value;
    }

    internal static Snapshot Require(IntPtr token)
    {
        Snapshot value = Read(token);
        if (!value.verified) throw new InvalidOperationException("S1_TEST_IDENTITY_NOT_RESTRICTED");
        return value;
    }

    internal static Snapshot Current()
    {
        IntPtr token = Open(GetCurrentProcess(), 8);
        try { return Require(token); } finally { CloseHandle(token); }
    }

    internal static IntPtr Create()
    {
        IntPtr original = Open(GetCurrentProcess(), 0x8 | 0x2 | 0x1 | 0x80);
        IntPtr restricted = IntPtr.Zero;
        List<IntPtr> sids = new List<IntPtr>();
        IntPtr disabled = IntPtr.Zero;
        try
        {
            IntPtr groups = Buffer(original, 2);
            try
            {
                int count = Marshal.ReadInt32(groups), offset = Marshal.OffsetOf(typeof(GROUPS_HEADER), "First").ToInt32();
                for (int i = 0; i < count; i++)
                {
                    SID_AND_ATTRIBUTES group = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(groups, offset + i * Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES))), typeof(SID_AND_ATTRIBUTES));
                    string sid = new SecurityIdentifier(group.Sid).Value;
                    if (!AdminGroup(sid)) continue;
                    IntPtr copy; Check(ConvertStringSidToSid(sid, out copy), "S1_TEST_SID_FAILED"); sids.Add(copy);
                }
            }
            finally { Marshal.FreeHGlobal(groups); }
            if (sids.Count > 0)
            {
                disabled = Marshal.AllocHGlobal(sids.Count * Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)));
                for (int i = 0; i < sids.Count; i++) Marshal.StructureToPtr(new SID_AND_ATTRIBUTES { Sid = sids[i] }, IntPtr.Add(disabled, i * Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES))), false);
            }
            // DISABLE_MAX_PRIVILEGE | LUA_TOKEN; never SANDBOX_INERT.
            Check(CreateRestrictedToken(original, 0x1 | 0x4, (uint)sids.Count, disabled, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted), "S1_TEST_RESTRICT_FAILED");
            IntPtr medium; Check(ConvertStringSidToSid("S-1-16-8192", out medium), "S1_TEST_INTEGRITY_SID_FAILED");
            try
            {
                SID_AND_ATTRIBUTES label = new SID_AND_ATTRIBUTES { Sid = medium, Attributes = 0x20 };
                Check(SetTokenInformation(restricted, 25, ref label, Marshal.SizeOf(label) + GetLengthSid(medium)), "S1_TEST_INTEGRITY_SET_FAILED");
            }
            finally { LocalFree(medium); }
            // The built-in Administrator's original default object DACL can be
            // admin-only. Give newly created test-process objects to the SAME
            // user and SYSTEM; do not edit any existing filesystem/system ACL.
            IntPtr descriptor;
            Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;" + User(original) + ")(A;;GA;;;SY)", 1, out descriptor, IntPtr.Zero), "S1_TEST_DEFAULT_DACL_FAILED");
            try
            {
                bool present, defaulted; IntPtr dacl;
                Check(GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) && present && dacl != IntPtr.Zero, "S1_TEST_DEFAULT_DACL_FAILED");
                Check(SetTokenDefaultDacl(restricted, 6, ref dacl, IntPtr.Size), "S1_TEST_DEFAULT_DACL_SET_FAILED");
            }
            finally { LocalFree(descriptor); }
            Require(restricted);
            if (User(original) != User(restricted)) throw new InvalidOperationException("S1_TEST_USER_CHANGED");
            IntPtr result = restricted; restricted = IntPtr.Zero; return result;
        }
        finally
        {
            if (restricted != IntPtr.Zero) CloseHandle(restricted);
            if (disabled != IntPtr.Zero) Marshal.FreeHGlobal(disabled);
            foreach (IntPtr sid in sids) LocalFree(sid);
            CloseHandle(original);
        }
    }

    private static bool AdminGroup(string sid)
    {
        if (sid == "S-1-5-114") return true;
        if (sid.StartsWith("S-1-5-32-", StringComparison.Ordinal))
        {
            int rid = Int32.Parse(sid.Substring(sid.LastIndexOf('-') + 1));
            return rid == 544 || (rid >= 547 && rid <= 552) || rid == 578;
        }
        return sid.StartsWith("S-1-5-21-", StringComparison.Ordinal) && (sid.EndsWith("-512", StringComparison.Ordinal) || sid.EndsWith("-518", StringComparison.Ordinal) || sid.EndsWith("-519", StringComparison.Ordinal));
    }

    private static void Check(bool value, string code) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error(), code); }
    [StructLayout(LayoutKind.Sequential)] private struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct GROUPS_HEADER { public uint Count; public SID_AND_ATTRIBUTES First; }
    [StructLayout(LayoutKind.Sequential)] private struct LUID { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] private struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attributes; }
    [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CreateRestrictedToken(IntPtr original, uint flags, uint count, IntPtr disabled, uint privilegeCount, IntPtr privileges, uint restrictedCount, IntPtr restricted, out IntPtr token);
    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)] private static extern bool GetTokenInformationNumber(IntPtr token, int infoClass, out int info, int length, out int returned);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetTokenInformation(IntPtr token, int infoClass, ref SID_AND_ATTRIBUTES info, int length);
    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "SetTokenInformation")] private static extern bool SetTokenDefaultDacl(IntPtr token, int infoClass, ref IntPtr info, int length);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW")] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, IntPtr size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertStringSidToSidW")] private static extern bool ConvertStringSidToSid(string text, out IntPtr sid);
    [DllImport("advapi32.dll")] private static extern int GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "LookupPrivilegeNameW")] private static extern bool LookupPrivilegeName(string system, ref LUID luid, StringBuilder name, ref int length);
}
