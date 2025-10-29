const ESPN_VIEWS = [
  "mTeam",
  "mRoster",
  "mMatchup",
  "mScoreboard",
  "mSettings",
  "mDraftDetail"
];

const WRONG_HOST_HINT = "Open your league or team page on fantasy.espn.com";
const LOGIN_HINT = "Log into https://www.espn.com/, refresh the fantasy page, then retry.";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      let result;
      switch (message?.type) {
        case "background.testConnection":
          result = await testEspnConnection(message.leagueId, message.season);
          break;
        case "background.fetchBundle":
          result = await fetchLeagueBundle(
            message.leagueId,
            message.season,
            Boolean(message.includeRaw)
          );
          break;
        case "syncSupabase":
          result = await syncToSupabase(message);
          break;
        default:
          result = {
            ok: false,
            code: "UNKNOWN_REQUEST",
            message: `Unknown message type: ${message?.type}`
          };
      }

      if (!result) {
        sendResponse({ ok: false, code: "NO_RESPONSE", message: "No result available." });
        return;
      }

      sendResponse(result);
    } catch (error) {
      console.error("Background error", error);
      sendResponse({
        ok: false,
        code: "UNEXPECTED_ERROR",
        message: error?.message || "Unexpected error"
      });
    }
  })();

  return true;
});

function buildEspnUrl(leagueId, season, view) {
  return `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=${view}`;
}

async function getActiveFantasyTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Array.isArray(tabs) || !tabs.length) {
    return null;
  }
  const [tab] = tabs;
  if (!tab?.url || !tab.url.startsWith("https://fantasy.espn.com/")) {
    return null;
  }
  return tab;
}

async function csFetchJson(tabId, urls) {
  return await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "cs.fetchJson", urls }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          code: "CS_ERROR",
          message: chrome.runtime.lastError.message
        });
        return;
      }
      if (!response) {
        resolve({ ok: false, code: "CS_ERROR", message: "No response from content script." });
        return;
      }
      resolve(response);
    });
  });
}

function isUnauthorizedStatus(status) {
  return status === 401 || status === 403;
}

async function testEspnConnection(leagueId, season) {
  if (!leagueId) {
    return { ok: false, code: "MISSING_LEAGUE", message: "League ID is required." };
  }
  if (!season) {
    return { ok: false, code: "MISSING_SEASON", message: "Season is required." };
  }

  const settingsUrl = buildEspnUrl(leagueId, season, "mSettings");
  const tab = await getActiveFantasyTab();
  if (!tab) {
    return { ok: false, code: "WRONG_HOST", hint: WRONG_HOST_HINT };
  }

  const response = await csFetchJson(tab.id, [settingsUrl]);
  if (!response?.ok) {
    return {
      ok: false,
      code: response?.code || "CS_ERROR",
      message: response?.message || "Content script error."
    };
  }

  const [result] = Array.isArray(response.results) ? response.results : [];
  if (result?.ok) {
    return { ok: true, path: "content-script" };
  }

  if (result?.code === "HTTP_ERROR" && isUnauthorizedStatus(result.status)) {
    return { ok: false, code: "NOT_LOGGED_IN", hint: LOGIN_HINT };
  }

  if (result?.code === "HTTP_ERROR") {
    return {
      ok: false,
      code: "HTTP_ERROR",
      status: result.status,
      statusText: result.statusText,
      message: result.message
    };
  }

  return {
    ok: false,
    code: result?.code || "NETWORK_ERROR",
    message: result?.message || "Network error."
  };
}

function mergeViewData(target, source) {
  if (!source || typeof source !== "object") {
    return target;
  }
  Object.entries(source).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      target[key] = value;
      return;
    }
    if (value && typeof value === "object") {
      const current = target[key];
      const base =
        current && typeof current === "object" && !Array.isArray(current)
          ? current
          : {};
      target[key] = mergeViewData(base, value);
      return;
    }
    target[key] = value;
  });
  return target;
}

