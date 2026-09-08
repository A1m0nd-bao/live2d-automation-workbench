"""Local-only bridge for Cubism Editor 5.4 alpha External App Integration.

The bridge intentionally starts in *read-only inspection* mode.  It never
calls EditBegin, EditEnd, or an editing API unless a future, explicit command
is added.  Its first job is to prove that Cubism and the automation workbench
can exchange the model's structure reliably.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import uuid
from pathlib import Path
from typing import Any

import websockets

VERSION = "1.1.0"
DEFAULT_URI = "ws://127.0.0.1:22033"
APP_NAME = "Live2D Automation Workbench"
STATE_DIR = Path.home() / "Library" / "Application Support" / "Live2DAutomationBridge"
TOKEN_FILE = STATE_DIR / "cubism-token.txt"


class CubismProtocolError(RuntimeError):
    pass


class CubismClient:
    def __init__(self, uri: str) -> None:
        self.uri = uri
        self.websocket: Any = None
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.receiver: asyncio.Task[None] | None = None

    async def __aenter__(self) -> "CubismClient":
        self.websocket = await websockets.connect(self.uri)
        self.receiver = asyncio.create_task(self._receive_loop())
        await self.register()
        return self

    async def __aexit__(self, *_: object) -> None:
        if self.receiver:
            self.receiver.cancel()
        if self.websocket:
            await self.websocket.close()

    async def _receive_loop(self) -> None:
        assert self.websocket is not None
        async for message in self.websocket:
            envelope = json.loads(message)
            request_id = envelope.get("RequestId")
            request = self.pending.pop(request_id, None)
            if not request:
                continue
            if envelope.get("Type") == "Error":
                request.set_exception(CubismProtocolError(json.dumps(envelope.get("Data", {}), ensure_ascii=False)))
            else:
                request.set_result(envelope.get("Data", {}))

    async def request(self, method: str, data: dict[str, Any] | None = None, timeout: float = 15) -> dict[str, Any]:
        assert self.websocket is not None
        request_id = uuid.uuid4().hex
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        await self.websocket.send(json.dumps({
            "Version": VERSION,
            "RequestId": request_id,
            "Type": "Request",
            "Method": method,
            "Data": data or {},
        }))
        try:
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(request_id, None)

    async def register(self) -> None:
        token = TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else ""
        result = await self.request("RegisterPlugin", {"Token": token, "Name": APP_NAME})
        received = result.get("Token")
        if isinstance(received, str) and received and received != token:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            TOKEN_FILE.write_text(received)
            os.chmod(TOKEN_FILE, 0o600)

    async def is_approved(self) -> bool:
        return bool((await self.request("GetIsApproval")).get("Result"))

    async def snapshot(self) -> dict[str, Any]:
        if not await self.is_approved():
            raise PermissionError(
                "Cubism 尚未允许本机 Bridge。请在「外部应用程序集成的设置」中允许 “Live2D Automation Workbench”。"
            )
        model_uid = (await self.request("GetCurrentModelUID")).get("ModelUID")
        if not isinstance(model_uid, str) or not model_uid:
            raise CubismProtocolError("Cubism 没有返回当前模型 UID；请先打开 CMO3。")
        parameter_structure, part_structure, deformer_structure = await asyncio.gather(
            self.request("GetParameterStructure", {"ModelUID": model_uid}),
            self.request("GetPartStructure", {"ModelUID": model_uid}),
            self.request("GetDeformerStructure", {"ModelUID": model_uid}),
        )
        return {
            "bridge": APP_NAME,
            "protocol": VERSION,
            "mode": "read-only",
            "modelUid": model_uid,
            "parameterStructure": parameter_structure,
            "partStructure": part_structure,
            "deformerStructure": deformer_structure,
        }


async def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect a currently open Cubism 5.4 alpha model without editing it.")
    parser.add_argument("--uri", default=DEFAULT_URI)
    parser.add_argument("--out", type=Path, default=Path.cwd() / "cubism-bridge" / "snapshots" / "cubism-model-structure.json")
    parser.add_argument("--wait", action="store_true", help="Keep waiting for the user to approve this bridge in Cubism.")
    args = parser.parse_args()

    while True:
        try:
            async with CubismClient(args.uri) as client:
                while not await client.is_approved():
                    if not args.wait:
                        raise PermissionError("等待 Cubism 授权。重新运行时加入 --wait，或先在 Cubism 授权。")
                    print("已连接 Cubism；等待普通访问授权…", flush=True)
                    await asyncio.sleep(1)
                snapshot = await client.snapshot()
            break
        except OSError:
            if not args.wait:
                raise
            print(f"等待 Cubism 在 {args.uri} 开启本机接口…", flush=True)
            await asyncio.sleep(1)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")
    print(f"已保存只读模型结构：{args.out}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except (OSError, PermissionError, CubismProtocolError) as error:
        raise SystemExit(f"Bridge 未完成：{error}")
