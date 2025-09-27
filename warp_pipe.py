import comfy.samplers
import hashlib
import uuid
import weakref
import threading
from typing import Dict, Any, Optional

# Global storage for warp data; keys are unique per Warp instance
warp_storage: Dict[str, Dict[str, Any]] = {}
_storage_lock = threading.Lock()

def cleanup_warp_storage():
    """Clean up unused warp storage entries"""
    with _storage_lock:
        # In a real implementation, you'd track active warp IDs
        # For now, we'll keep the simple approach but add the infrastructure
        pass

class Warp:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "warp"
    OUTPUT_NODE = True
    DISPLAY_NAME = "Warp Bundle"
    DESCRIPTION = "Bundle multiple data types into a single warp object"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "warp": ("CONTROL", {}),  # copy from existing warp if provided
                "model": ("MODEL", {}),
                "clip": ("CLIP", {}),
                "clip_vision": ("CLIP_VISION", {}),
                "vae": ("VAE", {}),
                "conditioning_positive": ("CONDITIONING", {}),
                "conditioning_negative": ("CONDITIONING", {}),
                "image": ("IMAGE", {}),
                "latent": ("LATENT", {}),
                "prompt_positive": ("STRING", {"default": ""}),
                "prompt_negative": ("STRING", {"default": ""}),
                "initial_steps": ("INT", {"default": 20, "min": 1, "max": 200}),
                "detailer_steps": ("INT", {"default": 0, "min": 0, "max": 200}),
                "upscaler_steps": ("INT", {"default": 0, "min": 0, "max": 200}),
                "cfg": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 50.0}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {}),
            }
        }

    RETURN_TYPES = ("CONTROL",)
    RETURN_NAMES = ("warp",)

    def __init__(self):
        # Unique ID for this warp instance
        self._warp_id = uuid.uuid4().hex

    @classmethod
    def IS_CHANGED(cls, **kwargs) -> str:
        h = hashlib.sha256()
        for key in sorted(kwargs.keys()):
            if kwargs[key] is not None:  # Only hash non-None values
                h.update(f"{key}:{repr(kwargs[key])}".encode('utf-8'))
        return h.hexdigest()
    
    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs) -> bool:
        """Validate inputs - always return True for optional inputs"""
        return True

    def warp(
        self,
        warp: Optional[Dict[str, Any]] = None,
        model: Optional[Any] = None,
        clip: Optional[Any] = None,
        clip_vision: Optional[Any] = None,
        vae: Optional[Any] = None,
        conditioning_positive: Optional[Any] = None,
        conditioning_negative: Optional[Any] = None,
        image: Optional[Any] = None,
        latent: Optional[Any] = None,
        prompt_positive: Optional[str] = None,
        prompt_negative: Optional[str] = None,
        initial_steps: Optional[int] = None,
        detailer_steps: Optional[int] = None,
        upscaler_steps: Optional[int] = None,
        cfg: Optional[float] = None,
        sampler_name: Optional[str] = None,
        scheduler: Optional[str] = None
    ) -> tuple:
        # If warp input provided, copy existing data
        if isinstance(warp, dict) and "id" in warp:
            prev_id = warp["id"]
            data = warp_storage.get(prev_id, {}).copy()
        else:
            data = {}

        # Apply any new inputs
        updates = {
            "model": model,
            "clip": clip,
            "clip_vision": clip_vision,
            "vae": vae,
            "conditioning_positive": conditioning_positive,
            "conditioning_negative": conditioning_negative,
            "image": image,
            "latent": latent,
            "prompt_positive": prompt_positive,
            "prompt_negative": prompt_negative,
            "initial_steps": initial_steps,
            "detailer_steps": detailer_steps,
            "upscaler_steps": upscaler_steps,
            "cfg": cfg,
            "sampler_name": sampler_name,
            "scheduler": scheduler
        }
        for key, val in updates.items():
            if val is not None:
                data[key] = val

        with _storage_lock:
            warp_storage[self._warp_id] = data
        return ({"id": self._warp_id},)

class Unwarp:
    CATEGORY = "Custom/WarpPipe Nodes"
    FUNCTION = "unwarp"
    DISPLAY_NAME = "Unwarp Bundle"
    DESCRIPTION = "Unpack a warp object back into individual data types"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "warp": ("CONTROL", {}),  # CONTROL carries the warp ID
            }
        }

    RETURN_TYPES = (
        "MODEL",
        "CLIP",
        "CLIP_VISION",
        "VAE",
        "CONDITIONING",
        "CONDITIONING",
        "IMAGE",
        "LATENT",
        "STRING",
        "STRING",
        "INT",
        "INT",
        "INT",
        "FLOAT",
        comfy.samplers.KSampler.SAMPLERS,
        comfy.samplers.KSampler.SCHEDULERS,
    )
    RETURN_NAMES = (
        "model",
        "clip",
        "clip_vision",
        "vae",
        "conditioning_positive",
        "conditioning_negative",
        "image",
        "latent",
        "prompt_positive",
        "prompt_negative",
        "initial_steps",
        "detailer_steps",
        "upscaler_steps",
        "cfg",
        "sampler_name",
        "scheduler",
    )

    def unwarp(self, warp: Dict[str, Any]) -> tuple:
        if not isinstance(warp, dict) or "id" not in warp:
            raise ValueError("Invalid warp signal. Ensure it comes from a Warp node.")
        
        warp_id = warp["id"]
        with _storage_lock:
            data = warp_storage.get(warp_id, {})
        
        if not data:
            raise ValueError(f"Warp data not found for ID: {warp_id}. The warp may have been cleaned up or corrupted.")
        return (
            data.get("model"),
            data.get("clip"),
            data.get("clip_vision"),
            data.get("vae"),
            data.get("conditioning_positive"),
            data.get("conditioning_negative"),
            data.get("image"),
            data.get("latent"),
            data.get("prompt_positive"),
            data.get("prompt_negative"),
            data.get("initial_steps"),
            data.get("detailer_steps"),
            data.get("upscaler_steps"),
            data.get("cfg"),
            data.get("sampler_name"),
            data.get("scheduler"),
        )

# Register nodes under capitalized names
NODE_CLASS_MAPPINGS = {
    "Warp": Warp,
    "Unwarp": Unwarp
}

# Optional: Display names for the UI (newer ComfyUI feature)
NODE_DISPLAY_NAME_MAPPINGS = {
    "Warp": "🔀 Warp Bundle",
    "Unwarp": "🔄 Unwarp Bundle"
}

# Optional: Web directory for custom UI files (if you add them later)
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
