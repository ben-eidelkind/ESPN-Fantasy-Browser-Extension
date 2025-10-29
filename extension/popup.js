// popup.js — detects leagueId robustly and communicates with background.js

const statusEl = document.getElementById("status");
const detectBtn = document.getElementById("detectLeague");
const leagueIdInput = document.getElementById("leagueId");
const seasonInput = document.getElementById("season");
const includeRawInput = document.getElementById("includeRaw");
const supabaseUrlInput = document.getElementById("supabaseUrl");
const supabaseKeyInput = document.getElementById("supabaseAnonKey");
const supabaseTableInput = document.getElementById("supabaseTable");
const testBtn = document.getElementById("testConnection");
const fetchBtn = document.getElementById("fetchData");
const syncBtn = document.getElementById("syncSupabase");
const downloadBtn = document.getElementById("downloadJson");

function logStatus(message, type = "info") {
  const time = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  line.textContent = `[${time}] ${message}`;
  line.className = type;
  statusEl.prepend(line);
}

async function detectLeagueIdFromTab() {
  logStatus("Detecting league ID from the active tab...");

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) {
    logStatus("No active tab found.", "error");
    return null;
  }

  const tab = tabs[0];
  const url = tab.url || "";

  // ✅ Step 1: try parsing the leagueId from the tab URL directly
  const match = url.match(/[?&#]leagueId=(\d+)/);
  if (match) {
    const id = match[1];
    logStatus(`Detected league ID from URL: ${id}`);
    return id;
  }

  // ✅ Step 2: ask the content script in top frame
  try {
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tab.id,
        { type: "detectLeagueId" },
        { frameId: 0 },
        (resp) => {
          if (chrome.runtime.lastError) {
            return resolve(null);
          }
          resolve(resp?.leagueId || null);
        }
      );
    });

    if (response) {
      logStatus(`Detected league ID via content script: ${response}`);
      return response;
    }
  } catch (_) {}

  // ✅ Step 3: fallback — try content script again (no frame)
  try {
    const response2 = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: "detectLeagueId" }, (resp) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(resp?.leagueId || null);
      });
    });

    if (response2) {
      logStatus(`Detected league ID (fallback): ${response2}`);
      return response2;
    }
  } catch (_) {}

  logStatus("Could not detect a league ID. Enter it manually.", "error");
  return null;
}

detectBtn.addEventListener("click", async () => {
  const id = await detectLeagueIdFromTab();
  if (id) leagueIdInput.value = id;
});

// --------------------------------------------------

testBtn.addEventListener("click", async () => {
  const leagueId = leagueIdInput.value.trim();
  const season = seasonInput.value.trim() || new Date().getFullYear();
  if (!leagueId) {
    logStatus("Please enter a League ID.", "error");
    return;
  }
  logStatus("Testing ESPN connection...");
  const res = await chrome.runtime.sendMessage({
    type: "background.testConnection",
    leagueId,
    season
  });
  if (res.ok) {
    logStatus("ESPN connection successful ✅");
  } else {
    logStatus(`Network error: ${res.code || "UNKNOWN"}`, "error");
  }
});

fetchBtn.addEventListener("click", async () => {
  const leagueId = leagueIdInput.value.trim();
  const season = seasonInput.value.trim() || new Date().getFullYear();
  if (!leagueId) {
    logStatus("Please enter a League ID.", "error");
    return;
  }
  logStatus("Fetching league data from ESPN...");
  const res = await chrome.runtime.sendMessage({
    type: "background.fetchBundle",
    leagueId,
    season,
    includeRaw: includeRawInput.checked
  });
  if (res.ok) {
    logStatus("Data fetched successfully. Ready to download or sync ✅");
    window._lastBundle = res.data;
  } else {
    logStatus(`Failed: ${res.code || "NETWORK_ERROR"}`, "error");
  }
});

downloadBtn.addEventListener("click", () => {
  if (!window._lastBundle) {
    logStatus("No data available to download.", "error");
    return;
  }
  const blob = new Blob([JSON.stringify(window._lastBundle, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "espn_export.json";
  a.click();
  URL.revokeObjectURL(url);
  logStatus("JSON downloaded.");
});

syncBtn.addEventListener("click", async () => {
  if (!window._lastBundle) {
    logStatus("Fetch data first.", "error");
    return;
  }
  const supabaseUrl = supabaseUrlInput.value.trim();
  const supabaseAnonKey = supabaseKeyInput.value.trim();
  const supabaseTable = supabaseTableInput.value.trim();
  logStatus("Syncing to Supabase...");
  const res = await chrome.runtime.sendMessage({
    type: "syncSupabase",
    normalized: window._lastBundle,
    supabaseUrl,
    supabaseAnonKey,
    supabaseTable
  });
  if (res.ok) logStatus("Synced to Supabase ✅");
  else logStatus(`Failed: ${res.message || "Unknown error"}`, "error");
});
