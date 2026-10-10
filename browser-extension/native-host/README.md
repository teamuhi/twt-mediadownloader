# Native messaging host

This is what the Firefox extension actually talks to. Firefox launches this
process itself via `browser.runtime.connectNative()` and manages its
lifecycle, so there's no server to start by hand and no auth token to pair
(compare to `backend/server.py`, which is the old/dev-only HTTP path kept
around for fast curl-based iteration).

`host.py` speaks Firefox's native messaging stdio protocol (4-byte
little-endian length prefix + UTF-8 JSON, both directions) and shares its
actual extraction/download logic with `backend/server.py` via
`backend/core.py`.

## Local dev setup (no packaging)

Prerequisite: `pip install yt-dlp pillow mutagen` (not vendored in this repo; both
`host.py` and `backend/server.py` import it as a normal dependency).

Firefox finds native messaging hosts via a registry key whose value is the
absolute path to a manifest JSON file, whose own `path` field is the
absolute path to an executable (no arguments allowed). For local testing
before any PyInstaller build exists, that executable is a small `.bat`
wrapper around `pythonw.exe` (a GUI-subsystem Python avoids a console
window flashing on every launch).

1. Create `host_dev.bat` next to this README (gitignored, since it has your
   local Python path baked in):
   ```bat
   @echo off
   "<path to pythonw.exe>" "<repo>\browser-extension\native-host\host.py"
   ```

2. Copy `com.nickel.nickel_tools.json.template` to
   `com.nickel.nickel_tools.json` (gitignored) next to it, and
   replace `__HOST_EXE_PATH__` with the absolute path to `host_dev.bat`
   (JSON-escape backslashes, e.g. `C:\\Users\\you\\...\\host_dev.bat`).

3. Register it for your user (no admin rights needed):
   ```powershell
   $key = 'HKCU:\Software\Mozilla\NativeMessagingHosts\com.nickel.nickel_tools'
   New-Item -Path $key -Force | Out-Null
   Set-ItemProperty -Path $key -Name '(Default)' -Value '<repo>\browser-extension\native-host\com.nickel.nickel_tools.json'
   ```

4. Load the extension via `about:debugging#/runtime/this-firefox` as usual.
   No options page / token step anymore; it just works once the registry
   key points at a valid manifest.

Check `%LOCALAPPDATA%\nickel-tools\host.log` if something isn't
connecting. `host.py` never prints to stdout/stderr (that would corrupt
the message stream Firefox reads), so all diagnostics go there instead.

## Local dev setup for Chrome/Edge/Brave

Same `host.py` and the same `host_dev.bat` from the Firefox setup above are
reused as-is (the native messaging wire protocol is identical across
Firefox and Chromium); only the manifest's `allowed_origins` field and the
registry location differ per browser.

1. Build the unpacked extension: from `browser-extension/installer/`, run
   `.\build-chromium.ps1`. This produces
   `browser-extension/installer/chromium-build/unpacked/`.
2. Load it via `chrome://extensions` (or `edge://extensions`,
   `brave://extensions`) with Developer mode on > Load unpacked > pick that
   folder. Note the extension's ID Chrome shows you -- it should be
   `lnpcggkomlddjkfpkbamcjkdkpnheejm`, derived from the production signing
   key at `browser-extension/installer/signing/chromium-key.pem` (see
   `extension-chromium/manifest.json`'s `key` field); if it's different,
   something about the manifest's `key` field changed and the template below
   needs updating to match.
3. Copy `com.nickel.nickel_tools.chromium.json.template` to
   `com.nickel.nickel_tools.chromium.json` (gitignored) next to it,
   and replace `__HOST_EXE_PATH__` with the absolute path to the same
   `host_dev.bat` used for Firefox (JSON-escape backslashes).
4. Register it per browser you're testing (HKCU, no admin rights needed) --
   the registry path differs per vendor even though the manifest content is
   identical:
   ```powershell
   # Chrome
   $key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.nickel.nickel_tools'
   # Edge
   $key = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.nickel.nickel_tools'
   # Brave
   $key = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.nickel.nickel_tools'

   New-Item -Path $key -Force | Out-Null
   Set-ItemProperty -Path $key -Name '(Default)' -Value '<repo>\browser-extension\native-host\com.nickel.nickel_tools.chromium.json'
   ```
5. Reload the extension (the reload icon on its card in `chrome://extensions`)
   after registering, then open the popup as usual.

The `key`/extension ID baked into `extension-chromium/manifest.json` is the
real, permanent production signing key
(`browser-extension/installer/signing/chromium-key.pem`, gitignored) --
losing it means a new extension ID for all future updates; leaking it lets
someone forge updates to anyone with the force-install policy applied. Keep
a durable backup outside git.

## Packaging

Once bundled with PyInstaller (`pyinstaller host.spec`), `path` in the
manifest points directly at the built `host.exe` instead of `host_dev.bat`,
and the Windows installer (`../installer/`) writes the manifest + registry
key automatically instead of doing it by hand. See `../installer/README.md`
for the full build, and `vendor/README.md` for the ffmpeg licensing note
before bundling one in.
