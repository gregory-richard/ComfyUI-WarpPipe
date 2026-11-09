import importlib.util
import json
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _load():
    spec = importlib.util.spec_from_file_location(
        "warppipe_prompt_writer_under_test", PROJECT_ROOT / "prompt_writer.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pw = _load()


class _Server:
    def __init__(self):
        self.requests = []
        self.replies = deque()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                outer.requests.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "headers": dict(self.headers),
                        "body": json.loads(raw) if raw else None,
                    }
                )
                status, body = outer.replies.popleft() if outer.replies else (200, {})
                data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
                self.send_response(status)
                ctype = "text/plain" if isinstance(body, str) else "application/json"
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = _handle
            do_POST = _handle

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/api/v1"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def server():
    pw._MODEL_CACHE.clear()
    s = _Server()
    yield s
    s.close()
    pw._MODEL_CACHE.clear()


def _key_file(tmp_path, key="k"):
    f = tmp_path / "warppipe_llm_keys.json"
    f.write_text(json.dumps({"127.0.0.1": key}), encoding="utf-8")
    return f


# --- Task 1 -----------------------------------------------------------------


def test_user_agent():
    version = (PROJECT_ROOT / "version.txt").read_text(encoding="utf-8").strip()
    assert pw.USER_AGENT == "ComfyUI-WarpPipe/" + version


def test_key_bound_to_host():
    env = {"NANOGPT_API_KEY": "k1"}
    assert pw.key_for("https://nano-gpt.com/api/v1", env, None) == "k1"
    assert pw.key_for("https://api.nano-gpt.com/api/v1", env, None) == "k1"
    assert pw.key_for("https://NANO-GPT.com/api/v1", env, None) == "k1"
    assert pw.key_for("https://evil.example/api/v1", env, None) is None
    assert pw.key_for("https://nano-gpt.com.evil.example/v1", env, None) is None
    assert pw.key_for("https://user@evil.example/nano-gpt.com", env, None) is None
    assert pw.key_for("http://127.0.0.1:1234/v1", env, None) is None
    assert pw.key_for("https://nano-gpt.com/api/v1", {}, None) is None


def test_key_file_names_other_hosts(tmp_path):
    f = tmp_path / "warppipe_llm_keys.json"
    f.write_text('{"127.0.0.1": "local"}')
    assert pw.key_for("http://127.0.0.1:1234/v1", {}, f) == "local"
    assert pw.key_for("http://localhost:1234/v1", {}, f) is None
    assert pw.key_for("http://127.0.0.1:1234/v1", {}, tmp_path / "missing.json") is None
    bad = tmp_path / "bad.json"
    bad.write_text("not json")
    assert pw.key_for("http://127.0.0.1:1234/v1", {}, bad) is None


def test_check_url():
    pw.check_url("https://nano-gpt.com/api/v1")
    pw.check_url("http://localhost:1234/v1")
    pw.check_url("http://127.0.0.1:1234/v1")
    pw.check_url("http://[::1]:1234/v1")
    for bad in ("http://nano-gpt.com/api/v1", "ftp://x/y", "file:///c:/x", "", "https:///x"):
        with pytest.raises(pw.PromptWriterError):
            pw.check_url(bad)


def test_map_models_nanogpt_and_plain():
    nano = {
        "data": [
            {
                "id": "b",
                "name": "Beta",
                "pricing": {"prompt": 0.3, "completion": 1.2},
                "capabilities": {"vision": True},
            },
            {"id": "a", "name": "alpha"},
        ]
    }
    assert pw.map_models(nano) == [
        {"id": "a", "name": "alpha", "prompt_price": None, "completion_price": None, "vision": False},
        {"id": "b", "name": "Beta", "prompt_price": 0.3, "completion_price": 1.2, "vision": True},
    ]
    assert pw.map_models({"data": [{"id": "m1"}]})[0]["name"] == "m1"
    io = pw.map_models({"data": [{"id": "x", "pricing": {"input": "0.5", "output": 2}}]})[0]
    assert io["prompt_price"] == 0.5 and io["completion_price"] == 2.0
    assert pw.map_models({}) == []


def test_list_models_sends_key_and_user_agent_and_caches(server):
    server.replies.append((200, {"data": [{"id": "m"}]}))
    models = pw.list_models(server.url, api_key="k")
    assert models[0]["id"] == "m"
    req = server.requests[0]
    assert req["path"] == "/api/v1/models?detailed=true"
    assert req["headers"]["Authorization"] == "Bearer k"
    assert req["headers"]["User-Agent"] == pw.USER_AGENT
    assert pw.USER_AGENT.startswith("ComfyUI-WarpPipe/")
    pw.list_models(server.url, api_key="k")
    assert len(server.requests) == 1
    server.replies.append((200, {"data": []}))
    assert pw.list_models(server.url, api_key="k", refresh=True) == []
    assert len(server.requests) == 2


def test_list_models_without_key_sends_no_authorization(server):
    server.replies.append((200, {"data": []}))
    pw.list_models(server.url, api_key=None)
    assert "Authorization" not in server.requests[0]["headers"]


