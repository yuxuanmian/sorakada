#!/usr/bin/env bash
# Read-only desktop status probe. Safe to run at any time: it starts and stops
# nothing, it only reports what is currently on the machine.
#
# Usage: bash status.sh

echo "bash_version=$BASH_VERSION"
echo "hostname=$(hostname)"

echo "--- sorakada processes ---"
ps -W 2>/dev/null | grep -i sorakada || echo "(none)"

echo "--- msedgewebview2 process count ---"
ps -W 2>/dev/null | grep -ci msedgewebview2 || true

echo "--- webview2 browser processes and their user-data-dirs ---"
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { \$_.CommandLine -notmatch '--type=' } | ForEach-Object { \$cl = [string]\$_.CommandLine; \$ud = '<none>'; if (\$cl -match '--user-data-dir=(?:\"([^\"]+)\"|(\S+))') { if (\$Matches[1]) { \$ud = \$Matches[1] } else { \$ud = \$Matches[2] } }; Write-Output (\"pid=\" + \$_.ProcessId + \" parent=\" + \$_.ParentProcessId + \" userdata=\" + \$ud) }" 2>/dev/null

echo "--- vite dev server on :1420 ---"
netstat -ano 2>/dev/null | grep -i listening | grep -E ':1420[^0-9]' || echo "(not listening)"

echo "--- cdp port :9222 ---"
netstat -ano 2>/dev/null | grep -i listening | grep -E ':9222[^0-9]' || echo "(not listening)"
