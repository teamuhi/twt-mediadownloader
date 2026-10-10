#!/usr/bin/env python
# coding: utf-8
"""Shared yt-dlp extraction/download logic.

Used by both server.py (the local HTTP dev/test backend) and
native-host/host.py (the native messaging host used by the packaged
extension), so the actual extraction/conversion behavior only lives in one
place.
"""

from __future__ import unicode_literals

import json
import os
import re
import shutil
import tempfile
import time

import yt_dlp
from yt_dlp.utils import sanitize_filename

import audio_tags
import errors
import render
import twitter

DEFAULT_DOWNLOAD_DIR = os.path.join(os.path.expanduser('~'), 'Downloads', 'nickel-tools')

APP_DATA_DIR = os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'), 'nickel-tools')
CONFIG_PATH = os.path.join(APP_DATA_DIR, 'config.json')
TMP_DIR = os.path.join(APP_DATA_DIR, 'tmp')

HTTP_URL_RE = re.compile(r'^https?://', re.IGNORECASE)

# Audio output formats. `codec` is yt-dlp's preferredcodec, `encoder` the ffmpeg
# encoder it needs (formats whose encoder is missing from the bundled ffmpeg are
# not offered). For lossy formats 'best' means VBR V0 (mp3) or "keep the source
# stream when it already is this codec" (the others).
AUDIO_FORMATS = {
    'mp3': {'label': 'MP3', 'sub': 'Universal', 'codec': 'mp3', 'ext': 'mp3', 'encoder': 'libmp3lame', 'qualities': ['best', '320', '256', '192', '128']},
    'm4a': {'label': 'M4A', 'sub': 'AAC', 'codec': 'm4a', 'ext': 'm4a', 'encoder': 'aac', 'qualities': ['best', '256', '192', '128']},
    'opus': {'label': 'Opus', 'sub': 'Smallest', 'codec': 'opus', 'ext': 'opus', 'encoder': 'libopus', 'qualities': ['best', '160', '128', '96']},
    'ogg': {'label': 'OGG', 'sub': 'Vorbis', 'codec': 'vorbis', 'ext': 'ogg', 'encoder': 'libvorbis', 'qualities': ['best', '320', '192', '128']},
    'flac': {'label': 'FLAC', 'sub': 'Lossless', 'codec': 'flac', 'ext': 'flac', 'encoder': 'flac', 'qualities': []},
    'alac': {'label': 'ALAC', 'sub': 'Apple', 'codec': 'alac', 'ext': 'm4a', 'encoder': 'alac', 'qualities': []},
    'wav': {'label': 'WAV', 'sub': 'Raw PCM', 'codec': 'wav', 'ext': 'wav', 'encoder': 'pcm_s16le', 'qualities': []},
}

MAX_META_LEN = 500
MAX_COVER_DATA_URL = 14_000_000  # ~10 MB of image


def load_config():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except (ValueError, OSError):
            pass
    return {}


def save_config(config):
    os.makedirs(APP_DATA_DIR, exist_ok=True)
    with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(config, f)


CONFIG_DIR_KEYS = {'youtube': 'download_dir', 'twitter': 'twitter_download_dir', 'web': 'web_download_dir'}


def get_download_dir(source='youtube'):
    """Save location for `source` ('youtube', 'twitter' or 'web'). An unset
    Twitter/Web location follows the general one, so existing setups keep working."""
    config = load_config()
    return config.get(CONFIG_DIR_KEYS.get(source)) or config.get('download_dir') or DEFAULT_DOWNLOAD_DIR


def set_download_dir(path, source='youtube'):
    """Validates `path` (or clears the override if falsy) and persists it."""
    if path:
        path = os.path.expanduser(path)
        os.makedirs(path, exist_ok=True)
    config = load_config()
    config[CONFIG_DIR_KEYS[source]] = path or None
    save_config(config)
    return get_download_dir(source)


def ensure_download_dir(download_dir=None, source='youtube'):
    d = download_dir or get_download_dir(source)
    os.makedirs(d, exist_ok=True)
    return d


