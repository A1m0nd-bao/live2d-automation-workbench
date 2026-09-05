# Morph Live2D Workbench

一个面向 Live2D 角色制作的轻量级生产工作台：将角色参考图提交到 See-Through 完成分层 PSD 拆分，再按 PSD 质检、Cubism 工程导出与运行时编译的顺序追踪交付状态。

> 适合个人创作者、小型团队和需要可追溯资产流程的 Live2D 实验项目。

![Frontend](https://img.shields.io/badge/frontend-React%2019-149eca?style=flat-square&logo=react&logoColor=white)
![Runtime](https://img.shields.io/badge/runtime-Node.js%2022-339933?style=flat-square&logo=node.js&logoColor=white)
![Relay](https://img.shields.io/badge/relay-FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)

## 项目亮点

- **端到端流程可视化**：从参考图、PSD、`.cmo3` 到 `.moc3 + model3.json`，每个阶段都有明确状态。
- **安全的异步拆分队列**：浏览器只调用自己的 API 路由，ModelScope Token 和 Relay Token 保存在服务端环境变量中。
- **可恢复任务**：Relay 使用 SQLite 保存任务状态和本地文件，服务重启后会恢复未完成任务。
- **可靠的产物校验**：下载 PSD 后会校验 Photoshop 文件签名，并保留私有诊断事件用于排查失败原因。
- **网页备用流程**：API Relay 未配置时，仍可从任务面板打开 See-Through 网页完成人工操作。

## 工作流

```text
角色参考图
    ↓
安全 API 代理
    ↓
ModelScope See-Through
    ↓
分层 PSD ──→ PSD 质检
                  ↓
              Stretchy Studio
                  ↓
                .cmo3
                  ↓
              Cubism Editor
                  ↓
        .moc3 + model3.json
```

## 技术架构

```text
React / Vite / GitHub Pages
            │
            ▼
      Edge API Route
            │  私密凭据
            ▼
 FastAPI Durable Relay
            │
            ├── SQLite 任务状态
            ├── /mnt/data 输入与输出
            └── Gradio SSE 长连接
                    │
                    ▼
          ModelScope See-Through
```

目录职责：

| 目录 | 用途 |
| --- | --- |
| `src/` | 工作台界面与任务交互 |
| `app/api/see-through/` | 前端到 Relay 的服务端 API 代理 |
| `worker/app/` | FastAPI Relay、队列恢复、SSE 监听与 PSD 下载 |
| `worker/test_relay.py` | Relay 的基础行为测试 |
| `worker/diagnose.py` | 带原始事件和 PSD 解析的真实诊断脚本 |

## 本地开发

### 启动前端

```bash
npm ci
npm run dev
```

随后打开终端显示的本地地址。若只需要生成 GitHub Pages 静态产物：

```bash
npm run build:pages
```

### 启动 Relay

```bash
cd worker
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export SEE_THROUGH_API_TOKEN="ms-..."
export MORPH_RELAY_TOKEN="replace-with-a-random-secret"
uvicorn app.main:app --host 0.0.0.0 --port 7860
```

前端 API 代理需要配置：

```text
SEE_THROUGH_RELAY_URL=https://your-relay.example.com
MORPH_RELAY_TOKEN=与 Relay 相同的随机密钥
MODELSCOPE_API_TOKEN=ModelScope API Token
```

不要将任何 Token 写入前端代码、提交到 Git，或发送给浏览器。

## 部署说明

- GitHub Pages 通过 `.github/workflows/deploy-pages.yml` 自动构建并发布 `docs/`。
- Relay 适合部署到支持持久化 `/mnt/data` 的 CPU-only ModelScope Studio。
- Relay 部署配置见 [`worker/ms_deploy.json`](worker/ms_deploy.json)。
- 生产环境请为 Relay 配置 HTTPS、持久化磁盘和强随机 `MORPH_RELAY_TOKEN`。

## 隐私与安全

- 参考图只在 API 提交时经服务端 Relay 转发，不会写入 GitHub Pages 前端。
- 上游访问凭据只从服务端环境变量读取，并在诊断日志中脱敏。
- Relay 只接受 PNG / JPEG 输入，并限制输出下载到受信任的上游文件路由。
- 浏览器端任务列表使用本地存储；请自行备份最终 PSD、CMO3 和 MOC3 资产。

## 当前边界

这个项目负责生产编排与任务追踪，不替代 Cubism Editor，也不在浏览器中执行 GPU 推理。最终 `.cmo3` 导出与 `.moc3` 编译仍需要 Stretchy Studio / Cubism Editor 完成。

## License

许可证信息请以仓库后续提交的根目录 `LICENSE` 文件为准；当前版本未包含根目录许可证文件。
