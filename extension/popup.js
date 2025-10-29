const leagueInput = document.getElementById("leagueId");
const seasonInput = document.getElementById("season");
const includeRawInput = document.getElementById("includeRaw");
const detectButton = document.getElementById("detectButton");
const testButton = document.getElementById("testButton");
const fetchButton = document.getElementById("fetchButton");
const downloadButton = document.getElementById("downloadButton");
const syncButton = document.getElementById("syncButton");
const openOptionsButton = document.getElementById("openOptions");
const statusLog = document.getElementById("statusLog");
const jsonPreview = document.getElementById("jsonPreview");
const togglePreviewButton = document.getElementById("togglePreview");
const supabaseUrlInput = document.getElementById("supabaseUrl");
const supabaseKeyInput = document.getElementById("supabaseAnonKey");
const supabaseTableInput = document.getElementById("supabaseTable");

let currentNormalized = null;
let previewExpanded = false;
let supabaseConfig = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  supabaseTable: "espn_syncs"
};

const WRONG_HOST_MESSAGE = "Open your league or team page on fantasy.espn.com, then retry.";
const NOT_LOGGED_IN_MESSAGE = "Log into https://www.espn.com/, refresh your fantasy page, then retry.";
const GENERIC_NETWORK_MESSAGE = "Network error. Temporarily disable blockers and try again.";

function getDefaultSeason() {
  const now = new Date();
  const year = now.getFullYear();
  return now.getMonth() >= 6 ? year : year - 1;
}

function logStatus(message, type = "info") {
  const entry = document.createElement("div");
  entry.className = `entry ${type}`;
  const timestamp = new Date().toLocaleTimeString();
  entry.textContent = `[${timestamp}] ${message}`;
  statusLog.appendChild(entry);
  statusLog.scrollTop = statusLog.scrollHeight;
}

function clearStatusLog() {
  statusLog.textContent = "";
}

function updateActionButtons() {
  const hasData = Boolean(currentNormalized);
  downloadButton.disabled = !hasData;
  togglePreviewButton.disabled = !hasData;
  togglePreviewButton.textContent = previewExpanded ? "Show less" : "Show more";

  const hasSupabaseConfig = Boolean(
    supabaseConfig.supabaseUrl && supabaseConfig.supabaseAnonKey && supabaseConfig.supabaseTable
  );
  syncButton.disabled = !hasData || !hasSupabaseConfig;
}

function renderPreview() {
  if (!currentNormalized) {
    jsonPreview.textContent = "";
    jsonPreview.classList.remove("expanded");
    previewExpanded = false;
    togglePreviewButton.textContent = "Show more";
    return;
  }
  const text = JSON.stringify(currentNormalized, null, 2);
  jsonPreview.textContent = text;
  jsonPreview.classList.toggle("expanded", previewExpanded);
  togglePreviewButton.textContent = previewExpanded ? "Show less" : "Show more";
}

function handleTogglePreview() {
  previewExpanded = !previewExpanded;
  renderPreview();
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, resolve);
  });
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response === undefined) {
        reject(new Error("No response from background."));
        return;
      }
      resolve(response);
    });
  });
}

function getStructuredErrorMessage(response) {
  if (!response || typeof response !== "object") {
    return GENERIC_NETWORK_MESSAGE;
  }
  if (response.code === "WRONG_HOST") {
    return WRONG_HOST_MESSAGE;
  }
  if (response.code === "NOT_LOGGED_IN") {
    return NOT_LOGGED_IN_MESSAGE;
  }
  if (response.code === "HTTP_ERROR" && response.status) {
    const statusText = response.statusText ? ` ${response.statusText}` : "";
    return `HTTP ${response.status}${statusText}`;
  }
  return GENERIC_NETWORK_MESSAGE;
}

