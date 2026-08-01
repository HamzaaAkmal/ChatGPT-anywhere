import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Store } from "./lib/store.js";
import { WebSocketServer } from "./lib/ws.js";
import { buildChatGPTRequest, parseSSEChunk, toOpenAIChunk, toOpenAIResponse } from "./lib/chatgpt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, ".data");
const filesDir = path.join(dataDir, "files");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const store = new Store({ dataDir });

await store.init();
await fs.mkdir(filesDir, { recursive: true });

if (process.env.OPENAI_API_KEY) {
  await store.patchConfig({ upstreamApiKey: process.env.OPENAI_API_KEY });
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (error) {
    console.error(error);
    sendJson(req, res, 500, {
      error: {
        message: "Internal server error",
        type: "server_error"
      }
    });
  }
});

server.listen(port, host, () => {
  console.log(`ChatGPT Anywhere server listening on http://${host}:${port}`);
  console.log(`Admin token: ${store.getAdminToken()}`);
});

let extensionConnection = null;
const remoteImageSources = new Map();
const wsServer = new WebSocketServer(server, { path: "/ws/extension" });

wsServer.on("connection", (conn) => {
  if (extensionConnection) {
    extensionConnection.close();
  }
  extensionConnection = conn;
  console.log("Extension connected");

  conn.on("close", () => {
    if (extensionConnection === conn) {
      extensionConnection = null;
      console.log("Extension disconnected");
    }
  });
});

const requestQueue = [];
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    try {
      await task();
    } catch (e) {
      console.error("Queue task error", e);
    }
  }
  isProcessingQueue = false;
}

