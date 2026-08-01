const defaults = {
  serverUrl: "http://127.0.0.1:8787",
  adminToken: ""
};

const elements = {
  serverUrl: document.querySelector("#serverUrl"),
  adminToken: document.querySelector("#adminToken"),
  statusPill: document.querySelector("#statusPill"),
  wsDot: document.querySelector("#wsDot"),
  tabDot: document.querySelector("#tabDot"),
  tokenDot: document.querySelector("#tokenDot"),
  endpoint: document.querySelector("#endpoint"),
  message: document.querySelector("#message"),
  saveButton: document.querySelector("#saveButton"),
  checkButton: document.querySelector("#checkButton"),
  optionsButton: document.querySelector("#optionsButton"),
  testButton: document.querySelector("#testButton"),
  copyButton: document.querySelector("#copyButton")
};

init();

async function init() {
  const settings = await chrome.storage.local.get(defaults);
  elements.serverUrl.value = settings.serverUrl;
  elements.adminToken.value = settings.adminToken;
  updateEndpoint();
  bindEvents();
  await checkServer();
  await checkStatus();
}

function bindEvents() {
  elements.serverUrl.addEventListener("input", updateEndpoint);
  elements.saveButton.addEventListener("click", saveSettings);
  elements.checkButton.addEventListener("click", checkServer);
  elements.optionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
  elements.testButton.addEventListener("click", testPrompt);
  elements.copyButton.addEventListener("click", copyEndpoint);
}

async function saveSettings() {
  await chrome.storage.local.set({
    serverUrl: normalizeUrl(elements.serverUrl.value),
    adminToken: elements.adminToken.value.trim()
  });
  elements.serverUrl.value = normalizeUrl(elements.serverUrl.value);
  updateEndpoint();
  setMessage("Saved.");
}

async function checkStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (!response) return;

    elements.wsDot.className = "status-dot " + (response.wsConnected ? "dot-ok" : "dot-bad");
    elements.tabDot.className = "status-dot " + (response.chatgptTabId ? "dot-ok" : "dot-bad");
    elements.tokenDot.className = "status-dot " + (response.tokenAvailable ? "dot-ok" : "dot-bad");

    if (response.wsConnected && response.chatgptTabId && response.tokenAvailable) {
      setStatus("Browser", "ok");
    } else if (response.wsConnected) {
      setStatus("API", "pending");
    } else {
      setStatus("Offline", "bad");
    }
  });
}

async function checkServer() {
  setStatus("Checking", "");

  try {
    const response = await fetch(`${normalizeUrl(elements.serverUrl.value)}/health`);
    const health = await response.json();

    if (!health.ok) {
      throw new Error("Server did not return ok");
    }
    
    await checkStatus();
    setMessage("Local server is reachable.");
  } catch (error) {
    setStatus("Offline", "bad");
    setMessage("Start the Node server, then check again.");
    
    elements.wsDot.className = "status-dot dot-bad";
    elements.tabDot.className = "status-dot dot-bad";
    elements.tokenDot.className = "status-dot dot-bad";
  }
}

function testPrompt() {
  chrome.runtime.sendMessage({ type: 'TEST_PROMPT' }, (response) => {
    if (response && response.ok) {
      setMessage("Test prompt sent.");
    } else {
      setMessage(response?.error || "Failed to send test prompt.");
    }
  });
}

async function copyEndpoint() {
  await navigator.clipboard.writeText(elements.endpoint.textContent);
  setMessage("Endpoint copied.");
}

function updateEndpoint() {
  elements.endpoint.textContent = `${normalizeUrl(elements.serverUrl.value)}/v1/chat/completions`;
}

function normalizeUrl(value) {
  return (value || defaults.serverUrl).trim().replace(/\/+$/, "");
}

function setStatus(text, className) {
  elements.statusPill.textContent = text;
  elements.statusPill.className = `pill ${className}`.trim();
}

function setMessage(text) {
  elements.message.textContent = text;
}
