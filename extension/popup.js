
// popup.js — matches popup.html IDs; robust Detect; uses existing UI

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

function logStatus(message, type = "info") {
  const entry = document.createElement("div");
  entry.className = `entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  statusLog.appendChild(entry);
  statusLog.scrollTop = statusLog.scrollHeight;
}

// Robust leagueId detection
async function detectLeagueIdFromTab() {
  const tabs = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (result) => resolve(result || []));
  });
  if (!tabs.length) return null;
  const tab = tabs[0];

  const match = String(tab.url || "").match(/[?&#]leagueId=(\d+)/);
  if (match) return match[1];

  const respTop = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "detectLeagueId" }, { frameId: 0 }, (response) => {
      if (chrome.runtime.lastError) return resolve(undefined);
      resolve(response);
    });
  });
  if (respTop && respTop.leagueId) return respTop.leagueId;

  const respAny = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "detectLeagueId" }, (response) => {
      if (chrome.runtime.lastError) return resolve(undefined);
      resolve(response);
    });
  });
  return respAny?.leagueId || null;
}

detectButton.addEventListener("click", async () => {
  logStatus("Detecting league ID from the active tab...");
  const id = await detectLeagueIdFromTab();
  if (id) {
    leagueInput.value = id;
    logStatus("Detected league ID: " + id, "success");
  } else {
    logStatus("Could not detect a league ID. Enter it manually.", "error");
  }
});

// Example listeners for other buttons (no-op if unchanged)
testButton.addEventListener("click", () => logStatus("Testing ESPN connection..."));
fetchButton.addEventListener("click", () => logStatus("Fetching data..."));
downloadButton.addEventListener("click", () => logStatus("Downloading JSON..."));
syncButton.addEventListener("click", () => logStatus("Syncing to Supabase..."));
openOptionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
togglePreviewButton.addEventListener("click", () => logStatus("Toggling preview..."));
