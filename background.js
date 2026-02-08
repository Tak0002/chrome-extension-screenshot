const CAPTURE_TTL_MS = 30 * 60 * 1000;
const SCROLL_DELAY_MS = 200;

function getCaptureKey(captureId) {
  return `capture:${captureId}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function getPageInfo(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const doc = document.documentElement;
      return {
        scrollWidth: doc.scrollWidth,
        scrollHeight: doc.scrollHeight,
        clientWidth: doc.clientWidth,
        clientHeight: doc.clientHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio
      };
    }
  });
  return result;
}

async function scrollToPosition(tabId, x, y) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (scrollX, scrollY) => {
      window.scrollTo(scrollX, scrollY);
    },
    args: [x, y]
  });
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

async function captureFullPage(tab) {
  const info = await getPageInfo(tab.id);
  const positions = [];
  for (let y = 0; y < info.scrollHeight; y += info.clientHeight) {
    positions.push({ x: 0, y });
  }

  const captures = [];
  let captureWidth = null;
  let captureHeight = null;

  for (const position of positions) {
    await scrollToPosition(tab.id, position.x, position.y);
    await delay(SCROLL_DELAY_MS);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    if (!captureWidth) {
      captureWidth = bitmap.width;
      captureHeight = bitmap.height;
    }
    captures.push({ bitmap, position });
  }

  await scrollToPosition(tab.id, info.scrollX, info.scrollY);

  const scale = captureHeight / info.clientHeight;
  const stitchedHeight = Math.ceil(info.scrollHeight * scale);
  const canvas = new OffscreenCanvas(captureWidth, stitchedHeight);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const { bitmap, position } of captures) {
    const drawY = Math.round(position.y * scale);
    ctx.drawImage(bitmap, 0, drawY);
    bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return {
    dataUrl: await blobToDataUrl(blob),
    width: info.scrollWidth,
    height: info.scrollHeight,
    devicePixelRatio: info.devicePixelRatio
  };
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
    width: tab?.width ?? null,
    height: tab?.height ?? null,
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
    let capture = null;
    const mode = message.mode ?? "viewport";
    if (mode === "fullpage") {
      capture = await captureFullPage(activeTab);
    } else {
      const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: "png" });
      capture = { dataUrl, width: null, height: null, devicePixelRatio: null };
    }
    const captureId = await createCaptureRecord({
      dataUrl: capture.dataUrl,
      tab: {
        ...activeTab,
        width: capture.width,
        height: capture.height,
        devicePixelRatio: capture.devicePixelRatio
      },
      captureMode: mode
    });
    await openSavePage(captureId);
    sendResponse({ ok: true, captureId });
  })().catch((error) => {
    console.error("Capture failed", error);
    sendResponse({ ok: false, error: error?.message ?? "Capture failed" });
  });

  return true;
});
