const supabaseUrlInput = document.getElementById("supabaseUrl");
const supabaseAnonKeyInput = document.getElementById("supabaseAnonKey");
const supabaseTableInput = document.getElementById("supabaseTable");
const saveButton = document.getElementById("saveButton");
const resetButton = document.getElementById("resetButton");
const statusEl = document.getElementById("status");

function showStatus(message, type = "info") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function storageClear() {
  return new Promise((resolve) => chrome.storage.local.clear(resolve));
}

async function loadSettings() {
  const { supabaseUrl = "", supabaseAnonKey = "", supabaseTable = "espn_syncs" } = await storageGet([
    "supabaseUrl",
    "supabaseAnonKey",
    "supabaseTable"
  ]);
  supabaseUrlInput.value = supabaseUrl;
  supabaseAnonKeyInput.value = supabaseAnonKey;
  supabaseTableInput.value = supabaseTable || "espn_syncs";
}

async function handleSave() {
  const supabaseUrl = supabaseUrlInput.value.trim();
  const supabaseAnonKey = supabaseAnonKeyInput.value.trim();
  const supabaseTable = supabaseTableInput.value.trim() || "espn_syncs";

  if (!supabaseUrl) {
    showStatus("Supabase URL is required.", "error");
    return;
  }
  if (!supabaseAnonKey) {
    showStatus("Supabase anon key is required.", "error");
    return;
  }

  await storageSet({ supabaseUrl, supabaseAnonKey, supabaseTable });
  showStatus("Settings saved.", "success");
}

async function handleReset() {
  if (!confirm("This will clear all saved settings. Continue?")) {
    return;
  }
  await storageClear();
  await loadSettings();
  showStatus("Storage cleared.", "success");
}

saveButton.addEventListener("click", handleSave);
resetButton.addEventListener("click", handleReset);

loadSettings().catch((error) => {
  console.error("Failed to load settings", error);
  showStatus("Failed to load settings.", "error");
});
