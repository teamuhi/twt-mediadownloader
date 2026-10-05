# coding: utf-8
"""Tweet metadata + media fetching.

Metadata comes from X's public syndication endpoint (no login needed), with
yt-dlp as a fallback for tweets it won't serve (tombstones, sensitive media).
Videos/GIFs are downloaded straight from the mp4 variants the syndication
payload lists; yt-dlp is only used when that payload is unavailable.
"""

from __future__ import unicode_literals

import contextlib
import html
import json
import os
import re
import tempfile
import urllib.error
import urllib.request
from datetime import datetime

import yt_dlp

import errors
from errors import TweetError

TWEET_URL_RE = re.compile(r'^https?://(?:[\w-]+\.)?(?:x|twitter)\.com/(?:[^/?#]+|i/web)/status(?:es)?/(\d+)', re.IGNORECASE)
SYNDICATION_URL = 'https://cdn.syndication.twimg.com/tweet-result'
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'
TIMEOUT = 20
_BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'


def parse_tweet_id(url):
    m = TWEET_URL_RE.match(url or '')
    if not m:
        raise ValueError('Not a tweet link')
    return m.group(1)


def _base36(n):
    """JS Number.prototype.toString(36) for a positive float (close enough
    for the syndication token, which isn't validated strictly)."""
    ip = int(n)
    fp = n - ip
    out = ''
    while ip:
        ip, r = divmod(ip, 36)
        out = _BASE36[r] + out
    out = out or '0'
    if fp:
        out += '.'
        for _ in range(11):
            fp *= 36
            d = int(fp)
            out += _BASE36[d]
            fp -= d
    return out


def _syndication_token(tweet_id):
    import math
    return re.sub(r'(0+|\.)', '', _base36(int(tweet_id) / 1e15 * math.pi))


def _http_get(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    return urllib.request.urlopen(req, timeout=timeout)


def fetch_syndication(tweet_id):
    """Raw syndication JSON, or None when X has nothing for this tweet."""
    url = '%s?id=%s&lang=en&token=%s' % (SYNDICATION_URL, tweet_id, _syndication_token(tweet_id))
    try:
        with _http_get(url) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):
            return None
        raise
    if not body.strip():
        return None
    data = json.loads(body.decode('utf-8'))
    if not isinstance(data, dict) or data.get('__typename') == 'TweetTombstone':
        return None
    return data


def _clean_text(data):
    text = data.get('text') or ''
    rng = data.get('display_text_range')
    if isinstance(rng, list) and len(rng) == 2:
        # Offsets are in code points, which is what Python slices by.
        text = text[rng[0]:rng[1]]
    text = html.unescape(text)
    return re.sub(r'\s*https://t\.co/\w+\s*$', '', text).strip()


def _variants(details):
    """mp4 variants as [{url, height, bitrate}], best first."""
    out = []
    for v in (details.get('video_info') or {}).get('variants') or []:
        if v.get('content_type') != 'video/mp4' or not v.get('url'):
            continue
        m = re.search(r'/(\d+)x(\d+)/', v['url'])
        out.append({'url': v['url'], 'height': int(m.group(2)) if m else 0, 'bitrate': v.get('bitrate') or 0})
    return sorted(out, key=lambda v: (v['height'], v['bitrate']), reverse=True)


def _media_from_syndication(items):
    media = []
    video_n = 0
    for d in items:
        kind = d.get('type')
        info = d.get('original_info') or {}
        item = {
            'index': len(media),
            'type': kind,
            'width': info.get('width'),
            'height': info.get('height'),
            'thumbnail': d.get('media_url_https'),
            'duration': None,
            'previewUrl': None,
            'photoUrl': None,
            'videoIndex': None,
            'variants': [],
            'qualities': [],
        }
        if kind == 'photo':
            item['photoUrl'] = d.get('media_url_https')
        elif kind in ('video', 'animated_gif'):
            video_n += 1
            item['videoIndex'] = video_n
            millis = (d.get('video_info') or {}).get('duration_millis')
            item['duration'] = millis / 1000 if millis else None
            item['variants'] = _variants(d)
            seen = set()
            for v in item['variants']:
                if v['height'] and v['height'] not in seen:
                    seen.add(v['height'])
                    size = v['bitrate'] * item['duration'] / 8 if v['bitrate'] and item['duration'] else None
                    item['qualities'].append({'height': v['height'], 'estimated_bytes': size})
            if item['variants']:
                item['previewUrl'] = min(item['variants'], key=lambda v: (v['height'] or 9999, v['bitrate']))['url']
        else:
            continue
        media.append(item)
    return media


