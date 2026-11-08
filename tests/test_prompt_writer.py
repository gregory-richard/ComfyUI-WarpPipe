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
    assert set(out) == {"text", "seconds", "usage", "cost"}
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
