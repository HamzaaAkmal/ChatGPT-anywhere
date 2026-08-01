import { randomUUID } from "node:crypto";

export function buildChatGPTRequest(openAIBody) {
  const model = mapModel(openAIBody.model);
  const action = "next";
  const parentMessageId = randomUUID();
  const conversationId = openAIBody.conversation_id;

  const messages = (openAIBody.messages || []).map((msg) => {
    let contentParts = [];
    if (typeof msg.content === "string") {
      contentParts = [msg.content];
    } else if (Array.isArray(msg.content)) {
      contentParts = msg.content.map(part => part.text || "");
    }
    return {
      id: randomUUID(),
      author: { role: msg.role },
      content: { content_type: "text", parts: contentParts },
      metadata: {}
    };
  });

  const request = {
    action,
    model,
    parent_message_id: parentMessageId,
    messages
  };

  if (conversationId) {
    request.conversation_id = conversationId;
  }

  return request;
}

function mapModel(model) {
  if (!model) return "auto";
  const m = model.toLowerCase();
  if (m.includes("gpt-4o-mini")) return "gpt-4o-mini";
  if (m.includes("gpt-4o")) return "gpt-4o";
  if (m.includes("o3")) return "o3";
  if (m.includes("gpt-4")) return "gpt-4";
  return "auto";
}

export function parseSSEChunk(line) {
  if (!line.startsWith("data:")) return { type: "ignore" };
  const data = line.slice(5).trim();
  if (data === "[DONE]") return { type: "done" };
  if (!data) return { type: "ignore" };

  try {
    const parsed = JSON.parse(data);
    if (parsed.error) {
      return { type: "error", error: parsed.error };
    }
    
    if (parsed.message?.content?.parts?.[0] !== undefined) {
      const content = parsed.message.content.parts[0];
      const messageId = parsed.message.id;
      const conversationId = parsed.conversation_id;
      const model = parsed.message.metadata?.model_slug || "auto";

      if (parsed.message.author?.role === "assistant") {
         return { type: "delta", content, messageId, conversationId, model };
      }
    }
    
    return { type: "ignore" };
  } catch {
    return { type: "ignore" };
  }
}

export function toOpenAIChunk(parsed, requestId, model) {
  return JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || "gpt-4o",
    choices: [
      {
        index: 0,
        delta: { content: parsed.content },
        finish_reason: null
      }
    ]
  });
}

export function toOpenAIResponse(fullContent, requestId, model, usage = {}) {
  return JSON.stringify({
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "gpt-4o",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: fullContent
        },
        finish_reason: "stop"
      }
    ],
    usage: usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  });
}
