
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
