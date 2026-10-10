// MV3 service worker for Chrome/Edge/Brave. Owns the native messaging Port,
// tracks in-flight download jobs, and pushes progress/notifications
// independently of whether the popup is open -- same responsibility as the
// Firefox extension's background.js, but this file can be killed and
// restarted by the browser at any time (MV3 service worker lifecycle), so
// unlike the Firefox version it can't just trust its own in-memory state:
//
//   - `jobs` and `notificationPaths` are persisted to chrome.storage.session
//     on every mutation, and rehydrated here at startup, so a restart
//     doesn't lose track of an in-flight download or a pending
//     click-to-reveal notification.
//   - Reconnecting via connectNative() after a restart always spawns a NEW
//     host.exe process, never reattaches to the one already running the
//     download -- there is no such API. So on rehydration, any job that
//     isn't already finished/errored is reconciled by asking the (possibly
//     new) host process to read the job's status back from the status file
//     host.py persists to disk per requestId (see getJobStatus below),
//     rather than trusting the rehydrated in-memory shape as current.

const HOST_NAME = 'com.nickel.nickel_tools';
const HOST_TIMEOUT_MS = 8000;
const TRANSLATE_TIMEOUT_MS = 30000; // two sequential web requests; also covers an old host that ignores the message

let port = null;

// requestId -> { resolve, reject }, for one-shot request/response calls
// (ping, formats, config). Unlike `jobs`, these are NOT persisted: an
// in-flight Promise can't survive a service worker restart, so a caller
// whose request was orphaned by a restart just sees it reject/hang and can
// retry -- these calls are all short-lived (popup-open-triggered), so the
// window for this to matter is small.
const pendingRequests = {};

// requestId -> tabUrl, so a pushed jobUpdate can find its job. Persisted
// alongside `jobs` since it's needed to route jobUpdate messages after a
// restart too.
let requestIdToTabUrl = {};

// tabUrl -> { requestId, title, mode, source, status, percent, startedAt, filename, error, errorCode, errorHint }
let jobs = {};

// notificationId -> file path, so clicking a finished-download notification
// can ask the host to reveal it
let notificationPaths = {};

let stateLoaded = loadState();

function newRequestId() {
  return crypto.randomUUID();
}

console.log('[bg] service worker script evaluating, t=', Date.now());

async function loadState() {
  const stored = await chrome.storage.session.get(['jobs', 'notificationPaths', 'requestIdToTabUrl']);
  jobs = stored.jobs || {};
  notificationPaths = stored.notificationPaths || {};
  requestIdToTabUrl = stored.requestIdToTabUrl || {};
  console.log('[bg] state rehydrated, jobs=', JSON.stringify(jobs));
  reconcileJobs();
  updateBadge();
}

function persistState() {
  chrome.storage.session.set({ jobs, notificationPaths, requestIdToTabUrl });
}

// requestId -> { intervalId, failures }. After a restart, the host process
// we're now connected to is NOT the one running the download (a fresh
// connectNative() always spawns a new process -- see the module comment at
// the top), so it will never push us another jobUpdate for this job on its
// own. The only way to keep the popup's progress current is to keep asking
// -- a single reconciliation check would just freeze the UI at whatever
// that one snapshot showed. Polls over the same already-open port, which is
// what's expected to keep this service worker instance alive for the
// duration (same "strong keep-alive" assumption normal, non-restarted
// downloads already rely on) -- chrome.alarms was considered instead since
// setInterval doesn't survive a service worker being torn down, but its
// ~30s minimum period is too coarse for a progress bar.
const activePolls = {};

function stopPolling(requestId) {
  if (activePolls[requestId]) {
    clearInterval(activePolls[requestId].intervalId);
    delete activePolls[requestId];
  }
}

