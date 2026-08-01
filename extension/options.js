const defaults = {
  serverUrl: "http://127.0.0.1:8787",
  adminToken: ""
};

const elements = {
  statusText: document.querySelector("#statusText"),
  refreshButton: document.querySelector("#refreshButton"),
  refreshSessionButton: document.querySelector("#refreshSessionButton"),
  saveConnectionButton: document.querySelector("#saveConnectionButton"),
  saveConfigButton: document.querySelector("#saveConfigButton"),
  createKeyButton: document.querySelector("#createKeyButton"),
  copyKeyButton: document.querySelector("#copyKeyButton"),
  wsCard: document.querySelector("#wsCard"),
  wsStatus: document.querySelector("#wsStatus"),
  tabCard: document.querySelector("#tabCard"),
  tabStatus: document.querySelector("#tabStatus"),
  tokenCard: document.querySelector("#tokenCard"),
  tokenStatus: document.querySelector("#tokenStatus"),
  serverUrl: document.querySelector("#serverUrl"),
  adminToken: document.querySelector("#adminToken"),
  upstreamBaseUrl: document.querySelector("#upstreamBaseUrl"),
  defaultModel: document.querySelector("#defaultModel"),
  upstreamApiKey: document.querySelector("#upstreamApiKey"),
  apiKeyStatus: document.querySelector("#apiKeyStatus"),
  keyName: document.querySelector("#keyName"),
  newKeyBox: document.querySelector("#newKeyBox"),
  newKey: document.querySelector("#newKey"),
  keys: document.querySelector("#keys"),
  chats: document.querySelector("#chats")
};

init();

async function init() {
  const settings = await chrome.storage.local.get(defaults);
  elements.serverUrl.value = settings.serverUrl;
  elements.adminToken.value = settings.adminToken;
  bindEvents();
  await refreshAll();
  await loadSessionStatus();
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => { refreshAll(); loadSessionStatus(); });
  elements.refreshSessionButton.addEventListener("click", loadSessionStatus);
  elements.saveConnectionButton.addEventListener("click", saveConnection);
  elements.saveConfigButton.addEventListener("click", saveConfig);
  elements.createKeyButton.addEventListener("click", createKey);
  elements.copyKeyButton.addEventListener("click", copyNewKey);
}

async function refreshAll() {
  try {
    await checkHealth();
    await Promise.all([loadConfig(), loadKeys(), loadChats()]);
    setStatus("Connected to local server.");
  } catch (error) {
    setStatus(error.message || "Unable to connect.");
  }
}

async function loadSessionStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (!response) return;
    
    if (response.wsConnected) {
      elements.wsCard.className = "status-card card-ok";
      elements.wsStatus.textContent = "Connected";
    } else {
      elements.wsCard.className = "status-card card-bad";
      elements.wsStatus.textContent = "Disconnected";
    }

    if (response.chatgptTabId) {
      elements.tabCard.className = "status-card card-ok";
      elements.tabStatus.textContent = "Active";
    } else {
      elements.tabCard.className = "status-card card-bad";
      elements.tabStatus.textContent = "Not Found";
    }

    if (response.tokenAvailable) {
      elements.tokenCard.className = "status-card card-ok";
      elements.tokenStatus.textContent = "Intercepted";
    } else {
      elements.tokenCard.className = "status-card card-bad";
      elements.tokenStatus.textContent = "Missing";
    }
  });
}

async function checkHealth() {
  const response = await fetch(`${serverUrl()}/health`);
  const health = await response.json();

  if (!health.ok) {
    throw new Error("Server health check failed.");
  }
}

async function loadConfig() {
  const config = await adminFetch("/admin/config");
  elements.upstreamBaseUrl.value = config.upstreamBaseUrl || "https://api.openai.com/v1";
  elements.defaultModel.value = config.defaultModel || "gpt-5.5";
  elements.apiKeyStatus.textContent = config.upstreamApiKey?.configured
    ? `Upstream key configured: ${config.upstreamApiKey.prefix}`
    : "No upstream API key configured.";
}

async function loadKeys() {
  const payload = await adminFetch("/admin/keys");
  elements.keys.textContent = "";

  if (!payload.data?.length) {
    elements.keys.append(emptyNode());
    return;
  }

  for (const key of payload.data) {
    const row = document.createElement("div");
    row.className = "row";

    const details = document.createElement("div");
    const title = document.createElement("p");
    title.className = "title";
    title.textContent = key.name;

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${key.prefix} · created ${formatDate(key.createdAt)} · last used ${formatDate(key.lastUsedAt)}`;

    const button = document.createElement("button");
    button.className = "danger";
    button.type = "button";
    button.textContent = "Delete";
    button.addEventListener("click", () => deleteKey(key.id));

    details.append(title, meta);
    row.append(details, button);
    elements.keys.append(row);
  }
}

async function loadChats() {
  const payload = await adminFetch("/admin/chats?limit=20");
  elements.chats.textContent = "";

  if (!payload.data?.length) {
    elements.chats.append(emptyNode());
    return;
  }

  for (const chat of payload.data) {
    const row = document.createElement("div");
    row.className = "row";

    const details = document.createElement("div");
    const title = document.createElement("p");
    title.className = "title";
    title.textContent = chat.title;

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${chat.id} · ${chat.model || "model"} · ${formatDate(chat.updatedAt)}`;

    details.append(title, meta);
    row.append(details);
    elements.chats.append(row);
  }
}

async function saveConnection() {
  await chrome.storage.local.set({
    serverUrl: serverUrl(),
    adminToken: adminToken()
  });
  setStatus("Connection settings saved.");
  await refreshAll();
}

async function saveConfig() {
  const body = {
    upstreamBaseUrl: elements.upstreamBaseUrl.value.trim(),
    defaultModel: elements.defaultModel.value.trim()
  };

  if (elements.upstreamApiKey.value.trim()) {
    body.upstreamApiKey = elements.upstreamApiKey.value.trim();
  }

  await adminFetch("/admin/config", {
    method: "PUT",
    body: JSON.stringify(body)
  });
  elements.upstreamApiKey.value = "";
  await loadConfig();
  setStatus("OpenAI API settings saved.");
}

async function createKey() {
  const name = elements.keyName.value.trim() || "Local client";
  const key = await adminFetch("/admin/keys", {
    method: "POST",
    body: JSON.stringify({ name })
  });

  elements.newKeyBox.classList.remove("hidden");
  elements.newKey.value = key.secret;
  elements.keyName.value = "";
  await loadKeys();
  setStatus("Local key generated. Copy it now; it will not be shown again.");
}

async function deleteKey(id) {
  await adminFetch(`/admin/keys/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  await loadKeys();
  setStatus("Local key deleted.");
}

async function copyNewKey() {
  await navigator.clipboard.writeText(elements.newKey.value);
  setStatus("Local key copied.");
}

async function adminFetch(path, options = {}) {
  const response = await fetch(`${serverUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${adminToken()}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(payload.error?.message || `Request failed with ${response.status}`);
  }

  return payload;
}

function serverUrl() {
  return normalizeUrl(elements.serverUrl.value);
}

function adminToken() {
  return elements.adminToken.value.trim();
}

function normalizeUrl(value) {
  return (value || defaults.serverUrl).trim().replace(/\/+$/, "");
}

function setStatus(text) {
  elements.statusText.textContent = text;
}

function emptyNode() {
  return document.querySelector("#emptyTemplate").content.firstElementChild.cloneNode(true);
}

function formatDate(value) {
  if (!value) {
    return "never";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}
