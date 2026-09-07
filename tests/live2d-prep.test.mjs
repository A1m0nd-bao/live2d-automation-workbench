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
    '从头到脚的完整角色',
    '左右手臂',
    '两条完整腿',
    '真实 Alpha 通道的透明 PNG 背景',
    '若本次输出能力无法生成 Alpha',
    '现实人物照片、强写实绘画或近似 3D',
    '构图优先级最高',
    '小腿、脚踝、双脚和鞋底',
    '画幅底部必须能看到鞋底以下的背景带',
    '正面、中立的 A 字站姿',
    '双手不得贴身体',
    '只有在上述全身构图与肢体分离都满足时',
    '额外或缺失的手指/肢体',
    '不强制转换成赛璐璐',
    '适度压低过强的三维渲染感',
    '保留输入图本身已有的笔触',
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
