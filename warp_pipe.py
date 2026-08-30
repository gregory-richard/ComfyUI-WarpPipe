import difflib
import hashlib
import json
import logging
import os
import re
import threading
import time
import urllib.parse
import uuid
from typing import Any, ClassVar, Optional

logger = logging.getLogger("WarpPipe")

try:
    import comfy.samplers
except ModuleNotFoundError as exc:
    if exc.name not in {"comfy", "comfy.samplers"}:
        raise

    logger.warning("Failed to import comfy.samplers: %s", exc)

    # Complete-enough fallback for local linting and unit tests outside ComfyUI.
    class _MockKSampler:
        SAMPLERS: ClassVar[list[str]] = [
            "euler",
            "euler_ancestral",
            "heun",
            "dpm_2",
            "dpm_2_ancestral",
            "lms",
            "dpm_fast",
            "dpm_adaptive",
            "dpmpp_2s_ancestral",
            "dpmpp_sde",
            "dpmpp_2m",
        ]
        SCHEDULERS: ClassVar[list[str]] = [
            "normal",
            "karras",
            "exponential",
            "sgm_uniform",
            "simple",
            "ddim_uniform",
        ]

    class _MockSamplers:
        KSampler = _MockKSampler
        SCHEDULER_NAMES: ClassVar[list[str]] = _MockKSampler.SCHEDULERS.copy()
        SCHEDULER_HANDLERS: ClassVar[dict[str, object]] = {
            name: object() for name in _MockKSampler.SCHEDULERS
        }

    class _MockComfy:
        samplers = _MockSamplers

    comfy = _MockComfy()

try:
    from comfy_api.latest import ComfyExtension, io

    COMFY_API_AVAILABLE = True
except ImportError:
    ComfyExtension = None
    io = None
    COMFY_API_AVAILABLE = False

# V3 combo outputs currently validate inconsistently in ComfyUI when linked to
# sampler/scheduler inputs. Keep the stable legacy schema by default, while
# leaving the V3 implementation available for explicit local testing.
ENABLE_V3_NODES = COMFY_API_AVAILABLE and os.environ.get("WARPPIPE_ENABLE_V3") == "1"

# Patch for RES4LYF compatibility - GLOBAL REGISTRATION
# We must register beta57 and bong_tangent in the global comfy.samplers lists so *other* nodes (like FaceDetailer)
# pick them up as valid scheduler options, even if RES4LYF hasn't loaded yet.
RES4LYF_SCHEDULERS = ("beta57", "bong_tangent")


def _register_res4lyf_scheduler_fallbacks() -> None:
    handlers = getattr(comfy.samplers, "SCHEDULER_HANDLERS", None)
    if not isinstance(handlers, dict) or handlers.get("karras") is None:
        logger.warning("Cannot register RES4LYF scheduler fallbacks: ComfyUI has no karras handler")
        return

    scheduler_names = getattr(comfy.samplers, "SCHEDULER_NAMES", None)
    if not isinstance(scheduler_names, list):
        scheduler_names = list(scheduler_names or ())
        comfy.samplers.SCHEDULER_NAMES = scheduler_names

    ksampler_schedulers = getattr(comfy.samplers.KSampler, "SCHEDULERS", None)
    if not isinstance(ksampler_schedulers, list):
        ksampler_schedulers = list(ksampler_schedulers or ())
        comfy.samplers.KSampler.SCHEDULERS = ksampler_schedulers

    for scheduler_name in RES4LYF_SCHEDULERS:
        handlers.setdefault(scheduler_name, handlers["karras"])
        if scheduler_name not in scheduler_names:
            scheduler_names.append(scheduler_name)
        if scheduler_name not in ksampler_schedulers:
            ksampler_schedulers.append(scheduler_name)


_register_res4lyf_scheduler_fallbacks()

# Safe scheduler/sampler lists for compatibility (pulled dynamically from Comfy).
SAFE_SAMPLERS = getattr(comfy.samplers.KSampler, "SAMPLERS", [])
if not isinstance(SAFE_SAMPLERS, list):
    SAFE_SAMPLERS = list(SAFE_SAMPLERS)

SAFE_SCHEDULERS = getattr(comfy.samplers.KSampler, "SCHEDULERS", [])
if not isinstance(SAFE_SCHEDULERS, list):
    SAFE_SCHEDULERS = list(SAFE_SCHEDULERS)

# Compatibility mappings for exotic schedulers
SCHEDULER_ALIASES = {
    "AYS SDXL": "karras",
    "AYS SD1": "karras",
    "AYS SVD": "karras",
    "GITS[coeff=1.2]": "karras",
    "LTXV[default]": "karras",
    "OSS FLUX": "karras",
    "OSS Wan": "karras",
    "OSS Chroma": "karras",
}

# Impact Pack's additional schedulers
IMPACT_PACK_SCHEDULERS = [
    "AYS SDXL",
    "AYS SD1",
    "AYS SVD",
    "GITS[coeff=1.2]",
    "LTXV[default]",
    "OSS FLUX",
    "OSS Wan",
    "OSS Chroma",
]

# Dynamically build FD_SCHEDULERS to match FaceDetailer's expectation
# It expects: list(comfy.samplers.SCHEDULER_HANDLERS) + ADDITIONAL_SCHEDULERS
# We use list(comfy.samplers.SCHEDULER_HANDLERS) to ensure exact order match.
# Note: we use list() to get keys, which matches how FaceDetailer does it.
FD_SCHEDULERS = list(
    dict.fromkeys(
        list(getattr(comfy.samplers, "SCHEDULER_HANDLERS", {}))
        + SAFE_SCHEDULERS
        + IMPACT_PACK_SCHEDULERS
    )
)


def coerce_scheduler(name: str) -> str:
    """
    Coerce scheduler name to a safe, compatible value.

    Args:
        name: The scheduler name to coerce

    Returns:
        A safe scheduler name that ComfyUI will accept
    """
    if name in SAFE_SCHEDULERS:
        return name
    return SCHEDULER_ALIASES.get(name, "karras")


def coerce_scheduler_fd(name: str) -> str:
    """
    Coerce scheduler into FaceDetailer's accepted set.

    Args:
        name: The scheduler name to coerce for FaceDetailer compatibility

    Returns:
        A scheduler name that FaceDetailer will accept
    """
    if name in FD_SCHEDULERS:
        return name
    # Try alias map; if alias within FD list, return it, else fallback to karras
    alias = SCHEDULER_ALIASES.get(name)
    if alias in FD_SCHEDULERS:
        return alias
    return "karras"


def coerce_sampler(name: str) -> str:
    """
    Coerce sampler name to a safe, compatible value.

    Args:
        name: The sampler name to coerce

    Returns:
        A safe sampler name that ComfyUI will accept
    """
    if name in SAFE_SAMPLERS:
        return name
    # Default fallback for any unknown samplers
    return "euler"


def _validate_linked_input_types(
    input_types: Optional[dict[str, Any]],
    declared_inputs: dict[str, tuple],
    relaxed_inputs: set[str],
):
    """Retain normal socket checks while allowing compatible external enums."""
    if not input_types:
        return True

    for input_name, received_type in input_types.items():
        if input_name in relaxed_inputs or input_name not in declared_inputs:
            continue

        expected_type = declared_inputs[input_name][0]
        if received_type == expected_type or received_type == "*" or expected_type == "*":
            continue

        if isinstance(received_type, str) and isinstance(expected_type, str):
            received_types = {item.strip() for item in received_type.split(",")}
            expected_types = {item.strip() for item in expected_type.split(",")}
            if received_types.intersection(expected_types):
                continue

        return f"Linked input '{input_name}' has type {received_type!r}; expected {expected_type!r}"

    return True


# Global storage for warp data; keys are unique per Warp instance
warp_storage: dict[str, dict[str, Any]] = {}
_storage_timestamps: dict[str, float] = {}  # Track last-access time per warp ID
_storage_lock = threading.Lock()
_STORAGE_MAX_AGE_SECONDS = 3600  # Prune entries older than 1 hour
_STORAGE_MAX_ENTRIES = 256  # Hard cap on stored entries


def _cleanup_warp_storage_locked(now: float) -> None:
    stale_ids = [
        warp_id
        for warp_id in warp_storage
        if now - _storage_timestamps.get(warp_id, float("-inf")) > _STORAGE_MAX_AGE_SECONDS
    ]
    for warp_id in stale_ids:
        warp_storage.pop(warp_id, None)
        _storage_timestamps.pop(warp_id, None)

    if stale_ids:
        logger.debug("Cleaned up %d stale warp storage entries", len(stale_ids))

    overflow = len(warp_storage) - _STORAGE_MAX_ENTRIES
    if overflow > 0:
        oldest_ids = sorted(
            warp_storage,
            key=lambda warp_id: _storage_timestamps.get(warp_id, float("-inf")),
        )[:overflow]
        for warp_id in oldest_ids:
            warp_storage.pop(warp_id, None)
            _storage_timestamps.pop(warp_id, None)
        logger.debug("Evicted %d warp storage entries (over cap)", len(oldest_ids))


def cleanup_warp_storage() -> None:
    """Prune stale warp storage entries to prevent memory leaks."""
    now = time.time()
    with _storage_lock:
        _cleanup_warp_storage_locked(now)


def _fingerprint_inputs(kwargs: dict[str, Any]) -> str:
    h = hashlib.sha256()
    for key in sorted(kwargs.keys()):
        if kwargs[key] is not None:
            h.update(f"{key}:{kwargs[key]!r}".encode())
    return h.hexdigest()


