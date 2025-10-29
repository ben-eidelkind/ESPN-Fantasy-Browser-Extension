function extractLeagueIdFromUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    const id = parsed.searchParams.get("leagueId");
    if (id && /^\d+$/.test(id)) {
      return id;
    }
  } catch (err) {
    // ignore
  }
  return null;
}

function extractLeagueIdFromDom() {
  const attributeElement = document.querySelector('[data-leagueid], [data-league-id]');
  if (attributeElement) {
    const id = attributeElement.getAttribute("data-leagueid") || attributeElement.getAttribute("data-league-id");
    if (id && /^\d+$/.test(id)) {
      return id;
    }
  }

  const textMatches = document.body.innerText.match(/leagueId\s*[:=]\s*(\d{3,})/i);
  if (textMatches && textMatches[1]) {
    return textMatches[1];
  }

  const scripts = Array.from(document.scripts);
  for (const script of scripts) {
    const content = script.textContent || "";
    const match = content.match(/"leagueId"\s*:\s*(\d{3,})/);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

function detectLeagueId() {
  return (
    extractLeagueIdFromUrl(window.location.href) ||
    extractLeagueIdFromDom()
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "detectLeagueId") {
    const leagueId = detectLeagueId();
    sendResponse({ leagueId });
  }
});
