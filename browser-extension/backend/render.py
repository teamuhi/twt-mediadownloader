# coding: utf-8
"""ffmpeg helpers (GIF conversion, progress parsing) and tweet-card rendering.

Cards are drawn with Pillow at 2x. Photo cards are a single PNG. Video/GIF
cards are a PNG background + the video scaled into the media box + a
transparent overlay (rounded corners and border), composited by ffmpeg.
"""

from __future__ import unicode_literals

import functools
import os
import re
import subprocess
from datetime import datetime

from PIL import Image, ImageChops, ImageDraw, ImageFont

from errors import FfmpegError, TweetError

# ---------------------------------------------------------------- ffmpeg

PROGRESS_KEY_RE = re.compile(r'^(frame|fps|stream_\S+|bitrate|total_size|out_time_us|out_time_ms|out_time|dup_frames|drop_frames|speed|progress)=(.*)$')


def ffmpeg_exe(ffmpeg_location=None):
    return os.path.join(ffmpeg_location, 'ffmpeg.exe') if ffmpeg_location else 'ffmpeg'


def run_ffmpeg(args, duration, on_progress, status, ffmpeg_location=None):
    """Runs ffmpeg with `args`, reporting on_progress(status=..., percent=...)
    from its -progress stream. `duration` is the expected output length in
    seconds (None = no percent). Raises FfmpegError with the stderr tail."""
    cmd = [ffmpeg_exe(ffmpeg_location), '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'] + args
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True, encoding='utf-8', errors='replace')
    except FileNotFoundError:
        raise TweetError('E_FFMPEG_MISSING', 'ffmpeg not found')
    tail = []
    on_progress(status=status, percent=0)
    for line in proc.stdout:
        line = line.strip()
        m = PROGRESS_KEY_RE.match(line)
        if not m:
            if line:
                tail.append(line)
                del tail[:-5]
            continue
        if m.group(1) == 'out_time_us' and duration and m.group(2).lstrip('-').isdigit():
            on_progress(status=status, percent=max(0, min(99, round(int(m.group(2)) / 1e6 * 100 / duration, 1))))
    if proc.wait() != 0:
        raise FfmpegError('\n'.join(tail) or 'ffmpeg exited with code %d' % proc.returncode)


