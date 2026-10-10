# nickel.tools
based on the fork by [leoconnn](https://github.com/leconnn/youtube-dl-extension) which is forked from [youtube-dl](https://github.com/ytdl-org/youtube-dl), heavy references to the web tool [cobalt.tools](https://cobalt.meowing.de/). This fork is for my personal use only, I do not claim anything in these repositories.

<p align="center"><img src="browser-extension/extension/icons/icon-128.png" alt="icon" width="128"></p>

**[See `browser-extension/README.md` for the actual project](browser-extension/README.md):**
what it does, how to install it, and how it works.

New: tweet cards can **auto-translate** the tweet and its quoted post (pick a
language in the card's Translate row; the card shows "Translated from ...").

## Image previews

### YouTube
<table>
<tr>
<td align="top-center"><img src="browser-extension/extension/asset_images/yt-video.PNG" width="220"><br><sub>Video</sub></td>
<td align="top-center"><img src="browser-extension/extension/asset_images/yt-audio.PNG" width="220"><br><sub>Audio</sub></td>
</tr>
</table>

### Twitter
<table>
<tr>
<td align="center"><img src="browser-extension/extension/asset_images/twt-media.PNG" width="220"><br><sub>Media only</sub></td>
<td align="center"><img src="browser-extension/extension/asset_images/twt-card.PNG" width="220"><br><sub>Tweet card</sub></td>
<td align="center"><img src="browser-extension/extension/asset_images/twt-card_preview.PNG" width="220"><br><sub>Tweet card preview</sub></td>
</tr>
</table>

### Web
<table>
<tr>
<td align="center"><img src="browser-extension/extension/asset_images/web-media.PNG" width="220"><br><sub>Media</sub></td>
</tr>
</table>

## Layout

- `browser-extension/`: the actual project. Start with its README.
  - `backend/core.py`: the shared extraction/download logic, a thin layer
    over yt-dlp (installed as a normal pip dependency, not vendored here).
  - `native-host/`: the native messaging host every browser's extension
    talks to (same program for all of them), and the PyInstaller build that
    bundles it with yt-dlp and ffmpeg into a standalone Windows program.
  - `extension/`: the Firefox WebExtension (Manifest V2).
  - `extension-chromium/`: the Chrome/Edge/Brave-specific parts of the
    extension (Manifest V3); shares most of its UI code with `extension/`
    at build time rather than duplicating it.
  - `installer/`: the Windows installer (Inno Setup) that ties all of the
    above together into one `.exe`, for every browser it finds installed.

This repo used to be a full fork of the original youtube-dl CLI project;
that history (its own CLI, docs, packaging, and test suite) has been
removed since none of it applies here, this is a browser extension project
that depends on yt-dlp as a library, not a fork of a CLI tool.

## Recent changes

- Export state outside the popup: while a download runs, the toolbar icon
  shows a progress badge (`42%`, the count when several run, then a check or
  `!`) with the title in its tooltip, and a "started" notification is
  replaced by the finished/failed one. All of it can be turned off in
  Settings.
- "Download to a specific folder" and the Settings **Browse...** buttons open
  the normal Windows folder dialog (with its own "Make New Folder" button).
  The extension's background script runs the dialog and starts the download
  or saves the setting afterwards, so it works even though the popup closes
  while the dialog has focus.
- Many more settings: notifications and badge, theme (System/Light/Dark),
  startup tab, remember last-used options, download history, host/yt-dlp versions and a reset button.
- YouTube tab: pick the video container (MP4, MKV or WebM), with a default in
  Settings. WebM is limited to VP9/AV1 and falls back to MP4 if the video
  doesn't offer them.

- YouTube tab: new "Preferred codec" picker under Resolution (H.264 + AAC as
  MP4, VP9 + Opus or AV1 + Opus as WebM). Only codecs the video offers are
  listed; if one isn't available at the chosen resolution it falls back to
  H.264 and says so. Needs the rebuilt native host.
- Better page detection on the Web tab: the page scan now also picks up
  lazy-loaded images (`data-src` etc.), CSS background images, media inside
  iframes and shadow DOM, and HLS/DASH streams. If yt-dlp can't handle a
  page (not only "unsupported URL"), the popup falls back to the Web tab.

## How to Install

- Firefox: Install exe file, and after installing drag the xpi file on the opened firefox browser

- Chrome: Install exe file, then open (or restart) Chrome -- the extension installs itself automatically, no manual steps needed

- Brave: Install exe file, then open (or restart) Brave -- the extension installs itself automatically, no manual steps needed

## License

Unlicense (public domain), see `LICENSE`. This covers this repository's own
code; yt-dlp is a separate dependency (also Unlicense) installed via pip,
not vendored here.
