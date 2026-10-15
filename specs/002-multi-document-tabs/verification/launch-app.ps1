# Launches the Sorakada dev app with the WebView2 remote debugging port enabled.
#
# The port is injected through a Tauri config *overlay* passed on the command
# line, so no tracked repository file (src-tauri/tauri.conf.json in particular)
# is modified. The overlay repeats the complete window definition because an
# overlay's array replaces the base array rather than merging element-wise.
#
# Usage:  & 'D:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -File launch-app.ps1
#
# Intended to run as a long-lived background job; stop it to close the app.

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$overlay = (Resolve-Path (Join-Path $PSScriptRoot 'tauri.cdp-overlay.json')).Path

Set-Location $repoRoot

Write-Output "repo    = $repoRoot"
Write-Output "overlay = $overlay"
Write-Output 'starting: npm run tauri -- dev --config <overlay>'
Write-Output ''

npm run tauri -- dev --config $overlay