function logFailureDetails(failures) {
  if (!Array.isArray(failures) || !failures.length) return;
  failures.forEach((failure) => {
    const viewLabel = failure?.view ? `${failure.view}: ` : "";
    if (failure?.code === "HTTP_ERROR" && failure.status) {
      const statusText = failure.statusText ? ` ${failure.statusText}` : "";
      logStatus(`Failed ${viewLabel}HTTP ${failure.status}${statusText}`, "error");
      return;
    }
    const extra = failure?.message ? ` (${failure.message})` : "";
    logStatus(`Failed ${viewLabel}${failure?.code || "UNKNOWN_ERROR"}${extra}`, "error");
  });
}

async function detectLeagueIdFromTab() {
  const tabs = await new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || []);
    });
  });
  if (!tabs.length) {
    throw new Error("No active tab found.");
  }
  const tabId = tabs[0].id;
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "detectLeagueId" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error("Unable to access the page. Open fantasy.espn.com."));
        return;
      }
      resolve(response?.leagueId || null);
    });
  });
}

function validateInputs() {
  const leagueId = leagueInput.value.trim();
  const season = seasonInput.value.trim();
  if (!leagueId) {
    throw new Error("League ID is required.");
  }
  if (!/^\d+$/.test(leagueId)) {
    throw new Error("League ID must be numeric.");
  }
  if (!season) {
    throw new Error("Season is required.");
  }
  return { leagueId, season };
}

async function initialize() {
  const defaults = await storageGet({
    leagueId: null,
    season: null,
    supabaseUrl: "",
    supabaseAnonKey: "",
    supabaseTable: "",
    lastSummary: null
  });

  leagueInput.value = defaults.leagueId || "";
  seasonInput.value = defaults.season || getDefaultSeason();
  supabaseConfig = {
    supabaseUrl: defaults.supabaseUrl || "",
    supabaseAnonKey: defaults.supabaseAnonKey || "",
    supabaseTable: defaults.supabaseTable || "espn_syncs"
  };
  supabaseUrlInput.value = supabaseConfig.supabaseUrl;
  supabaseKeyInput.value = supabaseConfig.supabaseAnonKey;
  supabaseTableInput.value = supabaseConfig.supabaseTable;

  if (defaults.lastSummary) {
    logStatus(`Last fetch: ${JSON.stringify(defaults.lastSummary)}`, "info");
  }

  updateActionButtons();
}

async function handleDetectClick() {
  logStatus("Detecting league ID from the active tab...");
  try {
    const detected = await detectLeagueIdFromTab();
    if (detected) {
      leagueInput.value = detected;
      await storageSet({ leagueId: detected });
      logStatus(`Detected league ID ${detected}.`, "success");
    } else {
      logStatus("Could not detect a league ID. Enter it manually.", "error");
    }
  } catch (error) {
    logStatus(error.message, "error");
  }
}

async function handleTestConnection() {
  clearStatusLog();
  let leagueId;
  let season;
  try {
    ({ leagueId, season } = validateInputs());
  } catch (error) {
    logStatus(error.message, "error");
    return;
  }

  try {
    logStatus("Testing ESPN connection...");
    const response = await sendMessage({
      type: "background.testConnection",
      leagueId,
      season
    });
    if (response?.ok) {
      logStatus("OK (in-page fetch).", "success");
      return;
    }
    const message = getStructuredErrorMessage(response);
    logStatus(message, "error");
  } catch (error) {
    console.error("Test connection failed", error);
    logStatus(GENERIC_NETWORK_MESSAGE, "error");
  }
}

