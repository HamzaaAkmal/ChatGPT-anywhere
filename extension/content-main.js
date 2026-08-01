// ─── Auth token state ────────────────────────────────────────────────────────
const CGA_INSTANCE_ID = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random()}`;
window.__CGA_MAIN_INSTANCE_ID = CGA_INSTANCE_ID;

let currentToken = null;
let tokenFetchedAt = 0;
let capturedHeaders = {};
let backendBlockedUntil = 0;
const BACKEND_BLOCK_CACHE_MS = 5 * 60 * 1000;
const activeAbortControllers = new Map();
const cancelledRequestIds = new Set();

// Proactively fetch the session token as soon as the script loads.
// This handles the case where the page is already logged in and the
// /api/auth/session endpoint won't be called again via normal navigation.
async function fetchSessionToken() {
  if (window.__CGA_MAIN_INSTANCE_ID !== CGA_INSTANCE_ID) return;

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
const originalFetch = window.__CGA_ORIGINAL_FETCH || window.fetch;
window.__CGA_ORIGINAL_FETCH = originalFetch;

window.fetch = async function (...args) {
  if (window.__CGA_MAIN_INSTANCE_ID !== CGA_INSTANCE_ID) {
    return originalFetch.apply(this, args);
  }

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
    
    // Capture important sentinel and device headers dynamically
    Object.keys(headersObj).forEach(key => {
      if (key.startsWith("oai-") || key.startsWith("openai-") || key === "chat-requirements") {
        capturedHeaders[key] = headersObj[key];
      }
    });
  }

  return originalFetch.apply(this, args);
};

// Kick off proactive token fetch after override is in place
fetchSessionToken();

function clickChatGPTStopButton() {
  const stopButton = document.querySelector('[data-testid="stop-button"], button[aria-label="Stop answering"]');
  if (stopButton instanceof HTMLElement) {
    stopButton.click();
    return true;
  }

  return false;
}

// ─── Message handler ──────────────────────────────────────────────────────────
window.addEventListener("message", async (event) => {
  if (window.__CGA_MAIN_INSTANCE_ID !== CGA_INSTANCE_ID) return;
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

  // ── Prompt cancellation ──
  if (event.data?.type === "CGA_CANCEL_PROMPT") {
    const cancelRequestId = event.data.requestId;
    if (cancelRequestId) {
      cancelledRequestIds.add(cancelRequestId);
      activeAbortControllers.get(cancelRequestId)?.abort();
      setTimeout(() => cancelledRequestIds.delete(cancelRequestId), 30000);
    }

    clickChatGPTStopButton();
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

  let previousText = "";
  let activeMessageId = null;
  let activeConversationId = null;
  const backendController = new AbortController();
  activeAbortControllers.set(requestId, backendController);

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

    if (Date.now() < backendBlockedUntil) {
      throwIfCancelled();
      await submitPromptViaUI();
      return;
    }

    throwIfCancelled();

    const response = await originalFetch("https://chatgpt.com/backend-api/conversation", {
      method: "POST",
      headers: requestHeaders,
      credentials: "include",
      signal: backendController.signal,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      // Read the body for a more helpful error message
      let detail = "";
      try {
        detail = await response.text();
      } catch {}
      const truncated = detail.slice(0, 300);
      if (shouldUseUIFallback(response.status, truncated)) {
        backendBlockedUntil = Date.now() + BACKEND_BLOCK_CACHE_MS;
        console.debug("[CGA] Backend API blocked; falling back to ChatGPT UI automation.");
        await submitPromptViaUI();
        return;
      }
      throw new Error(`ChatGPT ${response.status}: ${truncated || response.statusText}`);
    }

    // ── SSE stream parsing ────────────────────────────────────────────────────
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let lineBuffer = "";

    while (true) {
      throwIfCancelled();
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

          const message = data.message || data.v?.message;
          if (message) {
            if (message.author?.role && message.author.role !== "assistant") continue;

            activeMessageId = message.id || activeMessageId;
            emitTextDelta(extractMessageText(message));
          }

          for (const patch of extractStreamPatches(data)) {
            if (patch.p === "/conversation_id" && typeof patch.v === "string") {
              activeConversationId = patch.v;
              continue;
            }

            if (patch.p === "/message/id" && typeof patch.v === "string") {
              activeMessageId = patch.v;
              continue;
            }

            if (!patch.p?.startsWith("/message/content/parts/")) {
              continue;
            }

            const value = textFromValue(patch.v);
            if (!value) continue;

            if (patch.o === "append") {
              previousText += value;
              emitChunk(value);
            } else {
              emitTextDelta(value);
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
  } finally {
    activeAbortControllers.delete(requestId);
    cancelledRequestIds.delete(requestId);
  }

  function emitTextDelta(currentText) {
    if (typeof currentText !== "string" || !currentText) return;

    if (currentText.length > previousText.length && currentText.startsWith(previousText)) {
      const delta = currentText.slice(previousText.length);
      previousText = currentText;
      emitChunk(delta);
      return;
    }

    if (currentText !== previousText) {
      previousText = currentText;
      emitChunk(currentText);
    }
  }

  function emitChunk(delta) {
    if (!delta) return;

    window.postMessage({
      type: "CGA_STREAM_CHUNK",
      requestId,
      delta,
      messageId: activeMessageId,
      conversationId: activeConversationId,
      source: "chatgpt-anywhere-main"
    }, "*");
  }

  function emitDone() {
    emitDoneWithContent(previousText);
  }

  function emitDoneWithContent(fullContent) {
    window.postMessage({
      type: "CGA_STREAM_DONE",
      requestId,
      fullContent,
      conversationId: activeConversationId,
      messageId: activeMessageId,
      source: "chatgpt-anywhere-main"
    }, "*");
  }

  function shouldUseUIFallback(status, detail) {
    return status === 403 ||
      /unusual activity|sentinel|proof|challenge|arkose|captcha/i.test(detail || "");
  }

  async function submitPromptViaUI() {
    const promptText = messagesToPrompt(body.messages || []);
    if (!promptText) {
      throw new Error("No prompt text available for ChatGPT UI fallback.");
    }

    await stopCurrentUIResponse();

    const beforeTurnMarker = getLastTurnMarker();
    const composer = await waitForComposer(15000);

    setComposerText(composer, promptText);
    await delay(150);

    const submitButton = await waitForEnabledSubmitButton(15000);
    submitButton.click();

    const startedAt = Date.now();
    let lastObservedText = "";
    let lastTextChangedAt = Date.now();
    let lastActiveAt = Date.now();
    const emitLiveDeltas = Boolean(body.cga?.live_ui_stream || body.live_ui_stream);

    while (Date.now() - startedAt < 120000) {
      throwIfCancelled();
      const responseState = getUIResponseState(beforeTurnMarker, promptText);
      if (responseState.active) {
        lastActiveAt = Date.now();
      }

      if (responseState.text && responseState.text !== lastObservedText) {
        lastObservedText = responseState.text;
        lastTextChangedAt = Date.now();

        if (emitLiveDeltas) {
          emitTextDelta(responseState.text);
        }
      }

      if (shouldFinishUIResponse(responseState, {
        lastObservedText,
        lastTextChangedAt,
        lastActiveAt
      })) {
        if (!emitLiveDeltas) {
          previousText = "";
        }

        emitTextDelta(lastObservedText);
        emitDoneWithContent(lastObservedText);
        return;
      }

      await delay(80);
    }

    throw new Error("Timed out waiting for ChatGPT UI response.");
  }

  async function stopCurrentUIResponse() {
    if (clickChatGPTStopButton()) {
      await delay(500);
    }
  }

  function throwIfCancelled() {
    if (cancelledRequestIds.has(requestId)) {
      throw new Error("Request cancelled.");
    }
  }

  function messagesToPrompt(messages) {
    const normalized = messages
      .filter((message) => ["system", "user", "assistant"].includes(message?.role))
      .map((message) => ({
        role: message.role,
        content: messageContentToText(message.content)
      }))
      .filter((message) => message.content);

    if (normalized.length === 1 && normalized[0].role === "user") {
      return normalized[0].content;
    }

    return normalized
      .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
      .join("\n\n");
  }

  function messageContentToText(content) {
    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (typeof part?.text === "string") return part.text;
          if (typeof part?.content === "string") return part.content;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    return content ? JSON.stringify(content) : "";
  }

  function setComposerText(composer, text) {
    composer.focus();

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      composer.value = text;
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
      return;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, text);
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
  }

  async function waitForEnabledSubmitButton(timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const button = document.querySelector(
        '#composer-submit-button:not([data-testid="stop-button"]), [data-testid="send-button"], button[aria-label="Send prompt"]'
      );

      if (button instanceof HTMLButtonElement && !button.disabled) {
        return button;
      }

      await delay(100);
    }

    throw new Error("ChatGPT send button was not available.");
  }

  async function waitForComposer(timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const editor = document.querySelector('#prompt-textarea[contenteditable="true"]');
      if (editor instanceof HTMLElement) {
        return editor;
      }

      const textarea = document.querySelector('textarea[aria-label="Chat with ChatGPT"]');
      if (textarea instanceof HTMLElement) {
        return textarea;
      }

      await delay(100);
    }

    throw new Error("Timed out waiting for ChatGPT composer.");
  }

  function getLatestAssistantTurnText(beforeTurnMarker, promptText) {
    return getUIResponseState(beforeTurnMarker, promptText).text;
  }

  function getUIResponseState(beforeTurnMarker, promptText) {
    const newTurns = getResponseCandidateTurns(beforeTurnMarker, promptText);
    const assistantTurn = [...newTurns].reverse().find(isAssistantTurn);
    if (!assistantTurn) {
      return {
        text: "",
        active: isChatGPTResponseActive(null)
      };
    }

    const text = extractAssistantTurnText(assistantTurn) ||
      cleanTurnText(assistantTurn.innerText || assistantTurn.textContent || "");

    return {
      text: text === cleanTurnText(promptText) || isTransientAnswerText(text) ? "" : text,
      active: isChatGPTResponseActive(assistantTurn)
    };
  }

  function shouldFinishUIResponse(responseState, timing) {
    if (!responseState.text || !timing.lastObservedText) return false;
    if (responseState.active) return false;

    const now = Date.now();
    const quietMs = body.stream ? 350 : 220;
    return now - timing.lastTextChangedAt >= quietMs &&
      now - timing.lastActiveAt >= 120;
  }

  function isAssistantTurn(turn) {
    return turn?.getAttribute("data-turn") === "assistant" ||
      Boolean(turn?.querySelector?.('[data-message-author-role="assistant"]'));
  }

  function isUserTurn(turn) {
    return turn?.getAttribute("data-turn") === "user" ||
      Boolean(turn?.querySelector?.('[data-message-author-role="user"]'));
  }

  function isChatGPTResponseActive(assistantTurn) {
    if (document.querySelector('[data-testid="stop-button"], button[aria-label="Stop answering"]')) {
      return true;
    }

    return Boolean(assistantTurn?.querySelector?.([
      ".streaming-animation",
      '[data-is-streaming="true"]',
      '[aria-busy="true"]',
      '[data-testid*="streaming"]'
    ].join(",")));
  }

  function extractAssistantTurnText(turn) {
    const assistant = turn.querySelector('[data-message-author-role="assistant"]') || turn;
    const writingBlock = assistant.querySelector(
      '[data-writing-block] .ProseMirror.markdown, [data-writing-block] .mt4SwW_editor'
    );
    if (writingBlock instanceof HTMLElement) {
      return cleanTurnText(writingBlock.innerText || writingBlock.textContent || "");
    }

    const markdown = assistant.querySelector(".markdown");
    if (markdown instanceof HTMLElement) {
      const clone = markdown.cloneNode(true);
      clone.querySelectorAll("pre").forEach((pre) => {
        if (!clone.contains(pre)) return;

        const codeNode = pre.querySelector(".cm-content code, pre code, code");
        const codeText = codeNode?.textContent || pre.textContent || "";
        const language = extractCodeLanguage(pre);
        const replacement = document.createElement("div");
        replacement.textContent = `\n\`\`\`${language}\n${codeText.trimEnd()}\n\`\`\`\n`;
        pre.replaceWith(replacement);
      });
      clone.querySelectorAll([
        ".sr-only",
        "button",
        '[role="button"]',
        '[data-testid^="writing-block-header"]',
        '[data-testid*="magic-edit"]'
      ].join(",")).forEach((element) => element.remove());
      return cleanTurnText(clone.innerText || clone.textContent || "");
    }

    return "";
  }

  function extractCodeLanguage(pre) {
    const headerText = Array.from(pre.children)
      .map((element) => cleanTurnText(element.innerText || element.textContent || ""))
      .find((text) => text);
    const language = (headerText || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !/^(run|copy)$/i.test(line));

    return /^[a-z0-9+#.-]{1,24}$/i.test(language || "") ? language.toLowerCase() : "";
  }

  function getConversationTurns() {
    return Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
  }

  function getResponseCandidateTurns(beforeTurnMarker, promptText) {
    const turns = getConversationTurns();
    const markerIndex = beforeTurnMarker
      ? turns.findIndex((turn) => getTurnMarker(turn) === beforeTurnMarker)
      : -1;
    const startIndex = markerIndex >= 0 ? markerIndex + 1 : 0;
    const promptIndex = findLastTurnIndex(turns, (turn, index) =>
      index >= startIndex && isUserTurn(turn) && turnMatchesPrompt(turn, promptText)
    );

    if (promptIndex >= 0) {
      return turns.slice(promptIndex + 1);
    }

    return markerIndex >= 0 ? turns.slice(startIndex) : [];
  }

  function findLastTurnIndex(turns, predicate) {
    for (let index = turns.length - 1; index >= 0; index--) {
      if (predicate(turns[index], index)) return index;
    }

    return -1;
  }

  function turnMatchesPrompt(turn, promptText) {
    const turnText = normalizeComparableText(turn.innerText || turn.textContent || "");
    const expectedText = normalizeComparableText(promptText);
    return Boolean(expectedText && turnText.includes(expectedText));
  }

  function getLastTurnMarker() {
    const turns = getConversationTurns();
    return getTurnMarker(turns[turns.length - 1]);
  }

  function getTurnMarker(turn) {
    if (!(turn instanceof HTMLElement)) return "";

    return turn.getAttribute("data-turn-id") ||
      `${turn.getAttribute("data-testid") || ""}:${turn.getAttribute("data-turn") || ""}:${cleanTurnText(turn.innerText || turn.textContent || "").slice(0, 120)}`;
  }

  function cleanTurnText(text) {
    return String(text || "")
      .replace(/\n+(Copy|Share|Good response|Bad response|Read aloud|Regenerate).*$/s, "")
      .replace(/^(?:(?:Thinking|ChatGPT said:|Edit)\s*)+/g, "")
      .replace(/\s+\n/g, "\n")
      .trim();
  }

  function isTransientAnswerText(text) {
    const normalized = cleanTurnText(text).replace(/\s+/g, " ").trim();
    if (!normalized) return true;

    return /^(thinking|searching( the web)?|creating\b.{0,160}|working\b.{0,160}|writing\b.{0,160})$/i
      .test(normalized);
  }

  function normalizeComparableText(text) {
    return cleanTurnText(text).replace(/\s+/g, " ").trim();
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function extractStreamPatches(data) {
    if (Array.isArray(data)) {
      return data.flatMap(extractStreamPatches);
    }

    if (!data || typeof data !== "object") {
      return [];
    }

    const patches = [];
    if (typeof data.o === "string" && typeof data.p === "string") {
      patches.push(data);
    }

    for (const key of ["patches", "ops", "operations"]) {
      if (Array.isArray(data[key])) {
        patches.push(...data[key].flatMap(extractStreamPatches));
      }
    }

    if (data.v && typeof data.v === "object") {
      patches.push(...extractStreamPatches(data.v));
    }

    return patches;
  }

  function extractMessageText(message) {
    const parts = message?.content?.parts;
    if (Array.isArray(parts)) {
      return parts.map(textFromValue).join("");
    }

    return textFromValue(message?.content?.text) ||
      textFromValue(message?.content?.content) ||
      textFromValue(message?.content);
  }

  function textFromValue(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";

    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (typeof value.value === "string") return value.value;

    return "";
  }
});
