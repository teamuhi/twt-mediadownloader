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

import errors
import render
import twitter

DEFAULT_DOWNLOAD_DIR = os.path.join(os.path.expanduser('~'), 'Downloads', 'twtdl-extension')

APP_DATA_DIR = os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'), 'twtdl-extension')
CONFIG_PATH = os.path.join(APP_DATA_DIR, 'config.json')
TMP_DIR = os.path.join(APP_DATA_DIR, 'tmp')

HTTP_URL_RE = re.compile(r'^https?://', re.IGNORECASE)

MP3_QUALITIES = {'best', '320', '256', '192', '128'}

MODE_EXTENSIONS = {'mp4': 'mp4', 'mp3': 'mp3', 'wav': 'wav'}


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


CONFIG_DIR_KEYS = {'youtube': 'download_dir', 'twitter': 'twitter_download_dir'}


def get_download_dir(source='youtube'):
    """Save location for `source` ('youtube' or 'twitter'). An unset Twitter
    location follows the general one, so existing setups keep working."""
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


def best_audio_kbps(info):
    """Highest audio-only bitrate available, used to estimate MP3 'best'
    (VBR) output size; None if yt-dlp didn't report one."""
    audio_only = [f for f in (info.get('formats') or []) if f.get('acodec') not in (None, 'none') and f.get('vcodec') in (None, 'none')]
    abrs = [f['abr'] for f in audio_only if f.get('abr')]
    return max(abrs) if abrs else None


def expected_final_path(ydl, info, mode):
    base = ydl.prepare_filename(info)
    root, _ext = os.path.splitext(base)
    return root + '.' + MODE_EXTENSIONS[mode]


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


def fetch_formats(url):
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
        'thumbnail': info.get('thumbnail'),
        'duration': info.get('duration'),
        'video_qualities': video_qualities_from_info(info),
        'mp3_qualities': sorted(MP3_QUALITIES, key=lambda q: (q != 'best', -int(q) if q != 'best' else 0)),
        'best_audio_kbps': best_audio_kbps(info),
        'ytdlp': errors.ytdlp_version_info(),
    }


def validate_download_request(url, mode, quality):
    """Raises ValueError (user-facing message) if the request is invalid."""
    if not url or not HTTP_URL_RE.match(url):
        raise ValueError('URL is missing or invalid')
    if mode not in ('mp4', 'mp3', 'wav'):
        raise ValueError('mode must be one of mp4, mp3, wav')
    if mode == 'mp4' and not quality:
        raise ValueError('quality (target height) is required for mp4')
    if mode == 'mp3' and quality and str(quality) not in MP3_QUALITIES:
        raise ValueError('invalid mp3 quality')


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


def run_download(url, mode, quality, on_progress, ffmpeg_location=None, download_dir=None, title=None):
    """Downloads/converts `url` per `mode`/`quality`.

    Calls on_progress(**kwargs) with partial updates as the download
    proceeds (e.g. status='downloading', percent=...; status='converting'),
    then a final call: status='finished', percent=100, filename=..., path=...
    or status='error', error=....

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
    if mode not in MODE_EXTENSIONS:
        on_progress(status='error', **errors.classify_error('Unknown mode: %s' % mode))
        return

    target_dir = ensure_download_dir(download_dir)

    if not title:
        try:
            probe_opts = {'quiet': True, 'no_warnings': True, 'skip_download': True, 'noplaylist': True}
            with yt_dlp.YoutubeDL(probe_opts) as probe:
                title = probe.extract_info(url, download=False).get('title') or 'video'
        except Exception as e:
            on_progress(status='error', **errors.classify_error(e))
            return

    final_path = dedupe_path(os.path.join(target_dir, sanitize_filename(title, restricted=False) + '.' + MODE_EXTENSIONS[mode]))
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
        height = quality
        ydl_opts['format'] = (
            'bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]/'
            'bestvideo[height<={h}]+bestaudio/best[height<={h}]'
        ).format(h=height)
        ydl_opts['merge_output_format'] = 'mp4'
    elif mode == 'mp3':
        ydl_opts['format'] = 'bestaudio/best'
        pp = {'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3'}
        pp['preferredquality'] = quality if (quality and quality != 'best') else '0'
        ydl_opts['postprocessors'] = [pp]
    elif mode == 'wav':
        ydl_opts['format'] = 'bestaudio/best'
        ydl_opts['postprocessors'] = [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'wav'}]

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            final_path = expected_final_path(ydl, info, mode)
        on_progress(
            status='finished',
            percent=100,
            filename=os.path.basename(final_path),
            path=final_path,
        )
    except Exception as e:
        on_progress(status='error', **errors.classify_error(e))


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
        'quality': options.get('quality'),
        'gif': {'fps': int(_num(gif.get('fps'), 15, 5, 30)), 'speed': _num(gif.get('speed'), 1.0, 0.25, 4.0),
                'width': width, 'start': start, 'end': end},
        'card': {'theme': 'dark' if card.get('theme') == 'dark' else 'light',
                 'showText': card.get('showText', True) is not False,
                 'showDate': card.get('showDate', True) is not False,
                 'showVerified': card.get('showVerified', True) is not False,
                 'showQuote': card.get('showQuote', True) is not False},
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
    """Downloads one tweet video/GIF into `tmp`, returns its path."""
    variant = twitter.pick_variant(item.get('variants'), quality)
    if variant:
        dest = os.path.join(tmp, 'video.mp4')
        twitter.download_file(variant['url'], dest, on_progress)
        return dest
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
            return os.path.join(tmp, name)
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
            twitter.download_photo(item['photoUrl'], out)
            ext = os.path.splitext(item['photoUrl'].split('?')[0])[1].lstrip('.') or 'jpg'
            return out, ext, base
        video = _download_video(tweet, item, options['quality'], tmp, cookiefile, on_progress)
        if options['format'] == 'gif':
            g = options['gif']
            out = os.path.join(tmp, 'out.gif')
            render.to_gif(video, out, g['fps'], g['speed'], g['width'], g['start'], g['end'], on_progress, ffmpeg_location)
            return out, 'gif', base
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
        video = _download_video(tweet, item, options['quality'], tmp, cookiefile, on_progress)
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
        on_progress(status='error', **errors.classify_error(e))
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
