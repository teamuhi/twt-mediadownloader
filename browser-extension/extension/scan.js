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

  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"], meta[property="og:image:url"]')
    .forEach((m) => add(m.content, 'image'));
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"]')
    .forEach((m) => { if (!EMBED_RE.test(m.content || '')) add(m.content, 'video'); });

  document.querySelectorAll('img').forEach((img) => {
    if (!shown(img)) return;
    const dims = { w: img.naturalWidth, h: img.naturalHeight };
    add(bestFromSrcset(img.srcset) || img.currentSrc || img.src, 'image', dims);
  });
  document.querySelectorAll('picture source[srcset]').forEach((s) => {
    const img = s.parentElement.querySelector('img');
    if (!img || shown(img)) add(bestFromSrcset(s.srcset), 'image');
  });

  document.querySelectorAll('video').forEach((v) => {
    if (!shown(v)) return;
    const poster = v.poster ? abs(v.poster) || '' : '';
    add(v.currentSrc || v.src, 'video', { poster });
    v.querySelectorAll('source[src]').forEach((s) => add(s.src, 'video', { poster }));
    if (poster) add(v.poster, 'image');
  });
  document.querySelectorAll('audio').forEach((a) => {
    if (a.controls && !shown(a)) return;
    add(a.currentSrc || a.src, 'audio');
    a.querySelectorAll('source[src]').forEach((s) => add(s.src, 'audio'));
  });

  document.querySelectorAll('a[href]').forEach((a) => {
    if (!shown(a)) return;
    const path = (abs(a.href) || '').split(/[?#]/)[0];
    for (const kind in MEDIA_EXT) {
      if (MEDIA_EXT[kind].test(path)) { add(a.href, kind); break; }
    }
  });

  document.querySelectorAll('iframe[src]').forEach((f) => {
    if (EMBED_RE.test(f.src) && shown(f)) add(f.src, 'embed');
  });

  return { title: document.title || '', url: location.href, items };
})();
