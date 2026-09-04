import os
import importlib.util
import sys
from pathlib import Path

import gradio as gr
import uvicorn

module_spec = importlib.util.spec_from_file_location("morph_relay_api", Path(__file__).parent / "app" / "main.py")
if module_spec is None or module_spec.loader is None:
    raise RuntimeError("Unable to load the relay API")
module = importlib.util.module_from_spec(module_spec)
sys.modules[module_spec.name] = module
module_spec.loader.exec_module(module)
api = module.app


with gr.Blocks(title="Morph See-Through Relay") as console:
    gr.Markdown("# Morph See-Through Relay\n\nThis private service keeps See-Through jobs running and stores their state for the production workbench.")


app = gr.mount_gradio_app(api, console, path="/console")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "7860")))
