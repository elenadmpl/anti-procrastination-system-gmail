$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskUrl = 'http://127.0.0.1:4387'
$taskReady = $false
try { $taskReady = (Invoke-WebRequest -Uri $taskUrl -TimeoutSec 2).StatusCode -eq 200 } catch {}
if (-not $taskReady) {
    $taskNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $taskNode) {
        $taskBundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        if (Test-Path -LiteralPath $taskBundledNode) { $taskNode = $taskBundledNode }
    }
    if (-not $taskNode) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show('Orbit needs Node.js. Install it from nodejs.org, then open Orbit again.', 'Orbit')
        exit 1
    }
    $taskServer = Join-Path $taskRoot 'preview-server.js'
    Start-Process -FilePath $taskNode -ArgumentList ('"' + $taskServer + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden
    for ($taskAttempt = 0; $taskAttempt -lt 20; $taskAttempt++) {
        try { if ((Invoke-WebRequest -Uri $taskUrl -TimeoutSec 1).StatusCode -eq 200) { $taskReady = $true; break } } catch {}
        Start-Sleep -Milliseconds 250
    }
}
if (-not $taskReady) { throw 'Orbit could not start. Check whether port 4387 is already in use.' }
$taskChrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
if (Test-Path -LiteralPath $taskChrome) { Start-Process -FilePath $taskChrome -ArgumentList ('--app=' + $taskUrl) }
else { Start-Process $taskUrl }