def _get_v3_node_id(cls, fallback_prefix: str) -> str:
    unique_id = getattr(getattr(cls, "hidden", None), "unique_id", None)
    if unique_id:
        return f"v3:{unique_id}"
    return f"{fallback_prefix}:{uuid.uuid4().hex}"


def _create_empty_latent(width: int, height: int, batch_size: int):
    for name, value, minimum, maximum in (
        ("width", width, 64, 8192),
        ("height", height, 64, 8192),
        ("batch_size", batch_size, 1, 64),
    ):
        if not isinstance(value, int) or isinstance(value, bool):
            raise TypeError(f"{name} must be an integer, got {type(value).__name__}")
        if not minimum <= value <= maximum:
            raise ValueError(f"{name} must be between {minimum} and {maximum}, got {value}")

    if width % 8 or height % 8:
        raise ValueError(f"width and height must be divisible by 8, got {width} x {height}")

    import torch

    latent_width = width // 8
    latent_height = height // 8
    latent = torch.zeros([batch_size, 4, latent_height, latent_width])
    return {"samples": latent}


def _parse_size_preset(preset: str) -> tuple:
    """
    Parse resolution preset strings like:
    "Square (SDXL native)        |  1:1   |  1024 x  1024  |  1.05 MP"
    """
    match = re.search(r"(\d+)\s*×\s*(\d+)", preset)
    if match:
        return int(match.group(1)), int(match.group(2))

    match = re.search(r"(\d+)\s*x\s*(\d+)", preset, re.IGNORECASE)
    if match:
        return int(match.group(1)), int(match.group(2))

    return 1024, 1024


class Warp:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "warp"
    DESCRIPTION = "Bundle multiple data types into a single warp object"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "warp": ("WARPPIPE", {}),  # copy from existing warp if provided
                "prompt_positive": ("STRING", {"forceInput": True}),
                "prompt_negative": ("STRING", {"forceInput": True}),
                "conditioning_positive": ("CONDITIONING", {}),
                "conditioning_negative": ("CONDITIONING", {}),
                "image": ("IMAGE", {}),
                "mask": ("MASK", {}),
                "model_1": ("MODEL", {}),
                "model_2": ("MODEL", {}),
                "clip": ("CLIP", {}),
                "clip_vision": ("CLIP_VISION", {}),
                "vae": ("VAE", {}),
                "latent": ("LATENT", {}),
                "batch_size": ("INT", {"forceInput": True}),
                "seed": ("INT", {"forceInput": True}),
                "steps_1": ("INT", {"forceInput": True}),
                "steps_2": ("INT", {"forceInput": True}),
                "steps_3": ("INT", {"forceInput": True}),
                "cfg": ("FLOAT", {"forceInput": True}),
                # Accept enum (matches KSampler)
                "sampler_name": (SAFE_SAMPLERS, {"forceInput": True}),
                "scheduler": (SAFE_SCHEDULERS, {"forceInput": True}),
                "width": ("INT", {"forceInput": True}),
                "height": ("INT", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("WARPPIPE",)
    RETURN_NAMES = ("warp",)

    def __init__(self):
        # Unique ID for this warp instance
        self._warp_id = uuid.uuid4().hex

    @classmethod
    def IS_CHANGED(cls, **kwargs) -> str:
        return _fingerprint_inputs(kwargs)

    @classmethod
    def VALIDATE_INPUTS(cls, input_types=None):
        """Accept linked combo enums from nodes that expose wider option lists."""
        return _validate_linked_input_types(
            input_types,
            cls.INPUT_TYPES()["optional"],
            {"sampler_name", "scheduler"},
        )

    def warp(
        self,
        warp: Optional[dict[str, Any]] = None,
        image: Optional[Any] = None,
        mask: Optional[Any] = None,
        model_1: Optional[Any] = None,
        model_2: Optional[Any] = None,
        clip: Optional[Any] = None,
        clip_vision: Optional[Any] = None,
        vae: Optional[Any] = None,
        conditioning_positive: Optional[Any] = None,
        conditioning_negative: Optional[Any] = None,
        latent: Optional[Any] = None,
        prompt_positive: Optional[str] = None,
        prompt_negative: Optional[str] = None,
        batch_size: Optional[int] = None,
        seed: Optional[int] = None,
        steps_1: Optional[int] = None,
        steps_2: Optional[int] = None,
        steps_3: Optional[int] = None,
        cfg: Optional[float] = None,
        sampler_name: Optional[str] = None,
        scheduler: Optional[str] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
    ) -> tuple:
        # If warp input provided, copy existing data
        if isinstance(warp, dict) and "id" in warp:
            prev_id = warp["id"]
            with _storage_lock:
                data = warp_storage.get(prev_id, {}).copy()
        else:
            data = {}

        logger.debug("Warp Input - model_1 type: %s", type(model_1))
        logger.debug("Warp Input - model_2 type: %s", type(model_2))
        logger.debug("Warp Input - clip type: %s", type(clip))

        # Normalize sampler/scheduler values
        normalized_sampler = coerce_sampler(sampler_name) if sampler_name is not None else None
        normalized_scheduler = coerce_scheduler(scheduler) if scheduler is not None else None

        # Apply any new inputs
        updates = {
            "image": image,
            "mask": mask,
            "model_1": model_1,
            "model_2": model_2,
            "clip": clip,
            "clip_vision": clip_vision,
            "vae": vae,
            "conditioning_positive": conditioning_positive,
            "conditioning_negative": conditioning_negative,
            "latent": latent,
            "prompt_positive": prompt_positive,
            "prompt_negative": prompt_negative,
            "batch_size": batch_size,
            "seed": seed,
            "steps_1": steps_1,
            "steps_2": steps_2,
            "steps_3": steps_3,
            "cfg": cfg,
            "sampler_name": normalized_sampler,
            "scheduler": normalized_scheduler,
            "width": width,
            "height": height,
        }
        for key, val in updates.items():
            if val is not None:
                data[key] = val

        with _storage_lock:
            now = time.time()
            warp_storage[self._warp_id] = data
            _storage_timestamps[self._warp_id] = now
            _cleanup_warp_storage_locked(now)

        if latent is not None:
            logger.debug("Warping latent type: %s", type(latent))

        return ({"id": self._warp_id},)


class Unwarp:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "unwarp"
    DESCRIPTION = "Unpack a warp object back into individual data types"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "warp": ("WARPPIPE", {}),  # WARPPIPE carries the warp ID
            }
        }

    RETURN_TYPES = (
        "MODEL",
        "MODEL",
        "IMAGE",
        "MASK",
        "CLIP",
        "CLIP_VISION",
        "VAE",
        "CONDITIONING",
        "CONDITIONING",
        "LATENT",
        "STRING",
        "STRING",
        "INT",
        "INT",
        "INT",
        "INT",
        "INT",
        "FLOAT",
        SAFE_SAMPLERS,
        SAFE_SCHEDULERS,
        "INT",
        "INT",
    )
    RETURN_NAMES = (
        "model_1",
        "model_2",
        "image",
        "mask",
        "clip",
        "clip_vision",
        "vae",
        "conditioning_positive",
        "conditioning_negative",
        "latent",
        "prompt_positive",
        "prompt_negative",
        "batch_size",
        "seed",
        "steps_1",
        "steps_2",
        "steps_3",
        "cfg",
        "sampler_name",
        "scheduler",
        "width",
        "height",
    )

    def _return_empty_values(self) -> tuple:
        """Return a tuple of None values for all expected outputs"""
        return (None,) * len(self.RETURN_TYPES)

    def unwarp(self, warp: Optional[dict[str, Any]] = None) -> tuple:
        # Handle case where no warp is connected - return all None values
        if warp is None:
            return self._return_empty_values()

        # Handle invalid warp data gracefully
        if not isinstance(warp, dict) or "id" not in warp:
            logger.warning("Invalid warp signal received. Returning empty values.")
            return self._return_empty_values()

        warp_id = warp["id"]
        with _storage_lock:
            stored_data = warp_storage.get(warp_id)
            if stored_data is not None:
                _storage_timestamps[warp_id] = time.time()  # Refresh on access
                data = stored_data.copy()
            else:
                data = None

        # Handle missing warp data gracefully
        if data is None:
            logger.warning("Warp data not found for ID: %s. Returning empty values.", warp_id)
            return self._return_empty_values()

        latent_out = data.get("latent")
        model_out = data.get("model_1")
        clip_out = data.get("clip")

        logger.debug("Unwarp Output - model_1 type: %s", type(model_out))
        logger.debug("Unwarp Output - clip type: %s", type(clip_out))
        if latent_out is not None:
            logger.debug("Unwarping latent type: %s", type(latent_out))

        ret = (
            data.get("model_1"),
            data.get("model_2"),
            data.get("image"),
            data.get("mask"),
            data.get("clip"),
            data.get("clip_vision"),
            data.get("vae"),
            data.get("conditioning_positive"),
            data.get("conditioning_negative"),
            latent_out,
            data.get("prompt_positive"),
            data.get("prompt_negative"),
            data.get("batch_size"),
            data.get("seed"),
            data.get("steps_1"),
            data.get("steps_2"),
            data.get("steps_3"),
            data.get("cfg"),
            (
                coerce_sampler(data["sampler_name"])
                if data.get("sampler_name") is not None
                else None
            ),
            (coerce_scheduler(data["scheduler"]) if data.get("scheduler") is not None else None),
            data.get("width"),
            data.get("height"),
        )

        logger.debug(
            "Unwarp RETURN_TYPES len: %d, return tuple len: %d", len(self.RETURN_TYPES), len(ret)
        )

        return ret


