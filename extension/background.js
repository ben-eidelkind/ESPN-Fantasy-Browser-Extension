// background.js
// Orchestrates content-script fetches and normalizes data. No Cookie headers here.

function getDefaultSeason() {
  const now = new Date();
  const y = now.getFullYear();
  return now.getMonth() >= 6 ? y : y - 1; // July switch
}

async function getActiveFantasyTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  if (!tab.url.startsWith("https://fantasy.espn.com/")) return null;
  return tab;
}

// Send message to TOP FRAME (frameId: 0) first; fall back if needed.
async function csFetchJson(tabId, urls) {
  // Try top frame
  const topResp = await new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: "cs.fetchJson", urls },
      { frameId: 0 },
      (resp) => {
        if (chrome.runtime.lastError) {
          return resolve({
            ok: false,
            code: "CS_ERROR",
            message: chrome.runtime.lastError.message
          });
        }
        resolve(resp);
      }
    );
  });
  if (topResp) return topResp;

  // Fallback default routing
  return await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "cs.fetchJson", urls }, (resp) => {
      if (chrome.runtime.lastError) {
        return resolve({
          ok: false,
          code: "CS_ERROR",
          message: chrome.runtime.lastError.message
        });
      }
      resolve(resp || { ok: false, code: "CS_ERROR", message: "No response from content script." });
    });
  });
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

  // counts
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
    league: {
      settings,
      teams,
      rosters,
      matchups,
      draft
    }
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
  if (!tab) {
    return { ok: false, code: "WRONG_HOST", hint: "Open your league or team page on fantasy.espn.com" };
  }
  const [settingsUrl] = buildUrls(leagueId, season, ["mSettings"]);
  const resp = await csFetchJson(tab.id, [settingsUrl]);

  if (!resp?.ok || !Array.isArray(resp.results) || !resp.results[0]) {
    return resp || { ok: false, code: "NETWORK_ERROR" };
  }
  const r = resp.results[0];
  if (r.ok) return { ok: true, path: "content-script" };
  if (r.code === "HTTP_ERROR" && (r.status === 401 || r.status === 403)) {
    return { ok: false, code: "NOT_LOGGED_IN", hint: "Log into https://www.espn.com/, refresh the fantasy page, then retry." };
  }
  return r; // surface HTTP_ERROR / PARSE_ERROR / NETWORK_ERROR
}

async function fetchLeagueBundle(leagueId, season, includeRaw) {
  const tab = await getActiveFantasyTab();
  if (!tab) {
    return { ok: false, code: "WRONG_HOST", hint: "Open your league or team page on fantasy.espn.com" };
  }

  const views = ["mTeam","mRoster","mMatchup","mScoreboard","mSettings","mDraftDetail"];
  const urls = buildUrls(leagueId, season, views);
  const resp = await csFetchJson(tab.id, urls);
  if (!resp?.ok || !Array.isArray(resp.results)) return resp || { ok: false, code: "NETWORK_ERROR" };

  const results = resp.results;
  const map = {};
  const failures = [];

  views.forEach((v, i) => {
    const ri = results[i];
    if (ri && ri.ok) map[v] = ri;
    else failures.push({ view: v, ...(ri || { code: "UNKNOWN" }) });
  });

  // if ALL failed with network, bubble up a single error
  if (failures.length === views.length) {
    // If at least one is 401/403, treat as not logged in
    const authErr = failures.find(f => f.code === "HTTP_ERROR" && (f.status === 401 || f.status === 403));
    if (authErr) return { ok: false, code: "NOT_LOGGED_IN", hint: "Log into https://www.espn.com/, refresh the fantasy page, then retry." };
    return { ok: false, code: "NETWORK_ERROR", failures };
  }

  const data = normalizeBundle(leagueId, season, map, includeRaw);
  return { ok: true, data, failures };
}

async function syncToSupabase(normalized, supabaseUrl, supabaseAnonKey, supabaseTable) {
  if (!supabaseUrl || !supabaseAnonKey || !supabaseTable) {
    return { ok: false, message: "Missing Supabase configuration." };
  }
  const row = {
    league_id: normalized.meta.leagueId,
    season: normalized.meta.season,
    fetched_at: normalized.meta.fetchedAtISO,
    payload: normalized
  };
  try {
    const url = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/${encodeURIComponent(supabaseTable)}`;
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

// ------- Message wiring -------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "background.testConnection") {
        const leagueId = msg.leagueId;
        const season = msg.season || getDefaultSeason();
        const out = await testEspnConnection(leagueId, season);
        sendResponse(out);
        return;
      }

      if (msg?.type === "background.fetchBundle") {
        const leagueId = msg.leagueId;
        const season = msg.season || getDefaultSeason();
        const includeRaw = Boolean(msg.includeRaw);
        const out = await fetchLeagueBundle(leagueId, season, includeRaw);
        sendResponse(out);
        return;
      }

      if (msg?.type === "syncSupabase") {
        const { normalized, supabaseUrl, supabaseAnonKey, supabaseTable } = msg;
        const out = await syncToSupabase(normalized, supabaseUrl, supabaseAnonKey, supabaseTable);
        sendResponse(out);
        return;
      }

      sendResponse({ ok: false, code: "UNKNOWN_REQUEST" });
    } catch (e) {
      sendResponse({ ok: false, code: "UNEXPECTED", message: String(e) });
    }
  })();
  return true; // async
});
