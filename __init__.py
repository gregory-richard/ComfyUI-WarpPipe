if __package__:
    from . import warp_pipe as _warp_pipe
else:
    # Support direct import smoke tests from the node-pack root.
    import warp_pipe as _warp_pipe

WEB_DIRECTORY = _warp_pipe.WEB_DIRECTORY

if hasattr(_warp_pipe, "comfy_entrypoint"):
    comfy_entrypoint = _warp_pipe.comfy_entrypoint
    __all__ = ["WEB_DIRECTORY", "comfy_entrypoint"]
else:
    NODE_CLASS_MAPPINGS = _warp_pipe.NODE_CLASS_MAPPINGS
    NODE_DISPLAY_NAME_MAPPINGS = _warp_pipe.NODE_DISPLAY_NAME_MAPPINGS
    __all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
