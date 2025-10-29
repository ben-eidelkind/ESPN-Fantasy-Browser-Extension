const ESPN_VIEWS = [
  "mTeam",
  "mRoster",
  "mMatchup",
  "mScoreboard",
  "mSettings",
  "mDraftDetail"
];

const STATUS_MESSAGES = {
  400: "Bad request – please verify the league ID and season.",
  401: "Unauthorized – make sure you are logged in to ESPN in Chrome.",
  403: "Forbidden – your ESPN session may have expired. Refresh fantasy.espn.com and try again.",
  404: "League not found – confirm the league ID and season.",
  429: "Too many requests – retrying automatically.",
  500: "ESPN is having trouble right now. Try again later."
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    switch (message.type) {
      case "getEspnAuth":
        return await getEspnAuth();
      case "testConnection":
        return await testConnection(message);
      case "fetchData":
        return await fetchAndNormalize(message);
      case "syncSupabase":
        return await syncToSupabase(message);
      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  };

  handler()
    .then((data) => {
      if (message.type === "getEspnAuth") {
        sendResponse(data);
        return;
      }
      sendResponse({ ok: true, data });
    })
    .catch((error) => {
      console.error("ESPN Fantasy Exporter error", error);
      sendResponse({
        ok: false,
        error: error.message || "Unexpected error",
        details: error.details || null
      });
    });
  return true;
});

function withChromeCallback(fn) {
  return new Promise((resolve, reject) => {
    fn((result) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

async function ensureEspnPermission() {
  const origins = ["https://*.espn.com/*"];
  const hasPermission = await withChromeCallback((cb) =>
    chrome.permissions.contains({ origins }, cb)
  );
  if (hasPermission) {
    return true;
  }
  const granted = await withChromeCallback((cb) =>
    chrome.permissions.request({ origins }, cb)
  );
  return Boolean(granted);
}

async function getCookieAnyDomain(name) {
  const cookies = await withChromeCallback((cb) =>
    chrome.cookies.getAll({ name }, cb)
  );
  if (!Array.isArray(cookies) || !cookies.length) {
    return null;
  }
  const espnCookies = cookies.filter(
    (cookie) => typeof cookie.domain === "string" && cookie.domain.includes("espn.com")
  );
  if (!espnCookies.length) {
    return null;
  }
  const preferred = espnCookies.find(
    (cookie) => cookie.domain === ".espn.com" || cookie.hostOnly === false
  );
  const selected = preferred || espnCookies[0];
  return selected?.value || null;
}

async function getEspnAuth() {
  const hasPermission = await ensureEspnPermission();
  if (!hasPermission) {
    return { ok: false, code: "NO_PERMISSION" };
  }

  const [swid, s2] = await Promise.all([
    getCookieAnyDomain("SWID"),
    getCookieAnyDomain("espn_s2")
  ]);

  if (!swid || !s2) {
    return {
      ok: false,
      code: "MISSING_COOKIES",
      hint: "Log into https://www.espn.com/, then refresh your fantasy tab."
    };
  }

  return { ok: true, swid, s2 };
}

async function requireEspnAuth() {
  const auth = await getEspnAuth();
  if (auth.ok) {
    return auth;
  }

  const error =
    auth.code === "NO_PERMISSION"
      ? new Error("Permission to read ESPN cookies is required.")
      : new Error(auth.hint || "Missing ESPN authentication cookies.");
  error.code = auth.code;
  if (auth.hint) {
    error.details = auth.hint;
  }
  throw error;
}

function buildEspnUrl(leagueId, season, views) {
  const params = views.map((view) => `view=${view}`).join("&");
  return `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?${params}`;
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retries = 3, baseDelay = 400) {
  let attempt = 0;
  while (true) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      if (attempt >= retries) {
        const error = new Error("Network error while contacting ESPN.");
        error.details = err.message;
        throw error;
      }
      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(`Network error, retrying in ${delay}ms`);
      await wait(delay);
      attempt += 1;
      continue;
    }
    if (response.status !== 429) {
      return response;
    }
    if (attempt >= retries) {
      return response;
    }
    const delay = baseDelay * Math.pow(2, attempt);
    console.warn(`429 received, retrying in ${delay}ms`);
    await wait(delay);
    attempt += 1;
  }
}

async function fetchLeaguePayload(leagueId, season, includeViews = ESPN_VIEWS) {
  const { swid, s2 } = await requireEspnAuth();
  const url = buildEspnUrl(leagueId, season, includeViews);
  const response = await fetchWithRetry(url, {
    headers: {
      Cookie: `SWID=${swid}; espn_s2=${s2}`
    },
    credentials: "include"
  });

  if (!response.ok) {
    const text = await response.text();
    const message = STATUS_MESSAGES[response.status] || `ESPN responded with status ${response.status}.`;
    const error = new Error(message);
    error.details = text;
    error.status = response.status;
    throw error;
  }

  try {
    return await response.json();
  } catch (err) {
    const error = new Error("Failed to parse ESPN response JSON.");
    error.details = err.message;
    throw error;
  }
}

async function testConnection({ leagueId, season }) {
  if (!leagueId) {
    throw new Error("League ID is required to test the connection.");
  }
  const data = await fetchLeaguePayload(leagueId, season, ["mSettings"]);
  return {
    ok: true,
    settingsName: data?.settings?.name || null
  };
}

function normalizeLeagueData(rawData, { leagueId, season }, includeRaw) {
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
      views: ESPN_VIEWS.slice(),
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
      draft: rawData?.draftDetail || null,
      raw: includeRaw ? rawData : null
    }
  };

  return normalized;
}

async function fetchAndNormalize({ leagueId, season, includeRaw }) {
  if (!leagueId) {
    throw new Error("League ID is required.");
  }
  if (!season) {
    throw new Error("Season is required.");
  }

  const rawData = await fetchLeaguePayload(leagueId, season, ESPN_VIEWS);
  const normalized = normalizeLeagueData(rawData, { leagueId, season }, includeRaw);
  await chrome.storage.local.set({
    leagueId,
    season,
    lastSummary: normalized.meta.summary
  });
  return {
    normalized,
    summary: normalized.meta.summary
  };
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
    response: result
  };
}
