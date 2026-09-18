# Live2D MVP Character Contract

这是一个用于快速验证角色是否适合进入自动化动作链路的门禁工具，而不是自动绑定器。

它扫描运行时目录中的 `.model3.json`、`.cdi3.json`、已有 `.motion3.json` 与 `.physics3.json`，自动得到：

- `ready`：可跑基础对话、动作与情绪 MVP；
- `degraded`：可跑基础对话，但隐藏不安全的动作；
- `manual_review`：基础待机、眨眼或口型缺失，需要人工映射或修复。

## 使用

```bash
python3 character_contract.py /path/to/runtime-folder --preset gentle
```

写出该角色唯一需要人工确认的配置：

```bash
python3 character_contract.py /path/to/model3.json \
  --preset lively \
  --write-profile profiles/my-character.profile.json
```

配置符合 [`character-contract.schema.json`](character-contract.schema.json)。动作模板只读取 `parameterMap` 里的规范角色名，不能直接假设任意模型都有 `ParamAngleX` 一类 ID。

可参考已经通过扫描的 [`examples/hiyori.profile.json`](examples/hiyori.profile.json)。它把通用角色名（如 `headYaw`、`mouthOpen`）映射到 Hiyori 的实际参数；新角色只需改这一层，不改动作模板。

## 生产规则

1. 只让 `allowedActions` 中的动作出现在网页按钮或对话编排中。
2. `doNotAnimateDirectly` 中的参数是物理模拟输出；动作应驱动父级头/身体参数，不直接写它们。
3. `manual_review` 不自动生成动作。先修复或人工补足最小参数映射。
4. `degraded` 不是失败：它是低成本的角色类型，可保留待机、眨眼、说话并减少情绪按钮。

## 最低角色契约

| 能力 | 最少参数 | 作用 |
| --- | --- | --- |
| 待机 | 头部左右或上下 | 有轻微、可停留的存在感 |
| 眨眼 | 左右眼开合 | 避免静态凝视 |
| 对话 | 嘴巴开合 | 音量口型或文本节奏反馈 |
| 交互 | 头部上下 / 左右 | 点头和摇头 |
| 情绪 | 眼、嘴，最好加眉 | 开心、思考、惊讶等 |

基础循环（待机、眨眼、说话）不通过时，报告为 `manual_review`；复杂动作不会被硬凑。
