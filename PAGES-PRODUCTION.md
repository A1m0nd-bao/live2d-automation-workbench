# GitHub Pages production path

- Public UI: https://a1m0nd-bao.github.io/live2d-automation-workbench/
- Private service connection: existing Sites `/pages-bridge`; access policy unchanged.
- Image preparation: private `POST /api/live2d-prep` uses Doubao Seedream reference-image editing with the source as the identity lock, then requires human approval before See-Through submission. Configure `VOLCENGINE_ARK_API_KEY`, `VOLCENGINE_TOS_ACCESS_KEY`, `VOLCENGINE_TOS_SECRET_KEY`, and `VOLCENGINE_TOS_BUCKET` as Sites secrets; never use a Vite variable. `VOLCENGINE_TOS_REGION` (default `cn-beijing`), `VOLCENGINE_TOS_ENDPOINT`, and `VOLCENGINE_ARK_MODEL` are optional non-secret overrides.
- Inference: existing authenticated relay, server queue and saved task states.
- PSD → CMO3: pinned browser-side StretchyStudio compatibility exporter; no ModelScope key needed for existing PSD.

## Use

Import accepted PSD when creating a task, confirm input QA, generate, then download CMO3 and the ZIP backup. For a PNG/JPG reference, first connect the private service in its login popup, create a Live2D-friendly Doubao Seedream edit, inspect it, approve it, then submit the approved edit. The original and approved image remain separate browser assets. A private, signed TOS object exists only while Seedream reads the reference and is deleted after the call. Open a task to resume status polling and retrieve its PSD. No fabricated completion percentages are shown.

Task metadata uses the existing localStorage key; actual inputs and outputs use IndexedDB. An older task with only filenames needs its file reimported. Changing origins/devices or clearing site data does not migrate files. Keep downloaded backups. Closing Pages stops browser generation, but not an already submitted server inference job.

The popup permits only the configured Pages origin and window.opener. Replies require service origin, window reference, random connection nonce and request ID. It exposes fixed health/submit/status/output operations, not arbitrary URLs. Credentials remain in the private service environment. Public visitors without access cannot use this private inference service, but can process their own PSD locally.

## Compatibility and acceptance

Engine: StretchyStudio 24a83a27ba43e43e9d2e3de5e33994594e6199c2, MIT, with native warp nodes omitted from a copy before standard auto-rig export. This avoids the reproduced upper-body-loss path. Hand-authored native warp lattices are not losslessly converted. Skeleton estimation uses layer bounds, not DWPose.

Local UI test on 2026-09-05: imported the accepted 1024×1024 ana.psd, generated 24 part meshes, downloaded ana-pages-compat.cmo3 and opened it in Cubism 5.3.03. Full-body default display verified. Parameter motion quality and MOC3 compilation remain separate acceptance steps; file generation alone never marks them passed.

## Checks

`node --test tests/service-bridge.test.mjs tests/live2d-prep.test.mjs`

`npx tsc --noEmit`

`npm run build:pages` and `npm run build`

Never add runtime ModelScope/relay credentials to a Vite environment variable or GitHub Pages artifact.
