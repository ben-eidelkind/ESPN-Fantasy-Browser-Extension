// content.js
// Handles leagueId detection and in-page ESPN API fetching.
// Runs directly inside fantasy.espn.com so requests include your logged-in cookies.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // --- League ID detection ---
      if (msg?.type === "detectLeagueId") {
        const match = String(location.href).match(/[?&#]leagueId=(\d+)/);
        if (match) {
          return sendResponse({ ok: true, leagueId: match[1] });
        }
        return sendResponse({ ok: false, error: "NO_LEAGUE_ID" });
      }

      // --- ESPN API fetch (used for Test + Fetch Data) ---
      if (msg?.type === "cs.fetchJson") {
        const urls = Array.isArray(msg.urls) ? msg.urls : [];
        const results = [];

        for (const urlString of urls) {
          try {
            const parsed = new URL(urlString);

            // ✅ Allow any path on fantasy.espn.com
            if (!/^https:\/\/fantasy\.espn\.com/i.test(parsed.origin)) {
              results.push({
                ok: false,
                code: "CROSS_ORIGIN",
                message: "URL origin not fantasy.espn.com",
                url: urlString
              });
              continue;
            }

            const res = await fetch(parsed.toString(), {
              credentials: "include",
              headers: { "Accept": "application/json" }
            });

            if (!res.ok) {
              results.push({
                ok: false,
                code: "HTTP_ERROR",
                status: res.status,
                statusText: res.statusText,
                url: urlString
              });
              continue;
            }

            const data = await res.json().catch(() => null);
            if (!data) {
              results.push({
                ok: false,
                code: "PARSE_ERROR",
                url: urlString
              });
              continue;
            }

            results.push({ ok: true, data, url: urlString });
          } catch (e) {
            results.push({
              ok: false,
              code: "NETWORK_ERROR",
              message: String(e),
              url: urlString
            });
          }
        }

        return sendResponse({ ok: true, results, path: "content-script" });
      }

    } catch (e) {
      sendResponse({
        ok: false,
        code: "UNEXPECTED",
        message: String(e)
      });
    }
  })();
  return true; // keeps channel open for async responses
});
