import hashlib
import logging
import uuid
import threading
from typing import Dict, Any, Optional
import sys
import os

logger = logging.getLogger("WarpPipe")

# Add ComfyUI root to sys.path if needed
current_dir = os.path.dirname(os.path.abspath(__file__))
comfy_root = os.path.dirname(os.path.dirname(os.path.dirname(current_dir)))
if comfy_root not in sys.path:
    sys.path.append(comfy_root)

try:
    import comfy.samplers
except ImportError:
    # Try importing from nodes (sometimes comfy is not directly exposed but nodes is)
    try:
        from nodes import comfy
    except ImportError as e:
        logger.warning("Failed to import comfy.samplers: %s", e)
        # Fallback for development/testing environments
        class MockKSampler:
            SAMPLERS = ["euler", "euler_ancestral", "heun", "dpm_2", "dpm_2_ancestral", "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral", "dpmpp_sde", "dpmpp_2m"]
            SCHEDULERS = ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform"]
        
        class MockSamplers:
            KSampler = MockKSampler
            SCHEDULER_NAMES = MockKSampler.SCHEDULERS.copy()
            SCHEDULER_HANDLERS = {name: None for name in MockKSampler.SCHEDULERS}
        
        class MockComfy:
            samplers = MockSamplers
        
        comfy = MockComfy()

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

# Safe scheduler/sampler lists for compatibility (pulled dynamically from Comfy)
try:
    SAFE_SAMPLERS = getattr(comfy.samplers.KSampler, "SAMPLERS", [])
except Exception:
    SAFE_SAMPLERS = []

# Patch for RES4LYF compatibility - GLOBAL REGISTRATION
# We must register beta57 and bong_tangent in the global comfy.samplers lists so *other* nodes (like FaceDetailer)
# pick them up as valid scheduler options, even if RES4LYF hasn't loaded yet.
for scheduler_name in ["beta57", "bong_tangent"]:
    if scheduler_name not in comfy.samplers.SCHEDULER_NAMES:
        comfy.samplers.SCHEDULER_NAMES.append(scheduler_name)

    # Ensure there is a handler for it (map to karras if missing to prevent crashes)
    if scheduler_name not in comfy.samplers.SCHEDULER_HANDLERS:
        comfy.samplers.SCHEDULER_HANDLERS[scheduler_name] = comfy.samplers.SCHEDULER_HANDLERS.get("karras")

try:
    SAFE_SCHEDULERS = getattr(comfy.samplers.KSampler, "SCHEDULERS", [])
except Exception:
    SAFE_SCHEDULERS = []

# Update SAFE_SCHEDULERS to include beta57/bong_tangent if KSampler doesn't have it yet
for scheduler_name in ["beta57", "bong_tangent"]:
    if scheduler_name not in SAFE_SCHEDULERS:
        SAFE_SCHEDULERS.append(scheduler_name)

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
FD_SCHEDULERS = list(comfy.samplers.SCHEDULER_HANDLERS) + IMPACT_PACK_SCHEDULERS

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

def _split_type_options(value: Any) -> Optional[set[str]]:
    if isinstance(value, str):
        parts = [part.strip() for part in value.split(",")]
    elif isinstance(value, (list, tuple, set)):
        parts = [str(part).strip() for part in value]
    else:
        return None

    options = {part for part in parts if part}
    return options or None

def _is_combo_marker(value: Any) -> bool:
    return value == "COMBO"

