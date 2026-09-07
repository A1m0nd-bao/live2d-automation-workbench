import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as agPsd from 'ag-psd';
import { extractVariantManifest } from '../src/vendor/stretchystudio/io/psd.js';

// ag-psd's browser path only needs an ImageData factory for this round-trip.
// Keep the test dependency-free instead of requiring a native node-canvas.
agPsd.initializeCanvas((width, height) => ({
  width,
  height,
  getContext: () => ({
    createImageData: (imageWidth, imageHeight) => ({
      width: imageWidth,
      height: imageHeight,
      data: new Uint8ClampedArray(imageWidth * imageHeight * 4),
    }),
    putImageData: () => {},
  }),
}));

const source = process.argv[2] || '/Users/baotianrong/Downloads/00-cubism-import-free-v5.psd';
const output = process.argv[3] || '/Users/baotianrong/Downloads/Live2D-Pro-合层验收样例.psd';

function runCommonJs(sourceCode, context) {
  const compiled = ts.transpileModule(sourceCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, ...context });
  return module.exports;
}

const plannerSource = await fs.readFile(new URL('../src/live2dPro.ts', import.meta.url), 'utf8');
const planner = runCommonJs(plannerSource, {});
let mergerSource = await fs.readFile(new URL('../src/live2dProMerge.ts', import.meta.url), 'utf8');
mergerSource = mergerSource
  .replace("import { readPsd, writePsd } from 'ag-psd';", 'const { readPsd, writePsd } = agPsd;')
  .replace(/import \{\n  type ProLayerProbe,\n  type ProState,\n  planLive2DProDiff,\n\} from '.\/live2dPro';/, 'const { planLive2DProDiff } = planner;');
const merger = runCommonJs(mergerSource, { agPsd, planner, Blob });

const sourceFile = await fs.readFile(source);
const input = sourceFile.buffer.slice(sourceFile.byteOffset, sourceFile.byteOffset + sourceFile.byteLength);
const states = planner.selectedProStates([
  'action_02_wave_arms_only',
  'action_03_hand_on_hip_arms_only',
  'action_04_arms_crossed_crossed_arms',
  'action_05_thinking_arms_only',
  'expression_02_soft_smile_face_controls',
  'expression_04_embarrassed_face_controls',
  'expression_07_surprised_face_controls',
]);
// The golden PSD already has the same layer protocol. Reusing it as each
// input isolates and validates the writer: each output variant is replaced
// with a freshly written hidden semantic group.
const result = merger.mergeLive2dProPsd(input, states.map((state) => ({
  state,
  data: input.slice(0),
  filename: `${state.id}.psd`,
})));
const data = Buffer.from(await result.psd.arrayBuffer());
if (data.subarray(0, 4).toString('ascii') !== '8BPS')
  throw new Error('合层器未生成 PSD 文件头。');
const roundTrip = extractVariantManifest(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
const report = {
  source,
  output,
  requestedStates: states.length,
  writtenStates: result.report.states.length,
  parsedVariants: roundTrip.variants.map((variant) => ({ id: variant.id, hidden: variant.hidden, parts: variant.parts.length })),
  success: result.report.states.length === states.length && states.every((state) =>
    roundTrip.variants.filter((variant) => variant.id === state.id && variant.hidden).length === 1,
  ),
};
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, data);
await fs.writeFile(output.replace(/\.psd$/i, '-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
