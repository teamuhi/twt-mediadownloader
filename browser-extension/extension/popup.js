// Shared popup logic: tab switching, job/progress + error rendering, settings
// and theme. The YouTube and Twitter panels live in youtube.js / twitter.js and
// plug in through the `panels` registry below. The Web panel lives in web.js.

const HTTP_URL_RE = /^https?:\/\//i;
const TWEET_URL_RE = /^https?:\/\/(?:[\w-]+\.)?(?:x|twitter)\.com\/(?:[^/?#]+|i\/web)\/status(?:es)?\/\d+/i;

const X_HOST_RE = /^https?:\/\/(?:[\w-]+\.)?(?:x|twitter)\.com\//i;

const $ = (id) => document.getElementById(id);

const downloadBtn = $('download');
const downloadToBtn = $('download-to');
const actionsEl = $('actions');
const progressWrap = $('progress-wrap');
const progressBar = $('progress-bar');
const progressText = $('progress-text');
const jobErrorEl = $('job-error');

let currentTabUrlValue = null;
let currentTabId = null;
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

// Like send(), for requests that must be answered. An empty reply means the
// background script doesn't know the message (a stale copy still running
// after an update), so say that instead of letting callers crash on undefined.
function request(message) {
  return send(message).then((res) => {
    if (res == null) {
      throw new Error('No reply from the extension background. Reload the extension (or restart the browser) and try again.');
    }
    return res;
  });
}

// Last-used options for a panel (storage.local), unless the user turned
// "Remember my last-used options" off in Settings.
async function loadPrefs(keys) {
  const { rememberOptions } = await browser.storage.local.get('rememberOptions');
  return rememberOptions === false ? {} : browser.storage.local.get(keys);
}

// The tab being downloaded from: the one the popup was opened on, or the one a
// detached window was opened for (?tabId=...).
const detachedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

function currentTab() {
  if (detachedTabId) return browser.tabs.get(detachedTabId);
  return browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);
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
  const blocked = !!busy || (panel.canDownload && !panel.canDownload());
  downloadBtn.disabled = blocked;
  downloadToBtn.disabled = blocked;
  refreshOutput();
}

const WEB_FALLBACK_CODES = ['E_UNSUPPORTED_URL', 'E_NO_MEDIA', 'E_EXTRACTOR_BROKEN', 'E_UNKNOWN'];
const YOUTUBE_HOST_RE = /^https?:\/\/(?:[\w-]+\.)?(?:youtube\.com|youtu\.be)\//i; // keep its yt-dlp error visible

function loadPanel(name) {
  const panel = panels[name];
  if (panel.state) return;
  if (!panel.accepts(currentTabUrlValue)) {
    panel.state = 'unsupported';
    panelMessage(name, typeof panel.hint === 'function' ? panel.hint(currentTabUrlValue) : panel.hint);
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
      // yt-dlp can't use this page (no video, or the site blocks/breaks its
      // extractor): the Web tab can still list its images and files.
      if (name === 'youtube' && WEB_FALLBACK_CODES.includes(err.code) && !YOUTUBE_HOST_RE.test(currentTabUrlValue) && activeTab === name && panels.web && panels.web.accepts(currentTabUrlValue)) {
        selectTab('web');
      }
    });
}

