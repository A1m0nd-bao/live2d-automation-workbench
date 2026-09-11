# 两人协作约定

## 分支和发布

- `master`：稳定发布分支，合并会触发 GitHub Pages 部署。
- 每个任务一个短期分支，例如 `feat/model-preview`、`fix/queue-recovery`；Codex 创建的分支用 `codex/` 前缀。
- 完成后向 `master` 提 PR，由另一人审查；检查通过并批准后再合并。
- 不直接推送或强制推送 `master`。分支过期时合并最新 `master`，重新运行检查。
- 手动运行 Pages 工作流也只允许发布 `master`。PR 自动检查不部署、不读取服务密钥。
- Ana 修复在 `codex/ana-limb-fix`，仍需 Cubism 动态验收；不能因为自动测试通过就作为成品发布。

GitHub 主分支保护：1 人批准、更新代码后旧批准失效、分支与主线同步、`Tests and Pages build` 通过、讨论解决；管理员同样遵守，禁止强推与删除。

## 新同事开始开发

使用自己的 GitHub 账号接受仓库邀请，然后在自己的电脑操作：

```sh
git clone https://github.com/A1m0nd-bao/live2d-automation-workbench.git
cd live2d-automation-workbench
git switch -c feat/my-task
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

上面的新克隆默认远端名为 `origin`。维护者旧工作目录的 GitHub 远端叫 `github`，另有旧托管远端；推送前先 `git remote -v` 确认，勿向旧托管误推。

统一 Node 22，依赖使用锁文件。模型验收统一 Cubism 5.3.03；不要把 5.4 alpha 的结果与稳定版本混用。

```sh
node --test scripts/test-prep-policy.mjs tests/*.test.mjs
npm run build:pages
git add <本任务文件>
git commit -m "描述本次修改"
git push -u origin feat/my-task
```

在 GitHub 发起 PR。需要同步主线时，在干净工作目录中执行 `git fetch origin`、`git merge origin/master`，解决冲突并重新验证；不要覆盖他人的修改。

## 素材、密钥与协作边界

- `.env`、API key、生产令牌不提交、不写 PR；开发使用本地配置，CI 和部署配置由维护者管理。
- 不连接生产任务队列做破坏性测试。测试账户、测试数据和产物应与生产区分。
- 同一 PSD/CMO3 同时只由一人编辑；其他人另存副本。二进制模型不能依靠 Git 文本合并。
- 基准记录素材哈希、生成参数、代码提交号、Cubism 版本、已通过/未通过项目。
- PR 只提交本任务代码，不使用 `git add .` 把其他实验、素材、产物一起上传。
- 自动测试检查结构与构建；动态视觉、材质图集、moc3 导出和运行时兼容性仍需单独验收。

无需长期 `develop` 分支。任务验收合并后，可删除对应功能分支；不删除仍有未合并工作的分支。
