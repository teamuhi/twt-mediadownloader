# coding: utf-8
"""Maps raw exceptions/messages to a stable error code plus a readable
description and hint, shown by the popup and in notifications."""

from __future__ import unicode_literals

import datetime
import errno
import re
import urllib.error

ANSI_RE = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')


class FfmpegError(Exception):
    """Raised when an ffmpeg run fails; message is the tail of its stderr."""


class TweetError(Exception):
    """Raised for tweet-level problems with a known code (e.g. E_NO_MEDIA)."""

    def __init__(self, code, message=''):
        super().__init__(message or code)
        self.code = code


def ytdlp_version_info():
    """{'version', 'age_days'} for the bundled yt-dlp; age_days is None if the
    version string isn't a date (yt-dlp versions are YYYY.MM.DD[.N])."""
    try:
        from yt_dlp.version import __version__ as version
    except Exception:
        return {'version': None, 'age_days': None}
    try:
        y, m, d = (int(p) for p in version.split('.')[:3])
        age = (datetime.date.today() - datetime.date(y, m, d)).days
    except (ValueError, TypeError):
        age = None
    return {'version': version, 'age_days': age}


def _ytdlp_hint():
    info = ytdlp_version_info()
    if not info['version']:
        return 'Update twtdl to get the latest yt-dlp.'
    age = ' (%d days old)' % info['age_days'] if info['age_days'] is not None else ''
    return 'Bundled yt-dlp is %s%s. Update twtdl to get a newer one.' % (info['version'], age)


# (code, readable message, hint or callable returning one)
_RULES = [
    ('E_AUTH_REQUIRED', ('nsfw', 'requires authentication', 'log in', 'login', 'sign in', 'protected', 'age-restricted', 'age restricted'),
     'This tweet needs a logged-in account.',
     "Log into x.com in this browser and keep 'Use my x.com login' on in settings."),
    ('E_NO_MEDIA', ('no video could be found', 'no media', 'no downloadable media'),
     'This tweet has no downloadable media.',
     'Pick a tweet that contains a video, GIF or photo.'),
    ('E_NOT_FOUND', ('404', 'does not exist', 'unavailable', 'suspended', 'deleted', 'tombstone', 'not found'),
     'Tweet not found or deleted.',
     'Check the link. If it is sensitive or from a protected account, log into x.com in this browser.'),
    ('E_RATE_LIMITED', ('429', 'rate limit', 'too many requests'),
     'X is rate-limiting requests.',
     'Wait a few minutes and try again.'),
    ('E_GEO', ('geo', 'not available in your country', 'region'),
     'This media is region-locked.',
     'It is not available from your location.'),
    ('E_FORMAT', ('requested format is not available', 'unsupported codec', 'no video formats'),
     'The media is in a different format than expected.',
     'Try another quality, or use Media only.'),
    ('E_FFMPEG_MISSING', ('ffmpeg not found', 'ffmpeg is not installed', 'ffprobe and ffmpeg not found'),
     'ffmpeg is missing.',
     'Reinstall twtdl so the bundled ffmpeg is restored.'),
    ('E_UNSUPPORTED_URL', ('unsupported url', 'url is missing or invalid', 'not a tweet link'),
     "This page isn't a supported video or tweet.",
     'Open a tweet link like x.com/user/status/123.'),
    ('E_NETWORK', ('urlopen error', 'timed out', 'getaddrinfo', 'connection', 'network is unreachable'),
     'Network error.',
     'Check your internet connection and try again.'),
    ('E_EXTRACTOR_BROKEN', ('unable to extract', 'unable to download json', 'unable to download webpage', 'http error 400', 'http error 403', 'keyerror', 'nonetype'),
     "yt-dlp couldn't read this page. It is probably outdated.",
     _ytdlp_hint),
]


def classify_error(exc):
    """Returns {'errorCode','error','errorHint','errorDetail'} for an
    exception or message string."""
    raw = str(exc) if not isinstance(exc, str) else exc
    detail = ANSI_RE.sub('', raw).strip()
    if detail.upper().startswith('ERROR: '):
        detail = detail[7:]

    def result(code, message, hint):
        if callable(hint):
            hint = hint()
        return {'errorCode': code, 'error': message, 'errorHint': hint, 'errorDetail': detail}

    if isinstance(exc, TweetError):
        for code, _keys, message, hint in _RULES:
            if code == exc.code:
                return result(code, message, hint)
    if isinstance(exc, FfmpegError):
        return result('E_FFMPEG_FAILED', 'Conversion or rendering failed.', 'The media may be corrupt or in an unusual format.')
    if isinstance(exc, FileNotFoundError) and 'ffmpeg' in detail.lower():
        return result('E_FFMPEG_MISSING', 'ffmpeg is missing.', 'Reinstall twtdl so the bundled ffmpeg is restored.')
    if isinstance(exc, OSError) and not isinstance(exc, urllib.error.URLError) and getattr(exc, 'errno', None) in (errno.ENOSPC, errno.EACCES, errno.EPERM):
        return result('E_DISK', 'Could not write the file (disk full or no permission).', 'Free some space or choose another download folder.')
    if isinstance(exc, (urllib.error.URLError, TimeoutError, ConnectionError)) and not (isinstance(exc, urllib.error.HTTPError)):
        return result('E_NETWORK', 'Network error.', 'Check your internet connection and try again.')
    if isinstance(exc, (KeyError, TypeError, AttributeError)):
        return result('E_EXTRACTOR_BROKEN', "yt-dlp couldn't read this page. It is probably outdated.", _ytdlp_hint)

    low = detail.lower()
    for code, keys, message, hint in _RULES:
        if any(k in low for k in keys):
            return result(code, message, hint)
    return result('E_UNKNOWN', detail or 'Unknown error.', 'If this keeps happening, update twtdl.')
