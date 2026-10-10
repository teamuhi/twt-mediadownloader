// Injected into the active page by the background script (scanPage). The value
// of the last expression is what executeScript hands back, so this must stay a
// single IIFE with no side effects on the page.
(() => {
  const MAX_ITEMS = 300;
  const MIN_PX = 48;
  const MEDIA_EXT = {
    image: /\.(?:jpe?g|png|gif|webp|avif|svg|bmp)$/i,
    video: /\.(?:mp4|webm|mov|m4v|mkv)$/i,
    audio: /\.(?:mp3|m4a|wav|ogg|oga|flac|opus|aac)$/i,
  };
  const EMBED_RE = /^https?:\/\/(?:[\w-]+\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|dailymotion\.com|soundcloud\.com|streamable\.com|wistia\.(?:com|net)|loom\.com|twitch\.tv)\//i;

  // Query params that only pick a rendition of the same picture.
  const SIZE_PARAMS = /^(?:w|h|width|height|size|quality|q|resize|fit|format|auto|dpr)$/i;
  const SIZE_SUFFIX = /[_-]\d{2,4}x\d{2,4}(?=\.\w+$)/;

  const byKey = new Map();
  const items = [];

  // True for elements the visitor can actually see: skips display:none
  // templates, lazy-load placeholders and invisible tracking/spinner images.
  function shown(el) {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  // Identifies one picture across its renditions (?w=300 / _1280x1280.jpg).
  function variantKey(url) {
    const u = new URL(url);
    [...u.searchParams.keys()].forEach((k) => { if (SIZE_PARAMS.test(k)) u.searchParams.delete(k); });
    u.hash = '';
    u.pathname = u.pathname.replace(SIZE_SUFFIX, '');
    return u.href;
  }

  function abs(url) {
    try {
      const u = new URL(url, document.baseURI);
      return /^https?:$/.test(u.protocol) ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  function nameOf(url) {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || new URL(url).hostname);
    } catch (e) {
      return url;
    }
  }

  function add(raw, kind, extra) {
    const url = raw && abs(raw);
    if (!url) return;
    const w = (extra && extra.w) || 0;
    const h = (extra && extra.h) || 0;
    if (kind === 'image' && w && h && Math.max(w, h) < MIN_PX) return;
    const key = kind + '|' + variantKey(url);
    const item = { url, kind, w, h, name: nameOf(url), poster: (extra && extra.poster) || '' };
    const prev = byKey.get(key);
    if (prev) {
      // Same picture again: keep the larger rendition.
      if (w * h > prev.w * prev.h) Object.assign(prev, item);
      return;
    }
    if (items.length >= MAX_ITEMS) return;
    byKey.set(key, item);
    items.push(item);
  }

  // The widest candidate of a srcset ("a.jpg 480w, b.jpg 1200w").
  function bestFromSrcset(srcset) {
    let best = null;
    let bestW = -1;
    (srcset || '').split(',').forEach((part) => {
      const [u, d] = part.trim().split(/\s+/);
      const n = parseFloat(d) || 1;
      if (u && n > bestW) { best = u; bestW = n; }
    });
    return best;
  }

  // querySelectorAll that also pierces open shadow roots (web components).
  function all(selector, root = document) {
    const found = [...root.querySelectorAll(selector)];
    root.querySelectorAll('*').forEach((host) => {
      if (host.shadowRoot) found.push(...all(selector, host.shadowRoot));
    });
    return found;
  }

  // Lazy-loaders park the real URL in a data-* attribute while src is a placeholder.
  const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url', 'data-hi-res-src'];
  const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];
  const attr = (el, names) => names.map((n) => el.getAttribute(n)).find(Boolean) || '';

  function imageUrl(img) {
    const real = (u) => u && !u.startsWith('data:') && !u.startsWith('blob:');
    return bestFromSrcset(img.srcset)
      || bestFromSrcset(attr(img, LAZY_SRCSET))
      || [img.currentSrc, img.src].find(real)
      || attr(img, LAZY_ATTRS);
  }

  // Manifests and blob: players can't be fetched as a file; yt-dlp handles the manifest.
  const STREAM_RE = /\.(?:m3u8|mpd)$/i;
  function addVideo(url, extra) {
    const clean = (abs(url) || '').split(/[?#]/)[0];
    add(url, STREAM_RE.test(clean) ? 'embed' : 'video', extra);
  }

  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"], meta[property="og:image:url"]')
    .forEach((m) => add(m.content, 'image'));
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]')
    .forEach((m) => { if (!EMBED_RE.test(m.content || '')) addVideo(m.content); });

  all('img').forEach((img) => {
    if (!shown(img)) return;
    add(imageUrl(img), 'image', { w: img.naturalWidth, h: img.naturalHeight });
  });
  all('picture source').forEach((s) => {
    const img = s.parentElement.querySelector('img');
    if (!img || shown(img)) add(bestFromSrcset(s.srcset) || bestFromSrcset(attr(s, LAZY_SRCSET)), 'image');
  });

  all('video').forEach((v) => {
    if (!shown(v)) return;
    const poster = v.poster ? abs(v.poster) || '' : '';
    addVideo(v.currentSrc || v.src || attr(v, LAZY_ATTRS), { poster });
    v.querySelectorAll('source[src]').forEach((s) => addVideo(s.src, { poster }));
    if (poster) add(v.poster, 'image');
  });
  all('audio').forEach((a) => {
    if (a.controls && !shown(a)) return;
    add(a.currentSrc || a.src, 'audio');
    a.querySelectorAll('source[src]').forEach((s) => add(s.src, 'audio'));
  });

  all('a[href]').forEach((a) => {
    if (!shown(a)) return;
    const path = (abs(a.href) || '').split(/[?#]/)[0];
    for (const kind in MEDIA_EXT) {
      if (MEDIA_EXT[kind].test(path)) { add(a.href, kind); break; }
    }
    if (STREAM_RE.test(path)) add(a.href, 'embed');
  });

  all('iframe[src]').forEach((f) => {
    if (EMBED_RE.test(f.src) && shown(f)) add(f.src, 'embed');
  });

  // CSS background images (galleries, hero banners, many lazy-load libraries).
  const BG_URL = /url\((['"]?)(.*?)\1\)/g;
  all('*').slice(0, 4000).forEach((el) => {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none' || !shown(el)) return;
    const rect = el.getBoundingClientRect();
    for (const m of bg.matchAll(BG_URL)) {
      if (!m[2].startsWith('data:')) add(m[2], 'image', { w: Math.round(rect.width), h: Math.round(rect.height) });
    }
  });

  return { title: document.title || '', url: location.href, top: window === window.top, items };
})();
