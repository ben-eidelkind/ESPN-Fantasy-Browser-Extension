// background.js — adds MAIN world fallback via chrome.scripting.executeScript

function getDefaultSeason() {
  const now = new Date();
  const y = now.getFullYear();
  return now.getMonth() >= 6 ? y : y - 1;
}

async function getActiveFantasyTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  if (!tab.url.startsWith("https://fantasy.espn.com/")) return null;
  return tab;
}

// 1) Standard content-script path (extension world)
async function csFetchJson(tabId, urls) {
  const respTop = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "cs.fetchJson", urls }, { frameId: 0 }, (response) => {
      if (chrome.runtime.lastError) {
        return resolve({ ok: false, code: "CS_ERROR", message: chrome.runtime.lastError.message });
      }
      resolve(response);
    });
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

// 2) MAIN world fallback: run fetch *in the page* via executeScript
async function mainWorldFetchJson(tabId, urls) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      func: async (urls) => {
        const out = [];
        for (const u of urls) {
          try {
            const parsed = new URL(String(u));
            if (!/^https:\/\/fantasy\.espn\.com/i.test(parsed.origin)) {
              out.push({ ok: false, code: "CROSS_ORIGIN", url: u });
              continue;
            }
            const res = await fetch(parsed.toString(), {
              credentials: "include",
              headers: { "Accept": "application/json" }
            });
            if (!res.ok) {
              out.push({ ok: false, code: "HTTP_ERROR", status: res.status, statusText: res.statusText, url: u });
              continue;
            }
            let data = null;
            try { data = await res.json(); } catch {}
            if (!data) { out.push({ ok: false, code: "PARSE_ERROR", url: u }); continue; }
            out.push({ ok: true, data, url: u, path: "main-world" });
          } catch (e) {
            out.push({ ok: false, code: "NETWORK_ERROR", message: String(e), url: u });
          }
        }
        return out;
      },
      args: [urls]
    });
    return { ok: true, results: result, path: "main-world" };
  } catch (e) {
    return { ok: false, code: "EXECUTE_ERROR", message: String(e) };
  }
}

function buildUrls(leagueId, season, views) {
  const base = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  return views.map((v) => `${base}?view=${encodeURIComponent(v)}`);
}

function normalizeBundle(leagueId, season, rawMap, includeRaw) {
  const settings = rawMap.mSettings?.data ?? null;
  const teams = rawMap.mTeam?.data?.teams ?? settings?.teams ?? null;
  const rosters = rawMap.mRoster?.data ?? null;
  const matchups = rawMap.mMatchup?.data ?? rawMap.mScoreboard?.data ?? null;
  const draft = rawMap.mDraftDetail?.data ?? null;

  const teamCount = Array.isArray(teams) ? teams.length : (settings?.teams?.length || 0);
  let totalRosteredPlayers = 0;
  if (Array.isArray(rosters?.teams)) {
    for (const t of rosters.teams) {
      if (Array.isArray(t?.roster?.entries)) totalRosteredPlayers += t.roster.entries.length;
    }
  }
  const matchupCount = Array.isArray(matchups?.schedule) ? matchups.schedule.length
                        : Array.isArray(matchups?.matchups) ? matchups.matchups.length
                        : 0;

  const payload = {
    meta: {
      leagueId: String(leagueId),
      season: Number(season) || getDefaultSeason(),
      fetchedAtISO: new Date().toISOString(),
      views: ["mTeam","mRoster","mMatchup","mScoreboard","mSettings","mDraftDetail"],
      summary: { teamCount, totalRosteredPlayers, matchupCount }
    },
    league: { settings, teams, rosters, matchups, draft }
  };
  if (includeRaw) {
    payload.league.raw = {
      mTeam: rawMap.mTeam?.data ?? null,
      mRoster: rawMap.mRoster?.data ?? null,
      mMatchup: rawMap.mMatchup?.data ?? null,
      mScoreboard: rawMap.mScoreboard?.data ?? null,
      mSettings: rawMap.mSettings?.data ?? null,
      mDraftDetail: rawMap.mDraftDetail?.data ?? null
    };
  }
  return payload;
}

