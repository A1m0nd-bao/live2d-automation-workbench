# GitHub Pages production path

- Public UI: https://a1m0nd-bao.github.io/live2d-automation-workbench/
- Private service connection: existing Sites `/pages-bridge` remains as a
  compatibility fallback. The preferred GitHub Pages route is **直连设置**:
  configure a Relay HTTPS URL plus `MORPH_DEVICE_TOKEN` once per browser to
  avoid the Sites login popup. The token is a revocable Relay access key, not
  a ModelScope or Ark credential.
- Image preparation: the task dialog offers **豆包 Seedream** and **Image-2**. Both use the same source-identity lock and Live2D-friendly prompt before See-Through submission. Provider choice is browser task metadata only; secrets remain in the private service.
  - Doubao: configure `VOLCENGINE_ARK_API_KEY` as a Sites secret. `VOLCENGINE_ARK_MODEL` is an optional non-secret override.
  - Image-2 (Vercel AI Gateway): configure `AI_GATEWAY_API_KEY` as a Sites secret. `IMAGE2_MODEL` is optional and defaults to `openai/gpt-image-2`. The private adapter calls Vercel AI Gateway's image-edit endpoint with the source image as a data URL, the shared persona-lock prompt, and the target canvas. It explicitly requests `background: transparent` and PNG output, then accepts PNG/JPEG bytes or `data[0].b64_json`. No Gateway key is included in the Pages bundle or task metadata.
  Never place either provider's key in a Vite variable, direct Relay setup, GitHub Pages artifact, or browser storage.
- Inference: existing authenticated relay, server queue and saved task states.
- PSD → CMO3: pinned browser-side StretchyStudio compatibility exporter; no ModelScope key needed for existing PSD.

## Use

Import accepted PSD when creating a task, confirm input QA, generate, then download CMO3 and the ZIP backup. For a PNG/JPG reference, first connect the private service in its login popup, create a Live2D-friendly Doubao Seedream edit, inspect it, approve it, then submit the approved edit. The original and approved image remain separate browser assets. The reference is sent directly from the private service to Ark as a base64 data URL; no bucket or public object URL is created. Open a task to resume status polling and retrieve its PSD. No fabricated completion percentages are shown.

Task metadata uses the existing localStorage key; actual inputs and outputs use IndexedDB. An older task with only filenames needs its file reimported. Changing origins/devices or clearing site data does not migrate files. Keep downloaded backups. Closing Pages stops browser generation, but not an already submitted server inference job.

The popup permits only the configured Pages origin and window.opener. Replies require service origin, window reference, random connection nonce and request ID. It exposes fixed health/submit/status/output operations, not arbitrary URLs. Credentials remain in the private service environment. Direct mode sends only the dedicated device token to the Relay; the Relay CORS allow-list must contain `https://a1m0nd-bao.github.io`, and its upstream credentials remain server-only. Public visitors without the device token cannot use the queue, but can process their own PSD locally.

## Compatibility and acceptance

Engine: StretchyStudio 24a83a27ba43e43e9d2e3de5e33994594e6199c2, MIT, with native warp nodes omitted from a copy before standard auto-rig export. This avoids the reproduced upper-body-loss path. Hand-authored native warp lattices are not losslessly converted. PSD → Cubism generation uses DWPose in the browser to refine limb and joint pivots from the neutral composite, then keeps See-Through layer tags as the source of truth for part parenting. The model is downloaded on first use and cached by the browser; when it cannot load, generation automatically falls back to layer-bound skeleton estimation.

Local UI test on 2026-09-05: imported the accepted 1024×1024 ana.psd, generated 24 part meshes, downloaded ana-pages-compat.cmo3 and opened it in Cubism 5.3.03. Full-body default display verified. Parameter motion quality and MOC3 compilation remain separate acceptance steps; file generation alone never marks them passed.

## Checks

`node --test tests/service-bridge.test.mjs tests/live2d-prep.test.mjs`

`npx tsc --noEmit`

`npm run build:pages` and `npm run build`

Never add runtime ModelScope/relay credentials to a Vite environment variable or GitHub Pages artifact.
