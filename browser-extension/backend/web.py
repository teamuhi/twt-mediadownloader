# coding: utf-8
"""Web tab downloads: saves the images/video/audio a page exposes as direct
files, and hands embedded players (YouTube, Vimeo, ...) to yt-dlp. Same
on_progress protocol as core.run_download."""

from __future__ import unicode_literals

import mimetypes
import os
import re
import urllib.parse
import urllib.request

import yt_dlp
from yt_dlp.utils import sanitize_filename

import core
import errors
import render
import twitter

MAX_ITEMS = 300
KINDS = ('image', 'video', 'audio', 'embed')
# Image conversion targets -> (Pillow format, file extension, extensions already in that format)
IMAGE_FORMATS = {
    'png': ('PNG', 'png', ('png',)),
    'jpg': ('JPEG', 'jpg', ('jpg', 'jpeg', 'jpe')),
    'webp': ('WEBP', 'webp', ('webp',)),
    'gif': ('GIF', 'gif', ('gif',)),
    'bmp': ('BMP', 'bmp', ('bmp',)),
    'tiff': ('TIFF', 'tiff', ('tif', 'tiff')),
    'avif': ('AVIF', 'avif', ('avif',)),
}
IMAGE_SAVE_ARGS = {
    'JPEG': {'quality': 92, 'optimize': True},
    'PNG': {'optimize': True},
    'WEBP': {'quality': 90},
    'TIFF': {'compression': 'tiff_lzw'},
    'AVIF': {'quality': 80},
}
NO_ALPHA = ('JPEG', 'BMP')  # formats that get transparency flattened onto white
# Video conversion targets -> (file extension, extensions already in that container)
VIDEO_FORMATS = {
    'mp4': ('mp4', ('mp4', 'm4v')),
    'webm': ('webm', ('webm',)),
    'mkv': ('mkv', ('mkv',)),
    'mov': ('mov', ('mov',)),
    'avi': ('avi', ('avi',)),
    'gif': ('gif', ()),
}
CHUNK = 1 << 16
FILENAME_RE = re.compile(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', re.IGNORECASE)


def validate_items(items):
    """Returns a cleaned [{url, kind}] list; raises ValueError (user-facing)."""
    if not isinstance(items, list) or not items:
        raise ValueError('Select at least one item to download')
    if len(items) > MAX_ITEMS:
        raise ValueError('Too many items (max %d)' % MAX_ITEMS)
    clean = []
    for item in items:
        url = item.get('url') if isinstance(item, dict) else None
        kind = item.get('kind') if isinstance(item, dict) else None
        if not url or not core.HTTP_URL_RE.match(url) or kind not in KINDS:
            raise ValueError('URL is missing or invalid')
        clean.append({'url': url, 'kind': kind})
    return clean


def _file_name(url, headers):
    """Name from Content-Disposition, else the URL path; the extension falls
    back to the Content-Type when the name has none."""
    name = ''
    m = FILENAME_RE.search(headers.get('Content-Disposition') or '')
    if m:
        name = urllib.parse.unquote(m.group(1))
    if not name:
        name = urllib.parse.unquote(urllib.parse.urlparse(url).path.rsplit('/', 1)[-1])
    root, ext = os.path.splitext(name)
    if not ext or len(ext) > 6:
        guessed = mimetypes.guess_extension((headers.get('Content-Type') or '').split(';')[0].strip()) or ''
        root, ext = name, {'.jpe': '.jpg'}.get(guessed, guessed)
    return sanitize_filename(root or 'file', restricted=False) + ext


def _download_direct(item, page_url, target_dir, on_overall):
    req = urllib.request.Request(item['url'], headers={'User-Agent': twitter.USER_AGENT, 'Referer': page_url})
    with urllib.request.urlopen(req, timeout=60) as resp:
        path = core.dedupe_path(os.path.join(target_dir, _file_name(item['url'], resp.headers)))
        total = int(resp.headers.get('Content-Length') or 0)
        done = 0
        try:
            with open(path, 'wb') as out:
                while True:
                    chunk = resp.read(CHUNK)
                    if not chunk:
                        break
                    out.write(chunk)
                    done += len(chunk)
                    if total:
                        on_overall(done / total)
        except Exception:
            try:
                os.remove(path)  # don't leave a truncated file behind
            except OSError:
                pass
            raise
    return path


def convert_image(path, target):
    """Re-encodes the image at `path` as `target` (a key of IMAGE_FORMATS) next
    to it and removes the original. Returns the new path, or `path` unchanged
    when it already is that format. Animated images keep their first frame and
    transparency is flattened onto white for JPG/BMP. Raises on anything Pillow
    can't read (e.g. SVG); the caller then keeps the original file."""
    from PIL import Image
    fmt, ext, same = IMAGE_FORMATS[target]
    root, old_ext = os.path.splitext(path)
    if old_ext.lower().lstrip('.') in same:
        return path
    dest = core.dedupe_path(root + '.' + ext)
    with Image.open(path) as im:
        im.load()
        has_alpha = im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)
        if fmt in NO_ALPHA:
            if has_alpha:
                rgba = im.convert('RGBA')
                flat = Image.new('RGB', rgba.size, (255, 255, 255))
                flat.paste(rgba, mask=rgba.getchannel('A'))
                im = flat
            elif im.mode != 'RGB':
                im = im.convert('RGB')
        elif im.mode not in ('RGB', 'RGBA', 'L', 'LA'):
            im = im.convert('RGBA' if has_alpha else 'RGB')
        try:
            im.save(dest, fmt, **IMAGE_SAVE_ARGS.get(fmt, {}))
        except Exception:
            if os.path.exists(dest):
                os.remove(dest)
            raise
    os.remove(path)
    return dest