def _format_size(fmt):
    return fmt.get('filesize') or fmt.get('filesize_approx')


def _best_by_size(candidates, preferred_ext):
    """Picks the candidate matching `preferred_ext` if any do (mirroring the
    ext preference in run_download's format-selector strings), then the one
    with the largest known size among those, as a stand-in for "best"."""
    pool = [f for f in candidates if f.get('ext') == preferred_ext] or candidates
    sized = [f for f in pool if _format_size(f)]
    if sized:
        return max(sized, key=_format_size)
    return pool[0] if pool else None


def video_qualities_from_info(info):
    """Returns [{height, estimated_bytes}, ...] sorted by height descending.
    estimated_bytes is None when yt-dlp didn't report a size for the
    formats at that height (common for some DASH streams); it's always an
    approximation since it doesn't reproduce yt-dlp's exact format selector.
    """
    formats = info.get('formats') or []
    audio_only = [f for f in formats if f.get('acodec') not in (None, 'none') and f.get('vcodec') in (None, 'none')]
    best_audio = _best_by_size(audio_only, 'm4a')
    audio_size = _format_size(best_audio) if best_audio else None

    heights = set()
    for fmt in formats:
        if fmt.get('vcodec') and fmt.get('vcodec') != 'none' and fmt.get('height'):
            heights.add(int(fmt['height']))

    qualities = []
    for h in sorted(heights, reverse=True):
        video_candidates = [f for f in formats if f.get('vcodec') not in (None, 'none') and f.get('height') == h]
        best_video = _best_by_size(video_candidates, 'mp4')
        video_size = _format_size(best_video) if best_video else None
        if video_size is not None and audio_size is not None:
            estimated_bytes = video_size + audio_size
        elif video_size is not None:
            estimated_bytes = video_size
        else:
            estimated_bytes = None
        qualities.append({'height': h, 'estimated_bytes': estimated_bytes})
    return qualities


# Preferred video codec -> (label, yt-dlp regex on the stream's vcodec, container).
# AV1/VP9 pair with Opus, which only the WebM container carries everywhere.
VIDEO_CODECS = {
    'h264': ('H.264', '^(avc1|h264)', 'mp4'),
    'vp9': ('VP9', '^(vp9|vp09)', 'webm'),
    'av1': ('AV1', '^(av01|av1)', 'webm'),
}
DEFAULT_VIDEO_CODEC = 'h264'
VIDEO_CONTAINERS = ('mp4', 'mkv', 'webm')


def _is_codec(fmt, codec):
    return re.match(VIDEO_CODECS[codec][1], fmt.get('vcodec') or '') is not None


def _has_opus(info):
    return any((f.get('acodec') or '').startswith('opus') and f.get('vcodec') in (None, 'none') for f in info.get('formats') or [])


def video_codecs_from_info(info):
    """Codec ids (keys of VIDEO_CODECS) the page can be saved as. H.264 is
    always offered (it falls back to whatever is best); VP9/AV1 need a stream
    in that codec plus an Opus track to go with it."""
    formats = info.get('formats') or []
    has_opus = _has_opus(info)
    return [c for c in VIDEO_CODECS
            if c == DEFAULT_VIDEO_CODEC or (has_opus and any(_is_codec(f, c) for f in formats))]


def _codec_available(info, codec, height):
    """True when `info` has a `codec` stream at `height` or lower, plus Opus audio."""
    try:
        limit = int(height)
    except (TypeError, ValueError):
        return False
    return _has_opus(info) and any(_is_codec(f, codec) and (f.get('height') or 0) and f['height'] <= limit for f in info.get('formats') or [])


def video_format_selector(codec, height):
    """yt-dlp format string for `codec` at up to `height`p; always ends with a
    codec-agnostic fallback."""
    legacy = ('bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]/'
              'bestvideo[height<={h}]+bestaudio/best[height<={h}]').format(h=height)
    if codec == 'h264':
        return "bv*[height<={h}][vcodec~='{r}']+ba[ext=m4a]/{legacy}".format(h=height, r=VIDEO_CODECS[codec][1], legacy=legacy)
    return "bv*[height<={h}][vcodec~='{r}']+ba[acodec^=opus]/{legacy}".format(h=height, r=VIDEO_CODECS[codec][1], legacy=legacy)


