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
      if (!response) {
        reject(new Error("No response from background."));
        return;
      }
      if (response.ok) {
        resolve(response);
      } else {
        const error = new Error(response.message || response.error || "Unknown error");
        error.code = response.code;
        error.details = response.details;
        error.hint = response.hint;
        error.status = response.status;
        reject(error);
      }
    });
  });
}

function getFriendlyErrorMessage(error, fallback) {
  if (!error) {
    return fallback || "Unexpected error.";
  }
  if (error.code === "WRONG_HOST") {
    return "Open your league or team page on fantasy.espn.com, then retry.";
  }
  if (error.code === "NOT_LOGGED_IN") {
    return "Log into https://www.espn.com/, refresh the fantasy page, then retry.";
  }
  if (error.message) {
    return error.message;
  }
  return fallback || "Unexpected error.";
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
  try {
    const { leagueId, season } = validateInputs();
    logStatus("Testing ESPN connection...");
    const result = await sendMessage({ type: "testConnection", leagueId, season });
    const statusMessage =
      result.path === "content-script" ? "OK (in-page fetch)" : "OK (cookie auth)";
    const name = result.settingsName ? ` – League: ${result.settingsName}` : "";
    logStatus(`${statusMessage}${name}.`, "success");
  } catch (error) {
    const message = getFriendlyErrorMessage(error, "Failed to test ESPN connection.");
    logStatus(message, "error");
    if (error.hint && error.hint !== message) {
      logStatus(error.hint, "info");
    }
    if (error.details) {
      console.error("Test connection details", error.details);
    }
  }
}

async function handleFetch() {
  try {
    const { leagueId, season } = validateInputs();
    await storageSet({ leagueId, season });
    logStatus("Fetching league data from ESPN...");
    const response = await sendMessage({
      type: "fetchData",
      leagueId,
      season,
      includeRaw: includeRawInput.checked
    });
    const { normalized, summary } = response.data;
    currentNormalized = normalized;
    previewExpanded = false;
    renderPreview();
    updateActionButtons();
    const statusMessage =
      response.path === "content-script" ? "in-page fetch" : "cookie auth";
    logStatus(
      `Fetched data (${statusMessage}). Teams: ${summary.teamCount}, players: ${summary.totalRosteredPlayers}, matchups: ${summary.matchupCount}.`,
      "success"
    );
  } catch (error) {
    currentNormalized = null;
    renderPreview();
    updateActionButtons();
    const message = getFriendlyErrorMessage(error, "Failed to fetch data from ESPN.");
    logStatus(message, "error");
    if (error.hint && error.hint !== message) {
      logStatus(error.hint, "info");
    }
    if (error.details) {
      console.error("Fetch details", error.details);
    }
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
    await sendMessage({
      type: "syncSupabase",
      normalized: currentNormalized,
      supabaseUrl: supabaseConfig.supabaseUrl,
      supabaseAnonKey: supabaseConfig.supabaseAnonKey,
      supabaseTable: supabaseConfig.supabaseTable || "espn_syncs"
    });
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
