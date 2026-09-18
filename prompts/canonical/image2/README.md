# Image-2 用户基准：未经用户明确要求不改写

归档日期：2026-09-10。

- `SKILL.md`：从用户提供的 `/Users/baotianrong/Downloads/SKILL (1).md` 原样复制，未改写。这是角色一致性工作规范，不是原样发送给图像 API 的短提示词。
- `prep_prompt_image2.txt`：实际生成 `outputs/provider-comparison-20260910/image2.png` 所用提示词的冻结副本。它是现有运行提示词，不冒称为附件全文。
- `references/character-bible-template.md`：附件引用的模板；附件未附此文件，因此从本机同名技能取得补充副本。主 SKILL 已核对与本机同名技能内容一致。
- 样式样本：`../../../outputs/provider-comparison-20260910/image2.png`（只约束绘制方式，不作为所有角色的身份参考）。

样本真实位置：`/Users/baotianrong/Documents/ChatGPT/live2d实践/outputs/provider-comparison-20260910/image2.png`。

## 权限与分工

Image-2 继续使用现有基准提示词；用户附件作为后续制作与验收依据保留，不把技能中的文件操作要求直接发送给图像模型。
禁止因豆包效果不佳而同时改动 Image-2。必须修改基准时，先取得用户明确方向，再新增版本并说明差异，不静默覆盖。

豆包独立维护 `worker/app/prep_prompt_doubao.txt`：根据样本提取细致线条、柔和明暗、自然比例和材质表达，不能学成粗线极简平涂或三维手办；保持参考角色的衣装长度和结构。使用纯浅灰背景，不请求模型绘制“透明效果”。
当前豆包接入仍只提交用户原图；上述样式通过文本约束实现，没有暗中把天使样本作为额外图片上传，也没有承诺两家模型会输出完全一致风格。

## 回归保护

`tests/live2d-prep.test.mjs` 校验附件与基准提示词的 SHA-256、运行模板与基准逐字一致，以及两家提供方模板分离。
本轮未进行新的付费生成；豆包新版的实际画风仍需下一次生成验证。
