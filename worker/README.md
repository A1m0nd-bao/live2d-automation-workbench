# Morph See-Through Worker

This is the compute service behind the static GitHub Pages UI. It invokes the
official See-Through `inference/scripts/inference_psd.py` script and returns a
job id immediately.

## Prerequisites

1. Provision an NVIDIA GPU machine. The official See-Through full pipeline
   needs about 12–16 GB VRAM at 1280px; the quantized variant can run around
   8 GB VRAM.
2. Clone `https://github.com/shitagaki-lab/see-through` beside this folder and
   complete its official Python, CUDA, model, and dependency installation.
3. Install this service's requirements in the same Python environment.

## Run

```bash
export SEE_THROUGH_REPO=/absolute/path/to/see-through
export CORS_ORIGINS=https://tianrongbao.github.io,http://localhost:3000
uvicorn app.main:app --host 0.0.0.0 --port 8787
```

In the workbench, open **设置 → 连接 See-Through Worker** and enter the
publicly reachable HTTPS URL of this service. Do not expose a private GPU
machine to the internet without authentication and a reverse proxy.

The in-memory job registry is deliberately minimal. Replace it with Redis or a
database before using it for multi-user or restart-safe production workloads.
