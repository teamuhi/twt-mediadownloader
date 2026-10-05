# Builds the full Windows installer: packages the extension into an .xpi,
# runs PyInstaller to bundle the native host + ffmpeg, then compiles the
# Inno Setup script. Run from anywhere; paths below are relative to this
# script's own location.
#
# Prerequisites (one-time):
#   - PyInstaller + deps: pip install pyinstaller yt-dlp pillow
#   - browser-extension/native-host/vendor/ffmpeg/ffmpeg.exe and ffprobe.exe
#     (see native-host/vendor/README.md for where to get an LGPL build)
#   - Inno Setup 6 (ISCC.exe on PATH, or edit $iscc below):
#     winget install -e --id JRSoftware.InnoSetup --scope user --silent

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$installerDir = Join-Path $root 'installer'
$extensionDir = Join-Path $root 'extension'
$nativeHostDir = Join-Path $root 'native-host'

Write-Host '--- Packaging extension into .xpi ---'
$xpiPath = Join-Path $installerDir 'twtdl-extension.xpi'
if (Test-Path $xpiPath) { Remove-Item $xpiPath -Force }
Compress-Archive -Path (Join-Path $extensionDir '*') -DestinationPath ($xpiPath -replace '\.xpi$', '.zip') -Force
Move-Item ($xpiPath -replace '\.xpi$', '.zip') $xpiPath -Force
Write-Host "Wrote $xpiPath"

Write-Host '--- Checking for bundled ffmpeg ---'
$ffmpegExe = Join-Path $nativeHostDir 'vendor\ffmpeg\ffmpeg.exe'
if (-not (Test-Path $ffmpegExe)) {
  Write-Warning "vendor\ffmpeg\ffmpeg.exe not found; see native-host\vendor\README.md. Continuing without it (host will rely on system PATH, defeating the point of the installer)."
}

Write-Host '--- Building native host with PyInstaller ---'
Push-Location $nativeHostDir
try {
  python -m PyInstaller host.spec --noconfirm
} finally {
  Pop-Location
}

Write-Host '--- Compiling installer with Inno Setup ---'
$iscc = 'ISCC.exe'
if (-not (Get-Command $iscc -ErrorAction SilentlyContinue)) {
  $iscc = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
}
Push-Location $installerDir
try {
  & $iscc setup.iss
} finally {
  Pop-Location
}

Write-Host '--- Done. Installer is in browser-extension/installer/Output/ ---'
