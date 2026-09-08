# Cubism 5.4 alpha 本机 Bridge

这是一条只绑定 `127.0.0.1:22033` 的本机连接，首个版本只读取当前打开的
CMO3 的参数、部件和变形器结构，不会调用编辑 API。

```sh
python3 -m venv cubism-bridge/.venv
cubism-bridge/.venv/bin/pip install -r cubism-bridge/requirements.txt
cubism-bridge/.venv/bin/python cubism-bridge/bridge.py --wait --keep-alive
```

启动后，在 Cubism 5.4 alpha 的「文件 → 外部应用程序集成的设置…」中允许
`Live2D Automation Workbench` 的普通访问权限。桥接器会持续保持连接，直到
Cubism 关闭或进程被停止。

## 编辑通道验证

在开启“编辑”权限后，可运行以下安全探针：

```sh
cubism-bridge/.venv/bin/python cubism-bridge/bridge.py --wait --probe-edit --keep-alive
```

它只执行 `EditBegin → EditSendLog → EditEnd(Cancel=true)`，不会修改模型，也不会
写入撤销历史。真实写入必须针对副本 CMO3，并由明确、具体的编辑命令触发。
