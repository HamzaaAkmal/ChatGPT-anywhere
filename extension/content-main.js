// ─── Auth token state ────────────────────────────────────────────────────────
let currentToken = null;
let tokenFetchedAt = 0;
let capturedHeaders = {};

// Proactively fetch the session token as soon as the script loads.
// This handles the case where the page is already logged in and the
// /api/auth/session endpoint won't be called again via normal navigation.
async function fetchSessionToken() {
  try {
    const resp = await originalFetch("/api/auth/session", {
      credentials: "include"
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.accessToken) {
        currentToken = data.accessToken;
        tokenFetchedAt = Date.now();
        console.debug("[CGA] Session token acquired proactively.");
      }
    }
  } catch {
    // Will be captured via fetch override instead
  }
}

// ─── Fetch override ───────────────────────────────────────────────────────────
const originalFetch = window.fetch;
window.fetch = async function (...args) {
  const resource = args[0];
  const url = typeof resource === "string" ? resource : (resource instanceof Request ? resource.url : "");

  // Capture token from session endpoint responses
  if (url.includes("/api/auth/session")) {
    const response = await originalFetch.apply(this, args);
    const clone = response.clone();
    clone.json().then((data) => {
      if (data && data.accessToken) {
        currentToken = data.accessToken;
        tokenFetchedAt = Date.now();
        console.debug("[CGA] Session token captured from /api/auth/session.");
      }
    }).catch(() => {});
    return response;
  }

  // Capture token and headers from outgoing backend-api requests
  if (url.includes("/backend-api/")) {
    const options = args[1] || {};
    const headers = options.headers || (resource instanceof Request ? resource.headers : {});

    const headersObj = {};
    if (headers instanceof Headers) {
      headers.forEach((value, key) => { headersObj[key.toLowerCase()] = value; });
    } else if (Array.isArray(headers)) {
      headers.forEach(h => { headersObj[h[0].toLowerCase()] = h[1]; });
    } else if (headers && typeof headers === "object") {
      Object.keys(headers).forEach(k => { headersObj[k.toLowerCase()] = headers[k]; });
    }

    if (headersObj["authorization"] && headersObj["authorization"].startsWith("Bearer ")) {
      currentToken = headersObj["authorization"].split(" ")[1];
      tokenFetchedAt = Date.now();
    }
    
    // Capture important sentinel and device headers
    const headersToCapture = [
      "oai-device-id",
      "oai-language",
      "openai-sentinel-chat-requirements-token",
      "openai-sentinel-proof-token"
    ];
    
    headersToCapture.forEach(key => {
      if (headersObj[key]) capturedHeaders[key] = headersObj[key];
    });
  }

  return originalFetch.apply(this, args);
};

// Kick off proactive token fetch after override is in place
fetchSessionToken();