function pollJobStatus(tabUrl, requestId) {
  console.log('[bg] pollJobStatus: starting poll for', requestId, 'tabUrl=', tabUrl);
  stopPolling(requestId);
  const poll = { intervalId: null, failures: 0 };
  activePolls[requestId] = poll;
  poll.intervalId = setInterval(() => {
    if (!jobs[tabUrl] || jobs[tabUrl].requestId !== requestId) {
      console.log('[bg] pollJobStatus: job superseded/gone, stopping poll for', requestId);
      stopPolling(requestId);
      return;
    }
    // A fresh requestId per poll tick for response correlation (so two
    // overlapping ticks can't clobber each other in pendingRequests); jobId
    // tells the host which job's status file to actually read.
    sendRequest({ type: 'getJobStatus', requestId: newRequestId(), jobId: requestId })
      .then((res) => {
        console.log('[bg] pollJobStatus tick ok for', requestId, '->', JSON.stringify(res));
        poll.failures = 0;
        if (!jobs[tabUrl] || jobs[tabUrl].requestId !== requestId) {
          stopPolling(requestId);
          return;
        }
        // res carries this one RPC's own wrapper fields (type, ok, and a
        // per-tick requestId used only for response correlation -- see the
        // comment above) which must NOT overwrite the job's real, stable
        // requestId. Only the actual status fields belong in jobs[tabUrl].
        const { type, ok, requestId: _wrapperRequestId, ...statusFields } = res;
        Object.assign(jobs[tabUrl], statusFields);
        persistState();
        broadcast(tabUrl);
        updateBadge();
        if (jobs[tabUrl].status === 'finished' || jobs[tabUrl].status === 'error') {
          stopPolling(requestId);
          jobDone(jobs[tabUrl]);
        }
      })
      .catch((err) => {
        console.warn('[bg] pollJobStatus tick FAILED for', requestId, err && err.message);
        // A single missed tick isn't fatal (the host may just be briefly
        // busy); only give up after several in a row.
        poll.failures += 1;
        if (poll.failures >= 5 && jobs[tabUrl] && jobs[tabUrl].requestId === requestId) {
          jobs[tabUrl].status = 'error';
          jobs[tabUrl].error = 'Lost track of this download after a browser restart.';
          persistState();
          broadcast(tabUrl);
          stopPolling(requestId);
          jobDone(jobs[tabUrl]);
        }
      });
  }, 1500);
}

function reconcileJobs() {
  console.log('[bg] reconcileJobs: checking', Object.keys(jobs).length, 'rehydrated job(s)');
  for (const tabUrl in jobs) {
    const job = jobs[tabUrl];
    if (job.status === 'finished' || job.status === 'error') continue;
    pollJobStatus(tabUrl, job.requestId);
  }
}

function ensurePort() {
  if (port) return port;
  console.log('[bg] ensurePort: spawning a new native host connection');
  port = chrome.runtime.connectNative(HOST_NAME);
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
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))) };
}

// Browser's x.com login cookies, for sensitive/protected tweets. Sent to the
// local host only for that one request; null when the user turned it off.
async function getXCookies() {
  const { useXLogin } = await chrome.storage.local.get('useXLogin');
  if (useXLogin === false) return null;
  const lists = await Promise.all(['x.com', 'twitter.com'].map((domain) => chrome.cookies.getAll({ domain })));
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

// chrome.notifications.create(id?, options, callback): the id is optional.
function createNotification(id, options, callback) {
  const args = id ? [id, options] : [options];
  chrome.notifications.create(...args, callback);
}

const STATUS_WORDS = { starting: 'Starting', downloading: 'Downloading', converting: 'Converting', tagging: 'Writing tags', rendering: 'Rendering card' };
const BADGE_COLORS = { active: '#111111', finished: '#346538', error: '#9f2f2d' };
const BADGE_FLASH_MS = { finished: 5000, error: 10000 };
const DEFAULT_TITLE = 'Download media from this page';

// Toolbar badge: progress while exporting, then a short-lived check or "!".
// This is what shows an export is running while the popup is closed. The
// badge itself outlives a service worker restart; only the flash timer
// doesn't, which at worst leaves a check/"!" up until the next update.
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
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.showBadge) updateBadge();
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
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift({ title: job.title || job.filename || 'Saved', filename: job.filename, path: job.path, source: job.source, at: Date.now() });
  chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
}

// Same notification id as the "started" one, so the result replaces it.
function notify(job, isError) {
  createNotification(jobNotificationId(job), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
    title: isError ? 'Download failed' + (job.errorCode ? ' (' + job.errorCode + ')' : '') : 'Download finished',
    message: isError ? job.error + (job.errorHint ? '\n' + job.errorHint : '') : (job.title || job.filename || 'Saved') + (job.path ? '\nClick to show in folder' : ''),
  }, (notificationId) => {
    if (!isError && job.path) {
      notificationPaths[notificationId] = job.path;
      persistState();
    }
  });
}

async function notifyStarted(job) {
  if (!(await getSettings()).notifyStart) return;
  createNotification(jobNotificationId(job), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
    title: 'Exporting…',
    message: job.title || 'Your download has started',
    silent: true,
  });
}

chrome.notifications.onClicked.addListener((notificationId) => {
  const path = notificationPaths[notificationId];
  if (!path) return;
  ensurePort().postMessage({ type: 'revealFile', requestId: newRequestId(), path });
});

chrome.notifications.onClosed.addListener((notificationId) => {
  delete notificationPaths[notificationId];
  persistState();
});

function broadcast(tabUrl) {
  chrome.runtime.sendMessage({ type: 'jobUpdate', tabUrl, job: jobs[tabUrl] }).catch(() => {
    // No popup listening; that's fine.
  });
}

