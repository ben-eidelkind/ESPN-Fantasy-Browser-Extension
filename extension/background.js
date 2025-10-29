// background.js - fixed to target top frame first for ESPN requests

async function csFetchJson(tabId, urls) {
  const respTop = await new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: "cs.fetchJson", urls },
      { frameId: 0 },
      (response) => {
        if (chrome.runtime.lastError) {
          return resolve({ ok: false, code: "CS_ERROR", message: chrome.runtime.lastError.message });
        }
        resolve(response);
      }
    );
  });
  if (respTop) return respTop;

  return await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "cs.fetchJson", urls }, (response) => {
      if (chrome.runtime.lastError) {
        return resolve({ ok: false, code: "CS_ERROR", message: chrome.runtime.lastError.message });
      }
      resolve(response || { ok: false, code: "CS_ERROR", message: "No response from content script." });
    });
  });
}
