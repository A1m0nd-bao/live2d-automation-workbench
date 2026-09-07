"""FastAPI-only local entrypoint for the persistent desktop bridge.

The Studio entrypoint `app.py` mounts a Gradio console, which is useful in
ModelScope but unnecessary on the local machine.  Loading this module avoids
that optional dependency while keeping the same durable queue implementation.
"""

import importlib.util
import sys
from pathlib import Path

module_spec = importlib.util.spec_from_file_location(
    "morph_local_relay_api", Path(__file__).parent / "app" / "main.py"
)
if module_spec is None or module_spec.loader is None:
    raise RuntimeError("Unable to load the local relay API")
module = importlib.util.module_from_spec(module_spec)
sys.modules[module_spec.name] = module
module_spec.loader.exec_module(module)
app = module.app