def best_audio_kbps(info):
    """Highest audio-only bitrate available, used to estimate MP3 'best'
    (VBR) output size; None if yt-dlp didn't report one."""
    audio_only = [f for f in (info.get('formats') or []) if f.get('acodec') not in (None, 'none') and f.get('vcodec') in (None, 'none')]
    abrs = [f['abr'] for f in audio_only if f.get('abr')]
    return max(abrs) if abrs else None


# ---------------------------------------------------------- audio metadata

_NOISE_RE = re.compile(r'\s*[(\[【][^)\]】]*\b(?:official|lyrics?|audio|video|visuali[sz]er|mv|m/v|hd|hq|4k)\b[^)\]】]*[)\]】]', re.IGNORECASE)
_SPLIT_RE = re.compile(r'^(.+?)\s+[-–—]\s+(.+)$')


def _strip_topic(name):
    return re.sub(r'\s*-\s*Topic$', '', name or '').strip()


def _iso_date(info):
    raw = str(info.get('release_date') or info.get('upload_date') or '')
    if re.fullmatch(r'\d{8}', raw):
        return '%s-%s-%s' % (raw[:4], raw[4:6], raw[6:])
    return str(info.get('release_year') or '')


def auto_meta(info):
    """Tags guessed from what yt-dlp knows. Music uploads carry real
    track/artist/album fields; ordinary videos fall back to splitting an
    "Artist - Title" video title and using the channel name."""
    track = info.get('track')
    artist = _strip_topic(info.get('artist') or '')
    title = _NOISE_RE.sub('', track or info.get('title') or '').strip()
    if not track:
        m = _SPLIT_RE.match(title)
        if m and (not artist or m.group(1).strip().lower() == artist.lower()):
            artist, title = m.group(1).strip(), m.group(2).strip()
    artist = artist or _strip_topic(info.get('creator') or info.get('uploader') or info.get('channel') or '')
    return {
        'title': title,
        'artist': artist,
        'album': info.get('album') or '',
        'albumArtist': info.get('album_artist') or '',
        'date': _iso_date(info),
        'genre': info.get('genre') or (info.get('genres') or [''])[0] or '',
        'track': str(info.get('track_number') or ''),
        'comment': info.get('webpage_url') or '',
    }


def cover_urls(info):
    """Candidate cover images, best first: the 1280px YouTube still when it
    exists (older videos 404 on it, hence the fallbacks), then yt-dlp's pick."""
    thumbs = [t['url'] for t in (info.get('thumbnails') or []) if t.get('url')]
    big = [u for u in thumbs if 'maxresdefault' in u and u.split('?')[0].endswith('.jpg')]
    return list(dict.fromkeys(big + [info.get('thumbnail')] + thumbs[::-1]))[:6] if (thumbs or info.get('thumbnail')) else []


def _fetch_cover(info):
    last = None
    for url in filter(None, cover_urls(info)):
        try:
            with twitter._http_get(url) as resp:
                return resp.read()
        except Exception as e:
            last = e
    raise last or ValueError('no thumbnail available')


def default_audio_name(meta):
    return '%s - %s' % (meta['artist'], meta['title']) if meta['artist'] and meta['title'] else meta['title'] or 'audio'


def _tag_audio(path, audio, info):
    """Writes the tags + cover; returns a warning string instead of raising."""
    meta = auto_meta(info)
    if audio['meta'] is not None:
        meta.update(audio['meta'])  # edit mode: the user's values win, blanks included
    cover = None
    warning = None
    c = audio['cover']
    try:
        if c['source'] == 'thumbnail':
            cover = audio_tags.prepare_cover(_fetch_cover(info), c['square'])
        elif c['source'] == 'custom':
            import base64
            cover = audio_tags.prepare_cover(base64.b64decode(c['dataUrl'].split(',', 1)[1]), c['square'])
    except Exception as e:
        warning = 'Cover art skipped: %s' % e
    try:
        audio_tags.write_tags(path, audio['format'], meta, cover)
    except Exception as e:
        warning = 'Tags could not be written: %s' % e
    return warning


