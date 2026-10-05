# ffmpeg for the bundled build

`host.spec` looks for `ffmpeg.exe` and `ffprobe.exe` in this directory
(`vendor/ffmpeg/`) and bundles them into `dist/host/` alongside `host.exe`
if present. Not committed to git (large binaries; see the root
`.gitignore`).

## Which build to use

Use an **LGPL-only** Windows build, not a GPL one. The gyan.dev "full"
build many people already have installed (including the one on this dev
machine at `C:\ffmpeg\bin\ffmpeg.exe`) is GPL-configured (it bundles
GPL-licensed components like libx264/libx265/libvidstab). Redistributing a
GPL build to end users through the installer would carry an ongoing
obligation to provide or credibly offer ffmpeg's corresponding source for
as long as it's distributed. An LGPL-only build avoids that.

Recommended source: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases),
pick a release asset with `-lgpl` in the filename. Use a version-pinned
asset (e.g. `ffmpeg-nX.Y-latest-win64-lgpl-X.Y.zip`), not the rolling
`master-latest` build, so the exact source this binary was built from stays
identifiable later.

Currently bundled:

```
Source:  https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-9.0.zip
Version: n9.0.2 (ffmpeg -version), built 2026-09-26
Build config confirms LGPL: --enable-version3, --disable-libx264,
  --disable-libx265, --disable-libxavs2, --disable-libxvid (the GPL-only
  encoders are off; --enable-libmp3lame and stream copy/remux are unaffected).
  Tweet-card videos need an H.264 encoder, and this build has no libx264,
  so backend/render.py `h264_args()` picks libx264 if present, else the
  bundled libopenh264, else Windows' h264_mf, else mpeg4.
Corresponding source: the BtbN/FFmpeg-Builds repository and its pinned
  FFmpeg upstream commit for this release satisfy LGPL's source-availability
  requirement; both are public.
```

If this ever needs updating, replace the two files below and update this
block to match.

## Setup

1. Download and extract the chosen build.
2. Copy `bin/ffmpeg.exe` and `bin/ffprobe.exe` into this directory
   (`vendor/ffmpeg/ffmpeg.exe`, `vendor/ffmpeg/ffprobe.exe`).
3. Run `pyinstaller host.spec` from `browser-extension/native-host/`.

If an LGPL build ever proves insufficient (missing a codec that turns out
to matter) and a GPL build has to be substituted instead, the GPL
source-offer and license-text-inclusion obligations need to be honored
explicitly at that point, not skipped.
