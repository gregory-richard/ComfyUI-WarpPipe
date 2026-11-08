"""Prompt Writer backend: a small OpenAI-compatible LLM client.

Stdlib only, so it can be tested without ComfyUI or aiohttp. The aiohttp
routes are attached by ``register``, which ``warp_pipe._register_routes`` calls.

Secrets: an API key is only ever attached to a request whose host is the host
the key belongs to. A workflow that points ``base_url`` somewhere else can
therefore never receive the user's key. Keys are never logged, returned or
written, and are scrubbed from any error text.
"""

import base64
import json
import logging
import mimetypes
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Mapping, Optional

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://nano-gpt.com/api/v1"
SETTING_DIR = "WarpPipe.PromptWriter.SystemPromptDir"
KEY_FILE_NAME = "warppipe_llm_keys.json"
NANOGPT_ENV = "NANOGPT_API_KEY"
NANOGPT_HOSTS = frozenset({"nano-gpt.com", "api.nano-gpt.com"})
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
CHAT_TIMEOUT = 180
TITLE_TIMEOUT = 30
MODELS_TIMEOUT = 30
MODELS_TTL = 3600
DEFAULT_TEMPERATURE = 0.6
MAX_REFERENCES = 8
IMPROVE_REQUEST = "Improve this prompt. Keep what it describes."


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


def _request(url, *, api_key, body=None, timeout, opener):
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
        with opener(req, timeout=timeout) as resp:
            raw = resp.read()
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
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise PromptWriterError(f"{host} returned a response that is not JSON") from None


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
    opener=urllib.request.urlopen,
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
    system: str, idea: str, previous_result: Optional[str], image_data_urls: list
) -> list:
    messages = [{"role": "system", "content": system}]
    if previous_result:
        messages.append({"role": "assistant", "content": previous_result})
    text = IMPROVE_REQUEST if previous_result and not idea else idea
    if image_data_urls:
        content = [{"type": "text", "text": text}]
        content += [{"type": "image_url", "image_url": {"url": url}} for url in image_data_urls]
    else:
        content = text
    messages.append({"role": "user", "content": content})
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
    text = re.sub(r"(?s)<think>.*?</think>", "", content).strip()
    if not text:
        raise PromptWriterError("The model returned no text")
    return text


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
    opener=urllib.request.urlopen,
) -> dict:
    body = {
        "model": model_id,
        "temperature": temperature,
        "stream": False,
        "messages": build_messages(system, idea, previous_result, image_data_urls),
    }
    start = time.monotonic()
    payload = _request(
        _endpoint(base_url, "/chat/completions"),
        api_key=api_key,
        body=body,
        timeout=CHAT_TIMEOUT,
        opener=opener,
    )
    seconds = float(time.monotonic() - start)
    text = parse_reply(payload)
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    usage = {k: usage[k] for k in ("prompt_tokens", "completion_tokens") if k in usage}
    return {"text": text, "seconds": seconds, "usage": usage, "cost": cost_of(payload, model)}


# --- chat titles ------------------------------------------------------------

DEFAULT_TITLE_MODEL = "gemma-4-26b-a4b-it-chimeraxheretic"
TITLE_MAX_TOKENS = 24
TITLE_SOURCE_CHARS = 600
TITLE_MAX_CHARS = 60
TITLE_SYSTEM = (
    "You name chats about image ideas. Reply with only a short title of two to five words "
    "that says what the image shows, in the language of the text. "
    "No quotation marks, no final period, no explanation."
)


def clean_title(text: str) -> str:
    """One short line from whatever the model returned; empty when nothing usable is left."""
    text = re.sub(r"(?s)<think>.*?</think>", "", text or "").strip()
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
    opener=urllib.request.urlopen,
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


# --- request handling (no aiohttp) -----------------------------------------


def _key_or_error(base_url: str, env, key_file) -> Optional[str]:
    check_url(base_url)
    key = key_for(base_url, env, key_file)
    if key is None and _host(base_url) in NANOGPT_HOSTS:
        raise PromptWriterError(f"No API key for {_host(base_url)}: set {NANOGPT_ENV}")
    return key


def handle_models(base_url: str, refresh: bool, *, env, key_file, opener=urllib.request.urlopen) -> dict:
    base_url = (base_url or DEFAULT_BASE_URL).strip()
    try:
        check_url(base_url)
        key = key_for(base_url, env, key_file)  # the list works without a key
        return {"models": list_models(base_url, api_key=key, refresh=refresh, opener=opener)}
    except PromptWriterError as exc:
        return {"error": str(exc)}


def handle_title(body: dict, *, env, key_file, opener=urllib.request.urlopen) -> dict:
    try:
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


def handle_write(
    body: dict,
    *,
    env,
    key_file: Optional[Path],
    settings: dict,
    image_path: Callable[[str], Optional[str]],
    opener=urllib.request.urlopen,
) -> dict:
    key = None
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
        system = read_system_prompt(
            (settings or {}).get(SETTING_DIR), str(body.get("system_prompt") or "")
        )
        images = [
            _image_data_url(name, image_path) for name in _reference_names(body.get("references"))
        ]
        key = _key_or_error(base_url, env, key_file)
        try:
            models = list_models(base_url, api_key=key, opener=opener)
            model = next((m for m in models if m["id"] == model_id), None)
        except PromptWriterError:
            model = None
        return write(
            base_url, model_id, system, temperature, idea, previous, images,
            api_key=key, model=model, opener=opener,
        )
    except PromptWriterError as exc:
        return {"error": _scrub(str(exc), key)}


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
        out = await asyncio.to_thread(
            handle_write,
            body,
            env=os.environ,
            key_file=key_file,
            settings=settings,
            image_path=image_path,
        )
        return web.json_response(out)
