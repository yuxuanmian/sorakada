# Waits for the Sorakada CDP endpoint and reports the application + target state.
#
# Usage:  & 'D:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -File check-cdp.ps1 [-TimeoutSeconds 60]

[CmdletBinding()]
param(
    [int] $TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$listening = $false

while ((Get-Date) -lt $deadline) {
    $connection = Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue
    if ($connection) {
        $listening = $true
        break
    }
    Start-Sleep -Milliseconds 500
}

if (-not $listening) {
    Write-Output 'CDP: not listening'
}
else {
    $owners = ($connection | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique) -join ','
    Write-Output "CDP: listening (pid=$owners)"
}

Write-Output ''
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

if (-not $listening) {
    exit 1
}

Write-Output ''
Write-Output '--- webview2 browser args ---'
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.CommandLine -notmatch '--type=' } |
    ForEach-Object {
        $commandLine = [string]$_.CommandLine
        if ($commandLine -match 'com\.sorakada\.editor') {
            $port = '<none>'
            if ($commandLine -match '--remote-debugging-port=(\d+)') { $port = $Matches[1] }
            Write-Output ("sorakada webview pid={0} remoteDebugPort={1}" -f $_.ProcessId, $port)
        }
    }

Write-Output ''
Write-Output '--- CDP targets ---'
try {
    $targets = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/list' -TimeoutSec 10
    foreach ($target in $targets) {
        Write-Output ("type={0} title='{1}' url={2}" -f $target.type, $target.title, $target.url)
    }
}
catch {
    Write-Output ("target listing failed: {0}" -f $_.Exception.Message)
}

exit 0
