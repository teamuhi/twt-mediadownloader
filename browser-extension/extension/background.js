// Owns the native messaging Port to the local host, tracks in-flight
// download jobs, and pushes progress/notifications independently of
// whether the popup is open (a Port opened from the popup would die the
// instant the popup closes, so the popup only ever talks to us).

const HOST_NAME = 'com.nickel.nickel_tools';
const HOST_TIMEOUT_MS = 8000;
const TRANSLATE_TIMEOUT_MS = 30000; // two sequential web requests; also covers an old host that ignores the message

let port = null;

// requestId -> { resolve, reject }, for one-shot request/response calls (ping, formats)
const pendingRequests = {};

// requestId -> tabUrl, so a pushed jobUpdate can find its job
const requestIdToTabUrl = {};

// tabUrl -> { requestId, title, mode, source, status, percent, startedAt, filename, error, errorCode, errorHint }
const jobs = {};

// notificationId -> file path, so clicking a finished-download notification
// can ask the host to reveal it
const notificationPaths = {};

function newRequestId() {
  return crypto.randomUUID();
}

function ensurePort() {
  if (port) return port;
  port = browser.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(onPortDisconnect);
  return port;
}

// timeoutMs is for requests an older host build never answers (unknown
// message types are silently ignored), so the popup can tell it to update.
function sendRequest(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    pendingRequests[message.requestId] = {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
    if (timeoutMs) {
      timer = setTimeout(() => {
        delete pendingRequests[message.requestId];
        reject(Object.assign(new Error('The native host did not answer.'), {
          code: 'E_HOST_OUTDATED',
          hint: 'Reinstall nickel.tools to update the native host.',
        }));
      }, timeoutMs);
    }
    try {
      ensurePort().postMessage(message);
    } catch (e) {
      delete pendingRequests[message.requestId];
      reject(e);
    }
  });
}


// User-facing toggles from the popup's Settings page (storage.local).
const DEFAULT_SETTINGS = { showBadge: true, notifyStart: true, notifyFinish: true, notifyError: true, autoReveal: false };
const HISTORY_MAX = 20;

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await browser.storage.local.get(Object.keys(DEFAULT_SETTINGS))) };
}

// Browser's x.com login cookies, for sensitive/protected tweets. Sent to the
// local host only for that one request; null when the user turned it off.
async function getXCookies() {
  const { useXLogin } = await browser.storage.local.get('useXLogin');
  if (useXLogin === false) return null;
  const lists = await Promise.all(['x.com', 'twitter.com'].map((domain) => browser.cookies.getAll({ domain })));
  return lists.flat().map((c) => ({
    domain: c.domain, path: c.path, secure: c.secure, expirationDate: c.expirationDate, name: c.name, value: c.value,
  }));
}

// Error shape shared with the popup: host errors carry a code, readable
// message and hint (see backend/errors.py).
function makeError(msg) {
  return Object.assign(new Error(msg.error), { code: msg.errorCode, hint: msg.errorHint, detail: msg.errorDetail });
}

function failure(err) {
  return { ok: false, error: err.message, errorCode: err.code, errorHint: err.hint, errorDetail: err.detail };
}

const isActive = (job) => job.status !== 'finished' && job.status !== 'error';
const jobNotificationId = (job) => (job.requestId ? 'job-' + job.requestId : undefined);

const STATUS_WORDS = { starting: 'Starting', downloading: 'Downloading', converting: 'Converting', tagging: 'Writing tags', rendering: 'Rendering card' };
const BADGE_COLORS = { active: '#111111', finished: '#346538', error: '#9f2f2d' };
const BADGE_FLASH_MS = { finished: 5000, error: 10000 };
const DEFAULT_TITLE = 'Download media from this page';

// Toolbar badge: progress while exporting, then a short-lived check or "!".
// This is what shows an export is running while the popup is closed.
let badgeFlash = null;
let badgeFlashTimer = null;
let lastBadge = '';

function flashBadge(status) {
  clearTimeout(badgeFlashTimer);
  badgeFlash = status;
  badgeFlashTimer = setTimeout(() => { badgeFlash = null; updateBadge(); }, BADGE_FLASH_MS[status]);
}

function clearBadgeFlash() {
  clearTimeout(badgeFlashTimer);
  badgeFlash = null;
  updateBadge();
}

