# Morph Live2D 工作台：新同事本地部署与排障

核对日期：2026-09-14。适用 GitHub `master` 提交 `f8a7733`。

这份文档针对“从 GitHub 全新克隆”，不依赖原开发者的电脑、登录状态或钥匙串。命令按 macOS/Linux 的 Bash/Zsh 编写；Windows 可使用 WSL 跑前后端，Cubism 在 Windows 桌面单独打开文件。WSL 的浏览器到本机端口转发需另行核实。

## 1. 先弄清要启动哪些东西

| 环节 | 在哪里运行 | 需要什么 |
| --- | --- | --- |
| 工作台界面 | 浏览器、本地 Vite 或 GitHub Pages | Node 22.13+，建议统一 Node 22 |
| 豆包 / Image-2 生图 | Relay 调用外部 API | 对应提供方的有效 key、模型权限、余额 |
| See-Through 拆 PSD | Relay 调用 ModelScope 上游 | 独立的 `SEE_THROUGH_API_TOKEN` |
| 常驻任务、历史、文件下载 | Python Relay + SQLite + 本地文件 | Python 3.11（建议统一）、可写持久目录 |
| PSD → CMO3 | 浏览器内的导出器 | 合格 PSD；关节识别模型需要首次下载 |
| CMO3 → moc3 运行包 | Cubism Editor | 本项目统一使用 5.3.03 验收，所需许可证自行准备 |

**GitHub Pages 只托管前端，不会替你启动 Python 后端。GitHub 登录也不等于已经配置生图和 See-Through。**

先用“本地前端 + 本地 Relay”跑通最小闭环，再接共享服务。若仅导入已有 PSD 做本地 CMO3 生成，不需要先配置三个上游 API。

## 2. 克隆并建立自己的分支

```sh
git clone https://github.com/A1m0nd-bao/live2d-automation-workbench.git
cd live2d-automation-workbench
git switch -c feat/my-task
node --version
python3 --version
npm ci --ignore-scripts --no-audit --no-fund
```

把 `feat/my-task` 改成你的任务名。新克隆的 GitHub 远端叫 `origin`；原开发者旧目录的 GitHub 远端叫 `github`，不要混用。

当前 Ana 绑定修复在 `codex/ana-limb-fix`，尚不等于生产验收通过。如果专门协作这条修复，可在干净目录执行：

```sh
git fetch origin
git switch -c feat/my-ana-task origin/codex/ana-limb-fix
```

不要在有未提交修改时盲目切换、覆盖或重置分支。

## 3. 安装 Relay 依赖

在仓库根目录执行：

```sh
python3 -m venv worker/.venv
source worker/.venv/bin/activate
python -m pip install -r worker/requirements.txt fastapi 'uvicorn[standard]' python-dotenv
```

注意：核对版本的 `worker/requirements.txt` 只列了 `httpx`、`python-multipart`，不能只安装它就直接启动。本命令补上本地运行所需依赖；FastAPI 会带入 Pydantic。`python-dotenv` 用于后面的 `--env-file`。

首次启动不需要 CUDA、GPU，也不需要自行部署 See-Through 模型。不要先装实验抠图、原生编译相关依赖；先跑基础链路。

## 4. 配置后端：三个 API 各管各的

在编辑器中创建仓库根目录的 `.env.relay.local`，填入下面内容。它被现有 `.env*` 忽略规则排除，不要强制提交。

```dotenv
# 必填：浏览器访问你自己的 Relay 的设备凭据。
MORPH_DEVICE_TOKEN=替换为至少32字节随机值的十六进制文本

# 本地持久目录：下面启动命令从仓库根目录运行。
MORPH_DATA_ROOT=./worker/.local-state
MORPH_ALLOWED_ORIGINS=http://127.0.0.1:4173,http://localhost:4173,https://a1m0nd-bao.github.io
MORPH_LOCAL_BOOTSTRAP=0
MORPH_MAX_CONCURRENT_JOBS=1

# PNG/JPG → PSD 必填：ModelScope See-Through 上游 token。
SEE_THROUGH_API_TOKEN=替换为有效的ModelScope令牌
SEE_THROUGH_URL=https://studio-ljsabc-see-through.api-inference.modelscope.net
SEE_THROUGH_RESOLUTION=1024
SEE_THROUGH_SPLIT_LIMBS=true

# 只填要使用的提供方；不用的留空。两者都要使用才填两套。
VOLCENGINE_ARK_API_KEY=
VOLCENGINE_ARK_MODEL=doubao-seedream-4-5-251128
AI_GATEWAY_API_KEY=
IMAGE2_MODEL=openai/gpt-image-2
```