def test_system_prompt_files(tmp_path):
    (tmp_path / "v2.6.txt").write_text("SYS", encoding="utf-8")
    (tmp_path / "notes.md").write_text("x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "inner.txt").write_text("x")
    assert pw.system_prompt_names(str(tmp_path)) == ["v2.6.txt"]
    assert pw.read_system_prompt(str(tmp_path), "v2.6.txt") == "SYS"
    for bad in ("../x.txt", "a/b.txt", "a\\b.txt", "notes.md", "missing.txt", "", "..", "sub/inner.txt"):
        with pytest.raises(pw.PromptWriterError):
            pw.read_system_prompt(str(tmp_path), bad)
    with pytest.raises(pw.PromptWriterError, match="SystemPromptDir"):
        pw.system_prompt_names(None)
    with pytest.raises(pw.PromptWriterError, match="SystemPromptDir"):
        pw.system_prompt_names("")
    with pytest.raises(pw.PromptWriterError):
        pw.system_prompt_names(str(tmp_path / "nope"))


def test_build_messages():
    assert pw.build_messages("S", "idea", None, []) == [
        {"role": "system", "content": "S"},
        {"role": "user", "content": "idea"},
    ]
    m = pw.build_messages("S", "warmer light", "OLD", ["data:image/png;base64,AAA"])
    assert m[1] == {"role": "assistant", "content": "OLD"}
    assert m[2] == {
        "role": "user",
        "content": [
            {"type": "text", "text": "warmer light"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}},
        ],
    }
    assert len(pw.build_messages("S", "i", "", [])) == 2


def test_build_messages_one_part_per_image():
    urls = ["data:image/png;base64,AAA", "data:image/jpeg;base64,BBB", "data:image/png;base64,CCC"]
    content = pw.build_messages("S", "i", None, urls)[1]["content"]
    assert content[0] == {"type": "text", "text": "i"}
    assert [p["image_url"]["url"] for p in content[1:]] == urls
    assert all(p["type"] == "image_url" for p in content[1:])


def test_build_messages_empty_idea_improves_previous():
    m = pw.build_messages("S", "", "OLD", [])
    assert m[1] == {"role": "assistant", "content": "OLD"}
    assert m[2] == {"role": "user", "content": "Improve this prompt. Keep what it describes."}
    with_image = pw.build_messages("S", "", "OLD", ["data:image/png;base64,AAA"])[2]["content"]
    assert with_image[0] == {"type": "text", "text": "Improve this prompt. Keep what it describes."}


def test_parse_reply_strips_thinking():
    def msg(**kw):
        return {"choices": [{"message": kw}]}

    assert pw.parse_reply(msg(content="<think>x</think>\n// Overview\n- A")) == "// Overview\n- A"
    assert pw.parse_reply(msg(content="P", reasoning="long")) == "P"
    with pytest.raises(pw.PromptWriterError, match="returned no text"):
        pw.parse_reply(msg(content="", reasoning_content="only thoughts"))
    with pytest.raises(pw.PromptWriterError, match="returned no text"):
        pw.parse_reply(msg(content="<think>only</think>"))
    with pytest.raises(pw.PromptWriterError, match="returned no text"):
        pw.parse_reply({})


def test_cost_of():
    usage = {"prompt_tokens": 1000, "completion_tokens": 500}
    model = {"prompt_price": 0.3, "completion_price": 1.2}
    assert pw.cost_of({"usage": usage}, model) == pytest.approx(0.0009)
    assert pw.cost_of({"usage": {**usage, "cost": 0.002}}, model) == 0.002
    assert pw.cost_of({"usage": usage}, None) is None
    assert pw.cost_of({"usage": usage}, {"prompt_price": None, "completion_price": None}) is None


