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
const { isPng, isJpeg, LIVE2D_PREP_MODEL, LIVE2D_PREP_SIZE, live2dPrepPrompt } =
  module.exports;

test('Live2D preprocessing targets Doubao Seedream image editing with a portrait source canvas', () => {
  assert.equal(LIVE2D_PREP_MODEL, 'doubao-seedream-4-5-251128');
  assert.equal(LIVE2D_PREP_SIZE, '1536x2400');
});

test('character lock requires full-body, identity preservation and rejects topology drift', () => {
  const prompt = live2dPrepPrompt();
  for (const phrase of [
    '唯一角色设定',
    '完整展示头部',
    '左右手臂',
    '双腿',
    '不透明极浅灰纯背景',
    '额外或缺失的手指/肢体',
    '二维平面原画',
    '有限色阶的赛璐璐阴影',
    '禁止照片质感',
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

test('JPEG output from Seedream can be identified for browser-side PNG normalization', () => {
  assert.equal(isJpeg(Uint8Array.from([0xff, 0xd8, 0xff]).buffer), true);
  assert.equal(isJpeg(Uint8Array.from([0x89, 0x50, 0x4e]).buffer), false);
});
