import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { extractVariantManifest } from '../src/vendor/stretchystudio/io/psd.js';

const source = process.argv[2] || '/Users/baotianrong/Downloads/00-cubism-import-free-v5.psd';
const output = process.argv[3] || '/Users/baotianrong/Downloads/Live2D-Pro-案例差分报告.json';

// Execute the browser-safe Pro planner directly from its TypeScript source so
// this command validates the same contract used by the workbench UI.
const module = { exports: {} };
const sourceCode = await fs.readFile(new URL('../src/live2dPro.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(sourceCode, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(compiled, { module, exports: module.exports });
const { selectedProStates, planLive2DProDiff } = module.exports;

const data = await fs.readFile(source);
const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
const manifest = extractVariantManifest(buffer);
const baseLayers = manifest.baseSlots.map((part) => ({ name: part.name, bounds: part.bounds }));
const variants = new Map(manifest.variants.map((variant) => [variant.id, variant]));
const requested = selectedProStates([
  'action_02_wave_arms_only',
  'action_03_hand_on_hip_arms_only',
  'action_04_arms_crossed_crossed_arms',
  'action_05_thinking_arms_only',
  'expression_02_soft_smile_face_controls',
  'expression_04_embarrassed_face_controls',
  'expression_07_surprised_face_controls',
]);

const plans = requested.map((state) => {
  const variant = variants.get(state.id);
  if (!variant) return { stateId: state.id, ready: false, replacements: [], warnings: ['PSD 中不存在该状态组。'] };
  // See-Through outputs canonical names. The golden PSD already stores the
  // action source as state__slot, so convert it back to the expected input
  // names before asking the planner to create the merge mapping.
  const stateLayers = variant.parts.map((part) => ({ name: part.slot, bounds: part.bounds }));
  return planLive2DProDiff(state, baseLayers, stateLayers);
});

const report = {
  source,
  canvas: [manifest.width, manifest.height],
  baseSlotCount: manifest.baseSlots.length,
  baseSlots: baseLayers.map((layer) => layer.name),
  expectedStateCount: requested.length,
  readyStateCount: plans.filter((plan) => plan.ready).length,
  plans,
};
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