def test_write_round_trip(server):
    server.replies.append(
        (
            200,
            {
                "choices": [{"message": {"content": "PROMPT"}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            },
        )
    )
    result = pw.write(
        server.url, "m", "S", 0.6, "idea", None, [], api_key="k", model=None
    )
    req = server.requests[0]
    assert req["method"] == "POST"
    assert req["path"] == "/api/v1/chat/completions"
    assert req["headers"]["User-Agent"] == pw.USER_AGENT
    assert req["body"] == {
        "model": "m",
        "temperature": 0.6,
        "stream": False,
        "messages": [{"role": "system", "content": "S"}, {"role": "user", "content": "idea"}],
    }
    assert result["text"] == "PROMPT"
    assert result["usage"] == {"prompt_tokens": 10, "completion_tokens": 5}
    assert isinstance(result["seconds"], float)
    assert result["cost"] is None


def test_write_surfaces_provider_errors(server):
    server.replies.append((402, {"error": {"message": "Insufficient balance"}}))
    with pytest.raises(pw.PromptWriterError) as e:
        pw.write(server.url, "m", "S", 0.6, "i", None, [], api_key="SECRETKEY", model=None)
    assert str(e.value) == "Insufficient balance"

    server.replies.append((500, "upstream down"))
    with pytest.raises(pw.PromptWriterError) as e:
        pw.write(server.url, "m", "S", 0.6, "i", None, [], api_key="SECRETKEY", model=None)
    assert "upstream down" in str(e.value) and "500" in str(e.value)
    assert "SECRETKEY" not in str(e.value)

    server.replies.append((400, "echo SECRETKEY back"))
    with pytest.raises(pw.PromptWriterError) as e:
        pw.write(server.url, "m", "S", 0.6, "i", None, [], api_key="SECRETKEY", model=None)
    assert "SECRETKEY" not in str(e.value)


def test_unreachable_host_is_error():
    with pytest.raises(pw.PromptWriterError, match="127.0.0.1"):
        pw.list_models("http://127.0.0.1:9/v1", api_key=None, refresh=True)


def test_foreign_host_rejected_before_request():
    with pytest.raises(pw.PromptWriterError):
        pw.write("http://evil.example/v1", "m", "S", 0.6, "i", None, [], api_key=None, model=None)


# --- Task 2 -----------------------------------------------------------------


def test_handle_write_uses_setting_folder_and_reference(server, tmp_path):
    (tmp_path / "s.txt").write_text("SYS", encoding="utf-8")
    img = tmp_path / "ref.png"
    img.write_bytes(b"\x89PNG")
    server.replies.append(
        (200, {"data": [{"id": "m", "pricing": {"prompt": 1.0, "completion": 2.0}}]})
    )
    server.replies.append(
        (
            200,
            {
                "choices": [{"message": {"content": "OUT"}}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 1000},
            },
        )
    )
    out = pw.handle_write(
        {
            "base_url": server.url,
            "model": "m",
            "system_prompt": "s.txt",
            "temperature": 0.6,
            "idea": "i",
            "previous_result": "",
            "references": ["ref.png"],
        },
        env={},
        key_file=_key_file(tmp_path, "LOCALKEY"),
        settings={"WarpPipe.PromptWriter.SystemPromptDir": str(tmp_path)},
        image_path=lambda name: str(img) if name == "ref.png" else None,
    )
    chat = [r for r in server.requests if r["path"].endswith("/chat/completions")][0]
    assert chat["headers"]["Authorization"] == "Bearer LOCALKEY"
    msgs = chat["body"]["messages"]
    assert msgs[0] == {"role": "system", "content": "SYS"}
    assert len(msgs) == 2
    assert msgs[1]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert out["text"] == "OUT"
    assert out["cost"] == pytest.approx(0.003)
    assert set(out) == {"text", "seconds", "usage", "cost", "suggestions"}
    assert out["suggestions"] == []
    assert "LOCALKEY" not in json.dumps(out)


def test_handle_write_model_list_failure_keeps_write(server, tmp_path):
    (tmp_path / "s.txt").write_text("SYS", encoding="utf-8")
    server.replies.append((500, "no list"))
    server.replies.append((200, {"choices": [{"message": {"content": "OUT"}}]}))
    out = pw.handle_write(
        {"base_url": server.url, "model": "m", "system_prompt": "s.txt", "idea": "i",
         "previous_result": "PREV"},
        env={}, key_file=tmp_path / "none.json",
        settings={"WarpPipe.PromptWriter.SystemPromptDir": str(tmp_path)},
        image_path=lambda name: None,
    )
    assert out["text"] == "OUT" and out["cost"] is None
    chat = server.requests[-1]
    assert chat["body"]["messages"][1] == {"role": "assistant", "content": "PREV"}
    assert chat["body"]["temperature"] == 0.6


def test_handle_write_unknown_reference_is_error(server, tmp_path):
    (tmp_path / "s.txt").write_text("SYS", encoding="utf-8")
    out = pw.handle_write(
        {"base_url": server.url, "model": "m", "system_prompt": "s.txt", "idea": "i",
         "references": ["nope.png"]},
        env={}, key_file=tmp_path / "none.json",
        settings={"WarpPipe.PromptWriter.SystemPromptDir": str(tmp_path)},
        image_path=lambda name: None,
    )
    assert "error" in out and "nope.png" in out["error"]
    assert not [r for r in server.requests if r["path"].endswith("/chat/completions")]


def _no_request(*args, **kwargs):
    pytest.fail("no request expected")


def _write_kwargs(tmp_path, image_path=lambda name: None, opener=_no_request):
    (tmp_path / "s.txt").write_text("SYS", encoding="utf-8")
    return dict(
        env={}, key_file=tmp_path / "none.json",
        settings={"WarpPipe.PromptWriter.SystemPromptDir": str(tmp_path)},
        image_path=image_path, opener=opener,
    )


WRITE_BASE = {"base_url": "http://127.0.0.1:9/v1", "model": "m", "system_prompt": "s.txt"}


def test_handle_write_sends_every_reference_in_order(server, tmp_path):
    paths = {}
    for name in ("a.png", "b.jpg", "c.gif"):
        paths[name] = tmp_path / name
        paths[name].write_bytes(name.encode())
    server.replies.append((200, {"data": []}))
    server.replies.append((200, {"choices": [{"message": {"content": "OUT"}}]}))
    out = pw.handle_write(
        {**WRITE_BASE, "base_url": server.url, "idea": "i", "references": ["a.png", "b.jpg", "c.gif"]},
        **_write_kwargs(
            tmp_path,
            image_path=lambda name: str(paths[name]),
            opener=pw.urllib.request.urlopen,
        ),
    )
    assert out["text"] == "OUT"
    content = server.requests[-1]["body"]["messages"][1]["content"]
    urls = [p["image_url"]["url"] for p in content[1:]]
    assert len(urls) == 3
    assert urls[0].startswith("data:image/png;base64,")
    assert urls[1].startswith("data:image/jpeg;base64,")
    assert urls[2].startswith("data:image/gif;base64,")


def test_handle_write_without_references_sends_plain_text(server, tmp_path):
    server.replies.append((200, {"data": []}))
    server.replies.append((200, {"choices": [{"message": {"content": "OUT"}}]}))
    out = pw.handle_write(
        {**WRITE_BASE, "base_url": server.url, "idea": "i", "references": []},
        **_write_kwargs(tmp_path, opener=pw.urllib.request.urlopen),
    )
    assert out["text"] == "OUT"
    assert server.requests[-1]["body"]["messages"][1] == {"role": "user", "content": "i"}


def test_handle_write_refuses_more_than_eight_references(tmp_path):
    img = tmp_path / "a.png"
    img.write_bytes(b"x")
    calls = []

    def image_path(name):
        calls.append(name)
        return str(img)

    out = pw.handle_write(
        {**WRITE_BASE, "idea": "i", "references": [f"{i}.png" for i in range(9)]},
        **_write_kwargs(tmp_path, image_path=image_path),
    )
    assert "8" in out["error"]
    assert calls == []


def test_handle_write_allows_eight_references(server, tmp_path):
    img = tmp_path / "a.png"
    img.write_bytes(b"x")
    server.replies.append((200, {"data": []}))
    server.replies.append((200, {"choices": [{"message": {"content": "OUT"}}]}))
    out = pw.handle_write(
        {**WRITE_BASE, "base_url": server.url, "idea": "i", "references": [f"{i}.png" for i in range(8)]},
        **_write_kwargs(
            tmp_path, image_path=lambda name: str(img), opener=pw.urllib.request.urlopen
        ),
    )
    assert out["text"] == "OUT"
    assert len(server.requests[-1]["body"]["messages"][1]["content"]) == 9


@pytest.mark.parametrize("bad", ["a.png", 5, {"name": "a.png"}, [1], [None], ["a.png", {}]])
def test_handle_write_refuses_malformed_references(tmp_path, bad):
    out = pw.handle_write(
        {**WRITE_BASE, "idea": "i", "references": bad}, **_write_kwargs(tmp_path)
    )
    assert "error" in out


def test_handle_write_one_bad_reference_refuses_the_request(tmp_path):
    img = tmp_path / "a.png"
    img.write_bytes(b"x")
    out = pw.handle_write(
        {**WRITE_BASE, "idea": "i", "references": ["a.png", "../secret.png"]},
        **_write_kwargs(tmp_path, image_path=lambda name: str(img)),
    )
    assert "secret.png" in out["error"]


def test_handle_write_empty_idea_improves_previous(server, tmp_path):
    server.replies.append((200, {"data": []}))
    server.replies.append((200, {"choices": [{"message": {"content": "OUT"}}]}))
    out = pw.handle_write(
        {**WRITE_BASE, "base_url": server.url, "idea": "   ", "previous_result": "OLD"},
        **_write_kwargs(tmp_path, opener=pw.urllib.request.urlopen),
    )
    assert out["text"] == "OUT"
    msgs = server.requests[-1]["body"]["messages"]
    assert msgs[1] == {"role": "assistant", "content": "OLD"}
    assert msgs[2] == {"role": "user", "content": "Improve this prompt. Keep what it describes."}


@pytest.mark.parametrize("previous", [None, "", "  \n "])
def test_handle_write_empty_idea_without_previous_is_error(tmp_path, previous):
    out = pw.handle_write(
        {**WRITE_BASE, "idea": "", "previous_result": previous}, **_write_kwargs(tmp_path)
    )
    assert out == {"error": "Type an idea first"}


def test_handle_write_foreign_host_never_gets_key(tmp_path):
    (tmp_path / "s.txt").write_text("SYS", encoding="utf-8")
    seen = []

    def opener(req, timeout=None):
        seen.append(req)
        raise OSError("blocked")

    out = pw.handle_write(
        {"base_url": "https://evil.example/v1", "model": "m", "system_prompt": "s.txt", "idea": "i"},
        env={"NANOGPT_API_KEY": "NANOKEY"}, key_file=tmp_path / "none.json",
        settings={"WarpPipe.PromptWriter.SystemPromptDir": str(tmp_path)},
        image_path=lambda name: None, opener=opener,
    )
    assert "error" in out
    assert seen and all(r.get_header("Authorization") is None for r in seen)
    assert "NANOKEY" not in out["error"]


def test_handle_write_nanogpt_without_key_says_set_env(tmp_path):
    (tmp_path / "s.txt").write_text("SYS", encoding="utf-8")
    out = pw.handle_write(
        {"base_url": "https://nano-gpt.com/api/v1", "model": "m", "system_prompt": "s.txt", "idea": "i"},
        env={}, key_file=tmp_path / "none.json",
        settings={"WarpPipe.PromptWriter.SystemPromptDir": str(tmp_path)},
        image_path=lambda name: None, opener=lambda *a, **k: pytest.fail("no request expected"),
    )
    assert "NANOGPT_API_KEY" in out["error"]


def test_handle_models(server, tmp_path):
    server.replies.append((200, {"data": [{"id": "m"}]}))
    out = pw.handle_models(server.url, False, env={}, key_file=_key_file(tmp_path))
    assert out["models"][0]["id"] == "m"
    assert server.requests[0]["headers"]["Authorization"] == "Bearer k"
    assert "error" in pw.handle_models("http://evil.example/v1", False, env={}, key_file=None)


def test_handle_system_prompts(tmp_path):
    assert "SystemPromptDir" in pw.handle_system_prompts({})["error"]
    (tmp_path / "a.txt").write_text("x")
    out = pw.handle_system_prompts({"WarpPipe.PromptWriter.SystemPromptDir": str(tmp_path)})
    assert out == {"names": ["a.txt"]}


def test_handle_write_refuses_traversal_and_non_image_reference(tmp_path):
    (tmp_path / "s.txt").write_text("SYS", encoding="utf-8")
    secret = tmp_path / "secret.txt"
    secret.write_text("x")
    base = {"base_url": "http://127.0.0.1:9/v1", "model": "m", "system_prompt": "s.txt", "idea": "i"}
    kwargs = dict(
        env={}, key_file=None,
        settings={"WarpPipe.PromptWriter.SystemPromptDir": str(tmp_path)},
        image_path=lambda name: str(secret),
        opener=lambda *a, **k: pytest.fail("no request expected"),
    )
    for ref in ("../secret.txt", "C:/x.png", "/etc/x.png", "secret.txt"):
        out = pw.handle_write({**base, "references": [ref]}, **kwargs)
        assert "error" in out, ref


def test_handle_models_needs_no_key(server, tmp_path):
    server.replies.append((200, {"data": [{"id": "m"}]}))
    out = pw.handle_models(server.url, True, env={}, key_file=tmp_path / "none.json")
    assert out == {"models": [{"id": "m", "name": "m", "prompt_price": None,
                               "completion_price": None, "vision": False}]}


def test_save_key_binds_nanogpt_hosts_and_never_returns_key(tmp_path):
    f = tmp_path / "keys.json"
    f.write_text('{"127.0.0.1": "local"}', encoding="utf-8")
    assert pw.save_key(f, "https://nano-gpt.com/api/v1", "  sk-ABC  ") == {"set": True}
    data = json.loads(f.read_text(encoding="utf-8"))
    assert data == {"127.0.0.1": "local", "api.nano-gpt.com": "sk-ABC", "nano-gpt.com": "sk-ABC"}
    assert pw.key_for("https://api.nano-gpt.com/api/v1", {}, f) == "sk-ABC"
    assert pw.key_for("https://evil.example/v1", {}, f) is None
    status = pw.key_status("https://nano-gpt.com/api/v1", env={}, key_file=f)
    assert status == {"set": True, "source": "settings", "host": "api.nano-gpt.com"}
    assert "sk-ABC" not in json.dumps(status)
    assert pw.save_key(f, "https://nano-gpt.com/api/v1", "") == {"set": False}
    assert json.loads(f.read_text(encoding="utf-8")) == {"127.0.0.1": "local"}


def test_save_key_rejects_bad_input(tmp_path):
    f = tmp_path / "keys.json"
    with pytest.raises(pw.PromptWriterError):
        pw.save_key(f, "https://nano-gpt.com/api/v1", "a b")
    with pytest.raises(pw.PromptWriterError):
        pw.save_key(f, "http://evil.example/v1", "k")


def test_key_status_env_and_none(tmp_path):
    f = tmp_path / "none.json"
    assert pw.key_status("https://nano-gpt.com/api/v1", env={"NANOGPT_API_KEY": "x"}, key_file=f)["source"] == "environment"
    assert pw.key_status("https://nano-gpt.com/api/v1", env={}, key_file=f)["set"] is False


def test_clean_title():
    assert pw.clean_title('"Kitchen At Dusk."\n\nsecond line') == "Kitchen At Dusk"
    assert pw.clean_title("<think>hm</think>Title: Red bicycle") == "Red bicycle"
    assert len(pw.clean_title("word " * 40)) <= 60
    assert pw.clean_title("   ") == ""


def test_make_title_request(server):
    server.replies.append((200, {"choices": [{"message": {"content": "Red bicycle"}}]}))
    title = pw.make_title(server.url, "cheap", "a red bicycle " * 100, api_key="k")
    assert title == "Red bicycle"
    body = server.requests[0]["body"]
    assert body["model"] == "cheap"
    assert body["max_tokens"] == pw.TITLE_MAX_TOKENS
    assert body["messages"][0] == {"role": "system", "content": pw.TITLE_SYSTEM}
    assert len(body["messages"][1]["content"]) <= pw.TITLE_SOURCE_CHARS


def test_handle_title(server, tmp_path):
    none = tmp_path / "none.json"
    server.replies.append((200, {"choices": [{"message": {"content": "Beach at dusk"}}]}))
    out = pw.handle_title(
        {"base_url": server.url, "model": "m", "source": "idea"}, env={}, key_file=none
    )
    assert out == {"title": "Beach at dusk"}
    assert "error" in pw.handle_title(
        {"base_url": server.url, "model": "", "source": "idea"}, env={}, key_file=none
    )
    assert "error" in pw.handle_title(
        {"base_url": server.url, "model": "m", "source": "  "}, env={}, key_file=none
    )
    server.replies.append((200, {"choices": [{"message": {"content": '""'}}]}))
    assert "error" in pw.handle_title(
        {"base_url": server.url, "model": "m", "source": "idea"}, env={}, key_file=none
    )


def test_system_prompts_newest_version_first(tmp_path):
    names = [
        "image master prompt v1.0.txt",
        "image_master_prompt_v2.6.txt",
        "image_master_prompt_v2.7.txt",
        "image_master_prompt_v2.7.1.txt",
        "image_master_prompt_v2.7.2.txt",
        "image_master_prompt_v2.10.txt",
        "notes.txt",
    ]
    for name in names:
        (tmp_path / name).write_text("x", encoding="utf-8")
    assert pw.system_prompt_names(str(tmp_path)) == [
        "image_master_prompt_v2.10.txt",
        "image_master_prompt_v2.7.2.txt",
        "image_master_prompt_v2.7.1.txt",
        "image_master_prompt_v2.7.txt",
        "image_master_prompt_v2.6.txt",
        "image master prompt v1.0.txt",
        "notes.txt",
    ]


def test_handle_system_prompt(tmp_path):
    (tmp_path / "v2.7.txt").write_text("MASTER", encoding="utf-8")
    settings = {"WarpPipe.PromptWriter.SystemPromptDir": str(tmp_path)}
    assert pw.handle_system_prompt("v2.7.txt", settings) == {"name": "v2.7.txt", "text": "MASTER"}
    assert "error" in pw.handle_system_prompt("../secret.txt", settings)
    assert "error" in pw.handle_system_prompt("missing.txt", settings)
    assert "SystemPromptDir" in pw.handle_system_prompt("v2.7.txt", {})["error"]


# --- LoRAs ------------------------------------------------------------------

LORAS = {
    "available": [
        {"ref": "L1", "title": "Soft Light", "triggers": ["softlight", "glow"]},
        {"ref": "L2", "title": "No Words", "triggers": []},
    ],
    "active": [{"title": "Moss Style", "triggers": ["mossy", "green hue"]}],
}


def test_lora_instructions_states_the_rules():
    text = pw.lora_instructions(LORAS)
    assert "add-on for the image model" in text
    assert "trigger words" in text
    assert "Never use trigger words of LoRAs that are not active" in text
    assert "never mention LoRAs in the prompt" in text
    assert "===LORAS===" in text
    assert "REF | strength | reason" in text
    assert "at most 5 lines" in text
    assert "between 0.4 and 1.2" in text
    assert "at most 6 words" in text
    assert "write only the marker line" in text


def test_lora_instructions_lists_available_after_the_rules():
    lines = pw.lora_instructions(LORAS).splitlines()
    assert "L1 | Soft Light | triggers: softlight, glow" in lines
    assert "L2 | No Words" in lines
    assert lines.index("L2 | No Words") == len(lines) - 1
    assert lines.index("L1 | Soft Light | triggers: softlight, glow") > next(
        i for i, line in enumerate(lines) if "===LORAS===" in line
    )


def test_lora_instructions_lists_active_with_their_triggers():
    text = pw.lora_instructions(LORAS)
    assert "ACTIVE" in text
    assert "Moss Style | triggers: mossy, green hue" in text.splitlines()


def test_lora_instructions_active_without_triggers_has_no_triggers_part():
    text = pw.lora_instructions({"available": [], "active": [{"title": "Bare", "triggers": []}]})
    assert "Bare" in text.splitlines()


def test_lora_instructions_omits_the_active_block_when_empty():
    text = pw.lora_instructions({"available": LORAS["available"], "active": []})
    assert "ACTIVE" not in text
    assert "L1 | Soft Light | triggers: softlight, glow" in text.splitlines()


def test_lora_instructions_empty_when_there_is_nothing_to_say():
    assert pw.lora_instructions({"available": [], "active": []}) == ""
    assert pw.lora_instructions({}) == ""


def test_clean_loras_keeps_well_formed_input():
    assert pw.clean_loras(LORAS) == LORAS


@pytest.mark.parametrize("raw", [None, "x", 3, ["L1"]])
def test_clean_loras_not_a_dict_is_not_sent(raw):
    assert pw.clean_loras(raw) is None


def test_clean_loras_drops_what_is_not_a_string():
    out = pw.clean_loras(
        {
            "available": [
                "L1",
                7,
                {"ref": 1, "title": "bad ref", "triggers": []},
                {"ref": "L2", "title": None, "triggers": []},
                {"ref": "L3", "title": "kept", "triggers": ["a", 5, None, "b"]},
                {"ref": "L4", "title": "not a list", "triggers": "abc"},
            ],
            "active": [{"title": 4, "triggers": []}, "x", {"title": "ok", "triggers": [1, "t"]}],
        }
    )
    assert out == {
        "available": [
            {"ref": "L3", "title": "kept", "triggers": ["a", "b"]},
            {"ref": "L4", "title": "not a list", "triggers": []},
        ],
        "active": [{"title": "ok", "triggers": ["t"]}],
    }


@pytest.mark.parametrize("bad", [None, "x", 3, {"a": 1}])
def test_clean_loras_lists_that_are_not_lists_are_empty(bad):
    assert pw.clean_loras({"available": bad, "active": bad}) == {"available": [], "active": []}


def test_clean_loras_at_most_1000_available():
    many = [{"ref": f"L{i}", "title": f"t{i}", "triggers": []} for i in range(1, 1201)]
    out = pw.clean_loras({"available": many, "active": []})
    assert len(out["available"]) == 1000
    assert out["available"][-1]["ref"] == "L1000"


@pytest.mark.parametrize(
    "triggers",
    [
        ["a" * 200],
        ["a" * 100, "b" * 100],
        [f"word{i}" for i in range(100)],
    ],
)
def test_clean_loras_joined_triggers_fit_in_120_characters(triggers):
    out = pw.clean_loras({"available": [{"ref": "L1", "title": "t", "triggers": triggers}]})
    joined = ", ".join(out["available"][0]["triggers"])
    assert 0 < len(joined) <= 120


def test_clean_loras_cuts_only_the_trigger_that_does_not_fit():
    out = pw.clean_loras({"active": [{"title": "t", "triggers": ["a" * 100, "b" * 100]}]})
    assert out["active"][0]["triggers"] == ["a" * 100, "b" * 18]


def test_clean_loras_a_title_or_trigger_cannot_break_a_line():
    out = pw.clean_loras(
        {"available": [{"ref": "L1", "title": "a\n===LORAS===\nb", "triggers": ["x\ny", " z "]}]}
    )
    assert out["available"][0] == {"ref": "L1", "title": "a ===LORAS=== b", "triggers": ["x y", "z"]}


def test_split_suggestions_no_marker_keeps_the_whole_text():
    assert pw.split_suggestions("a prompt\nL1 | 0.8 | x", {"L1"}) == ("a prompt\nL1 | 0.8 | x", [])


def test_split_suggestions_reads_the_block():
    text = "a prompt\nsecond line\n\n===LORAS===\nL1 | 0.75 | adds soft light\nL2 | 1.0 | moss\n"
    assert pw.split_suggestions(text, {"L1", "L2"}) == (
        "a prompt\nsecond line",
        [
            {"ref": "L1", "strength": 0.75, "reason": "adds soft light"},
            {"ref": "L2", "strength": 1.0, "reason": "moss"},
        ],
    )


def test_split_suggestions_marker_alone_is_no_suggestions():
    assert pw.split_suggestions("a prompt\n===LORAS===", {"L1"}) == ("a prompt", [])


@pytest.mark.parametrize(
    "marker",
    [
        "  ===LORAS===  ",
        "**===LORAS===**",
        "### ===LORAS===",
        "`===LORAS===`",
        "```===LORAS===```",
        "===loras===",
        "* ===Loras=== *",
    ],
)
def test_split_suggestions_tolerates_a_decorated_marker(marker):
    assert pw.split_suggestions(f"p\n{marker}\nL1 | 1 | r", {"L1"}) == (
        "p",
        [{"ref": "L1", "strength": 1.0, "reason": "r"}],
    )


def test_split_suggestions_a_marker_inside_a_line_is_prompt_text():
    text = "write ===LORAS=== here\nL1 | 1 | r"
    assert pw.split_suggestions(text, {"L1"}) == (text, [])


def test_split_suggestions_splits_at_the_last_marker():
    text = "one\n===LORAS===\ntwo\n===LORAS===\nL1 | 1 | r"
    assert pw.split_suggestions(text, {"L1"}) == (
        "one\n===LORAS===\ntwo",
        [{"ref": "L1", "strength": 1.0, "reason": "r"}],
    )


def test_split_suggestions_handles_windows_line_ends():
    text = "p\r\n===LORAS===\r\nL1 | 0.5 | r\r\n"
    assert pw.split_suggestions(text, {"L1"}) == (
        "p",
        [{"ref": "L1", "strength": 0.5, "reason": "r"}],
    )


def test_split_suggestions_skips_unknown_refs_and_duplicates():
    text = "p\n===LORAS===\nL9 | 1 | no\nL1 | 0.5 | first\nL1 | 0.9 | again\nnone would help"
    assert pw.split_suggestions(text, {"L1"}) == (
        "p",
        [{"ref": "L1", "strength": 0.5, "reason": "first"}],
    )


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("0.5", 0.5),
        ("9", 1.5),
        ("-3", 0.1),
        ("0.123456", 0.12),
        ("strong", 0.8),
        ("", 0.8),
        ("nan", 0.8),
        ("inf", 0.8),
    ],
)
def test_split_suggestions_strength(raw, expected):
    _, found = pw.split_suggestions(f"p\n===LORAS===\nL1 | {raw} | r", {"L1"})
    assert found == [{"ref": "L1", "strength": expected, "reason": "r"}]


