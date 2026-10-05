// Owns the native messaging Port to the local host, tracks in-flight
// download jobs, and pushes progress/notifications independently of
// whether the popup is open (a Port opened from the popup would die the
// instant the popup closes, so the popup only ever talks to us).

const HOST_NAME = 'com.twtdl.twtdl_extension';

let port = null;

// requestId -> { resolve, reject }, for one-shot request/response calls (ping, formats)
const pendingRequests = {};

// requestId -> tabUrl, so a pushed jobUpdate can find its job
const requestIdToTabUrl = {};

// tabUrl -> { requestId, title, mode, source, status, percent, filename, error, errorCode, errorHint }
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

function notify(job) {
  const isError = job.status === 'error';
  browser.notifications.create({
    type: 'basic',
    title: isError ? 'Download failed' + (job.errorCode ? ' (' + job.errorCode + ')' : '') : 'Download finished',
    message: isError ? job.error + (job.errorHint ? '\n' + job.errorHint : '') : (job.title || job.filename || 'Saved') + (job.path ? '\nClick to show in folder' : ''),
  }).then((notificationId) => {
    if (!isError && job.path) {
      notificationPaths[notificationId] = job.path;
    }
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
  if (msg.type === 'pong' || msg.type === 'formatsResult' || msg.type === 'tweetResult' || msg.type === 'configResult' || msg.type === 'browseFolderResult') {
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
    if (msg.status === 'finished' || msg.status === 'error') {
      notify(jobs[tabUrl]);
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
      notify(jobs[tabUrl]);
    }
  }
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

  if (message.type === 'startDownload') {
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
    };
    (async () => {
      try {
        const cookies = message.source === 'twitter' ? await getXCookies() : null;
        ensurePort().postMessage({ ...params, type: 'download', requestId, cookies });
      } catch (e) {
        jobs[tabUrl].status = 'error';
        jobs[tabUrl].error = e.message;
        broadcast(tabUrl);
      }
    })();
    broadcast(tabUrl);
    return;
  }

  if (message.type === 'getJob') {
    return Promise.resolve(jobs[message.tabUrl] || null);
  }

  if (message.type === 'getConfig') {
    return sendRequest({ type: 'getConfig', requestId: newRequestId() }).catch(failure);
  }

  if (message.type === 'setConfig') {
    return sendRequest({ type: 'setConfig', requestId: newRequestId(), config: message.config }).catch(failure);
  }

  if (message.type === 'browseFolder') {
    return sendRequest({ type: 'browseFolder', requestId: newRequestId() }).catch(failure);
  }
});
