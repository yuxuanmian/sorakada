# Stops the Sorakada automation instance and the Vite dev server.
#
# Only touches processes this verification run started: any `sorakada` process
# and any node process listening on the dev port. Nothing else is killed.
#
# Usage:  & 'D:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -File stop-app.ps1

$ErrorActionPreference = 'Continue'

foreach ($process in @(Get-Process sorakada -ErrorAction SilentlyContinue)) {
    Write-Output ("stopping sorakada pid={0}" -f $process.Id)
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}

# The Vite dev server is the owner of the dev port.
foreach ($port in 1420, 1421) {
    foreach ($connection in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
        $owner = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
        if ($owner) {
            Write-Output ("stopping :{0} owner pid={1} name={2}" -f $port, $owner.Id, $owner.ProcessName)
            Stop-Process -Id $owner.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

Start-Sleep -Seconds 3

Write-Output ''
Write-Output ("sorakada remaining : {0}" -f @(Get-Process sorakada -ErrorAction SilentlyContinue).Count)
foreach ($port in 1420, 9222) {
    $listening = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    Write-Output (":{0} listening : {1}" -f $port, $listening)
}
