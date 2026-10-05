// YouTube (and any other yt-dlp site) panel: video download with a resolution
// picker, and a music-style audio download with format choice, automatic
// tags + cover art and an optional metadata editor. Registers itself into
// popup.js's `panels` registry.

(() => {
  const META_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'date', 'track', 'genre'];
  const COVER_MAX_PX = 1200;
  // Rough size of lossless output relative to uncompressed 16-bit/44.1 kHz stereo PCM.
  const LOSSLESS_RATIO = { wav: 1, flac: 0.55, alac: 0.6 };
  const FALLBACK_BEST_KBPS = { mp3: 192, m4a: 128, opus: 128, ogg: 160 };

  const el = {
    kind: $('yt-kind'), video: $('yt-video'), audio: $('yt-audio'), thumb: $('thumb'), mp4Quality: $('mp4-quality'),
    hero: $('yt-hero'), duration: $('yt-duration'), vTitle: $('yt-vtitle'), vChannel: $('yt-vchannel'),
    title: $('title'), ext: $('yt-ext'),
    cover: $('yt-cover'), coverEmpty: $('yt-cover-empty'), mcTitle: $('mc-title'), mcArtist: $('mc-artist'), mcAlbum: $('mc-album'), mcBadge: $('mc-badge'),
    afmt: $('yt-afmt'), aqRow: $('yt-aq-row'), aquality: $('yt-aquality'),
    tags: $('yt-tags'), square: $('yt-square'), squareRow: $('yt-square-row'), edit: $('yt-edit'), editRow: $('yt-edit-row'),
    form: $('yt-meta-form'), coverFile: $('yt-cover-file'),
  };
  const fields = Object.fromEntries(META_FIELDS.map((k) => [k, $('mf-' + k)]));

  let info = null;
  let kind = 'video';
  let prefs = { format: 'mp3', quality: 'best', tags: true, square: true };
  let cover = { source: 'thumbnail', dataUrl: '' };

  const formats = () => info.audio_formats || [];
  const currentFormat = () => formats().find((f) => f.id === prefs.format) || formats()[0];
  const isLossy = (f) => f && f.qualities.length > 0;

  function savePrefs() {
    browser.storage.local.set({ ytKind: kind, ytAudio: prefs });
  }

  // ------------------------------------------------------------- metadata

  // What the file will carry: the editor's values while it is open, else the automatic ones.
  function liveMeta() {
    if (!el.edit.checked) return info.meta;
    return Object.assign({}, info.meta, Object.fromEntries(META_FIELDS.map((k) => [k, fields[k].value.trim()])));
  }

  function fillFields() {
    META_FIELDS.forEach((k) => { fields[k].value = info.meta[k] || ''; });
  }

  function estimateBytes(fmt, quality) {
    const duration = info.duration;
    if (!duration) return null;
    if (!isLossy(fmt)) return duration * 176400 * (LOSSLESS_RATIO[fmt.id] || 1);
    const kbps = quality === 'best' ? (info.best_audio_kbps || FALLBACK_BEST_KBPS[fmt.id]) : Number(quality);
    return duration * kbps * 125; // kbps * 1000 / 8
  }

  function audioName() {
    const m = liveMeta();
    return m.artist && m.title ? m.artist + ' - ' + m.title : m.title || info.title || '';
  }

  // ------------------------------------------------------------- rendering

  function renderCover() {
    const url = cover.source === 'custom' ? cover.dataUrl : cover.source === 'thumbnail' ? info.thumbnail : '';
    const embedding = el.tags.checked;
    const shown = !!url && embedding;
    el.cover.classList.toggle('hidden', !shown);
    el.coverEmpty.classList.toggle('hidden', shown);
    el.coverEmpty.textContent = embedding ? 'No cover' : 'Not embedded';
    if (shown && el.cover.getAttribute('src') !== url) el.cover.src = url;
    el.cover.classList.toggle('is-contain', !el.square.checked);
  }

  function renderCard() {
    const m = liveMeta();
    const fmt = currentFormat();
    el.mcTitle.textContent = m.title || info.title || 'Untitled';
    el.mcArtist.textContent = el.tags.checked ? (m.artist || 'Unknown artist') : 'Tags off';
    el.mcAlbum.textContent = el.tags.checked ? [m.album, (m.date || '').slice(0, 4)].filter(Boolean).join(' · ') : '';
    el.mcBadge.textContent = fmt ? fmt.label + (isLossy(fmt) && el.aquality.value ? ' · ' + qualityName(el.aquality.value, fmt) : '') : '';
    el.title.placeholder = kind === 'audio' ? audioName() : info.title || '';
  }

  function qualityName(q, fmt) {
    return q === 'best' ? (fmt.id === 'mp3' ? 'Best (VBR)' : 'Best') : q + ' kbps';
  }

  function renderQualities() {
    const fmt = currentFormat();
    el.aqRow.classList.toggle('hidden', !isLossy(fmt));
    if (!isLossy(fmt)) return;
    el.aquality.innerHTML = '';
    fmt.qualities.forEach((q) => {
      const opt = document.createElement('option');
      opt.value = q;
      const size = formatBytes(estimateBytes(fmt, q));
      opt.textContent = qualityName(q, fmt) + (size ? ' · ~' + size : '');
      el.aquality.appendChild(opt);
    });
    el.aquality.value = fmt.qualities.includes(prefs.quality) ? prefs.quality : 'best';
  }

  function renderFormats() {
    el.afmt.innerHTML = '';
    formats().forEach((f) => {
      const label = document.createElement('label');
      label.className = 'fmt-card';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'afmt';
      input.value = f.id;
      input.checked = f.id === currentFormat().id;
      label.append(input, textNode('span', 'fmt-name', f.label), textNode('span', 'fmt-sub', f.sub));
      el.afmt.appendChild(label);
    });
  }

  function render() {
    setKind();
    el.editRow.classList.toggle('hidden', !el.tags.checked);
    el.squareRow.classList.toggle('hidden', !el.tags.checked);
    el.form.classList.toggle('hidden', !(el.tags.checked && el.edit.checked));
    renderCover();
    renderCard();
    refreshOutput();
  }

  function setKind() {
    el.kind.querySelectorAll('[role="tab"]').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.kind === kind));
    });
    el.video.classList.toggle('hidden', kind !== 'video');
    el.audio.classList.toggle('hidden', kind !== 'audio');
  }

  function formatDuration(seconds) {
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? h + ':' + pad(m) + ':' + pad(s % 60) : m + ':' + pad(s % 60);
  }

  function populate(data) {
    // An older native host sends neither tags nor audio formats; keep the panel usable.
    const outdated = !data.audio_formats || !data.meta;
    info = Object.assign({ audio_formats: [], meta: { title: data.title || '' } }, data);
    noteOutdatedHost('youtube', outdated);
    el.title.value = '';
    el.hero.classList.toggle('hidden', !info.thumbnail);
    if (info.thumbnail) el.thumb.src = info.thumbnail;
    el.duration.textContent = info.duration ? formatDuration(info.duration) : '';
    el.duration.classList.toggle('hidden', !info.duration);
    el.vTitle.textContent = info.title || '';
    el.vChannel.textContent = info.channel || '';

    el.mp4Quality.innerHTML = '';
    (info.video_qualities || []).forEach((q) => {
      const opt = document.createElement('option');
      opt.value = q.height;
      const size = formatBytes(q.estimated_bytes);
      opt.textContent = q.height + 'p' + (size ? ' · ' + size : '');
      el.mp4Quality.appendChild(opt);
    });
    if (el.mp4Quality.options.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'no video streams found';
      el.mp4Quality.appendChild(opt);
    }

    // Without an audio-capable ffmpeg there is nothing to offer under Audio.
    const audioTab = el.kind.querySelector('[data-kind="audio"]');
    audioTab.disabled = !formats().length;
    audioTab.title = formats().length ? '' : outdated ? 'Update the nickel.tools native host to enable audio' : 'Audio needs an ffmpeg build with audio encoders';
    if (!formats().length) kind = 'video';
    if (formats().length) {
      prefs.format = (formats().find((f) => f.id === prefs.format) || formats()[0]).id;
      el.tags.checked = prefs.tags;
      el.square.checked = prefs.square;
      el.edit.checked = false;
      cover = { source: 'thumbnail', dataUrl: '' };
      fillFields();
      renderFormats();
      renderQualities();
    }
    noteYtdlp(info.ytdlp);
    $('video-info').classList.remove('hidden');
    render();
  }

  // ------------------------------------------------------------- output

  function output() {
    if (kind === 'video') return { label: 'MP4', ext: '.mp4', hint: 'Video with audio.' };
    const fmt = currentFormat();
    const bytes = !isLossy(fmt) ? estimateBytes(fmt) : null;
    const size = bytes ? '~' + formatBytes(bytes) : '';
    const tagNote = !el.tags.checked ? 'No tags.' : fmt.id === 'wav' ? 'Tag support for WAV varies by player.' : 'Tagged with title, artist & cover.';
    return { label: fmt.label, ext: '.' + fmt.ext, hint: [size, tagNote].filter(Boolean).join(' · ') };
  }

  // ------------------------------------------------------------- cover

  // Any picked image is re-encoded as a JPEG of at most COVER_MAX_PX before it is sent to the host.
  function loadCoverFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, COVER_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      cover = { source: 'custom', dataUrl: canvas.toDataURL('image/jpeg', 0.9) };
      URL.revokeObjectURL(url);
      render();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  // ------------------------------------------------------------- listeners

  el.kind.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (!tab || tab.disabled) return;
    kind = tab.dataset.kind;
    savePrefs();
    render();
  });

  el.afmt.addEventListener('change', (e) => {
    prefs.format = e.target.value;
    savePrefs();
    renderQualities();
    render();
  });

  el.aquality.addEventListener('change', () => {
    prefs.quality = el.aquality.value;
    savePrefs();
    render();
  });

  [['tags', el.tags], ['square', el.square]].forEach(([key, box]) => {
    box.addEventListener('change', () => {
      prefs[key] = box.checked;
      savePrefs();
      render();
    });
  });

  el.edit.addEventListener('change', render);
  Object.values(fields).forEach((input) => input.addEventListener('input', () => { renderCard(); }));
  $('yt-meta-reset').addEventListener('click', () => { fillFields(); cover = { source: 'thumbnail', dataUrl: '' }; render(); });
  $('yt-cover-replace').addEventListener('click', () => el.coverFile.click());
  $('yt-cover-reset').addEventListener('click', () => { cover = { source: 'thumbnail', dataUrl: '' }; render(); });
  $('yt-cover-none').addEventListener('click', () => { cover = { source: 'none', dataUrl: '' }; render(); });
  el.coverFile.addEventListener('change', () => { loadCoverFile(el.coverFile.files[0]); el.coverFile.value = ''; });
  el.mp4Quality.addEventListener('change', refreshOutput);

  // ------------------------------------------------------------- registry

  panels.youtube = {
    el: $('yt-panel'),
    extEl: el.ext,
    output,
    accepts: (url) => HTTP_URL_RE.test(url) && !X_HOST_RE.test(url),
    hint: (url) => (X_HOST_RE.test(url)
      ? 'On X, open a tweet and use the X / Twitter tab.'
      : 'Open a web page with a video or audio to download it.'),
    loadingText: 'Loading media info…',
    load: (url) => Promise.all([
      browser.storage.local.get(['ytKind', 'ytAudio']),
      send({ type: 'getFormats', url }),
    ]).then(([stored, data]) => {
      kind = stored.ytKind === 'audio' ? 'audio' : 'video';
      prefs = Object.assign(prefs, stored.ytAudio);
      populate(data);
    }),
    payload() {
      const title = el.title.value.trim() || el.title.placeholder;
      if (kind === 'video') return { mode: 'mp4', quality: el.mp4Quality.value, title };
      const fmt = currentFormat();
      const quality = isLossy(fmt) ? el.aquality.value : undefined;
      const tags = el.tags.checked;
      return {
        mode: 'audio',
        quality,
        title,
        audio: {
          format: fmt.id,
          quality,
          tags,
          meta: tags && el.edit.checked ? liveMeta() : null,
          cover: { source: cover.source, square: el.square.checked, dataUrl: cover.source === 'custom' ? cover.dataUrl : '' },
        },
      };
    },
  };
})();
