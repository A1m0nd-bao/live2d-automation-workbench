import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const {
  isPng,
  isJpeg,
  LIVE2D_PREP_MODEL,
  LIVE2D_PREP_SIZE,
  LIVE2D_PREP_PROVIDERS,
  live2dPrepProviderLabel,
  live2dPrepPrompt,
  LIVE2D_FRONT_FACE_CONSTRAINT,
} =
  module.exports;

test('Live2D preprocessing targets Doubao Seedream image editing with a portrait source canvas', () => {
  assert.equal(LIVE2D_PREP_MODEL, 'doubao-seedream-4-5-251128');
  assert.equal(LIVE2D_PREP_SIZE, '1536x2400');
});

test('preprocessing offers provider choices without putting keys in browser configuration', () => {
  assert.deepEqual(Object.keys(LIVE2D_PREP_PROVIDERS).sort(), ['doubao', 'image2']);
  assert.equal(live2dPrepProviderLabel('image2'), 'Image-2 生图');
  assert.match(
    readFileSync(new URL('../app/api/live2d-prep/route.ts', import.meta.url), 'utf8'),
    /AI_GATEWAY_API_KEY/,
  );
  assert.match(
    readFileSync(new URL('../app/api/live2d-prep/route.ts', import.meta.url), 'utf8'),
    /https:\/\/ai-gateway\.vercel\.sh\/v1\/images\/edits/,
  );
  assert.match(
    readFileSync(new URL('../app/api/live2d-prep/route.ts', import.meta.url), 'utf8'),
    /background: 'transparent'/,
  );
  assert.match(
    readFileSync(new URL('../app/api/live2d-prep/route.ts', import.meta.url), 'utf8'),
    /output_format: 'png'/,
  );
});

test('character lock requires full-body, identity preservation and rejects topology drift', () => {
  const prompt = live2dPrepPrompt('image2');
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
  ])
    assert.match(prompt, new RegExp(phrase));
});

test('user Image-2 baseline stays frozen; only approved front-face constraints are appended', () => {
  const canonical = readFileSync(new URL('../prompts/canonical/image2/prep_prompt_image2.txt', import.meta.url));
  const skill = readFileSync(new URL('../prompts/canonical/image2/SKILL.md', import.meta.url));
  assert.equal(createHash('sha256').update(skill).digest('hex'), '7ea9700a4dfe90ce43e13a9ecaf571a62366ad3242e21159ab6dd641f157f86d');
  assert.equal(createHash('sha256').update(canonical).digest('hex'), '4a09c7f2ddbc7df7b6b6ea09263622958b98c6fcc5f8b095eeb76d920c9a5e98');
  assert.equal(live2dPrepPrompt('image2'), canonical.toString().trim() + '\n\n' + LIVE2D_FRONT_FACE_CONSTRAINT);
  for (const provider of ['image2', 'doubao']) {
    const prompt = live2dPrepPrompt(provider);
    for (const phrase of ['零偏航、零俯仰、零歪头', '双眼自然睁开', '不换成通用模板脸', '鞋必须与对应小腿连续连接', '正面姿态不等于左右镜像']) assert.ok(prompt.includes(phrase));
    assert.equal(prompt.split('【V2：Live2D 正脸底图硬约束】').length, 2);
  }
});

test('Doubao follows fine-line soft 2D sample without costume shortening or fake alpha', () => {
  const prompt = live2dPrepPrompt('doubao');
  for (const phrase of ['细线条、柔和二维上色', '原本长裙必须保持长裙', '当前输入图才约束人物设计', '背景只输出均匀、无纹理的纯色极浅灰背景', '不画棋盘格']) {
    assert.ok(prompt.includes(phrase));
  }
  assert.ok(!prompt.includes('必须将渲染方式统一为平面二次元赛璐璐插画'));
  assert.ok(!prompt.includes('主色和 1–2 档'));
});

test('provider prompts are separate and queue/legacy route agree per provider', () => {
  const prompt = live2dPrepPrompt();
  for (const provider of ['doubao', 'image2']) {
    assert.equal(live2dPrepPrompt(provider), readFileSync(new URL(`../worker/app/prep_prompt_${provider}.txt`, import.meta.url), 'utf8').trim());
    assert.ok(readFileSync(new URL('../app/api/live2d-prep/route.ts', import.meta.url), 'utf8').includes(`live2dPrepPrompt('${provider}')`));
  }
  const image2 = live2dPrepPrompt('image2');
  assert.notEqual(prompt, image2);
  assert.ok(image2.includes('不强制转换成赛璐璐'));
  assert.ok(image2.includes('保留输入图本身已有的笔触'));
  assert.ok(image2.includes('输入图可以是半身或缺少部件'));
  assert.ok(!image2.includes('必须将渲染方式统一为平面二次元赛璐璐插画'));
  assert.throws(() => live2dPrepPrompt('unknown'));
  for (const obsolete of ['不强制转换成赛璐璐', '适度压低过强', '以输入图的原画风格为准', '材质与原画风格']) {
    assert.ok(!prompt.includes(obsolete));
  }
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
