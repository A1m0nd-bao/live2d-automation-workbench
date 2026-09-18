# 普通 / Pro PSD 质检修复 v1

原则：修复优先，原件不覆盖，不自动触发重新生成。

共用配置为 `src/psdQuality.ts` 中 ana-ordinary-22-v1，来自用户提供的 seethrough_output (3).psd 实际排列。仅约束边界重叠的已知语义部件；这是一份人形角色参考，不是任意服装、头发、道具的通用视觉裁判。

普通 PSD 导入时自动执行，结果进入最终 morph-report.json 的 psdQuality 字段。Pro 合并基础层及各状态前执行，继续按目标槽位与严格像素一致性复用重复素材。未新增网页审核按钮或自动重生路径。

状态：structure_checked 为结构检查通过；repaired 为已自动修改顺序；needs_repair 为保留文件待进一步修复；unusable 为没有可见非空主体层。文件解析错误直接报错，不删除输入、不重生。以上都不是视觉成品验收通过。

目前自动修复仅包括安全同级图层排序、既有 Pro 精确重复槽位复用。跨组遮挡、蒙版、混合前后发、缺件、旧嘴残留、复杂服装例外均不猜着修改。needs_repair 会记入警告，可继续生成检查稿，但不能视作最终验收。不自动拆分、补图或改变像素。

输出可下载整理版 PSD 的本地批处理入口：

```
node scripts/quality-repair-psd.cjs INPUT.psd NEW_DIRECTORY ordinary
node scripts/quality-repair-psd.cjs INPUT.psd NEW_DIRECTORY pro
```

输出 normalized.psd 与 quality.json（含源文件哈希）；拒绝覆盖目录。该 CLI 只整理单份 PSD；多状态去重在 Pro 合并器执行。线上任务持久化异常队列、修复前后视觉对照、Pro 原生绑定验收仍待接入。

测试：`node --test tests/pro-psd-cleanup.test.cjs`，包括金标准原样不动、故意错序的脸/嘴恢复、像素不损失、复杂依赖保留、两模式不自动重生。