def _from_syndication(data, url, tweet_id):
    user = data.get('user') or {}
    avatar = user.get('profile_image_url_https') or ''
    return {
        'tweetId': tweet_id,
        'url': url,
        'author': {
            'name': user.get('name') or user.get('screen_name') or '',
            'handle': user.get('screen_name') or '',
            'avatarUrl': avatar.replace('_normal.', '_400x400.'),
            'verified': bool(user.get('is_blue_verified') or user.get('verified')),
        },
        'text': _clean_text(data),
        'createdAt': data.get('created_at'),
        'sensitive': bool(data.get('possibly_sensitive')),
        'media': _media_from_syndication(data.get('mediaDetails') or []),
    }


def _ytdlp_opts(cookiefile, **extra):
    opts = {'quiet': True, 'no_warnings': True, 'skip_download': True, 'noprogress': True}
    if cookiefile:
        opts['cookiefile'] = cookiefile
    opts.update(extra)
    return opts


def _from_ytdlp(url, tweet_id, cookiefile):
    import core  # lazy: core imports this module

    with yt_dlp.YoutubeDL(_ytdlp_opts(cookiefile, noplaylist=False)) as ydl:
        info = ydl.extract_info(url, download=False)
    entries = [e for e in (info.get('entries') or []) if e] or [info]
    media = []
    for n, e in enumerate(entries, 1):
        if not e.get('formats'):
            continue
        media.append({
            'index': len(media),
            'type': 'video',
            'width': e.get('width'),
            'height': e.get('height'),
            'thumbnail': e.get('thumbnail'),
            'duration': e.get('duration'),
            'previewUrl': None,
            'photoUrl': None,
            'videoIndex': n,
            'variants': [],
            'qualities': core.video_qualities_from_info(e),
        })
    handle = info.get('uploader_id') or ''
    return {
        'tweetId': tweet_id,
        'url': url,
        'author': {'name': info.get('uploader') or handle, 'handle': handle, 'avatarUrl': '', 'verified': False},
        'text': re.sub(r'\s*https://t\.co/\w+\s*$', '', info.get('description') or info.get('title') or '').strip(),
        'createdAt': datetime.utcfromtimestamp(info['timestamp']).isoformat() + 'Z' if info.get('timestamp') else None,
        'sensitive': False,
        'media': media,
    }


def fetch_tweet(url, cookiefile=None):
    """Normalized tweet dict (see twitter-card docs in the plan): author,
    text, createdAt, media[]. Raises TweetError/ValueError/yt-dlp errors."""
    tweet_id = parse_tweet_id(url)
    data = None
    try:
        data = fetch_syndication(tweet_id)
    except Exception:
        data = None  # network/JSON hiccup: let yt-dlp have a go

    if data is not None:
        tweet = _from_syndication(data, url, tweet_id)
        if tweet['media'] or not tweet['sensitive'] or cookiefile:
            return tweet
    try:
        return _from_ytdlp(url, tweet_id, cookiefile)
    except Exception as e:
        # yt-dlp can't tell "deleted" from "needs login"; the syndication
        # result (served vs not) disambiguates.
        if 'no video could be found' in str(e).lower():
            raise TweetError('E_AUTH_REQUIRED' if data is not None else 'E_NOT_FOUND', str(e))
        raise


def require_media(tweet):
    if not tweet['media']:
        raise TweetError('E_NO_MEDIA', 'No video could be found in this tweet')


@contextlib.contextmanager
def cookie_file(cookies):
    """Writes the browser's x.com cookies to a temp Netscape cookies.txt for
    yt-dlp and always deletes it afterwards. Yields the path, or None."""
    if not cookies:
        yield None
        return
    fd, path = tempfile.mkstemp(prefix='twtdl-cookies-', suffix='.txt')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as f:
            f.write('# Netscape HTTP Cookie File\n')
            for c in cookies:
                domain = c.get('domain') or ''
                name = c.get('name')
                if not domain or not name:
                    continue
                f.write('\t'.join([
                    domain,
                    'TRUE' if domain.startswith('.') else 'FALSE',
                    c.get('path') or '/',
                    'TRUE' if c.get('secure') else 'FALSE',
                    str(int(c.get('expirationDate') or 0)),
                    name,
                    str(c.get('value') or '').replace('\n', '').replace('\r', ''),
                ]) + '\n')
        yield path
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def download_file(url, dest, on_progress=None):
    """Streams `url` to `dest`, reporting status='downloading' percent."""
    with _http_get(url, timeout=60) as resp, open(dest, 'wb') as out:
        total = int(resp.headers.get('Content-Length') or 0)
        done = 0
        while True:
            chunk = resp.read(1 << 16)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if on_progress and total:
                on_progress(status='downloading', percent=round(done * 100 / total, 1))


def download_photo(url, dest):
    base = url.split('?')[0]
    download_file(base + '?name=orig', dest)


def pick_variant(variants, quality):
    """Best variant at or under `quality` (height); else the best overall."""
    if not variants:
        return None
    try:
        limit = int(quality)
    except (TypeError, ValueError):
        return variants[0]
    under = [v for v in variants if v['height'] and v['height'] <= limit]
    return under[0] if under else variants[0]
