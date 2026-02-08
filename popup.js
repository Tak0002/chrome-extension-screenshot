const statusEl = document.getElementById("status");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#ef4444" : "#2563eb";
}

async function handleCapture(mode) {
  setStatus("キャプチャ中…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "capture", mode });
    if (!response?.ok) {
      throw new Error(response?.error || "キャプチャに失敗しました");
    }
    setStatus("保存ページを開きました。");
  } catch (error) {
    setStatus(error.message, true);
  }
}

for (const button of document.querySelectorAll("button[data-mode]")) {
  button.addEventListener("click", () => {
    void handleCapture(button.dataset.mode);
  });
}
