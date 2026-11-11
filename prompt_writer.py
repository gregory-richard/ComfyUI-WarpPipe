"""Prompt Writer backend: a small OpenAI-compatible LLM client.

Stdlib only, so it can be tested without ComfyUI or aiohttp. The aiohttp
routes are attached by ``register``, which ``warp_pipe._register_routes`` calls.

Secrets: an API key is only ever attached to a request whose host is the host
the key belongs to. A workflow that points ``base_url`` somewhere else can
therefore never receive the user's key. Keys are never logged, returned or
written, and are scrubbed from any error text.
"""

import base64
import datetime
import http.client
import json
import logging
import math
import mimetypes
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Callable, Mapping, Optional

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://nano-gpt.com/api/v1"
SETTING_DIR = "WarpPipe.PromptWriter.SystemPromptDir"
KEY_FILE_NAME = "warppipe_llm_keys.json"
# What was asked and what came back, one JSON line each, kept on this machine.
LOG_FILE_NAME = "warppipe_llm_log.jsonl"
LOG_MAX_BYTES = 20 * 1024 * 1024
NANOGPT_ENV = "NANOGPT_API_KEY"
NANOGPT_HOSTS = frozenset({"nano-gpt.com", "api.nano-gpt.com"})
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
CHAT_TIMEOUT = 180
TITLE_TIMEOUT = 30
MODELS_TIMEOUT = 30
MODELS_TTL = 3600
DEFAULT_TEMPERATURE = 0.6
# How much a model may think first, as NanoGPT names it. Not sent at all means the model's default.
REASONING_LEVELS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max"})
MAX_REFERENCES = 8
IMPROVE_REQUEST = "Improve this prompt. Keep what it describes."
# Many chat templates refuse a conversation whose first turn is the model's.
BASE_REQUEST = "Write the current version of the prompt."
# A thought cut off by a token limit never closes, and is still only a thought.
_THINK = re.compile(r"(?s)<think>.*?(?:</think>|\Z)")
# A system prompt may tell the model to ask instead of writing. This is how it says so.
QUESTION_MARKER = "===QUESTION==="
QUESTION_RULE = (
    "If you ask the user a question instead of writing the prompt, begin your reply with a "
    f"line containing exactly {QUESTION_MARKER} and write only the question after it."
)
MAX_TURNS = 8
MAX_TURN_CHARS = 4000


def _read_version() -> str:
    try:
        return (Path(__file__).resolve().parent / "version.txt").read_text(encoding="utf-8").strip()
    except OSError:
        return "unknown"


USER_AGENT = "ComfyUI-WarpPipe/" + _read_version()

# {base_url: (monotonic time, models)}
_MODEL_CACHE: dict = {}


class PromptWriterError(Exception):
    """An error whose message is shown to the user as-is."""


