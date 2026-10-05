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

const HOST_NAME = 'com.twtdl.twtdl_extension';

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

// tabUrl -> { requestId, title, mode, source, status, percent, filename, error, errorCode, errorHint }
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
        if (jobs[tabUrl].status === 'finished' || jobs[tabUrl].status === 'error') {
          stopPolling(requestId);
          notify(jobs[tabUrl]);
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

function sendRequest(message) {
  return new Promise((resolve, reject) => {
    pendingRequests[message.requestId] = { resolve, reject };
    try {
      ensurePort().postMessage(message);
    } catch (e) {
      delete pendingRequests[message.requestId];
      reject(e);
    }
  });
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

function notify(job) {
  const isError = job.status === 'error';
  chrome.notifications.create({
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
  if (msg.type === 'pong' || msg.type === 'formatsResult' || msg.type === 'tweetResult' || msg.type === 'configResult' || msg.type === 'jobStatusResult' || msg.type === 'browseFolderResult') {
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
    if (msg.status === 'finished' || msg.status === 'error') {
      notify(jobs[tabUrl]);
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
      notify(jobs[tabUrl]);
    }
  }
  persistState();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getFormats') {
    stateLoaded.then(() => sendRequest({ type: 'formats', requestId: newRequestId(), url: message.url }))
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
    stateLoaded.then(async () => {
      const requestId = newRequestId();
      const { type, tabUrl, ...params } = message;
      console.log('[bg] startDownload: requestId=', requestId, 'tabUrl=', tabUrl, 'url=', message.url);
      requestIdToTabUrl[requestId] = tabUrl;
      jobs[tabUrl] = {
        requestId,
        title: message.title,
        mode: message.mode,
        source: message.source || 'youtube',
        status: 'starting',
        percent: 0,
      };
      try {
        const cookies = message.source === 'twitter' ? await getXCookies() : null;
        ensurePort().postMessage({ ...params, type: 'download', requestId, cookies });
      } catch (e) {
        console.error('[bg] startDownload: postMessage threw', e);
        jobs[tabUrl].status = 'error';
        jobs[tabUrl].error = e.message;
      }
      persistState();
      broadcast(tabUrl);
    });
    return false;
  }

  if (message.type === 'getJob') {
    stateLoaded.then(() => sendResponse(jobs[message.tabUrl] || null));
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

  if (message.type === 'browseFolder') {
    sendRequest({ type: 'browseFolder', requestId: newRequestId(), source: message.source })
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  return false;
});
