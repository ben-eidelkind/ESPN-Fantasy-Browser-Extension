// popup.js — robust Detect; matches popup.html IDs; full wiring

const leagueInput = document.getElementById("leagueId");
const seasonInput = document.getElementById("season");
const includeRawInput = document.getElementById("includeRaw");

const detectButton = document.getElementById("detectButton");
const testButton = document.getElementById("testButton");
const fetchButton = document.getElementById("fetchButton");
const downloadButton = document.getElementById("downloadButton");
const syncButton = document.getElementById("syncButton");
const openOptionsButton = document.getElementById("openOptions");
const togglePreviewButton = document.getElementById("togglePreview");

const statusLog = document.getElementById("statusLog");
const jsonPreview = document.getElementById("jsonPreview");

const supabaseUrlInput = document.getElementById("supabaseUrl");
const supabaseKeyInput = document.getElementById("supabaseAnonKey");
const supabaseTableInput = document.getElementById("supabaseTable");

let currentNormalized = null;
let previewExpanded = false;
let supabaseConfig = { supabaseUrl: "", supabaseAnonKey: "", supabaseTable: "espn_syncs" };

const WRONG_HOST_MESSAGE = "Open your league or team page on fantasy.espn.com, then retry.";
const NOT_LOGGED_IN_MESSAGE = "Log into https://www.espn.com/, refresh your fantasy page, then retry.";
const GENERIC_NETWORK_MESSAGE = "Network error. Temporarily disable blockers and try again.";

