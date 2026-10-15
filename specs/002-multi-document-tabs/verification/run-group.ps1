# Runs one checklist group end to end against a freshly launched application.
#
#   1. stops any previous automation instance and its Vite server
#   2. launches `tauri dev` with the CDP config overlay, detached
#   3. waits for the remote debugging port
#   4. focuses the window and runs the requested checklist group
#   5. leaves the application running for inspection
#
# Usage:
#   & 'D:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -File run-group.ps1 -Group n1

[CmdletBinding()]
param(
    [string] $Group = '',
    [ValidateSet('ui', 'native', 'browser')]
    [string] $Suite = 'ui',
    [int] $StartupTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$overlay = (Resolve-Path (Join-Path $PSScriptRoot 'tauri.cdp-overlay.json')).Path
$appLog = Join-Path $PSScriptRoot 'app.out.log'
$appErr = Join-Path $PSScriptRoot 'app.err.log'

Write-Output "=== group $Group ==="

# 1. Clean slate.
& (Join-Path $PSScriptRoot 'stop-app.ps1') | Out-Null

# 2. Detached launch, so this script keeps control of the sequence.
$launcher = Start-Process -FilePath 'npm.cmd' `
    -ArgumentList @('run', 'tauri', '--', 'dev', '--config', $overlay) `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $appLog `
    -RedirectStandardError $appErr `
    -WindowStyle Hidden `
    -PassThru
Write-Output ("launcher pid = {0}" -f $launcher.Id)

# 3. Wait for the debugging port.
$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$up = $false
while ((Get-Date) -lt $deadline) {
    if (Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue) {
        $up = $true
        break
    }
    if ($launcher.HasExited) {
        Write-Output 'launcher exited before the port came up'
        break
    }
    Start-Sleep -Milliseconds 500
}

if (-not $up) {
    Write-Output 'FAILED: CDP port never came up'
    Write-Output '--- app.err.log (tail) ---'
    if (Test-Path $appErr) { Get-Content -LiteralPath $appErr -Tail 30 }
    exit 1
}

Write-Output 'CDP port is up; giving the webview a moment to settle'
Start-Sleep -Seconds 2

# 4. Focus the window, then run the checks.
& (Join-Path $PSScriptRoot 'focus-window.ps1') | Out-Null

if (-not $Group) {
    Write-Output 'no group requested; the application is up and focused'
    exit 0
}

if ($Suite -eq 'browser') {
    # The browser-only check runs against the same Vite server, not the app.
    node (Join-Path $PSScriptRoot 'checklist-browser.mjs')
    exit $LASTEXITCODE
}

$checklist = switch ($Suite) {
    'native' { Join-Path $PSScriptRoot 'checklist-native.mjs' }
    'browser' { Join-Path $PSScriptRoot 'checklist-browser.mjs' }
    default { Join-Path $PSScriptRoot 'checklist-ui.mjs' }
}
node $checklist $Group
$checkExit = $LASTEXITCODE

Write-Output ''
Write-Output ("checklist exit code = {0}" -f $checkExit)
exit $checkExit
