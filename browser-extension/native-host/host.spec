# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller build for the native messaging host.

Builds a --onedir distributable (not --onefile): ffmpeg has to ship
alongside host.exe regardless, so a self-extracting one-file exe would just
re-extract everything into a temp dir on every launch for no benefit.

Usage (from this directory, once the build venv has `pip install yt-dlp pillow`
and vendor/ffmpeg/ has been populated, see vendor/README.md):

    pyinstaller host.spec

Output lands in dist/host/ (host.exe + supporting files), which is what the
Inno Setup installer (later phase) copies into place.
"""

import os

from PyInstaller.utils.hooks import collect_submodules

HOST_DIR = SPECPATH
BACKEND_DIR = os.path.join(os.path.dirname(HOST_DIR), 'backend')
VENDOR_FFMPEG_DIR = os.path.join(HOST_DIR, 'vendor', 'ffmpeg')

binaries = []
for name in ('ffmpeg.exe', 'ffprobe.exe'):
    path = os.path.join(VENDOR_FFMPEG_DIR, name)
    if os.path.exists(path):
        binaries.append((path, '.'))
    else:
        print('WARNING: %s not found in vendor/ffmpeg/, see vendor/README.md' % name)

a = Analysis(
    [os.path.join(HOST_DIR, 'host.py')],
    pathex=[BACKEND_DIR],
    binaries=binaries,
    datas=[],
    # yt_dlp.extractor imports its extractor classes statically, so this is
    # belt-and-suspenders rather than strictly required.
    hiddenimports=collect_submodules('yt_dlp.extractor'),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='host',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # GUI subsystem, not console: same reasoning as using pythonw.exe in
    # host_dev.bat, so no console window flashes when Firefox launches it.
    console=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name='host',
)
