# GitHub Pages production path

- Public UI: https://a1m0nd-bao.github.io/live2d-automation-workbench/
- Connection: **接入本机桥接（免登录）**, or configure an HTTPS Relay URL and
  `MORPH_DEVICE_TOKEN` in **直连设置**. Both image generation and decomposition
  use the durable Relay. The old Sites login popup is no longer used for generation.
- Image preparation: the task dialog offers **豆包 Seedream** and **Image-2**. Both use the same source-identity lock and Live2D-friendly prompt before See-Through submission. Provider choice is browser task metadata only; secrets remain in the private service.
  - Doubao: configure `VOLCENGINE_ARK_API_KEY` in the Relay environment. `VOLCENGINE_ARK_MODEL` is optional.
  - Image-2: configure `AI_GATEWAY_API_KEY` in the Relay environment. On this Mac run `scripts/配置生图服务.command` to store it in Keychain; `MORPH_USE_KEYCHAIN=1` makes the Relay read it without restarting. `IMAGE2_MODEL` defaults to `openai/gpt-image-2`.
  - The Gateway adapter follows the official SDK image-model protocol (`/v4/ai/image-model`, specification version 4, image `files`, base64 `images` output), not the old assumed `/v1/images/edits` compatibility endpoint. See https://github.com/vercel/ai/blob/main/packages/gateway/src/gateway-image-model.ts and `gateway-provider.ts`. Provider format changes require revalidation. Health indicates configured credentials, not verified credits or model permissions.
  Never place either provider's key in a Vite variable, direct Relay setup, GitHub Pages artifact, or browser storage.
- Inference: existing authenticated relay, server queue and saved task states.
- PSD → CMO3: pinned browser-side StretchyStudio compatibility exporter; no ModelScope key needed for existing PSD.

## Use

Import accepted PSD when creating a task, confirm input QA, generate, then download CMO3 and the ZIP backup. PNG/JPG tasks default to the selected provider (Doubao OR Image-2). Connect the Relay, configure the chosen provider on the server, then start. Missing configuration fails early; no provider fallback or source-image fallback occurs. A user may explicitly check “已处理，跳过生图”; this is `user-confirmed`, never AI-approved. Replacing input resets generation. Cropped references are allowed: the prompt requests conservative completion of unseen body parts.

Generation source, prompt snapshot, model, timestamps, task state and result are persisted in the Relay's `MORPH_DATA_ROOT/prep` (SQLite + files). Browser localStorage/IndexedDB are local UI/cache, not the generation record authority. Authenticated history recovers the latest 100 generation records and outputs. Recovered history does NOT auto-submit another decomposition. Reimport the source to regenerate if the local input is absent.

The browser saves a stable job ID before upload. Repeating submission with the same ID and source/provider returns the same job; conflicting inputs get 409. A paid call is never automatically retried. Queued jobs resume after process restart; running calls without a saved output become `uncertain`. Outputs already saved before a DB status interruption are recovered. Gateway/network timeouts (bounded to 10 minutes) are uncertain, not proof no charge occurred. New paid attempts require an explicit confirmation.

Outputs are saved BEFORE browser frame QA. Rejected candidates are downloadable as `needs-review`, never automatically submitted to See-Through. These checks remain geometric heuristics, not semantic detection of feet. Closing the webpage does not stop submitted image generation; browser QA and automatic handoff to See-Through resume when the original task is opened again. This Mac must remain powered and awake with the Relay running; GitHub Pages itself does not run the queue. For unattended overnight operation use an always-on host and persistent disk.

The popup permits only the configured Pages origin and window.opener. Replies require service origin, window reference, random connection nonce and request ID. It exposes fixed health/submit/status/output operations, not arbitrary URLs. Credentials remain in the private service environment. Direct mode sends only the dedicated device token to the Relay; the Relay CORS allow-list must contain `https://a1m0nd-bao.github.io`, and its upstream credentials remain server-only. Public visitors without the device token cannot use the queue, but can process their own PSD locally.

## Compatibility and acceptance

Engine: StretchyStudio 24a83a27ba43e43e9d2e3de5e33994594e6199c2, MIT, with native warp nodes omitted from a copy before standard auto-rig export. This avoids the reproduced upper-body-loss path. Hand-authored native warp lattices are not losslessly converted. PSD → Cubism generation uses DWPose in the browser to refine limb and joint pivots from the neutral composite, then keeps See-Through layer tags as the source of truth for part parenting. The model is downloaded on first use and cached by the browser; when it cannot load, generation automatically falls back to layer-bound skeleton estimation.

Local UI test on 2026-09-05: imported the accepted 1024×1024 ana.psd, generated 24 part meshes, downloaded ana-pages-compat.cmo3 and opened it in Cubism 5.3.03. Full-body default display verified. Parameter motion quality and MOC3 compilation remain separate acceptance steps; file generation alone never marks them passed.

## Checks

`node --test scripts/test-prep-policy.mjs tests/service-bridge.test.mjs tests/live2d-prep.test.mjs tests/prep-queue.test.mjs`

`python -m unittest discover -s worker -p test_prep_queue.py -v`

`npx tsc --noEmit`

`npm run build:pages` and `npm run build`

Never add runtime ModelScope/relay credentials to a Vite environment variable or GitHub Pages artifact.