class WarpProvider:
    """Parameter and latent provider for warp workflows"""

    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "provide"
    DESCRIPTION = "Generate latents and parameters for warp workflows"

    @classmethod
    def INPUT_TYPES(cls):
        # Resolution presets: Use Case | Aspect Ratio | Width × Height | Megapixels
        # Sorted by aspect ratio (increasing: 9:16 → 16:9), then by MP (increasing)
        # All dimensions divisible by 8, small side up to 2048
        size_presets = [
            # 9:16 - Mobile/Stories (portrait)
            "Mobile/Stories (small)      |  9:16  |   576 ×  1024  |  0.59 MP",
            "Mobile/Stories (HD)         |  9:16  |   720 ×  1280  |  0.92 MP",
            "Mobile/Stories (Full HD)    |  9:16  |  1080 ×  1920  |  2.07 MP",
            "Mobile/Stories (max)        |  9:16  |  1152 ×  2048  |  2.36 MP",
            # 3:4 - Portrait
            "Portrait (classic)          |  3:4   |   768 ×  1024  |  0.79 MP",
            "Portrait (high-res)         |  3:4   |  1152 ×  1536  |  1.77 MP",
            "Portrait (max)              |  3:4   |  1536 ×  2048  |  3.15 MP",
            # 2:3 - Photo portrait
            "Photo portrait              |  2:3   |   832 ×  1248  |  1.04 MP",
            "Photo portrait (high-res)   |  2:3   |  1024 ×  1536  |  1.57 MP",
            "Photo portrait (max)        |  2:3   |  1368 ×  2048  |  2.80 MP",
            # 4:5 - Instagram portrait
            "Instagram portrait          |  4:5   |   816 ×  1024  |  0.84 MP",
            "Instagram portrait (hi-res) |  4:5   |  1224 ×  1536  |  1.88 MP",
            "Instagram portrait (max)    |  4:5   |  1640 ×  2048  |  3.36 MP",
            # 1:1 - Square
            "Square (small)              |  1:1   |   768 ×   768  |  0.59 MP",
            "Square (SDXL native)        |  1:1   |  1024 ×  1024  |  1.05 MP",
            "Square (high-res)           |  1:1   |  1536 ×  1536  |  2.36 MP",
            "Square (max)                |  1:1   |  2048 ×  2048  |  4.19 MP",
            # 5:4 - Instagram landscape
            "Instagram landscape         |  5:4   |  1024 ×   816  |  0.84 MP",
            "Instagram landscape (hi-res)|  5:4   |  1536 ×  1224  |  1.88 MP",
            "Instagram landscape (max)   |  5:4   |  2048 ×  1640  |  3.36 MP",
            # 3:2 - Photo landscape
            "Photo landscape             |  3:2   |  1248 ×   832  |  1.04 MP",
            "Photo landscape (high-res)  |  3:2   |  1536 ×  1024  |  1.57 MP",
            "Photo landscape (max)       |  3:2   |  2048 ×  1368  |  2.80 MP",
            # 4:3 - Landscape
            "Landscape (classic)         |  4:3   |  1024 ×   768  |  0.79 MP",
            "Landscape (high-res)        |  4:3   |  1536 ×  1152  |  1.77 MP",
            "Landscape (max)             |  4:3   |  2048 ×  1536  |  3.15 MP",
            # 16:9 - Widescreen
            "Widescreen (small)          |  16:9  |  1024 ×   576  |  0.59 MP",
            "Widescreen (720p)           |  16:9  |  1280 ×   720  |  0.92 MP",
            "Widescreen (1080p)          |  16:9  |  1920 ×  1080  |  2.07 MP",
            "Widescreen (max)            |  16:9  |  2048 ×  1152  |  2.36 MP",
            # Custom option
            "Custom",
        ]

        return {
            "optional": {
                # Generation Parameters
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "steps_1": ("INT", {"default": 20, "min": 1, "max": 200}),
                "steps_2": ("INT", {"default": 0, "min": 0, "max": 200}),
                "steps_3": ("INT", {"default": 0, "min": 0, "max": 200}),
                "cfg": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 50.0}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "normal"}),
                # Image Size Parameters
                "size_preset": (
                    size_presets,
                    {"default": "Square (SDXL native)        |  1:1   |  1024 ×  1024  |  1.05 MP"},
                ),
                "custom_width": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "custom_height": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
            }
        }

    RETURN_TYPES = (
        "LATENT",
        "INT",
        "INT",
        "INT",
        "INT",
        "INT",
        "FLOAT",
        SAFE_SAMPLERS,
        SAFE_SCHEDULERS,
        "INT",
        "INT",
    )
    RETURN_NAMES = (
        "latent",
        "batch_size",
        "seed",
        "steps_1",
        "steps_2",
        "steps_3",
        "cfg",
        "sampler_name",
        "scheduler",
        "width",
        "height",
    )

    def provide(
        self,
        batch_size: int = 1,
        seed: int = 0,
        steps_1: int = 20,
        steps_2: int = 0,
        steps_3: int = 0,
        cfg: float = 7.0,
        sampler_name: str = "euler",
        scheduler: str = "normal",
        size_preset: str = "Square (SDXL native)        |  1:1   |  1024 ×  1024  |  1.05 MP",
        custom_width: int = 1024,
        custom_height: int = 1024,
    ) -> tuple:
        # Determine actual dimensions from preset or custom values
        if size_preset == "Custom":
            width, height = custom_width, custom_height
        else:
            width, height = _parse_size_preset(size_preset)

        # Create empty latent image based on dimensions and batch size
        latent = _create_empty_latent(width, height, batch_size)

        # Use the provided seed directly (rgthree-comfy will handle seed control)
        actual_seed = seed

        # Return all outputs with coercion for compatibility
        return (
            latent,  # LATENT
            batch_size,  # INT
            actual_seed,  # INT
            steps_1,  # INT
            steps_2,  # INT
            steps_3,  # INT
            cfg,  # FLOAT
            coerce_sampler(sampler_name),  # SAMPLER
            coerce_scheduler(scheduler),  # SCHEDULER
            width,  # INT
            height,  # INT
        )


# Adapter: KSampler scheduler enum -> FaceDetailer scheduler enum
class FDSchedulerAdapter:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "adapt"
    DESCRIPTION = "Convert KSampler scheduler to FaceDetailer scheduler"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scheduler": (SAFE_SCHEDULERS, {}),
            }
        }

    RETURN_TYPES = (FD_SCHEDULERS,)
    RETURN_NAMES = ("scheduler",)

    @classmethod
    def VALIDATE_INPUTS(cls, input_types=None) -> bool:
        return True

    def adapt(self, scheduler: str) -> tuple:
        return (coerce_scheduler_fd(scheduler),)


class DeadEnd:
    """A dead end node that accepts any input type but produces no output"""

    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "dead_end"
    DESCRIPTION = "A dead end node that accepts any input but produces no output - useful for debugging or temporarily disabling workflow paths"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                # Use "*" as the type to accept any input type
                "input": ("*", {}),
            }
        }

    # No return types - this is a true dead end
    RETURN_TYPES = ()
    RETURN_NAMES = ()

    # Do NOT mark as OUTPUT_NODE - we want it to be a true dead end
    # OUTPUT_NODE = False  # This is the default, so we don't need to specify it

    @classmethod
    def VALIDATE_INPUTS(cls, input_types=None):
        """
        Validate inputs - accept any type for wildcard '*' input.
        The input_types parameter is required to skip backend type validation
        when using wildcard inputs, per ComfyUI documentation.
        """
        return True

    def dead_end(self, input=None):
        """
        Accept any input and do nothing with it.
        This creates a dead end in the workflow execution graph.
        Since this node has no outputs and is not an OUTPUT_NODE,
        it will not trigger execution when connected.
        """
        # Simply return nothing - the input is consumed but not passed forward
        return ()


# ---------------------------------------------------------------------------
# Civitai-compatible image saving
#
# Civitai identifies a checkpoint or LoRA by a hash of the file, not by its
# name: AutoV2 is the first 10 hex characters of the file's SHA256. It reads
# those hashes out of an A1111-style "parameters" text chunk, which is a
# different dialect from ComfyUI's own "prompt"/"workflow" chunks. Writing both
# lets one PNG satisfy Civitai and still reopen as a workflow.
# ---------------------------------------------------------------------------

CIVITAI_INFO_SUFFIX = ".civitai.info"
AUTOV2_LENGTH = 10

# Matches an A1111 LoRA tag: <lora:name:0.8>, tolerating a trailing clip weight.
_LORA_TAG_RE = re.compile(r"<lora:([^:>]+):(-?[0-9]*\.?[0-9]+)[^>]*>", re.IGNORECASE)


_hash_cache: dict[str, str] = {}
_hash_cache_lock = threading.Lock()
_hash_cache_loaded = False


def _hash_cache_path() -> Optional[str]:
    """Writable location for the hash cache, or None when running outside ComfyUI."""
    try:
        import folder_paths
    except ImportError:
        return None

    for getter in ("get_user_directory", "get_output_directory", "get_temp_directory"):
        resolve = getattr(folder_paths, getter, None)
        if not callable(resolve):
            continue
        try:
            base = resolve()
        except Exception:
            continue
        if base and os.path.isdir(base):
            return os.path.join(base, "warppipe_hashes.json")
    return None


