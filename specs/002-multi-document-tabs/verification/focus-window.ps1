# Brings the Sorakada window to the foreground so real input reaches it.
#
# Usage:  & 'D:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -File focus-window.ps1 [-ProcessId <pid>]

[CmdletBinding()]
param(
    [int] $ProcessId
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class Win32Focus
{
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

if (-not $ProcessId) {
    $candidate = Get-Process sorakada -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
    if (-not $candidate) {
        Write-Output 'no Sorakada window found'
        exit 1
    }
    $ProcessId = $candidate.Id
}

$process = Get-Process -Id $ProcessId
$handle = $process.MainWindowHandle
if ($handle -eq 0) {
    Write-Output "pid=$ProcessId has no main window"
    exit 1
}

if ([Win32Focus]::IsIconic($handle)) {
    [void][Win32Focus]::ShowWindow($handle, 9) # SW_RESTORE
}

# The shell COM object is the most reliable way to activate another process's
# window from a script; SetForegroundWindow alone is often refused.
$shell = New-Object -ComObject WScript.Shell
$activated = $shell.AppActivate($ProcessId)
if (-not $activated) {
    [void][Win32Focus]::SetForegroundWindow($handle)
}
Start-Sleep -Milliseconds 400

$foreground = [Win32Focus]::GetForegroundWindow()
$foregroundOwner = 0
[void][Win32Focus]::GetWindowThreadProcessId($foreground, [ref]$foregroundOwner)

Write-Output ("pid={0} hwnd={1} appActivate={2} foregroundOwner={3} foregroundIsTarget={4}" -f `
        $ProcessId, $handle, $activated, $foregroundOwner, ($foregroundOwner -eq $ProcessId))
Write-Output ("title='{0}'" -f $process.MainWindowTitle)

exit 0
