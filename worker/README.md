---
domain: multi-modal
tags:
  - live2d
  - workflow
license: apache-2.0
---

# Morph See-Through Relay

## Durable image preparation (2026-09-10)

The same service now exposes authenticated `/prep/health`, `POST /prep/jobs`,
`GET /prep/jobs`, `GET /prep/jobs/{id}` and `GET /prep/jobs/{id}/output`.
Use one uvicorn worker per persistent data directory. A separate serial scheduler
owns image calls without blocking See-Through's queue. Requests require a stable
32-character hex `job_id`, `provider` (`image2` or `doubao`), `image` and `name`
form fields. Uploads are capped at 20 MB. Missing access credentials fail closed.

Set `AI_GATEWAY_API_KEY` for Image-2 and/or `VOLCENGINE_ARK_API_KEY` for Doubao.
No key belongs in the browser. Local Mac launchers can set `MORPH_USE_KEYCHAIN=1`
and use `scripts/配置生图服务.command`; stored Gateway keys are read on demand.
Readiness only checks configuration; it does not verify budget or permissions.

Sources, prompt snapshots and outputs are stored under `MORPH_DATA_ROOT/prep`.
Task IDs are idempotent; conflicts return 409. Queued jobs resume after restart.
Interrupted running jobs become `uncertain` rather than being silently billed
again. Saved output bytes are recoverable even if the final DB update failed.
Calls are bounded to 10 minutes; network failures/5xx are uncertain, 4xx explicit
failures. Raw upstream error bodies are never published or logged.
Candidates are saved even when frontend frame validation later rejects them.

Run `python -m unittest discover -s worker -p test_prep_queue.py -v`.

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
