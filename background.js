// Background service worker.
// Phase 1 scope: lifecycle logging only. Message relaying between the popup
// and content script is not needed yet because the popup talks to the
// content script directly via chrome.tabs.sendMessage.

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Job Autofill] Extension installed/updated:', details.reason);
});
