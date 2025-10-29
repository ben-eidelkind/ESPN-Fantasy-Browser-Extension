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
  (async () => {
    try {
      let result;
      switch (message.type) {
        case "getEspnAuth":
          result = await getEspnAuth();
          break;
        case "testConnection":
          result = await testConnection(message);
          break;
        case "fetchData":
          result = await fetchAndNormalize(message);
          break;
        case "syncSupabase":
          result = await syncToSupabase(message);
          break;
        default:
          result = {
            ok: false,
            code: "UNKNOWN_REQUEST",
            message: `Unknown message type: ${message.type}`
          };
          break;
      }
      if (result?.ok === undefined) {
        result = { ok: true, data: result };
      }
      sendResponse(result);
    } catch (error) {
      console.error("ESPN Fantasy Exporter error", error);
      const response = {
        ok: false,
        message: error.message || "Unexpected error"
      };
      if (error.code) {
        response.code = error.code;
      }
      if (error.details) {
        response.details = error.details;
      }
      if (error.hint) {
        response.hint = error.hint;
      }
      sendResponse(response);
    }
  })();
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

function buildEspnUrl(leagueId, season, views) {
  const params = views.map((view) => `view=${view}`).join("&");
  return `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?${params}`;
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retries = 3, baseDelay = 400) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isFantasyTab(tab) {
  return Boolean(tab?.url && tab.url.startsWith("https://fantasy.espn.com/"));
}

async function fetchEspnViaContentScript(tabId, url) {
  return await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "cs.fetchEspn", url }, (resp) => {
      if (chrome.runtime.lastError) {
        return resolve({
          ok: false,
          code: "CS_MESSAGING_ERROR",
          message: chrome.runtime.lastError.message
        });
      }
      resolve(resp);
    });
  });
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

function statusMessageFromResponse(status, statusText) {
  if (!status) {
    return "Unexpected response from ESPN.";
  }
  return (
    STATUS_MESSAGES[status] ||
    `ESPN responded with status ${status}${statusText ? ` ${statusText}` : ""}.`
  );
}

function isUnauthorizedStatus(status) {
  return status === 401 || status === 403;
}

async function fetchEspnJsonWithCookies(url, auth) {
  let response;
  try {
    response = await fetchWithRetry(url, {
      headers: {
        Cookie: `SWID=${auth.swid}; espn_s2=${auth.s2}`,
        Accept: "application/json"
      },
      credentials: "include"
    });
  } catch (error) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: error.message || "Network error while contacting ESPN.",
      details: error.details
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: "HTTP_ERROR",
      status: response.status,
      statusText: response.statusText,
      message: statusMessageFromResponse(response.status, response.statusText)
    };
  }

  try {
    const data = await response.json();
    return { ok: true, data, path: "cookies" };
  } catch (err) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: "Failed to parse ESPN response JSON.",
      details: err.message
    };
  }
}

async function fetchViewsViaContentScript(tabId, leagueId, season, views) {
  const aggregate = {};
  for (const view of views) {
    const url = buildEspnUrl(leagueId, season, [view]);
    const resp = await fetchEspnViaContentScript(tabId, url);
    if (!resp) {
      return {
        ok: false,
        code: "CS_NO_RESPONSE",
        message: "No response from content script."
      };
    }
    if (!resp.ok) {
      return resp;
    }
    mergeViewData(aggregate, resp.data);
  }
  return { ok: true, data: aggregate, path: "content-script" };
}

async function fetchLeaguePayload(leagueId, season, includeViews = ESPN_VIEWS) {
  const views = Array.isArray(includeViews) ? includeViews : [includeViews];
  const combinedUrl = buildEspnUrl(leagueId, season, views);

  const auth = await getEspnAuth();
  let shouldFallback = false;

  if (auth?.ok) {
    const cookieResult = await fetchEspnJsonWithCookies(combinedUrl, auth);
    if (cookieResult.ok) {
      return cookieResult;
    }
    if (cookieResult.code === "HTTP_ERROR" && isUnauthorizedStatus(cookieResult.status)) {
      shouldFallback = true;
    } else {
      return cookieResult;
    }
  } else if (auth?.code === "MISSING_COOKIES") {
    shouldFallback = true;
  } else if (auth?.code) {
    return {
      ok: false,
      code: auth.code,
      message: auth.hint || "Unable to access ESPN authentication cookies.",
      hint: auth.hint
    };
  } else {
    return {
      ok: false,
      code: "UNKNOWN_AUTH",
      message: "Unable to read ESPN authentication cookies."
    };
  }

  if (!shouldFallback) {
    return {
      ok: false,
      code: "FETCH_ABORTED",
      message: "Unable to fetch ESPN data."
    };
  }

  const tab = await getActiveTab();
  if (!isFantasyTab(tab)) {
    const message = "Open your fantasy.espn.com league or team page and try again.";
    return {
      ok: false,
      code: "WRONG_HOST",
      message,
      hint: message
    };
  }

  const csResult = await fetchViewsViaContentScript(tab.id, leagueId, season, views);
  if (!csResult) {
    return {
      ok: false,
      code: "CS_NO_RESPONSE",
      message: "No response from content script."
    };
  }
  if (csResult.ok) {
    return csResult;
  }

  if (csResult.code === "HTTP_ERROR" && isUnauthorizedStatus(csResult.status)) {
    const message = "Log into https://www.espn.com/, refresh the fantasy page, then retry.";
    return {
      ok: false,
      code: "NOT_LOGGED_IN",
      message,
      hint: message,
      status: csResult.status,
      statusText: csResult.statusText
    };
  }

  if (csResult.code === "HTTP_ERROR" && csResult.status) {
    return {
      ok: false,
      code: csResult.code,
      status: csResult.status,
      statusText: csResult.statusText,
      message: statusMessageFromResponse(csResult.status, csResult.statusText)
    };
  }

  return csResult;
}

async function testConnection({ leagueId, season }) {
  if (!leagueId) {
    return {
      ok: false,
      code: "MISSING_LEAGUE",
      message: "League ID is required to test the connection."
    };
  }
  if (!season) {
    return {
      ok: false,
      code: "MISSING_SEASON",
      message: "Season is required to test the connection."
    };
  }

  const result = await fetchLeaguePayload(leagueId, season, ["mSettings"]);
  if (!result.ok) {
    return result;
  }

  const settingsName = result.data?.settings?.name || null;
  return { ok: true, path: result.path, settingsName };
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
    return { ok: false, code: "MISSING_LEAGUE", message: "League ID is required." };
  }
  if (!season) {
    return { ok: false, code: "MISSING_SEASON", message: "Season is required." };
  }

  const result = await fetchLeaguePayload(leagueId, season, ESPN_VIEWS);
  if (!result.ok) {
    return result;
  }

  const rawData = result.data;
  const normalized = normalizeLeagueData(rawData, { leagueId, season }, includeRaw);
  await chrome.storage.local.set({
    leagueId,
    season,
    lastSummary: normalized.meta.summary
  });
  return {
    ok: true,
    path: result.path,
    data: {
      normalized,
      summary: normalized.meta.summary
    }
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
    ok: true,
    data: {
      response: result
    }
  };
}
