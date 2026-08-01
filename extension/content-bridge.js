let port = null;
const pendingImageFetches = new Map();
const MAX_IMAGE_DATA_URL_LENGTH = 14_000_000;

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: "chatgpt-bridge" });
  } catch {
    setTimeout(connectPort, 2000);
    return;
  }

  port.onMessage.addListener((msg) => {
    window.postMessage({
      ...msg,
      source: "chatgpt-anywhere-bridge"
    }, "*");

    if (msg?.type === "CGA_FETCH_IMAGE") {
      fetchImageFromBridge(msg);
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectPort, 1000);
  });
}

connectPort();

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== "chatgpt-anywhere-main") return;

  if (event.data?.type === "CGA_IMAGE_FETCH_DONE" || event.data?.type === "CGA_IMAGE_FETCH_ERROR") {
    settleImageFetch(event.data.requestId);
  }

  if (port) {
    try {
      port.postMessage(event.data);
    } catch {
      // Port disconnected; connectPort will handle reconnection
    }
  }
});

window.addEventListener("beforeunload", () => {
  if (port) {
    try { port.disconnect(); } catch {}
    port = null;
  }
});

async function fetchImageFromBridge(msg) {
  const requestId = msg.requestId;
  if (!requestId || pendingImageFetches.has(requestId)) return;

  pendingImageFetches.set(requestId, true);

  try {
    const image = await fetchImageAsDataUrl(msg.url, Number(msg.timeoutMs) || 18000);
    if (!pendingImageFetches.has(requestId)) return;

    if (!image.dataUrl) {
      throw new Error("Could not fetch image data from ChatGPT.");
    }

    postPortMessage({
      type: "CGA_IMAGE_FETCH_DONE",
      requestId,
      image,
      source: "chatgpt-anywhere-main"
    });
  } catch (error) {
    if (!pendingImageFetches.has(requestId)) return;
    postPortMessage({
      type: "CGA_IMAGE_FETCH_ERROR",
      requestId,
      error: error.message || "Image fetch failed.",
      source: "chatgpt-anywhere-main"
    });
  } finally {
    settleImageFetch(requestId);
  }
}

function settleImageFetch(requestId) {
  if (!requestId) return;
  pendingImageFetches.delete(requestId);
}

function postPortMessage(message) {
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    // Port disconnected; connectPort will handle reconnection.
  }
}

async function fetchImageAsDataUrl(url, timeoutMs) {
  if (!url) return {};

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs - 500));

  try {
    if (String(url).startsWith("data:image/")) {
      return url.length <= MAX_IMAGE_DATA_URL_LENGTH ? {
        dataUrl: url,
        mimeType: dataUrlMimeType(url)
      } : {};
    }

    const response = await fetch(url, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      },
      credentials: "include",
      signal: controller.signal
    });
    if (!response.ok) return {};

    const blob = await response.blob();
    const dataUrl = await blobToDataUrl(blob);
    if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) return {};

    return {
      dataUrl,
      mimeType: blob.type || dataUrlMimeType(dataUrl)
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read generated image."));
    reader.readAsDataURL(blob);
  });
}

function dataUrlMimeType(dataUrl) {
  return String(dataUrl).match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
}
