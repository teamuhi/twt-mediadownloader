// Web panel: lists the images, video, audio and embedded players found on the
// current page (scan.js runs in the page via the background script) and
// downloads the ticked ones. Registers itself into popup.js's `panels` registry.

(() => {
  const KIND_LABELS = { image: 'Images', video: 'Video', audio: 'Audio', embed: 'Embeds' };
  const KIND_GLYPHS = { image: '', video: '▶', audio: '♪', embed: '⧉' };
  const MIN_SIZES = [[0, 'Any size'], [200, '200px+'], [500, '500px+'], [1000, '1000px+']];

  const el = {
    content: $('web-content'), kinds: $('web-kinds'), min: $('web-min'), all: $('web-all'),
    count: $('web-count'), grid: $('web-grid'), subfolder: $('web-subfolder'),
    convert: $('web-convert'), convertRow: $('web-convert-row'),
    convertVideo: $('web-convert-video'), convertVideoRow: $('web-convert-video-row'),
  };
  const IMAGE_LABELS = { png: 'PNG', jpg: 'JPG', webp: 'WebP', gif: 'GIF', bmp: 'BMP', tiff: 'TIFF', avif: 'AVIF' };
  const VIDEO_LABELS = { mp4: 'MP4', webm: 'WebM', mkv: 'MKV', mov: 'MOV', avi: 'AVI', gif: 'GIF' };

  let page = { title: '', url: '', items: [] };
  let selected = new Set();
  let filter = { kind: 'all', min: 0 };

  function savePrefs() {
    browser.storage.local.set({
      webSubfolder: el.subfolder.checked, webMin: filter.min, webConvert: el.convert.value, webConvertVideo: el.convertVideo.value,
    });
  }

  const isVisible = (item) => (filter.kind === 'all' || item.kind === filter.kind)
    && !(item.kind === 'image' && filter.min && item.w && item.h && Math.max(item.w, item.h) < filter.min);
  const visibleItems = () => page.items.filter(isVisible);
  const chosen = () => visibleItems().filter((item) => selected.has(item.url));
  const isVideoLike = (item) => item.kind === 'video' || item.kind === 'embed';

  // ------------------------------------------------------------- rendering

  function renderKinds() {
    el.kinds.replaceChildren();
    const counts = { all: page.items.length };
    page.items.forEach((item) => { counts[item.kind] = (counts[item.kind] || 0) + 1; });
    ['all', ...Object.keys(KIND_LABELS)].filter((k) => counts[k]).forEach((k) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.dataset.kind = k;
      btn.setAttribute('aria-selected', String(k === filter.kind));
      btn.textContent = (k === 'all' ? 'All' : KIND_LABELS[k]) + ' ' + counts[k];
      el.kinds.append(btn);
    });
  }

  function makeCell(item) {
    const label = document.createElement('label');
    label.className = 'web-cell' + (selected.has(item.url) ? ' is-checked' : '');
    label.title = item.name;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(item.url);
    box.dataset.url = item.url;

    const thumb = document.createElement('span');
    thumb.className = 'web-thumb';
    const picture = item.kind === 'image' ? item.url : item.poster;
    if (picture) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = picture;
      img.addEventListener('error', () => img.remove());
      thumb.append(img);
    }
    thumb.append(textNode('span', 'web-glyph', KIND_GLYPHS[item.kind]));

    const meta = document.createElement('span');
    meta.className = 'web-meta';
    meta.append(
      textNode('span', 'web-kind', item.kind),
      textNode('span', 'web-dim', item.w && item.h ? item.w + '×' + item.h : ''),
    );
    label.append(box, thumb, meta, textNode('span', 'web-name', item.name));
    return label;
  }

  function renderGrid() {
    el.grid.replaceChildren(...visibleItems().map(makeCell));
    renderCount();
  }

  function renderCount() {
    const visible = visibleItems();
    const n = chosen().length;
    el.count.textContent = n + ' of ' + visible.length + ' selected';
    el.all.checked = visible.length > 0 && n === visible.length;
    el.all.indeterminate = n > 0 && n < visible.length;
    refreshOutput();
    syncActions();
  }

  // ------------------------------------------------------------- listeners

  el.kinds.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (!tab) return;
    filter.kind = tab.dataset.kind;
    renderKinds();
    renderGrid();
  });

  el.min.addEventListener('change', () => {
    filter.min = Number(el.min.value);
    savePrefs();
    renderGrid();
  });

  el.all.addEventListener('change', () => {
    visibleItems().forEach((item) => (el.all.checked ? selected.add(item.url) : selected.delete(item.url)));
    renderGrid();
  });

  el.grid.addEventListener('change', (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    if (box.checked) selected.add(box.dataset.url); else selected.delete(box.dataset.url);
    box.closest('.web-cell').classList.toggle('is-checked', box.checked);
    renderCount();
  });

  el.subfolder.addEventListener('change', savePrefs);
  [el.convert, el.convertVideo].forEach((select) => select.addEventListener('change', () => {
    savePrefs();
    refreshOutput();
  }));

  // ------------------------------------------------------------- registry

  function populate(data, stored) {
    page = { title: data.title || '', url: data.url || '', items: data.items || [] };
    filter = { kind: 'all', min: MIN_SIZES.some(([px]) => px === stored.webMin) ? stored.webMin : 0 };
    selected = new Set(); // nothing is pre-selected; the user picks what to download
    el.subfolder.checked = stored.webSubfolder === true;
    el.convert.value = IMAGE_LABELS[stored.webConvert] ? stored.webConvert : '';
    el.convertVideo.value = VIDEO_LABELS[stored.webConvertVideo] ? stored.webConvertVideo : '';
    el.convertRow.classList.toggle('hidden', !page.items.some((item) => item.kind === 'image'));
    el.convertVideoRow.classList.toggle('hidden', !page.items.some(isVideoLike));
    el.min.replaceChildren(...MIN_SIZES.map(([px, text]) => {
      const opt = document.createElement('option');
      opt.value = px;
      opt.textContent = text;
      return opt;
    }));
    el.min.value = filter.min;
    renderKinds();
    renderGrid();
    el.content.classList.remove('hidden');
  }

  panels.web = {
    el: $('web-panel'),
    output: () => {
      const n = chosen().length;
      const picked = chosen();
      const notes = [];
      if (el.convert.value && picked.some((item) => item.kind === 'image')) notes.push('Images are converted to ' + IMAGE_LABELS[el.convert.value] + '.');
      if (el.convertVideo.value && picked.some(isVideoLike)) notes.push('Video is converted to ' + VIDEO_LABELS[el.convertVideo.value] + '.');
      return {
        label: n + (n === 1 ? ' item' : ' items'),
        ext: '',
        hint: notes.length ? notes.join(' ') : 'Saved to your Web save location.',
      };
    },
    canDownload: () => chosen().length > 0,
    accepts: (url) => HTTP_URL_RE.test(url) && !TWEET_URL_RE.test(url),
    hint: 'Open a web page to list its images, video and audio.',
    loadingText: 'Scanning page…',
    load: () => Promise.all([loadPrefs(['webSubfolder', 'webMin', 'webConvert', 'webConvertVideo']), send({ type: 'scanPage', tabId: currentTabId })])
      .then(([stored, data]) => {
        if (!data || !data.items || !data.items.length) {
          throw Object.assign(new Error('No media found on this page.'), {
            code: 'E_NO_MEDIA',
            hint: 'Some sites load images only as you scroll. Scroll the page, reopen this popup and try again.',
          });
        }
        populate(data, stored);
      }),
    payload: () => ({
      title: page.title,
      pageUrl: page.url,
      subfolder: el.subfolder.checked,
      convert: { image: el.convert.value || null, video: el.convertVideo.value || null },
      items: chosen().map(({ url, kind }) => ({ url, kind })),
    }),
  };
})();