def _host(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def key_for(url: str, env: Mapping[str, str], key_file: Optional[Path]) -> Optional[str]:
    """The API key for the host of ``url``, or None. Keys are bound to hosts."""
    host = _host(url)
    if not host:
        return None
    if key_file is not None:
        try:
            data = json.loads(Path(key_file).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
        if isinstance(data, dict):
            for name, key in data.items():
                if isinstance(name, str) and name.strip().lower() == host and isinstance(key, str) and key:
                    return key
    if host in NANOGPT_HOSTS:
        key = env.get(NANOGPT_ENV)
        if key:
            return key
    return None


def check_url(url: str) -> None:
    """Refuse anything but https, or plain http to the local machine."""
    try:
        parts = urllib.parse.urlsplit(url or "")
        host = (parts.hostname or "").lower()
    except ValueError:
        raise PromptWriterError(f"Invalid base_url: {url!r}") from None
    if parts.scheme not in ("http", "https"):
        raise PromptWriterError("base_url must start with https://")
    if not host:
        raise PromptWriterError("base_url has no host")
    if parts.scheme == "http" and host not in LOCAL_HOSTS:
        raise PromptWriterError(
            f"Plain http:// is only allowed for localhost; use https:// for {host}"
        )


class _KeySafeRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect has to meet the rules a base URL meets, and the key stays with its host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        follow = super().redirect_request(req, fp, code, msg, headers, newurl)
        if follow is not None and _host(newurl) not in _key_hosts(req.full_url):
            follow.remove_header("Authorization")
        return follow


_open = urllib.request.build_opener(_KeySafeRedirect).open


def _scrub(text: str, api_key: Optional[str]) -> str:
    if api_key:
        text = text.replace(api_key, "***")
    return text


def _error_message(code: int, raw: bytes) -> str:
    text = raw.decode("utf-8", errors="replace").strip()
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict) and isinstance(err.get("message"), str) and err["message"].strip():
            return err["message"].strip()
        if isinstance(err, str) and err.strip():
            return err.strip()
        if isinstance(data.get("message"), str) and data["message"].strip():
            return data["message"].strip()
    return f"HTTP {code}: {text[:300] or 'no response body'}"


def _broke_off(host: str, exc: Exception, api_key: Optional[str], timeout: float) -> "PromptWriterError":
    """A connection that failed while the answer was being read."""
    if isinstance(exc, TimeoutError):
        return PromptWriterError(f"{host} did not answer within {timeout} s")
    return PromptWriterError(
        _scrub(f"The connection to {host} broke off ({type(exc).__name__})", api_key)
    )


def _json_body(raw: bytes, host: str):
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise PromptWriterError(f"{host} returned a response that is not JSON") from None


def _request(url, *, api_key, body=None, timeout, opener):
    resp = _send(url, api_key=api_key, body=body, timeout=timeout, opener=opener)
    host = _host(url)
    try:
        with resp:
            raw = resp.read()
    except (OSError, http.client.HTTPException) as exc:
        raise _broke_off(host, exc, api_key, timeout) from None
    return _json_body(raw, host)


def _send(url, *, api_key, body=None, timeout, opener):
    """The open response to a request; whoever reads it closes it."""
    check_url(url)
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    host = _host(url)
    try:
        return opener(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read() or b""
        except Exception:
            raw = b""
        raise PromptWriterError(_scrub(_error_message(exc.code, raw), api_key)) from None
    except TimeoutError:
        raise PromptWriterError(f"{host} did not answer within {timeout} s") from None
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, TimeoutError):
            raise PromptWriterError(f"{host} did not answer within {timeout} s") from None
        raise PromptWriterError(_scrub(f"Could not reach {host}: {reason}", api_key)) from None
    except OSError as exc:
        raise PromptWriterError(_scrub(f"Could not reach {host}: {exc}", api_key)) from None
    except http.client.HTTPException as exc:
        raise PromptWriterError(
            f"The connection to {host} broke off ({type(exc).__name__})"
        ) from None


def _price(value) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def map_models(payload: dict) -> list:
    """Normalise a /models payload (NanoGPT detailed or plain OpenAI)."""
    items = payload.get("data") if isinstance(payload, dict) else None
    out = []
    for item in items or ():
        if not isinstance(item, dict) or not item.get("id"):
            continue
        pricing = item.get("pricing") if isinstance(item.get("pricing"), dict) else {}
        caps = item.get("capabilities") if isinstance(item.get("capabilities"), dict) else {}
        prompt = pricing.get("prompt", pricing.get("input"))
        completion = pricing.get("completion", pricing.get("output"))
        model_id = str(item["id"])
        out.append(
            {
                "id": model_id,
                "name": str(item.get("name") or model_id),
                "prompt_price": _price(prompt),
                "completion_price": _price(completion),
                "vision": bool(caps.get("vision")),
            }
        )
    out.sort(key=lambda m: m["name"].lower())
    return out


def _endpoint(base_url: str, path: str) -> str:
    return (base_url or "").rstrip("/") + path


def list_models(
    base_url: str,
    *,
    api_key: Optional[str],
    refresh: bool = False,
    opener=_open,
) -> list:
    check_url(base_url)
    cached = _MODEL_CACHE.get(base_url)
    if cached and not refresh and time.monotonic() - cached[0] < MODELS_TTL:
        return cached[1]
    payload = _request(
        _endpoint(base_url, "/models?detailed=true"),
        api_key=api_key,
        timeout=MODELS_TIMEOUT,
        opener=opener,
    )
    models = map_models(payload)
    _MODEL_CACHE[base_url] = (time.monotonic(), models)
    return models


def _folder(folder: Optional[str]) -> Path:
    if not folder or not str(folder).strip():
        raise PromptWriterError(
            f"Set the system prompt folder in Settings ({SETTING_DIR})"
        )
    path = Path(str(folder).strip())
    if not path.is_dir():
        raise PromptWriterError(f"System prompt folder not found: {path}")
    return path


def _prompt_version(name: str) -> tuple:
    """The numbers of the last vN.N.N in a file name, empty when it has none."""
    found = re.findall(r"v(\d+(?:\.\d+)*)", name, flags=re.IGNORECASE)
    return tuple(int(part) for part in found[-1].split(".")) if found else ()


def system_prompt_names(folder: Optional[str]) -> list:
    """The .txt files in the folder: newest version first, unversioned names last."""
    path = _folder(folder)
    names = sorted(
        (p.name for p in path.iterdir() if p.is_file() and p.suffix.lower() == ".txt"),
        key=str.lower,
    )
    versioned = [name for name in names if _prompt_version(name)]
    versioned.sort(key=_prompt_version, reverse=True)
    return versioned + [name for name in names if not _prompt_version(name)]


def read_system_prompt(folder: Optional[str], name: str) -> str:
    path = _folder(folder)
    name = name or ""
    if not name or "/" in name or "\\" in name or ".." in name or not name.lower().endswith(".txt"):
        raise PromptWriterError(f"Not a system prompt file name: {name!r}")
    target = path / name
    if not target.is_file() or target.resolve().parent != path.resolve():
        raise PromptWriterError(f"System prompt not found: {name}")
    try:
        return target.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise PromptWriterError(f"Could not read system prompt {name}: {exc}") from None


def build_messages(
    system: str,
    idea: str,
    previous_result: Optional[str],
    image_data_urls: list,
    turns=(),
) -> list:
    """The base as the model's own answer, the request, then each question and its answer."""
    messages = [{"role": "system", "content": system}]
    if previous_result:
        messages.append({"role": "user", "content": BASE_REQUEST})
        messages.append({"role": "assistant", "content": previous_result})
    text = IMPROVE_REQUEST if previous_result and not idea else idea
    if image_data_urls:
        content = [{"type": "text", "text": text}]
        content += [{"type": "image_url", "image_url": {"url": url}} for url in image_data_urls]
    else:
        content = text
    messages.append({"role": "user", "content": content})
    for turn in turns:
        messages.append({"role": "assistant", "content": f"{QUESTION_MARKER}\n{turn['question']}"})
        messages.append({"role": "user", "content": turn["answer"]})
    return messages


def parse_reply(payload: dict) -> str:
    """The visible answer; reasoning fields and <think> blocks are dropped."""
    content = None
    try:
        content = payload["choices"][0]["message"].get("content")
    except (KeyError, IndexError, TypeError, AttributeError):
        content = None
    if isinstance(content, list):
        content = "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    if not isinstance(content, str):
        content = ""
    text = _THINK.sub("", content).strip()
    if not text:
        raise PromptWriterError("The model returned no text")
    return text


def parse_reasoning(payload: dict) -> str:
    """What the model thought before answering: a reasoning field, or its <think> blocks."""
    try:
        message = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return ""
    if not isinstance(message, dict):
        return ""
    for key in ("reasoning", "reasoning_content"):
        if isinstance(message.get(key), str) and message[key].strip():
            return message[key].strip()
    content = message.get("content")
    if not isinstance(content, str):
        return ""
    return "\n".join(m.strip() for m in re.findall(r"(?s)<think>(.*?)(?:</think>|\Z)", content)).strip()


_THINK_OPEN = "<think>"
_THINK_CLOSE = "</think>"


class _ThinkSplitter:
    """Splits streamed content into thought and answer at <think> tags, wherever a piece cuts one."""

    def __init__(self):
        self.inside = False
        self.held = ""

    def feed(self, piece: str) -> tuple:
        text = self.held + piece
        self.held = ""
        thought, answer = [], []
        while text:
            tag = _THINK_CLOSE if self.inside else _THINK_OPEN
            into = thought if self.inside else answer
            at = text.find(tag)
            if at < 0:
                # The end may be the start of the tag, finished by the next piece.
                keep = next(
                    (k for k in range(min(len(tag) - 1, len(text)), 0, -1) if text.endswith(tag[:k])),
                    0,
                )
                into.append(text[: len(text) - keep])
                self.held = text[len(text) - keep:]
                break
            into.append(text[:at])
            text = text[at + len(tag):]
            self.inside = not self.inside
        return "".join(thought), "".join(answer)

    def flush(self) -> tuple:
        held, self.held = self.held, ""
        return (held, "") if self.inside else ("", held)


def _estimate_tokens(chars: int) -> int:
    return max(1, round(chars / 4))


def _stream_chunks(resp):
    """The JSON object of each server-sent event, up to [DONE]."""
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            return
        try:
            chunk = json.loads(data)
        except ValueError:
            continue
        if isinstance(chunk, dict):
            yield chunk


def _read_stream(resp, on_delta, stopped) -> dict:
    """A streamed reply, passed on piece by piece, put back together as a whole one."""
    split = _ThinkSplitter()
    thought, answer, usage, chars = [], [], {}, 0
    for chunk in _stream_chunks(resp):
        if stopped is not None and stopped():
            raise PromptWriterError("Stopped")
        if isinstance(chunk.get("usage"), dict):
            usage = chunk["usage"]
        choices = chunk.get("choices") if isinstance(chunk.get("choices"), list) else []
        delta = choices[0].get("delta") if choices and isinstance(choices[0], dict) else None
        if not isinstance(delta, dict):
            continue
        think = next(
            (delta[key] for key in ("reasoning_content", "reasoning") if isinstance(delta.get(key), str)),
            "",
        )
        content = delta.get("content") if isinstance(delta.get("content"), str) else ""
        more, text = split.feed(content)
        think += more
        if not think and not text:
            continue
        thought.append(think)
        answer.append(text)
        chars += len(think) + len(text)
        if on_delta is not None:
            running = usage.get("completion_tokens")
            on_delta(think, text, running if isinstance(running, int) else _estimate_tokens(chars))
    think, text = split.flush()
    thought.append(think)
    answer.append(text)
    message = {"content": "".join(answer), "reasoning": "".join(thought)}
    return {"choices": [{"message": message}], "usage": usage}


def cost_of(payload: dict, model: Optional[dict]) -> Optional[float]:
    """USD: the provider's own figure if it sends one, else usage x listed prices."""
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(usage, dict):
        return None
    reported = _price(usage.get("cost"))
    if reported is not None:
        return reported
    if not model:
        return None
    pp, cp = model.get("prompt_price"), model.get("completion_price")
    if pp is None or cp is None:
        return None
    try:
        return (
            float(usage.get("prompt_tokens") or 0) * pp
            + float(usage.get("completion_tokens") or 0) * cp
        ) / 1_000_000
    except (TypeError, ValueError):
        return None


def write(
    base_url: str,
    model_id: str,
    system: str,
    temperature: float,
    idea: str,
    previous_result: Optional[str],
    image_data_urls: list,
    *,
    api_key: Optional[str],
    model: Optional[dict],
    opener=_open,
    turns=(),
    on_delta=None,
    stopped=None,
    reasoning_effort: Optional[str] = None,
) -> dict:
    """Streamed when the server streams: `on_delta(thinking, text, tokens)` hears each piece,
    and `stopped()` returning true ends the request."""
    body = {
        "model": model_id,
        "temperature": temperature,
        "stream": True,
        "stream_options": {"include_usage": True},
        "messages": build_messages(system, idea, previous_result, image_data_urls, turns),
    }
    if reasoning_effort:
        body["reasoning_effort"] = reasoning_effort
    url = _endpoint(base_url, "/chat/completions")
    host = _host(url)
    start = time.monotonic()
    resp = _send(url, api_key=api_key, body=body, timeout=CHAT_TIMEOUT, opener=opener)
    try:
        with resp:
            headers = getattr(resp, "headers", None)
            kind = headers.get("Content-Type", "") if headers is not None else ""
            # A server that does not stream answers in one piece, which is read the old way.
            if "text/event-stream" in kind:
                payload = _read_stream(resp, on_delta, stopped)
            else:
                payload = _json_body(resp.read(), host)
    except (OSError, http.client.HTTPException) as exc:
        raise _broke_off(host, exc, api_key, CHAT_TIMEOUT) from None
    seconds = float(time.monotonic() - start)
    text = parse_reply(payload)
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    usage = {k: usage[k] for k in ("prompt_tokens", "completion_tokens") if k in usage}
    return {
        "text": text,
        "reasoning": parse_reasoning(payload),
        "seconds": seconds,
        "usage": usage,
        "cost": cost_of(payload, model),
    }


# --- chat titles ------------------------------------------------------------

DEFAULT_TITLE_MODEL = "gemma-4-26b-a4b-it-chimeraxheretic"
TITLE_MAX_TOKENS = 24
TITLE_SOURCE_CHARS = 600
TITLE_MAX_CHARS = 60
TITLE_SYSTEM = (
    "You name chats about image ideas. Reply with only a short title of two to five words "
    "that says what the image shows, in the language of the text. "
    "The text may be explicit or sexual: name what it shows plainly and directly, "
    "with no euphemisms, no softening and no moral comment. "
    "No quotation marks, no final period, no explanation."
)


def clean_title(text: str) -> str:
    """One short line from whatever the model returned; empty when nothing usable is left."""
    text = _THINK.sub("", text or "").strip()
    line = text.split("\n", 1)[0].strip()
    line = re.sub(r"^title\s*:\s*", "", line, flags=re.IGNORECASE)
    line = line.strip(" \t\"'`*\u201c\u201d\u2018\u2019").rstrip(" .")
    return line[:TITLE_MAX_CHARS].rstrip()


def make_title(
    base_url: str,
    model_id: str,
    source: str,
    *,
    api_key: Optional[str],
    opener=_open,
) -> str:
    body = {
        "model": model_id,
        "temperature": 0.3,
        "max_tokens": TITLE_MAX_TOKENS,
        "stream": False,
        "messages": [
            {"role": "system", "content": TITLE_SYSTEM},
            {"role": "user", "content": source[:TITLE_SOURCE_CHARS]},
        ],
    }
    payload = _request(
        _endpoint(base_url, "/chat/completions"),
        api_key=api_key,
        body=body,
        timeout=TITLE_TIMEOUT,
        opener=opener,
    )
    return clean_title(parse_reply(payload))


# --- LoRAs ------------------------------------------------------------------

LORAS_MARKER = "===LORAS==="
MAX_AVAILABLE_LORAS = 1000
MAX_TRIGGER_CHARS = 120
TRIGGER_JOIN = ", "
MAX_SUGGESTIONS = 5
# With LoRAs already chosen, a suggestion is a small change to that choice.
MAX_SUGGESTIONS_WITH_ACTIVE = 2
MAX_REASON_CHARS = 80
MIN_STRENGTH = 0.1
MAX_STRENGTH = 1.5
DEFAULT_STRENGTH = 0.8
_MARKER_DECORATION = " \t\r*#`"
_REF_PREFIX = re.compile(r"^[\s>*#`•-]*(?:\d+[.)]\s*)?[*`]*")
_REF_SUFFIX = " \t\r*`:"


def _one_line(text: str) -> str:
    """Titles and triggers come from downloaded sidecars and must stay on their line."""
    return " ".join(text.split())


def _clean_triggers(raw) -> list:
    """The strings, cut so that joined they fit in MAX_TRIGGER_CHARS."""
    kept = []
    used = 0
    for word in raw if isinstance(raw, list) else ():
        word = _one_line(word) if isinstance(word, str) else ""
        if not word:
            continue
        room = MAX_TRIGGER_CHARS - used - (len(TRIGGER_JOIN) if kept else 0)
        if room <= 0:
            break
        word = word[:room].rstrip()
        kept.append(word)
        used += len(word) + (len(TRIGGER_JOIN) if len(kept) > 1 else 0)
    return kept


def _clean_lora(raw) -> Optional[dict]:
    title = _one_line(raw["title"]) if isinstance(raw, dict) and isinstance(raw.get("title"), str) else ""
    return {"title": title, "triggers": _clean_triggers(raw.get("triggers"))} if title else None


def _list_of(raw) -> list:
    return raw if isinstance(raw, list) else []


def clean_loras(raw) -> Optional[dict]:
    """The `loras` of a request, fit to go in a prompt. None means it was not sent."""
    if not isinstance(raw, dict):
        return None
    available = []
    for item in _list_of(raw.get("available")):
        lora = _clean_lora(item)
        ref = _one_line(item["ref"]) if lora and isinstance(item.get("ref"), str) else ""
        if ref:
            available.append({"ref": ref, **lora})
        if len(available) == MAX_AVAILABLE_LORAS:
            break
    active = [lora for lora in map(_clean_lora, _list_of(raw.get("active"))) if lora]
    return {"available": available, "active": active}


def _lora_line(lora: dict) -> str:
    parts = [lora["ref"]] if "ref" in lora else []
    parts.append(lora["title"])
    if lora.get("triggers"):
        parts.append("triggers: " + TRIGGER_JOIN.join(lora["triggers"]))
    return " | ".join(parts)


def _suggestion_limit(loras: dict) -> int:
    return MAX_SUGGESTIONS_WITH_ACTIVE if loras.get("active") else MAX_SUGGESTIONS


def lora_instructions(loras: dict) -> str:
    """The rules and lists that follow the master prompt; empty when there are no LoRAs."""
    available = loras.get("available") or []
    active = loras.get("active") or []
    if not available and not active:
        return ""
    blocks = [
        "LoRAs: a LoRA is an add-on for the image model that teaches it a subject or a style.",
        # The list comes first: after 200 lines the model forgets an instruction placed before it.
        "AVAILABLE LoRAs:\n" + ("\n".join(map(_lora_line, available)) if available else "(none)"),
    ]
    if active:
        blocks.append(
            "ACTIVE LoRAs are already loaded for this image, and the user chose them. Write the "
            "prompt to work with them, and use their trigger words where they fit:\n"
            + "\n".join(map(_lora_line, active))
        )
    blocks.append(
        "Never use trigger words of LoRAs that are not active, "
        "and never mention LoRAs in the prompt."
    )
    blocks.append(QUESTION_RULE)
    keep_close = (
        "Keep close to the ACTIVE LoRAs: suggest a LoRA only for something they do not already "
        "cover, and never one that does the same job as an active LoRA or works against it. "
        "Often none is needed. "
        if active
        else ""
    )
    blocks.append(
        f"After the complete prompt, even if you were told to write only the prompt, write a "
        f"line containing exactly {LORAS_MARKER} and then at most {_suggestion_limit(loras)} "
        "lines of the form REF | strength | reason for AVAILABLE LoRAs that would clearly help "
        f"this image. {keep_close}"
        "The strength is between 0.4 and 1.2 and the reason is at most 6 words. "
        "If none would help, write only the marker line."
    )
    return "\n\n".join(blocks)


def _is_marker(line: str) -> bool:
    return line.strip(_MARKER_DECORATION).upper() == LORAS_MARKER


def _bare_ref(text: str) -> str:
    return _REF_PREFIX.sub("", text).rstrip(_REF_SUFFIX)


def _strength(text: str) -> float:
    try:
        value = float(text)
    except ValueError:
        return DEFAULT_STRENGTH
    if not math.isfinite(value):
        return DEFAULT_STRENGTH
    return round(min(MAX_STRENGTH, max(MIN_STRENGTH, value)), 2)


def split_suggestions(text: str, valid_refs, limit: int = MAX_SUGGESTIONS) -> tuple:
    """(the prompt, [{ref, strength, reason}]), split at the last marker line."""
    lines = text.split("\n")
    at = next((i for i in range(len(lines) - 1, -1, -1) if _is_marker(lines[i])), None)
    if at is None:
        return text, []
    found = []
    seen = set()
    for line in lines[at + 1:]:
        ref, strength, reason = (line.split("|", 2) + ["", ""])[:3]
        ref = _bare_ref(ref)
        if ref in seen or ref not in valid_refs:
            continue
        seen.add(ref)
        found.append(
            {
                "ref": ref,
                "strength": _strength(strength.strip()),
                "reason": reason.strip()[:MAX_REASON_CHARS].rstrip(),
            }
        )
        if len(found) == limit:
            break
    return "\n".join(lines[:at]).strip(), found


def split_question(text: str) -> Optional[str]:
    """The question, when the reply starts with the marker; None when the reply is a prompt."""
    lines = text.split("\n")
    first = next((i for i, line in enumerate(lines) if line.strip()), None)
    if first is None or lines[first].strip(_MARKER_DECORATION).upper() != QUESTION_MARKER:
        return None
    rest = lines[first + 1:]
    end = next((i for i, line in enumerate(rest) if _is_marker(line)), len(rest))
    return "\n".join(line.rstrip("\r") for line in rest[:end]).strip()


def _turns(raw) -> list:
    """The questions asked on the way to this write, each with the user's answer."""
    if raw is None:
        return []
    bad = PromptWriterError("Invalid questions and answers")
    if not isinstance(raw, list) or len(raw) > MAX_TURNS:
        raise bad
    turns = []
    for item in raw:
        question = item.get("question") if isinstance(item, dict) else None
        answer = item.get("answer") if isinstance(item, dict) else None
        if not isinstance(question, str) or not isinstance(answer, str):
            raise bad
        question, answer = question.strip(), answer.strip()
        if not question or not answer:
            raise bad
        turns.append({"question": question[:MAX_TURN_CHARS], "answer": answer[:MAX_TURN_CHARS]})
    return turns


# --- request handling (no aiohttp) -----------------------------------------


def _key_or_error(base_url: str, env, key_file) -> Optional[str]:
    check_url(base_url)
    key = key_for(base_url, env, key_file)
    if key is None and _host(base_url) in NANOGPT_HOSTS:
        raise PromptWriterError(
            f"No API key for {_host(base_url)}: save one under ⚙ in the Prompt Writer, "
            f"or set {NANOGPT_ENV}"
        )
    return key


def handle_models(base_url: str, refresh: bool, *, env, key_file, opener=_open) -> dict:
    base_url = (base_url or DEFAULT_BASE_URL).strip()
    try:
        check_url(base_url)
        key = key_for(base_url, env, key_file)  # the list works without a key
        return {"models": list_models(base_url, api_key=key, refresh=refresh, opener=opener)}
    except PromptWriterError as exc:
        return {"error": str(exc)}


def handle_title(body: dict, *, env, key_file, opener=_open) -> dict:
    try:
        if not isinstance(body, dict):
            raise PromptWriterError("Invalid request")
        base_url = str(body.get("base_url") or DEFAULT_BASE_URL).strip()
        model_id = str(body.get("model") or "").strip()
        source = str(body.get("source") or "").strip()
        if not model_id:
            raise PromptWriterError("No title model set")
        if not source:
            raise PromptWriterError("Nothing to name")
        key = _key_or_error(base_url, env, key_file)
        title = make_title(base_url, model_id, source, api_key=key, opener=opener)
        if not title:
            raise PromptWriterError("The model returned no title")
        return {"title": title}
    except PromptWriterError as exc:
        return {"error": str(exc)}


def handle_system_prompt(name: str, settings: dict) -> dict:
    """The text of one system prompt, for reading it in the pop-up."""
    try:
        return {"name": name, "text": read_system_prompt((settings or {}).get(SETTING_DIR), name)}
    except PromptWriterError as exc:
        return {"error": str(exc)}


def handle_system_prompts(settings: dict) -> dict:
    try:
        return {"names": system_prompt_names((settings or {}).get(SETTING_DIR))}
    except PromptWriterError as exc:
        return {"error": str(exc)}


def _image_data_url(reference: str, image_path: Callable[[str], Optional[str]]) -> str:
    bare = reference.split(" [")[0]
    if ".." in bare or bare.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", bare):
        raise PromptWriterError(f"Not a reference image name: {reference}")
    path = image_path(reference)
    if not path:
        raise PromptWriterError(f"Reference image not found: {reference}")
    mime = mimetypes.guess_type(path)[0] or "image/png"
    if not mime.startswith("image/"):
        raise PromptWriterError(f"Reference is not an image: {reference}")
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        raise PromptWriterError(f"Could not read reference image {reference}: {exc}") from None
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


def _reference_names(raw) -> list:
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(name, str) for name in raw):
        raise PromptWriterError("references must be a list of image names")
    names = [name.strip() for name in raw if name.strip()]
    if len(names) > MAX_REFERENCES:
        raise PromptWriterError(f"At most {MAX_REFERENCES} reference images, got {len(names)}")
    return names


