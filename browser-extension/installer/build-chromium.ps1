# Assembles the unpacked Chromium (Chrome/Edge/Brave) extension, and
# optionally (-Pack) signs it into a .crx + generates the update.xml used by
# the installer's ExtensionInstallForcelist policy for self-hosted,
# store-free distribution.
#
# There is no hand-maintained second copy of popup.js/popup.css/popup.html:
# this script copies popup.js/youtube.js/twitter.js/web.js/scan.js/popup.css verbatim from extension/ and derives
# popup.html from extension/popup.html by inserting one <script> tag for the
# browser-polyfill shim, so extension/ (the shipping Firefox extension)
# never needs to be touched or hand-kept-in-sync.
#
# Usage:
#   .\build-chromium.ps1            # unpacked only, for "Load unpacked" dev testing
#   .\build-chromium.ps1 -Pack      # also produces twtdl-extension.crx + update.xml
#
# -Pack requires a local Chrome or Edge install (used only to run
# --pack-extension; the built .crx works in Chrome, Edge, and Brave alike)
# and the production signing key at signing/chromium-key.pem (gitignored --
# see native-host/README.md for what this key is and why it must never be
# committed or lost).
#
# Output: browser-extension/installer/chromium-build/ (gitignored; -Pack
# output is what gets uploaded as GitHub Release assets, never committed).

param(
  [switch]$Pack
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$extensionDir = Join-Path $root 'extension'
$chromiumSrcDir = Join-Path $root 'extension-chromium'
$buildDir = Join-Path $PSScriptRoot 'chromium-build'
$outDir = Join-Path $buildDir 'unpacked'
$keyPath = Join-Path $PSScriptRoot 'signing\chromium-key.pem'

# Must match extension-chromium/manifest.json's "key" field -- both are
# derived from signing/chromium-key.pem. If the key is ever regenerated,
# update the manifest's "key" field to match (see native-host/README.md).
$ExpectedExtensionId = 'lnpcggkomlddjkfpkbamcjkdkpnheejm'
$UpdateManifestUrl = 'https://github.com/teamuhi/twt-mediadownloader/releases/latest/download/update.xml'
$CrxDownloadUrl = 'https://github.com/teamuhi/twt-mediadownloader/releases/latest/download/twtdl-extension.crx'

Write-Host '--- Cleaning output directory ---'
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

Write-Host '--- Copying Chromium-specific files ---'
Copy-Item (Join-Path $chromiumSrcDir 'background.js') $outDir
Copy-Item (Join-Path $chromiumSrcDir 'vendor\browser-polyfill.js') (Join-Path $outDir 'browser-polyfill.js')

Write-Host '--- Copying shared files from extension/ ---'
Copy-Item (Join-Path $extensionDir 'popup.js') $outDir
Copy-Item (Join-Path $extensionDir 'youtube.js') $outDir
Copy-Item (Join-Path $extensionDir 'twitter.js') $outDir
Copy-Item (Join-Path $extensionDir 'web.js') $outDir
Copy-Item (Join-Path $extensionDir 'scan.js') $outDir
Copy-Item (Join-Path $extensionDir 'popup.css') $outDir
Copy-Item (Join-Path $extensionDir 'icons') $outDir -Recurse

Write-Host '--- Deriving popup.html (injecting browser-polyfill.js script tag) ---'
$popupHtml = Get-Content (Join-Path $extensionDir 'popup.html') -Raw
$needle = '<script src="popup.js"></script>'
if ($popupHtml -notmatch [regex]::Escape($needle)) {
  throw "Could not find '$needle' in extension/popup.html -- update this script's injection point."
}
$popupHtml = $popupHtml -replace [regex]::Escape($needle), "<script src=`"browser-polyfill.js`"></script>`n  $needle"
Set-Content -Path (Join-Path $outDir 'popup.html') -Value $popupHtml -NoNewline

Write-Host '--- Stamping manifest.json (Chromium manifest + version from extension/manifest.json) ---'
$firefoxManifest = Get-Content (Join-Path $extensionDir 'manifest.json') -Raw | ConvertFrom-Json
$chromiumManifest = Get-Content (Join-Path $chromiumSrcDir 'manifest.json') -Raw | ConvertFrom-Json
$version = $firefoxManifest.version
$chromiumManifest | Add-Member -NotePropertyName 'version' -NotePropertyValue $version -Force
$chromiumManifest | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $outDir 'manifest.json')