生成设备凭据（只生成随机值，不调用上游服务）：

```sh
python -c 'import secrets; print(secrets.token_hex(32))'
```

将输出粘贴进 `MORPH_DEVICE_TOKEN`，安全保存，不要发到聊天、截图或 PR。设备凭据可访问这个 Relay 的队列和文件，不是无权限的“连接码”。macOS/Linux 建议执行 `chmod 600 .env.relay.local`。

| 名称 | 从哪里准备 | 应该放哪里 |
| --- | --- | --- |
| `VOLCENGINE_ARK_API_KEY` | 你自己的火山方舟 API key，需开通对应生图模型 | 后端 `.env.relay.local` |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key；当前 Image-2 适配器走 Gateway | 后端 `.env.relay.local` |
| `SEE_THROUGH_API_TOKEN` | 自己的 ModelScope 访问令牌，并确认能调用该 Studio | 后端 `.env.relay.local` |
| `MORPH_DEVICE_TOKEN` | 自己随机生成 | 后端 + 网页“直连设置”，两边一致 |
| `MORPH_RELAY_TOKEN` | 仅旧的服务器到服务器代理路径需要 | 本文直连模式无需配置；不要给浏览器 |

普通 OpenAI `sk-...` key 不能作为当前 Gateway key 的直接替代。环境变量名也要完全一致：`DOUBAO_API_KEY` 或 `MODELSCOPE_TOKEN` 不会自动替代上表 Relay 读取的变量。

