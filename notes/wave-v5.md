> 历史 V5 原型记录：当前第一版已改为按输入素材分析关节点，见 [wave-first-version.md](wave-first-version.md)。下述固定标定仅保留为回归测试夹具。

# V5 arm raise and wave prototype

Input: `00-cubism-import-free-v5.psd`, 1024 × 1024, with neutral `handwear-r`
and `action_02_wave_arms_only__handwear-r` artwork. The source PSD is never
modified. This first calibration is specific to that illustration.

`src/waveRig.js` computes canvas-space keyforms from shoulder, elbow and wrist
anchors. Both paintings follow the same interpolated joint trajectory during
the raise. A short texture crossfade changes the relaxed hand to the open hand.
The raised pose then rotates the forearm by ±7 degrees, keeping the upper arm
stationary. A calibrated separator prevents the upward-facing hand from being
assigned to the nearby shoulder. Other illustrations require their own profile;
the built-in profile is gated by canvas size and the two source layer bounds.

`ParamActionWave`:

- 0: original resting pose.
- 0–1: sampled arm raise, including intermediate mesh positions.
- 1: original raised pose.
- 1–3: one complete small waving cycle; 1 and 3 have identical geometry.
- Returning 1–0 lowers the arm.

The CMO3 writer now accepts optional `keys` and `stateVertices` alongside action
opacities. Existing opacity-only actions retain their previous behavior. The
workbench CMO3 bundle includes `wave_only.motion3.json`,
`raise_wave_lower.motion3.json` and the calibration profile. These curves require
a model with the new parameter range and keyforms; they are not compatible with
an older model containing only a 0–1 pose switch. The browser MOC3 writer has
not been extended to compile these shapes. A native CMO3 export is still needed
for that runtime delivery path.

Generate an independent CMO3, interactive preview and sampled images:

```sh
node scripts/build-wave-demo.mjs /path/to/00-cubism-import-free-v5.psd outputs/wave-v5
node --test tests/wave-rig.test.mjs tests/limb-bend-cmo3.test.mjs tests/autorig-preflight.test.mjs tests/psd-rig-normalization.test.mjs
```

Validation: 19 focused tests passed, including decoding generated CAFF and
checking actual XML position arrays and fractional parameter keys. Pages build
passed with existing bundle-size/browser-externalization warnings. The preview
was exercised with Playwright and local Chrome at 1200 × 900: loaded canvas,
pause, scrub to 1.5, resume, no page errors. Browser plugin was not available;
bundled Playwright used the installed Chrome because its bundled browser was
absent. Sampled raster images were visually inspected.

Known limitations: the middle of the raise shows a brief translucent/double
hand because the two paintings have different finger poses and silhouettes.
This is an experimental transition, not an approved natural hand-opening
animation. Edge quality and elbow shape need further visual tuning. No palm
flip or finger articulation is synthesized. Cubism Editor loading and final
MOC3 runtime playback have not been verified in this change.
