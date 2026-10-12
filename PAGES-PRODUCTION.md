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

### Batch production

The sidebar's **批量生产** opens the batch panel. It accepts 1–100 PNG/JPEG files, preserves their chosen order and uploads original bytes without regeneration, padding, cutout or visual-QA rejection. Defaults match the October batch runs: resolution 1024, seed 42, split left/right limbs enabled. Settings are snapshotted per batch. The authenticated Relay must include `worker/app/batch_queue.py` and the updated `main.py`.

The client saves random batch/item IDs and SHA-256 fingerprints before submitting. Upload recovery reuses those IDs; conflicting bytes return 409. A batch starts only after all sources are saved server-side. The Relay owns sequencing, continues while the browser is closed, records failures and skips explicitly failed items. Unknown inference submissions block further inference; reconnects use the saved Gradio event ID. Pause stops future submissions, not a running job. Refresh restores batch history; completed PSDs are downloaded in a ZIP with a status manifest. ZIP download still requires an open browser; reconnecting later can download the saved outputs.

**批量制作已完成的 PSD** downloads completed sources into the workbench and runs the existing standard/Pro local authoring path sequentially, producing CMO3 and native MOC3 packages with a per-character failure manifest. Existing PSDs may also be selected together in **新建生产任务**. Saved native packages are reused on continuation; this local authoring step requires the browser to remain open. Pro uses states actually present in the PSD, rather than inventing absent pose artwork. GPU splitting and local authoring are independent, so local work can begin while remaining images continue to split.

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

# PSD-first Pro 状态形态（psd-pose-variants-v1）

新版单张/批量 Pro 改为：基础分层 PSD → 完整肩袖手局部部件 → 当前角色锚点对齐 → 隐藏动作组合层。
基础图片仍仅拆一次；已有 PSD 直接复用。状态不再生成全身图、不再逐张 See-Through。

- 六个手势：挥手、叉腰、抱臂、思考、托掌、握拳。表情/嘴部保留原模型控制，本轮不重画。
- 服务端需要 `psd-tools`、SciPy，复用已配置的生图提供方和视觉检查凭据。Image-2 请求透明 PNG；不透明部件仅做既有 CPU 背景透明化，再检查整臂，绝不回退云端语义拆件。
- 使用真实源图层 `handwear-r` / `handwear-l`，拒绝缺失、重复、隐藏、含剪贴/遮罩的中立手臂。肩位/骨段定位按此 PSD，不使用另一角色常量；单侧动作复制另一侧原层。
- 原始 PSD 不覆盖，原层顺序和像素保留，动作组置于上方且默认隐藏。导出后重开，比较中立像素、原层签名，并检查四个合成 RGBA 通道。
- `/pro/pose-jobs` 使用独立持久队列；新版本和请求 ID 在浏览器提交前持久化。生成中断且未保存部件则标为未知，不自动重生。复核现有素材与明确付费重生分开。
- 视觉检查同时看部件和实际合成结果。躯干层含残留旧袖、肩口无法衔接、手比例不符等会阻止导出；保留素材待处理，不假装自动修补通过。缺失/错误语义层需用户先整理。
- 旧 `/pro/jobs` 任务只恢复原记录，不迁移、不因升级另发收费任务。已包含选定状态的 PSD 直接复用；批量继续会复用已完成的运行包。
- 本轮验证覆盖持久状态机、模拟提供方合成链路、实际 PSD 重开、网页入口、类型检查和构建。测试不发起新的收费图像请求；不能据此声称所有角色的生成动作已视觉验收。
