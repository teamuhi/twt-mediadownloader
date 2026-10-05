// Shared popup logic: tab switching, job/progress + error rendering, settings
// and theme. The YouTube and Twitter panels live in youtube.js / twitter.js and
// plug in through the `panels` registry below.

const HTTP_URL_RE = /^https?:\/\//i;
const TWEET_URL_RE = /^https?:\/\/(?:[\w-]+\.)?(?:x|twitter)\.com\/(?:[^/?#]+|i\/web)\/status(?:es)?\/\d+/i;

const $ = (id) => document.getElementById(id);

const downloadBtn = $('download');
const downloadToBtn = $('download-to');
const actionsEl = $('actions');
const progressWrap = $('progress-wrap');
const progressBar = $('progress-bar');
const progressText = $('progress-text');
const jobErrorEl = $('job-error');

let currentTabUrlValue = null;
let activeTab = 'youtube';
let lastJob = null;

// name -> { el, accepts(url), hint, loadingText, load(url) -> Promise, payload() -> {...},
//           state: undefined | 'loading' | 'ready' | 'error' | 'unsupported' }
const panels = {};

// ---------------------------------------------------------------- helpers

// Background replies { ok: false, error, errorCode, errorHint, errorDetail }
// on failure (both browsers); turn that into a thrown error carrying the code.
class AppError extends Error {
  constructor(res) {
    super(res.error);
    this.code = res.errorCode;
    this.hint = res.errorHint;
    this.detail = res.errorDetail;
  }
}

function send(message) {
  return browser.runtime.sendMessage(message).then((res) => {
    if (res && res.ok === false) throw new AppError(res);
    return res;
  });
}

function currentTabUrl() {
  return browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0].url);
}

function formatBytes(bytes) {
  if (bytes == null) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(i === 0 ? 0 : (n < 10 ? 1 : 0)) + ' ' + units[i];
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

// err: { code, message, hint, detail }. Built with textContent only, since
// message/detail can echo page or server text.
function fillError(el, err) {
  el.replaceChildren();
  if (err.code) el.append(textNode('span', 'err-code', err.code));
  el.append(textNode('div', 'err-msg', err.message));
  if (err.hint) el.append(textNode('div', 'err-hint', err.hint));
  if (err.detail && err.detail !== err.message) {
    const details = document.createElement('details');
    details.append(textNode('summary', '', 'Details'), textNode('pre', '', err.detail));
    el.append(details);
  }
  el.classList.remove('hidden');
}

function panelMessage(name, text) {
  const el = panels[name].el;
  el.querySelector('.msg').textContent = text;
  el.querySelector('.error-box').classList.add('hidden');
}

function panelError(name, err) {
  const el = panels[name].el;
  el.querySelector('.msg').textContent = '';
  fillError(el.querySelector('.error-box'), { code: err.code, message: err.message, hint: err.hint, detail: err.detail });
}

// Shown when the native host answers with an older payload than the popup expects.
function noteOutdatedHost(name, outdated) {
  panels[name].el.querySelector('.host-note').classList.toggle('hidden', !outdated);
}

function noteYtdlp(info) {
  if (!info || !info.version) return;
  const age = info.age_days != null ? ' (' + info.age_days + ' days old)' : '';
  const el = $('ytdlp-info');
  el.textContent = 'yt-dlp ' + info.version + age;
  el.classList.toggle('is-stale', info.age_days != null && info.age_days > 90);
}

// ------------------------------------------------------------------ tabs

// Reflects the selected output in the footer button, the hint under it and the
// filename extension badge. Panels expose output() -> { label, ext, hint }.
function refreshOutput() {
  const panel = panels[activeTab];
  const out = panel && panel.state === 'ready' && panel.output ? panel.output() : null;
  $('download-label').textContent = out ? 'Download ' + out.label : 'Download';
  $('action-hint').textContent = out && out.hint ? out.hint : '';
  if (panel && panel.extEl) panel.extEl.textContent = out ? out.ext : '';
}

function syncActions() {
  const panel = panels[activeTab];
  actionsEl.classList.toggle('hidden', panel.state !== 'ready');
  const busy = lastJob && lastJob.status !== 'finished' && lastJob.status !== 'error';
  downloadBtn.disabled = !!busy;
  downloadToBtn.disabled = !!busy;
  refreshOutput();
}

function loadPanel(name) {
  const panel = panels[name];
  if (panel.state) return;
  if (!panel.accepts(currentTabUrlValue)) {
    panel.state = 'unsupported';
    panelMessage(name, panel.hint);
    return;
  }
  panel.state = 'loading';
  panelMessage(name, panel.loadingText);
  panel.load(currentTabUrlValue)
    .then(() => {
      panel.state = 'ready';
      panelMessage(name, '');
      syncActions();
    })
    .catch((err) => {
      panel.state = 'error';
      panelError(name, err);
      syncActions();
    });
}

function selectTab(name) {
  activeTab = name;
  document.body.dataset.tab = name; // the Twitter tab gets a wider popup
  document.querySelectorAll('#tabs [role="tab"]').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  });
  for (const key in panels) panels[key].el.classList.toggle('hidden', key !== name);
  loadPanel(name);
  renderJob(lastJob);
}

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[role="tab"]');
  if (tab) selectTab(tab.dataset.tab);
});