def convert_video(path, target, on_progress, ffmpeg_location=None):
    """Re-encodes/remuxes the video at `path` into `target` (a key of
    VIDEO_FORMATS) next to it and removes the original. Returns the new path,
    or `path` unchanged when it is already in that container. Raises
    FfmpegError on failure (the half-written output is removed)."""
    ext, same = VIDEO_FORMATS[target]
    root, old_ext = os.path.splitext(path)
    if old_ext.lower().lstrip('.') in same:
        return path
    dest = core.dedupe_path(root + '.' + ext)
    try:
        if target == 'gif':
            render.to_gif(path, dest, 15, 1, 480, 0, None, on_progress, ffmpeg_location)
        else:
            if target == 'mkv':
                args = ['-i', path, '-c', 'copy']  # Matroska takes any stream, so no re-encode
            elif target == 'webm':
                if not render.has_encoder('libvpx-vp9', ffmpeg_location):
                    raise errors.FfmpegError('this ffmpeg build has no VP9 encoder')
                args = ['-i', path, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4',
                        '-c:a', 'libopus', '-b:a', '128k']
            elif target == 'avi':
                args = ['-i', path, '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'libmp3lame', '-q:a', '3']
            else:  # mp4, mov: H.264 + AAC
                args = ['-i', path, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', *render.h264_args(ffmpeg_location, 1920, 1080),
                        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']
            render.run_ffmpeg(args + [dest], None, on_progress, 'converting', ffmpeg_location)
    except Exception:
        if os.path.exists(dest):
            os.remove(dest)
        raise
    os.remove(path)
    return dest


def _download_embed(item, target_dir, ffmpeg_location, on_overall):
    def hook(d):
        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate')
            if total:
                on_overall((d.get('downloaded_bytes') or 0) / total)

    opts = {
        'quiet': True,
        'no_warnings': True,
        'noprogress': True,  # raw progress text would corrupt the host's framed stdout
        'noplaylist': True,
        'restrictfilenames': False,
        'outtmpl': os.path.join(target_dir, '%(title).150B [%(id)s].%(ext)s'),
        'format': 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
        'merge_output_format': 'mp4',
        'progress_hooks': [hook],
    }
    if ffmpeg_location:
        opts['ffmpeg_location'] = ffmpeg_location
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(item['url'], download=True)
        downloaded = info.get('requested_downloads') or []
        return (downloaded[0].get('filepath') if downloaded else None) or ydl.prepare_filename(info)


def run_web_download(items, page_url, on_progress, ffmpeg_location=None, download_dir=None, title=None, subfolder=False, convert=None):
    """`convert` is {'image': <IMAGE_FORMATS key>, 'video': <VIDEO_FORMATS key>}
    (either may be missing/None to keep the original); images and
    videos/embeds are re-encoded after they download. A bare string is
    treated as the image target."""
    convert = convert if isinstance(convert, dict) else {'image': convert}
    targets = {
        'image': convert.get('image') if convert.get('image') in IMAGE_FORMATS else None,
        'video': convert.get('video') if convert.get('video') in VIDEO_FORMATS else None,
        'embed': convert.get('video') if convert.get('video') in VIDEO_FORMATS else None,
    }
    try:
        items = validate_items(items)
    except ValueError as e:
        on_progress(status='error', **errors.classify_error(e, 'web'))
        return

    try:
        target_dir = core.ensure_download_dir(download_dir, 'web')
        if subfolder and title:
            target_dir = os.path.join(target_dir, sanitize_filename(title, restricted=False)[:80].strip(' .') or 'page')
            os.makedirs(target_dir, exist_ok=True)
    except OSError as e:
        on_progress(status='error', **errors.classify_error(e, 'web'))
        return

    total = len(items)
    saved, failures, last_error = [], 0, None
    first_error = ''
    kept = []  # "SVG to JPG"-style notes for files that could not be converted and stay as downloaded
    for i, item in enumerate(items):
        def on_overall(frac, i=i):
            on_progress(status='downloading', item=i + 1, total=total, percent=round((i + frac) / total * 100, 1))

        def on_convert(i=i, **_):  # ffmpeg reports per-file percent; keep the overall one
            on_progress(status='converting', item=i + 1, total=total, percent=round(i / total * 100, 1))

        on_overall(0)
        try:
            if item['kind'] == 'embed':
                path = _download_embed(item, target_dir, ffmpeg_location, on_overall)
            else:
                path = _download_direct(item, page_url, target_dir, on_overall)
            target = targets.get(item['kind'])
            if target:
                before = os.path.splitext(path)[1].lstrip('.').upper() or 'file'
                try:
                    if item['kind'] == 'image':
                        path = convert_image(path, target)
                    else:
                        on_convert()
                        path = convert_video(path, target, on_convert, ffmpeg_location)
                except Exception:
                    kept.append('%s to %s' % (before, target.upper()))
            saved.append(path)
        except Exception as e:
            failures += 1
            last_error = e
            first_error = first_error or errors.classify_error(e, 'web')['error']

    if not saved:
        on_progress(status='error', **errors.classify_error(last_error, 'web'))
        return
    done = {
        'filename': os.path.basename(saved[0]) if len(saved) == 1 else '%d files' % len(saved),
        'path': saved[0] if len(saved) == 1 else target_dir,
    }
    notes = []
    if failures:
        notes.append('%d of %d failed: %s' % (failures, total, first_error))
    if kept:
        notes.append("%d file(s) kept as the original (could not convert %s)" % (len(kept), ', '.join(sorted(set(kept)))))
    if notes:
        done['warning'] = '\n'.join(notes)
    on_progress(status='finished', percent=100, **done)
