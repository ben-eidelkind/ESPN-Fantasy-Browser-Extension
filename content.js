// content.js — page-world fallback remains; still supports cs.fetchJson

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "detectLeagueId") {
        const m = String(location.href).match(/[?&#]leagueId=(\d+)/);
        if (m) return sendResponse({ ok: true, leagueId: m[1] });
        return sendResponse({ ok: false, error: "NO_LEAGUE_ID" });
      }
      if (msg?.type === "cs.fetchJson") {
        const urls = Array.isArray(msg.urls) ? msg.urls : [];
        const results = [];
        for (const urlString of urls) {
          try {
            const parsed = new URL(String(urlString));
            if (!/^https:\/\/fantasy\.espn\.com/i.test(parsed.origin)) {
              results.push({ ok: false, code: "CROSS_ORIGIN", url: urlString });
              continue;
            }
            const res = await fetch(parsed.toString(), {
              credentials: "include",
              headers: { "Accept": "application/json" }
            });
            if (!res.ok) {
              results.push({ ok: false, code: "HTTP_ERROR", status: res.status, statusText: res.statusText, url: urlString });
              continue;
            }
            let data = null;
            try { data = await res.json(); } catch {}
            if (!data) { results.push({ ok: false, code: "PARSE_ERROR", url: urlString }); continue; }
            results.push({ ok: true, data, url: urlString, path: "content-script" });
          } catch (e) {
            results.push({ ok: false, code: "NETWORK_ERROR", message: String(e), url: urlString });
          }
        }
        return sendResponse({ ok: true, results, path: "content-script" });
      }
      return sendResponse({ ok: false, code: "UNKNOWN_REQUEST" });
    } catch (e) {
      return sendResponse({ ok: false, code: "UNEXPECTED", message: String(e) });
    }
  })();
  return true;
});