async function handleRequest(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);

  if (req.method === "GET" && url.pathname === "/health") {
    const config = store.getConfig();
    const hasKey = Boolean(config.upstreamApiKey);
    const hasExt = Boolean(extensionConnection && extensionConnection.isAlive);
    const mode = hasExt ? "browser" : (hasKey ? "api" : "disconnected");
    sendJson(req, res, 200, {
      ok: true,
      service: "chatgpt-anywhere",
      version: "0.1.0",
      extensionConnected: hasExt,
      mode
    });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/v1/files/")) {
    await serveLocalFile(req, res, url);
    return;
  }

  if (url.pathname.startsWith("/admin/")) {
    await handleAdmin(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    await requireClientKey(req, res);
    if (res.writableEnded) return;
    await proxyModels(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const client = await requireClientKey(req, res);
    if (res.writableEnded) return;
    await proxyChatCompletions(req, res, client);
    return;
  }

  sendJson(req, res, 404, {
    error: {
      message: `No route for ${req.method} ${url.pathname}`,
      type: "not_found"
    }
  });
}

async function handleAdmin(req, res, url) {
  if (!requireAdmin(req, res)) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/admin/config") {
    sendJson(req, res, 200, store.getPublicConfig());
    return;
  }

  if (req.method === "PUT" && url.pathname === "/admin/config") {
    const body = await readJson(req);
    const config = await store.patchConfig(body);
    sendJson(req, res, 200, config);
    return;
  }

  if (req.method === "GET" && url.pathname === "/admin/keys") {
    sendJson(req, res, 200, {
      data: store.listKeys()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/keys") {
    const body = await readJson(req);
    const key = await store.createApiKey(body.name);
    sendJson(req, res, 201, key);
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/admin/keys/")) {
    const id = decodeURIComponent(url.pathname.replace("/admin/keys/", ""));
    const deleted = await store.deleteApiKey(id);
    sendJson(req, res, deleted ? 200 : 404, { deleted });
    return;
  }

  if (req.method === "GET" && url.pathname === "/admin/chats") {
    const limit = Number(url.searchParams.get("limit") || 50);
    sendJson(req, res, 200, {
      data: await store.listChats(limit)
    });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/admin/chats/")) {
    const id = decodeURIComponent(url.pathname.replace("/admin/chats/", ""));
    const chat = await store.getChat(id);
    sendJson(req, res, chat ? 200 : 404, chat || { error: { message: "Chat not found" } });
    return;
  }

  sendJson(req, res, 404, {
    error: {
      message: `No admin route for ${req.method} ${url.pathname}`,
      type: "not_found"
    }
  });
}

async function proxyModels(req, res) {
  const config = store.getConfig();

  if (!config.upstreamApiKey) {
    sendJson(req, res, 400, {
      error: {
        message: "Upstream OpenAI API key is not configured",
        type: "configuration_error"
      }
    });
    return;
  }

  const upstream = await fetch(`${config.upstreamBaseUrl}/models`, {
    headers: {
      Authorization: `Bearer ${config.upstreamApiKey}`
    }
  });

  await forwardJsonResponse(req, res, upstream);
}

async function proxyChatCompletions(req, res, client) {
  const config = store.getConfig();
  const body = await readJson(req);
  const local = getLocalRequestOptions(req, body);

  if (extensionConnection && extensionConnection.isAlive) {
    return new Promise((resolve) => {
      let clientClosedBeforeRun = false;
      const markClientClosedBeforeRun = () => {
        if (!res.writableEnded) {
          clientClosedBeforeRun = true;
        }
      };
      res.once("close", markClientClosedBeforeRun);
      req.once("aborted", markClientClosedBeforeRun);

      requestQueue.push(async () => {
        res.removeListener("close", markClientClosedBeforeRun);
        req.removeListener("aborted", markClientClosedBeforeRun);
        if (clientClosedBeforeRun) {
          resolve();
          return;
        }

        await forwardToExtension(req, res, body, local, config, client);
        resolve();
      });
      processQueue();
    });
  }

  const upstreamBody = await buildUpstreamChatBody(body, local, config);

  if (!config.upstreamApiKey) {
    sendJson(req, res, 400, {
      error: {
        message: "No extension connected and upstream OpenAI API key is not configured",
        type: "configuration_error"
      }
    });
    return;
  }

  if (!Array.isArray(upstreamBody.messages)) {
    sendJson(req, res, 400, {
      error: {
        message: "messages must be an array",
        type: "invalid_request_error",
        param: "messages"
      }
    });
    return;
  }

  const upstream = await fetch(`${config.upstreamBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.upstreamApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(upstreamBody)
  });

  if (upstreamBody.stream) {
    await forwardStreamingChat(req, res, upstream, {
      chatId: local.chatId,
      requestMessages: upstreamBody.messages,
      model: upstreamBody.model,
      client
    });
    return;
  }

  await forwardBufferedChat(req, res, upstream, {
    chatId: local.chatId,
    requestMessages: upstreamBody.messages,
    model: upstreamBody.model,
    client
  });
}

async function forwardToExtension(req, res, body, local, config, client) {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const isStreaming = Boolean(body.stream);

    let isFinished = false;
    let fullContentBuffer = "";
    let materializedImages = [];
    const startedAtMs = Date.now();
    const requestedModel = body.model ||
      config.browserSession?.defaultModel ||
      config.defaultModel ||
      "gpt-5.5";
    let finalModel = requestedModel;
    const requestTimeout = Math.max(
      config.browserSession?.requestTimeout || 120000,
      isLikelyImageRequest(body) ? 300000 : 0
    );
    const onClientClose = () => {
      if (isFinished || res.writableEnded) return;
      sendCancelToExtension("Client disconnected.");
      finish(null, { skipResponse: true, skipStore: true });
    };

    res.once("close", onClientClose);
    req.once("aborted", onClientClose);

    if (isStreaming) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });

      // Send initial role delta
      const roleDelta = JSON.stringify({
        id: `chatcmpl-${requestId.slice(0, 8)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: finalModel,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
      });
      res.write(`data: ${roleDelta}\n\n`);
    }

    const timeout = setTimeout(() => {
      if (!isFinished) {
        finish("Request timed out waiting for ChatGPT response.");
      }
    }, requestTimeout);

    function sendCancelToExtension(reason) {
      try {
        extensionConnection?.send(JSON.stringify({
          type: "cancel",
          requestId,
          reason
        }));
      } catch {
        // The extension may already be disconnected.
      }
    }

    function finish(error, options = {}) {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeout);
      res.removeListener("close", onClientClose);
      req.removeListener("aborted", onClientClose);

      if (extensionConnection) {
        extensionConnection.removeListener("message", onMessage);
        extensionConnection.removeListener("close", onClose);
      }

      if (options.skipResponse) {
        resolve();
        return;
      }

      if (error && !isStreaming && !res.writableEnded) {
        sendJson(req, res, 502, {
          error: { message: String(error), type: "bridge_error" }
        });
        resolve();
        return;
      }

      if (isStreaming && !res.writableEnded) {
        if (error) {
          // Emit the error visibly in the stream
          const errorChunk = JSON.stringify({
            error: { message: String(error), type: "bridge_error" }
          });
          res.write(`data: ${errorChunk}\n\n`);
        } else {
          // Send final chunk with finish_reason only on clean completion
          const finalChunk = JSON.stringify({
            id: `chatcmpl-${requestId.slice(0, 8)}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: finalModel,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: estimateUsage(body.messages || [], fullContentBuffer),
            time_taken_ms: Date.now() - startedAtMs,
            images: materializedImages,
            cga: {
              full_content: fullContentBuffer,
              usage_source: "estimated_browser_ui"
            }
          });
          res.write(`data: ${finalChunk}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }

      if (!options.skipStore) {
        store.upsertChatTurn({
          chatId: local.chatId,
          requestMessages: body.messages || [],
          responseMessage: { role: "assistant", content: fullContentBuffer },
          model: finalModel,
          completionId: `chatcmpl-${requestId.slice(0, 8)}`,
          streamed: isStreaming,
          usage: estimateUsage(body.messages || [], fullContentBuffer)
        }).catch((err) => console.error("Failed to store chat turn:", err));
      }

      resolve();
    }

    function onClose() {
      if (!isFinished) {
        finish("Extension disconnected during request.");
      }
    }

    async function onMessage(rawMsg) {
      try {
        const msg = typeof rawMsg === "string" ? JSON.parse(rawMsg) : rawMsg;
        if (msg.requestId !== requestId) return;

        if (msg.type === "chunk") {
          const delta = msg.delta || "";
          fullContentBuffer += delta;

          if (isStreaming && delta) {
            const chunk = JSON.stringify({
              id: `chatcmpl-${requestId.slice(0, 8)}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: finalModel,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
            });
            res.write(`data: ${chunk}\n\n`);
          }
        } else if (msg.type === "done") {
          materializedImages = await materializeBridgeImages(msg.images || [], req, {
            bridgeTabId: msg.bridgeTabId
          });
          const finalContent = mergeContentAndImages(msg.fullContent || fullContentBuffer, materializedImages);
          const imageContent = imageLines(materializedImages);
          const finalDelta = finalContent.startsWith(fullContentBuffer)
            ? finalContent.slice(fullContentBuffer.length)
            : materializedImages.length
              ? (fullContentBuffer ? `\n\n${imageContent}` : imageContent)
              : (!fullContentBuffer ? finalContent : "");

          if (isStreaming && finalDelta && !res.writableEnded) {
            const chunk = JSON.stringify({
              id: `chatcmpl-${requestId.slice(0, 8)}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: finalModel,
              choices: [{ index: 0, delta: { content: finalDelta }, finish_reason: null }]
            });
            res.write(`data: ${chunk}\n\n`);
          }

          fullContentBuffer = finalContent || fullContentBuffer;

          if (!isStreaming && !res.writableEnded) {
            const usage = estimateUsage(body.messages || [], fullContentBuffer);
            const response = {
              id: `chatcmpl-${requestId.slice(0, 8)}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: finalModel,
              choices: [{
                index: 0,
                message: { role: "assistant", content: fullContentBuffer },
                finish_reason: "stop"
              }],
              usage,
              time_taken_ms: Date.now() - startedAtMs,
              usage_source: "estimated_browser_ui",
              images: materializedImages
            };
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(response, null, 2) + "\n");
          }

          finish(null);
        } else if (msg.type === "error") {
          finish(msg.error || "Unknown extension error");
        }
      } catch {
        // ignore malformed messages
      }
    }

    extensionConnection.on("message", onMessage);
    extensionConnection.on("close", onClose);

    try {
      extensionConnection.send(JSON.stringify({
        type: "prompt",
        requestId,
        body: {
          ...body,
          model: requestedModel
        }
      }));
    } catch {
      onClose();
    }
  });
}

async function buildUpstreamChatBody(body, local, config) {
  const upstreamBody = { ...body };

  delete upstreamBody.chat_id;
  delete upstreamBody.conversation_id;
  delete upstreamBody.append_context;
  delete upstreamBody.use_stored_context;
  delete upstreamBody.store_locally;
  delete upstreamBody.cga;

  upstreamBody.model = upstreamBody.model || config.defaultModel;

  if (local.appendContext && local.chatId) {
    const previous = await store.getChat(local.chatId);
    const newMessages = Array.isArray(body.messages) ? body.messages : [];
    upstreamBody.messages = [...(previous?.messages || []), ...newMessages];
  }

  return upstreamBody;
}

async function forwardBufferedChat(req, res, upstream, meta) {
  const raw = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "application/json";

  res.writeHead(upstream.status, {
    "Content-Type": contentType
  });
  res.end(raw);

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (upstream.ok && parsed) {
    await store.upsertChatTurn({
      chatId: meta.chatId,
      requestMessages: meta.requestMessages,
      responseMessage: parsed.choices?.[0]?.message,
      model: parsed.model || meta.model,
      completionId: parsed.id,
      streamed: false,
      usage: parsed.usage || null
    });
  }
}

async function forwardStreamingChat(req, res, upstream, meta) {
  if (!upstream.ok) {
    await forwardJsonResponse(req, res, upstream);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantRole = "assistant";
  let assistantContent = "";
  let completionId = null;
  let responseModel = meta.model;
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    res.write(value);
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) {
        continue;
      }

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }

      try {
        const chunk = JSON.parse(payload);
        completionId = completionId || chunk.id;
        responseModel = chunk.model || responseModel;
        usage = chunk.usage || usage;

        const delta = chunk.choices?.[0]?.delta;
        assistantRole = delta?.role || assistantRole;

        if (typeof delta?.content === "string") {
          assistantContent += delta.content;
        }
      } catch {
        // Ignore malformed upstream chunks; the raw stream has already been forwarded.
      }
    }
  }

  res.end();

  await store.upsertChatTurn({
    chatId: meta.chatId,
    requestMessages: meta.requestMessages,
    responseMessage: {
      role: assistantRole,
      content: assistantContent
    },
    model: responseModel,
    completionId,
    streamed: true,
    usage
  });
}

async function forwardJsonResponse(req, res, upstream) {
  const raw = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "application/json";

  res.writeHead(upstream.status, {
    "Content-Type": contentType
  });
  res.end(raw);
}

function getLocalRequestOptions(req, body) {
  const chatId = req.headers["x-chat-id"] ||
    body.chat_id ||
    body.conversation_id ||
    body.cga?.chat_id ||
    body.metadata?.chat_id ||
    `chat_${Date.now()}_${randomUUID().slice(0, 8)}`;

  return {
    chatId,
    appendContext: Boolean(body.append_context ?? body.use_stored_context ?? body.cga?.append_context)
  };
}

async function requireClientKey(req, res) {
  const token = getBearerToken(req);
  const key = await store.verifyApiKey(token);

  if (!key) {
    sendJson(req, res, 401, {
      error: {
        message: "A valid local API key is required",
        type: "authentication_error"
      }
    });
    return null;
  }

  return key;
}

function requireAdmin(req, res) {
  const token = getBearerToken(req) || req.headers["x-admin-token"];

  if (token !== store.getAdminToken()) {
    sendJson(req, res, 401, {
      error: {
        message: "A valid admin token is required",
        type: "authentication_error"
      }
    });
    return false;
  }

  return true;
}

function getBearerToken(req) {
  const value = req.headers.authorization || "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > 2_000_000) {
      throw new Error("Request body exceeds 2MB limit");
    }

    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

function sendJson(req, res, status, payload) {
  setCors(req, res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = !origin ||
    origin.startsWith("chrome-extension://") ||
    origin === "http://localhost" ||
    origin.startsWith("http://localhost:") ||
    origin === "http://127.0.0.1" ||
    origin.startsWith("http://127.0.0.1:");

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Admin-Token,X-Chat-Id");
}

async function serveLocalFile(req, res, url) {
  setCors(req, res);

  if (url.pathname.startsWith("/v1/files/remote/")) {
    await serveRemoteImageProxy(req, res, url);
    return;
  }

  const fileName = path.basename(decodeURIComponent(url.pathname.replace("/v1/files/", "")));
  if (!/^[a-zA-Z0-9_.-]+$/.test(fileName)) {
    sendJson(req, res, 400, {
      error: { message: "Invalid file name", type: "invalid_request_error" }
    });
    return;
  }

  const filePath = path.join(filesDir, fileName);
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypeForFile(fileName),
      "Cache-Control": "public, max-age=86400"
    });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(req, res, 404, {
        error: { message: "File not found", type: "not_found" }
      });
      return;
    }

    throw error;
  }
}

async function materializeBridgeImages(images, req, options = {}) {
  const output = [];
  const seen = new Set();

  for (const image of Array.isArray(images) ? images : []) {
    const sourceUrl = typeof image?.url === "string" ? image.url : "";
    const key = sourceUrl || image?.dataUrl || randomUUID();
    if (seen.has(key)) continue;
    seen.add(key);

    let url = sourceUrl;
    let fileName = null;
    const dataUrl = typeof image?.dataUrl === "string" ? image.dataUrl : "";
    const parsed = parseDataUrl(dataUrl);

    if (parsed) {
      fileName = `${randomUUID()}${extensionForMimeType(parsed.mimeType)}`;
      await fs.writeFile(path.join(filesDir, fileName), parsed.buffer);
      url = `${getServerBaseUrl(req)}/v1/files/${fileName}`;
    } else if (sourceUrl) {
      const proxyId = randomUUID();
      remoteImageSources.set(proxyId, {
        sourceUrl,
        bridgeTabId: options.bridgeTabId || null,
        createdAt: Date.now()
      });
      url = `${getServerBaseUrl(req)}/v1/files/remote/${proxyId}`;
    }

    if (!url) continue;

    output.push({
      url,
      source_url: sourceUrl || null,
      file_name: fileName,
      mime_type: parsed?.mimeType || image?.mimeType || mimeTypeForUrl(url),
      width: Number(image?.width) || null,
      height: Number(image?.height) || null,
      alt: typeof image?.alt === "string" ? image.alt : ""
    });
  }

  return output;
}

async function serveRemoteImageProxy(req, res, url) {
  const proxyId = path.basename(decodeURIComponent(url.pathname.replace("/v1/files/remote/", "")));
  const entry = remoteImageSources.get(proxyId);
  if (!entry) {
    sendJson(req, res, 404, {
      error: { message: "Image proxy not found or server restarted", type: "not_found" }
    });
    return;
  }

  try {
    const image = await fetchImageViaExtension(entry.sourceUrl, 25000, {
      bridgeTabId: entry.bridgeTabId
    });
    const parsed = parseDataUrl(image.dataUrl);
    if (!parsed) {
      throw new Error("Extension returned invalid image data.");
    }

    res.writeHead(200, {
      "Content-Type": parsed.mimeType,
      "Cache-Control": "public, max-age=86400"
    });
    res.end(parsed.buffer);
  } catch (error) {
    sendJson(req, res, 502, {
      error: {
        message: error.message,
        type: "image_proxy_error"
      }
    });
  }
}

function fetchImageViaExtension(sourceUrl, timeoutMs, options = {}) {
  if (!extensionConnection || !extensionConnection.isAlive) {
    throw new Error("Extension is not connected.");
  }

  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out fetching image through ChatGPT session."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      extensionConnection?.removeListener("message", onMessage);
      extensionConnection?.removeListener("close", onClose);
    }

    function onClose() {
      cleanup();
      reject(new Error("Extension disconnected while fetching image."));
    }

    function onMessage(rawMsg) {
      try {
        const msg = typeof rawMsg === "string" ? JSON.parse(rawMsg) : rawMsg;
        if (msg.requestId !== requestId) return;

        cleanup();
        if (msg.type === "image_fetch_done") {
          resolve(msg.image || {});
        } else if (msg.type === "image_fetch_error") {
          reject(new Error(msg.error || "Image fetch failed."));
        }
      } catch {
        // Ignore malformed messages.
      }
    }

    extensionConnection.on("message", onMessage);
    extensionConnection.on("close", onClose);

    try {
      extensionConnection.send(JSON.stringify({
        type: "fetch_image",
        requestId,
        url: sourceUrl,
        bridgeTabId: options.bridgeTabId,
        timeoutMs: Math.max(1000, timeoutMs - 1000)
      }));
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function mergeContentAndImages(content, images) {
  const cleanContent = String(content || "").trim();
  if (!images?.length) return cleanContent;

  const lines = imageLines(images)
    .split("\n")
    .filter((line) => line && !cleanContent.includes(line));

  if (lines.length === 0) return cleanContent;
  return cleanContent ? `${cleanContent}\n\n${lines.join("\n")}` : lines.join("\n");
}

function imageLines(images) {
  return (images || [])
    .map((image, index) => `Image ${index + 1}: ${image.url}`)
    .join("\n");
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match || !match[2]) return null;

  try {
    return {
      mimeType: match[1] || "application/octet-stream",
      buffer: Buffer.from(match[3], "base64")
    };
  } catch {
    return null;
  }
}

function getServerBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || "http";
  return `${proto}://${req.headers.host || `${host}:${port}`}`;
}

function estimateUsage(messages, content) {
  const promptText = (Array.isArray(messages) ? messages : [])
    .map((message) => messageContentToText(message?.content))
    .join("\n");
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(content);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens
  };
}

function estimateTokens(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return 0;

  const byChars = Math.ceil(normalized.length / 4);
  const byWords = Math.ceil(normalized.split(/\s+/).length * 1.33);
  return Math.max(1, byChars, byWords);
}

function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    }).filter(Boolean).join("\n");
  }

  return content ? JSON.stringify(content) : "";
}

function isLikelyImageRequest(body) {
  const text = messageContentToText((body.messages || []).at?.(-1)?.content || "")
    || (Array.isArray(body.messages) ? body.messages.map((message) => messageContentToText(message.content)).join("\n") : "");

  return /\b(create|generate|make|draw|render|design)\b.{0,80}\b(image|picture|photo|illustration|art|wallpaper|poster|logo)\b/i
    .test(text) ||
    /\b(image|picture|photo|illustration|art|wallpaper|poster|logo)\b.{0,80}\b(of|for|showing|with)\b/i
      .test(text);
}

function mimeTypeForFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function mimeTypeForUrl(url) {
  try {
    return mimeTypeForFile(new URL(url).pathname);
  } catch {
    return "application/octet-stream";
  }
}

function extensionForMimeType(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("gif")) return ".gif";
  return ".png";
}