ModelScope 网页入口：[See-Through Studio](https://modelscope.cn/studios/ljsabc/See-Through)。网页能打开不等于 API token、权限和上游队列已验证。

**不要把任何上游 key 放进 `VITE_*`：Vite 变量可能进入公开前端代码。** 环境文件里的占位文字必须替换；非空占位文字也可能让健康检查误报“已配置”。

## 5. 启动 Relay（终端 A）

仍在仓库根目录，虚拟环境已激活：

```sh
python -m uvicorn app.main:app --app-dir worker --host 127.0.0.1 --port 7861 --workers 1 --env-file .env.relay.local
```

保持这个终端运行。不要加 `--reload`，不要启动多个进程共用一个数据目录。修改环境变量后，需要在没有任务运行时重启 Relay；单纯修改文件不会更新正在运行进程的配置。

`7861` 是网页“接入本机桥接”约定的端口。不要误用 README 云端示例里的 `7860`，除非你也手工更改网页直连地址。

本文关闭自动 bootstrap，优先使用下一节的手动设备凭据。如果仅在自己的电脑运行，可设置 `MORPH_LOCAL_BOOTSTRAP=1` 后重启，再点“接入本机桥接（免登录）”。该接口会向允许的 Origin 返回设备凭据，所以**只允许配合 `127.0.0.1` 监听，不得在共享/公网服务开启**。

## 6. 启动与线上一致的静态前端（终端 B）

在另一个终端进入同一仓库根目录：

```sh
npx vite --config vite.pages.config.ts --host 127.0.0.1 --port 4173 --strictPort
```

打开：<http://127.0.0.1:4173/live2d-automation-workbench/>

采用这条命令是为了对齐 Pages 入口和 CORS 端口。仓库的 `npm run dev` 是另一条 `vinext` 开发路径，不要把它的端口/API 行为与 Pages 静态入口混淆。

在网页找到“直连设置 / 直连常驻 Relay”：

- Relay 地址：`http://127.0.0.1:7861`
- 设备密钥：上一步自己的 `MORPH_DEVICE_TOKEN`
- 保存，然后检查服务。

不要填写 ModelScope Studio 网页地址或上游 inference 地址。直连地址必须是**你自己启动的 Relay**。

配置保存在当前浏览器、当前网站 Origin 的 localStorage。换电脑、浏览器，或从 `localhost` 换成 `127.0.0.1`，都要重新配置。`127.0.0.1` 永远指向当前浏览器所在的电脑，不会指向原开发者电脑。

旧提示文案仍可能说“直连只管拆分、生图需登录”；以当前实际调用为准，直连 Relay 已承载 `/prep` 生图队列。不要为了这个旧提示去配置 shehaoli 登录。

## 7. 按顺序验通，不要一次点完整链路猜原因

### 7.1 网络和上游凭据是否配置

```sh
curl --fail-with-body http://127.0.0.1:7861/health
```

应返回 JSON，`ok: true` 只表示 See-Through token **非空**，不是实时上游鉴权成功，也不证明额度充足。

### 7.2 验证设备凭据和提供方配置

在仓库根目录、Python 虚拟环境里执行；只输出健康状态，不输出 key，不提交付费任务：

```sh
python - <<'PY'
from dotenv import dotenv_values
import httpx
c = dotenv_values('.env.relay.local')
headers = {'X-Morph-Device-Token': c['MORPH_DEVICE_TOKEN']}
for endpoint in ('/prep/health', '/jobs?limit=1'):
    r = httpx.get('http://127.0.0.1:7861' + endpoint, headers=headers, timeout=10)
    print(endpoint, r.status_code)
    if endpoint == '/prep/health':
        print(r.json())
PY
```

`/prep/health` 中选用的 provider 应 `ready: true`；`/jobs` 应返回 200。未配置的另一家显示 false 是正常的。健康检查不调用生图，因此仍不能验证余额或实际模型访问权。

### 7.3 只验证 See-Through

准备一张自己有权使用、全身完整、四肢清楚的 PNG/JPG。在网页创建任务，明确勾选“已处理，跳过生图”。检查任务是否进入 See-Through 队列，最终能下载 PSD。该操作实际调用上游，可能消耗额度。

此步骤失败，就集中查 Relay 和 See-Through，先不要更换豆包/Image-2 key。

### 7.4 再验证生图 → PSD

创建新任务，取消跳过生图，只选择一个已配置 provider。先确认生图结果可下载、构图检查通过，再确认进入 See-Through。分别测试另一个 provider，不要一次连续提交很多图。

构图检查拒绝时应查看候选图，不要为追求自动流转绕过检查。`uncertain` 表示调用结果不确定，可能已经扣费，先查任务和输出再决定是否重试。

### 7.5 PSD → CMO3 → moc3

下载 PSD 后核对图层和预览，再生成 CMO3。首次关节模型下载需联网，失败可能降级为边界估计，不等于精确识别通过。

用 Cubism 5.3.03 打开 CMO3，检查默认姿势、左右肘/膝、鞋子跟随、动作切换，创建纹理图集后导出 moc3。保留 `model3.json` 引用的所有文件，包括纹理目录，以及模型实际需要的 physics、motion、expression 等文件；不要只发送一个 moc3。

**基础部署不承诺任意输入都能生成合格绑定，也不承诺克隆仓库后就能无人值守自动导出 moc3。**

## 8. Supabase / GitHub 登录不是第一阶段必填

本地直连、调用生成与拆分、处理已有 PSD，不要求先接入团队账本。需要团队项目、审核、权限时，再向维护者申请对应测试项目配置和授权；不要重复运行生产初始化 SQL。

前端公开配置的名称见 `config/production.env.example`：`VITE_SUPABASE_URL` 和 `VITE_SUPABASE_PUBLISHABLE_KEY`。禁止使用 secret/service_role key 替代 publishable key。启动/构建后修改前端环境变量需重新启动/构建。

## 9. 共享 Relay 与持续运行

- 新同事可使用维护者提供的 HTTPS Relay 根地址和专用设备凭据，无需在自己电脑重复运行后端；上游 API key 留在共享服务端。
- 不要把同事网页里的 `127.0.0.1` 当成你的服务器，也不要简单改成普通 HTTP 局域网 IP：当前前端只接受 HTTPS，或 loopback HTTP。
- CORS 白名单填写网页 Origin，例如 `https://a1m0nd-bao.github.io`，不加仓库路径和尾斜杠；变更后重启。
- 当前设备凭据不是每用户隔离的完整权限体系，持有人可以访问该 Relay 的任务/历史/产物。共享前确认数据访问范围，不开放成匿名公共服务。
- 本地模式关终端、关机或休眠会中断服务。生产常驻需独立进程管理和持久磁盘；本文终端命令不是开机自启配置。
- 保留整个 `MORPH_DATA_ROOT`，含 SQLite 和文件。最简单的备份方式是在队列空闲且服务停止时复制整个目录，避免只拷贝正在写入的数据库主文件。
- 已提交任务由 Relay 继续处理，但生图后的浏览器构图检查、后续提交以及浏览器内 CMO3 生成仍依赖网页恢复运行，不是全程无浏览器调度。

## 10. 常见卡点

| 现象 | 优先检查 |
| --- | --- |
| `No module named fastapi/uvicorn` | 第 3 节依赖是否安装在当前 Python 虚拟环境 |
| 写入 `/mnt/workspace` 失败 | 是否遗漏 `MORPH_DATA_ROOT`，是否通过 `--env-file` 载入配置 |
| 前端正常，但连接失败 | Relay 终端是否运行、端口是否 7861、浏览器是否连的是同一台电脑 |
| HTTP 401/403 来自 Relay | 网页设备凭据是否匹配；不要用上游 key 替代设备凭据 |
| `/health` 的 `ok` 为 false | `SEE_THROUGH_API_TOKEN` 缺失，配置后重启 |
| 生图可以，See-Through 卡住 | 上游 token、权限、队列、下载阶段；生图和拆分凭据彼此独立 |
| 上游 401/403 | 查看任务诊断，核实 ModelScope token/上游权限，不是 GitHub 登录问题 |
| 429、排队心跳、进度不变 | 上游限流/拥堵；保留任务 ID，不连续重提 |
| `See-Through emitted error: null` | 上游返回了失败事件，不要直接归因于登录；查看完整阶段诊断 |
| 任务成功但 PSD 下载失败 | 检查 Relay 的输出落盘及下载日志，不直接用 `ms.show` 网页文件链接代替 API 下载 |
| 浏览器 CORS / Failed to fetch | 地址协议、端口、Origin 白名单；浏览器本地网络访问提示；不要关闭安全保护 |
| 点击桥接提示没发现服务 | `/local-bootstrap` 默认关闭时请手动配置；不要为共享服务开启该接口 |
| 提示去旧网站登录 | 当前浏览器没有有效直连配置，或用了不同 Origin |
| `FileNotFoundError` 提示缺少 prompt/native_export | 混入了本地未提交版本；先比对分支和文件，不要随意删除 import 绕过 |
| `409` 生图冲突 | 同一 job ID 对应不同输入/provider；先恢复旧任务或创建真正的新任务 |
| 队列历史没了 | 数据目录或 Relay 地址变了，或只看了另一浏览器的本地缓存 |
| CMO3 有文件但动作错位 | 模型质量/绑定问题，不能靠改登录或重装前端解决 |

## 11. 提交前自检和反馈

```sh
node --test scripts/test-prep-policy.mjs tests/*.test.mjs
npm run build:pages
python -m unittest discover -s worker -p 'test_prep_queue.py' -v
python -m unittest discover -s worker -p 'test_relay.py' -v
git status --short
```

自动测试不证明真实外部服务和模型视觉验收通过。不要在生产服务仍使用同一数据目录时启动测试实例。

反馈故障时提供：分支和 `git rev-parse --short HEAD`、操作系统、Node/Python 版本、出错阶段、任务 ID、HTTP 状态码、脱敏后的错误文字。不要贴 `.env`、请求 Authorization/设备密钥或未脱敏的完整网络日志。

`master` 已保护：每个任务一个分支，提 PR，自动检查通过并由另一人批准后合并。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 12. 当前仓库与原开发电脑的版本差异

本次文档依据已拉取的 GitHub `master`，不是原开发电脑全部未提交工作。

- `master` 的生图提示词文件是 `worker/app/prep_prompt.txt`；本地实验版已经拆成两个 provider 文件。不要只复制 `prep_queue.py` 而遗漏它实际读取的模板。
- 本地 `/native-export` 编译器和环境路径不能视为克隆即用，需要单独的完整交付与兼容/许可核对。本指南先以 Cubism 手工导出为准。
- Ana 修复草稿 PR 的结构测试通过不等于整套动态验收通过，不应直接当稳定基线发布。

文档验证边界：已核对当前仓库入口、配置读取、路由和依赖文件；本次没有替新同事提交付费生图/拆分任务，也没有宣称其电脑已端到端跑通。
