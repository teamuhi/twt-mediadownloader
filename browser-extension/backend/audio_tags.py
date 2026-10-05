# coding: utf-8
"""Audio tagging: cover-art prep and per-container tag writing (mutagen)."""

from __future__ import unicode_literals

import base64
import io

from PIL import Image

META_KEYS = ('title', 'artist', 'album', 'albumArtist', 'date', 'genre', 'track', 'comment')


def prepare_cover(data, square=True, max_px=1200):
    """Image bytes -> JPEG bytes: optional center-crop to a square, capped at max_px."""
    im = Image.open(io.BytesIO(data)).convert('RGB')
    if square and im.width != im.height:
        side = min(im.size)
        left, top = (im.width - side) // 2, (im.height - side) // 2
        im = im.crop((left, top, left + side, top + side))
    if max(im.size) > max_px:
        im.thumbnail((max_px, max_px), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, 'JPEG', quality=90)
    return out.getvalue()


def _clean(meta):
    return {k: str(meta[k]).strip() for k in META_KEYS if meta.get(k) not in (None, '') and str(meta[k]).strip()}


def _track_number(track):
    try:
        return int(str(track).split('/')[0])
    except ValueError:
        return None


def _write_id3(audio, meta, cover):
    from mutagen import id3
    if audio.tags is None:
        audio.add_tags()
    tags = audio.tags
    frames = {'title': id3.TIT2, 'artist': id3.TPE1, 'album': id3.TALB, 'albumArtist': id3.TPE2,
              'date': id3.TDRC, 'genre': id3.TCON, 'track': id3.TRCK}
    for key, frame in frames.items():
        if key in meta:
            tags.add(frame(encoding=3, text=meta[key]))
    if 'comment' in meta:
        tags.add(id3.COMM(encoding=3, lang='eng', desc='', text=meta['comment']))
    if cover:
        tags.add(id3.APIC(encoding=3, mime='image/jpeg', type=3, desc='Cover', data=cover))
    return audio


def _picture(cover):
    from mutagen.flac import Picture
    pic = Picture()
    pic.type, pic.mime, pic.data = 3, 'image/jpeg', cover
    with Image.open(io.BytesIO(cover)) as im:
        pic.width, pic.height, pic.depth = im.width, im.height, 24
    return pic


def _vorbis(audio, meta, cover, embed):
    names = {'title': 'title', 'artist': 'artist', 'album': 'album', 'albumArtist': 'albumartist',
             'date': 'date', 'genre': 'genre', 'track': 'tracknumber', 'comment': 'comment'}
    for key, name in names.items():
        if key in meta:
            audio[name] = [meta[key]]
    if cover:
        embed(audio, _picture(cover))


def write_tags(path, fmt, meta, cover=None):
    """Writes `meta` (see META_KEYS) and an optional JPEG `cover` into `path`.
    Blank values are skipped rather than written as empty frames."""
    meta = _clean(meta or {})
    if fmt in ('mp3', 'wav'):
        if fmt == 'mp3':
            from mutagen.mp3 import MP3
            audio = MP3(path)
        else:
            from mutagen.wave import WAVE
            audio = WAVE(path)
        _write_id3(audio, meta, cover).save()
    elif fmt in ('m4a', 'alac'):
        from mutagen.mp4 import MP4, MP4Cover
        audio = MP4(path)
        atoms = {'title': '\xa9nam', 'artist': '\xa9ART', 'album': '\xa9alb', 'albumArtist': 'aART',
                 'date': '\xa9day', 'genre': '\xa9gen', 'comment': '\xa9cmt'}
        for key, atom in atoms.items():
            if key in meta:
                audio[atom] = [meta[key]]
        number = _track_number(meta['track']) if 'track' in meta else None
        if number:
            audio['trkn'] = [(number, 0)]
        if cover:
            audio['covr'] = [MP4Cover(cover, imageformat=MP4Cover.FORMAT_JPEG)]
        audio.save()
    elif fmt == 'flac':
        from mutagen.flac import FLAC
        audio = FLAC(path)
        _vorbis(audio, meta, cover, lambda a, pic: a.add_picture(pic))
        audio.save()
    elif fmt in ('opus', 'ogg'):
        if fmt == 'opus':
            from mutagen.oggopus import OggOpus
            audio = OggOpus(path)
        else:
            from mutagen.oggvorbis import OggVorbis
            audio = OggVorbis(path)

        def embed(a, pic):
            a['metadata_block_picture'] = [base64.b64encode(pic.write()).decode('ascii')]
        _vorbis(audio, meta, cover, embed)
        audio.save()
    else:
        raise ValueError('Unsupported format for tags: %s' % fmt)
