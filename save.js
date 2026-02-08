const statusEl = document.getElementById("status");
const previewImageEl = document.getElementById("preview-image");
const metaEl = document.getElementById("meta");
const formatEl = document.getElementById("format");
const qualityEl = document.getElementById("quality");
const qualityValueEl = document.getElementById("quality-value");
const qualityField = document.getElementById("quality-field");
const filenameEl = document.getElementById("filename");
const autoCloseEl = document.getElementById("auto-close");
const toastEl = document.getElementById("toast");
const saveImageButton = document.getElementById("save-image");
const savePdfButton = document.getElementById("save-pdf");
const copyClipboardButton = document.getElementById("copy-clipboard");

const PAGE_WIDTH_PT = 595.28;
const PAGE_HEIGHT_PT = 841.89;

let captureRecord = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#dc2626" : "#6b7280";
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  window.setTimeout(() => toastEl.classList.remove("show"), 2500);
}

function formatDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function buildDefaultFilename(record) {
  const now = new Date(record?.createdAt ?? Date.now());
  let hostname = "capture";
  if (record?.url) {
    try {
      hostname = new URL(record.url).hostname || hostname;
    } catch (error) {
      hostname = "capture";
    }
  }
  const mode = record?.captureMode ?? "capture";
  return `${hostname}_${formatDate(now)}_${mode}`;
}

function setQualityVisibility() {
  const isJpg = formatEl.value === "jpg";
  qualityField.style.display = isJpg ? "grid" : "none";
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
    image.src = dataUrl;
  });
}

async function createJpegBlob(image, quality) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      "image/jpeg",
      quality
    );
  });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function createPdfBytes(pages) {
  const encoder = new TextEncoder();
  const objects = [];
  const offsets = [0];

  const addObject = (contentChunks) => {
    objects.push(contentChunks);
  };

  addObject([encoder.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")]);

  const pageIds = [];
  const pageObjects = [];
  const contentObjects = [];
  const imageObjects = [];
  let nextId = 3;

  for (const page of pages) {
    const imageId = nextId++;
    const contentId = nextId++;
    const pageId = nextId++;
    pageIds.push(pageId);

    const imageHeader = `<< /Type /XObject /Subtype /Image /Width ${page.widthPx} /Height ${page.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.length} >>`;
    imageObjects.push([
      encoder.encode(`${imageId} 0 obj\n${imageHeader}\nstream\n`),
      page.jpegBytes,
      encoder.encode("\nendstream\nendobj\n")
    ]);

    const contentStream = `q ${page.drawWidth.toFixed(2)} 0 0 ${page.drawHeight.toFixed(2)} 0 ${
      PAGE_HEIGHT_PT - page.drawHeight
    } cm /Im0 Do Q`;
    const contentBytes = encoder.encode(contentStream);
    contentObjects.push([
      encoder.encode(`${contentId} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`),
      contentBytes,
      encoder.encode("\nendstream\nendobj\n")
    ]);

    const pageDict = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /MediaBox [0 0 ${PAGE_WIDTH_PT} ${PAGE_HEIGHT_PT}] /Contents ${contentId} 0 R >>`;
    pageObjects.push([
      encoder.encode(`${pageId} 0 obj\n${pageDict}\nendobj\n`)
    ]);
  }

  const pagesDict = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds
    .map((id) => `${id} 0 R`)
    .join(" ")}] >>`;
  addObject([encoder.encode(`2 0 obj\n${pagesDict}\nendobj\n`)]);

  for (let i = 0; i < pages.length; i += 1) {
    addObject(imageObjects[i]);
    addObject(contentObjects[i]);
    addObject(pageObjects[i]);
  }

  const chunks = [encoder.encode("%PDF-1.4\n")];
  let offset = chunks[0].length;

  for (const objectChunks of objects) {
    offsets.push(offset);
    const combined = concatBytes(objectChunks);
    chunks.push(combined);
    offset += combined.length;
  }

  const xrefOffset = offset;
  const xrefLines = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f "
  ];

  for (let i = 1; i < offsets.length; i += 1) {
    xrefLines.push(`${String(offsets[i]).padStart(10, "0")} 00000 n `);
  }

  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(encoder.encode(`${xrefLines.join("\n")}\n${trailer}`));

  return concatBytes(chunks);
}

async function createPdfBlob(image) {
  const scale = PAGE_WIDTH_PT / image.width;
  const sliceHeightPx = PAGE_HEIGHT_PT / scale;
  const pages = [];
  for (let offsetY = 0; offsetY < image.height; offsetY += sliceHeightPx) {
    const sliceHeight = Math.min(sliceHeightPx, image.height - offsetY);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = sliceHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, -offsetY);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const base64 = dataUrl.split(",")[1];
    pages.push({
      jpegBytes: base64ToBytes(base64),
      widthPx: canvas.width,
      heightPx: canvas.height,
      drawWidth: PAGE_WIDTH_PT,
      drawHeight: sliceHeight * scale
    });
  }

  const pdfBytes = createPdfBytes(pages);
  return new Blob([pdfBytes], { type: "application/pdf" });
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename, saveAs: true });
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function handleSaveImage() {
  try {
    setStatus("変換中…");
    const image = await loadImage(captureRecord.imageDataUrl);
    const format = formatEl.value;
    const baseName = filenameEl.value.trim() || buildDefaultFilename(captureRecord);
    let blob = null;
    let extension = "png";

    if (format === "jpg") {
      const quality = Number(qualityEl.value) / 100;
      blob = await createJpegBlob(image, quality);
      extension = "jpg";
    } else {
      blob = await dataUrlToBlob(captureRecord.imageDataUrl);
      extension = "png";
    }

    setStatus("保存要求中…");
    await downloadBlob(blob, `${baseName}.${extension}`);
    setStatus("完了");
    showToast(`${extension.toUpperCase()}として保存しました`);
    await cleanupCapture();
  } catch (error) {
    setStatus(`失敗: ${error.message}`, true);
  }
}

