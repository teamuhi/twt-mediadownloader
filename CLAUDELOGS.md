
## Rename leconnn -> twtdl
- Replaced every `leconnn` with `twtdl` (native host name `com.twtdl.youtube_dl_extension`, GitHub URLs, installer publisher, .gitignore, READMEs, both background.js).
- Renamed the two native-host `.json.template` files to match.
- Not yet renamed: `youtube_dl_extension` / "youtube-dl" naming itself, and the GitHub repo URLs now point at `twtdl/youtube-dl-extension` (placeholder; fix once real repo exists).

## Rename youtube-dl -> twtdl
- `youtube-dl-extension` -> `twtdl-extension` (xpi/crx/setup.exe names, gecko id `twtdl-extension@local`, GitHub URLs), `youtube_dl_extension` -> `twtdl_extension` (native host `com.twtdl.twtdl_extension`), display name "youtube-dl Downloader" -> "twtdl Downloader".
- Renamed the two native-host `.json.template` files again; .gitignore updated by the sed.
- Left alone on purpose: `yt_dlp.YoutubeDL` (library API) and the historical "fork of youtube-dl CLI" sentence in root README.
- Re-register native host registry entries after this (name changed). Real GitHub repo URL still a placeholder.

## Twitter/X downloader + tweet card + GIF conversion (v0.6.0) -- DONE
Plan: `C:\Users\timoT\.claude\plans\plan-this-task-to-delegated-parnas.md`.
- Popup now has 2 tabs: YouTube (old MP4/MP3/WAV panel, unchanged) and Twitter (new). A tweet URL auto-selects Twitter.
- Twitter tab: **Media only** (MP4 w/ quality, photo original, video->GIF with fps/speed/width/start-end trim + looping preview) and **Tweet card** (avatar, name, @handle, optional text/date/verified checkboxes, light/dark card theme; MP4 for video/GIF tweets, PNG for photos/text-only).
- Errors: `backend/errors.py` `classify_error()` -> `errorCode/error/errorHint/errorDetail` (E_AUTH_REQUIRED, E_NOT_FOUND, E_NO_MEDIA, E_EXTRACTOR_BROKEN, E_FORMAT, E_FFMPEG_*, E_NETWORK, ...). Shown in popup error box + notification title. Settings panel shows yt-dlp version/age.
- New files: `backend/errors.py`, `backend/twitter.py` (syndication API metadata, yt-dlp fallback, cookie file, direct mp4 variant download), `backend/render.py` (ffmpeg runner, GIF, Pillow card), `extension/twitter.js`.
- Changed: `backend/core.py` (`run_twitter_download`, `get_tweet_info`, `validate_twitter_request`, tmp dir, shared `make_progress_hook`), `native-host/host.py` (`tweet` msg, `source:'twitter'` download, `sweep_tmp`), `backend/server.py` (`/tweet`), both `background.js` (cookies via `getXCookies`, `failure()` -> `{ok:false,error,errorCode,...}` responses, `tweetResult`), `popup.html/css/js`, both manifests (+`cookies`, x.com/twitter.com host perms), chromium `browser-polyfill.js` (now a plain alias; popup.js `send()` converts `{ok:false}` to a thrown `AppError`), `installer/build-chromium.ps1` (copies twitter.js), setup.iss -> 0.6.0, READMEs.
- Decisions: videos/GIFs are downloaded straight from the syndication mp4 variants (yt-dlp only as fallback when syndication has nothing); `Pillow` is a new build dependency (`pip install yt-dlp pillow pyinstaller`).
- Tested (scratch venv): fetch of video/multi-video/mixed/text tweets, mp4, GIF (frame count matches speed+trim), card video light/dark (audio kept), photo card PNG, text-only card, error codes, native host over framed stdio, popup screenshots via headless Chrome with a stubbed `browser` API (light/dark, GIF, card, error states).
- NOT tested: real Firefox/Chrome install with the native host registered, sensitive-tweet flow with real cookies (E_AUTH_REQUIRED path only exercised via UI stub / yt-dlp message mapping), PyInstaller build with Pillow, `build-chromium.ps1`.
- Gotcha: Microsoft Store Python virtualizes writes under `%LOCALAPPDATA%`, so ffmpeg can't see files the dev host writes there; set `LOCALAPPDATA` elsewhere when testing with Store Python (the frozen host is unaffected).
- Emoji in card text use Segoe UI Emoji; newer emoji missing from that font are skipped. Non-Latin scripts (CJK) have no fallback font in the card renderer yet.

## Installed ffmpeg/ffprobe (dev machine) -- DONE
- `winget install Gyan.FFmpeg` (v9.0.2 full build) -> ffmpeg, ffprobe, ffplay on PATH. Open a new shell/restart VS Code for PATH to apply. No repo files changed.