async function updateBadge() {
  const { showBadge } = await getSettings();
  const active = Object.values(jobs).filter(isActive);
  let text = '';
  let color = BADGE_COLORS.active;
  let title = DEFAULT_TITLE;
  if (showBadge && active.length) {
    const job = active.reduce((a, b) => ((b.startedAt || 0) > (a.startedAt || 0) ? b : a));
    const percent = Math.round(job.percent || 0);
    text = active.length > 1 ? String(active.length) : percent + '%';
    title = 'nickel.tools: ' + (STATUS_WORDS[job.status] || 'Exporting') + (job.title ? ' "' + job.title + '"' : '') + '… ' + percent + '%'
      + (active.length > 1 ? ' (+' + (active.length - 1) + ' more)' : '');
  } else if (showBadge && badgeFlash) {
    text = badgeFlash === 'finished' ? '✓' : '!';
    color = BADGE_COLORS[badgeFlash];
    title = badgeFlash === 'finished' ? 'nickel.tools: export finished' : 'nickel.tools: export failed';
  }
  const key = text + color + title;
  if (key === lastBadge) return;
  lastBadge = key;
  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color });
  browser.browserAction.setTitle({ title });
}

browser.storage.onChanged.addListener((changes) => {
  if (changes.showBadge) updateBadge();
});

const finishedJobs = new Set();

// Everything that happens once a job ends: badge, notification, history, auto-reveal.
async function jobDone(job) {
  const id = job.requestId || job.title;
  if (finishedJobs.has(id)) return;
  finishedJobs.add(id);
  const isError = job.status === 'error';
  flashBadge(isError ? 'error' : 'finished');
  updateBadge();

  const settings = await getSettings();
  if (isError ? settings.notifyError : settings.notifyFinish) notify(job, isError);
  if (isError) return;

  if (settings.autoReveal && job.path) {
    ensurePort().postMessage({ type: 'revealFile', requestId: newRequestId(), path: job.path });
  }
  const { history = [] } = await browser.storage.local.get('history');
  history.unshift({ title: job.title || job.filename || 'Saved', filename: job.filename, path: job.path, source: job.source, at: Date.now() });
  browser.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
}

// Same notification id as the "started" one, so the result replaces it.
function notify(job, isError) {
  browser.notifications.create(jobNotificationId(job), {
    type: 'basic',
    title: isError ? 'Download failed' + (job.errorCode ? ' (' + job.errorCode + ')' : '') : 'Download finished',
    message: isError ? job.error + (job.errorHint ? '\n' + job.errorHint : '') : (job.title || job.filename || 'Saved') + (job.path ? '\nClick to show in folder' : ''),
  }).then((notificationId) => {
    if (!isError && job.path) {
      notificationPaths[notificationId] = job.path;
    }
  });
}

async function notifyStarted(job) {
  if (!(await getSettings()).notifyStart) return;
  browser.notifications.create(jobNotificationId(job), {
    type: 'basic',
    title: 'Exporting…',
    message: job.title || 'Your download has started',
  });
}

browser.notifications.onClicked.addListener((notificationId) => {
  const path = notificationPaths[notificationId];
  if (!path) return;
  ensurePort().postMessage({ type: 'revealFile', requestId: newRequestId(), path });
});

browser.notifications.onClosed.addListener((notificationId) => {
  delete notificationPaths[notificationId];
});

function broadcast(tabUrl) {
  browser.runtime.sendMessage({ type: 'jobUpdate', tabUrl, job: jobs[tabUrl] }).catch(() => {
    // No popup listening; that's fine.
  });
}

function onPortMessage(msg) {
  if (msg.type === 'pong' || msg.type === 'formatsResult' || msg.type === 'tweetResult' || msg.type === 'translateResult' || msg.type === 'configResult' || msg.type === 'browseFolderResult' || msg.type === 'openPathResult' || msg.type === 'revealFileResult') {
    const pending = pendingRequests[msg.requestId];
    if (!pending) return;
    delete pendingRequests[msg.requestId];
    if (msg.ok === false) {
      pending.reject(makeError(msg));
    } else {
      pending.resolve(msg);
    }
    return;
  }

  if (msg.type === 'jobUpdate') {
    const tabUrl = requestIdToTabUrl[msg.requestId];
    if (!tabUrl || !jobs[tabUrl]) return;
    Object.assign(jobs[tabUrl], msg);
    broadcast(tabUrl);
    updateBadge();
    if (msg.status === 'finished' || msg.status === 'error') {
      jobDone(jobs[tabUrl]);
      delete requestIdToTabUrl[msg.requestId];
    }
  }
}

function onPortDisconnect() {
  const err = browser.runtime.lastError;
  const message = 'Native host disconnected' + (err && err.message ? ': ' + err.message : '');
  port = null;

  Object.values(pendingRequests).forEach((p) => p.reject(new Error(message)));
  for (const id in pendingRequests) delete pendingRequests[id];

  for (const tabUrl in jobs) {
    if (jobs[tabUrl].status !== 'finished' && jobs[tabUrl].status !== 'error') {
      jobs[tabUrl].status = 'error';
      jobs[tabUrl].error = message;
      broadcast(tabUrl);
      jobDone(jobs[tabUrl]);
    }
  }
}

