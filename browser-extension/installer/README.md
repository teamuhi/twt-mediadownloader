# Building the Windows installer

This is the developer-facing build process. For the end-user installation
guide, see `browser-extension/README.md`.

`setup.iss` (Inno Setup) produces one `.exe` that installs everything a user
needs for every browser it finds installed: the bundled native host
(Python + yt-dlp + ffmpeg, via PyInstaller, shared by all browsers), the
Firefox extension (signed by Mozilla through their unlisted distribution
channel), and the Chrome/Edge/Brave extension (installed via each browser's
own `ExtensionInstallForcelist` enterprise policy instead, since Chromium
has no unlisted-but-signed equivalent to Firefox's channel); see "Why isn't
the extension in an official store" in the main README for both.

## One-time setup

- `pip install pyinstaller yt-dlp` (neither is a dependency of anything
  else in this repo; only needed for building the installer)
- An LGPL Windows ffmpeg build in `../native-host/vendor/ffmpeg/ffmpeg.exe`
  and `ffprobe.exe`, see `../native-host/vendor/README.md`
- Inno Setup 6: `winget install -e --id JRSoftware.InnoSetup --scope user --silent`
  (installs to `%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe`)
- A local Chrome or Edge install (used only to run `--pack-extension`; the
  `.crx` it produces works in Chrome, Edge, and Brave alike)
- The Chromium production signing key at `signing/chromium-key.pem`
  (gitignored, **never commit it** -- see `native-host/README.md` for what
  it is and why losing or leaking it is a real problem, not just an
  inconvenience). Generate it once, if it doesn't already exist:
  ```bash
  openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out signing/chromium-key.pem
  ```
  then derive the base64 public key for `extension-chromium/manifest.json`'s
  `"key"` field and the extension ID for `setup.iss`'s
  `#define ChromiumExtensionId` and the native-messaging-host template's
  `allowed_origins` -- all three must stay in sync if this key is ever
  regenerated:
  ```bash
  openssl rsa -in signing/chromium-key.pem -pubout -outform DER | openssl base64 -A
  openssl rsa -in signing/chromium-key.pem -pubout -outform DER | openssl dgst -sha256 -binary | head -c16 | od -An -tx1 | tr -d ' \n' | tr '0123456789abcdef' 'abcdefghijklmnop'
  ```

## Build

```powershell
.\build.ps1              # Firefox: .xpi + host.exe + installer
.\build-chromium.ps1 -Pack   # Chromium: unpacked dir + signed .crx + update.xml
```

`build.ps1` packages `browser-extension/extension/` into
`twtdl-extension.xpi`, runs `pyinstaller host.spec` in `native-host/`
to produce `dist/host/`, then compiles `setup.iss` (which bundles that xpi
and host.exe together) into
`browser-extension/installer/Output/twtdl-extension-setup.exe`. The
`.xpi` it produces is **unsigned** -- sign it via AMO before shipping (see
below), then re-run `.\build.ps1` (or just recompile `setup.iss` directly)
so the installer bundles the signed copy.

`build-chromium.ps1 -Pack` assembles the Chromium extension (sharing
`popup.js`/`popup.css`/`popup.html` from `extension/` rather than
duplicating them -- see the comments at the top of the script), packs and
signs it into `chromium-build/twtdl-extension.crx` using the signing
key above, self-verifies the packed `.crx`'s embedded key matches the
expected extension ID, and generates `chromium-build/update.xml`. Both of
those, not the installer, are what get uploaded as GitHub Release assets --
see "How Chromium updates get found" below. Omit `-Pack` to just refresh
the unpacked dev-testing build without touching signing at all.

Signing the Firefox `.xpi` (a separate step, needs a
[Mozilla Add-on Developer API key](https://addons.mozilla.org/developers/addon/api/key/)):
```bash
npx web-ext sign --source-dir=../extension --artifacts-dir=signed --channel=unlisted --api-key=<issuer> --api-secret=<secret>
cp signed/*.xpi twtdl-extension.xpi
```

None of `dist/`, `build/`, `vendor/ffmpeg/`, `Output/`, `signing/`,
`signed/`, `chromium-build/`, or the generated `.xpi` are committed to git
(large binaries and secrets; the built artifacts are published as GitHub
Release assets instead, not repo files).

## How Chromium updates get found

`ExtensionInstallForcelist` points Chrome/Edge/Brave at a fixed URL
(`#define UpdateManifestURL` in `setup.iss`) for `update.xml`, which in turn
points at the `.crx`. Both need to keep working forever at the same URL
even as new versions ship, so both are uploaded to every release under the
same fixed names and referenced via GitHub's "latest release" redirect
(`.../releases/latest/download/update.xml`,
`.../releases/latest/download/twtdl-extension.crx`) rather than a
per-tag URL that would change every release. Every release must include
both assets under those exact names, or the installer's already-applied
policy stops finding updates.

## What the installer actually does

Requires admin rights, all under one UAC prompt, for every browser it finds
installed:

1. Copies the bundled host (`host.exe` + `_internal/`, including ffmpeg) to
   `Program Files\twtdl-extension\`. One copy serves every browser.
2. Writes a native messaging manifest and registers it per browser:
   `HKLM\SOFTWARE\Mozilla\NativeMessagingHosts\...` for Firefox, and the
   `...\Google\Chrome\...` / `...\Microsoft\Edge\...` /
   `...\BraveSoftware\Brave-Browser\...` equivalents for the others (all
   pointing at the same `host.exe`).
3. **Firefox**: locates the installation via the Windows App Paths registry
   key, and if it doesn't already have a `distribution\policies.json`,
   writes one that installs the bundled `.xpi` via Firefox's
   `ExtensionSettings` policy. If a `policies.json` already exists, the
   installer leaves it alone and shows the snippet to add by hand instead
   of risking overwriting an existing configuration.
4. **Chrome/Edge/Brave**: for each one detected (checking both HKLM/HKCU
   App Paths and common per-user install locations, since unlike Firefox
   these are often installed without admin rights), merges one entry into
   that browser's own `ExtensionInstallForcelist` policy
   (`HKLM\SOFTWARE\Policies\<Vendor>\<Product>\ExtensionInstallForcelist`,
   a numbered list of `"<extension id>;<update url>"` strings) pointed at
   the update manifest URL above. This never touches pre-existing unrelated
   entries in that same list (enumerates existing numbered values and adds
   its own at the next free index), and is idempotent on re-install/upgrade
   (does nothing if its entry is already present). Which exact value name
   it created is recorded in a marker file so uninstall removes only that
   one entry.

The uninstaller reverses all of the above for whichever browsers were
touched: removes the install directory, every native messaging registry
key it created, the Firefox `policies.json` (only if this installer wrote
it), and each browser's owned `ExtensionInstallForcelist` entry (never the
whole policy key).

## Testing changes to this script

Compiling doesn't run the installer. Actually running it modifies real
system state (Program Files, HKLM, and whatever Firefox/Chrome/Edge/Brave
installs it finds), so test on a VM or throwaway machine when possible, and
always verify the uninstaller actually undoes each step, before pointing it
at a machine you care about. The `ExtensionInstallForcelist` merge/remove
logic can be sanity-checked without admin rights or the installer itself by
running the same enumerate/next-free-index/remove-only-owned-entry
algorithm against a scratch `HKCU` key first.