def test_split_suggestions_a_ref_alone_gets_the_defaults():
    assert pw.split_suggestions("p\n===LORAS===\nL1", {"L1"}) == (
        "p",
        [{"ref": "L1", "strength": 0.8, "reason": ""}],
    )


@pytest.mark.parametrize("ref", ["- L1", "1. L1", "**L1**", "`L1`", "* L1"])
def test_split_suggestions_tolerates_list_decoration_on_the_ref(ref):
    _, found = pw.split_suggestions(f"p\n===LORAS===\n{ref} | 1 | r", {"L1"})
    assert [item["ref"] for item in found] == ["L1"]


def test_split_suggestions_at_most_five():
    refs = {f"L{i}" for i in range(1, 9)}
    lines = "\n".join(f"L{i} | 1 | r" for i in range(1, 9))
    _, found = pw.split_suggestions(f"p\n===LORAS===\n{lines}", refs)
    assert [item["ref"] for item in found] == ["L1", "L2", "L3", "L4", "L5"]


def test_split_suggestions_skipped_lines_do_not_use_up_the_five():
    refs = {f"L{i}" for i in range(1, 6)}
    lines = "\n".join(["X | 1 | r", "L1 | 1 | r", "L1 | 1 | r"] + [f"L{i} | 1 | r" for i in range(2, 6)])
    _, found = pw.split_suggestions(f"p\n===LORAS===\n{lines}", refs)
    assert len(found) == 5


