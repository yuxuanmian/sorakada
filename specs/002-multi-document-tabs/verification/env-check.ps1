# Read-only desktop state probe for the Sorakada verification run.
#
# Starts and stops nothing. Reports only what is currently on the machine, so it
# is safe to run at any time.
#
# Usage:  & 'D:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -File env-check.ps1

$ErrorActionPreference = 'Stop'

Write-Output "PSEdition = $($PSVersionTable.PSEdition)"
Write-Output "PSVersion = $($PSVersionTable.PSVersion)"
Write-Output ""

Write-Output '--- sorakada processes ---'
$sorakada = @(Get-Process sorakada -ErrorAction SilentlyContinue)
if ($sorakada.Count -eq 0) {
    Write-Output '(none)'
}
else {
    foreach ($process in $sorakada) {
        Write-Output ("pid={0} responding={1} title='{2}'" -f $process.Id, $process.Responding, $process.MainWindowTitle)
    }
}
Write-Output ''

Write-Output '--- ports ---'
foreach ($port in 1420, 9222) {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        Write-Output (":{0} (not listening)" -f $port)
    }
    else {
        $owners = ($listeners | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique) -join ','
        Write-Output (":{0} listening, pid={1}" -f $port, $owners)
    }
}
Write-Output ''

Write-Output '--- msedgewebview2 browser processes ---'
$webviews = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue)
Write-Output ("total msedgewebview2 processes: {0}" -f $webviews.Count)
foreach ($webview in $webviews) {
    $commandLine = [string]$webview.CommandLine
    if ($commandLine -match '--type=') { continue }

    $userDataDir = '<none>'
    if ($commandLine -match '--user-data-dir=(?:"([^"]+)"|(\S+))') {
        $userDataDir = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    }

    $debugPort = '<none>'
    if ($commandLine -match '--remote-debugging-port=(\d+)') { $debugPort = $Matches[1] }

    Write-Output ("browser pid={0} parent={1} remoteDebug={2}" -f $webview.ProcessId, $webview.ParentProcessId, $debugPort)
    Write-Output ("  userdata={0}" -f $userDataDir)
}
Write-Output ''

Write-Output '--- tauri window config keys ---'
$configPath = Join-Path $PSScriptRoot '..\..\..\src-tauri\tauri.conf.json'
$configPath = (Resolve-Path $configPath).Path
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$window = $config.app.windows[0]
Write-Output ("config: {0}" -f $configPath)
Write-Output ("window keys: {0}" -f (($window.PSObject.Properties.Name) -join ', '))
Write-Output ("additionalBrowserArgs present: {0}" -f [bool]($window.PSObject.Properties.Name -contains 'additionalBrowserArgs'))
