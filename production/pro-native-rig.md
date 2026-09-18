# Pro 原生嘴部与九向流程

2026-09-16 接入版本：`pro-rig-v1`。

## 实际入口

Pro 任务的“生成 / 重新生成运行时包”会按顺序执行：

1. 当前 PSD 导出器生成角色自身的基础绑定和 AngleX × AngleY 3×3 九向关键形态。
2. `compileNative(..., 'pro-rig-v1')` 提交到本机 `/native-export/jobs?profile=pro-rig-v1`。
3. 后端从唯一独立 mouth 层读取位置，在自己的 mouth Warp 下合并口腔、舌头、上下嘴线；生成 12 个张嘴 × 嘴型组合关键形态。闭嘴保留原画嘴层。
4. 检查九向网格的参数、关键帧数和有效位移，不借用其他角色的头部或眼睛。
5. 编译原始基线和增强工程，用官方 Web Core 检查 2700 组转头、歪头、眨眼、开合、嘴型组合。
6. 检查无非有限坐标、新嘴网格无相对参考形态的三角翻转、闭口额外网格隐藏、复位无漂移、非嘴部几何与基线一致。数值通过后才发布运行包。
7. 前端保存增强 CMO3，替换工程包内的 CMO3，保存原始版本为 cmo-base，并把原生运行包接入原有交互预览。Pro 交付节点以 proRigPassed 和原生包同时存在为完成条件。

普通模式保持原编译路径。增强包包含 `enhanced.cmo3`、`model.moc3`、`model.model3.json`、贴图、`enhanced.integration.json` 与 `pro-verification.json`。接口按流程版本和输入内容分别缓存，旧服务不能被前端当成 Pro 完成。

## 本机运行

当前已更新常驻桥接 http://127.0.0.1:7861 ，本地新版工作台：
http://127.0.0.1:4173/live2d-automation-workbench/

```sh
npm run build:pages
npx vite preview --config vite.pages.config.ts --host 127.0.0.1 --port 4173 --strictPort
```

桥接依赖原有 MORPH_EXPORT_JAVA / MORPH_EXPORT_CLASSES / MORPH_CUBISM_LIBS，新增 MORPH_EXPORT_NODE（默认 PATH 中的 node）与 MORPH_CUBISM_WEB_CORE（官方 Web Core 本地文件绝对路径）。Node 需支持原生 CompressionStream，建议沿用项目要求的 Node 22+。

已有桌面桥接可通过 `python3 scripts/pro-rig/install-local.py --runtime <桥接目录> --core <官方 Web Core 文件>` 安装，脚本备份旧 native_export.py 和 run.sh，复制运行所需的本地依赖，不读取密钥。确认队列没有正在生图/拆分的任务后再重启常驻服务。公开网站未在本次发布；访问旧线上前端不会自动切换为新流程。

## 适用范围和边界

- 接入的是现有自动绑定导出器的九向生成，不是把神女 V15 的定制造型直接移植到所有角色。
- 独立 mouth 缺失、重复、合并为 mouth_nose，或 mouth Warp 含其他手工绑定时，会停止并保留原工程。支持规范 PSD 经当前导出器生成的工程，不承诺任意手工工程通用。
- 新嘴部使用通用柔和色嘴线和口腔，位置/比例取自输入。不同画风的颜色与嘴型仍需视觉调整。
- 保留原头部、眼睛、身体绑定；不加 V16 眼睛透视，也不加低头半蹲联动。
- 组合检查不能代替视觉验收；视觉状态始终标记 pending。本次未泛化此前对 Ana／神女进行的全部美术专项修正。

## 验证记录

- Ana 站立源工程、神女 V15 源工程、新生成的独立 512×512 测试工程均通过服务端完整链路，各 2700 组。
- 已对部署后的真实 7861 接口提交独立测试工程并下载验证增强工程、原生运行包与报告：`outputs/pro-rig-validation-20260916/deployed-relay-verification.json`。
- 自动测试：`node --test tests/native-export-relay.test.mjs`，`python -m unittest discover -s worker -p 'test_pro_*.py' -v`（使用已安装 FastAPI / httpx 的桥接虚拟环境）。
- AI 姿态模型下载增加 45 秒超时；超时使用既有图层骨架回退，并在报告中记录，避免网络故障卡住整个流程。
- 从实际 Pro 页面重新生成“Ana Pro 自动桥接验证 · 2026-09-14”：完成 PSD 导出、原生嘴部合并、2700 组组合检查、增强工程保存，网页自动加载 30 网格／34 参数模型。
- 前端生产构建通过。全仓 tsc 存在已有错误（NativeRuntimeViewer、proQueue 等），本次修改的 App/nativeExport 没有剩余类型错误。
