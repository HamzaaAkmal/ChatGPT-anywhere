# ChatGPT Anywhere API Usage

Official local API reference for the ChatGPT Anywhere server.

## Overview

ChatGPT Anywhere exposes a local OpenAI-compatible API at:

```text
http://127.0.0.1:8787
```

The default model is:

```text
gpt-5.5
```

The server can run in two modes:

- Browser mode: uses the connected Chrome extension and your logged-in ChatGPT session.
- Upstream mode: uses `OPENAI_API_KEY` or the configured upstream API key when no extension is connected.

Browser mode is the main mode for this project.

## Authentication

Every `/v1/*` request requires a local API key:

```http
Authorization: Bearer cga_local_xxx
```

Create or list keys from the admin endpoints using the admin token printed when the server starts.

## Health

```bash
curl http://127.0.0.1:8787/health
```

Example response:

```json
{
  "ok": true,
  "service": "chatgpt-anywhere",
  "version": "0.1.0",
  "extensionConnected": true,
  "mode": "browser"
}
```

## Chat Completions

Endpoint:

```http
POST /v1/chat/completions
```

## Streamlit UI

Install the Python UI dependencies:

```bash
python -m pip install -r requirements.txt
```

Run the local chat UI:

```bash
streamlit run streamlit_app.py
```

The UI supports:

- Chatting through the local `/v1/chat/completions` API.
- Streaming responses.
- Plain, cleaned display that removes raw Markdown clutter while keeping code blocks readable.
- Generated image rendering from returned `/v1/files/...` URLs.
- Uploading images and files.
- Optional direct upstream mode for lower latency when you configure your own provider API key.

File upload behavior:

- Text-like files, code files, CSV, JSON, Markdown, logs, and PDFs are converted to prompt text.
- Images are sent as OpenAI-compatible `image_url` data URLs for direct upstream mode.
- Browser mode can show image attachments in the prompt, but true image understanding needs direct upstream mode with a vision-capable model.

### Non-Streaming Example

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer cga_local_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "messages": [
      { "role": "user", "content": "Write a haiku" }
    ],
    "stream": false
  }'
```

### Streaming Example

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer cga_local_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "messages": [
      { "role": "user", "content": "Count from 1 to 20" }
    ],
    "stream": true
  }'
```

## Chat Selection

By default, browser mode uses the most recent connected ChatGPT tab/chat. This keeps normal follow-up behavior fast and natural.

To force a fresh ChatGPT chat, send `new_chat: true`:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer cga_local_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "new_chat": true,
    "messages": [
      { "role": "user", "content": "Start a clean conversation and say hello." }
    ],
    "stream": false
  }'
```

Equivalent names:

```json
{ "new_chat": true }
```

```json
{ "cga": { "new_chat": true } }
```

When `new_chat` is omitted or false, the bridge uses the most recent connected ChatGPT chat.

## Image Generation

Ask for an image in the normal chat endpoint:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer cga_local_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "messages": [
      { "role": "user", "content": "Create an image of the moon" }
    ],
    "stream": true
  }'
```

The assistant content will include local image links:

```text
Image 1: http://127.0.0.1:8787/v1/files/...
```

The final response or final stream chunk also includes:

```json
{
  "images": [
    {
      "url": "http://127.0.0.1:8787/v1/files/...",
      "source_url": "https://chatgpt.com/...",
      "file_name": "generated-file.png",
      "mime_type": "image/png",
      "width": 1254,
      "height": 1254,
      "alt": "Generated image"
    }
  ]
}
```

Fetch the image with:

```bash
curl -L "http://127.0.0.1:8787/v1/files/generated-file.png" -o image.png
```