def _install_combo_union_validation_patch() -> None:
    """
    Allow enum unions like "euler,heun,..." to connect to combo/list inputs.

    Some V3 and frontend-generated nodes expose combo outputs as comma-joined
    union strings, while Comfy's prompt validator still treats list-backed combo
    inputs separately. The runtime value is still a normal string; this only
    relaxes prompt type validation for equivalent enum socket metadata.
    """
    try:
        import comfy_execution.validation as validation
    except Exception as e:
        logger.debug("Could not patch ComfyUI combo validation: %s", e)
        return

    current = getattr(validation, "validate_node_input", None)
    if current is None:
        return
    original = getattr(current, "_warp_pipe_original", current)

    def validate_node_input(received_type, input_type, strict: bool = False) -> bool:
        if _is_combo_marker(input_type) and isinstance(received_type, str) and "," in received_type:
            return True

        received_options = _split_type_options(received_type)
        input_options = _split_type_options(input_type)
        if received_options and input_options:
            if strict:
                if received_options.issubset(input_options):
                    return True
            elif received_options.intersection(input_options):
                return True

        return original(received_type, input_type, strict)

    validate_node_input._warp_pipe_combo_patch = True
    validate_node_input._warp_pipe_original = original
    validation.validate_node_input = validate_node_input

    patched_modules = ["comfy_execution.validation"]
    for module_name, module in list(sys.modules.items()):
        if module_name == "execution" or module_name.endswith(".execution"):
            if hasattr(module, "validate_node_input"):
                module.validate_node_input = validate_node_input
                patched_modules.append(module_name)

    logger.info(
        "Installed WarpPipe combo enum validation compatibility patch for %s",
        ", ".join(sorted(set(patched_modules))),
    )

_install_combo_union_validation_patch()

# Global storage for warp data; keys are unique per Warp instance
warp_storage: Dict[str, Dict[str, Any]] = {}
_storage_timestamps: Dict[str, float] = {}  # Track last-access time per warp ID
_storage_lock = threading.Lock()
_STORAGE_MAX_AGE_SECONDS = 3600  # Prune entries older than 1 hour
_STORAGE_MAX_ENTRIES = 256       # Hard cap on stored entries

def cleanup_warp_storage():
    """Prune stale warp storage entries to prevent memory leaks."""
    import time
    now = time.time()
    with _storage_lock:
        stale_ids = [
            wid for wid, ts in _storage_timestamps.items()
            if now - ts > _STORAGE_MAX_AGE_SECONDS
        ]
        for wid in stale_ids:
            warp_storage.pop(wid, None)
            _storage_timestamps.pop(wid, None)
        if stale_ids:
            logger.debug("Cleaned up %d stale warp storage entries", len(stale_ids))
        # If still over the hard cap, remove oldest entries
        if len(warp_storage) > _STORAGE_MAX_ENTRIES:
            sorted_ids = sorted(_storage_timestamps, key=_storage_timestamps.get)
            to_remove = sorted_ids[:len(warp_storage) - _STORAGE_MAX_ENTRIES]
            for wid in to_remove:
                warp_storage.pop(wid, None)
                _storage_timestamps.pop(wid, None)
            if to_remove:
                logger.debug("Evicted %d warp storage entries (over cap)", len(to_remove))

def _fingerprint_inputs(kwargs: Dict[str, Any]) -> str:
    h = hashlib.sha256()
    for key in sorted(kwargs.keys()):
        if kwargs[key] is not None:
            h.update(f"{key}:{repr(kwargs[key])}".encode("utf-8"))
    return h.hexdigest()

def _get_v3_node_id(cls, fallback_prefix: str) -> str:
    unique_id = getattr(getattr(cls, "hidden", None), "unique_id", None)
    if unique_id:
        return f"v3:{unique_id}"
    return f"{fallback_prefix}:{uuid.uuid4().hex}"

def _create_empty_latent(width: int, height: int, batch_size: int):
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
    import re
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
    DISPLAY_NAME = "Warp Bundle"
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
    def VALIDATE_INPUTS(cls, input_types=None, **kwargs) -> bool:
        """Accept linked combo enums from nodes that expose wider option lists."""
        return True

    def warp(
        self,
        warp: Optional[Dict[str, Any]] = None,
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
        height: Optional[int] = None
    ) -> tuple:
        # If warp input provided, copy existing data
        if isinstance(warp, dict) and "id" in warp:
            prev_id = warp["id"]
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
            "height": height
        }
        for key, val in updates.items():
            if val is not None:
                data[key] = val

        import time
        # Prune stale entries before storing new data
        cleanup_warp_storage()

        with _storage_lock:
            warp_storage[self._warp_id] = data
            _storage_timestamps[self._warp_id] = time.time()
        
        if latent is not None:
            logger.debug("Warping latent type: %s", type(latent))

        return ({"id": self._warp_id},)

