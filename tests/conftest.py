import importlib.util
import sys
import types
import uuid
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class FakeTensor:
    def __init__(self, shape):
        self.shape = tuple(shape)


class _Field:
    io_type = None

    def __init__(self, field_id=None, display_name=None, options=None, **kwargs):
        self.id = field_id
        self.display_name = display_name or field_id
        self.options = list(options or ())
        self.metadata = kwargs


def _type_factory(io_type):
    input_type = type("Input", (_Field,), {"io_type": io_type})
    output_type = type("Output", (_Field,), {"io_type": io_type})
    return type(
        "FakeComfyType",
        (),
        {"io_type": io_type, "Input": input_type, "Output": output_type},
    )


class _Schema:
    def __init__(
        self,
        node_id,
        display_name=None,
        category=None,
        description=None,
        inputs=None,
        outputs=None,
        hidden=None,
        **kwargs,
    ):
        self.node_id = node_id
        self.display_name = display_name
        self.category = category
        self.description = description
        self.inputs = list(inputs or ())
        self.outputs = list(outputs or ())
        self.hidden = list(hidden or ())
        self.metadata = kwargs


class _ComfyNode:
    hidden = types.SimpleNamespace(
        unique_id="test-node",
        prompt=None,
        extra_pnginfo=None,
    )

    @classmethod
    def GET_SCHEMA(cls):
        schema = cls.define_schema()
        field_ids = [field.id for field in schema.inputs + schema.outputs if field.id]
        if len(field_ids) != len(set(field_ids)):
            raise ValueError("Schema field IDs must be unique")
        return schema


class _NodeOutput(tuple):
    def __new__(cls, *values, **kwargs):
        instance = super().__new__(cls, values)
        instance.metadata = kwargs
        return instance


class _ComfyExtension:
    pass


def _fake_io_module():
    io = types.SimpleNamespace()
    io.ComfyNode = _ComfyNode
    io.Schema = _Schema
    io.NodeOutput = _NodeOutput
    io.Hidden = types.SimpleNamespace(unique_id=object(), prompt=object(), extra_pnginfo=object())
    io.Custom = _type_factory

    for name, io_type in (
        ("AnyType", "*"),
        ("Boolean", "BOOLEAN"),
        ("Clip", "CLIP"),
        ("ClipVision", "CLIP_VISION"),
        ("Combo", "COMBO"),
        ("Conditioning", "CONDITIONING"),
        ("Float", "FLOAT"),
        ("Image", "IMAGE"),
        ("Int", "INT"),
        ("Latent", "LATENT"),
        ("Mask", "MASK"),
        ("Model", "MODEL"),
        ("String", "STRING"),
        ("Vae", "VAE"),
    ):
        setattr(io, name, _type_factory(io_type))

    return io


def _install_fake_runtime(monkeypatch):
    torch_module = types.ModuleType("torch")
    torch_module.zeros = lambda shape: FakeTensor(shape)
    monkeypatch.setitem(sys.modules, "torch", torch_module)

    samplers_module = types.ModuleType("comfy.samplers")
    samplers_module.SAMPLER_NAMES = ["euler", "heun"]
    samplers_module.SCHEDULER_HANDLERS = {
        "normal": object(),
        "karras": object(),
        "simple": object(),
    }
    samplers_module.SCHEDULER_NAMES = list(samplers_module.SCHEDULER_HANDLERS)
    samplers_module.KSampler = type(
        "KSampler",
        (),
        {
            "SAMPLERS": samplers_module.SAMPLER_NAMES,
            "SCHEDULERS": samplers_module.SCHEDULER_NAMES,
        },
    )

    comfy_module = types.ModuleType("comfy")
    comfy_module.__path__ = []
    comfy_module.samplers = samplers_module
    monkeypatch.setitem(sys.modules, "comfy", comfy_module)
    monkeypatch.setitem(sys.modules, "comfy.samplers", samplers_module)

    latest_module = types.ModuleType("comfy_api.latest")
    latest_module.ComfyExtension = _ComfyExtension
    latest_module.io = _fake_io_module()
    comfy_api_module = types.ModuleType("comfy_api")
    comfy_api_module.__path__ = []
    comfy_api_module.latest = latest_module
    monkeypatch.setitem(sys.modules, "comfy_api", comfy_api_module)
    monkeypatch.setitem(sys.modules, "comfy_api.latest", latest_module)


def load_warp_pipe(monkeypatch, enable_v3=False):
    _install_fake_runtime(monkeypatch)
    if enable_v3:
        monkeypatch.setenv("WARPPIPE_ENABLE_V3", "1")
    else:
        monkeypatch.delenv("WARPPIPE_ENABLE_V3", raising=False)

    module_name = "_warppipe_test_" + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(module_name, PROJECT_ROOT / "warp_pipe.py")
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, module_name, module)
    spec.loader.exec_module(module)
    return module


def load_package(monkeypatch, enable_v3=False):
    _install_fake_runtime(monkeypatch)
    if enable_v3:
        monkeypatch.setenv("WARPPIPE_ENABLE_V3", "1")
    else:
        monkeypatch.delenv("WARPPIPE_ENABLE_V3", raising=False)

    module_name = "_warppipe_package_test_" + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(
        module_name,
        PROJECT_ROOT / "__init__.py",
        submodule_search_locations=[str(PROJECT_ROOT)],
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, module_name, module)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def warp_pipe(monkeypatch):
    return load_warp_pipe(monkeypatch)


@pytest.fixture
def warp_pipe_loader(monkeypatch):
    return lambda enable_v3=False: load_warp_pipe(monkeypatch, enable_v3=enable_v3)


@pytest.fixture
def package_loader(monkeypatch):
    return lambda enable_v3=False: load_package(monkeypatch, enable_v3=enable_v3)
