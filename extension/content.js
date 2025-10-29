// content.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "detectLeagueId") {
        const m = String(location.href).match(/[?&#]leagueId=(\d+)/);
        if (m) return sendResponse({ ok: true, leagueId: m[1] });
        return sendResponse({ ok: false, error: "NO_LEAGUE_ID" });
      }
      if (msg?.type === "cs.fetchEspn") {
        try {
          const u = new URL(msg.url);
          if (u.origin !== location.origin) {
            return sendResponse({ ok: false, code: "CROSS_ORIGIN", message: "URL origin mismatch" });
          }
          const res = await fetch(u.toString(), {
            credentials: "include",
            headers: { Accept: "application/json" }
          });
          if (!res.ok) {
            return sendResponse({ ok: false, code: "HTTP_ERROR", status: res.status, statusText: res.statusText });
          }
          const data = await res.json();
          return sendResponse({ ok: true, data, path: "content-script" });
        } catch (e) {
          return sendResponse({ ok: false, code: "FETCH_ERROR", message: String(e) });
        }
      }
    } catch (e) {
      sendResponse({ ok: false, code: "UNEXPECTED", message: String(e) });
    }
  })();
  return true; // async
});
