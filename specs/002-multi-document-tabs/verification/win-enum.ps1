# Enumerates every top-level window, including hidden and owned ones.
#
# UIA's desktop children miss windows that are hidden, owned or on a different
# desktop, so this uses raw EnumWindows when a dialog seems to be missing.
#
# Usage:
#   & 'D:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -File win-enum.ps1 [-ProcessId 1234]

[CmdletBinding()]
param(
    [int] $ProcessId = 0
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class Win32Enum
{
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr hWnd);

    public const uint GW_OWNER = 4;

    public static List<string> Describe(uint onlyProcessId)
    {
        var lines = new List<string>();
        EnumWindows((hWnd, lParam) =>
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (onlyProcessId != 0 && pid != onlyProcessId)
            {
                return true;
            }

            var title = new StringBuilder(512);
            GetWindowTextW(hWnd, title, title.Capacity);
            var className = new StringBuilder(256);
            GetClassNameW(hWnd, className, className.Capacity);

            var owner = GetWindow(hWnd, GW_OWNER);
            var popup = GetLastActivePopup(hWnd);

            lines.Add(string.Format(
                "hwnd={0} pid={1} visible={2} enabled={3} owner={4} lastActivePopup={5} class='{6}' title='{7}'",
                hWnd, pid, IsWindowVisible(hWnd), IsWindowEnabled(hWnd), owner, popup,
                className.ToString(), title.ToString()));
            return true;
        }, IntPtr.Zero);
        return lines;
    }
}
'@

foreach ($line in [Win32Enum]::Describe([uint32]$ProcessId)) {
    Write-Output $line
}
