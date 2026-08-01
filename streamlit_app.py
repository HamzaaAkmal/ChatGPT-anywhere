import base64
import html
import json
import os
import re
import time
from io import BytesIO
from pathlib import Path

import requests
import streamlit as st

try:
    from pypdf import PdfReader
except Exception:
    PdfReader = None


DEFAULT_API_BASE = os.getenv("CGA_API_BASE", "http://127.0.0.1:8787")
DEFAULT_MODEL = os.getenv("CGA_MODEL", "gpt-5.5")
MAX_TEXT_CHARS = 80_000
MAX_IMAGE_BYTES = 8 * 1024 * 1024
IMAGE_LINE_RE = re.compile(r"^\s*Image\s+\d+\s*:\s*(https?://\S+)\s*$", re.IGNORECASE | re.MULTILINE)
CODE_BLOCK_RE = re.compile(r"```([a-zA-Z0-9_+.-]*)\n([\s\S]*?)```")


st.set_page_config(
    page_title="ChatGPT Anywhere",
    page_icon="",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown(
    """
    <style>
      .block-container { padding-top: 1.2rem; max-width: 1180px; }
      [data-testid="stSidebar"] .stTextInput input { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .chat-clean {
        line-height: 1.55;
        font-size: 0.98rem;
        white-space: normal;
      }
      .meta-row {
        color: #6b7280;
        font-size: 0.78rem;
        margin-top: .35rem;
      }
      .attachment-chip {
        display: inline-block;
        border: 1px solid #d0d7de;
        border-radius: 999px;
        padding: 0.18rem 0.55rem;
        margin: 0.15rem 0.2rem 0 0;
        color: #374151;
        background: #f6f8fa;
        font-size: 0.78rem;
      }
      .small-note {
        color: #6b7280;
        font-size: 0.82rem;
      }
    </style>
    """,
    unsafe_allow_html=True,
)


def init_state():
    st.session_state.setdefault("messages", [])
    st.session_state.setdefault("api_base", DEFAULT_API_BASE)
    st.session_state.setdefault("api_key", os.getenv("CGA_API_KEY", ""))
    st.session_state.setdefault("model", DEFAULT_MODEL)
    st.session_state.setdefault("stream", True)
    st.session_state.setdefault("new_chat_next", False)
    st.session_state.setdefault("send_history", False)
    st.session_state.setdefault("force_upstream", False)


def repair_unicode(value):
    if value is None:
        return ""

    text = value if isinstance(value, str) else str(value)
    try:
        text.encode("utf-8")
        return text
    except UnicodeEncodeError:
        pass

    try:
        return text.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    except UnicodeError:
        return text.encode("utf-8", "replace").decode("utf-8", "replace")


def sanitize_value(value):
    if isinstance(value, str):
        return repair_unicode(value)
    if isinstance(value, list):
        return [sanitize_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(sanitize_value(item) for item in value)
    if isinstance(value, dict):
        return {
            repair_unicode(key): sanitize_value(item)
            for key, item in value.items()
        }
    return value


def escape_text(value):
    return html.escape(repair_unicode(value))


def strip_markdown(text):
    text = IMAGE_LINE_RE.sub("", repair_unicode(text))
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", text)
    text = re.sub(r"[*_~`]+", "", text)
    text = re.sub(r"^\s*[-*+]\s+", "• ", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*>\s?", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_image_urls(text, response_images=None):
    urls = IMAGE_LINE_RE.findall(repair_unicode(text))
    for image in response_images or []:
        url = image.get("url")
        if url and url not in urls:
            urls.append(url)
    return urls


def render_clean_text(text):
    text = repair_unicode(text)
    pos = 0
    rendered = False
    for match in CODE_BLOCK_RE.finditer(text):
        before = strip_markdown(text[pos:match.start()])
        if before:
            st.markdown(f"<div class='chat-clean'>{escape_text(before).replace(chr(10), '<br>')}</div>", unsafe_allow_html=True)
            rendered = True
        language = match.group(1).strip() or None
        st.code(match.group(2).strip("\n"), language=language)
        rendered = True
        pos = match.end()

    after = strip_markdown(text[pos:])
    if after:
        st.markdown(f"<div class='chat-clean'>{escape_text(after).replace(chr(10), '<br>')}</div>", unsafe_allow_html=True)
        rendered = True

    if not rendered:
        st.markdown("<div class='small-note'>No displayable text.</div>", unsafe_allow_html=True)


def render_message(message):
    with st.chat_message(message["role"]):
        if message["role"] == "assistant":
            render_clean_text(message.get("content", ""))
            for url in extract_image_urls(message.get("content", ""), message.get("images")):
                st.image(url)
        else:
            render_clean_text(message.get("display", message.get("content", "")))
            chips = message.get("attachments", [])
            if chips:
                chip_html = "".join(
                    f"<span class='attachment-chip'>{escape_text(item)}</span>"
                    for item in chips
                )
                st.markdown(chip_html, unsafe_allow_html=True)

        meta = message.get("meta")
        if meta:
            st.markdown(f"<div class='meta-row'>{escape_text(meta)}</div>", unsafe_allow_html=True)


def read_text_file(uploaded_file, raw):
    name = uploaded_file.name
    mime = uploaded_file.type or ""
    suffix = Path(name).suffix.lower()

    if mime == "application/pdf" or suffix == ".pdf":
        if PdfReader is None:
            return "PDF text extraction is unavailable. Install pypdf to extract PDF text."
        try:
            reader = PdfReader(BytesIO(raw))
            pages = []
            for index, page in enumerate(reader.pages[:20], start=1):
                text = page.extract_text() or ""
                if text.strip():
                    pages.append(f"[Page {index}]\n{text}")
            return repair_unicode("\n\n".join(pages).strip()[:MAX_TEXT_CHARS]) or "No extractable PDF text found."
        except Exception as exc:
            return f"Could not extract PDF text: {exc}"

    try:
        return repair_unicode(raw.decode("utf-8", errors="replace")[:MAX_TEXT_CHARS])
    except UnicodeDecodeError:
        return repair_unicode(raw.decode("latin-1", errors="replace")[:MAX_TEXT_CHARS])


def is_text_like(uploaded_file):
    mime = uploaded_file.type or ""
    suffix = Path(uploaded_file.name).suffix.lower()
    text_suffixes = {
        ".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml",
        ".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css", ".sql", ".log",
        ".pdf",
    }
    return mime.startswith("text/") or mime in {
        "application/json", "application/xml", "application/pdf",
        "application/javascript", "application/x-yaml",
    } or suffix in text_suffixes


def build_content_parts(prompt, uploaded_files):
    parts = []
    attachment_labels = []
    text_sections = [repair_unicode(prompt).strip()]
    has_image = False

    for uploaded_file in uploaded_files or []:
        raw = uploaded_file.getvalue()
        file_name = repair_unicode(uploaded_file.name)
        file_type = repair_unicode(uploaded_file.type or "")
        size_kb = len(raw) / 1024
        label = f"{file_name} · {size_kb:.1f} KB"
        attachment_labels.append(label)

        if file_type.startswith("image/"):
            has_image = True
            if len(raw) <= MAX_IMAGE_BYTES:
                encoded = base64.b64encode(raw).decode("ascii")
                parts.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{file_type};base64,{encoded}"
                    }
                })
                text_sections.append(f"[Attached image: {file_name}]")
            else:
                text_sections.append(f"[Attached image skipped because it is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB: {file_name}]")
            continue

        if is_text_like(uploaded_file):
            extracted = read_text_file(uploaded_file, raw)
            text_sections.append(
                f"Attached file: {file_name}\n"
                f"Content:\n{extracted}"
            )
        else:
            text_sections.append(
                f"Attached file: {file_name}\n"
                f"Type: {file_type or 'unknown'}\n"
                "Binary content was not converted to text by the UI."
            )

    combined_text = repair_unicode("\n\n".join(section for section in text_sections if section))
    parts.insert(0, {"type": "text", "text": combined_text})

    if len(parts) == 1:
        return combined_text, attachment_labels, has_image
    return parts, attachment_labels, has_image