def _load_hash_cache() -> None:
    global _hash_cache_loaded
    if _hash_cache_loaded:
        return
    _hash_cache_loaded = True

    path = _hash_cache_path()
    if not path or not os.path.isfile(path):
        return
    try:
        with open(path, encoding="utf-8") as handle:
            stored = json.load(handle)
        if isinstance(stored, dict):
            _hash_cache.update({k: v for k, v in stored.items() if isinstance(v, str)})
    except (OSError, ValueError) as exc:
        logger.debug("Could not read hash cache: %s", exc)


def _persist_hash_cache() -> None:
    path = _hash_cache_path()
    if not path:
        return
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(_hash_cache, handle)
    except OSError as exc:
        logger.debug("Could not write hash cache: %s", exc)


def _cache_key(file_path: str) -> Optional[str]:
    """Identify a file by path, size and mtime so a replaced file re-hashes."""
    try:
        stat = os.stat(file_path)
    except OSError:
        return None
    return f"{os.path.abspath(file_path)}|{stat.st_size}|{int(stat.st_mtime)}"


def sha256_file(file_path: str, chunk_size: int = 1024 * 1024) -> Optional[str]:
    """SHA256 of a file, cached on disk. Returns None if the file cannot be read."""
    key = _cache_key(file_path)
    if key is None:
        return None

    with _hash_cache_lock:
        _load_hash_cache()
        cached = _hash_cache.get(key)
    if cached:
        return cached

    digest = hashlib.sha256()
    try:
        with open(file_path, "rb") as handle:
            for chunk in iter(lambda: handle.read(chunk_size), b""):
                digest.update(chunk)
    except OSError as exc:
        logger.warning("Could not hash %s: %s", file_path, exc)
        return None

    value = digest.hexdigest()
    with _hash_cache_lock:
        _hash_cache[key] = value
        _persist_hash_cache()
    return value


def read_civitai_sidecar(file_path: str) -> Optional[dict[str, Any]]:
    """Read the .civitai.info sidecar written by Civitai Updater and similar tools."""
    base, _ = os.path.splitext(file_path)
    sidecar = base + CIVITAI_INFO_SUFFIX
    if not os.path.isfile(sidecar):
        return None
    try:
        with open(sidecar, encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError) as exc:
        logger.debug("Could not read sidecar %s: %s", sidecar, exc)
        return None
    return payload if isinstance(payload, dict) else None


def _sha256_from_sidecar(payload: dict[str, Any]) -> Optional[str]:
    for entry in payload.get("files") or ():
        if not isinstance(entry, dict):
            continue
        hashes = entry.get("hashes")
        if isinstance(hashes, dict):
            value = hashes.get("SHA256") or hashes.get("sha256")
            if isinstance(value, str) and value:
                return value
    return None


def model_autov2(file_path: Optional[str]) -> Optional[str]:
    """AutoV2 for a model file: the sidecar's SHA256 when present, else hash it."""
    if not file_path:
        return None

    payload = read_civitai_sidecar(file_path)
    if payload:
        sha = _sha256_from_sidecar(payload)
        if sha:
            return sha[:AUTOV2_LENGTH].lower()

    sha = sha256_file(file_path)
    return sha[:AUTOV2_LENGTH].lower() if sha else None