function selectTab(name) {
  activeTab = name;
  document.body.dataset.tab = name; // the Twitter and Web tabs get a wider popup
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
    progressText.textContent = 'Downloading' + (job.total > 1 ? ' ' + job.item + ' of ' + job.total : '') + '… ' + percent + '%';
  } else if (job.status === 'converting') {
    progressText.textContent = 'Converting' + (job.total > 1 ? ' ' + job.item + ' of ' + job.total : '') + '…' + (job.source === 'twitter' ? ' ' + percent + '%' : '');
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

function buildPayload(type) {
  const url = currentTabUrlValue;
  return Object.assign({ type, tabUrl: url, url, source: activeTab }, panels[activeTab].payload());
}

// `extra` merges into the request, e.g. { downloadDir } for a one-off folder.
function startDownload(extra) {
  renderJob({ status: 'starting', percent: 0, source: activeTab });
  send(Object.assign(buildPayload('startDownload'), extra)).catch((err) => renderJob({ status: 'error', error: err.message, source: activeTab }));
}

// The folder dialog steals focus, which closes the popup, so the background
// script owns the whole sequence (pick a folder, then start the job). If the
// popup is still open afterwards it just follows the job's updates.
function startDownloadTo() {
  downloadToBtn.disabled = true;
  send(buildPayload('startDownloadTo'))
    .then(() => syncActions())
    .catch((err) => {
      syncActions();
      renderJob({ status: 'error', error: 'Could not start the download: ' + err.message, source: activeTab });
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

// One save location per tab. `key` is the field name in the host's config
// messages; `loaded` is the last value the host reported, so Save is only
// enabled for edited fields and only those are sent (an untouched Twitter
// field that is inheriting the YouTube path must not get pinned to it).
const dirFields = {
  youtube: { input: $('download-dir'), browse: $('browse-dir'), key: 'downloadDir', loaded: '' },
  twitter: { input: $('twitter-dir'), browse: $('browse-twitter-dir'), key: 'twitterDownloadDir', loaded: '' },
  web: { input: $('web-dir'), browse: $('browse-web-dir'), key: 'webDownloadDir', loaded: '' },
};

// Toggles and selects in the Settings panel (`data-setting`) save straight to
// storage.local as they change; background.js reads the notification/badge ones.
const SETTING_DEFAULTS = {
  showBadge: true, notifyStart: true, notifyFinish: true, notifyError: true, autoReveal: false,
  rememberOptions: true, useXLogin: true,
  theme: 'system', defaultTab: 'auto',
};
const settingInputs = [...document.querySelectorAll('[data-setting]')];
const containerSeg = $('set-container');
const HISTORY_SHOWN = 5;

function setSettingsStatus(text) {
  settingsStatusEl.textContent = text;
}

function flashSettingsStatus(text) {
  setSettingsStatus(text);
  setTimeout(() => setSettingsStatus(''), 1500);
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

function renderSettingValues(stored) {
  settingInputs.forEach((input) => {
    const key = input.dataset.setting;
    const value = stored[key] != null ? stored[key] : SETTING_DEFAULTS[key];
    if (input.type === 'checkbox') input.checked = value !== false;
    else input.value = String(value);
  });
  const container = stored.defaultContainer || 'mp4';
  containerSeg.querySelectorAll('[data-container]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.container === container)));
}

function renderHistory(history) {
  const list = (history || []).slice(0, HISTORY_SHOWN);
  $('history-wrap').classList.toggle('hidden', !list.length);
  $('history-list').replaceChildren(...list.map((entry) => {
    const row = document.createElement('div');
    row.className = 'row';
    const title = textNode('span', 'row-text hist-title', entry.title || entry.filename || 'Saved');
    title.title = entry.path || '';
    const show = textNode('button', 'mini-btn mini-btn-fit', 'Show');
    show.type = 'button';
    show.disabled = !entry.path;
    show.addEventListener('click', () => send({ type: 'revealFile', path: entry.path }).catch((err) => flashSettingsStatus('Error: ' + err.message)));
    row.append(title, show);
    return row;
  }));
}

function loadSettings() {
  setSettingsStatus('Loading…');
  request({ type: 'getConfig' })
    .then((res) => {
      applyConfig(res);
      $('about-info').textContent = 'nickel.tools ' + browser.runtime.getManifest().version + ' · '
        + (res.hostVersion ? 'host ' + res.hostVersion : 'host outdated (reinstall nickel.tools to update it)');
      noteYtdlp(res.ytdlp);
      setSettingsStatus('');
    })
    .catch((err) => {
      setSettingsStatus('Error: ' + err.message);
    });
  browser.storage.local.get([...Object.keys(SETTING_DEFAULTS), 'defaultContainer', 'history']).then((stored) => {
    renderSettingValues(stored);
    renderHistory(stored.history);
  });
}

function saveSettings() {
  const config = {};
  for (const field of Object.values(dirFields)) {
    if (isDirDirty(field)) config[field.key] = field.input.value.trim();
  }
  setSettingsStatus('Saving…');
  request({ type: 'setConfig', config })
    .then((res) => {
      applyConfig(res);
      flashSettingsStatus('Saved');
    })
    .catch((err) => {
      setSettingsStatus('Error: ' + err.message);
    });
}

Object.values(dirFields).forEach((field) => field.input.addEventListener('input', updateSaveButtonState));

settingInputs.forEach((input) => {
  input.addEventListener('change', () => {
    const key = input.dataset.setting;
    let value = input.type === 'checkbox' ? input.checked : input.value;
    browser.storage.local.set({ [key]: value });
    if (key === 'theme') applyThemePref(value);
  });
});

containerSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-container]');
  if (!btn) return;
  browser.storage.local.set({ defaultContainer: btn.dataset.container });
  containerSeg.querySelectorAll('[data-container]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
});

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

// The background script picks the folder and saves it (the popup may close
// while the dialog is open); if we are still here, show the stored result.
Object.entries(dirFields).forEach(([name, field]) => {
  field.browse.addEventListener('click', () => {
    field.browse.disabled = true;
    setSettingsStatus('Choose a folder…');
    request({ type: 'pickDir', source: name })
      .then((res) => {
        field.browse.disabled = false;
        if (res && res.cancelled) {
          setSettingsStatus(''); // user cancelled the dialog
          return;
        }
        applyConfig(res);
        flashSettingsStatus('Saved');
      })
      .catch((err) => {
        field.browse.disabled = false;
        setSettingsStatus('Error: ' + err.message);
      });
  });
});

document.querySelectorAll('[data-open]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const field = dirFields[btn.dataset.open];
    send({ type: 'openPath', source: btn.dataset.open, path: field.input.value.trim() })
      .catch((err) => setSettingsStatus('Error: ' + err.message));
  });
});

$('clear-history').addEventListener('click', () => {
  browser.storage.local.remove('history').then(() => renderHistory([]));
});

// Two clicks, so a stray one can't wipe the settings.
const resetBtn = $('reset-settings');
let resetTimer = null;
resetBtn.addEventListener('click', () => {
  if (resetTimer === null) {
    resetBtn.textContent = 'Click again to reset';
    resetTimer = setTimeout(() => {
      resetBtn.textContent = 'Reset';
      resetTimer = null;
    }, 4000);
    return;
  }
  clearTimeout(resetTimer);
  resetTimer = null;
  resetBtn.textContent = 'Reset';
  browser.storage.local.clear()
    .then(() => send({ type: 'setConfig', config: { downloadDir: '', twitterDownloadDir: '', webDownloadDir: '' } }))
    .then(() => {
      applyThemePref('system');
      loadSettings();
      flashSettingsStatus('Settings reset');
    })
    .catch((err) => setSettingsStatus('Error: ' + err.message));
});

// -------------------------------------------------------------- pop-out

const popoutBtn = $('popout-btn');
if (detachedTabId) document.body.classList.add('is-detached');
if (!browser.windows) popoutBtn.classList.add('hidden'); // e.g. Firefox Android

// A popup closes the moment it loses focus; a window of its own does not.
popoutBtn.addEventListener('click', () => {
  browser.windows.create({ url: 'popup.html?tabId=' + currentTabId, type: 'popup', width: 520, height: 700 })
    .then(() => window.close());
});

// ------------------------------------------------------------------ theme

const themeToggleBtn = $('theme-toggle');
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let themePref = 'system';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  themeToggleBtn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

// 'system' follows the OS (and tracks it live); 'light' / 'dark' are fixed.
function applyThemePref(pref) {
  themePref = pref;
  applyTheme(pref === 'system' ? (systemDark.matches ? 'dark' : 'light') : pref);
}

systemDark.addEventListener('change', () => {
  if (themePref === 'system') applyThemePref('system');
});

themeToggleBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyThemePref(next);
  $('set-theme').value = next;
  browser.storage.local.set({ theme: next });
});

// ------------------------------------------------------------------- init

// "Open on tab" setting; Auto opens a tweet link on the Twitter tab, anything else on YouTube.
function startTab(url, pref) {
  if (pref && pref !== 'auto' && panels[pref]) return pref;
  return TWEET_URL_RE.test(url) ? 'twitter' : 'youtube';
}

function init() {
  const stored = browser.storage.local.get(['theme', 'defaultTab']);
  stored.then((s) => applyThemePref(s.theme || 'system'));

  Promise.all([stored, currentTab()]).then(([s, tab]) => {
    const url = tab.url;
    currentTabUrlValue = url;
    currentTabId = tab.id;
    send({ type: 'getJob', tabUrl: url }).then((job) => {
      if (job) lastJob = job;
      selectTab(startTab(url, s.defaultTab));
    });
  });
}

// twitter.js registers panels.twitter at script load; init runs after both.
document.addEventListener('DOMContentLoaded', init);