Write-Host "--- Done. Load unpacked from: $outDir ---"

if (-not $Pack) {
  exit 0
}

Write-Host '--- Packing signed .crx ---'
if (-not (Test-Path $keyPath)) {
  throw "Signing key not found at $keyPath -- see native-host/README.md. Cannot -Pack without it."
}

$chromeExe = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$edgeExe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (Test-Path $chromeExe) {
  $packer = $chromeExe
} elseif (Test-Path $edgeExe) {
  $packer = $edgeExe
} else {
  throw 'Neither Chrome nor Edge found at their default install paths -- either is needed to run --pack-extension.'
}

$crxPath = Join-Path $buildDir 'twtdl-extension.crx'
if (Test-Path $crxPath) { Remove-Item $crxPath -Force }
$producedCrx = Join-Path $buildDir 'unpacked.crx'
if (Test-Path $producedCrx) { Remove-Item $producedCrx -Force }

& $packer "--pack-extension=$outDir" "--pack-extension-key=$keyPath" --no-sandbox | Out-Null

if (-not (Test-Path $producedCrx)) {
  throw "Expected $producedCrx after packing but it wasn't created -- --pack-extension's output naming may have changed."
}
Move-Item $producedCrx $crxPath -Force
Write-Host "Wrote $crxPath"

Write-Host '--- Verifying packed .crx matches the expected extension ID ---'
$opensslExe = 'openssl'
if (-not (Get-Command $opensslExe -ErrorAction SilentlyContinue)) {
  $gitOpenssl = 'C:\Program Files\Git\mingw64\bin\openssl.exe'
  if (Test-Path $gitOpenssl) {
    $opensslExe = $gitOpenssl
  } else {
    throw 'openssl not found on PATH and not found at Git for Windows'' bundled location -- install OpenSSL or Git for Windows to verify the packed .crx.'
  }
}
$pubDerPath = Join-Path $buildDir 'pub.der.tmp'
# openssl writes an informational "writing RSA key" line to stderr on
# success; under $ErrorActionPreference = 'Stop' that gets promoted to a
# terminating error unless briefly relaxed here.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $opensslExe rsa -in $keyPath -pubout -outform DER -out $pubDerPath 2>$null
$ErrorActionPreference = $prevEAP
$pubDer = [System.IO.File]::ReadAllBytes($pubDerPath)
$crxBytes = [System.IO.File]::ReadAllBytes($crxPath)
Remove-Item $pubDerPath -Force

function Find-Bytes($haystack, $needle) {
  for ($i = 0; $i -le $haystack.Length - $needle.Length; $i++) {
    $match = $true
    for ($j = 0; $j -lt $needle.Length; $j++) {
      if ($haystack[$i + $j] -ne $needle[$j]) { $match = $false; break }
    }
    if ($match) { return $true }
  }
  return $false
}

if (-not (Find-Bytes $crxBytes $pubDer)) {
  throw "Packed .crx does not appear to contain the expected public key -- signing key mismatch."
}
Write-Host "Confirmed: .crx is signed with the key matching extension ID $ExpectedExtensionId"

Write-Host '--- Generating update.xml ---'
$updateXml = @"
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$ExpectedExtensionId'>
    <updatecheck codebase='$CrxDownloadUrl' version='$version' />
  </app>
</gupdate>
"@
$updateXmlPath = Join-Path $buildDir 'update.xml'
Set-Content -Path $updateXmlPath -Value $updateXml -NoNewline
Write-Host "Wrote $updateXmlPath (version $version, codebase $CrxDownloadUrl)"

Write-Host "--- Done. Release assets: $crxPath, $updateXmlPath ---"
Write-Host "Installer policy should point at: $UpdateManifestUrl"