async function handleFetch() {
  let leagueId;
  let season;
  try {
    ({ leagueId, season } = validateInputs());
  } catch (error) {
    logStatus(error.message, "error");
    return;
  }

  try {
    await storageSet({ leagueId, season });
    logStatus("Fetching league data from ESPN...");
    const response = await sendMessage({
      type: "background.fetchBundle",
      leagueId,
      season,
      includeRaw: includeRawInput.checked
    });

    if (!response?.ok) {
      currentNormalized = null;
      renderPreview();
      updateActionButtons();
      const message = getStructuredErrorMessage(response);
      logStatus(message, "error");
      logFailureDetails(response?.failures);
      return;
    }

    const normalized = response.data;
    const summary = normalized?.meta?.summary || {
      teamCount: 0,
      totalRosteredPlayers: 0,
      matchupCount: 0
    };
    currentNormalized = normalized;
    previewExpanded = false;
    renderPreview();
    updateActionButtons();
    logStatus(
      `Fetched data (in-page fetch). Teams: ${summary.teamCount}, players: ${summary.totalRosteredPlayers}, matchups: ${summary.matchupCount}.`,
      "success"
    );
    if (Array.isArray(response.failures) && response.failures.length) {
      logStatus(`Partial failures: ${response.failures.length}`, "info");
      logFailureDetails(response.failures);
    }
  } catch (error) {
    console.error("Fetch failed", error);
    currentNormalized = null;
    renderPreview();
    updateActionButtons();
    logStatus(GENERIC_NETWORK_MESSAGE, "error");
  }
}

function handleDownload() {
  if (!currentNormalized) {
    return;
  }
  const blob = new Blob([JSON.stringify(currentNormalized, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const filename = `espn-league-${currentNormalized.meta.leagueId}-${currentNormalized.meta.season}.json`;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  logStatus(`Downloaded ${filename}.`, "success");
}

async function handleSync() {
  if (!currentNormalized) {
    return;
  }
  try {
    logStatus("Syncing to Supabase...");
    const response = await sendMessage({
      type: "syncSupabase",
      normalized: currentNormalized,
      supabaseUrl: supabaseConfig.supabaseUrl,
      supabaseAnonKey: supabaseConfig.supabaseAnonKey,
      supabaseTable: supabaseConfig.supabaseTable || "espn_syncs"
    });
    if (!response?.ok) {
      const error = new Error(response?.message || "Supabase sync failed.");
      error.details = response?.details;
      throw error;
    }
    logStatus("Supabase sync complete.", "success");
  } catch (error) {
    logStatus(error.message, "error");
    if (error.details) {
      console.error("Supabase sync details", error.details);
    }
  }
}

function handleOpenOptions() {
  chrome.runtime.openOptionsPage();
}

function handleStorageChange(changes) {
  if (changes.supabaseUrl || changes.supabaseAnonKey || changes.supabaseTable) {
    supabaseConfig.supabaseUrl = changes.supabaseUrl?.newValue || supabaseConfig.supabaseUrl || "";
    supabaseConfig.supabaseAnonKey = changes.supabaseAnonKey?.newValue || supabaseConfig.supabaseAnonKey || "";
    supabaseConfig.supabaseTable = changes.supabaseTable?.newValue || supabaseConfig.supabaseTable || "espn_syncs";
    supabaseUrlInput.value = supabaseConfig.supabaseUrl;
    supabaseKeyInput.value = supabaseConfig.supabaseAnonKey;
    supabaseTableInput.value = supabaseConfig.supabaseTable;
    updateActionButtons();
  }
}

leagueInput.addEventListener("change", () => storageSet({ leagueId: leagueInput.value.trim() }));
seasonInput.addEventListener("change", () => storageSet({ season: seasonInput.value.trim() }));
detectButton.addEventListener("click", handleDetectClick);
testButton.addEventListener("click", handleTestConnection);
fetchButton.addEventListener("click", handleFetch);
downloadButton.addEventListener("click", handleDownload);
syncButton.addEventListener("click", handleSync);
openOptionsButton.addEventListener("click", handleOpenOptions);
togglePreviewButton.addEventListener("click", handleTogglePreview);
chrome.storage.onChanged.addListener(handleStorageChange);

initialize().catch((error) => {
  console.error("Initialization error", error);
  logStatus("Failed to initialize popup.", "error");
});
