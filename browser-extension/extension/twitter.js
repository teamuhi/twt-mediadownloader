// Twitter/X panel: media-only download (MP4, optional GIF conversion with
// frame rate / speed / size / trim) and tweet-card download. Registers itself
// into popup.js's `panels` registry.

(() => {
  const FPS_OPTIONS = [10, 12, 15, 20, 24, 30];
  const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const WIDTH_OPTIONS = [720, 540, 480, 360, 240];
  const MIN_CLIP = 0.1; // seconds
  const GIF_BYTES_PER_PIXEL_FRAME = 0.12; // rough palette+LZW average, for the size hint

  const el = {
    author: document.querySelector('.tw-author'), avatar: $('tw-avatar'), name: $('tw-name'), verified: $('tw-verified'), handle: $('tw-handle'),
    text: $('tw-text'), strip: $('tw-strip'), title: $('tw-title'),
    kind: $('tw-kind'), mediaOpts: $('tw-media-opts'), cardOpts: $('tw-card-opts'),
    formats: $('tw-formats'), quality: $('tw-quality'), gifEst: $('tw-gif-est'), gifOpts: $('tw-gif-opts'),
    fps: $('tw-fps'), speed: $('tw-speed'), width: $('tw-width'),
    preview: $('tw-preview'), trim: $('tw-trim'), range: $('tw-range'),
    start: $('tw-start'), end: $('tw-end'), startT: $('tw-start-t'), endT: $('tw-end-t'),
    photoHint: $('tw-photo-hint'),
    cardTheme: $('tw-card-theme'), showText: $('tw-show-text'), showDate: $('tw-show-date'), showVerified: $('tw-show-verified'),
    card: $('tw-card'), cardAvatar: $('card-avatar'), cardName: $('card-name'), cardVerified: $('card-verified'),
    cardHandle: $('card-handle'), cardText: $('card-text'), cardMedia: $('card-media'), cardDate: $('card-date'),
    cardOut: $('tw-card-out'),
  };

  let tweet = null;
  let selected = 0;
  let kind = 'media';
  let card = { theme: 'light', showText: true, showDate: true, showVerified: true };
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

  function defaultTitle() {
    const base = tweet.author.handle + '_' + tweet.tweetId;
    const suffix = kind === 'media' && tweet.media.length > 1 ? '_' + (selected + 1) : '';
    return base + suffix + (kind === 'card' ? '_card' : '');
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

  function renderCardPreview() {
    el.card.dataset.cardTheme = card.theme;
    setSeg(el.cardTheme, 'theme', card.theme);
    el.showText.checked = card.showText;
    el.showDate.checked = card.showDate;
    el.showVerified.checked = card.showVerified;

    const { author, text, createdAt } = tweet;
    el.cardAvatar.src = author.avatarUrl || '';
    el.cardAvatar.classList.toggle('hidden', !author.avatarUrl);
    el.cardName.textContent = author.name;
    el.cardHandle.textContent = '@' + author.handle;
    el.cardVerified.classList.toggle('hidden', !(author.verified && card.showVerified));
    el.cardText.textContent = text;
    el.cardText.classList.toggle('hidden', !(card.showText && text));

    const item = currentItem();
    el.cardMedia.classList.toggle('hidden', !item);
    if (item) {
      el.cardMedia.src = item.thumbnail || '';
      el.cardMedia.style.aspectRatio = item.width && item.height ? String(Math.max(item.width / item.height, 0.8)) : '16 / 9';
    }

    const date = createdAt && new Date(createdAt);
    const showDate = card.showDate && date && !isNaN(date);
    el.cardDate.classList.toggle('hidden', !showDate);
    if (showDate) {
      el.cardDate.textContent = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' · ' +
        date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    el.cardOut.textContent = !item ? 'Saved as a PNG image (text only).'
      : isVideo(item) ? 'Saved as an MP4 video with the card around it.'
        : 'Saved as a PNG image' + (tweet.media.filter((m) => m.type === 'photo').length > 1 ? ' (up to 4 photos).' : '.');
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
      el.photoHint.classList.toggle('hidden', video);
      el.gifOpts.classList.toggle('hidden', !gifOpen);
    }
    // The card preview already shows author and text, and the GIF options need the room.
    el.author.classList.toggle('hidden', kind === 'card');
    el.text.classList.toggle('hidden', !tweet.text || kind !== 'media' || gifOpen);
    if (kind === 'card') renderCardPreview();
  }

  // Rebuilds everything that depends on which media item is selected.
  function selectMedia(index) {
    selected = index;
    const item = currentItem();
    el.strip.querySelectorAll('.tw-thumb').forEach((btn, i) => btn.classList.toggle('is-selected', i === index));

    if (isVideo(item)) {
      fillSelect(el.quality, (item.qualities || []).map((q) => q.height), (h) => {
        const q = item.qualities.find((x) => x.height === h);
        const size = formatBytes(q.estimated_bytes);
        return h + 'p' + (size ? ' · ' + size : '');
      });
      if (!el.quality.options.length) fillSelect(el.quality, [''], () => 'best available');

      const widths = WIDTH_OPTIONS.filter((w) => !item.width || w < item.width);
      fillSelect(el.width, ['', ...widths], (w) => (w ? w + ' px' : 'Original'), widths.includes(480) ? 480 : '');

      const duration = item.duration || 0;
      el.end.max = el.start.max = duration || 1;
      el.trim.classList.toggle('hidden', !duration);
      el.preview.classList.toggle('hidden', !item.previewUrl);
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
    el.strip.classList.toggle('hidden', tweet.media.length < 2);
    tweet.media.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tw-thumb';
      btn.title = m.type === 'photo' ? 'Photo ' + (i + 1) : m.type === 'animated_gif' ? 'GIF ' + (i + 1) : 'Video ' + (i + 1);
      const img = document.createElement('img');
      img.alt = '';
      img.src = m.thumbnail || '';
      btn.append(img, textNode('span', 'tw-badge', m.type === 'photo' ? 'IMG' : m.type === 'animated_gif' ? 'GIF' : 'VID'));
      btn.addEventListener('click', () => selectMedia(i));
      el.strip.appendChild(btn);
    });
  }

  function populate() {
    const { author, text } = tweet;
    el.avatar.src = author.avatarUrl || '';
    el.avatar.classList.toggle('hidden', !author.avatarUrl);
    el.name.textContent = author.name;
    el.verified.classList.toggle('hidden', !author.verified);
    el.handle.textContent = '@' + author.handle;
    el.text.textContent = text;
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

  el.cardTheme.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (!tab) return;
    card.theme = tab.dataset.theme;
    savePrefs();
    renderCardPreview();
  });

  [['showText', el.showText], ['showDate', el.showDate], ['showVerified', el.showVerified]].forEach(([key, box]) => {
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
    accepts: (url) => TWEET_URL_RE.test(url),
    hint: 'Open a tweet (x.com/…/status/…) to use this tab.',
    loadingText: 'Loading tweet…',
    load: (url) => Promise.all([
      browser.storage.local.get(['twKind', 'twCard']),
      send({ type: 'getTweet', url }),
    ]).then(([stored, info]) => {
      kind = stored.twKind === 'card' ? 'card' : 'media';
      card = Object.assign(card, stored.twCard);
      tweet = info;
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
          gif: {
            fps: Number(el.fps.value),
            speed: Number(el.speed.value),
            width: Number(el.width.value) || null,
            start: trim.start,
            end: trim.end || null,
          },
          card: Object.assign({}, card),
        },
      };
    },
  };
})();