// Which config field holds each tab's save location.
const DIR_KEYS = { youtube: 'downloadDir', twitter: 'twitterDownloadDir', web: 'webDownloadDir' };

// Shows the host's Windows folder dialog; resolves to the chosen path, or null if
// cancelled. Runs here rather than in the popup because the dialog steals focus,
// which closes the popup before the answer arrives. No timeout: the user may
// take as long as they like.
function browseFolder(source) {
  return sendRequest({ type: 'browseFolder', requestId: newRequestId(), source }).then((res) => res.path || null);
}

function startJob(message) {
  const requestId = newRequestId();
  const { type, tabUrl, ...params } = message;
  requestIdToTabUrl[requestId] = tabUrl;
  jobs[tabUrl] = {
    requestId,
    title: message.title,
    mode: message.mode,
    source: message.source || 'youtube',
    status: 'starting',
    percent: 0,
    startedAt: Date.now(),
  };
  notifyStarted(jobs[tabUrl]);
  (async () => {
    try {
      const cookies = message.source === 'twitter' ? await getXCookies() : null;
      ensurePort().postMessage({ ...params, type: 'download', requestId, cookies });
    } catch (e) {
      jobs[tabUrl].status = 'error';
      jobs[tabUrl].error = e.message;
      broadcast(tabUrl);
      jobDone(jobs[tabUrl]);
    }
  })();
  broadcast(tabUrl);
  updateBadge();
}

// One scan.js result per frame -> the top frame's page info plus every frame's
// items (media is often inside an iframe), de-duplicated by URL.
function mergeScans(results) {
  const scans = (results || []).filter((r) => r && r.items);
  const top = scans.find((r) => r.top) || scans[0];
  if (!top) return null;
  const seen = new Set();
  const items = scans.flatMap((r) => r.items).filter((item) => !seen.has(item.url) && seen.add(item.url));
  return { ...top, items: items.slice(0, 300) };
}

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'getFormats') {
    return sendRequest({ type: 'formats', requestId: newRequestId(), url: message.url }).catch(failure);
  }

  if (message.type === 'getTweet') {
    return getXCookies()
      .then((cookies) => sendRequest({ type: 'tweet', requestId: newRequestId(), url: message.url, cookies }))
      .catch(failure);
  }

  if (message.type === 'translate') {
    return sendRequest({ type: 'translate', requestId: newRequestId(), texts: message.texts, target: message.target }, TRANSLATE_TIMEOUT_MS).catch(failure);
  }

  if (message.type === 'startDownload') {
    startJob(message);
    return;
  }

  if (message.type === 'startDownloadTo') {
    return browseFolder(message.source)
      .then((path) => {
        if (path) startJob({ ...message, downloadDir: path });
      })
      .catch((err) => {
        jobs[message.tabUrl] = { source: message.source, status: 'error', percent: 0, error: 'Could not choose a folder: ' + err.message };
        broadcast(message.tabUrl);
        notify(jobs[message.tabUrl]);
      });
  }

  if (message.type === 'pickDir') {
    return browseFolder(message.source)
      .then((path) => {
        if (!path) return { cancelled: true };
        return sendRequest({ type: 'setConfig', requestId: newRequestId(), config: { [DIR_KEYS[message.source]]: path } });
      })
      .catch(failure);
  }

  if (message.type === 'scanPage') {
    return browser.tabs.executeScript(message.tabId, { file: 'scan.js', allFrames: true })
      .then(mergeScans)
      .catch((e) => failure(Object.assign(new Error("This page can't be scanned."), {
        code: 'E_UNSUPPORTED_URL',
        hint: 'Reload the page, then open nickel.tools from the toolbar again.',
        detail: e.message,
      })));
  }

  if (message.type === 'getJob') {
    clearBadgeFlash();
    return Promise.resolve(jobs[message.tabUrl] || null);
  }

  if (message.type === 'getConfig') {
    return sendRequest({ type: 'getConfig', requestId: newRequestId() }).catch(failure);
  }

  if (message.type === 'setConfig') {
    return sendRequest({ type: 'setConfig', requestId: newRequestId(), config: message.config }).catch(failure);
  }

  // Settings helpers; an old host never answers these.
  if (message.type === 'openPath') {
    return sendRequest({ type: 'openPath', requestId: newRequestId(), path: message.path, source: message.source }, HOST_TIMEOUT_MS).catch(failure);
  }

  if (message.type === 'revealFile') {
    return sendRequest({ type: 'revealFile', requestId: newRequestId(), path: message.path }, HOST_TIMEOUT_MS).catch(failure);
  }
});