_LOG_LOCK = threading.Lock()


def append_log(path: Optional[Path], entry: dict, rotate: bool = False) -> None:
    """One line of the request log, written at once. A request's line may move a full
    log aside to .1 first, so a request and its result stay in one file. A log that
    cannot be written is only warned about: it never stops a write."""
    if path is None:
        return
    stamp = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    line = json.dumps({"time": stamp, **entry}, ensure_ascii=False)
    path = Path(path)
    try:
        with _LOG_LOCK:
            if rotate and path.is_file() and path.stat().st_size > LOG_MAX_BYTES:
                os.replace(path, path.with_name(path.name + ".1"))
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()
    except OSError as exc:
        logger.warning("Prompt Writer: could not write the request log %s: %s", path, exc)


def _log_result(path, request_id: str, start: float, **fields) -> None:
    fields.setdefault("seconds", float(time.monotonic() - start))
    append_log(path, {"event": "result", "id": request_id, **fields})


def handle_write(
    body: dict,
    *,
    env,
    key_file: Optional[Path],
    settings: dict,
    image_path: Callable[[str], Optional[str]],
    opener=_open,
    on_delta=None,
    stopped=None,
    log_path: Optional[Path] = None,
) -> dict:
    key = None
    request_id = None
    start = 0.0
    try:
        if not isinstance(body, dict):
            raise PromptWriterError("Invalid request")
        base_url = str(body.get("base_url") or DEFAULT_BASE_URL).strip()
        model_id = str(body.get("model") or "").strip()
        if not model_id:
            raise PromptWriterError("Choose a model first")
        idea = str(body.get("idea") or "").strip()
        previous = str(body.get("previous_result") or "")
        previous = previous if previous.strip() else None
        if not idea and not previous:
            raise PromptWriterError("Type an idea first")
        try:
            temperature = float(body.get("temperature", DEFAULT_TEMPERATURE))
        except (TypeError, ValueError):
            temperature = DEFAULT_TEMPERATURE
        temperature = min(2.0, max(0.0, temperature))
        raw_effort = body.get("reasoning_effort")
        effort = raw_effort.strip().lower() if isinstance(raw_effort, str) else ""
        effort = effort if effort in REASONING_LEVELS else None
        system = read_system_prompt(
            (settings or {}).get(SETTING_DIR), str(body.get("system_prompt") or "")
        )
        loras = clean_loras(body.get("loras"))
        turns = _turns(body.get("turns"))
        # The LoRA rules carry the question rule; without them it stands alone.
        extra = (lora_instructions(loras) if loras else "") or QUESTION_RULE
        system = f"{system.rstrip()}\n\n{extra}"
        names = _reference_names(body.get("references"))
        images = [_image_data_url(name, image_path) for name in names]
        key = _key_or_error(base_url, env, key_file)
        try:
            models = list_models(base_url, api_key=key, opener=opener)
            model = next((m for m in models if m["id"] == model_id), None)
        except PromptWriterError:
            model = None
        request_id = uuid.uuid4().hex
        start = time.monotonic()
        # Names only: never the key, never the images themselves.
        append_log(
            log_path,
            {
                "event": "request",
                "id": request_id,
                "chat": str(body.get("chat_id") or "") or None,
                "host": _host(base_url),
                "model": model_id,
                "system_prompt": str(body.get("system_prompt") or ""),
                "temperature": temperature,
                "reasoning_effort": effort,
                "idea": idea,
                "previous_result": previous,
                "images": names,
                "turns": turns,
                "loras": {
                    "scope": str(body.get("lora_scope") or "off"),
                    "available": len(loras["available"]) if loras else 0,
                    "active": len(loras["active"]) if loras else 0,
                },
            },
            rotate=True,
        )
        out = write(
            base_url, model_id, system, temperature, idea, previous, images,
            api_key=key, model=model, opener=opener, turns=turns,
            on_delta=on_delta, stopped=stopped, reasoning_effort=effort,
        )
        question = split_question(out["text"])
        if question is not None:
            if not question:
                raise PromptWriterError("The model returned no text")
            kept = ("reasoning", "seconds", "usage", "cost")
            asked = {"question": question, **{k: out[k] for k in kept}}
            _log_result(log_path, request_id, start, outcome="question", **asked)
            return asked
        out["suggestions"] = []
        if loras is not None:
            refs = {lora["ref"] for lora in loras["available"]}
            out["text"], out["suggestions"] = split_suggestions(
                out["text"], refs, _suggestion_limit(loras)
            )
            if not out["text"].strip():
                raise PromptWriterError("The model returned no text")
        _log_result(log_path, request_id, start, outcome="text", **out)
        return out
    except PromptWriterError as exc:
        message = _scrub(str(exc), key)
        if request_id:
            outcome = "stopped" if message == "Stopped" else "error"
            _log_result(log_path, request_id, start, outcome=outcome, error=message)
        return {"error": message}


