# Cubism 5.4 alpha 本机 Bridge

这是一条只绑定 `127.0.0.1:22033` 的本机连接，首个版本只读取当前打开的
CMO3 的参数、部件和变形器结构，不会调用编辑 API。

```sh
python3 -m venv cubism-bridge/.venv
cubism-bridge/.venv/bin/pip install -r cubism-bridge/requirements.txt
cubism-bridge/.venv/bin/python cubism-bridge/bridge.py --wait
```

启动后，在 Cubism 5.4 alpha 的「文件 → 外部应用程序集成的设置…」中允许
`Live2D Automation Workbench` 的普通访问权限。编辑权限暂不申请；后续写入操作
必须先针对副本 CMO3 获得单独确认。
