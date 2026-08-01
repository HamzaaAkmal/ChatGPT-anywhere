let ws = null;
let reconnectTimer = null;
let keepaliveTimer = null;
let backoffDelay = 1000;
let wsConnected = false;
let connectedPorts = new Map();
let activeRequests = new Map();
let tokenAvailable = false;
let chatgptTabId = null;
let preferredTabId = null;
const PORT_WAIT_MS = 15000;

async function updateState(updates) {
  if (updates.wsConnected !== undefined) wsConnected = updates.wsConnected;
  if (updates.chatgptTabId !== undefined) chatgptTabId = updates.chatgptTabId;
  if (updates.tokenAvailable !== undefined) tokenAvailable = updates.tokenAvailable;

  try {
    await chrome.storage.session.set({
      wsConnected,
      chatgptTabId,
      tokenAvailable
    });
  } catch {
    // session storage may not be available in all contexts
  }
}

async function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const { serverUrl } = await chrome.storage.local.get(["serverUrl"]);
  const base = (serverUrl || "http://127.0.0.1:8787").replace(/^http/, "ws");
  const wsUrl = base + "/ws/extension";

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    backoffDelay = 1000;
    updateState({ wsConnected: true });

    // Clear any previous keepalive
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 25000);
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "prompt") {
        // Server sends { type:"prompt", requestId, body }
        let activeEntry = await getBestChatGPTEntry();
        if (activeEntry && shouldStartNewChat(msg.body)) {
          activeEntry = await openNewChatInTab(activeEntry) || activeEntry;
        }
        const activePort = activeEntry?.port || null;

        if (activePort) {
          activeRequests.set(msg.requestId, activePort);
          chrome.alarms.create("cga-keepalive", { periodInMinutes: 0.4 });
          activePort.postMessage({
            type: "CGA_SUBMIT_PROMPT",
            requestId: msg.requestId,
            body: msg.body,
            conversationId: shouldStartNewChat(msg.body) ? null : msg.body?.conversation_id
          });
        } else {
          sendToServer({
            type: "error",
            requestId: msg.requestId,
            error: "No active ChatGPT tab found. Open chatgpt.com and log in."
          });
        }
      } else if (msg.type === "cancel") {
        const activePort = activeRequests.get(msg.requestId) || await getBestChatGPTPort();
        activeRequests.delete(msg.requestId);
        if (activePort) {
          activePort.postMessage({
            type: "CGA_CANCEL_PROMPT",
            requestId: msg.requestId,
            reason: msg.reason
          });
        }
      } else if (msg.type === "fetch_image") {
        const activePort = msg.bridgeTabId && connectedPorts.has(msg.bridgeTabId)
          ? connectedPorts.get(msg.bridgeTabId).port
          : await getBestChatGPTPort();
        if (activePort) {
          activePort.postMessage({
            type: "CGA_FETCH_IMAGE",
            requestId: msg.requestId,
            url: msg.url,
            timeoutMs: msg.timeoutMs
          });
        } else {
          sendToServer({
            type: "image_fetch_error",
            requestId: msg.requestId,
            error: "No active ChatGPT tab found. Open chatgpt.com and log in."
          });
        }
      }
    } catch (e) {
      console.error("CGA: Failed to parse WS message", e);
    }
  };

  ws.onclose = () => {
    updateState({ wsConnected: false });
    ws = null;
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after onerror
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, backoffDelay);
  backoffDelay = Math.min(backoffDelay * 2, 30000);
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(["serverUrl"]);
  if (!current.serverUrl) {
    await chrome.storage.local.set({
      serverUrl: "http://127.0.0.1:8787"
    });
  }
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(() => {
  connectWebSocket();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chatgpt-bridge") return;

  const tabId = port.sender?.tab?.id;
  if (!tabId) return;

  connectedPorts.set(tabId, {
    tabId,
    port,
    lastSeenAt: Date.now(),
    lastSuccessAt: 0,
    hasToken: false
  });
  preferredTabId = preferredTabId || tabId;
  updateState({ chatgptTabId: tabId });

  // Ask content script for token status immediately
  port.postMessage({ type: "CGA_GET_STATUS" });

  port.onMessage.addListener((msg) => {
    const entry = connectedPorts.get(tabId);
    if (entry) {
      entry.lastSeenAt = Date.now();
    }

    if (msg.type === "CGA_STATUS") {
      if (entry) {
        entry.hasToken = Boolean(msg.hasToken);
      }
      if (msg.hasToken) {
        preferredTabId = tabId;
      }
      updateState({ tokenAvailable: msg.hasToken });
    } else if (msg.type === "CGA_STREAM_CHUNK") {
      sendToServer({
        type: "chunk",
        requestId: msg.requestId,
        delta: msg.delta
      });
    } else if (msg.type === "CGA_STREAM_DONE") {
      if (entry) {
        entry.lastSuccessAt = Date.now();
      }
      preferredTabId = tabId;
      activeRequests.delete(msg.requestId);
      chrome.alarms.clear("cga-keepalive");
      sendToServer({
        type: "done",
        requestId: msg.requestId,
        fullContent: msg.fullContent,
        images: msg.images || [],
        bridgeTabId: tabId,
        conversationId: msg.conversationId,
        messageId: msg.messageId
      });
    } else if (msg.type === "CGA_STREAM_ERROR") {
      activeRequests.delete(msg.requestId);
      chrome.alarms.clear("cga-keepalive");
      sendToServer({
        type: "error",
        requestId: msg.requestId,
        error: msg.error
      });
    } else if (msg.type === "CGA_IMAGE_FETCH_DONE") {
      sendToServer({
        type: "image_fetch_done",
        requestId: msg.requestId,
        image: msg.image
      });
    } else if (msg.type === "CGA_IMAGE_FETCH_ERROR") {
      sendToServer({
        type: "image_fetch_error",
        requestId: msg.requestId,
        error: msg.error
      });
    }
  });

  port.onDisconnect.addListener(() => {
    connectedPorts.delete(tabId);
    if (preferredTabId === tabId) {
      preferredTabId = null;
    }
    for (const [requestId, requestPort] of activeRequests) {
      if (requestPort === port) {
        activeRequests.delete(requestId);
      }
    }
    if (connectedPorts.size === 0) {
      updateState({ chatgptTabId: null, tokenAvailable: false });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_STATUS") {
    // Refresh token status from active tab
    if (chatgptTabId && connectedPorts.has(chatgptTabId)) {
      connectedPorts.get(chatgptTabId).port.postMessage({ type: "CGA_GET_STATUS" });
    }
    sendResponse({ wsConnected, chatgptTabId, tokenAvailable });
  } else if (msg.type === "RECONNECT_WS") {
    if (ws) {
      ws.close();
    } else {
      connectWebSocket();
    }
    sendResponse({ ok: true });
  } else if (msg.type === "TEST_PROMPT") {
    if (connectedPorts.size > 0) {
      const port = Array.from(connectedPorts.values())
        .sort((a, b) => a.lastSeenAt - b.lastSeenAt)
        .pop()
        .port;
      const requestId = "test-" + Date.now();
      port.postMessage({
        type: "CGA_SUBMIT_PROMPT",
        requestId,
        body: {
          messages: [{ role: "user", content: "Say exactly: Test successful" }],
          model: "auto"
        }
      });
      sendResponse({ ok: true, requestId });
    } else {
      sendResponse({ ok: false, error: "No active ChatGPT tab found." });
    }
  }
  return true;
});

async function getBestChatGPTPort() {
  const entry = await getBestChatGPTEntry();
  return entry?.port || null;
}

async function getBestChatGPTEntry() {
  const existingEntry = getBestConnectedEntry();
  if (existingEntry?.port) return existingEntry;

  return await openChatGPTTabAndWait();
}

function getBestConnectedEntry() {
  const preferredEntry = preferredTabId ? connectedPorts.get(preferredTabId) : null;
  if (preferredEntry?.port) return preferredEntry;

  return Array.from(connectedPorts.values())
    .sort((a, b) =>
      Number(a.hasToken) - Number(b.hasToken) ||
      a.lastSuccessAt - b.lastSuccessAt ||
      a.lastSeenAt - b.lastSeenAt
    )
    .pop() || null;
}

async function openChatGPTTabAndWait() {
  try {
    const tab = await chrome.tabs.create({
      url: "https://chatgpt.com/",
      active: false
    });
    if (tab?.id) {
      preferredTabId = tab.id;
      updateState({ chatgptTabId: tab.id });
      return await waitForPort(tab.id, PORT_WAIT_MS);
    }
  } catch {
    // Fall through to no-port error.
  }

  return null;
}

async function openNewChatInTab(entry) {
  if (!entry?.tabId) return null;

  try {
    preferredTabId = entry.tabId;
    updateState({ chatgptTabId: entry.tabId });
    await chrome.tabs.update(entry.tabId, {
      url: "https://chatgpt.com/",
      active: false
    });
    const freshEntry = await waitForFreshPort(entry.tabId, entry.port, PORT_WAIT_MS);
    await delay(250);
    return freshEntry || connectedPorts.get(entry.tabId) || entry;
  } catch {
    return connectedPorts.get(entry.tabId) || entry;
  }
}

async function waitForPort(tabId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const entry = connectedPorts.get(tabId);
    if (entry?.port) return entry;
    await delay(100);
  }

  return null;
}

async function waitForFreshPort(tabId, previousPort, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const entry = connectedPorts.get(tabId);
    if (entry?.port && entry.port !== previousPort) return entry;
    await delay(100);
  }

  return null;
}

function shouldStartNewChat(body = {}) {
  const value = body.new_chat ?? body.cga?.new_chat;
  return value === true || value === 1 || value === "true" || value === "1";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Connect on service worker startup
connectWebSocket();