def dedupe_path(path):
    """If `path` already exists, appends " (2)", " (3)", ... (like a
    browser's own download manager) until a free name is found."""
    if not os.path.exists(path):
        return path
    root, ext = os.path.splitext(path)
    n = 2
    while True:
        candidate = '%s (%d)%s' % (root, n, ext)
        if not os.path.exists(candidate):
            return candidate
        n += 1


def fetch_formats(url, ffmpeg_location=None):
    """Returns the /formats-style info dict for `url`.

    Raises ValueError (user-facing message) for a missing/non-http(s) URL or
    a playlist link; other exceptions propagate from yt-dlp as-is, including
    "Unsupported URL" for a page none of yt-dlp's extractors recognize, or
    the video/page being unavailable.
    """
    if not url or not HTTP_URL_RE.match(url):
        raise ValueError('URL is missing or invalid')

    ydl_opts = {'quiet': True, 'no_warnings': True, 'skip_download': True, 'noplaylist': True}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if info.get('_type') == 'playlist' or 'formats' not in info:
        raise ValueError('Playlists are not supported yet. Open an individual video.')

    return {
        'title': info.get('title'),
        'channel': info.get('channel') or info.get('uploader') or '',
        'thumbnail': info.get('thumbnail'),
        'duration': info.get('duration'),
        'video_qualities': video_qualities_from_info(info),
        'video_codecs': video_codecs_from_info(info),
        'audio_formats': [dict(id=fid, **{k: f[k] for k in ('label', 'sub', 'ext', 'qualities')})
                          for fid, f in AUDIO_FORMATS.items() if render.has_encoder(f['encoder'], ffmpeg_location)],
        'meta': auto_meta(info),
        'best_audio_kbps': best_audio_kbps(info),
        'ytdlp': errors.ytdlp_version_info(),
    }


def _clip(value):
    return str(value if value is not None else '').strip()[:MAX_META_LEN]


def _normalize_audio(audio):
    audio = audio if isinstance(audio, dict) else {}
    fmt = audio.get('format')
    if fmt not in AUDIO_FORMATS:
        raise ValueError('audio format must be one of ' + ', '.join(AUDIO_FORMATS))
    qualities = AUDIO_FORMATS[fmt]['qualities']
    quality = str(audio.get('quality') or 'best') if qualities else None
    if qualities and quality not in qualities:
        raise ValueError('invalid %s quality' % fmt)
    meta = audio.get('meta')
    cover = audio.get('cover') if isinstance(audio.get('cover'), dict) else {}
    source = cover.get('source') if cover.get('source') in ('thumbnail', 'custom', 'none') else 'thumbnail'
    data_url = cover.get('dataUrl') or ''
    if source == 'custom' and not (data_url.startswith('data:image/') and ',' in data_url and len(data_url) <= MAX_COVER_DATA_URL):
        raise ValueError('custom cover must be an image under 10 MB')
    return {
        'format': fmt,
        'quality': quality,
        'tags': audio.get('tags', True) is not False,
        'meta': {k: _clip(meta.get(k)) for k in audio_tags.META_KEYS} if isinstance(meta, dict) else None,
        'cover': {'source': source, 'square': cover.get('square', True) is not False, 'dataUrl': data_url if source == 'custom' else ''},
    }