// -------------------------------------------------------------- job / UI

function renderJob(job) {
  lastJob = job || null;
  const show = !!job && (job.source || 'youtube') === activeTab;
  progressWrap.classList.toggle('hidden', !show);
  syncActions();
  if (!show) return;

  const percent = job.percent || 0;
  progressBar.style.transform = 'scaleX(' + (percent / 100) + ')';
  if (job.status === 'starting') {
    progressText.textContent = 'Starting…';
  } else if (job.status === 'downloading') {
    progressText.textContent = 'Downloading… ' + percent + '%';
  } else if (job.status === 'converting') {
    progressText.textContent = 'Converting…' + (job.source === 'twitter' ? ' ' + percent + '%' : '');
  } else if (job.status === 'tagging') {
    progressText.textContent = 'Writing tags…';
  } else if (job.status === 'rendering') {
    progressText.textContent = 'Rendering card… ' + percent + '%';
  } else if (job.status === 'finished') {
    progressText.textContent = 'Saved as ' + job.filename + (job.warning ? '\n' + job.warning : '');
  } else if (job.status === 'error') {
    progressText.textContent = 'Failed';
  }
  progressWrap.classList.toggle('is-success', job.status === 'finished');
  progressWrap.classList.toggle('is-error', job.status === 'error');
  if (job.status === 'error') {
    fillError(jobErrorEl, { code: job.errorCode, message: job.error, hint: job.errorHint, detail: job.errorDetail });
  } else {
    jobErrorEl.classList.add('hidden');
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'jobUpdate' && message.tabUrl === currentTabUrlValue) {
    renderJob(message.job);
  }
});

function startDownload(downloadDir) {
  const url = currentTabUrlValue;
  renderJob({ status: 'starting', percent: 0, source: activeTab });
  const payload = Object.assign({ type: 'startDownload', tabUrl: url, url, source: activeTab }, panels[activeTab].payload());
  if (downloadDir) payload.downloadDir = downloadDir;
  send(payload).catch((err) => renderJob({ status: 'error', error: err.message, source: activeTab }));
}

function startDownloadTo() {
  downloadToBtn.disabled = true;
  send({ type: 'browseFolder', source: activeTab })
    .then((res) => {
      syncActions();
      if (res && res.path) startDownload(res.path);
    })
    .catch((err) => {
      renderJob({ status: 'error', error: 'Could not open folder picker: ' + err.message, source: activeTab });
    });
}

downloadBtn.addEventListener('click', () => startDownload());
downloadToBtn.addEventListener('click', startDownloadTo);

// --------------------------------------------------------------- settings

const settingsToggleBtn = $('settings-toggle');
const settingsPanel = $('settings-panel');
const mainEl = $('main');
const saveSettingsBtn = $('save-settings');
const settingsStatusEl = $('settings-status');
const useXLoginEl = $('use-x-login');

// One save location per tab. `key` is the field name in the host's config
// messages; `loaded` is the last value the host reported, so Save is only
// enabled for edited fields and only those are sent (an untouched Twitter
// field that is inheriting the YouTube path must not get pinned to it).
const dirFields = {
  youtube: { input: $('download-dir'), browse: $('browse-dir'), key: 'downloadDir', loaded: '' },
  twitter: { input: $('twitter-dir'), browse: $('browse-twitter-dir'), key: 'twitterDownloadDir', loaded: '' },
};

