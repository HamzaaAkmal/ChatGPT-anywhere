import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashSecret, makeSecret, redactSecret, safeCompareHash, secretPrefix } from "./security.js";

const DEFAULT_STATE = {
  version: 1,
  adminToken: null,
  config: {
    upstreamBaseUrl: "https://api.openai.com/v1",
    upstreamApiKey: "",
    defaultModel: "gpt-5.5",
    browserSession: {
      defaultModel: "gpt-5.5",
      requestTimeout: 120000,
      maxConcurrency: 1
    }
  },
  keys: []
};

export class Store {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, "state.json");
    this.chatsDir = path.join(dataDir, "chats");
    this.chatIndexPath = path.join(this.chatsDir, "index.json");
    this.state = structuredClone(DEFAULT_STATE);
  }

  async init() {
    await fs.mkdir(this.chatsDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      this.state = mergeState(JSON.parse(raw));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      this.state = mergeState({});
    }

    if (!this.state.adminToken) {
      this.state.adminToken = makeSecret("cga_admin", 36);
      await this.saveState();
    }

    try {
      await fs.access(this.chatIndexPath);
    } catch {
      await this.writeJson(this.chatIndexPath, []);
    }
  }

  async saveState() {
    await this.writeJson(this.statePath, this.state);
  }

  async writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  getAdminToken() {
    return this.state.adminToken;
  }

  getConfig() {
    return { ...this.state.config };
  }

  getPublicConfig() {
    return {
      upstreamBaseUrl: this.state.config.upstreamBaseUrl,
      defaultModel: this.state.config.defaultModel,
      upstreamApiKey: redactSecret(this.state.config.upstreamApiKey),
      browserSession: this.state.config.browserSession
    };
  }

  async patchConfig(patch) {
    const next = {};

    if (typeof patch.upstreamBaseUrl === "string" && patch.upstreamBaseUrl.trim()) {
      next.upstreamBaseUrl = patch.upstreamBaseUrl.trim().replace(/\/+$/, "");
    }

    if (typeof patch.defaultModel === "string" && patch.defaultModel.trim()) {
      next.defaultModel = patch.defaultModel.trim();
    }

    if (typeof patch.upstreamApiKey === "string") {
      next.upstreamApiKey = patch.upstreamApiKey.trim();
    }

    if (patch.browserSession && typeof patch.browserSession === "object") {
      next.browserSession = {
        ...this.state.config.browserSession,
        ...patch.browserSession
      };
    }

    this.state.config = {
      ...this.state.config,
      ...next
    };

    await this.saveState();
    return this.getPublicConfig();
  }

  listKeys() {
    return this.state.keys.map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt || null,
      disabled: Boolean(key.disabled)
    }));
  }

  async createApiKey(name = "Local client") {
    const secret = makeSecret("cga_local", 36);
    const hashed = hashSecret(secret);
    const key = {
      id: `key_${randomUUID()}`,
      name: String(name || "Local client").slice(0, 80),
      prefix: secretPrefix(secret),
      salt: hashed.salt,
      hash: hashed.hash,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      disabled: false
    };

    this.state.keys.unshift(key);
    await this.saveState();

    return {
      ...this.listKeys().find((item) => item.id === key.id),
      secret
    };
  }

  async deleteApiKey(id) {
    const before = this.state.keys.length;
    this.state.keys = this.state.keys.filter((key) => key.id !== id);

    if (this.state.keys.length !== before) {
      await this.saveState();
      return true;
    }

    return false;
  }

  async verifyApiKey(secret) {
    if (!secret) {
      return null;
    }

    const key = this.state.keys.find((candidate) => {
      if (candidate.disabled) {
        return false;
      }

      return safeCompareHash(secret, candidate.salt, candidate.hash);
    });

    if (!key) {
      return null;
    }

    key.lastUsedAt = new Date().toISOString();
    await this.saveState();
    return {
      id: key.id,
      name: key.name
    };
  }

  async listChats(limit = 50) {
    const index = await this.readChatIndex();
    return index.slice(0, Number(limit) || 50);
  }

  async getChat(id) {
    const safeId = sanitizeChatId(id);
    const chatPath = path.join(this.chatsDir, `${safeId}.json`);

    try {
      return JSON.parse(await fs.readFile(chatPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  async upsertChatTurn({ chatId, requestMessages, responseMessage, model, completionId, streamed, usage, error }) {
    const now = new Date().toISOString();
    const safeId = sanitizeChatId(chatId || `chat_${Date.now()}_${randomUUID().slice(0, 8)}`);
    const previous = await this.getChat(safeId);
    const assistantMessage = responseMessage || {
      role: "assistant",
      content: ""
    };

    const chat = previous || {
      id: safeId,
      title: titleFromMessages(requestMessages),
      createdAt: now,
      updatedAt: now,
      messages: [],
      turns: []
    };

    chat.updatedAt = now;
    chat.title = chat.title || titleFromMessages(requestMessages);
    chat.messages = [...requestMessages, assistantMessage].filter(Boolean);
    chat.turns.unshift({
      id: `turn_${randomUUID()}`,
      createdAt: now,
      model,
      completionId,
      streamed: Boolean(streamed),
      requestMessages,
      responseMessage: assistantMessage,
      usage: usage || null,
      error: error || null
    });

    await this.writeJson(path.join(this.chatsDir, `${safeId}.json`), chat);
    await this.updateChatIndex(chat, assistantMessage);

    return chat;
  }

  async readChatIndex() {
    try {
      return JSON.parse(await fs.readFile(this.chatIndexPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async updateChatIndex(chat, assistantMessage) {
    const index = await this.readChatIndex();
    const withoutCurrent = index.filter((item) => item.id !== chat.id);
    const item = {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      model: chat.turns[0]?.model || null,
      messageCount: chat.messages.length,
      preview: messagePreview(assistantMessage)
    };

    await this.writeJson(this.chatIndexPath, [item, ...withoutCurrent].slice(0, 200));
  }
}

function mergeState(input) {
  return {
    ...structuredClone(DEFAULT_STATE),
    ...input,
    config: {
      ...DEFAULT_STATE.config,
      ...(input.config || {}),
      browserSession: {
        ...DEFAULT_STATE.config.browserSession,
        ...(input.config?.browserSession || {})
      }
    },
    keys: Array.isArray(input.keys) ? input.keys : []
  };
}

function sanitizeChatId(id) {
  return String(id || "")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 120);
}

function titleFromMessages(messages = []) {
  const firstUser = messages.find((message) => message?.role === "user");
  const text = messagePreview(firstUser);
  return text || "New chat";
}

function messagePreview(message) {
  const content = message?.content;

  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim().slice(0, 120);
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        return part?.text || part?.type || "";
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  return "";
}
