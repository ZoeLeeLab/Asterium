// Verification of the actual ordinary AppContainer token, before resume.
// No filesystem ACL changes or native/private token flags are used as proof.
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;

internal static class AppContainerIdentity
{
    internal sealed class Snapshot
    {
        public string method { get; set; }
        public bool packageMatches { get; set; }
        public bool userMatches { get; set; }
        public bool userOnlyDenied { get; set; }
        public bool packageAllowed { get; set; }
        public bool allApplicationPackagesAllowed { get; set; }
        public string observedProfile { get; set; }
        public bool verified { get; set; }
    }

    internal static Snapshot Verify(IntPtr process, IntPtr expectedSid, string expectedProfile)
    {
        if (expectedProfile != "lpac" && expectedProfile != "appcontainer") throw new InvalidOperationException("SANDBOX_INVALID_IDENTITY_EXPECTATION");
        IntPtr token = TokenAccess.Open(process, 8 | 2), impersonation = IntPtr.Zero;
        try
        {
            if (TokenAccess.Number(token, 29) != 1 || TokenAccess.Number(token, 20) != 0) throw new InvalidOperationException("SANDBOX_IDENTITY_NOT_APPCONTAINER");
            string user = TokenAccess.User(token);
            string package;
            IntPtr packageInfo = TokenAccess.Buffer(token, 31);
            try { package = new SecurityIdentifier(Marshal.ReadIntPtr(packageInfo)).Value; }
            finally { Marshal.FreeHGlobal(packageInfo); }
            IntPtr current = TokenAccess.Open(TokenAccess.GetCurrentProcess(), 8);
            bool userMatches;
            try { userMatches = user == TokenAccess.User(current); }
            finally { TokenAccess.CloseHandle(current); }
            bool packageMatches = package == new SecurityIdentifier(expectedSid).Value;
            if (!userMatches || !packageMatches) throw new InvalidOperationException("SANDBOX_IDENTITY_OWNER_MISMATCH");
            Check(DuplicateToken(token, 2, out impersonation), "SANDBOX_IDENTITY_DUPLICATE_FAILED");
            // The user grant alone MUST fail the AppContainer principal check.
            // An exact package grant MUST succeed; otherwise a blanket denial
            // could be mistaken for LPAC. The third descriptor is the discriminator.
            bool userOnly = Allowed(impersonation, user, null);
            bool exactPackage = Allowed(impersonation, user, package);
            bool allPackages = Allowed(impersonation, user, "S-1-15-2-1");
            if (userOnly || !exactPackage) throw new InvalidOperationException("SANDBOX_IDENTITY_CONTROLS_FAILED");
            string observed = allPackages ? "appcontainer" : "lpac";
            if (observed != expectedProfile) throw new InvalidOperationException("SANDBOX_IDENTITY_PROFILE_MISMATCH");
            return new Snapshot { method = "access_check_controls", packageMatches = true, userMatches = true, userOnlyDenied = true, packageAllowed = true,
                allApplicationPackagesAllowed = allPackages, observedProfile = observed, verified = true };
        }
        finally { if (impersonation != IntPtr.Zero) TokenAccess.CloseHandle(impersonation); TokenAccess.CloseHandle(token); }
    }

    private static bool Allowed(IntPtr token, string user, string package)
    {
        // A private read bit (0x1), no generic bits, no SACL, and explicit owner
        // and group. This checks the token in memory, not a host file or object.
        string descriptorText = "O:" + user + "G:" + user + "D:(A;;0x1;;;" + user + ")";
        if (package != null) descriptorText += "(A;;0x1;;;" + package + ")";
        IntPtr descriptor;
        Check(ConvertStringSecurityDescriptorToSecurityDescriptor(descriptorText, 1, out descriptor, IntPtr.Zero), "SANDBOX_IDENTITY_DESCRIPTOR_FAILED");
        IntPtr privileges = Marshal.AllocHGlobal(4096);
        try
        {
            GENERIC_MAPPING mapping = new GENERIC_MAPPING { Read = 1, Write = 2, Execute = 4, All = 7 };
            uint privilegeLength = 4096, granted;
            bool allowed;
            Check(AccessCheck(descriptor, token, 1, ref mapping, privileges, ref privilegeLength, out granted, out allowed), "SANDBOX_IDENTITY_ACCESS_CHECK_FAILED");
            if (allowed && (granted & 1) == 0) throw new InvalidOperationException("SANDBOX_IDENTITY_ACCESS_RESULT_INVALID");
            return allowed;
        }
        finally { Marshal.FreeHGlobal(privileges); LocalFree(descriptor); }
    }

    private static void Check(bool value, string code) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error(), code); }
    [StructLayout(LayoutKind.Sequential)] private struct GENERIC_MAPPING { public uint Read, Write, Execute, All; }
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DuplicateToken(IntPtr token, int level, out IntPtr impersonation);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AccessCheck(IntPtr descriptor, IntPtr token, uint desired, ref GENERIC_MAPPING mapping, IntPtr privileges, ref uint privilegeLength, out uint granted, out bool allowed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW")] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, IntPtr size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
}