class Unwarp:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "unwarp"
    DISPLAY_NAME = "Unwarp Bundle"
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

    def unwarp(self, warp: Optional[Dict[str, Any]] = None) -> tuple:
        # Handle case where no warp is connected - return all None values
        if warp is None:
            return self._return_empty_values()
        
        # Handle invalid warp data gracefully
        if not isinstance(warp, dict) or "id" not in warp:
            logger.warning("Invalid warp signal received. Returning empty values.")
            return self._return_empty_values()
        
        import time
        warp_id = warp["id"]
        with _storage_lock:
            data = warp_storage.get(warp_id, {})
            if data:
                _storage_timestamps[warp_id] = time.time()  # Refresh on access
        
        # Handle missing warp data gracefully
        if not data:
            logger.warning("Warp data not found for ID: %s. Returning empty values.", warp_id)
            return self._return_empty_values()
        # Get width and height (either calculated from size_preset or direct values)
        width = data.get("width", 1024)
        height = data.get("height", 1024)
        
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
            coerce_sampler(data.get("sampler_name", "euler")),
            coerce_scheduler(data.get("scheduler", "karras")),
            width,
            height,
        )
        
        logger.debug("Unwarp RETURN_TYPES len: %d, return tuple len: %d", len(self.RETURN_TYPES), len(ret))
        
        return ret

class WarpProvider:
    """Parameter and latent provider for warp workflows"""
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "provide"
    DISPLAY_NAME = "Warp Provider"
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
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "steps_1": ("INT", {"default": 20, "min": 1, "max": 200}),
                "steps_2": ("INT", {"default": 0, "min": 0, "max": 200}),
                "steps_3": ("INT", {"default": 0, "min": 0, "max": 200}),
                "cfg": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 50.0}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "normal"}),
                
                # Image Size Parameters
                "size_preset": (size_presets, {"default": "Square (SDXL native)        |  1:1   |  1024 ×  1024  |  1.05 MP"}),
                "custom_width": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "custom_height": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
            }
        }

    RETURN_TYPES = ("LATENT", "INT", "INT", "INT", "INT", "INT", "FLOAT", SAFE_SAMPLERS, SAFE_SCHEDULERS, "INT", "INT")
    RETURN_NAMES = ("latent", "batch_size", "seed", "steps_1", "steps_2", "steps_3", "cfg", "sampler_name", "scheduler", "width", "height")

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
        custom_height: int = 1024
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
            latent,                          # LATENT
            batch_size,                      # INT
            actual_seed,                     # INT
            steps_1,                         # INT
            steps_2,                         # INT
            steps_3,                         # INT
            cfg,                             # FLOAT
            coerce_sampler(sampler_name),    # SAMPLER
            coerce_scheduler(scheduler),     # SCHEDULER
            width,                           # INT
            height                           # INT
        )

# Adapter: KSampler scheduler enum -> FaceDetailer scheduler enum
class FDSchedulerAdapter:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "adapt"
    DISPLAY_NAME = "FD Scheduler Adapter"
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
    def VALIDATE_INPUTS(cls, input_types=None, **kwargs) -> bool:
        return True

    def adapt(self, scheduler: str) -> tuple:
        return (coerce_scheduler_fd(scheduler),)

class DeadEnd:
    """A dead end node that accepts any input type but produces no output"""
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "dead_end"
    DISPLAY_NAME = "Dead End"
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
    def VALIDATE_INPUTS(cls, input_types=None, **kwargs):
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