function setSettingsStatus(text) {
  settingsStatusEl.textContent = text;
}

function isDirDirty(field) {
  return field.input.value.trim() !== field.loaded;
}

function updateSaveButtonState() {
  saveSettingsBtn.disabled = !Object.values(dirFields).some(isDirDirty);
}

function applyConfig(res) {
  for (const field of Object.values(dirFields)) {
    field.loaded = res[field.key] || '';
    field.input.value = field.loaded;
  }
  updateSaveButtonState();
}

function loadSettings() {
  setSettingsStatus('Loading…');
  send({ type: 'getConfig' })
    .then((res) => {
      applyConfig(res);
      setSettingsStatus('');
    })
    .catch((err) => {
      setSettingsStatus('Error: ' + err.message);
    });
  browser.storage.local.get('useXLogin').then((stored) => {
    useXLoginEl.checked = stored.useXLogin !== false;
  });
}

function saveSettings() {
  const config = {};
  for (const field of Object.values(dirFields)) {
    if (isDirDirty(field)) config[field.key] = field.input.value.trim();
  }
  setSettingsStatus('Saving…');
  send({ type: 'setConfig', config })
    .then((res) => {
      applyConfig(res);
      setSettingsStatus('Saved');
      setTimeout(() => setSettingsStatus(''), 1500);
    })
    .catch((err) => {
      setSettingsStatus('Error: ' + err.message);
    });
}

Object.values(dirFields).forEach((field) => field.input.addEventListener('input', updateSaveButtonState));
useXLoginEl.addEventListener('change', () => browser.storage.local.set({ useXLogin: useXLoginEl.checked }));

// Matches --duration-base in popup.css. The settings panel and the main UI
// are tall enough together to push the popup past the browser's max popup
// height, so they're shown one at a time; sequencing the fade avoids both
// being laid out at once.
const PANEL_FADE_MS = 150;

settingsToggleBtn.addEventListener('click', () => {
  const opening = settingsPanel.classList.contains('hidden');
  $('app').classList.toggle('settings-open', opening);
  settingsToggleBtn.setAttribute('aria-pressed', String(opening));
  settingsToggleBtn.title = opening ? 'Close settings' : 'Settings';
  if (opening) {
    loadSettings();
    mainEl.classList.add('hidden');
    setTimeout(() => settingsPanel.classList.remove('hidden'), PANEL_FADE_MS);
  } else {
    settingsPanel.classList.add('hidden');
    setTimeout(() => mainEl.classList.remove('hidden'), PANEL_FADE_MS);
  }
});

saveSettingsBtn.addEventListener('click', saveSettings);

Object.entries(dirFields).forEach(([name, field]) => {
  field.browse.addEventListener('click', () => {
    field.browse.disabled = true;
    setSettingsStatus('Choose a folder…');
    send({ type: 'browseFolder', source: name })
      .then((res) => {
        field.browse.disabled = false;
        if (res && res.path) {
          field.input.value = res.path;
          saveSettings(); // auto-save: a picked folder is already a deliberate choice
        } else {
          setSettingsStatus(''); // user cancelled the dialog
        }
      })
      .catch((err) => {
        field.browse.disabled = false;
        setSettingsStatus('Error: ' + err.message);
      });
  });
});

// ------------------------------------------------------------------ theme

const themeToggleBtn = $('theme-toggle');
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  themeToggleBtn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

themeToggleBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  browser.storage.local.set({ theme: next });
});

// ------------------------------------------------------------------- init

function init() {
  browser.storage.local.get('theme').then((stored) => {
    applyTheme(stored.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  });

  currentTabUrl().then((url) => {
    currentTabUrlValue = url;
    send({ type: 'getJob', tabUrl: url }).then((job) => {
      if (job) lastJob = job;
      // A tweet link opens on the Twitter tab; anything else on YouTube.
      selectTab(TWEET_URL_RE.test(url) ? 'twitter' : 'youtube');
    });
  });
}

// twitter.js registers panels.twitter at script load; init runs after both.
document.addEventListener('DOMContentLoaded', init);
