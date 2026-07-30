# make-shortcut.ps1 - puts an "Income Tracker" shortcut on the Desktop that
# opens the tracker in its own window, with no address bar and no tabs.
#
#   Right-click this file -> "Run with PowerShell"      (or)
#   powershell -ExecutionPolicy Bypass -File make-shortcut.ps1
#
# Nothing is installed. The shortcut is just Chrome (or Edge) started in app
# mode against the local file, so the app stays exactly as portable as before.
# Re-run this if you move the folder - the shortcut stores absolute paths.

$ErrorActionPreference = 'Stop'

$app = Join-Path $PSScriptRoot 'income-tracker.html'
if (-not (Test-Path $app)) {
    throw "income-tracker.html not found next to this script. Run 'node build.mjs' first."
}

# Chrome and Edge both support --app; either gives a plain window.
$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) {
    throw "Neither Chrome nor Edge was found. Double-click income-tracker.html instead."
}

# file:///E:/Apps/income/income-tracker.html - forward slashes, so the URL is
# well-formed regardless of how Windows spells the path.
$url = 'file:///' + ($app -replace '\\', '/')

# An .html file carries no icon resource, so it has to be a real .ico or
# Explorer falls back to the generic browser-document icon.
$icon = Join-Path $PSScriptRoot 'income-tracker.ico'
if (-not (Test-Path $icon)) {
    Write-Warning "income-tracker.ico is missing - run 'node make-icon.mjs' to rebuild it. Using the browser icon for now."
    $icon = $browser
}

$linkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Income Tracker.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)
$link.TargetPath = $browser
$link.Arguments = "--app=`"$url`""
$link.WorkingDirectory = $PSScriptRoot
$link.IconLocation = "$icon,0"
$link.Description = 'Income, bills, purchases and savings - offline'
$link.Save()

# Read the shortcut back: the COM API accepts arguments it can then mangle, and
# a lost pair of quotes silently downgrades this to an ordinary browser tab.
$check = $shell.CreateShortcut($linkPath)
if ($check.Arguments -notmatch '^--app="file:///.+income-tracker\.html"$') {
    throw "The shortcut was written but its arguments came back as '$($check.Arguments)'. Expected --app=`"$url`"."
}
if ($check.IconLocation -notlike "*income-tracker.ico*" -and (Test-Path (Join-Path $PSScriptRoot 'income-tracker.ico'))) {
    throw "The icon did not stick: IconLocation came back as '$($check.IconLocation)'."
}

# Explorer caches icons per shortcut path, so a shortcut that previously had a
# different icon can keep showing the stale one until the shell is nudged.
try { & "$env:SystemRoot\system32\ie4uinit.exe" -show } catch { }

Write-Host "Created: $linkPath"
Write-Host "  opens: $(Split-Path -Leaf $browser) --app=`"$url`""
Write-Host "   icon: $($check.IconLocation)"
Write-Host ""
Write-Host "Double-click 'Income Tracker' on your Desktop. It opens in its own"
Write-Host "window with no address bar. Right-click it in the taskbar and choose"
Write-Host "'Pin to taskbar' if you want it there permanently."