def test_split_suggestions_reason_is_capped_and_may_hold_a_bar():
    _, found = pw.split_suggestions(f"p\n===LORAS===\nL1 | 1 | a | b {'x' * 200}", {"L1"})
    assert found[0]["reason"].startswith("a | b ")
    assert len(found[0]["reason"]) == 80


def test_split_suggestions_only_the_block_leaves_empty_text():
    assert pw.split_suggestions("===LORAS===\nL1 | 1 | r", {"L1"})[0] == ""


def _chat_body(server):
    return [r for r in server.requests if r["path"].endswith("/chat/completions")][-1]["body"]


def _lora_write(server, tmp_path, content, loras):
    server.replies.append((200, {"data": []}))
    server.replies.append((200, {"choices": [{"message": {"content": content}}]}))
    body = {**WRITE_BASE, "base_url": server.url, "idea": "i"}
    if loras is not None:
        body["loras"] = loras
    return pw.handle_write(body, **_write_kwargs(tmp_path, opener=pw.urllib.request.urlopen))


def test_handle_write_without_loras_behaves_as_before(server, tmp_path):
    out = _lora_write(server, tmp_path, "OUT\n===LORAS===\nL1 | 1 | r", None)
    assert _chat_body(server)["messages"][0] == {"role": "system", "content": "SYS"}
    assert out["text"] == "OUT\n===LORAS===\nL1 | 1 | r"
    assert out["suggestions"] == []


