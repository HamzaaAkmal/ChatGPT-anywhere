let port = null;

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
