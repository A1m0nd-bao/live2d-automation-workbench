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

- `SEE_THROUGH_API_TOKEN`: calls the upstream See-Through Studio
- `MORPH_RELAY_TOKEN`: accepted only from the workbench proxy
- `MORPH_DEVICE_TOKEN`: a separate, revocable token for the GitHub Pages
  direct-connect mode; never reuse `MORPH_RELAY_TOKEN` here
- `MORPH_ALLOWED_ORIGINS`: comma-separated browser origins permitted to call
  the relay directly (defaults to this project's GitHub Pages and localhost)

## Run locally

```bash
export SEE_THROUGH_API_TOKEN=ms-...
export MORPH_RELAY_TOKEN=replace-with-a-random-secret
export MORPH_DEVICE_TOKEN="$(openssl rand -hex 32)"
uvicorn app.main:app --host 0.0.0.0 --port 7860
```

The private proxy uses `MORPH_RELAY_TOKEN`; never send that token to the
browser. For the login-free GitHub Pages path, configure the deployed relay
HTTPS URL and the separate `MORPH_DEVICE_TOKEN` once in **直连设置**. It is
stored only in that browser and can be revoked by changing the Relay variable.

By default the relay stores queue metadata and PSDs in ModelScope's persistent
`/mnt/workspace/morph-live2d` directory. It can be changed with
`MORPH_DATA_ROOT`; do not point it at the ephemeral `/mnt/data` path.

FileData may contain a browser-facing `ms.show` URL. Download its `path` through
the API inference host instead; the browser URL rejects bearer API tokens.
The relay checks the PSD signature before reporting success. Private diagnostic
events are available from `/jobs/{id}/diagnostics` using the relay token.

Run `python test_relay.py` to verify null failure events, trusted download routing,
and invalid file rejection. For a real bounded test with raw events and PSD parsing,
install `psd-tools` and run `python diagnose.py /path/to/image.png /path/to/output`.