## Request Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `gpt-5.5` | Model name shown in the OpenAI-compatible response. Browser mode asks ChatGPT to use this model when possible. |
| `messages` | array | required | OpenAI-style messages. Supported roles: `system`, `user`, `assistant`. |
| `stream` | boolean | `false` | When true, returns server-sent events using OpenAI chat completion chunk format. |
| `new_chat` | boolean/string/number | `false` | When true, opens a fresh ChatGPT chat before sending the prompt. When false or omitted, uses the most recent connected ChatGPT chat. Accepts `true`, `1`, `"true"`, or `"1"`. |
| `force_upstream` | boolean/string/number | `false` | When true, skips the browser extension and calls the configured upstream API directly. This is the safe low-latency path and requires an upstream API key. |
| `prefer_upstream` | boolean/string/number | `false` | Alias for `force_upstream`. |
| `conversation_id` | string | none | Advanced. Used by the direct ChatGPT backend path when available. Browser UI mode normally uses the currently loaded ChatGPT tab instead. |
| `chat_id` | string | generated | Local archive id for server-side chat history storage. |
| `append_context` | boolean | `false` | Upstream fallback only. Appends stored local messages for the same `chat_id`. |
| `use_stored_context` | boolean | `false` | Alias for `append_context`. |
| `temperature` | number | provider default | Passed to upstream OpenAI API fallback. Browser UI mode may ignore it. |
| `max_tokens` | number | provider default | Passed to upstream OpenAI API fallback. Browser UI mode may ignore it. |

## `cga` Parameters

Place bridge-specific options inside `cga` if you want to avoid top-level custom fields:

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `cga.new_chat` | boolean/string/number | `false` | Same as top-level `new_chat`. |
| `cga.force_upstream` | boolean/string/number | `false` | Same as top-level `force_upstream`. |
| `cga.prefer_upstream` | boolean/string/number | `false` | Alias for `cga.force_upstream`. |
| `cga.prefer_backend` | boolean | `false` | When true, tries the direct ChatGPT backend path before the UI path. |
| `cga.live_ui_stream` | boolean | `true` | When true, streams visible UI text as it appears. Set false to buffer until final. |
| `cga.materialize_images` | boolean | `true` | When true, attempts to save generated image bytes to local `/v1/files/...` URLs. |
| `cga.chat_id` | string | generated | Local archive id alias. |
| `cga.append_context` | boolean | `false` | Upstream fallback context append alias. |

## Response Fields

### Non-Streaming

```json
{
  "id": "chatcmpl-xxxx",
  "object": "chat.completion",
  "created": 1785578996,
  "model": "gpt-5.5",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 3,
    "completion_tokens": 1,
    "total_tokens": 4
  },
  "time_taken_ms": 6249,
  "usage_source": "estimated_browser_ui",
  "images": []
}
```

### Streaming

Streaming responses follow OpenAI-style SSE chunks. The final chunk includes:

```json
{
  "choices": [
    {
      "index": 0,
      "delta": {},
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 11,
    "completion_tokens": 27,
    "total_tokens": 38
  },
  "time_taken_ms": 3782,
  "images": [],
  "cga": {
    "full_content": "1 2 3 ...",
    "usage_source": "estimated_browser_ui"
  }
}
```

Browser mode token counts are estimated because the ChatGPT web UI does not expose exact API token usage. Upstream OpenAI API mode returns provider usage when available.

## Admin Endpoints

Admin endpoints require the admin token:

```http
Authorization: Bearer cga_admin_xxx
```

| Endpoint | Method | Description |
| --- | --- | --- |
| `/admin/config` | `GET` | Read public config. |
| `/admin/config` | `PUT` | Update config such as `defaultModel`, `upstreamBaseUrl`, `upstreamApiKey`, or `browserSession`. |
| `/admin/keys` | `GET` | List local API keys. |
| `/admin/keys` | `POST` | Create a local API key. Body: `{ "name": "my app" }`. |
| `/admin/keys/:id` | `DELETE` | Delete a local API key. |
| `/admin/chats` | `GET` | List locally archived chats. Optional query: `limit`. |
| `/admin/chats/:id` | `GET` | Read a locally archived chat. |

## Notes

- Keep at least one logged-in ChatGPT tab available for browser mode.
- Reload the Chrome extension after changing files in `extension/`.
- For lowest latency, keep the ChatGPT tab warm and use `stream: true`.
- Millisecond-level latency is not realistic through the ChatGPT web UI. For that, configure an upstream API key and call the provider API directly.