def _resolve_model_path(folder: str, name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    try:
        import folder_paths
    except ImportError:
        return None
    try:
        return folder_paths.get_full_path(folder, name)
    except Exception as exc:
        logger.debug("Could not resolve %s/%s: %s", folder, name, exc)
        return None


def _as_float(value: Any, default: float = 1.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def extract_lora_tags(text: Optional[str]) -> list[tuple[str, float]]:
    """Pull <lora:name:weight> tags out of prompt text."""
    if not isinstance(text, str):
        return []
    return [(m.group(1).strip(), _as_float(m.group(2))) for m in _LORA_TAG_RE.finditer(text)]


# Model loaders are recognised by the input they carry rather than by class
# name, so checkpoint, UNet/diffusion and GGUF loaders are all covered without
# naming each pack. Each entry maps the input to the folder_paths keys to try.
MODEL_INPUT_KEYS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("ckpt_name", ("checkpoints",)),
    ("unet_name", ("diffusion_models", "unet")),
    ("model_name", ("diffusion_models", "checkpoints")),
)


def trace_upstream(graph: dict[str, Any], start_id: Optional[str]) -> Optional[set[str]]:
    """Node ids that feed the given node, following links backwards.

    A large workflow holds many loaders behind switches and subgraphs; only the
    ones upstream of the image being saved actually produced it. Returns None
    when there is no usable starting point, meaning "consider the whole graph".
    """
    if start_id is None or not isinstance(graph, dict):
        return None

    start = str(start_id)
    if start not in graph:
        return None

    seen: set[str] = set()
    pending = [start]
    while pending:
        node_id = pending.pop()
        if node_id in seen:
            continue
        seen.add(node_id)

        node = graph.get(node_id)
        if not isinstance(node, dict):
            continue
        for value in (node.get("inputs") or {}).values():
            # A link is encoded as [source_node_id, output_index].
            if isinstance(value, list) and value and isinstance(value[0], (str, int)):
                pending.append(str(value[0]))
    return seen


def collect_graph_resources(
    prompt_graph: Optional[dict[str, Any]],
    start_id: Optional[str] = None,
) -> tuple[Optional[str], list[tuple[str, float]]]:
    """Find the model and LoRAs that produced the image being saved.

    Handles ComfyUI's own loaders, UNet/diffusion and GGUF loaders, and the
    stacked slot format used by rgthree's Power Lora Loader. When start_id is
    given, only nodes upstream of it are considered, so unrelated branches of a
    large workflow do not contribute.
    """
    model_name: Optional[str] = None
    loras: list[tuple[str, float]] = []

    if not isinstance(prompt_graph, dict):
        return model_name, loras

    upstream = trace_upstream(prompt_graph, start_id)
    for node_id, node in prompt_graph.items():
        if upstream is not None and str(node_id) not in upstream:
            continue
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue

        if model_name is None:
            for key, _folders in MODEL_INPUT_KEYS:
                value = inputs.get(key)
                if isinstance(value, str) and value and value.lower() != "none":
                    model_name = value
                    break

        name = inputs.get("lora_name")
        if isinstance(name, str) and name and name.lower() != "none":
            loras.append((name, _as_float(inputs.get("strength_model"))))

        # Nodes that take LoRAs as <lora:name:weight> in their text - this pack's
        # Prompt + LoRAs node, and power-prompt nodes from other packs - keep the
        # tags in a plain string input, so the graph still records what was used.
        for value in inputs.values():
            if isinstance(value, str) and "<lora:" in value.lower():
                loras.extend(extract_lora_tags(value))

        # Stacked loaders keep one dict per slot, e.g. {"lora": ..., "on": ...}.
        for value in inputs.values():
            if not isinstance(value, dict):
                continue
            slot = value.get("lora")
            if not isinstance(slot, str) or not slot or slot.lower() == "none":
                continue
            if value.get("on") is False:
                continue
            loras.append((slot, _as_float(value.get("strength"))))

    deduped: list[tuple[str, float]] = []
    seen: set[str] = set()
    for name, weight in loras:
        if name not in seen:
            seen.add(name)
            deduped.append((name, weight))
    return model_name, deduped


def resolve_model_file(name: Optional[str]) -> Optional[str]:
    """Locate a model file across the folder types different loaders use."""
    if not name:
        return None
    for _key, folders in MODEL_INPUT_KEYS:
        for folder in folders:
            path = _resolve_model_path(folder, name)
            if path:
                return path
    return None


def _lora_display_name(name: str) -> str:
    """Civitai shows the bare filename, without folders or extension."""
    return os.path.splitext(os.path.basename(name))[0]


def build_civitai_parameters(
    positive: str = "",
    negative: str = "",
    steps: Optional[int] = None,
    sampler_name: Optional[str] = None,
    scheduler: Optional[str] = None,
    cfg: Optional[float] = None,
    seed: Optional[int] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    model_name: Optional[str] = None,
    model_hash: Optional[str] = None,
    loras: Optional[list[tuple[str, float, Optional[str]]]] = None,
) -> str:
    """Assemble the A1111-style parameters block that Civitai parses."""
    loras = loras or []
    positive = positive or ""

    # A1111 carries LoRAs as tags in the prompt. Only add ones not already there,
    # so prompts that already use tag syntax are not duplicated.
    existing = {name.lower() for name, _ in extract_lora_tags(positive)}
    additions = [
        f"<lora:{display}:{weight:g}>"
        for display, weight, _ in loras
        if display.lower() not in existing
    ]
    if additions:
        positive = " ".join([positive.strip(), *additions]).strip()

    fields: list[tuple[str, Any]] = [
        ("Steps", steps),
        ("Sampler", sampler_name),
        ("Schedule type", scheduler),
        ("CFG scale", cfg),
        ("Seed", seed),
        ("Size", f"{width}x{height}" if width and height else None),
        ("Model hash", model_hash),
        ("Model", os.path.splitext(os.path.basename(model_name))[0] if model_name else None),
    ]

    hashed = [(display, sha) for display, _, sha in loras if sha]
    if hashed:
        pairs = ", ".join(f"{display}: {sha}" for display, sha in hashed)
        fields.append(("Lora hashes", '"' + pairs + '"'))

    fields.append(("Version", "ComfyUI-WarpPipe"))

    rendered = ", ".join(f"{key}: {value}" for key, value in fields if value not in (None, ""))

    lines = [positive]
    if negative:
        lines.append("Negative prompt: " + negative)
    lines.append(rendered)
    return "\n".join(lines)


def civitai_trigger_words(file_path: Optional[str]) -> list[str]:
    """Trigger words for a model, from its .civitai.info sidecar."""
    if not file_path:
        return []
    payload = read_civitai_sidecar(file_path)
    if not payload:
        return []

    words: list[str] = []
    for entry in payload.get("trainedWords") or ():
        if not isinstance(entry, str):
            continue
        # Civitai often packs several comma-separated words into one entry.
        words.extend(part.strip() for part in entry.split(",") if part.strip())
    return words


def available_loras() -> list[str]:
    try:
        import folder_paths

        return list(folder_paths.get_filename_list("loras"))
    except Exception:
        return []


class LoraTagError(ValueError):
    """A LoRA tag names no file, or names too many."""


def _normalise(value: str) -> str:
    """Compare paths without caring about slash direction or case."""
    return value.replace("\\", "/").strip().lower()


def resolve_lora_name(
    query: str,
    candidates: Optional[list[str]] = None,
    strict: bool = False,
) -> Optional[str]:
    """Match what a tag names against the LoRAs on disk.

    Tried in order: the full name, the filename without folder or extension,
    then a unique substring. A folder prefix disambiguates, which matters: a
    real collection here holds 24 files whose names all contain "secret sauce",
    so a bare fragment cannot identify one.

    With strict=True an unresolvable tag raises instead of returning None, so a
    typo fails the run rather than silently producing an image without the LoRA.
    """
    if not query or not query.strip():
        return None
    names = available_loras() if candidates is None else candidates
    if not names:
        return None

    wanted = _normalise(query)

    for name in names:
        if _normalise(name) == wanted:
            return name

    for name in names:
        stem = _normalise(os.path.splitext(os.path.basename(name))[0])
        if stem == wanted:
            return name

    # A folder-qualified fragment, e.g. "sdxl/secret sauce".
    suffix = [name for name in names if _normalise(name).startswith(wanted)]
    if len(suffix) == 1:
        return suffix[0]

    partial = [name for name in names if wanted in _normalise(name)]
    if len(partial) == 1:
        return partial[0]

    # Fall back to matching every word separately, so a folder and a fragment
    # can be combined even though the creator's name sits between them:
    # "anima/grabbing breasts" finds "anima/bolero537 - grabbing breasts (anima)".
    terms = wanted.replace("/", " ").split()
    if len(terms) > 1:
        every = [name for name in names if all(term in _normalise(name) for term in terms)]
        if len(every) == 1:
            return every[0]
        if every:
            partial = every

    if partial:
        shown = ", ".join(os.path.basename(name) for name in partial[:4])
        more = f" and {len(partial) - 4} more" if len(partial) > 4 else ""
        message = (
            f"LoRA tag '{query}' matches {len(partial)} files ({shown}{more}). "
            "Add the folder or more of the name to pick one."
        )
    else:
        message = f"LoRA tag '{query}' matches no file in the loras folder."
        # With hundreds of LoRAs installed a typo is the likeliest cause, so
        # point at the nearest names rather than leaving a dead end.
        # Compare against whole names and their dash-separated parts, so a typo
        # in a short fragment ("fake breast slidr") still finds its file.
        keys: dict[str, str] = {}
        for name in names:
            stem = os.path.splitext(os.path.basename(name))[0]
            keys.setdefault(stem, stem)
            for part in stem.split(" - "):
                keys.setdefault(part.strip(), stem)
        close = difflib.get_close_matches(query.strip(), list(keys), n=5, cutoff=0.7)
        suggestions: list[str] = []
        for key in close:
            full = keys[key]
            if full not in suggestions:
                suggestions.append(full)
        if suggestions:
            message += " Did you mean: " + "; ".join(suggestions[:3]) + "?"

    if strict:
        raise LoraTagError(message)
    logger.warning("%s", message)
    return None


# Everything from // to the end of the line is a note to yourself.
_COMMENT_RE = re.compile(r"//[^\n]*")
# Tidy-ups applied after removing tags and comments, in order.
_TIDY = (
    (re.compile(r"[ \t]+"), " "),  # runs of spaces
    (re.compile(r"\s+([,.;:!?])"), r"\1"),  # space stranded before punctuation
    (re.compile(r"(,\s*){2,}"), ", "),  # commas left adjacent by a removal
    (re.compile(r"\n{3,}"), "\n\n"),  # more than one blank line
    (re.compile(r"^[\s,]+|[\s,]+$"), ""),  # leading and trailing debris
)


def strip_comments(text: Optional[str]) -> str:
    """Remove // notes. They are for the person writing the prompt, not the model."""
    if not isinstance(text, str):
        return ""
    return _COMMENT_RE.sub("", text)


def strip_lora_tags(text: Optional[str]) -> str:
    """Remove <lora:...> tags, leaving the prompt that should be encoded."""
    if not isinstance(text, str):
        return ""
    return _LORA_TAG_RE.sub("", text)


def clean_prompt(text: Optional[str]) -> str:
    """The prompt as the encoder should see it: no tags, no notes, no debris.

    Removing a tag from the middle of a sentence leaves gaps behind it - a space
    before a comma, or two commas in a row - so the text is tidied afterwards.
    """
    if not isinstance(text, str):
        return ""
    cleaned = strip_lora_tags(strip_comments(text))
    # A line holding only a note, or only a tag, should not survive as a blank.
    lines = [line.strip() for line in cleaned.splitlines()]
    cleaned = "\n".join(line for line in lines if line)
    for pattern, replacement in _TIDY:
        cleaned = pattern.sub(replacement, cleaned)
    return cleaned.strip()


class WarpLoraPrompt:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "apply"
    DESCRIPTION = "Write the prompt and its LoRAs in one place, A1111 style"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "placeholder": "a portrait, dramatic lighting <lora:detail tweaker:0.8>",
                        "tooltip": (
                            "The prompt. LoRAs go inline as <lora:name:weight>, and "
                            "anything after // is a note that is not sent."
                        ),
                    },
                ),
                "insert_trigger_words": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "add trigger words",
                        "label_off": "prompt as written",
                    },
                ),
                # Many architectures ship model-only LoRAs, where patching CLIP
                # does nothing; SDXL-era ones usually carry text-encoder weights.
                "apply_to_clip": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "model + CLIP",
                        "label_off": "model only",
                    },
                ),
            },
            "optional": {
                # Written by the node's interface rather than by hand: keeping
                # the LoRA list out of the prompt means the prompt stays prose.
                # Tags typed directly into the prompt still work.
                "loras": ("STRING", {"default": "", "multiline": False}),
                "model": ("MODEL", {}),
                "clip": ("CLIP", {}),
                "warp": ("WARPPIPE", {}),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING", "WARPPIPE")
    RETURN_NAMES = ("model", "clip", "prompt", "warp")

    def __init__(self):
        self._warp_id = uuid.uuid4().hex

    @classmethod
    def IS_CHANGED(cls, **kwargs) -> str:
        return _fingerprint_inputs(kwargs)

    def plan(
        self, text: str, strict: bool = False, loras: str = ""
    ) -> tuple[list[dict[str, Any]], list[str]]:
        """Work out which LoRAs a prompt asks for, without loading anything.

        Returns the resolved LoRAs and any trigger words they declare, so the
        parsing can be tested without a ComfyUI runtime.
        """
        candidates = available_loras()
        resolved: list[dict[str, Any]] = []
        trigger_words: list[str] = []
        seen: set[str] = set()

        # The list the interface maintains, then any tags typed into the prompt.
        wanted = extract_lora_tags(loras) + extract_lora_tags(text)
        for query, weight in wanted:
            if query.lower() in seen:
                continue
            seen.add(query.lower())
            name = resolve_lora_name(query, candidates, strict=strict)
            if name is None:
                continue
            path = _resolve_model_path("loras", name)
            resolved.append(
                {
                    "query": query,
                    "name": name,
                    "path": path,
                    "weight": weight,
                    "display": _lora_display_name(name),
                    "hash": model_autov2(path),
                }
            )
            for word in civitai_trigger_words(path):
                if word not in trigger_words:
                    trigger_words.append(word)

        return resolved, trigger_words

    def apply(
        self,
        text: str = "",
        insert_trigger_words: bool = False,
        apply_to_clip: bool = True,
        loras: str = "",
        model: Optional[Any] = None,
        clip: Optional[Any] = None,
        warp: Optional[dict[str, Any]] = None,
    ) -> tuple:
        # A tag that cannot be resolved fails the run: generating without a
        # LoRA the prompt asked for produces a wrong image and wrong metadata.
        resolved, trigger_words = self.plan(
            strip_comments(text), strict=True, loras=strip_comments(loras)
        )

        prompt = clean_prompt(text)
        if insert_trigger_words and trigger_words:
            missing = [w for w in trigger_words if w.lower() not in prompt.lower()]
            if missing:
                prompt = ", ".join([prompt, *missing]) if prompt else ", ".join(missing)

        for entry in resolved:
            if entry["path"] is None:
                continue
            if model is None and clip is None:
                break
            try:
                import comfy.sd
                import comfy.utils

                lora, metadata = comfy.utils.load_torch_file(
                    entry["path"], safe_load=True, return_metadata=True
                )
                # Passing clip=None patches the model alone and returns None for
                # the clip, so the untouched one is kept.
                patched_model, patched_clip = comfy.sd.load_lora_for_models(
                    model,
                    clip if apply_to_clip else None,
                    lora,
                    entry["weight"],
                    entry["weight"] if apply_to_clip else 0.0,
                    lora_metadata=metadata,
                )
                model = patched_model
                if patched_clip is not None:
                    clip = patched_clip
            except Exception as exc:
                logger.warning("Could not apply LoRA %s: %s", entry["name"], exc)

        # Carry the resolved LoRAs in the warp so the save node does not have to
        # rediscover them from the graph.
        if isinstance(warp, dict) and "id" in warp:
            with _storage_lock:
                data = warp_storage.get(warp["id"], {}).copy()
        else:
            data = {}

        data["loras"] = [
            {"name": entry["display"], "weight": entry["weight"], "hash": entry["hash"]}
            for entry in resolved
        ]
        data["prompt_positive"] = prompt
        if model is not None:
            data["model_1"] = model
        if clip is not None:
            data["clip"] = clip

        with _storage_lock:
            now = time.time()
            warp_storage[self._warp_id] = data
            _storage_timestamps[self._warp_id] = now
            _cleanup_warp_storage_locked(now)

        return (model, clip, prompt, {"id": self._warp_id})


# ComfyUI's server expands %year%, %month% and friends, but the %date:FORMAT%
# form is substituted by its frontend, so it never reaches a prompt sent over the
# API. Expanding it here means the same prefix behaves the same either way.
_DATE_TOKEN_RE = re.compile(r"%date:([^%]*)%")

# .NET-style field letters, as used by A1111 and ComfyUI. Case matters: MM is the
# month, mm the minute.
_DATE_FIELDS = {
    "yyyy": lambda t: f"{t.tm_year:04d}",
    "yy": lambda t: f"{t.tm_year % 100:02d}",
    "MM": lambda t: f"{t.tm_mon:02d}",
    "dd": lambda t: f"{t.tm_mday:02d}",
    "hh": lambda t: f"{t.tm_hour:02d}",
    "mm": lambda t: f"{t.tm_min:02d}",
    "ss": lambda t: f"{t.tm_sec:02d}",
}

# Longest first, so yyyy is not consumed as two yy.
_DATE_FIELD_RE = re.compile("|".join(sorted(_DATE_FIELDS, key=len, reverse=True)))

# Illegal in a Windows filename. Slashes are left alone: ComfyUI reads them as
# subfolders, so %date:yyyy/MM% usefully files output by month.
_ILLEGAL_IN_FILENAME = str.maketrans({c: "-" for c in '<>:"|?*'})


def format_date_pattern(pattern: str, now: Optional[time.struct_time] = None) -> str:
    """Render one %date:...% body, e.g. "yy-MM-dd hh-mm-ss" -> "26-08-28 17-28-56"."""
    stamp = now or time.localtime()
    rendered = _DATE_FIELD_RE.sub(lambda m: _DATE_FIELDS[m.group(0)](stamp), pattern)
    return rendered.translate(_ILLEGAL_IN_FILENAME)


def expand_filename_prefix(prefix: str, now: Optional[time.struct_time] = None) -> str:
    """Expand every %date:FORMAT% in a filename prefix."""
    if not prefix or "%date:" not in prefix:
        return prefix
    stamp = now or time.localtime()
    return _DATE_TOKEN_RE.sub(lambda m: format_date_pattern(m.group(1), stamp), prefix)


# ---------------------------------------------------------------------------
# LoRA library index and thumbnails
#
# Preview images sit next to the model files and are full generations: in the
# collection this was built against, 624 of them totalling about a gigabyte, a
# median of 1.27 MB each. A browser cannot load those, so they are cached down
# to small WebP thumbnails on first request - measured at 20 ms and 8 KB each.
# ---------------------------------------------------------------------------

THUMBNAIL_SIZE = 320
THUMBNAIL_QUALITY = 80

PREVIEW_EXTENSIONS = (
    ".preview.png",
    ".preview.jpg",
    ".preview.jpeg",
    ".preview.webp",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
)

# "creator - name - version (base).safetensors" is the convention this indexes.
# Anything that does not match keeps its whole stem as the name.
_BASE_TAIL_RE = re.compile(r"\s*\(([^()]+)\)\s*$")
_VERSION_RE = re.compile(r"^(v[\d.]+\S*|beta|alpha|final|nano|slim|low|high|full|exp)\b", re.I)


def parse_lora_filename(name: str) -> dict[str, Optional[str]]:
    """Split a LoRA filename into the parts worth showing separately."""
    folder = ""
    normalised = name.replace("\\", "/")
    if "/" in normalised:
        folder = normalised.rsplit("/", 1)[0].split("/")[0]

    stem = os.path.splitext(os.path.basename(normalised))[0]

    tail = None
    match = _BASE_TAIL_RE.search(stem)
    if match:
        tail = match.group(1).strip()
        stem = stem[: match.start()].strip()

    parts = [part.strip() for part in stem.split(" - ") if part.strip()]
    creator = version = None
    if len(parts) >= 2:
        creator = parts[0]
        parts = parts[1:]
    if len(parts) >= 2 and _VERSION_RE.match(parts[-1]):
        version = parts[-1]
        parts = parts[:-1]

    return {
        "folder": folder,
        "creator": creator,
        "name": " - ".join(parts) if parts else stem,
        "version": version,
        "tagged_base": tail,
    }


def normalise_base_model(value: Optional[str]) -> Optional[str]:
    """Tidy Civitai's base-model spellings without merging distinct ones.

    The same base is written several ways ("Flux.2 Klein 9B" and
    "Flux.2 Klein 9B-base"), but neighbouring names are genuinely different
    models, so only trivial variants are folded together - never whole families.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    cleaned = re.sub(r"\s+", " ", value.strip())
    cleaned = re.sub(r"[-\s]*base$", "", cleaned, flags=re.I)
    return cleaned or None


def base_model_of(file_path: Optional[str]) -> Optional[str]:
    """The base model a file declares in its sidecar, if it has one."""
    payload = read_civitai_sidecar(file_path) if file_path else None
    return normalise_base_model(_sidecar_base_model(payload))


def find_model_path(name: str) -> Optional[str]:
    """Locate a model by name across the folders different loaders use."""
    for folder in ("loras", "checkpoints", "diffusion_models", "unet", "embeddings"):
        path = _resolve_model_path(folder, name)
        if path:
            return path
    return None


def lora_preview_path(model_path: Optional[str]) -> Optional[str]:
    """The preview image sitting beside a model file, if there is one."""
    if not model_path:
        return None
    base = os.path.splitext(model_path)[0]
    for extension in PREVIEW_EXTENSIONS:
        candidate = base + extension
        if os.path.isfile(candidate):
            return candidate
    return None


def _sidecar_base_model(payload: Optional[dict[str, Any]]) -> Optional[str]:
    if not payload:
        return None
    value = payload.get("baseModel")
    return value if isinstance(value, str) and value else None


def _thumbnail_dir() -> Optional[str]:
    cache = _hash_cache_path()
    if not cache:
        return None
    directory = os.path.join(os.path.dirname(cache), "warppipe_thumbs")
    try:
        os.makedirs(directory, exist_ok=True)
    except OSError:
        return None
    return directory


def thumbnail_for(preview_path: str) -> Optional[str]:
    """Path to a cached thumbnail, building it on first request.

    Keyed by path, size and mtime, so replacing a preview refreshes it.
    """
    key = _cache_key(preview_path)
    if key is None:
        return None

    directory = _thumbnail_dir()
    if directory is None:
        return None

    cached = os.path.join(directory, hashlib.sha256(key.encode()).hexdigest()[:32] + ".webp")
    if os.path.isfile(cached):
        return cached

    try:
        from PIL import Image
    except ImportError:
        return None

    try:
        with Image.open(preview_path) as image:
            image.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE))
            image.convert("RGB").save(cached, "WEBP", quality=THUMBNAIL_QUALITY)
    except Exception as exc:
        logger.warning("Could not thumbnail %s: %s", preview_path, exc)
        return None
    return cached


def available_models(folder_key: str) -> list[str]:
    try:
        import folder_paths

        return list(folder_paths.get_filename_list(folder_key))
    except Exception:
        return []


def embedding_index() -> list[dict[str, Any]]:
    """Embeddings, in the same shape as the LoRA index.

    An embedding is used by writing embedding:name in the prompt, so "insert"
    means something different, but everything the browser shows is the same.
    """
    return model_index("embeddings")


def lora_index() -> list[dict[str, Any]]:
    return model_index("loras")


def model_index(folder_key: str = "loras") -> list[dict[str, Any]]:
    """Everything the browser needs to list a library, without any image data."""
    entries: list[dict[str, Any]] = []
    for name in available_models(folder_key):
        path = _resolve_model_path(folder_key, name)
        payload = read_civitai_sidecar(path) if path else None
        parsed = parse_lora_filename(name)
        has_preview = lora_preview_path(path) is not None
        entries.append(
            {
                # The exact string a tag must contain.
                "id": name,
                "folder": parsed["folder"],
                "creator": parsed["creator"],
                "name": parsed["name"],
                "version": parsed["version"],
                # What the filename claims, and what Civitai recorded.
                "tagged_base": parsed["tagged_base"],
                "base_model": normalise_base_model(_sidecar_base_model(payload)),
                # True when the filename actually followed a
                # "creator - name - version" shape. Anything else keeps its
                # whole stem as the name, and callers should not pretend
                # otherwise.
                "structured": parsed["creator"] is not None,
                "triggers": civitai_trigger_words(path) if path else [],
                "has_preview": has_preview,
                # The server owns URL construction; the client just uses it.
                "kind": folder_key,
                "thumbnail": (
                    "/warppipe/lora/thumbnail?name="
                    + urllib.parse.quote(name)
                    + "&kind="
                    + urllib.parse.quote(folder_key)
                    if has_preview
                    else None
                ),
            }
        )
    return entries


def _register_routes() -> None:
    """Expose the index and thumbnails to the frontend, when running in ComfyUI."""
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return

    instance = getattr(PromptServer, "instance", None)
    routes = getattr(instance, "routes", None)
    if routes is None:
        return

    @routes.get("/warppipe/loras")
    async def _loras(request):
        return web.json_response({"loras": lora_index()})

    @routes.get("/warppipe/embeddings")
    async def _embeddings(request):
        return web.json_response({"embeddings": embedding_index()})

    @routes.get("/warppipe/model/base")
    async def _model_base(request):
        """The base model of an arbitrary model file, for matching LoRAs to it."""
        name = request.query.get("name", "")
        path = find_model_path(name)
        return web.json_response(
            {"name": name, "base_model": base_model_of(path), "found": bool(path)}
        )

    @routes.get("/warppipe/lora/thumbnail")
    async def _thumbnail(request):
        name = request.query.get("name", "")
        kind = request.query.get("kind", "loras")
        if kind not in {"loras", "embeddings"}:
            return web.Response(status=400, text="unknown kind")
        # Resolving through folder_paths is what keeps this to configured
        # model folders; an arbitrary path can never be requested.
        path = _resolve_model_path(kind, name)
        preview = lora_preview_path(path)
        if not preview:
            return web.Response(status=404, text="no preview")

        cached = thumbnail_for(preview)
        if not cached:
            return web.Response(status=404, text="no thumbnail")
        return web.FileResponse(cached, headers={"Cache-Control": "max-age=86400"})

    logger.info("WarpPipe LoRA library routes registered")


try:
    _register_routes()
except Exception as exc:
    logger.warning("Could not register WarpPipe library routes: %s", exc)


class SaveImageCivitai:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    DESCRIPTION = "Save images with Civitai-readable generation metadata"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "filename_prefix": (
                    "STRING",
                    {
                        "default": "WarpPipe",
                        "tooltip": (
                            "Supports %date:yy-MM-dd hh-mm-ss% and ComfyUI's own "
                            "%width%/%height%. A slash makes a subfolder."
                        ),
                    },
                ),
                "embed_workflow": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "workflow embedded",
                        "label_off": "metadata only",
                    },
                ),
            },
            "optional": {
                # Optional so that bypassing an upstream branch leaves this node
                # idle instead of failing the whole prompt with a missing input.
                "images": ("IMAGE", {}),
                "warp": ("WARPPIPE", {}),
                # Detected from the graph; this only overrides that.
                "model_name_override": ("STRING", {"default": "", "multiline": False}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    def _warp_values(self, warp: Optional[dict[str, Any]]) -> dict[str, Any]:
        if not isinstance(warp, dict) or "id" not in warp:
            return {}
        with _storage_lock:
            stored = warp_storage.get(warp["id"])
        return dict(stored) if isinstance(stored, dict) else {}

    def build_metadata(
        self,
        warp: Optional[dict[str, Any]] = None,
        prompt: Optional[dict[str, Any]] = None,
        model_name: str = "",
        width: Optional[int] = None,
        height: Optional[int] = None,
        unique_id: Optional[str] = None,
    ) -> str:
        """Resolve every resource and return the parameters block.

        Kept separate from saving so it can be exercised without an image or a
        filesystem.
        """
        values = self._warp_values(warp)
        graph_model, graph_loras = collect_graph_resources(prompt, start_id=unique_id)

        positive = values.get("prompt_positive") or ""
        negative = values.get("prompt_negative") or ""

        # A Prompt + LoRAs node records exactly what it applied, which beats
        # rediscovering it from the graph. Fall back to the graph otherwise.
        recorded = values.get("loras")
        if isinstance(recorded, list) and recorded:
            loras = [
                (str(entry.get("name")), _as_float(entry.get("weight")), entry.get("hash"))
                for entry in recorded
                if isinstance(entry, dict) and entry.get("name")
            ]
        else:
            tagged = extract_lora_tags(positive)
            combined = list(graph_loras)
            known = {name.lower() for name, _ in combined}
            combined.extend((n, w) for n, w in tagged if n.lower() not in known)

            loras = []
            candidates = available_loras()
            for name, weight in combined:
                # A tag may hold a fragment rather than a full filename.
                resolved = resolve_lora_name(name, candidates) or name
                path = _resolve_model_path("loras", resolved)
                loras.append((_lora_display_name(resolved), weight, model_autov2(path)))

        checkpoint = model_name.strip() or graph_model
        checkpoint_hash = model_autov2(resolve_model_file(checkpoint))

        return build_civitai_parameters(
            positive=positive,
            negative=negative,
            steps=values.get("steps_1"),
            sampler_name=values.get("sampler_name"),
            scheduler=values.get("scheduler"),
            cfg=values.get("cfg"),
            seed=values.get("seed"),
            width=width or values.get("width"),
            height=height or values.get("height"),
            model_name=checkpoint,
            model_hash=checkpoint_hash,
            loras=loras,
        )

    def save_images(
        self,
        images=None,
        filename_prefix: str = "WarpPipe",
        embed_workflow: bool = True,
        warp: Optional[dict[str, Any]] = None,
        model_name_override: str = "",
        prompt: Optional[dict[str, Any]] = None,
        extra_pnginfo: Optional[dict[str, Any]] = None,
        unique_id: Optional[str] = None,
    ) -> dict[str, Any]:
        if images is None or len(images) == 0:
            logger.info("Save Image (Civitai): no images connected, nothing to save.")
            return {"ui": {"images": []}}

        import folder_paths
        import numpy as np
        from PIL import Image, PngImagePlugin

        height = int(images[0].shape[0])
        width = int(images[0].shape[1])
        parameters = self.build_metadata(
            warp=warp,
            prompt=prompt,
            model_name=model_name_override,
            width=width,
            height=height,
            unique_id=unique_id,
        )
        logger.debug("Civitai parameters: %s", parameters)

        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            expand_filename_prefix(filename_prefix),
            folder_paths.get_output_directory(),
            width,
            height,
        )

        results = []
        for image in images:
            array = np.clip(255.0 * image.cpu().numpy(), 0, 255).astype(np.uint8)
            png_info = PngImagePlugin.PngInfo()
            png_info.add_text("parameters", parameters)
            if embed_workflow:
                if prompt is not None:
                    png_info.add_text("prompt", json.dumps(prompt))
                for key, value in (extra_pnginfo or {}).items():
                    png_info.add_text(key, json.dumps(value))

            file_name = f"{filename}_{counter:05}_.png"
            Image.fromarray(array).save(
                os.path.join(full_output_folder, file_name),
                pnginfo=png_info,
                compress_level=4,
            )
            results.append({"filename": file_name, "subfolder": subfolder, "type": "output"})
            counter += 1

        return {"ui": {"images": results}}


if ENABLE_V3_NODES:
    WARPPIPE_TYPE = io.Custom("WARPPIPE")
    ANY_TYPE = getattr(io, "AnyType", io.Custom("*"))

    def _io_type(name: str):
        aliases = {
            "IMAGE": ("Image",),
            "MASK": ("Mask",),
            "LATENT": ("Latent",),
            "CONDITIONING": ("Conditioning",),
            "MODEL": ("Model",),
            "CLIP": ("Clip", "CLIP"),
            "CLIP_VISION": ("ClipVision",),
            "VAE": ("Vae", "VAE"),
        }
        for attr in aliases.get(name, ()):
            if hasattr(io, attr):
                return getattr(io, attr)
        return io.Custom(name)

    def _combo_input(input_id: str, options: list[str], **kwargs):
        try:
            return io.Combo.Input(input_id, options=options, **kwargs)
        except TypeError:
            kwargs.pop("force_input", None)
            return io.Combo.Input(input_id, options=options, **kwargs)

    def _combo_output(output_id: str, options: list[str], display_name: str):
        return io.Combo.Output(output_id, display_name=display_name, options=options)

    class WarpV3(io.ComfyNode):
        @classmethod
        def define_schema(cls) -> io.Schema:
            return io.Schema(
                node_id="Warp",
                display_name="🌀 Warp",
                category=Warp.CATEGORY,
                description=Warp.DESCRIPTION,
                hidden=[io.Hidden.unique_id],
                inputs=[
                    WARPPIPE_TYPE.Input("warp", optional=True),
                    io.String.Input("prompt_positive", optional=True, force_input=True),
                    io.String.Input("prompt_negative", optional=True, force_input=True),
                    _io_type("CONDITIONING").Input("conditioning_positive", optional=True),
                    _io_type("CONDITIONING").Input("conditioning_negative", optional=True),
                    _io_type("IMAGE").Input("image", optional=True),
                    _io_type("MASK").Input("mask", optional=True),
                    _io_type("MODEL").Input("model_1", optional=True),
                    _io_type("MODEL").Input("model_2", optional=True),
                    _io_type("CLIP").Input("clip", optional=True),
                    _io_type("CLIP_VISION").Input("clip_vision", optional=True),
                    _io_type("VAE").Input("vae", optional=True),
                    _io_type("LATENT").Input("latent", optional=True),
                    io.Int.Input("batch_size", optional=True, force_input=True),
                    io.Int.Input("seed", optional=True, force_input=True),
                    io.Int.Input("steps_1", optional=True, force_input=True),
                    io.Int.Input("steps_2", optional=True, force_input=True),
                    io.Int.Input("steps_3", optional=True, force_input=True),
                    io.Float.Input("cfg", optional=True, force_input=True),
                    _combo_input("sampler_name", SAFE_SAMPLERS, optional=True, force_input=True),
                    _combo_input("scheduler", SAFE_SCHEDULERS, optional=True, force_input=True),
                    io.Int.Input("width", optional=True, force_input=True),
                    io.Int.Input("height", optional=True, force_input=True),
                ],
                outputs=[
                    WARPPIPE_TYPE.Output("warp_out", display_name="warp"),
                ],
                not_idempotent=True,
            )

        @classmethod
        def fingerprint_inputs(cls, **kwargs):
            return _fingerprint_inputs(kwargs)

        @classmethod
        def validate_inputs(cls, input_types=None):
            return Warp.VALIDATE_INPUTS(input_types)

        @classmethod
        def execute(cls, **kwargs) -> io.NodeOutput:
            node = Warp()
            node._warp_id = _get_v3_node_id(cls, "v3-warp")
            return io.NodeOutput(*node.warp(**kwargs))

    class UnwarpV3(io.ComfyNode):
        @classmethod
        def define_schema(cls) -> io.Schema:
            return io.Schema(
                node_id="Unwarp",
                display_name="🌀 Unwarp",
                category=Unwarp.CATEGORY,
                description=Unwarp.DESCRIPTION,
                inputs=[
                    WARPPIPE_TYPE.Input("warp", optional=True),
                ],
                outputs=[
                    _io_type("MODEL").Output("model_1", display_name="model_1"),
                    _io_type("MODEL").Output("model_2", display_name="model_2"),
                    _io_type("IMAGE").Output("image", display_name="image"),
                    _io_type("MASK").Output("mask", display_name="mask"),
                    _io_type("CLIP").Output("clip", display_name="clip"),
                    _io_type("CLIP_VISION").Output("clip_vision", display_name="clip_vision"),
                    _io_type("VAE").Output("vae", display_name="vae"),
                    _io_type("CONDITIONING").Output(
                        "conditioning_positive", display_name="conditioning_positive"
                    ),
                    _io_type("CONDITIONING").Output(
                        "conditioning_negative", display_name="conditioning_negative"
                    ),
                    _io_type("LATENT").Output("latent", display_name="latent"),
                    io.String.Output("prompt_positive", display_name="prompt_positive"),
                    io.String.Output("prompt_negative", display_name="prompt_negative"),
                    io.Int.Output("batch_size", display_name="batch_size"),
                    io.Int.Output("seed", display_name="seed"),
                    io.Int.Output("steps_1", display_name="steps_1"),
                    io.Int.Output("steps_2", display_name="steps_2"),
                    io.Int.Output("steps_3", display_name="steps_3"),
                    io.Float.Output("cfg", display_name="cfg"),
                    _combo_output("sampler_name", SAFE_SAMPLERS, "sampler_name"),
                    _combo_output("scheduler", SAFE_SCHEDULERS, "scheduler"),
                    io.Int.Output("width", display_name="width"),
                    io.Int.Output("height", display_name="height"),
                ],
            )

        @classmethod
        def execute(cls, warp: Optional[dict[str, Any]] = None) -> io.NodeOutput:
            return io.NodeOutput(*Unwarp().unwarp(warp))

    class WarpProviderV3(io.ComfyNode):
        @classmethod
        def define_schema(cls) -> io.Schema:
            size_presets = list(WarpProvider.INPUT_TYPES()["optional"]["size_preset"][0])
            return io.Schema(
                node_id="Warp Provider",
                display_name="🌀 Warp Provider",
                category=WarpProvider.CATEGORY,
                description=WarpProvider.DESCRIPTION,
                inputs=[
                    io.Int.Input("batch_size", default=1, min=1, max=64),
                    io.Int.Input("seed", default=0, min=0, max=0xFFFFFFFFFFFFFFFF),
                    io.Int.Input("steps_1", default=20, min=1, max=200),
                    io.Int.Input("steps_2", default=0, min=0, max=200),
                    io.Int.Input("steps_3", default=0, min=0, max=200),
                    io.Float.Input("cfg", default=7.0, min=0.0, max=50.0),
                    _combo_input(
                        "sampler_name", list(comfy.samplers.KSampler.SAMPLERS), default="euler"
                    ),
                    _combo_input(
                        "scheduler", list(comfy.samplers.KSampler.SCHEDULERS), default="normal"
                    ),
                    _combo_input(
                        "size_preset",
                        size_presets,
                        default="Square (SDXL native)        |  1:1   |  1024 ×  1024  |  1.05 MP",
                    ),
                    io.Int.Input("custom_width", default=1024, min=64, max=8192, step=8),
                    io.Int.Input("custom_height", default=1024, min=64, max=8192, step=8),
                ],
                outputs=[
                    _io_type("LATENT").Output("latent", display_name="latent"),
                    io.Int.Output("batch_size_out", display_name="batch_size"),
                    io.Int.Output("seed_out", display_name="seed"),
                    io.Int.Output("steps_1_out", display_name="steps_1"),
                    io.Int.Output("steps_2_out", display_name="steps_2"),
                    io.Int.Output("steps_3_out", display_name="steps_3"),
                    io.Float.Output("cfg_out", display_name="cfg"),
                    _combo_output("sampler_name_out", SAFE_SAMPLERS, "sampler_name"),
                    _combo_output("scheduler_out", SAFE_SCHEDULERS, "scheduler"),
                    io.Int.Output("width", display_name="width"),
                    io.Int.Output("height", display_name="height"),
                ],
            )

        @classmethod
        def execute(
            cls,
            batch_size: int = 1,
            seed: int = 0,
            steps_1: int = 20,
            steps_2: int = 0,
            steps_3: int = 0,
            cfg: float = 7.0,
            sampler_name: str = "euler",
            scheduler: str = "normal",
            size_preset: str = "Square (SDXL native)        |  1:1   |  1024 ×  1024  |  1.05 MP",
            custom_width: int = 1024,
            custom_height: int = 1024,
        ) -> io.NodeOutput:
            return io.NodeOutput(
                *WarpProvider().provide(
                    batch_size,
                    seed,
                    steps_1,
                    steps_2,
                    steps_3,
                    cfg,
                    sampler_name,
                    scheduler,
                    size_preset,
                    custom_width,
                    custom_height,
                )
            )

    class FDSchedulerAdapterV3(io.ComfyNode):
        @classmethod
        def define_schema(cls) -> io.Schema:
            return io.Schema(
                node_id="FD Scheduler Adapter",
                display_name="🌀 Scheduler Adapter for FaceDetailer",
                category=FDSchedulerAdapter.CATEGORY,
                description=FDSchedulerAdapter.DESCRIPTION,
                inputs=[
                    _combo_input("scheduler", SAFE_SCHEDULERS),
                ],
                outputs=[
                    _combo_output("scheduler_out", FD_SCHEDULERS, "scheduler"),
                ],
            )

        @classmethod
        def execute(cls, scheduler: str) -> io.NodeOutput:
            return io.NodeOutput(*FDSchedulerAdapter().adapt(scheduler))

    class DeadEndV3(io.ComfyNode):
        @classmethod
        def define_schema(cls) -> io.Schema:
            return io.Schema(
                node_id="Dead End",
                display_name="🚫 Dead End",
                category=DeadEnd.CATEGORY,
                description=DeadEnd.DESCRIPTION,
                inputs=[
                    ANY_TYPE.Input("input", optional=True),
                ],
                outputs=[],
            )

        @classmethod
        def validate_inputs(cls, input_types=None):
            return True

        @classmethod
        def execute(cls, input=None) -> io.NodeOutput:
            return io.NodeOutput()

    class WarpPipeExtension(ComfyExtension):
        async def get_node_list(self) -> list[type[io.ComfyNode]]:
            return [
                WarpV3,
                UnwarpV3,
                WarpProviderV3,
                FDSchedulerAdapterV3,
                DeadEndV3,
            ]

    async def comfy_entrypoint() -> WarpPipeExtension:
        return WarpPipeExtension()


# Legacy mappings remain the default registration path. In V3 mode ComfyUI loads
# the same node IDs exclusively through comfy_entrypoint().
if not ENABLE_V3_NODES:
    NODE_CLASS_MAPPINGS = {
        "Warp": Warp,
        "Unwarp": Unwarp,
        "Warp Provider": WarpProvider,
        "FD Scheduler Adapter": FDSchedulerAdapter,
        "Dead End": DeadEnd,
        "Save Image Civitai": SaveImageCivitai,
        "Warp Lora Prompt": WarpLoraPrompt,
    }

    NODE_DISPLAY_NAME_MAPPINGS = {
        "Warp": "🌀 Warp",
        "Unwarp": "🌀 Unwarp",
        "Warp Provider": "🌀 Warp Provider",
        "FD Scheduler Adapter": "🌀 Scheduler Adapter for FaceDetailer",
        "Dead End": "🚫 Dead End",
        "Save Image Civitai": "🌀 Save Image (Civitai)",
        "Warp Lora Prompt": "🌀 Prompt + LoRAs",
    }

# Optional: Web directory for custom UI files (if you add them later)
WEB_DIRECTORY = "./web"

if ENABLE_V3_NODES:
    __all__ = ["WEB_DIRECTORY", "comfy_entrypoint"]
else:
    __all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