def validate_download_request(url, mode, quality, audio=None):
    """Raises ValueError (user-facing message) if the request is invalid;
    otherwise returns the normalized (mode, quality, audio). The legacy modes
    'mp3' / 'wav' are accepted and become mode 'audio' with that format."""
    if not url or not HTTP_URL_RE.match(url):
        raise ValueError('URL is missing or invalid')
    if mode in ('mp3', 'wav'):
        mode, audio = 'audio', {'format': mode, 'quality': quality}
    if mode not in ('mp4', 'audio'):
        raise ValueError('mode must be mp4 or audio')
    if mode == 'audio':
        audio = _normalize_audio(audio)
        return mode, audio['quality'], audio
    if not quality:
        raise ValueError('quality (target height) is required for mp4')
    return mode, quality, None


def make_progress_hook(on_progress):
    """yt-dlp progress hook that reports downloading/converting updates."""
    def hook(d):
        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate')
            downloaded = d.get('downloaded_bytes') or 0
            update = {'status': 'downloading'}
            if total:
                update['percent'] = round(downloaded * 100 / total, 1)
            on_progress(**update)
        elif d['status'] == 'finished':
            on_progress(status='converting', percent=100)
    return hook


def run_download(url, mode, quality, on_progress, ffmpeg_location=None, download_dir=None, title=None, audio=None, codec=None, container=None):
    """Downloads/converts `url` per `mode` ('mp4' or 'audio') / `quality`.
    `codec` (a key of VIDEO_CODECS, default H.264/MP4) is the preferred video
    codec; VP9/AV1 save as .webm unless `container` (mp4, mkv or webm) says
    otherwise, and fall back to H.264 when unavailable. WebM only carries
    VP9/AV1 + Opus, so H.264 into WebM falls back to MP4.

    Calls on_progress(**kwargs) with partial updates as the download
    proceeds (e.g. status='downloading', percent=...; status='converting';
    status='tagging'), then a final call: status='finished', percent=100,
    filename=..., path=... (+ warning=... if tags/cover couldn't be written)
    or status='error', error=....

    `audio` is {format, quality, tags, meta, cover} (see _normalize_audio).
    `ffmpeg_location` lets a frozen/bundled host point at its own bundled
    ffmpeg instead of relying on PATH. `download_dir` overrides the
    configured/default save location for this one call. `title`, if given,
    is used as the saved filename (sanitized) instead of the video's own
    title.

    The target filename is always resolved and deduped (appending " (2)",
    " (3)", ... if something's already there, like a browser's own download
    manager) before the real download starts, so re-downloading the same
    video (or two videos landing on the same name) never silently overwrites
    an existing file or leaves ffmpeg stuck waiting on an overwrite prompt
    with no console attached to show it.
    """
    try:
        mode, quality, audio = validate_download_request(url, mode, quality, audio)
    except ValueError as e:
        on_progress(status='error', **errors.classify_error(e, 'youtube'))
        return

    target_dir = ensure_download_dir(download_dir)
    codec = codec if codec in VIDEO_CODECS else DEFAULT_VIDEO_CODEC
    warning = None

    container = container if container in VIDEO_CONTAINERS else None
    webm_wanted = mode == 'mp4' and container == 'webm'
    if webm_wanted and codec == DEFAULT_VIDEO_CODEC:
        codec = 'vp9'  # WebM can't hold H.264; try VP9, falling back to MP4/H.264 below

    # A non-default codec has to be checked against the real streams first, since
    # it decides the container (and so the file name).
    if not title or (mode == 'mp4' and codec != DEFAULT_VIDEO_CODEC):
        try:
            probe_opts = {'quiet': True, 'no_warnings': True, 'skip_download': True, 'noplaylist': True}
            with yt_dlp.YoutubeDL(probe_opts) as probe:
                probed = probe.extract_info(url, download=False)
            title = title or (default_audio_name(auto_meta(probed)) if audio else probed.get('title') or 'video')
        except Exception as e:
            on_progress(status='error', **errors.classify_error(e, 'youtube'))
            return
        if mode == 'mp4' and codec != DEFAULT_VIDEO_CODEC and not _codec_available(probed, codec, quality):
            warning = '%s is not available at this quality; saved as %s instead.' % (VIDEO_CODECS[codec][0], VIDEO_CODECS[DEFAULT_VIDEO_CODEC][0] + (' MP4' if webm_wanted else ''))
            codec = DEFAULT_VIDEO_CODEC
            if webm_wanted:
                container = 'mp4'

    ext = AUDIO_FORMATS[audio['format']]['ext'] if audio else (container or VIDEO_CODECS[codec][2])

    final_path = dedupe_path(os.path.join(target_dir, sanitize_filename(title, restricted=False) + '.' + ext))
    outtmpl = os.path.splitext(final_path)[0] + '.%(ext)s'

    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        # We report progress ourselves via progress_hooks; yt-dlp's own
        # progress bar writes raw text straight to stdout regardless of
        # `quiet`, which corrupts the native host's framed stdout protocol
        # (host.py can only ever write well-formed frames there).
        'noprogress': True,
        'outtmpl': outtmpl,
        'progress_hooks': [make_progress_hook(on_progress)],
        'restrictfilenames': False,
        'noplaylist': True,
    }
    if ffmpeg_location:
        ydl_opts['ffmpeg_location'] = ffmpeg_location

    if mode == 'mp4':
        ydl_opts['format'] = video_format_selector(codec, quality)
        ydl_opts['merge_output_format'] = ext
    else:
        pp = {'key': 'FFmpegExtractAudio', 'preferredcodec': AUDIO_FORMATS[audio['format']]['codec']}
        if audio['format'] == 'mp3':
            pp['preferredquality'] = quality if quality != 'best' else '0'
        elif quality and quality != 'best':
            pp['preferredquality'] = quality
        ydl_opts['format'] = 'bestaudio/best'
        ydl_opts['postprocessors'] = [pp]

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
        done = {'filename': os.path.basename(final_path), 'path': final_path}
        if audio and audio['tags']:
            on_progress(status='tagging', percent=100)
            warning = _tag_audio(final_path, audio, info)
        if warning:
            done['warning'] = warning
        on_progress(status='finished', percent=100, **done)
    except Exception as e:
        on_progress(status='error', **errors.classify_error(e, 'youtube'))