function logStatus(message, type = "info") {
  const entry = document.createElement("div");
  entry.className = `entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  statusLog.appendChild(entry);
  statusLog.scrollTop = statusLog.scrollHeight;
}

function storageGet(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function storageSet(vals) { return new Promise(r => chrome.storage.local.set(vals, r)); }

function getDefaultSeason() {
  const now = new Date();
  const y = now.getFullYear();
  return now.getMonth() >= 6 ? y : y - 1;
}

function getStructuredErrorMessage(response) {
  if (!response || typeof response !== "object") return GENERIC_NETWORK_MESSAGE;
  if (response.code === "WRONG_HOST") return WRONG_HOST_MESSAGE;
  if (response.code === "NOT_LOGGED_IN") return NOT_LOGGED_IN_MESSAGE;
  if (response.code === "HTTP_ERROR" && response.status) {
    return `HTTP ${response.status}${response.statusText ? " " + response.statusText : ""}`;
  }
  return GENERIC_NETWORK_MESSAGE;
}

function logFailureDetails(failures) {
  if (!Array.isArray(failures) || !failures.length) return;
  failures.forEach((f) => {
    const view = f?.view ? `${f.view}: ` : "";
    if (f?.code === "HTTP_ERROR" && f.status) {
      logStatus(`Failed ${view}HTTP ${f.status}${f.statusText ? " " + f.statusText : ""}`, "error");
    } else {
      logStatus(`Failed ${view}${f?.code || "UNKNOWN_ERROR"}${f?.message ? " ("+f.message+")" : ""}`, "error");
    }
  });
}

async function detectLeagueIdFromTab() {
  const tabs = await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, r => resolve(r || [])));
  if (!tabs.length) return null;
  const tab = tabs[0];

  const m = String(tab.url || "").match(/[?&#]leagueId=(\d+)/);
  if (m) return m[1];

  const topResp = await new Promise(res => chrome.tabs.sendMessage(tab.id, { type: "detectLeagueId" }, { frameId: 0 }, r => {
    if (chrome.runtime.lastError) return res(undefined); res(r);
  }));
  if (topResp && topResp.leagueId) return topResp.leagueId;

  const anyResp = await new Promise(res => chrome.tabs.sendMessage(tab.id, { type: "detectLeagueId" }, r => {
    if (chrome.runtime.lastError) return res(undefined); res(r);
  }));
  return anyResp?.leagueId || null;
}

async function initialize() {
  const saved = await storageGet({ leagueId: "", season: "", supabaseUrl: "", supabaseAnonKey: "", supabaseTable: "" });
  leagueInput.value = saved.leagueId || "";
  seasonInput.value = saved.season || getDefaultSeason();
  supabaseConfig = {
    supabaseUrl: saved.supabaseUrl || "",
    supabaseAnonKey: saved.supabaseAnonKey || "",
    supabaseTable: saved.supabaseTable || "espn_syncs"
  };
  supabaseUrlInput.value = supabaseConfig.supabaseUrl;
  supabaseKeyInput.value = supabaseConfig.supabaseAnonKey;
  supabaseTableInput.value = supabaseConfig.supabaseTable;
}

async function handleDetect() {
  logStatus("Detecting league ID from the active tab...");
  const id = await detectLeagueIdFromTab();
  if (id) {
    leagueInput.value = id;
    await storageSet({ leagueId: id });
    logStatus(`Detected league ID: ${id}`, "success");
  } else {
    logStatus("Could not detect a league ID. Enter it manually.", "error");
  }
}

async function handleTest() {
  logStatus("Testing ESPN connection...");
  const leagueId = leagueInput.value.trim();
  const season = (seasonInput.value.trim() || getDefaultSeason()).toString();
  if (!leagueId) { logStatus("League ID is required.", "error"); return; }
  const res = await new Promise(resolve => chrome.runtime.sendMessage({ type: "background.testConnection", leagueId, season }, r => resolve(r)));
  if (res?.ok) {
    logStatus("OK (in-page fetch).", "success");
  } else {
    logStatus(getStructuredErrorMessage(res), "error");
  }
}

async function handleFetch() {
  const leagueId = leagueInput.value.trim();
  const season = (seasonInput.value.trim() || getDefaultSeason()).toString();
  if (!leagueId) { logStatus("League ID is required.", "error"); return; }
  await storageSet({ leagueId, season });
  logStatus("Fetching league data from ESPN...");
  const res = await new Promise(resolve => chrome.runtime.sendMessage({
    type: "background.fetchBundle",
    leagueId,
    season,
    includeRaw: includeRawInput.checked
  }, r => resolve(r)));
  if (!res?.ok) {
    currentNormalized = null;
    logStatus(getStructuredErrorMessage(res), "error");
    logFailureDetails(res?.failures);
    return;
  }
  currentNormalized = res.data;
  logStatus("Fetched data (in-page fetch).", "success");
  renderPreview();
  updateButtons();
  if (Array.isArray(res.failures) && res.failures.length) {
    logStatus(`Partial failures: ${res.failures.length}`, "info");
    logFailureDetails(res.failures);
  }
}

function renderPreview() {
  if (!currentNormalized) { jsonPreview.textContent = ""; return; }
  jsonPreview.textContent = JSON.stringify(currentNormalized, null, 2);
}

function updateButtons() {
  const has = Boolean(currentNormalized);
  downloadButton.disabled = !has;
  syncButton.disabled = !has || !(supabaseConfig.supabaseUrl && supabaseConfig.supabaseAnonKey && supabaseConfig.supabaseTable);
}

function handleDownload() {
  if (!currentNormalized) return;
  const blob = new Blob([JSON.stringify(currentNormalized, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `espn-league-${currentNormalized.meta.leagueId}-${currentNormalized.meta.season}.json`;
  a.click();
  URL.revokeObjectURL(url);
  logStatus("JSON downloaded.", "success");
}

async function handleSync() {
  if (!currentNormalized) return;
  supabaseConfig = {
    supabaseUrl: supabaseUrlInput.value.trim(),
    supabaseAnonKey: supabaseKeyInput.value.trim(),
    supabaseTable: supabaseTableInput.value.trim() || "espn_syncs"
  };
  const res = await new Promise(resolve => chrome.runtime.sendMessage({
    type: "syncSupabase",
    normalized: currentNormalized,
    supabaseUrl: supabaseConfig.supabaseUrl,
    supabaseAnonKey: supabaseConfig.supabaseAnonKey,
    supabaseTable: supabaseConfig.supabaseTable
  }, r => resolve(r)));
  if (res?.ok) logStatus("Synced to Supabase.", "success");
  else logStatus(res?.message || "Supabase sync failed.", "error");
}

function handleOpenOptions() { chrome.runtime.openOptionsPage(); }

detectButton.addEventListener("click", handleDetect);
testButton.addEventListener("click", handleTest);
fetchButton.addEventListener("click", handleFetch);
downloadButton.addEventListener("click", handleDownload);
syncButton.addEventListener("click", handleSync);
openOptionsButton.addEventListener("click", handleOpenOptions);
togglePreviewButton?.addEventListener("click", () => { /* optional */ });

initialize().then(updateButtons).catch(e => console.error(e));
