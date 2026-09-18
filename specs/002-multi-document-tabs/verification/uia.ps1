# Windows UI Automation driver for the native dialogs a Tauri app raises:
# the Open/Save pickers, the unsaved-work message box, and the app window.
#
# Discovery uses raw EnumWindows because UIA's desktop children enumeration does
# not reliably surface owned modal dialogs. Interaction then goes through UIA on
# the discovered window handle.
#
# Actions:
#   list                                     every top-level window, with class + title
#   wait   -TitleContains <t> [-TimeoutSeconds n]   block until the dialog exists
#   dump   -TitleContains <t>                the UIA control tree (names + ids)
#   set-filename -TitleContains <t> -Value <path>
#   click  -TitleContains <t> -Name <button label>
#   send-enter -TitleContains <t>            press Enter with the dialog focused
#   close  -TitleContains <t>                WM_CLOSE, i.e. the user clicking X
#
# Usage:
#   & 'D:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -File uia.ps1 list

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Action,

    [string] $TitleContains = '',
    [string] $ClassContains = '',
    [string] $Name = '',
    [string] $Value = '',
    [int] $TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class Win32Window
{
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    // CharSet.Unicode is essential: without it the marshaller hands a narrow
    // buffer to the wide entry points and every string is truncated to one char.
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    public const uint WM_CLOSE = 0x0010;

    public class WindowInfo
    {
        public IntPtr Handle;
        public uint ProcessId;
        public bool Visible;
        public string ClassName;
        public string Title;
    }

    public static List<WindowInfo> All()
    {
        var result = new List<WindowInfo>();
        EnumWindows((hWnd, lParam) =>
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);

            var title = new StringBuilder(1024);
            GetWindowTextW(hWnd, title, title.Capacity);
            var className = new StringBuilder(512);
            GetClassNameW(hWnd, className, className.Capacity);

            result.Add(new WindowInfo
            {
                Handle = hWnd,
                ProcessId = pid,
                Visible = IsWindowVisible(hWnd),
                ClassName = className.ToString(),
                Title = title.ToString()
            });
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetDlgCtrlID(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW", SetLastError = true)]
    public static extern IntPtr SendMessageText(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);

    public const uint WM_SETTEXT = 0x000C;
    public const uint WM_COMMAND = 0x0111;

    public static List<WindowInfo> Children(IntPtr parent)
    {
        var result = new List<WindowInfo>();
        EnumChildWindows(parent, (hWnd, lParam) =>
        {
            var title = new StringBuilder(1024);
            GetWindowTextW(hWnd, title, title.Capacity);
            var className = new StringBuilder(512);
            GetClassNameW(hWnd, className, className.Capacity);

            result.Add(new WindowInfo
            {
                Handle = hWnd,
                ProcessId = (uint)GetDlgCtrlID(hWnd),
                Visible = IsWindowVisible(hWnd),
                ClassName = className.ToString(),
                Title = title.ToString()
            });
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static bool SetText(IntPtr hWnd, string text)
    {
        SendMessageText(hWnd, WM_SETTEXT, IntPtr.Zero, text);
        return true;
    }

    public static bool ClickOk(IntPtr hWnd)
    {
        SendMessage(hWnd, WM_COMMAND, new IntPtr(1), IntPtr.Zero);
        return true;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    /// Clicks a child button by its visible text with a real mouse event.
    ///
    /// UIA's InvokePattern is not implemented by the DirectUI buttons inside a
    /// Win32 message box, so the click is synthesised at the button's centre.
    public static string ClickChildByText(IntPtr parent, string text)
    {
        foreach (var kid in Children(parent))
        {
            if (kid.ClassName != "Button" || kid.Title != text) continue;

            RECT rect;
            if (!GetWindowRect(kid.Handle, out rect)) continue;

            var x = (rect.Left + rect.Right) / 2;
            var y = (rect.Top + rect.Bottom) / 2;

            SetForegroundWindow(parent);
            System.Threading.Thread.Sleep(150);
            SetCursorPos(x, y);
            System.Threading.Thread.Sleep(80);
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
            System.Threading.Thread.Sleep(40);
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);

            return string.Format("clicked '{0}' at ({1},{2})", text, x, y);
        }
        return null;
    }
}
'@

function Get-UiaWindow {
    param([string] $Title, [string] $Class, [bool] $Wait = $false, [int] $Seconds = 20)

    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $match = [Win32Window]::All() |
            Where-Object {
                $_.Visible -and $_.Title -and $_.Title -like "*$Title*" -and
                ((-not $Class) -or $_.ClassName -like "*$Class*")
            } |
            Select-Object -First 1
        if ($match) { return $match }
        if (-not $Wait) { return $null }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)

    return $null
}

function Get-Descendants($element) {
    $element.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
}

switch ($Action) {
    'list' {
        foreach ($window in [Win32Window]::All()) {
            if (-not $window.Visible) { continue }
            Write-Output ("hwnd={0} pid={1} class='{2}' title='{3}'" -f `
                    $window.Handle, $window.ProcessId, $window.ClassName, $window.Title)
        }
    }

    # Child windows of a dialog, with their control ids. This is how the classic
    # common-dialog controls (file-name box 1148, Save button 1) are located.
    'children' {
        $window = Get-UiaWindow -Title $TitleContains -Class $ClassContains
        if (-not $window) {
            Write-Output "no window matching '$TitleContains'"
            exit 1
        }
        Write-Output ("parent hwnd={0} class='{1}' title='{2}'" -f $window.Handle, $window.ClassName, $window.Title)
        foreach ($child in [Win32Window]::Children($window.Handle)) {
            Write-Output ("  hwnd={0} id={1} visible={2} class='{3}' text='{4}'" -f `
                    $child.Handle, $child.ProcessId, $child.Visible, $child.ClassName, $child.Title)
        }
    }

    # Sets the file-name box by control id and accepts the dialog. Deterministic
    # where typed input is not, because it does not depend on focus.
    'set-path-and-accept' {
        $window = Get-UiaWindow -Title $TitleContains -Class $ClassContains -Wait $true -Seconds $TimeoutSeconds
        if (-not $window) {
            Write-Output "DIALOG_TIMEOUT: no visible window matching '$TitleContains'"
            exit 1
        }

        $children = [Win32Window]::Children($window.Handle)

        # The file-name box is the Edit with the classic control id 1001 that
        # sits inside the dialog's ComboBox; the address bar reuses id 1001 but
        # is a toolbar, not an Edit.
        $edit = $children |
            Where-Object { $_.ClassName -eq 'Edit' -and $_.ProcessId -eq 1001 -and $_.Visible } |
            Select-Object -First 1

        if (-not $edit) {
            $combo = $children | Where-Object { $_.ClassName -eq 'ComboBox' -and $_.Visible } | Select-Object -First 1
            if ($combo) {
                $edit = [Win32Window]::Children($combo.Handle) |
                    Where-Object { $_.ClassName -like '*Edit*' } |
                    Select-Object -First 1
            }
        }

        if (-not $edit) {
            Write-Output 'file-name edit box not found'
            $children | ForEach-Object {
                Write-Output ("  candidate id={0} class='{1}' visible={2}" -f $_.ProcessId, $_.ClassName, $_.Visible)
            }
            exit 1
        }

        [void][Win32Window]::SetText($edit.Handle, $Value)
        Start-Sleep -Milliseconds 300
        [void][Win32Window]::SetForegroundWindow($window.Handle)
        Start-Sleep -Milliseconds 200
        [void][Win32Window]::ClickOk($window.Handle)

        Write-Output ("set file-name box (hwnd={0}) to '{1}' and sent IDOK to '{2}'" -f $edit.Handle, $Value, $window.Title)
    }

    'wait' {
        $window = Get-UiaWindow -Title $TitleContains -Class $ClassContains -Wait $true -Seconds $TimeoutSeconds
        if (-not $window) {
            Write-Output "DIALOG_TIMEOUT: no visible window matching '$TitleContains'"
            exit 1
        }
        Write-Output ("hwnd={0} pid={1} class='{2}' title='{3}'" -f `
                $window.Handle, $window.ProcessId, $window.ClassName, $window.Title)
    }

    'dump' {
        $window = Get-UiaWindow -Title $TitleContains -Class $ClassContains
        if (-not $window) {
            Write-Output "no window matching '$TitleContains'"
            exit 1
        }
        Write-Output ("window hwnd={0} class='{1}' title='{2}'" -f $window.Handle, $window.ClassName, $window.Title)

        $element = [System.Windows.Automation.AutomationElement]::FromHandle($window.Handle)
        foreach ($child in Get-Descendants $element) {
            $childName = ''
            try { $childName = $child.Current.Name } catch { }
            $automationId = ''
            try { $automationId = $child.Current.AutomationId } catch { }
            $controlType = ''
            try { $controlType = $child.Current.ControlType.ProgrammaticName.Replace('ControlType.', '') } catch { }
            $enabled = $false
            try { $enabled = $child.Current.IsEnabled } catch { }

            if ($controlType -match 'Button|Edit|ComboBox|Text|List|MenuItem|ToolBar|Tree') {
                Write-Output ("  {0,-12} id='{1}' name='{2}' enabled={3}" -f `
                        $controlType, $automationId, $childName, $enabled)
            }
        }
    }

    'set-filename' {
        $window = Get-UiaWindow -Title $TitleContains -Class $ClassContains
        if (-not $window) {
            Write-Output "no window matching '$TitleContains'"
            exit 1
        }

        $element = [System.Windows.Automation.AutomationElement]::FromHandle($window.Handle)
        $target = $null
        $fallback = $null
        foreach ($child in Get-Descendants $element) {
            $controlType = ''
            try { $controlType = $child.Current.ControlType.ProgrammaticName } catch { }
            if ($controlType -ne 'ControlType.Edit') { continue }

            $automationId = ''
            try { $automationId = $child.Current.AutomationId } catch { }
            if ($automationId -eq '1148') { $target = $child; break }
            if ($automationId -eq '1001' -and -not $fallback) { $fallback = $child }
        }

        if (-not $target) { $target = $fallback }
        if (-not $target) {
            Write-Output 'file-name edit box not found'
            exit 1
        }

        $pattern = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $pattern.SetValue($Value)
        Start-Sleep -Milliseconds 200
        Write-Output ("set filename to '{0}'" -f $Value)
    }

    'click' {
        $window = Get-UiaWindow -Title $TitleContains -Class $ClassContains
        if (-not $window) {
            Write-Output "no window matching '$TitleContains'"
            exit 1
        }

        [void][Win32Window]::SetForegroundWindow($window.Handle)
        Start-Sleep -Milliseconds 200

        $element = [System.Windows.Automation.AutomationElement]::FromHandle($window.Handle)
        $target = $null
        foreach ($child in Get-Descendants $element) {
            $childName = ''
            try { $childName = $child.Current.Name } catch { }
            if ($childName -ne $Name) { continue }

            $controlType = ''
            try { $controlType = $child.Current.ControlType.ProgrammaticName } catch { }
            if ($controlType -like '*Button*') { $target = $child; break }
            if (-not $target) { $target = $child }
        }

        if (-not $target) {
            Write-Output "no element named '$Name'"
            exit 1
        }

        try {
            $invoke = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $invoke.Invoke()
            Write-Output ("invoked '{0}'" -f $Name)
        }
        catch {
            Write-Output ("invoke pattern unavailable for '{0}': {1}" -f $Name, $_.Exception.Message)
            exit 1
        }
    }

    'send-enter' {
        $window = Get-UiaWindow -Title $TitleContains -Class $ClassContains
        if (-not $window) {
            Write-Output "no window matching '$TitleContains'"
            exit 1
        }
        [void][Win32Window]::SetForegroundWindow($window.Handle)
        Start-Sleep -Milliseconds 250

        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        Write-Output 'sent ENTER'
    }

    # Types a path into the picker's focused file-name box and accepts it.
    #
    # The file-name field of the modern IFileSaveDialog/IFileOpenDialog is not
    # reliably exposed through UIA, but the dialog focuses it on open, so typed
    # input reaches it. SendKeys metacharacters are escaped.
    'fill-and-accept' {
        $window = Get-UiaWindow -Title $TitleContains -Class $ClassContains -Wait $true -Seconds $TimeoutSeconds
        if (-not $window) {
            Write-Output "DIALOG_TIMEOUT: no visible window matching '$TitleContains'"
            exit 1
        }

        [void][Win32Window]::SetForegroundWindow($window.Handle)
        Start-Sleep -Milliseconds 500

        $foreground = [Win32Window]::GetForegroundWindow()
        Write-Output ("dialog hwnd={0} foreground={1} isDialog={2}" -f `
                $window.Handle, $foreground, ($foreground -eq $window.Handle))

        Add-Type -AssemblyName System.Windows.Forms
        # The box may carry a suggested name, so select it all before typing.
        [System.Windows.Forms.SendKeys]::SendWait('^a')
        Start-Sleep -Milliseconds 150

        $escaped = $Value -replace '([+^%~()\[\]{}])', '{$1}'
        [System.Windows.Forms.SendKeys]::SendWait($escaped)
        Start-Sleep -Milliseconds 400
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

        Write-Output ("typed '{0}' into '{1}' and pressed ENTER" -f $Value, $window.Title)
    }

    # Answers the unsaved-work prompt by its stable button labels, which are the
    # exact strings `fileDialogs.ts` configures.
    # Clicks any child button by its exact text, with a real mouse event.
    'click-child' {
        $window = Get-UiaWindow -Title $TitleContains -Class $ClassContains -Wait $true -Seconds $TimeoutSeconds
        if (-not $window) {
            Write-Output "DIALOG_TIMEOUT: no window matching '$TitleContains' (class '$ClassContains')"
            exit 1
        }
        $clicked = [Win32Window]::ClickChildByText($window.Handle, $Name)
        if (-not $clicked) {
            Write-Output "no button labelled '$Name'"
            foreach ($child in [Win32Window]::Children($window.Handle)) {
                if ($child.ClassName -eq 'Button') {
                    Write-Output ("  button text='{0}'" -f $child.Title)
                }
            }
            exit 1
        }
        Write-Output $clicked
    }

    # Clicks the first button of a dialog, whatever it is labelled. Used for the
    # error boxes, whose single dismiss button is localised.
    'click-first-button' {
        $window = Get-UiaWindow -Title $TitleContains -Class $ClassContains -Wait $true -Seconds $TimeoutSeconds
        if (-not $window) {
            Write-Output "DIALOG_TIMEOUT: no window matching '$TitleContains' (class '$ClassContains')"
            exit 1
        }
        $buttons = @([Win32Window]::Children($window.Handle) | Where-Object { $_.ClassName -eq 'Button' })
        if ($buttons.Count -eq 0) {
            Write-Output 'no buttons found'
            exit 1
        }
        $clicked = [Win32Window]::ClickChildByText($window.Handle, $buttons[0].Title)
        Write-Output ("first button was '{0}': {1}" -f $buttons[0].Title, $clicked)
    }

    # Clicks the first button of every visible common dialog.
    #
    # Used for the shell's own confirmations, such as the overwrite prompt the
    # Save dialog raises before the application ever sees the chosen path.
    'dismiss-extra-dialogs' {
        $found = $false
        foreach ($window in [Win32Window]::All()) {
            if (-not $window.Visible) { continue }
            if ($window.ClassName -notlike '*#32770*') { continue }

            $buttons = @([Win32Window]::Children($window.Handle) | Where-Object { $_.ClassName -eq 'Button' })
            if ($buttons.Count -eq 0) { continue }

            $clicked = [Win32Window]::ClickChildByText($window.Handle, $buttons[0].Title)
            Write-Output ("dismissed '{0}' via '{1}': {2}" -f $window.Title, $buttons[0].Title, $clicked)
            $found = $true
        }
        if (-not $found) { Write-Output 'no extra dialog found' }
    }

    'unsaved' {
        $label = switch ($Name) {
            'save' { 'Save' }
            'dontSave' { "Don't Save" }
            'cancel' { 'Cancel' }
            default { $Name }
        }

        $window = Get-UiaWindow -Title $TitleContains -Class $ClassContains -Wait $true -Seconds $TimeoutSeconds
        if (-not $window) {
            Write-Output "DIALOG_TIMEOUT: no unsaved-work prompt matching '$TitleContains'"
            exit 1
        }

        $clicked = [Win32Window]::ClickChildByText($window.Handle, $label)
        if (-not $clicked) {
            Write-Output "no button labelled '$label'"
            foreach ($child in [Win32Window]::Children($window.Handle)) {
                if ($child.ClassName -eq 'Button') {
                    Write-Output ("  button text='{0}'" -f $child.Title)
                }
            }
            exit 1
        }

        Write-Output ("answered the prompt with '{0}': {1}" -f $label, $clicked)
    }

    'close' {
        $windows = @([Win32Window]::All() |
            Where-Object { $_.Visible -and $_.Title -and $_.Title -like "*$TitleContains*" })
        if ($windows.Count -eq 0) {
            Write-Output "no window matching '$TitleContains'"
            exit 1
        }
        foreach ($window in $windows) {
            [void][Win32Window]::SetForegroundWindow($window.Handle)
            [void][Win32Window]::SendMessage($window.Handle, [Win32Window]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
            Write-Output ("sent WM_CLOSE to '{0}'" -f $window.Title)
        }
    }

    default {
        Write-Output "unknown action '$Action'"
        exit 2
    }
}