## Packaged installer build (v0.6.0) -- BUILT, NOT YET RELEASED/INSTALLED
- Built: `installer/Output/twtdl-extension-setup.exe` (99 MB), `installer/chromium-build/{twtdl-extension.crx,update.xml}`, `installer/twtdl-extension.xpi` (UNSIGNED), `native-host/dist/host/` (PyInstaller, LGPL ffmpeg from `vendor/ffmpeg/`). All gitignored.
- Tools installed on this PC: Inno Setup 6 (winget, user scope), PyInstaller (in the scratch venv used for building). `build.ps1` aborts on PowerShell 5.1 because PyInstaller prints an admin warning to stderr; run `python -m PyInstaller host.spec --noconfirm` and `ISCC.exe setup.iss` by hand instead (or use pwsh 7).
- Installer URLs now point at `github.com/teamuhi/twt-mediadownloader` (setup.iss, build-chromium.ps1, README).
- NEW Chromium signing key generated at `installer/signing/chromium-key.pem` (gitignored; BACK IT UP, losing it changes the extension ID). New extension ID `lnpcggkomlddjkfpkbamcjkdkpnheejm` synced in: `extension-chromium/manifest.json` `key`, `setup.iss`, `build-chromium.ps1`, native-host chromium template + README. The old ID `nbackfald...` belonged to upstream's key.
- LGPL ffmpeg has no libx264: `render.h264_args()` now falls back libx264 -> libopenh264 -> h264_mf -> mpeg4 (card videos verified with the bundled LGPL build, frozen host.exe tested for GIF, video card, photo card).
- TODO for the user: (1) sign the .xpi via AMO (`npx web-ext sign --source-dir=../extension --artifacts-dir=signed --channel=unlisted --api-key=... --api-secret=...`, copy to `twtdl-extension.xpi`, recompile setup.iss) -- release Firefox rejects the unsigned one; (2) publish a GitHub Release on teamuhi/twt-mediadownloader with `twtdl-extension-setup.exe`, `twtdl-extension.crx`, `update.xml` (fixed names; repo must be public); (3) installer itself never run here: test on a VM/throwaway PC, Chrome may ignore force-install policy on non-domain Windows (fallback: Load unpacked from `chromium-build/unpacked`, host registered by the installer).

- UPDATE: the .xpi is now SIGNED by Mozilla (unlisted, 0.6.0, `installer/signed/*.xpi` copied over `installer/twtdl-extension.xpi`) and `Output/twtdl-extension-setup.exe` was recompiled with it. AMO API credentials were passed via env vars only and are not stored anywhere in the repo; the user was advised to regenerate them. Next release must bump the version (AMO rejects a re-upload of the same version). TODO (1) above is done; (2) and (3) remain.

## Per-tab download location (v0.6.1) -- DONE in source, installer NOT rebuilt
- Config keys `download_dir` (YouTube) + `twitter_download_dir` (falls back to `download_dir` when unset) in `backend/core.py` (`get_download_dir(source)`, `set_download_dir(path, source)`, `ensure_download_dir(dir, source)`); `host.py` `getConfig`/`setConfig` carry `downloadDir` + `twitterDownloadDir` (setConfig only touches keys that are present, so saving one never pins the other); `browseFolder` takes `source` so the picker opens at that tab's folder (both `background.js` forward it).
- Popup settings: two location fields + Browse buttons (`dirFields` in popup.js); only edited fields are saved. The one-off folder button opens at the active tab's folder.
- Verified via host stdio test (inherit -> set -> clear -> set; a Twitter download lands in the Twitter dir). Version bumped to 0.6.1 (manifest + setup.iss) because 0.6.0 is already signed on AMO and a changed extension needs a new version to sign.
- TODO: rebuild host (`pyinstaller host.spec`), re-sign the .xpi at 0.6.1 (needs fresh AMO API credentials), `build-chromium.ps1 -Pack`, recompile `setup.iss`, then publish the release.

## Quote-post cards (v0.6.1, unreleased) -- DONE in source
- Syndication `quoted_tweet` is now parsed (`twitter._from_syndication`, `tweet['quoted']` = author/text/createdAt/url). Its media is appended to `tweet['media']` with `from:'quoted'` (own media is `from:'own'`; `index` is unique across both).
- `render.build_card(tweet, opts, avatar, own, quote, quote_avatar)` takes media specs (`{'images': [...]}` static, or `{'aspect': f}` = reserved video box) and draws the quoted tweet in a bordered box under the main media. `render_card_video(..., target='own'|'quote', ...)` plays the selected video in the matching box and shows the other post's media as stills (`core._card_images`). `frame_overlay` now takes a corner radius. New card option `showQuote` (default on).
- Media-only downloads of quoted media are named after the quoted tweet. `mediaIndex` max raised to 15.
- Popup: strip shows quoted items with a "QT" badge, "Quote" checkbox (only when the tweet has a quote), live preview has a quote box; `defaultTitle()` mirrors the host naming.
- Plain reposts (retweets) have no URL of their own (X copies the original's link), so nothing to detect; documented in the README.
- Verified: quote with quoted video (no own media), quote with own video + 2 photos + text-only quote (video MP4 and photo-grid PNG), quote hidden, media-only from quoted video; regression on non-quote cards/media. Not yet rebuilt into the installer (needs rebuild + re-sign at 0.6.1, see previous section).

## GitHub Release v0.6.0 -- PUBLISHED
- https://github.com/teamuhi/twt-mediadownloader/releases/tag/v0.6.0, tag on commit 16d25d156 (the 0.6.0 source the built artifacts match). Assets: `twtdl-extension-setup.exe`, `twtdl-extension.crx`, `update.xml` (fixed names; installer URLs use `releases/latest/download/`).
- Made with the GitHub REST API using the git-stored credential (`gh` is not installed on this PC). Release notes and commit carry no Claude attribution, per the user.
- v0.6.1 features (per-tab download folders, quote-post cards) are in master but NOT in this release: still need host rebuild, AMO re-sign at 0.6.1, `build-chromium.ps1 -Pack`, recompile `setup.iss`, then a new v0.6.1 release.