@functools.lru_cache(maxsize=None)
def _encoders(ffmpeg_location):
    """Names of the encoders this ffmpeg build has (empty set if it can't run)."""
    try:
        out = subprocess.run([ffmpeg_exe(ffmpeg_location), '-hide_banner', '-encoders'], capture_output=True, text=True, errors='replace', timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return frozenset()
    return frozenset(line.split()[1] for line in out.splitlines() if line.startswith(' V') and len(line.split()) > 1)


def h264_args(ffmpeg_location, width, height):
    """H.264 encoder args for whatever this ffmpeg has: libx264 on a GPL
    build; the bundled LGPL build has none, so fall back to OpenH264, then
    Windows' Media Foundation encoder, then MPEG-4 part 2."""
    have = _encoders(ffmpeg_location)
    bitrate = '%dk' % max(2000, min(12000, int(width * height * 30 * 0.1 / 1000)))
    if 'libx264' in have:
        return ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium']
    if 'libopenh264' in have:
        return ['-c:v', 'libopenh264', '-b:v', bitrate]
    if 'h264_mf' in have:
        return ['-c:v', 'h264_mf', '-b:v', bitrate]
    return ['-c:v', 'mpeg4', '-q:v', '3']


def to_gif(src, dest, fps, speed, width, start, end, on_progress, ffmpeg_location=None):
    """Video -> GIF. `width` None keeps the source width (never upscales);
    start/end in seconds (end None = to the end)."""
    start = max(0.0, start or 0.0)
    clip = (end - start) if end else None
    scale = 'scale=w=%s:h=-2:flags=lanczos' % ("'min(%d,iw)'" % width if width else 'iw')
    graph = (
        '[0:v]setpts=PTS/%s,fps=%d,%s,split[a][b];'
        '[a]palettegen=stats_mode=diff[p];'
        '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle'
    ) % (speed, fps, scale)
    # -t before -i limits the *input* span, so end is honoured at any speed.
    args = ['-ss', '%.3f' % start] + (['-t', '%.3f' % clip] if clip else []) + ['-i', src]
    args += ['-filter_complex', graph, '-an', '-loop', '0', dest]
    run_ffmpeg(args, clip / speed if clip else None, on_progress, 'converting', ffmpeg_location)


# ------------------------------------------------------------ card layout

SCALE = 2
SS = 4  # supersampling for anti-aliased shapes
CARD_W = 598
PAD = 16
AVATAR = 40
MEDIA_W = CARD_W - 2 * PAD
RADIUS = 16
BORDER = 1
LINE_H = 24
GAP = 12
MAX_TALL = 1.25
GRID_H = 318
QPAD = 12  # padding inside the quoted-tweet box
QMEDIA_RADIUS = 12

THEMES = {
    'light': {'bg': (255, 255, 255), 'text': (15, 20, 25), 'muted': (83, 100, 113), 'border': (207, 217, 222)},
    'dark': {'bg': (0, 0, 0), 'text': (231, 233, 234), 'muted': (113, 118, 123), 'border': (47, 51, 54)},
}
BLUE = (29, 155, 240)

FONT_FILES = {'regular': ('segoeui.ttf',), 'bold': ('segoeuib.ttf', 'seguisb.ttf'), 'emoji': ('seguiemj.ttf',)}
EMOJI_RE = re.compile('([\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\u2190-\u21FF\uFE0F\u200D\u20E3]+)')


@functools.lru_cache(maxsize=None)
def _font(kind, size):
    fonts_dir = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')
    for name in FONT_FILES[kind]:
        try:
            return ImageFont.truetype(os.path.join(fonts_dir, name), size)
        except OSError:
            continue
    return ImageFont.load_default(size) if kind != 'emoji' else None


def _runs(text):
    """Splits into [(chunk, is_emoji)]."""
    return [(p, i % 2 == 1) for i, p in enumerate(EMOJI_RE.split(text)) if p]


def _width(text, kind, size):
    total = 0
    for chunk, emoji in _runs(text):
        f = _font('emoji', size) if emoji else _font(kind, size)
        total += f.getlength(chunk) if f else 0
    return total


def _draw_text(draw, x, baseline, text, kind, size, color):
    for chunk, emoji in _runs(text):
        f = _font('emoji', size) if emoji else _font(kind, size)
        if not f:
            continue
        try:
            draw.text((x, baseline), chunk, font=f, fill=color, anchor='ls', embedded_color=emoji)
        except Exception:
            pass  # emoji font without color support: skip the glyph rather than fail the card
        x += f.getlength(chunk)
    return x


def _baseline(y, line_h, kind, size):
    asc, desc = _font(kind, size).getmetrics()
    return y + (line_h - (asc + desc)) // 2 + asc


def _wrap(text, max_w, kind, size):
    lines = []
    for para in text.split('\n'):
        line = ''
        for word in para.split(' '):
            trial = (line + ' ' + word) if line else word
            if _width(trial, kind, size) <= max_w:
                line = trial
                continue
            if line:
                lines.append(line)
            while _width(word, kind, size) > max_w and len(word) > 1:  # long URL etc.
                cut = len(word)
                while cut > 1 and _width(word[:cut], kind, size) > max_w:
                    cut -= 1
                lines.append(word[:cut])
                word = word[cut:]
            line = word
        lines.append(line)
    return lines


def _format_date(iso):
    if not iso:
        return ''
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone()
    except ValueError:
        return ''
    return '%s \u00b7 %s %d, %d' % (dt.strftime('%I:%M %p').lstrip('0'), dt.strftime('%b'), dt.day, dt.year)


def _rounded_mask(size, radius, inset=0):
    w, h = size
    m = Image.new('L', (w * SS, h * SS), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [inset * SS, inset * SS, w * SS - 1 - inset * SS, h * SS - 1 - inset * SS],
        radius=max(radius - inset, 0) * SS, fill=255)
    return m.resize((w, h), Image.LANCZOS)


def _paste_color(img, color, mask, pos):
    layer = Image.new('RGBA', mask.size, color + (0,))
    layer.putalpha(mask)
    img.alpha_composite(layer, pos)


def _circle_avatar(path, d, name, theme):
    mask = _rounded_mask((d, d), d // 2)
    avatar = None
    if path:
        try:
            avatar = Image.open(path).convert('RGBA').resize((d, d), Image.LANCZOS)
        except Exception:
            avatar = None
    if avatar is None:
        avatar = Image.new('RGBA', (d, d), theme['muted'] + (255,))
        initial = (name or '?')[:1].upper()
        f = _font('bold', d // 2)
        ImageDraw.Draw(avatar).text((d // 2, d // 2), initial, font=f, fill=theme['bg'], anchor='mm')
    avatar.putalpha(mask)
    return avatar


def _draw_verified(img, x, cy, d):
    mask = _rounded_mask((d, d), d // 2)
    _paste_color(img, BLUE, mask, (int(x), int(cy - d / 2)))
    draw = ImageDraw.Draw(img)
    s = d / 18
    ox, oy = x, cy - d / 2
    pts = [(ox + 5 * s, oy + 9.5 * s), (ox + 8 * s, oy + 12.5 * s), (ox + 13.5 * s, oy + 6 * s)]
    draw.line(pts, fill=(255, 255, 255), width=max(2, int(1.8 * s)), joint='curve')


def _spec_aspect(spec):
    images = spec.get('images') or []
    if len(images) == 1:
        return images[0].width / images[0].height
    if images:
        return MEDIA_W / GRID_H
    return spec.get('aspect') or 16 / 9


def _fit_height(width, aspect):
    h = int(min(width / aspect, width * MAX_TALL))
    return h - h % 2


def _draw_name_row(img, x, top, tweet_author, size, theme, show_verified, max_w, badge, inline_handle):
    """Name (+ verified badge) and @handle. Stacked on two 20px lines when
    `inline_handle` is False (main header), else side by side (quote box)."""
    S = SCALE
    draw = ImageDraw.Draw(img)
    name = tweet_author['name']
    badge_w = (badge + 4 * S) if show_verified and tweet_author.get('verified') else 0
    limit = max_w * (0.6 if inline_handle else 1) - badge_w
    while len(name) > 1 and _width(name, 'bold', size) > limit:
        name = name[:-1]
    if name != tweet_author['name']:
        name = name[:-1] + '…'
    base = _baseline(top, 20 * S, 'bold', size)
    end_x = _draw_text(draw, x, base, name, 'bold', size, theme['text'])
    if badge_w:
        _draw_verified(img, end_x + 4 * S, top + 10 * S, badge)
        end_x += badge_w
        draw = ImageDraw.Draw(img)
    handle = '@' + tweet_author['handle']
    if inline_handle:
        hx, hbase, room = end_x + 6 * S, base, x + max_w - end_x - 6 * S
    else:
        hx, hbase, room = x, _baseline(top + 20 * S, 20 * S, 'regular', size), max_w
    while len(handle) > 2 and _width(handle, 'regular', size) > room:
        handle = handle[:-2] + '…'
    _draw_text(draw, hx, hbase, handle, 'regular', size, theme['muted'])


def _draw_media(img, rect, spec, radius, theme_name):
    """Draws a static media box (one image, or a 2-4 photo grid) with rounded
    corners + border. Returns True instead when `spec` is a video
    placeholder: the box is only reserved (black) for ffmpeg to overlay."""
    x, y, w, h = rect
    images = spec.get('images') or []
    if not images:
        ImageDraw.Draw(img).rectangle([x, y, x + w - 1, y + h - 1], fill=(0, 0, 0, 255))
        return True
    if len(images) == 1:
        box = _contain(images[0], w, h)
    else:
        box = Image.new('RGBA', (w, h), (0, 0, 0, 255))
        for im, (cx, cy, cw, ch) in zip(images, _photo_cells(len(images), w, h, 2 * SCALE)):
            box.alpha_composite(_cover(im, cw, ch), (cx, cy))
    img.alpha_composite(box, (x, y))
    img.alpha_composite(frame_overlay(img.size, rect, theme_name, radius))
    return False


def build_card(tweet, opts, avatar_path, own=None, quote=None, quote_avatar_path=None):
    """Draws the card. `own` / `quote` are media specs for the tweet itself and
    its quoted tweet: {'images': [PIL images]} for static media, or
    {'aspect': float} to reserve a box for a video. Returns (RGBA image,
    (video rect, corner radius) or None)."""
    theme_name = opts.get('theme')
    theme = THEMES.get(theme_name, THEMES['light'])
    S = SCALE
    W = CARD_W * S
    pad = PAD * S
    author = tweet['author']
    show_verified = opts.get('showVerified', True)
    show_text = opts.get('showText', True)
    quoted = tweet.get('quoted') if opts.get('showQuote', True) else None

    text_lines = _wrap(tweet['text'], W - 2 * pad, 'regular', 17 * S) if show_text and tweet.get('text') else []
    date = _format_date(tweet.get('createdAt')) if opts.get('showDate', True) else ''

    # ---- layout (everything in physical px, top to bottom)
    y = pad + AVATAR * S
    text_y = date_y = 0
    if text_lines:
        text_y = y + GAP * S
        y = text_y + len(text_lines) * LINE_H * S
    own_rect = None
    if own:
        mw = MEDIA_W * S
        own_rect = (pad, y + GAP * S, mw, _fit_height(mw, _spec_aspect(own)))
        y += GAP * S + own_rect[3]

    q = None
    if quoted:
        inner_x = pad + QPAD * S
        inner_w = MEDIA_W * S - 2 * QPAD * S
        box_y = y + GAP * S
        cy = box_y + QPAD * S
        q = {'box': (pad, box_y), 'head_y': cy, 'inner_x': inner_x, 'inner_w': inner_w, 'lines': [], 'text_y': 0, 'media': None}
        cy += 20 * S
        if show_text and quoted.get('text'):
            q['lines'] = _wrap(quoted['text'], inner_w, 'regular', 15 * S)
            q['text_y'] = cy + 4 * S
            cy = q['text_y'] + len(q['lines']) * 20 * S
        if quote:
            q['media'] = (inner_x, cy + 8 * S, inner_w, _fit_height(inner_w, _spec_aspect(quote)))
            cy += 8 * S + q['media'][3]
        q['size'] = (MEDIA_W * S, cy + QPAD * S - box_y)
        y = box_y + q['size'][1]

    if date:
        date_y = y + GAP * S
        y = date_y + 20 * S
    H = y + pad
    H += H % 2

    # ---- draw
    img = Image.new('RGBA', (W, H), theme['bg'] + (255,))
    img.alpha_composite(_circle_avatar(avatar_path, AVATAR * S, author['name'], theme), (pad, pad))
    name_x = pad + (AVATAR + 12) * S
    _draw_name_row(img, name_x, pad, author, 15 * S, theme, show_verified, W - pad - name_x, 18 * S, False)
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(text_lines):
        _draw_text(draw, pad, _baseline(text_y + i * LINE_H * S, LINE_H * S, 'regular', 17 * S), line, 'regular', 17 * S, theme['text'])

    video = None
    if own_rect:
        if _draw_media(img, own_rect, own, RADIUS * S, theme_name):
            video = (own_rect, RADIUS * S)

    if q:
        bx, by = q['box']
        bw, bh = q['size']
        outer = _rounded_mask((bw, bh), RADIUS * S)
        _paste_color(img, theme['border'], ImageChops.subtract(outer, _rounded_mask((bw, bh), RADIUS * S, inset=BORDER * S)), (bx, by))
        qa = 20 * S
        img.alpha_composite(_circle_avatar(quote_avatar_path, qa, quoted['author']['name'], theme), (q['inner_x'], q['head_y']))
        text_x = q['inner_x'] + qa + 8 * S
        _draw_name_row(img, text_x, q['head_y'], quoted['author'], 15 * S, theme, show_verified, q['inner_x'] + q['inner_w'] - text_x, 16 * S, True)
        draw = ImageDraw.Draw(img)
        for i, line in enumerate(q['lines']):
            _draw_text(draw, q['inner_x'], _baseline(q['text_y'] + i * 20 * S, 20 * S, 'regular', 15 * S), line, 'regular', 15 * S, theme['text'])
        if q['media'] and _draw_media(img, q['media'], quote, QMEDIA_RADIUS * S, theme_name):
            video = (q['media'], QMEDIA_RADIUS * S)

    if date:
        _draw_text(ImageDraw.Draw(img), pad, _baseline(date_y, 20 * S, 'regular', 15 * S), date, 'regular', 15 * S, theme['muted'])
    return img, video


def frame_overlay(size, rect, theme_name, radius=RADIUS * SCALE):
    """Transparent overlay that fills a media box's rounded corners with the
    card background and draws the border ring."""
    theme = THEMES.get(theme_name, THEMES['light'])
    x, y, w, h = rect
    outer = _rounded_mask((w, h), radius)
    ov = Image.new('RGBA', size, (0, 0, 0, 0))
    _paste_color(ov, theme['bg'], ImageChops.invert(outer), (x, y))
    ring = ImageChops.subtract(outer, _rounded_mask((w, h), radius, inset=BORDER * SCALE))
    _paste_color(ov, theme['border'], ring, (x, y))
    return ov


def _cover(im, w, h):
    scale = max(w / im.width, h / im.height)
    im = im.resize((max(w, round(im.width * scale)), max(h, round(im.height * scale))), Image.LANCZOS)
    left, top = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((left, top, left + w, top + h))


def _contain(im, w, h):
    scale = min(w / im.width, h / im.height)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    box = Image.new('RGBA', (w, h), (0, 0, 0, 255))
    box.alpha_composite(im, ((w - im.width) // 2, (h - im.height) // 2))
    return box


def _photo_cells(n, w, h, gap):
    half_w, half_h = (w - gap) // 2, (h - gap) // 2
    if n == 2:
        return [(0, 0, half_w, h), (half_w + gap, 0, w - half_w - gap, h)]
    if n == 3:
        return [(0, 0, half_w, h), (half_w + gap, 0, w - half_w - gap, half_h), (half_w + gap, half_h + gap, w - half_w - gap, h - half_h - gap)]
    return [(0, 0, half_w, half_h), (half_w + gap, 0, w - half_w - gap, half_h),
            (0, half_h + gap, half_w, h - half_h - gap), (half_w + gap, half_h + gap, w - half_w - gap, h - half_h - gap)]


def _spec(paths):
    images = [Image.open(p).convert('RGBA') for p in (paths or [])[:4]]
    return {'images': images} if images else None


def render_card_png(tweet, own_paths, quote_paths, opts, dest, avatar_path=None, quote_avatar_path=None):
    """Photo / text-only card (own and quoted media as static images) -> PNG."""
    img, _video = build_card(tweet, opts, avatar_path, _spec(own_paths), _spec(quote_paths), quote_avatar_path)
    img.convert('RGB').save(dest, 'PNG')


def render_card_video(tweet, video_path, target, opts, dest, tmp_dir, avatar_path, quote_avatar_path,
                      own_paths, quote_paths, aspect, duration, on_progress, ffmpeg_location=None):
    """Video/GIF card -> MP4 (audio kept when present). `target` says which
    box the playing video goes in, 'own' or 'quote' (the quoted tweet's
    video); the other box shows its media as static images."""
    if target == 'quote' and not (tweet.get('quoted') and opts.get('showQuote', True)):
        target, own_paths = 'own', []  # quote box hidden: play it in the main box instead
    placeholder = {'aspect': aspect or 16 / 9}
    own = placeholder if target == 'own' else _spec(own_paths)
    quote = placeholder if target == 'quote' else _spec(quote_paths)
    img, video = build_card(tweet, opts, avatar_path, own, quote, quote_avatar_path)
    (x, y, w, h), radius = video
    bg_path = os.path.join(tmp_dir, 'card-bg.png')
    fg_path = os.path.join(tmp_dir, 'card-fg.png')
    img.convert('RGB').save(bg_path, 'PNG')
    frame_overlay(img.size, (x, y, w, h), opts.get('theme'), radius).save(fg_path, 'PNG')

    graph = (
        '[1:v]scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v];'
        '[0:v][v]overlay=%d:%d:shortest=1[t];[t][2:v]overlay=0:0,format=yuv420p[out]'
    ) % (w, h, w, h, x, y)
    args = ['-loop', '1', '-framerate', '30', '-i', bg_path, '-i', video_path, '-i', fg_path,
            '-filter_complex', graph, '-map', '[out]', '-map', '1:a?',
            *h264_args(ffmpeg_location, img.width, img.height), '-c:a', 'aac', '-movflags', '+faststart',
            '-shortest', dest]
    run_ffmpeg(args, duration, on_progress, 'rendering', ffmpeg_location)
