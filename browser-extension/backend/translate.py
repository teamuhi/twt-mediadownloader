# coding: utf-8
"""Machine translation for tweet text (Google Translate's public web endpoint,
no API key). The source language is auto-detected."""

from __future__ import unicode_literals

import json
import urllib.parse
import urllib.request

TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single'
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'
TIMEOUT = 15
MAX_CHARS = 5000


def translate_text(text, target):
    """-> {'text': translated, 'from': detected language code}."""
    if not text.strip():
        return {'text': text, 'from': target}
    query = urllib.parse.urlencode({'client': 'gtx', 'sl': 'auto', 'tl': target, 'dt': 't'})
    body = urllib.parse.urlencode({'q': text[:MAX_CHARS]}).encode()
    req = urllib.request.Request(TRANSLATE_URL + '?' + query, data=body, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        data = json.loads(res.read().decode('utf-8'))
    return {'text': ''.join(seg[0] for seg in data[0] if seg and seg[0]), 'from': data[2] or target}


def translate_all(texts, target):
    """Translates a list of strings (None/empty pass through as None)."""
    if not isinstance(target, str) or not target.replace('-', '').isalnum() or len(target) > 12:
        raise ValueError('Invalid target language')
    return [translate_text(t, target) if t else None for t in texts]