async function testEspnConnection(leagueId, season) {
  const tab = await getActiveFantasyTab();
  if (!tab) return { ok: false, code: "WRONG_HOST", hint: "Open your league or team page on fantasy.espn.com" };
  const [settingsUrl] = buildUrls(leagueId, season, ["mSettings"]);

  // Try extension-world path first
  let resp = await csFetchJson(tab.id, [settingsUrl]);

  // If network failed, fall back to MAIN world
  if (!resp?.ok || !Array.isArray(resp.results) || !resp.results[0] || resp.results[0].code === "NETWORK_ERROR") {
    const alt = await mainWorldFetchJson(tab.id, [settingsUrl]);
    if (alt?.ok) resp = alt;
  }

  if (!resp?.ok || !Array.isArray(resp.results) || !resp.results[0]) return resp || { ok: false, code: "NETWORK_ERROR" };
  const r = resp.results[0];
  if (r.ok) return { ok: true, path: r.path || "content-script" };
  if (r.code === "HTTP_ERROR" && (r.status === 401 || r.status === 403)) {
    return { ok: false, code: "NOT_LOGGED_IN", hint: "Log into https://www.espn.com/, refresh the fantasy page, then retry." };
  }
  return r;
}

async function fetchLeagueBundle(leagueId, season, includeRaw) {
  const tab = await getActiveFantasyTab();
  if (!tab) return { ok: false, code: "WRONG_HOST", hint: "Open your league or team page on fantasy.espn.com" };

  const views = ["mTeam","mRoster","mMatchup","mScoreboard","mSettings","mDraftDetail"];
  const urls = buildUrls(leagueId, season, views);

  // Try extension-world path first
  let resp = await csFetchJson(tab.id, urls);

  // If network failed across the board, fall back to MAIN world
  const networkFail = !resp?.ok || !Array.isArray(resp.results) || resp.results.every(r => !r || r.code === "NETWORK_ERROR");
  if (networkFail) {
    const alt = await mainWorldFetchJson(tab.id, urls);
    if (alt?.ok) resp = alt;
  }

  if (!resp?.ok || !Array.isArray(resp.results)) return resp || { ok: false, code: "NETWORK_ERROR" };

  const results = resp.results;
  const map = {};
  const failures = [];
  views.forEach((v, i) => {
    const ri = results[i];
    if (ri && ri.ok) map[v] = ri; else failures.push({ view: v, ...(ri || { code: "UNKNOWN" }) });
  });

  if (failures.length === views.length) {
    const authErr = failures.find(f => f.code === "HTTP_ERROR" && (f.status === 401 || f.status === 403));
    if (authErr) return { ok: false, code: "NOT_LOGGED_IN", hint: "Log into https://www.espn.com/, refresh the fantasy page, then retry." };
    return { ok: false, code: "NETWORK_ERROR", failures };
  }

  return { ok: true, data: normalizeBundle(leagueId, season, map, includeRaw), failures };
}

async function syncToSupabase(normalized, supabaseUrl, supabaseAnonKey, supabaseTable) {
  if (!supabaseUrl || !supabaseAnonKey || !supabaseTable) return { ok: false, message: "Missing Supabase configuration." };
  const row = {
    league_id: normalized.meta.leagueId,
    season: normalized.meta.season,
    fetched_at: normalized.meta.fetchedAtISO,
    payload: normalized
  };
  try {
    const url = `${supabaseUrl.replace(/\\/+$/, "")}/rest/v1/${encodeURIComponent(supabaseTable)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify(row)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, message: `Supabase HTTP ${res.status}`, details: text };
    }
    const body = await res.json().catch(() => []);
    return { ok: true, data: body };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "background.testConnection") {
        sendResponse(await testEspnConnection(msg.leagueId, msg.season || getDefaultSeason())); return;
      }
      if (msg?.type === "background.fetchBundle") {
        sendResponse(await fetchLeagueBundle(msg.leagueId, msg.season || getDefaultSeason(), Boolean(msg.includeRaw))); return;
      }
      if (msg?.type === "syncSupabase") {
        sendResponse(await syncToSupabase(msg.normalized, msg.supabaseUrl, msg.supabaseAnonKey, msg.supabaseTable)); return;
      }
      sendResponse({ ok: false, code: "UNKNOWN_REQUEST" });
    } catch (e) {
      sendResponse({ ok: false, code: "UNEXPECTED", message: String(e) });
    }
  })();
  return true;
});