// ─── Message handler ──────────────────────────────────────────────────────────
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;

  // ── Status query ──
  if (event.data?.type === "CGA_GET_STATUS") {
    // If token is older than 10 minutes, try to refresh it
    if (!currentToken || Date.now() - tokenFetchedAt > 600_000) {
      await fetchSessionToken();
    }
    window.postMessage({
      type: "CGA_STATUS",
      hasToken: !!currentToken,
      tokenAge: currentToken ? Math.round((Date.now() - tokenFetchedAt) / 1000) : null,
      source: "chatgpt-anywhere-main"
    }, "*");
    return;
  }

  // ── Prompt submission ──
  if (event.data?.type !== "CGA_SUBMIT_PROMPT") return;

  const { requestId, body, conversationId } = event.data;

  // Ensure we have a token — try fetching if missing
  if (!currentToken) {
    await fetchSessionToken();
  }

  if (!currentToken) {
    window.postMessage({
      type: "CGA_STREAM_ERROR",
      requestId,
      error: "No session token available. Please make sure you are logged in to chatgpt.com and try again.",
      source: "chatgpt-anywhere-main"
    }, "*");
    return;
  }

  try {
    // Only include user/system/assistant messages in the ChatGPT payload.
    // System messages go as author.role = "system".
    const messages = (body.messages || []).map((m) => ({
      id: crypto.randomUUID(),
      author: { role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user" },
      content: {
        content_type: "text",
        parts: [typeof m.content === "string" ? m.content : JSON.stringify(m.content)]
      },
      metadata: {}
    }));

    const payload = {
      action: "next",
      messages,
      model: body.model || "auto",
      parent_message_id: crypto.randomUUID(),
      timezone_offset_min: new Date().getTimezoneOffset(),
      history_and_training_disabled: false,
      conversation_mode: { kind: "primary_assistant" },
      force_paragen: false,
      force_paragen_model_slug: "",
      force_rate_limit: false,
      reset_rate_limits: false,
      websocket_request_id: crypto.randomUUID(),
      supported_encodings: ["v1"],
      supports_buffering: true
    };

    if (conversationId) {
      payload.conversation_id = conversationId;
    }

    // Build request headers matching what the ChatGPT web UI sends
    const requestHeaders = {
      "Authorization": `Bearer ${currentToken}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Accept-Language": "en-US,en;q=0.9",
      "Origin": "https://chatgpt.com",
      "Referer": "https://chatgpt.com/",
      "OAI-Language": "en-US",
      ...capturedHeaders
    };

    const response = await originalFetch("https://chatgpt.com/backend-api/conversation", {
      method: "POST",
      headers: requestHeaders,
      credentials: "include",
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      // Read the body for a more helpful error message
      let detail = "";
      try {
        detail = await response.text();
      } catch {}
      const truncated = detail.slice(0, 300);
      throw new Error(`ChatGPT 403: ${truncated || response.statusText}`);
    }

    // ── SSE stream parsing ────────────────────────────────────────────────────
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let previousText = "";
    let activeMessageId = null;
    let activeConversationId = null;
    let lineBuffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || ""; // keep partial last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed === "data: [DONE]") {
          window.postMessage({
            type: "CGA_STREAM_DONE",
            requestId,
            fullContent: previousText,
            conversationId: activeConversationId,
            messageId: activeMessageId,
            source: "chatgpt-anywhere-main"
          }, "*");
          return;
        }

        if (!trimmed.startsWith("data: ")) continue;
        const dataStr = trimmed.slice(6);
        if (!dataStr) continue;

        try {
          const data = JSON.parse(dataStr);

          if (data.error) {
            throw new Error(data.error.message || JSON.stringify(data.error));
          }

          if (data.conversation_id) {
            activeConversationId = data.conversation_id;
          }

          if (data.message) {
            activeMessageId = data.message.id || activeMessageId;

            const parts = data.message.content?.parts;
            if (Array.isArray(parts) && parts.length > 0) {
              const currentText = parts[0];
              if (typeof currentText === "string" && currentText.length > previousText.length) {
                const delta = currentText.slice(previousText.length);
                previousText = currentText;

                window.postMessage({
                  type: "CGA_STREAM_CHUNK",
                  requestId,
                  delta,
                  messageId: activeMessageId,
                  conversationId: activeConversationId,
                  source: "chatgpt-anywhere-main"
                }, "*");
              }
            }
          }
        } catch (parseErr) {
          if (parseErr.message && !parseErr.message.startsWith("JSON")) {
            // It's a real error from the data, not a parse failure
            throw parseErr;
          }
          // Otherwise ignore incomplete JSON chunks
        }
      }
    }

    // Stream ended without [DONE] — still emit completion if we got content
    if (previousText) {
      window.postMessage({
        type: "CGA_STREAM_DONE",
        requestId,
        fullContent: previousText,
        conversationId: activeConversationId,
        messageId: activeMessageId,
        source: "chatgpt-anywhere-main"
      }, "*");
    } else {
      // Empty response
      window.postMessage({
        type: "CGA_STREAM_ERROR",
        requestId,
        error: "ChatGPT returned an empty response.",
        source: "chatgpt-anywhere-main"
      }, "*");
    }
  } catch (error) {
    window.postMessage({
      type: "CGA_STREAM_ERROR",
      requestId,
      error: error.message,
      source: "chatgpt-anywhere-main"
    }, "*");
  }
});