if ENABLE_V3_NODES:
    WARPPIPE_TYPE = io.Custom("WARPPIPE")
    ANY_TYPE = io.Custom("*")

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

    def _enum_output(output_id: str, options: list[str], display_name: str):
        io_type = ",".join(options) if options else "STRING"
        return io.Custom(io_type).Output(output_id, display_name=display_name)

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
            )

        @classmethod
        def fingerprint_inputs(cls, **kwargs):
            return _fingerprint_inputs(kwargs)

        @classmethod
        def validate_inputs(cls, input_types=None, **kwargs) -> bool:
            return True

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
                    _io_type("CONDITIONING").Output("conditioning_positive", display_name="conditioning_positive"),
                    _io_type("CONDITIONING").Output("conditioning_negative", display_name="conditioning_negative"),
                    _io_type("LATENT").Output("latent", display_name="latent"),
                    io.String.Output("prompt_positive", display_name="prompt_positive"),
                    io.String.Output("prompt_negative", display_name="prompt_negative"),
                    io.Int.Output("batch_size", display_name="batch_size"),
                    io.Int.Output("seed", display_name="seed"),
                    io.Int.Output("steps_1", display_name="steps_1"),
                    io.Int.Output("steps_2", display_name="steps_2"),
                    io.Int.Output("steps_3", display_name="steps_3"),
                    io.Float.Output("cfg", display_name="cfg"),
                    _enum_output("sampler_name", SAFE_SAMPLERS, "sampler_name"),
                    _enum_output("scheduler", SAFE_SCHEDULERS, "scheduler"),
                    io.Int.Output("width", display_name="width"),
                    io.Int.Output("height", display_name="height"),
                ],
            )

        @classmethod
        def execute(cls, warp: Optional[Dict[str, Any]] = None) -> io.NodeOutput:
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
                    io.Int.Input("seed", default=0, min=0, max=0xffffffffffffffff),
                    io.Int.Input("steps_1", default=20, min=1, max=200),
                    io.Int.Input("steps_2", default=0, min=0, max=200),
                    io.Int.Input("steps_3", default=0, min=0, max=200),
                    io.Float.Input("cfg", default=7.0, min=0.0, max=50.0),
                    _combo_input("sampler_name", list(comfy.samplers.KSampler.SAMPLERS), default="euler"),
                    _combo_input("scheduler", list(comfy.samplers.KSampler.SCHEDULERS), default="normal"),
                    _combo_input("size_preset", size_presets, default="Square (SDXL native)        |  1:1   |  1024 ×  1024  |  1.05 MP"),
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
                    _enum_output("sampler_name_out", SAFE_SAMPLERS, "sampler_name"),
                    _enum_output("scheduler_out", SAFE_SCHEDULERS, "scheduler"),
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
            return io.NodeOutput(*WarpProvider().provide(
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
            ))

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
                    _enum_output("scheduler_out", FD_SCHEDULERS, "scheduler"),
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
        def validate_inputs(cls, input_types=None, **kwargs):
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

# Register nodes under capitalized names. V3 nodes are opt-in because ComfyUI's
# current combo-output validation can reject sampler/scheduler links at runtime.
if ENABLE_V3_NODES:
    NODE_CLASS_MAPPINGS = {
        "Warp": WarpV3,
        "Unwarp": UnwarpV3,
        "Warp Provider": WarpProviderV3,
        "FD Scheduler Adapter": FDSchedulerAdapterV3,
        "Dead End": DeadEndV3,
    }
else:
    NODE_CLASS_MAPPINGS = {
        "Warp": Warp,
        "Unwarp": Unwarp,
        "Warp Provider": WarpProvider,
        "FD Scheduler Adapter": FDSchedulerAdapter,
        "Dead End": DeadEnd,
    }

# Optional: Display names for the UI (newer ComfyUI feature)
NODE_DISPLAY_NAME_MAPPINGS = {
    "Warp": "🌀 Warp",
    "Unwarp": "🌀 Unwarp",
    "Warp Provider": "🌀 Warp Provider",
    "FD Scheduler Adapter": "🌀 Scheduler Adapter for FaceDetailer",
    "Dead End": "🚫 Dead End"
}

# Optional: Web directory for custom UI files (if you add them later)
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
if ENABLE_V3_NODES:
    __all__.append("comfy_entrypoint")
