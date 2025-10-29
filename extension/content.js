// Handles in-page league detection and ESPN API fetches.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
        sendResponse({ ok: false, code: "BAD_MESSAGE", message: "Invalid request." });
        return;
      }

      if (msg.type === "detectLeagueId") {
        const match = String(location.href).match(/[?&#]leagueId=(\d+)/);
        if (match) {
          sendResponse({ ok: true, leagueId: match[1] });
        } else {
          sendResponse({ ok: false, code: "NO_LEAGUE_ID" });
        }
        return;
      }

      if (msg.type === "cs.fetchJson") {
        if (!Array.isArray(msg.urls)) {
          sendResponse({ ok: false, code: "BAD_MESSAGE", message: "Missing URLs." });
          return;
        }

        const results = [];
        for (const rawUrl of msg.urls) {
          const urlString = String(rawUrl || "");
          let parsed;
          try {
            parsed = new URL(urlString);
          } catch (err) {
            results.push({ ok: false, code: "INVALID_URL", message: String(err), url: urlString });
            continue;
          }

          if (parsed.origin !== location.origin) {
            results.push({
              ok: false,
              code: "CROSS_ORIGIN",
              message: "URL origin mismatch",
              url: urlString
            });
            continue;
          }

          try {
            const response = await fetch(parsed.toString(), {
              credentials: "include",
              headers: {
                Accept: "application/json"
              }
            });

            if (!response.ok) {
              results.push({
                ok: false,
                code: "HTTP_ERROR",
                status: response.status,
                statusText: response.statusText,
                url: urlString
              });
              continue;
            }

            try {
              const data = await response.json();
              results.push({ ok: true, data, url: urlString });
            } catch (parseError) {
              results.push({ ok: false, code: "PARSE_ERROR", url: urlString });
            }
          } catch (fetchError) {
            results.push({ ok: false, code: "NETWORK_ERROR", message: String(fetchError), url: urlString });
          }
        }

        sendResponse({ ok: true, results });
        return;
      }

      sendResponse({ ok: false, code: "UNKNOWN_REQUEST", message: `Unknown type: ${msg.type}` });
    } catch (err) {
      sendResponse({ ok: false, code: "UNEXPECTED_ERROR", message: String(err) });
    }
  })();

  return true;
});
