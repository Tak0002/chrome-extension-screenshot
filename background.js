const CAPTURE_TTL_MS = 30 * 60 * 1000;

function getCaptureKey(captureId) {
  return `capture:${captureId}`;
}

async function cleanupExpiredCaptures() {
  const allItems = await chrome.storage.session.get(null);
  const now = Date.now();
  const expiredKeys = Object.entries(allItems)
    .filter(([key, value]) => key.startsWith("capture:") && value?.createdAt && now - value.createdAt > CAPTURE_TTL_MS)
    .map(([key]) => key);
  if (expiredKeys.length > 0) {
    await chrome.storage.session.remove(expiredKeys);
  }
}

async function createCaptureRecord({ dataUrl, tab, captureMode }) {
  const captureId = crypto.randomUUID();
  const record = {
    captureId,
    createdAt: Date.now(),
    sourceTabId: tab?.id ?? null,
    url: tab?.url ?? null,
    title: tab?.title ?? null,
    imageMime: "image/png",
    imageDataUrl: dataUrl,
    width: null,
    height: null,
    devicePixelRatio: tab?.devicePixelRatio ?? null,
    captureMode
  };
  await chrome.storage.session.set({ [getCaptureKey(captureId)]: record });
  return captureId;
}

async function openSavePage(captureId) {
  const url = `${chrome.runtime.getURL("save.html")}?captureId=${encodeURIComponent(captureId)}`;
  await chrome.tabs.create({ url });
}

chrome.runtime.onInstalled.addListener(() => {
  void cleanupExpiredCaptures();
});

chrome.runtime.onStartup.addListener(() => {
  void cleanupExpiredCaptures();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "capture") {
    return false;
  }

  (async () => {
    await cleanupExpiredCaptures();
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: "png" });
    const captureId = await createCaptureRecord({ dataUrl, tab: activeTab, captureMode: message.mode ?? "viewport" });
    await openSavePage(captureId);
    sendResponse({ ok: true, captureId });
  })().catch((error) => {
    console.error("Capture failed", error);
    sendResponse({ ok: false, error: error?.message ?? "Capture failed" });
  });

  return true;
});
