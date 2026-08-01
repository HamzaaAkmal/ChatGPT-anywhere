import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Store } from "./lib/store.js";
import { WebSocketServer } from "./lib/ws.js";
import { buildChatGPTRequest, parseSSEChunk, toOpenAIChunk, toOpenAIResponse } from "./lib/chatgpt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, ".data");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const store = new Store({ dataDir });

await store.init();

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
    const requestedModel = body.model ||
      config.browserSession?.defaultModel ||
      config.defaultModel ||
      "gpt-5.5";
    let finalModel = requestedModel;
    const requestTimeout = config.browserSession?.requestTimeout || 120000;
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
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
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
          usage: null
        }).catch((err) => console.error("Failed to store chat turn:", err));
      }

      resolve();
    }

    function onClose() {
      if (!isFinished) {
        finish("Extension disconnected during request.");
      }
    }

    function onMessage(rawMsg) {
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
          fullContentBuffer = msg.fullContent || fullContentBuffer;

          if (!isStreaming && !res.writableEnded) {
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
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
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
