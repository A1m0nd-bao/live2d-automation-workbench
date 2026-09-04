---
domain: multi-modal
tags:
  - live2d
  - workflow
license: apache-2.0
---

# Morph See-Through Relay

Deploy this small CPU-only service as a private ModelScope Studio. It does not
run See-Through locally: the upstream See-Through Studio still handles GPU
inference. The relay owns the Gradio SSE connection, persists tasks and input
images under `/mnt/data`, retries interrupted sessions, and resumes unfinished
work after its process restarts.

## Required secrets

- `MODELSCOPE_API_TOKEN`: calls the upstream See-Through Studio
- `MORPH_RELAY_TOKEN`: accepted only from the workbench proxy

## Run locally

```bash
export MODELSCOPE_API_TOKEN=ms-...
export MORPH_RELAY_TOKEN=replace-with-a-random-secret
uvicorn app.main:app --host 0.0.0.0 --port 7860
```

Configure the workbench with the deployed relay URL and the same
`MORPH_RELAY_TOKEN`. Never send this token to the browser.
