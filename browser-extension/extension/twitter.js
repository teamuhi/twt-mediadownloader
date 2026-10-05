// Twitter/X panel: media-only download (MP4 at a chosen resolution, photos at a
// chosen size, optional GIF conversion with frame rate / speed / size / trim)
// and tweet-card download (1x-3x), with the quoted post previewed in both.
// Registers itself into popup.js's `panels` registry.

(() => {
  const FPS_OPTIONS = [10, 12, 15, 20, 24, 30];
  const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const WIDTH_OPTIONS = [720, 540, 480, 360, 240];
  const MIN_CLIP = 0.1; // seconds
  const GIF_BYTES_PER_PIXEL_FRAME = 0.12; // rough palette+LZW average, for the size hint
  const CARD_BASE_W = 598; // px at 1x, matches backend render.CARD_W
  const CARD_SCALES = [1, 2, 3];
  const PHOTO_PRESETS = [['large', 'Large', 2048], ['medium', 'Medium', 1200], ['small', 'Small', 680]]; // twimg ?name= sizes

  const el = {
    text: $('tw-text'), strip: $('tw-strip'), title: $('tw-title'),
    kind: $('tw-kind'), mediaOpts: $('tw-media-opts'), cardOpts: $('tw-card-opts'),
    formats: $('tw-formats'), quality: $('tw-quality'), gifEst: $('tw-gif-est'), gifOpts: $('tw-gif-opts'),
    fps: $('tw-fps'), speed: $('tw-speed'), width: $('tw-width'),
    preview: $('tw-preview'), trim: $('tw-trim'), range: $('tw-range'),
    start: $('tw-start'), end: $('tw-end'), startT: $('tw-start-t'), endT: $('tw-end-t'),
    photoOpts: $('tw-photo-opts'), photoSize: $('tw-photo-size'), cardScale: $('tw-card-scale'),
    cardTheme: $('tw-card-theme'), showText: $('tw-show-text'), showDate: $('tw-show-date'), showVerified: $('tw-show-verified'),
    showQuote: $('tw-show-quote'), showQuoteLabel: $('tw-show-quote-label'),
    quote: $('card-quote'), cardOwn: $('card-own'),
    card: $('tw-card'), cardAvatar: $('card-avatar'), cardName: $('card-name'), cardVerified: $('card-verified'),
    cardHandle: $('card-handle'), cardText: $('card-text'), cardDate: $('card-date'),
    heroImg: $('tw-hero-img'), qualityRow: $('tw-quality-row'), ext: $('tw-ext'),
  };

  el.quote.append($('quote-tpl').content.cloneNode(true));

  let tweet = null;
  let selected = 0;
  let kind = 'media';
  let card = { theme: 'light', showText: true, showDate: true, showVerified: true, showQuote: true, scale: 2 };
  let trim = { start: 0, end: 0 };

  const currentItem = () => (tweet && tweet.media[selected]) || null;
  const isVideo = (item) => item && item.type !== 'photo';
  const format = () => document.querySelector('input[name="twfmt"]:checked').value;

  function savePrefs() {
    browser.storage.local.set({ twKind: kind, twCard: card });
  }

  // ----------------------------------------------------------- time helpers

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    return m + ':' + (seconds - m * 60).toFixed(1).padStart(4, '0');
  }

  // Accepts "12", "12.5", "1:02", "1:02.5"; returns null if unparseable.
  function parseTime(text) {
    const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(text);
    return m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : null;
  }

  // --------------------------------------------------------------- render

  function fillSelect(select, values, labelFn, selectedValue) {
    select.innerHTML = '';
    values.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = labelFn(v);
      select.appendChild(opt);
    });
    if (selectedValue != null) select.value = selectedValue;
  }

  function setSeg(seg, attr, value) {
    seg.querySelectorAll('[role="tab"]').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset[attr] === value));
    });
  }

  // Mirrors the host's default filename: media of a quoted tweet is named
  // after that tweet; a card is named after the tweet itself.
  function defaultTitle() {
    const item = currentItem();
    if (kind === 'card' || !item) return tweet.author.handle + '_' + tweet.tweetId + '_card';
    const source = item.from === 'quoted' && tweet.quoted ? tweet.quoted : tweet;
    const group = tweet.media.filter((m) => m.from === item.from);
    return source.author.handle + '_' + source.tweetId + (group.length > 1 ? '_' + (group.indexOf(item) + 1) : '');
  }

  function updateGifEstimate() {
    const item = currentItem();
    if (!isVideo(item) || !item.width || trim.end <= trim.start) {
      el.gifEst.textContent = '';
      return;
    }
    const width = Number(el.width.value) || item.width;
    const height = Math.round(width * item.height / item.width);
    const seconds = (trim.end - trim.start) / Number(el.speed.value);
    const bytes = width * height * Number(el.fps.value) * seconds * GIF_BYTES_PER_PIXEL_FRAME;
    el.gifEst.textContent = width + '×' + height + ' · ~' + formatBytes(bytes);
  }

  function updateTrimUI() {
    const max = Number(el.end.max) || 1;
    el.range.style.setProperty('--lo', (trim.start / max * 100) + '%');
    el.range.style.setProperty('--hi', (trim.end / max * 100) + '%');
    el.start.value = trim.start;
    el.end.value = trim.end;
    el.startT.value = formatTime(trim.start);
    el.endT.value = formatTime(trim.end);
    updateGifEstimate();
  }

  // Keeps start < end by at least MIN_CLIP, moving whichever thumb was not touched last.
  function setTrim(start, end, moved) {
    const max = Number(el.end.max) || 0;
    start = Math.max(0, Math.min(start, max));
    end = Math.max(0, Math.min(end, max));
    if (end - start < MIN_CLIP) {
      if (moved === 'start') start = Math.max(0, end - MIN_CLIP);
      else end = Math.min(max, start + MIN_CLIP);
    }
    trim = { start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10 };
    updateTrimUI();
    if (el.preview.src && moved) el.preview.currentTime = moved === 'start' ? trim.start : Math.max(trim.start, trim.end - 0.1);
  }

  function formatDate(iso, withTime) {
    const date = iso && new Date(iso);
    if (!date || isNaN(date)) return '';
    const day = date.toLocaleDateString('en-US', withTime ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
    return withTime ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' · ' + day : day;
  }

  // Thumbnails laid out like the rendered card (1, 2, 3 or 4 images).
  function fillGrid(grid, items) {
    grid.replaceChildren();
    const shown = items.slice(0, 4);
    grid.classList.toggle('hidden', !shown.length);
    grid.dataset.n = shown.length;
    const first = shown[0];
    if (shown.length === 1 && first.width && first.height) {
      grid.style.setProperty('--ar', String(Math.min(2, Math.max(0.8, first.width / first.height))));
    } else {
      grid.style.removeProperty('--ar');
    }
    shown.forEach((m) => {
      const cell = document.createElement('div');
      cell.className = 'mg-cell' + (m.index === selected ? ' is-selected' : '');
      cell.dataset.index = m.index;
      const img = document.createElement('img');
      img.alt = '';
      img.src = m.thumbnail || '';
      cell.append(img);
      if (m.type !== 'photo') cell.append(textNode('span', 'mg-play', '▶'));
      grid.append(cell);
    });
  }

  // Fills a quote box built from #quote-tpl with the quoted post.
  function renderQuote(box, quoted, items, opts) {
    const q = (cls) => box.querySelector('.' + cls);
    const avatar = q('q-avatar');
    avatar.src = quoted.author.avatarUrl || '';
    avatar.classList.toggle('hidden', !quoted.author.avatarUrl);
    q('q-name').textContent = quoted.author.name;
    q('q-verified').classList.toggle('hidden', !(quoted.author.verified && opts.showVerified));
    q('q-handle').textContent = '@' + quoted.author.handle;
    const date = opts.showDate ? formatDate(quoted.createdAt) : '';
    q('q-date').textContent = date ? '· ' + date : '';
    const text = q('q-text');
    text.textContent = quoted.text;
    text.classList.toggle('hidden', !(opts.showText && quoted.text));
    fillGrid(q('q-media'), items);
  }

  const quoteItems = () => (tweet.media || []).filter((m) => m.from === 'quoted');

  function renderCardPreview() {
    el.card.dataset.cardTheme = card.theme;
    setSeg(el.cardTheme, 'theme', card.theme);
    el.showText.checked = card.showText;
    el.showDate.checked = card.showDate;
    el.showVerified.checked = card.showVerified;
    el.showQuote.checked = card.showQuote;

    const { author, text, createdAt } = tweet;
    el.cardAvatar.src = author.avatarUrl || '';
    el.cardAvatar.classList.toggle('hidden', !author.avatarUrl);
    el.cardName.textContent = author.name;
    el.cardHandle.textContent = '@' + author.handle;
    el.cardVerified.classList.toggle('hidden', !(author.verified && card.showVerified));
    el.cardText.textContent = text;
    el.cardText.classList.toggle('hidden', !(card.showText && text));

    fillGrid(el.cardOwn, tweet.media.filter((m) => m.from === 'own'));

    const quoted = tweet.quoted;
    el.showQuoteLabel.classList.toggle('hidden', !quoted);
    el.quote.classList.toggle('hidden', !(quoted && card.showQuote));
    if (quoted) renderQuote(el.quote, quoted, quoteItems(), card);

    const when = card.showDate ? formatDate(createdAt, true) : '';
    el.cardDate.classList.toggle('hidden', !when);
    el.cardDate.textContent = when;

    renderScaleOptions();
  }

  // 1x-3x with the output width; video cards are limited to 2x (see cardScale()).
  function renderScaleOptions() {
    const video = isVideo(currentItem());
    if (!el.cardScale.options.length) {
      CARD_SCALES.forEach((s) => el.cardScale.appendChild(new Option('', s)));
    }
    Array.from(el.cardScale.options).forEach((opt) => {
      const s = Number(opt.value);
      opt.disabled = video && s > 2;
      opt.textContent = s + '× · ' + CARD_BASE_W * s + ' px wide' + (opt.disabled ? ' · images only' : '');
    });
    el.cardScale.value = String(cardScale());
  }

  // Video cards are rendered at 2x at most (encoder size limits).
  function cardScale() {
    return isVideo(currentItem()) ? Math.min(card.scale, 2) : card.scale;
  }

  // What the current selection will be saved as; drives the footer button, hint and filename badge.
  function output() {
    const item = currentItem();
    if (kind === 'card') {
      if (!item) return { label: 'PNG', ext: '.png', hint: 'Saved as a PNG image (text only).' };
      if (isVideo(item)) return { label: 'MP4', ext: '.mp4', hint: 'Saved as an MP4 video with the card around it.' };
      const many = tweet.media.filter((m) => m.type === 'photo').length > 1;
      return { label: 'PNG', ext: '.png', hint: 'Saved as a PNG image' + (many ? ' (up to 4 photos).' : '.') };
    }
    if (!isVideo(item)) return { label: 'Image', ext: '', hint: '' };
    return format() === 'gif'
      ? { label: 'GIF', ext: '.gif', hint: 'Converted from the video.' }
      : { label: 'MP4', ext: '.mp4', hint: '' };
  }

  function render() {
    const item = currentItem();
    const hasMedia = !!item;
    el.kind.querySelector('[data-kind="media"]').disabled = !hasMedia;
    if (!hasMedia) kind = 'card';
    setSeg(el.kind, 'kind', kind);
    el.mediaOpts.classList.toggle('hidden', kind !== 'media');
    el.cardOpts.classList.toggle('hidden', kind !== 'card');
    el.title.placeholder = defaultTitle();

    let gifOpen = false;
    if (kind === 'media' && hasMedia) {
      const video = isVideo(item);
      gifOpen = video && format() === 'gif';
      el.formats.classList.toggle('hidden', !video);
      el.qualityRow.classList.toggle('hidden', gifOpen);
      el.photoOpts.classList.toggle('hidden', video);
      el.gifOpts.classList.toggle('hidden', !gifOpen);
    }

    // One hero slot: the card, the looping GIF clip, or the selected media's still.
    const showPreview = kind === 'media' && gifOpen && !!item.previewUrl;
    const showStill = kind === 'media' && hasMedia && !showPreview && !!item.thumbnail;
    el.card.classList.toggle('hidden', kind !== 'card');
    el.preview.classList.toggle('hidden', !showPreview);
    el.heroImg.classList.toggle('hidden', !showStill);
    if (showStill && el.heroImg.getAttribute('src') !== item.thumbnail) el.heroImg.src = item.thumbnail;
    if (!showPreview) el.preview.pause();

    // Media-only mode shows no author; the card preview shows its own author and text.
    el.text.classList.toggle('hidden', !tweet.text || kind !== 'media');
    if (kind === 'card') renderCardPreview();
    refreshOutput();
  }

  // Original plus the twimg size presets that are actually smaller than the photo.
  function photoSizes(item) {
    const long = Math.max(item.width || 0, item.height || 0);
    const dims = (limit) => {
      const f = Math.min(1, limit / long);
      return Math.round(item.width * f) + '×' + Math.round(item.height * f);
    };
    const original = { id: 'orig', label: 'Original' + (long ? ' · ' + item.width + '×' + item.height : '') };
    if (!long) return [original];
    return [original, ...PHOTO_PRESETS.filter(([, , limit]) => long > limit).map(([id, name, limit]) => ({ id, label: name + ' · ' + dims(limit) }))];
  }

  // Rebuilds everything that depends on which media item is selected.
  function selectMedia(index) {
    selected = index;
    const item = currentItem();
    el.strip.querySelectorAll('.tw-thumb').forEach((btn, i) => btn.classList.toggle('is-selected', i === index));
    document.querySelectorAll('#tw-panel .mg-cell[data-index]').forEach((cell) => cell.classList.toggle('is-selected', Number(cell.dataset.index) === index));

    if (item && item.type === 'photo') {
      fillSelect(el.photoSize, photoSizes(item).map((o) => o.id), (id) => photoSizes(item).find((o) => o.id === id).label);
    }
    if (isVideo(item)) {
      // Heights X serves directly come first-class; the rest are downscaled by ffmpeg ("scaled").
      fillSelect(el.quality, (item.qualities || []).map((q) => q.height), (h) => {
        const q = item.qualities.find((x) => x.height === h);
        const size = formatBytes(q.estimated_bytes);
        return h + 'p' + (size ? ' · ' + (q.native === false ? '~' : '') + size : '') + (q.native === false ? ' · scaled' : '');
      });
      if (!el.quality.options.length) fillSelect(el.quality, [''], () => 'best available');

      const widths = WIDTH_OPTIONS.filter((w) => !item.width || w < item.width);
      fillSelect(el.width, ['', ...widths], (w) => (w ? w + ' px' : 'Original'), widths.includes(480) ? 480 : '');

      const duration = item.duration || 0;
      el.end.max = el.start.max = duration || 1;
      el.trim.classList.toggle('hidden', !duration);
      el.preview.poster = item.thumbnail || '';
      if (item.previewUrl) el.preview.src = item.previewUrl; else el.preview.removeAttribute('src');
      trim = { start: 0, end: duration };
      updateTrimUI();

      document.querySelector('input[name="twfmt"][value="' + (item.type === 'animated_gif' ? 'gif' : 'mp4') + '"]').checked = true;
    }
    render();
  }

  function buildStrip() {
    el.strip.innerHTML = '';
    // Shown for 2+ items, or when the only media belongs to the quoted post (so it's visible where it came from).
    el.strip.classList.toggle('hidden', tweet.media.length < 2 && !(tweet.media[0] && tweet.media[0].from === 'quoted'));
    tweet.media.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tw-thumb';
      const label = m.type === 'photo' ? 'Photo' : m.type === 'animated_gif' ? 'GIF' : 'Video';
      btn.title = (m.from === 'quoted' ? 'Quoted post: ' : '') + label + ' ' + (i + 1);
      const img = document.createElement('img');
      img.alt = '';
      img.src = m.thumbnail || '';
      const kindBadge = m.type === 'photo' ? 'IMG' : m.type === 'animated_gif' ? 'GIF' : 'VID';
      btn.append(img, textNode('span', 'tw-badge', (m.from === 'quoted' ? 'QT ' : '') + kindBadge));
      btn.addEventListener('click', () => selectMedia(i));
      el.strip.appendChild(btn);
    });
  }

  function populate() {
    el.text.textContent = tweet.text;
    el.title.value = '';

    fillSelect(el.fps, FPS_OPTIONS, (v) => v + ' fps', 15);
    fillSelect(el.speed, SPEED_OPTIONS, (v) => v + '×', 1);
    buildStrip();
    selectMedia(0);
    $('tw-content').classList.remove('hidden');
  }

  // ------------------------------------------------------------- listeners

  el.kind.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (!tab || tab.disabled) return;
    kind = tab.dataset.kind;
    savePrefs();
    render();
  });

  el.cardScale.addEventListener('change', () => {
    card.scale = Number(el.cardScale.value);
    savePrefs();
    renderCardPreview();
  });

  el.cardTheme.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (!tab) return;
    card.theme = tab.dataset.theme;
    savePrefs();
    renderCardPreview();
  });

  [['showText', el.showText], ['showDate', el.showDate], ['showVerified', el.showVerified], ['showQuote', el.showQuote]].forEach(([key, box]) => {
    box.addEventListener('change', () => {
      card[key] = box.checked;
      savePrefs();
      renderCardPreview();
    });
  });

  document.querySelectorAll('input[name="twfmt"]').forEach((radio) => radio.addEventListener('change', render));
  [el.fps, el.speed, el.width].forEach((select) => select.addEventListener('change', updateGifEstimate));

  el.start.addEventListener('input', () => setTrim(Number(el.start.value), trim.end, 'start'));
  el.end.addEventListener('input', () => setTrim(trim.start, Number(el.end.value), 'end'));
  el.startT.addEventListener('change', () => {
    const t = parseTime(el.startT.value);
    setTrim(t == null ? trim.start : t, trim.end, 'start');
  });
  el.endT.addEventListener('change', () => {
    const t = parseTime(el.endT.value);
    setTrim(trim.start, t == null ? trim.end : t, 'end');
  });
  $('tw-start-now').addEventListener('click', () => setTrim(el.preview.currentTime, trim.end, 'start'));
  $('tw-end-now').addEventListener('click', () => setTrim(trim.start, el.preview.currentTime, 'end'));

  // Loop the preview inside the chosen clip.
  el.preview.addEventListener('timeupdate', () => {
    if (!trim.end) return;
    if (el.preview.currentTime >= trim.end || el.preview.currentTime < trim.start - 0.25) {
      el.preview.currentTime = trim.start;
    }
  });

  // ------------------------------------------------------------- registry

  panels.twitter = {
    el: $('tw-panel'),
    extEl: el.ext,
    output,
    accepts: (url) => TWEET_URL_RE.test(url),
    hint: 'Open a tweet (x.com/…/status/…) to use this tab.',
    loadingText: 'Loading tweet…',
    load: (url) => Promise.all([
      browser.storage.local.get(['twKind', 'twCard']),
      send({ type: 'getTweet', url }),
    ]).then(([stored, info]) => {
      kind = stored.twKind === 'card' ? 'card' : 'media';
      card = Object.assign(card, stored.twCard);
      // An older native host sends no quote data and doesn't tag which post a media item belongs to.
      noteOutdatedHost('twitter', !('quoted' in info));
      (info.media || []).forEach((m) => { m.from = m.from || 'own'; });
      tweet = Object.assign({ media: [], quoted: null }, info);
      noteYtdlp(info.ytdlp);
      populate();
    }),
    payload() {
      const item = currentItem();
      const isCard = kind === 'card';
      const fmt = !isVideo(item) ? 'photo' : format();
      const quality = !isCard && fmt === 'mp4' ? Number(el.quality.value) || undefined : undefined;
      return {
        mode: isCard ? 'card' : fmt,
        quality,
        title: el.title.value.trim() || undefined,
        options: {
          kind,
          format: fmt,
          mediaIndex: selected,
          quality,
          photoSize: el.photoSize.value || 'orig',
          gif: {
            fps: Number(el.fps.value),
            speed: Number(el.speed.value),
            width: Number(el.width.value) || null,
            start: trim.start,
            end: trim.end || null,
          },
          card: Object.assign({}, card, { scale: cardScale() }),
        },
      };
    },
  };
})();