# ------------------------------------------------------------------ Twitter

def make_job_tmp():
    os.makedirs(TMP_DIR, exist_ok=True)
    return tempfile.mkdtemp(prefix='job-', dir=TMP_DIR)


def sweep_tmp(max_age_seconds=6 * 3600):
    """Removes job temp dirs left behind by a crashed/killed host."""
    try:
        names = os.listdir(TMP_DIR)
    except OSError:
        return
    now = time.time()
    for name in names:
        path = os.path.join(TMP_DIR, name)
        try:
            if now - os.path.getmtime(path) > max_age_seconds:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


def _num(value, default, lo, hi):
    try:
        return max(lo, min(hi, float(value)))
    except (TypeError, ValueError):
        return default


def validate_twitter_request(url, options):
    """Returns normalized options; raises ValueError (user-facing message)."""
    twitter.parse_tweet_id(url)
    options = options or {}
    kind = options.get('kind')
    if kind not in ('media', 'card'):
        raise ValueError('kind must be media or card')
    fmt = options.get('format') or 'mp4'
    if kind == 'media' and fmt not in ('mp4', 'gif', 'photo'):
        raise ValueError('format must be mp4, gif or photo')
    gif = options.get('gif') or {}
    start = _num(gif.get('start'), 0.0, 0.0, 1e6)
    end = _num(gif.get('end'), 0.0, 0.0, 1e6) or None
    if end is not None and end <= start:
        raise ValueError('GIF end time must be after the start time')
    width = int(_num(gif.get('width'), 0, 0, 4096)) or None
    card = options.get('card') or {}
    return {
        'kind': kind,
        'format': fmt,
        'mediaIndex': int(_num(options.get('mediaIndex'), 0, 0, 15)),
        'quality': int(_num(options.get('quality'), 0, 0, 4320)) or None,
        'photoSize': options.get('photoSize') if options.get('photoSize') in twitter.PHOTO_SIZES else 'orig',
        'gif': {'fps': int(_num(gif.get('fps'), 15, 5, 30)), 'speed': _num(gif.get('speed'), 1.0, 0.25, 4.0),
                'width': width, 'start': start, 'end': end},
        'card': {'theme': 'dark' if card.get('theme') == 'dark' else 'light',
                 'showText': card.get('showText', True) is not False,
                 'showDate': card.get('showDate', True) is not False,
                 'showVerified': card.get('showVerified', True) is not False,
                 'showQuote': card.get('showQuote', True) is not False,
                 'photoLayout': card.get('photoLayout') if card.get('photoLayout') in render.PHOTO_LAYOUTS else 'grid',
                 'scale': int(_num(card.get('scale'), 2, 1, 3))},
    }