# --- aiohttp routes ---------------------------------------------------------


def _key_hosts(base_url: str) -> frozenset:
    check_url(base_url)
    host = _host(base_url)
    if not host:
        raise PromptWriterError("The base URL has no host")
    return NANOGPT_HOSTS if host in NANOGPT_HOSTS else frozenset({host})


def save_key(key_file: Path, base_url: str, key: str) -> dict:
    """Store (or, with an empty key, remove) the key for base_url's host. Never returns it."""
    hosts = _key_hosts(base_url)
    key = (key or "").strip()
    if any(ch.isspace() for ch in key):
        raise PromptWriterError("An API key cannot contain spaces or line breaks")
    key_file = Path(key_file)
    try:
        data = json.loads(key_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    data = {k: v for k, v in data.items() if not (isinstance(k, str) and k.strip().lower() in hosts)}
    if key:
        for host in sorted(hosts):
            data[host] = key
    key_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = key_file.with_name(key_file.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, key_file)
    return {"set": bool(key)}


def key_status(base_url: str, *, env, key_file) -> dict:
    """Whether a key exists for base_url's host, and where it comes from. Never the key."""
    try:
        hosts = _key_hosts(base_url)
    except PromptWriterError as exc:
        return {"error": str(exc)}
    host = _host(base_url)
    in_file = key_for(base_url, {}, key_file) is not None
    in_env = host in NANOGPT_HOSTS and bool(env.get(NANOGPT_ENV))
    source = "settings" if in_file else ("environment" if in_env else None)
    return {"set": bool(source), "source": source, "host": sorted(hosts)[0]}


def register(routes, web, *, user_dir: str, settings_loader, image_path) -> None:
    """Attach the /warppipe/llm routes. Blocking work runs in a thread."""
    import asyncio

    key_file = Path(user_dir) / KEY_FILE_NAME
    log_path = Path(user_dir) / LOG_FILE_NAME

    @routes.get("/warppipe/llm/models")
    async def _models(request):
        base_url = request.query.get("base_url", "") or DEFAULT_BASE_URL
        refresh = request.query.get("refresh") == "1"
        out = await asyncio.to_thread(
            handle_models, base_url, refresh, env=os.environ, key_file=key_file
        )
        return web.json_response(out)

    @routes.get("/warppipe/llm/key_status")
    async def _key_status(request):
        base_url = request.query.get("base_url", "") or DEFAULT_BASE_URL
        out = await asyncio.to_thread(key_status, base_url, env=os.environ, key_file=key_file)
        return web.json_response(out)

    @routes.post("/warppipe/llm/key")
    async def _save_key(request):
        try:
            body = await request.json()
            base_url = str(body.get("base_url") or DEFAULT_BASE_URL)
            key = str(body.get("key") or "")
        except Exception:
            return web.json_response({"error": "Invalid request body"})
        try:
            out = await asyncio.to_thread(save_key, key_file, base_url, key)
        except (PromptWriterError, OSError) as exc:
            return web.json_response({"error": _scrub(str(exc), key)})
        return web.json_response(out)

    @routes.get("/warppipe/llm/system_prompt")
    async def _system_prompt(request):
        settings = await asyncio.to_thread(settings_loader, request)
        name = request.query.get("name", "")
        out = await asyncio.to_thread(handle_system_prompt, name, settings)
        return web.json_response(out)

    @routes.get("/warppipe/llm/system_prompts")
    async def _system_prompts(request):
        settings = await asyncio.to_thread(settings_loader, request)
        return web.json_response(handle_system_prompts(settings))

    @routes.post("/warppipe/llm/title")
    async def _title(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid request body"})
        out = await asyncio.to_thread(handle_title, body, env=os.environ, key_file=key_file)
        return web.json_response(out)

    @routes.post("/warppipe/llm/write")
    async def _write(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid request body"})
        settings = await asyncio.to_thread(settings_loader, request)
        # One JSON object per line: {"type": "delta", thinking, text, tokens} while the
        # model answers, then {"type": "done", ...} with what handle_write returns.
        loop = asyncio.get_running_loop()
        events = asyncio.Queue()
        stop = threading.Event()

        def send(event):
            loop.call_soon_threadsafe(events.put_nowait, event)

        def work():
            def piece(thinking, text, tokens):
                send({"type": "delta", "thinking": thinking, "text": text, "tokens": tokens})

            try:
                out = handle_write(
                    body,
                    env=os.environ,
                    key_file=key_file,
                    settings=settings,
                    image_path=image_path,
                    on_delta=piece,
                    stopped=stop.is_set,
                    log_path=log_path,
                )
            except Exception as exc:
                # The stream has to end with its done line whatever went wrong.
                logger.exception("Prompt Writer: the write failed")
                out = {"error": f"The write failed ({type(exc).__name__})"}
            send({"type": "done", **out})

        response = web.StreamResponse(
            headers={"Content-Type": "application/x-ndjson", "Cache-Control": "no-cache"}
        )
        await response.prepare(request)
        asyncio.ensure_future(asyncio.to_thread(work))
        try:
            while True:
                try:
                    event = await asyncio.wait_for(events.get(), 1.0)
                except asyncio.TimeoutError:
                    # Nothing to write while the model thinks in silence: is the browser still there?
                    if request.transport is None or request.transport.is_closing():
                        break
                    continue
                await response.write((json.dumps(event) + "\n").encode("utf-8"))
                if event["type"] == "done":
                    await response.write_eof()
                    break
        except ConnectionError:
            pass  # the browser stopped the write
        finally:
            stop.set()
        return response
