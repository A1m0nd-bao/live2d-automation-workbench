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

Sources, prompt snapshots, each candidate and quality reports are stored under
`MORPH_DATA_ROOT/prep`. New neutral jobs snapshot `prep_prompt_master.txt`
(front-view 30-degree A-pose, identity/topology locks and wrist-width gaps),
an immutable source hash and provider-appropriate background policy. Pro PSD
parts use their separate pose brief, never the neutral A-pose prompt. Legacy provider templates remain
unchanged for historical reference. Ship `image_quality.py` alongside
`prep_queue.py` and `pro_queue.py`. Restart only when no calls are running.
Existing jobs keep their saved prompt and never silently change providers.

## Batch friendly masters and native state delivery (2026-10-13)

New `/batches` requests explicitly include `settings.friendly` and `provider`.
The Pages UI defaults to friendly generation; only a consciously confirmed
existing master may skip it. Legacy manifests keep their raw split policy and
are never silently regenerated or charged. Stable prep IDs, current-version QA,
serial splitting and an uncertainty stop prevent raw-image fallback or paid replay.
The archive includes accepted friendly images and prompt/lock/review records.

PSD-first Pro keeps original layers/order/pixels and appends hidden complete
replacement parts. Modeling preserves source painter order by default; safe
derived left/right parts remain in their original slot. Qualified alternates
inherit the counterpart slot; combined arms use the authored action plane.
Unqualified raster children in action/expression groups are blocked rather than
mistaken for additional neutral limbs.

CMO3 carries `morph-delivery.json` alongside its textures/XML. Every selected
pose is bound through one mutually-exclusive action selector; measured wave
retains its 0–3 phase lane. Native compilation samples the actual Core opacities
and geometry, then delivers registered `motion3.json`, `exp3.json`, matching
expression motions and `runtime-delivery.json`. Parameter presets are not new
AI face artwork. Ineffective facial parameters are reported, not certified.
Core validation and ZIP consistency do not imply visual acceptance.

Facial parameter presets reuse `scripts/expression-profiles.mjs` from the
existing batch system (Smile/Laugh/Shy/Surprised/Angry/Sad), not a second
independent set. Existing `expression-profile.json` enabled/profiles overrides
remain supported in the export directory; `enabled: []` explicitly disables
them. Overrides are facial-only and clamped to compiled parameter ranges.
Missing/ineffective bindings are listed by parameter in the delivery report;
the presets never create mouth artwork or affect the action selector.

Install `scripts/runtime-delivery.mjs` and `scripts/expression-profiles.mjs` beside `scripts/pro-rig`, update
`native_export.py`, and ship `prep_prompt_master.txt` with `prep_queue.py`.
Keep official Web Core/Node/native compiler configured. Restart only with no
active image/split/native calls; preserve local quality-policy customizations.
Both generators require the Gateway key for reference-based visual review.
The default reviewer is `openai/gpt-5.5` (`MORPH_IMAGE_REVIEW_MODEL` overrides it).
Review uses `MORPH_IMAGE_REVIEW_PROXY` or the existing OS HTTPS proxy when set.
Only all eight checks passing under the current review version permits automatic
splitting. Rejection gets one corrective generation from the original reference;
two failed candidates stop at `needs-review`. Review outages also stop there,
without another generation. `POST /prep/jobs/{id}/review` reviews existing bytes
without regenerating. Old review versions require re-review before splitting.
Visual checks can still make mistakes; model delivery retains human acceptance.
When only background/margins fail and all semantic checks pass, the queue first
uses the existing anime foreground tool plus canvas padding, then reviews again.
Install `requirements-foreground.txt` for this cleanup and ship `foreground.py`.
Original pixels/candidates and cleanup masks remain saved for inspection.
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

## Experimental foreground preflight (opt-in, 2026-09-10)

Install `pip install -r requirements-foreground.txt` in a Python 3.11–3.13
environment. Warm up `python app/foreground.py INPUT.png NEW_OUTPUT_DIRECTORY`
before accepting jobs: first use downloads the checksum-verified `isnet-anime`
ONNX weights (~176 MB) from the rembg release. Model selection is explicit;
the rembg default model is not used. See the upstream rembg and
SkyTNT/anime-segmentation model licensing separately from this worker.

`POST /jobs?foreground=true` enables local segmentation only for that job.
Omitting it preserves existing behavior; the Pages UI is not switched globally.
The stage is snapshotted in `foreground-request.json`, runs in a bounded CPU
subprocess (300 seconds) within the queue semaphore, and must finish before
any See-Through request. Failure stops the job, without submitting the original.
Completed cutouts are reused during recovery, not regenerated on upstream retry.

`source` preserves the original upload. `cutout/` contains transparent
`foreground.png`, `mask.png`, `on-dark.png`, `submission.png`, and a source-hash
report. This white-dress trial composites onto uniform gray (#d0d0d0) for
submission to avoid upstream alpha-decoder ambiguity. Geometry, resolution and
opaque foreground RGB pixels are not changed. Numerical mask checks do NOT
prove complete fingers/accessories: inspect the dark preview and final PSD.

Authenticated `GET /jobs/{id}/foreground` returns the transparent PNG;
`GET /jobs/{id}/source` returns the processed submission when ready.
Diagnostics include foreground start/completion/failure. The controlled local
experiment can be resumed with `python scripts/test-foreground-relay.py` from
the repository; its persisted job ID avoids duplicate submissions.

The canonical Image-2 prompt remains frozen. If matting is not sufficient,
the proposed generation-background policy is white for normal clothing, gray
for white clothing; that conditional fallback has not been enabled globally.
