// Token inspection only. No token creation, impersonation or privilege changes.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

internal static class TokenAccess
{
    internal static IntPtr Open(IntPtr process, uint rights)
    {
        IntPtr token;
        if (!OpenProcessToken(process, rights, out token)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SANDBOX_TOKEN_OPEN_FAILED");
        return token;
    }
    internal static IntPtr Buffer(IntPtr token, int kind)
    {
        int length; GetTokenInformation(token, kind, IntPtr.Zero, 0, out length);
        if (length < 1 || length > 65536) throw new InvalidOperationException("SANDBOX_TOKEN_SIZE_FAILED");
        IntPtr buffer = Marshal.AllocHGlobal(length);
        if (!GetTokenInformation(token, kind, buffer, length, out length)) { Marshal.FreeHGlobal(buffer); throw new Win32Exception(Marshal.GetLastWin32Error(), "SANDBOX_TOKEN_QUERY_FAILED"); }
        return buffer;
    }
    internal static int Number(IntPtr token, int kind)
    {
        IntPtr buffer = Buffer(token, kind);
        try { return Marshal.ReadInt32(buffer); } finally { Marshal.FreeHGlobal(buffer); }
    }
    internal static string User(IntPtr token)
    {
        IntPtr buffer = Buffer(token, 1);
        try { return new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value; } finally { Marshal.FreeHGlobal(buffer); }
    }
    [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int size, out int returned);
}
