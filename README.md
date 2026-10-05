# twtdl-extension

A Firefox/Chrome/Edge/Brave extension for downloading video or audio as
MP4 or tagged audio (MP3, M4A, Opus, FLAC, WAV, ...) from any site [yt-dlp](https://github.com/yt-dlp/yt-dlp)
supports, built on top of its download engine.

**[See `browser-extension/README.md` for the actual project](browser-extension/README.md):**
what it does, how to install it, and how it works.

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

## License

Unlicense (public domain), see `LICENSE`. This covers this repository's own
code; yt-dlp is a separate dependency (also Unlicense) installed via pip,
not vendored here.
