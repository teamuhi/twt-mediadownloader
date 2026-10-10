# coding: utf-8
"""Machine translation for tweet text (Google Translate's public web endpoint,
no API key). The source language is auto-detected."""

from __future__ import unicode_literals

import json
import re
import urllib.parse
import urllib.request

TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single'
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'
TIMEOUT = 15
MAX_CHARS = 5000
HANDLE_RE = re.compile(r'(?<![\w@])@\w+')  # @handles are names: never translated
PLACEHOLDER_RE = re.compile(r'\[\[(\d+)\]\]')


def _request(text, target):
    query = urllib.parse.urlencode({'client': 'gtx', 'sl': 'auto', 'tl': target, 'dt': 't'})
    body = urllib.parse.urlencode({'q': text[:MAX_CHARS]}).encode()
    req = urllib.request.Request(TRANSLATE_URL + '?' + query, data=body, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        data = json.loads(res.read().decode('utf-8'))
    return ''.join(seg[0] for seg in data[0] if seg and seg[0]), data[2] or target


def translate_text(text, target):
    """-> {'text': translated, 'from': detected language code}. @handles are kept verbatim."""
    if not text.strip():
        return {'text': text, 'from': target}
    handles = []

    def mask(m):
        handles.append(m.group(0))
        return '[[%d]]' % (len(handles) - 1)

    masked = HANDLE_RE.sub(mask, text)
    translated, source = _request(masked, target)
    found = [int(i) for i in PLACEHOLDER_RE.findall(translated)]
    if sorted(found) != list(range(len(handles))):
        # A placeholder got mangled: translate the text between the handles separately instead.
        parts = HANDLE_RE.split(text)
        translated = ''
        for i, part in enumerate(parts):
            if part.strip():
                chunk, src = _request(part, target)
                source = source if i else src
                lead = part[:len(part) - len(part.lstrip())]
                trail = part[len(part.rstrip()):]
                translated += lead + chunk.strip() + trail
            else:
                translated += part
            if i < len(handles):
                translated += handles[i]
        return {'text': translated, 'from': source}
    return {'text': PLACEHOLDER_RE.sub(lambda m: handles[int(m.group(1))], translated), 'from': source}


def translate_all(texts, target):
    """Translates a list of strings (None/empty pass through as None)."""
    if not isinstance(target, str) or not target.replace('-', '').isalnum() or len(target) > 12:
        raise ValueError('Invalid target language')
    return [translate_text(t, target) if t else None for t in texts]
