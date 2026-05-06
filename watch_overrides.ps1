$repoDir  = 'C:\Users\Andy\WCYT-Website'
$fullPath  = 'C:\Users\Andy\WCYT-Website\images\art_overrides.json'

Write-Host "Watching $fullPath for changes..."
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path   = 'C:\Users\Andy\WCYT-Website\images'
$watcher.Filter = 'art_overrides.json'
$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite

$script:lastPush = [datetime]::MinValue

$action = {
    if (([datetime]::Now - $script:lastPush).TotalSeconds -lt 10) { return }
    $script:lastPush = [datetime]::Now

    $ts = [datetime]::Now.ToString('HH:mm:ss')
    Write-Host ""
    Write-Host "[$ts] art_overrides.json changed - pushing..."

    Push-Location 'C:\Users\Andy\WCYT-Website'
    git add images/art_overrides.json 2>&1 | Out-Null
    $status = git status --short images/art_overrides.json
    if (-not $status) {
        Write-Host '  No changes to commit.'
        Pop-Location
        return
    }
    git commit -m 'Update art overrides' 2>&1 | Out-Null
    git push 2>&1 | Out-Null
    Pop-Location

    if ($LASTEXITCODE -eq 0) {
        Write-Host '  Pushed OK. Live in ~1 minute.'
    } else {
        Write-Host '  Push FAILED - check terminal.'
    }
}

Register-ObjectEvent $watcher Changed -Action $action | Out-Null
$watcher.EnableRaisingEvents = $true

try {
    while ($true) { Start-Sleep 1 }
} finally {
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
}