def get_tweet_info(url, cookies=None):
    """Tweet metadata for the popup (variant URLs are stripped; the host
    re-resolves them at download time)."""
    with twitter.cookie_file(cookies) as cookiefile:
        tweet = twitter.fetch_tweet(url, cookiefile)
    tweet['media'] = [{k: v for k, v in m.items() if k != 'variants'} for m in tweet['media']]
    tweet['ytdlp'] = errors.ytdlp_version_info()
    return tweet


def _download_video(tweet, item, quality, tmp, cookiefile, on_progress):
    """Downloads one tweet video/GIF into `tmp`, returns (path, height or None).
    From syndication variants the next size up from `quality` is fetched and
    the caller downscales; the yt-dlp fallback honours `quality` itself."""
    variant = twitter.pick_variant(item.get('variants'), quality)
    if variant:
        dest = os.path.join(tmp, 'video.mp4')
        twitter.download_file(variant['url'], dest, on_progress)
        return dest, variant['height'] or None
    # No syndication variants (yt-dlp fallback path): let yt-dlp pick.
    height = quality or 4320
    multi = sum(1 for m in tweet['media'] if m['videoIndex']) > 1
    opts = {
        'quiet': True, 'no_warnings': True, 'noprogress': True,
        'outtmpl': os.path.join(tmp, 'video.%(ext)s'),
        'format': 'bestvideo[height<={h}]+bestaudio/best[height<={h}]/best'.format(h=height),
        'merge_output_format': 'mp4',
        'progress_hooks': [make_progress_hook(on_progress)],
        'noplaylist': not multi,
    }
    if multi:
        opts['playlist_items'] = str(item['videoIndex'])
    if cookiefile:
        opts['cookiefile'] = cookiefile
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([tweet['url']])
    for name in os.listdir(tmp):
        if name.startswith('video.'):
            return os.path.join(tmp, name), None
    raise ValueError('No video could be found in this tweet')


def _fetch_avatar(author, tmp, name):
    url = author.get('avatarUrl')
    if not url:
        return None
    path = os.path.join(tmp, name)
    try:
        twitter.download_file(url, path)
        return path
    except Exception:
        return None  # card falls back to an initial-letter placeholder


def _card_images(items, tmp, tag):
    """Local image files for up to four media items (photos at original
    quality, videos/GIFs as their poster frame) for static card media."""
    paths = []
    for n, m in enumerate(items[:4]):
        path = os.path.join(tmp, '%s-%d' % (tag, n))
        if m['type'] == 'photo':
            twitter.download_photo(m['photoUrl'], path)
        else:
            twitter.download_file(m['thumbnail'], path)
        paths.append(path)
    return paths