def test_handle_write_appends_the_instructions_after_the_master_prompt(server, tmp_path):
    _lora_write(server, tmp_path, "OUT", LORAS)
    system = _chat_body(server)["messages"][0]["content"]
    assert system.startswith("SYS\n\n")
    assert system.endswith(pw.lora_instructions(LORAS))


def test_handle_write_returns_suggestions_and_clean_text(server, tmp_path):
    out = _lora_write(
        server, tmp_path, "the prompt\n===LORAS===\nL2 | 0.7 | moss\nL9 | 1 | unknown", LORAS
    )
    assert out["text"] == "the prompt"
    assert out["suggestions"] == [{"ref": "L2", "strength": 0.7, "reason": "moss"}]


def test_handle_write_block_only_is_the_no_text_error(server, tmp_path):
    out = _lora_write(server, tmp_path, "===LORAS===\nL1 | 1 | r", LORAS)
    assert out == {"error": "The model returned no text"}


def test_handle_write_loras_that_are_not_a_dict_count_as_not_sent(server, tmp_path):
    out = _lora_write(server, tmp_path, "OUT\n===LORAS===", ["L1"])
    assert _chat_body(server)["messages"][0]["content"] == "SYS"
    assert out["text"] == "OUT\n===LORAS==="
    assert out["suggestions"] == []


def test_handle_write_empty_loras_add_no_instructions(server, tmp_path):
    out = _lora_write(server, tmp_path, "OUT", {"available": [], "active": []})
    assert _chat_body(server)["messages"][0]["content"] == "SYS"
    assert out["text"] == "OUT"
    assert out["suggestions"] == []


def test_lora_instructions_end_with_the_output_rule():
    text = pw.lora_instructions({"available": [{"ref": "L1", "title": "Film", "triggers": []}]})
    assert text.index("AVAILABLE LoRAs") < text.index(pw.LORAS_MARKER)