async function handleSavePdf() {
  try {
    setStatus("PDF変換中…");
    const image = await loadImage(captureRecord.imageDataUrl);
    const baseName = filenameEl.value.trim() || buildDefaultFilename(captureRecord);
    const pdfBlob = await createPdfBlob(image);
    setStatus("保存要求中…");
    await downloadBlob(pdfBlob, `${baseName}.pdf`);
    setStatus("完了");
    showToast("PDFとして保存しました");
    await cleanupCapture();
  } catch (error) {
    setStatus(`失敗: ${error.message}`, true);
  }
}

async function handleCopyClipboard() {
  try {
    setStatus("クリップボードへコピー中…");
    const blob = await dataUrlToBlob(captureRecord.imageDataUrl);
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": blob })
    ]);
    setStatus("完了");
    showToast("クリップボードにコピーしました");
    await cleanupCapture();
  } catch (error) {
    setStatus(`失敗: ${error.message}`, true);
  }
}

async function cleanupCapture() {
  if (captureRecord?.captureId && chrome?.runtime?.sendMessage) {
    await chrome.runtime.sendMessage({
      type: "clearCapture",
      captureId: captureRecord.captureId
    });
  }
  if (autoCloseEl.checked) {
    window.setTimeout(() => window.close(), 500);
  }
}

function updateMeta() {
  if (!captureRecord) {
    return;
  }
  const parts = [];
  if (captureRecord.title) {
    parts.push(captureRecord.title);
  }
  if (captureRecord.url) {
    parts.push(captureRecord.url);
  }
  metaEl.textContent = parts.join(" • ");
}

async function loadCapture(captureId) {
  if (chrome?.runtime?.sendMessage && captureId) {
    const response = await chrome.runtime.sendMessage({ type: "getCapture", captureId });
    return response?.capture ?? null;
  }
  return null;
}

async function createDemoCapture() {
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 1200;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#2563eb";
  context.font = "bold 48px sans-serif";
  context.fillText("Demo Capture", 80, 120);
  context.fillStyle = "#6b7280";
  context.font = "24px sans-serif";
  context.fillText("スクリーンショットのプレビュー", 80, 180);
  context.fillStyle = "#e5e7eb";
  context.fillRect(80, 240, 640, 860);
  return {
    captureId: "demo",
    createdAt: Date.now(),
    url: "https://example.com",
    title: "デモページ",
    imageMime: "image/png",
    imageDataUrl: canvas.toDataURL("image/png"),
    captureMode: "fullpage"
  };
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const captureId = params.get("captureId");
  const demoMode = params.get("demo") === "1" || !chrome?.runtime?.sendMessage;

  setStatus("準備中…");
  captureRecord = demoMode ? await createDemoCapture() : await loadCapture(captureId);

  if (!captureRecord) {
    setStatus("キャプチャデータが見つかりませんでした", true);
    return;
  }

  previewImageEl.src = captureRecord.imageDataUrl;
  filenameEl.value = buildDefaultFilename(captureRecord);
  updateMeta();
  setQualityVisibility();
  setStatus("完了");
}

qualityEl.addEventListener("input", () => {
  qualityValueEl.textContent = qualityEl.value;
});

formatEl.addEventListener("change", () => {
  setQualityVisibility();
});

saveImageButton.addEventListener("click", () => void handleSaveImage());
savePdfButton.addEventListener("click", () => void handleSavePdf());
copyClipboardButton.addEventListener("click", () => void handleCopyClipboard());

void init();