def _run_twitter_job(url, options, on_progress, ffmpeg_location, tmp, cookiefile):
    """Does the work; returns (tmp output path, extension, default title)."""
    tweet = twitter.fetch_tweet(url, cookiefile)
    media = tweet['media']
    handle = tweet['author']['handle'] or 'tweet'
    base = '%s_%s' % (handle, tweet['tweetId'])
    kind = options['kind']
    index = options['mediaIndex']
    if index >= len(media):
        index = 0
    item = media[index] if media else None

    if kind == 'media':
        twitter.require_media(tweet)
        source = tweet['quoted'] if item['from'] == 'quoted' and tweet.get('quoted') else tweet
        base = '%s_%s' % (source['author']['handle'] or 'tweet', source['tweetId'])
        group = [m for m in media if m['from'] == item['from']]
        if len(group) > 1:
            base += '_%d' % (group.index(item) + 1)
        if item['type'] == 'photo':
            out = os.path.join(tmp, 'photo')
            twitter.download_photo(item['photoUrl'], out, options['photoSize'])
            ext = os.path.splitext(item['photoUrl'].split('?')[0])[1].lstrip('.') or 'jpg'
            return out, ext, base
        video, height = _download_video(tweet, item, options['quality'], tmp, cookiefile, on_progress)
        if options['format'] == 'gif':
            g = options['gif']
            out = os.path.join(tmp, 'out.gif')
            render.to_gif(video, out, g['fps'], g['speed'], g['width'], g['start'], g['end'], on_progress, ffmpeg_location)
            return out, 'gif', base
        if options['quality'] and height and options['quality'] < height:
            out = os.path.join(tmp, 'scaled.mp4')
            render.scale_video(video, out, options['quality'], item.get('duration'), on_progress, ffmpeg_location)
            return out, 'mp4', base
        return video, 'mp4', base

    # Tweet card. A quote post also draws the quoted tweet inside the card;
    # the selected media decides which box plays the video (or, for a photo or
    # a text-only tweet, the card is a static PNG with all media as images).
    opts = options['card']
    quoted = tweet.get('quoted') if opts['showQuote'] else None
    avatar = _fetch_avatar(tweet['author'], tmp, 'avatar')
    quote_avatar = _fetch_avatar(quoted['author'], tmp, 'quote-avatar') if quoted else None
    base += '_card'
    own_items = [m for m in media if m['from'] == 'own']
    quote_items = [m for m in media if m['from'] == 'quoted'] if quoted else []
    if item and item['type'] != 'photo':
        video, _height = _download_video(tweet, item, None, tmp, cookiefile, on_progress)
        opts = dict(opts, scale=min(opts['scale'], 2))  # video cards are capped at 2x (encoder size limits)
        target = 'quote' if item['from'] == 'quoted' and quoted else 'own'
        aspect = item['width'] / item['height'] if item.get('width') and item.get('height') else None
        out = os.path.join(tmp, 'card.mp4')
        render.render_card_video(
            tweet, video, target, opts, out, tmp, avatar, quote_avatar,
            _card_images(own_items if target == 'quote' else [], tmp, 'own'),
            _card_images(quote_items if target == 'own' else [], tmp, 'quote'),
            aspect, item.get('duration'), on_progress, ffmpeg_location)
        return out, 'mp4', base
    own_paths = _card_images(own_items, tmp, 'own')
    quote_paths = _card_images(quote_items, tmp, 'quote')
    on_progress(status='rendering', percent=50)
    out = os.path.join(tmp, 'card.png')
    render.render_card_png(tweet, own_paths, quote_paths, opts, out, avatar, quote_avatar)
    return out, 'png', base


def run_twitter_download(url, options, on_progress, ffmpeg_location=None, download_dir=None, title=None, cookies=None):
    """Twitter counterpart of run_download: same on_progress protocol
    (starting/downloading/converting|rendering/finished/error)."""
    tmp = None
    try:
        options = validate_twitter_request(url, options)
        target_dir = ensure_download_dir(download_dir, 'twitter')
        tmp = make_job_tmp()
        with twitter.cookie_file(cookies) as cookiefile:
            out, ext, default_title = _run_twitter_job(url, options, on_progress, ffmpeg_location, tmp, cookiefile)
        final_path = dedupe_path(os.path.join(target_dir, sanitize_filename(title or default_title, restricted=False) + '.' + ext))
        shutil.move(out, final_path)
        on_progress(status='finished', percent=100, filename=os.path.basename(final_path), path=final_path)
    except Exception as e:
        on_progress(status='error', **errors.classify_error(e, 'twitter'))
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