function onPortMessage(msg) {
  if (msg.type === 'pong' || msg.type === 'formatsResult' || msg.type === 'tweetResult' || msg.type === 'translateResult' || msg.type === 'configResult' || msg.type === 'jobStatusResult' || msg.type === 'browseFolderResult' || msg.type === 'openPathResult' || msg.type === 'revealFileResult') {
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
    console.log('[bg] jobUpdate received:', JSON.stringify(msg));
    const tabUrl = requestIdToTabUrl[msg.requestId];
    if (!tabUrl || !jobs[tabUrl]) {
      console.warn('[bg] jobUpdate has no matching tabUrl/job -- dropped. requestIdToTabUrl=', JSON.stringify(requestIdToTabUrl));
      return;
    }
    Object.assign(jobs[tabUrl], msg);
    persistState();
    broadcast(tabUrl);
    updateBadge();
    if (msg.status === 'finished' || msg.status === 'error') {
      jobDone(jobs[tabUrl]);
      delete requestIdToTabUrl[msg.requestId];
      persistState();
    }
  }
}

function onPortDisconnect() {
  const err = chrome.runtime.lastError;
  const message = 'Native host disconnected' + (err && err.message ? ': ' + err.message : '');
  console.warn('[bg] onPortDisconnect:', message);
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
  persistState();
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

async function startJob(message) {
  await stateLoaded;
  const requestId = newRequestId();
  const { type, tabUrl, ...params } = message;
  console.log('[bg] startJob: requestId=', requestId, 'tabUrl=', tabUrl, 'url=', message.url);
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
  try {
    const cookies = message.source === 'twitter' ? await getXCookies() : null;
    ensurePort().postMessage({ ...params, type: 'download', requestId, cookies });
  } catch (e) {
    console.error('[bg] startJob: postMessage threw', e);
    jobs[tabUrl].status = 'error';
    jobs[tabUrl].error = e.message;
    jobDone(jobs[tabUrl]);
  }
  persistState();
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getFormats') {
    stateLoaded.then(() => sendRequest({ type: 'formats', requestId: newRequestId(), url: message.url }))
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  if (message.type === 'translate') {
    stateLoaded.then(() => sendRequest({ type: 'translate', requestId: newRequestId(), texts: message.texts, target: message.target }, TRANSLATE_TIMEOUT_MS))
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  if (message.type === 'getTweet') {
    getXCookies()
      .then((cookies) => sendRequest({ type: 'tweet', requestId: newRequestId(), url: message.url, cookies }))
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  if (message.type === 'startDownload') {
    startJob(message);
    return false;
  }

  if (message.type === 'startDownloadTo') {
    browseFolder(message.source)
      .then((path) => (path ? startJob({ ...message, downloadDir: path }) : null))
      .catch(async (err) => {
        await stateLoaded;
        jobs[message.tabUrl] = { source: message.source, status: 'error', percent: 0, error: 'Could not choose a folder: ' + err.message };
        persistState();
        broadcast(message.tabUrl);
        notify(jobs[message.tabUrl]);
      })
      .then(() => sendResponse());
    return true;
  }

  if (message.type === 'pickDir') {
    browseFolder(message.source)
      .then((path) => {
        if (!path) return { cancelled: true };
        return sendRequest({ type: 'setConfig', requestId: newRequestId(), config: { [DIR_KEYS[message.source]]: path } });
      })
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  if (message.type === 'scanPage') {
    chrome.scripting.executeScript({ target: { tabId: message.tabId, allFrames: true }, files: ['scan.js'] })
      .then((res) => sendResponse(mergeScans(res.map((r) => r.result))))
      .catch((e) => sendResponse(failure(Object.assign(new Error("This page can't be scanned."), {
        code: 'E_UNSUPPORTED_URL',
        hint: 'Reload the page, then open nickel.tools from the toolbar again.',
        detail: e.message,
      }))));
    return true;
  }

  if (message.type === 'getJob') {
    stateLoaded.then(() => {
      clearBadgeFlash();
      sendResponse(jobs[message.tabUrl] || null);
    });
    return true;
  }

  if (message.type === 'getConfig') {
    sendRequest({ type: 'getConfig', requestId: newRequestId() })
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  if (message.type === 'setConfig') {
    sendRequest({ type: 'setConfig', requestId: newRequestId(), config: message.config })
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  // Settings helpers; an old host never answers these.
  const hostCalls = {
    openPath: () => ({ type: 'openPath', path: message.path, source: message.source }),
    revealFile: () => ({ type: 'revealFile', path: message.path }),
  };
  if (hostCalls[message.type]) {
    sendRequest({ ...hostCalls[message.type](), requestId: newRequestId() }, HOST_TIMEOUT_MS)
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  return false;
});