function normalizeLeagueData(rawData, { leagueId, season }, options = {}) {
  const { includeRaw = false, views = [] } = options;
  const teams = Array.isArray(rawData?.teams) ? rawData.teams : [];
  const rosters = teams.map((team) => ({
    teamId: team.id,
    entries: team?.roster?.entries || [],
    totalPlayers: (team?.roster?.entries || []).length
  }));
  const totalRosteredPlayers = rosters.reduce((acc, roster) => acc + roster.entries.length, 0);
  const scoreboard = rawData?.scoreboard || null;
  const schedule = Array.isArray(rawData?.schedule)
    ? rawData.schedule
    : Array.isArray(scoreboard?.matchups)
    ? scoreboard.matchups
    : Array.isArray(scoreboard?.schedule)
    ? scoreboard.schedule
    : [];

  const normalized = {
    meta: {
      leagueId,
      season,
      fetchedAtISO: new Date().toISOString(),
      views,
      summary: {
        teamCount: teams.length,
        totalRosteredPlayers,
        matchupCount: schedule.length
      }
    },
    league: {
      settings: rawData?.settings || null,
      teams,
      rosters,
      matchups: schedule,
      draft: rawData?.draftDetail || null
    }
  };

  if (includeRaw) {
    normalized.league.raw = rawData;
  }

  return normalized;
}

async function fetchLeagueBundle(leagueId, season, includeRaw = false) {
  if (!leagueId) {
    return { ok: false, code: "MISSING_LEAGUE", message: "League ID is required." };
  }
  if (!season) {
    return { ok: false, code: "MISSING_SEASON", message: "Season is required." };
  }

  const viewRequests = ESPN_VIEWS.map((view) => ({
    view,
    url: buildEspnUrl(leagueId, season, view)
  }));

  const tab = await getActiveFantasyTab();
  if (!tab) {
    return { ok: false, code: "WRONG_HOST", hint: WRONG_HOST_HINT };
  }

  const response = await csFetchJson(
    tab.id,
    viewRequests.map((request) => request.url)
  );
  if (!response?.ok) {
    return {
      ok: false,
      code: response?.code || "CS_ERROR",
      message: response?.message || "Content script error."
    };
  }

  const results = Array.isArray(response.results) ? response.results : [];
  const combined = {};
  const viewsFetched = [];
  const failures = [];

  for (let i = 0; i < viewRequests.length; i += 1) {
    const request = viewRequests[i];
    const result = results[i];
    if (result?.ok) {
      mergeViewData(combined, result.data);
      viewsFetched.push(request.view);
    } else {
      const failure = {
        ok: false,
        view: request.view,
        url: request.url,
        code: result?.code || "UNKNOWN_ERROR",
        status: result?.status,
        statusText: result?.statusText,
        message: result?.message
      };
      failures.push(failure);
    }
  }

  const unauthorizedFailure = failures.find((failure) =>
    failure.code === "HTTP_ERROR" && isUnauthorizedStatus(failure.status)
  );

  if (unauthorizedFailure) {
    return {
      ok: false,
      code: "NOT_LOGGED_IN",
      hint: LOGIN_HINT,
      failures
    };
  }

  if (!viewsFetched.length) {
    const primaryFailure = failures[0] || {
      code: "NETWORK_ERROR",
      message: "Unable to reach ESPN."
    };
    return {
      ok: false,
      code: primaryFailure.code,
      status: primaryFailure.status,
      statusText: primaryFailure.statusText,
      message: primaryFailure.message,
      failures: failures.length ? failures : undefined
    };
  }

  const normalized = normalizeLeagueData(combined, { leagueId, season }, {
    includeRaw,
    views: viewsFetched
  });

  await chrome.storage.local.set({
    leagueId,
    season,
    lastSummary: normalized.meta.summary
  });

  const responsePayload = {
    ok: true,
    path: "content-script",
    data: normalized
  };

  if (failures.length) {
    responsePayload.failures = failures;
  }

  return responsePayload;
}

async function syncToSupabase({ normalized, supabaseUrl, supabaseAnonKey, supabaseTable }) {
  if (!normalized) {
    throw new Error("No data available to sync. Fetch league data first.");
  }
  if (!supabaseUrl || !supabaseAnonKey || !supabaseTable) {
    throw new Error("Supabase URL, anon key, and table are required. Configure them in Options.");
  }

  const endpoint = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/${supabaseTable}`;
  const body = {
    league_id: normalized.meta.leagueId,
    season: normalized.meta.season,
    fetched_at: normalized.meta.fetchedAtISO,
    payload: normalized
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    const error = new Error("Network error while contacting Supabase.");
    error.details = err.message;
    throw error;
  }

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Supabase responded with status ${response.status}.`);
    error.details = text;
    throw error;
  }

  let result;
  try {
    result = await response.json();
  } catch (err) {
    result = null;
  }

  await chrome.storage.local.set({
    lastSyncedAt: new Date().toISOString()
  });

  return {
    ok: true,
    data: {
      response: result
    }
  };
}