def request_headers(api_key):
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


def health(api_base):
    try:
        response = requests.get(f"{api_base.rstrip('/')}/health", timeout=4)
        return response.json()
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def save_upstream_config(api_base, admin_token, upstream_key, upstream_base_url, default_model):
    payload = {}
    if upstream_key:
        payload["upstreamApiKey"] = repair_unicode(upstream_key)
    if upstream_base_url:
        payload["upstreamBaseUrl"] = repair_unicode(upstream_base_url).rstrip("/")
    if default_model:
        payload["defaultModel"] = repair_unicode(default_model)
        payload["browserSession"] = {"defaultModel": repair_unicode(default_model)}

    response = requests.put(
        f"{api_base.rstrip('/')}/admin/config",
        headers=request_headers(admin_token),
        json=sanitize_value(payload),
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def build_api_messages(current_content):
    messages = []
    if st.session_state.send_history:
        for item in st.session_state.messages:
            if item["role"] in {"user", "assistant"}:
                messages.append({
                    "role": item["role"],
                    "content": sanitize_value(item.get("api_content") or item.get("content", ""))
                })
    messages.append({"role": "user", "content": sanitize_value(current_content)})
    return messages


def parse_sse_lines(response):
    for raw_line in response.iter_lines(decode_unicode=True):
        if not raw_line or not raw_line.startswith("data: "):
            continue
        payload = raw_line[6:]
        if payload == "[DONE]":
            break
        try:
            yield sanitize_value(json.loads(payload))
        except json.JSONDecodeError:
            continue


def call_chat_api(api_base, api_key, body, stream):
    url = f"{api_base.rstrip('/')}/v1/chat/completions"
    safe_body = sanitize_value(body)
    if stream:
        with requests.post(url, headers=request_headers(api_key), json=safe_body, stream=True, timeout=360) as response:
            response.raise_for_status()
            yield from parse_sse_lines(response)
        return

    response = requests.post(url, headers=request_headers(api_key), json=safe_body, timeout=360)
    response.raise_for_status()
    yield response.json()


def sidebar():
    with st.sidebar:
        st.subheader("Connection")
        st.session_state.api_base = st.text_input("API base", value=st.session_state.api_base)
        st.session_state.api_key = st.text_input("Local API key", value=st.session_state.api_key, type="password")
        st.session_state.model = st.text_input("Model", value=st.session_state.model)

        status = health(st.session_state.api_base)
        if status.get("ok"):
            st.success(f"Server online · mode: {status.get('mode', 'unknown')}")
        else:
            st.error(f"Server unavailable: {status.get('error', 'unknown error')}")

        st.divider()
        st.subheader("Chat")
        st.session_state.stream = st.toggle("Stream responses", value=st.session_state.stream)
        st.session_state.new_chat_next = st.toggle("New ChatGPT chat on next send", value=st.session_state.new_chat_next)
        st.session_state.send_history = st.toggle("Send UI chat history", value=st.session_state.send_history)
        st.session_state.force_upstream = st.toggle("Direct upstream mode", value=st.session_state.force_upstream)

        st.markdown(
            "<div class='small-note'>Direct upstream mode uses your configured provider API key and is the lowest-latency safe path.</div>",
            unsafe_allow_html=True,
        )

        st.divider()
        st.subheader("Upstream API")
        admin_token = st.text_input("Admin token", type="password")
        upstream_key = st.text_input("Provider API key", type="password")
        upstream_base = st.text_input("Upstream base URL", value="https://api.openai.com/v1")
        if st.button("Save upstream config", use_container_width=True):
            if not admin_token:
                st.warning("Admin token is required to save upstream config.")
            else:
                try:
                    save_upstream_config(
                        st.session_state.api_base,
                        admin_token,
                        upstream_key,
                        upstream_base,
                        st.session_state.model,
                    )
                    st.success("Upstream config saved.")
                except Exception as exc:
                    st.error(f"Could not save config: {exc}")

        if st.button("Clear chat", use_container_width=True):
            st.session_state.messages = []
            st.rerun()


def main():
    init_state()
    sidebar()

    left, right = st.columns([0.72, 0.28], vertical_alignment="top")
    with left:
        st.title("ChatGPT Anywhere")
    with right:
        st.caption("Local OpenAI-compatible chat UI")

    for message in st.session_state.messages:
        render_message(message)

    uploaded_files = st.file_uploader(
        "Attach images or files",
        accept_multiple_files=True,
        label_visibility="collapsed",
    )

    prompt = st.chat_input("Message ChatGPT Anywhere")
    if not prompt:
        return
    prompt = repair_unicode(prompt)

    if not st.session_state.api_key:
        st.error("Enter a local API key in the sidebar first.")
        return

    content, labels, has_image = build_content_parts(prompt, uploaded_files)
    if has_image and not st.session_state.force_upstream:
        st.info("Image pixels are sent in OpenAI-compatible format. For actual vision analysis, enable Direct upstream mode with a vision-capable model.")

    user_record = {
        "role": "user",
        "content": prompt,
        "display": prompt,
        "api_content": content,
        "attachments": labels,
    }
    st.session_state.messages.append(user_record)
    render_message(user_record)

    body = {
        "model": st.session_state.model or DEFAULT_MODEL,
        "messages": build_api_messages(content),
        "stream": st.session_state.stream,
        "new_chat": st.session_state.new_chat_next,
        "force_upstream": st.session_state.force_upstream,
        "cga": {
            "live_ui_stream": True,
            "materialize_images": True,
        },
    }

    started = time.perf_counter()
    assistant_text = ""
    images = []
    meta = ""

    with st.chat_message("assistant"):
        placeholder = st.empty()
        try:
            final_payload = None
            for payload in call_chat_api(
                st.session_state.api_base,
                st.session_state.api_key,
                body,
                st.session_state.stream,
            ):
                final_payload = payload
                if payload.get("error"):
                    raise RuntimeError(payload["error"].get("message", "Bridge error"))

                if st.session_state.stream:
                    delta = repair_unicode(payload.get("choices", [{}])[0].get("delta", {}).get("content", ""))
                    if delta:
                        assistant_text += delta
                        with placeholder.container():
                            render_clean_text(assistant_text)
                    if payload.get("images"):
                        images = payload["images"]
                    if payload.get("usage") or payload.get("time_taken_ms"):
                        meta = format_meta(payload)
                else:
                    assistant_text = repair_unicode(payload.get("choices", [{}])[0].get("message", {}).get("content", ""))
                    images = payload.get("images", [])
                    meta = format_meta(payload)

            if final_payload is None:
                raise RuntimeError("No response returned.")

            if not st.session_state.stream:
                with placeholder.container():
                    render_clean_text(assistant_text)

            for url in extract_image_urls(assistant_text, images):
                st.image(url)

            if not meta:
                meta = f"{(time.perf_counter() - started) * 1000:.0f} ms"
            st.markdown(f"<div class='meta-row'>{escape_text(meta)}</div>", unsafe_allow_html=True)
        except Exception as exc:
            assistant_text = repair_unicode(f"Error: {exc}")
            st.error(assistant_text)

    st.session_state.messages.append({
        "role": "assistant",
        "content": assistant_text,
        "api_content": strip_markdown(assistant_text),
        "images": images,
        "meta": meta,
    })
    st.session_state.new_chat_next = False


def format_meta(payload):
    parts = []
    if payload.get("time_taken_ms") is not None:
        parts.append(f"{payload['time_taken_ms']} ms")
    usage = payload.get("usage") or {}
    if usage:
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        total_tokens = usage.get("total_tokens", 0)
        parts.append(f"tokens: {prompt_tokens} in / {completion_tokens} out / {total_tokens} total")
    if payload.get("usage_source"):
        parts.append(payload["usage_source"])
    elif payload.get("cga", {}).get("usage_source"):
        parts.append(payload["cga"]["usage_source"])
    return " · ".join(parts)


if __name__ == "__main__":
    main()
