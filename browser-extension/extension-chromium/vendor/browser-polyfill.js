// Minimal shim so the shared popup.js (which calls browser.*) runs
// unmodified under Chromium. Chrome/Edge/Brave's chrome.* APIs already
// return native Promises when no callback is passed (tabs.query,
// storage.local.get/set), so this is just a name alias. Failures arrive as
// { ok: false, error, errorCode, ... } responses (raw chrome.runtime can't
// reject the caller's promise), same as the Firefox background; popup.js's
// send() helper turns those into thrown errors for both browsers.
(function () {
  if (self.browser) return; // real Firefox `browser`, nothing to do

  self.browser = {
    tabs: chrome.tabs,
    storage: chrome.storage,
    notifications: chrome.notifications,
    runtime: chrome.runtime,
  };
})();
