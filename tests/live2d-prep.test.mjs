import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const module = { exports: {} };
const code = ts.transpileModule(
  readFileSync(new URL('../src/live2dPrep.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
vm.runInNewContext(code, { module, exports: module.exports, Uint8Array });
const { isPng, LIVE2D_PREP_MODEL, LIVE2D_PREP_SIZE, live2dPrepPrompt } =
  module.exports;

test('Live2D preprocessing targets image editing with a portrait source canvas', () => {
  assert.equal(LIVE2D_PREP_MODEL, 'gpt-image-2');
  assert.equal(LIVE2D_PREP_SIZE, '1024x1536');
});

test('character lock requires full-body, identity preservation and rejects topology drift', () => {
  const prompt = live2dPrepPrompt();
  for (const phrase of [
    'sole authority',
    'full head',
    'both arms',
    'both legs',
    'plain opaque very-light-gray background',
    'extra or missing fingers/limbs',
  ])
    assert.match(prompt, new RegExp(phrase));
});

test('only a genuine PNG header is accepted from the image service', () => {
  assert.equal(
    isPng(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
    ),
    true,
  );
  assert.equal(
    isPng(Uint8Array.from([0x38, 0x42, 0x50, 0x53, 0, 0, 0, 0]).buffer),
    false,
  );
});
