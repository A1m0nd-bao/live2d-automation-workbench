"""Persistent, single-worker image queue. Never replay an uncertain paid call.

Run one uvicorn worker per data directory. Provider secrets stay server-side.
The scheduler owns calls independently of browser connections; SQLite and atomic
files survive refresh, disconnect and normal process restarts.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import subprocess
import getpass

import httpx
from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse

MAX_INPUT = 20 * 1024 * 1024
MAX_OUTPUT = 64 * 1024 * 1024
ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
PROMPT = (Path(__file__).with_name("prep_prompt.txt")).read_text()


class PrepQueue:
    def __init__(self, root: Path, authorize):
        self.root = root / "prep"
        self.authorize = authorize
        self.task = None
        self.router = APIRouter(prefix="/prep")
        self.routes()

    def db(self):
        self.root.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(self.root / "jobs.sqlite3", timeout=10)
        con.row_factory = sqlite3.Row
        return con

    def init(self):
        with self.db() as con:
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("""CREATE TABLE IF NOT EXISTS prep_jobs (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
                model TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
                message TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
                started_at REAL, finished_at REAL, output_mime TEXT, request_id TEXT
            )""")
            con.execute("CREATE INDEX IF NOT EXISTS idx_prep_jobs_status_created ON prep_jobs(status, created_at)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_prep_jobs_updated ON prep_jobs(updated_at)")

    def get(self, job_id):
        if not ID_PATTERN.fullmatch(job_id):
            raise HTTPException(400, "任务编号无效")
        with self.db() as con:
            row = con.execute("SELECT * FROM prep_jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "没有找到这个生图任务")
        return dict(row)

    def update(self, job_id, **fields):
        fields["updated_at"] = time.time()
        with self.db() as con:
            con.execute(f"UPDATE prep_jobs SET {','.join(k+'=?' for k in fields)} WHERE id=?", (*fields.values(), job_id))

    @staticmethod
    def config(provider):
        def secret(env, service):
            value = os.getenv(env, "")
            if value or os.getenv("MORPH_USE_KEYCHAIN") != "1":
                return value
            try:
                result = subprocess.run(["/usr/bin/security", "find-generic-password", "-a", getpass.getuser(), "-s", service, "-w"], capture_output=True, text=True, timeout=3)
                return result.stdout.strip() if result.returncode == 0 else ""
            except (OSError, subprocess.TimeoutExpired):
                return ""
        if provider == "doubao":
            return secret("VOLCENGINE_ARK_API_KEY", "morph-live2d-volcengine-ark-api-key"), os.getenv("VOLCENGINE_ARK_MODEL", "doubao-seedream-4-5-251128")
        if provider == "image2":
            return secret("AI_GATEWAY_API_KEY", "morph-live2d-ai-gateway-api-key"), os.getenv("IMAGE2_MODEL", "openai/gpt-image-2")
        raise HTTPException(400, "请选择豆包或 Image-2，不会自动切换提供方")

    def health(self):
        providers = {}
        for provider, env in (("doubao", "VOLCENGINE_ARK_API_KEY"), ("image2", "AI_GATEWAY_API_KEY")):
            key, model = self.config(provider)
            providers[provider] = {"ready": bool(key), "model": model,
                "message": "服务端已配置凭据（不代表余额和模型权限已验证）" if key else f"常驻服务尚未配置 {env}，请在服务端设置；无需登录旧网站。"}
        return {"ready": any(p["ready"] for p in providers.values()), "durable": True,
                "version": "prep-queue-v1", "providers": providers,
                "message": "常驻生图队列已连接；请查看所选提供方的配置状态。"}

    @staticmethod
    def mime(data):
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if data.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        raise ValueError("返回文件不是 PNG/JPEG 图片")

    def persist(self, job_id, filename, data):
        directory = self.root / job_id
        directory.mkdir(exist_ok=True)
        destination = directory / filename
        temporary = directory / (filename + ".tmp")
        with temporary.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(destination)

    def create(self, job_id, name, provider, data):
        if not ID_PATTERN.fullmatch(job_id):
            raise HTTPException(400, "任务编号无效")
        key, model = self.config(provider)
        try:
            self.mime(data)
        except ValueError:
            raise HTTPException(415, "请上传有效 PNG/JPEG")
        fingerprint = hashlib.sha256(provider.encode() + b"\0" + data).hexdigest()
        # Check idempotency BEFORE credentials: an existing job remains recoverable
        # even when the provider key has since expired or been removed.
        with self.db() as con:
            con.execute("BEGIN IMMEDIATE")
            existing = con.execute("SELECT * FROM prep_jobs WHERE id=?", (job_id,)).fetchone()
            if existing:
                if existing["fingerprint"] != fingerprint:
                    raise HTTPException(409, "这个任务编号已用于另一张图或另一提供方")
                return dict(existing)
            if not key:
                raise HTTPException(503, self.health()["providers"][provider]["message"])
            count = con.execute("SELECT COUNT(*) FROM prep_jobs WHERE status IN ('queued','running')").fetchone()[0]
            if count >= 20:
                raise HTTPException(429, "队列已满，请等待已有任务完成")
            self.persist(job_id, "source", data)
            self.persist(job_id, "prompt.txt", PROMPT.encode())
            now = time.time()
            con.execute("""INSERT INTO prep_jobs
                (id,name,provider,model,fingerprint,status,message,created_at,updated_at)
                VALUES (?,?,?,?,?,'queued','已保存到服务端，等待生图',?,?)""",
                (job_id, name[:120], provider, model, fingerprint, now, now))
        return self.get(job_id)

    async def start(self):
        self.init()
        with self.db() as con:
            interrupted = con.execute("SELECT id FROM prep_jobs WHERE status='running'").fetchall()
        for row in interrupted:
            output = self.root / row["id"] / "output"
            try:
                mime = self.mime(output.read_bytes())
            except (OSError, ValueError):
                self.update(row["id"], status="uncertain", finished_at=time.time(),
                    message="服务重启前已发起生图，但未保存到结果；上游是否完成或扣费未知，未自动重试。")
            else:
                self.update(row["id"], status="succeeded", output_mime=mime, finished_at=time.time(), message="已恢复服务端保存的生成结果")
        self.task = asyncio.create_task(self.loop())

    async def stop(self):
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

    async def loop(self):
        while True:
            with self.db() as con:
                row = con.execute("SELECT id FROM prep_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").fetchone()
            if row:
                await self.run(row["id"])
            else:
                await asyncio.sleep(1)

    async def generate(self, job, key):
        data = (self.root / job["id"] / "source").read_bytes()
        source = f"data:{self.mime(data)};base64,{base64.b64encode(data).decode()}"
        prompt = (self.root / job["id"] / "prompt.txt").read_text()
        headers = {"Authorization": f"Bearer {key}"}
        if job["provider"] == "doubao":
            url = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
            body = {"model": job["model"], "prompt": prompt, "image": [source],
                    "size": "1536x2400", "sequential_image_generation": "disabled",
                    "response_format": "b64_json", "watermark": False}
        else:
            # Match Vercel's official gateway-image-model.ts wire protocol,
            # not an assumed OpenAI-compatible /v1/images/edits endpoint.
            url = "https://ai-gateway.vercel.sh/v4/ai/image-model"
            headers.update({"ai-model-id": job["model"], "ai-image-model-specification-version": "4",
                            "ai-gateway-protocol-version": "0.0.1", "ai-gateway-auth-method": "api-key"})
            body = {"prompt": prompt, "n": 1, "size": "1536x2400",
                    "files": [{"type": "file", "mediaType": self.mime(data), "data": base64.b64encode(data).decode()}],
                    "providerOptions": {"openai": {"outputFormat": "png"}}}
        # No transport retries: reconnecting a paid synchronous call may charge twice.
        async with httpx.AsyncClient(timeout=httpx.Timeout(570, connect=20)) as client:
            response = await client.post(url, headers=headers, json=body)
        self.update(job["id"], request_id=response.headers.get("x-request-id"))
        if not response.is_success:
            # Do not persist raw provider bodies: they can contain credentials,
            # embedded input images, signed URLs or internal diagnostics.
            status = "uncertain" if response.status_code >= 500 else "failed"
            labels = {401: "生图凭据无效", 403: "无模型使用权限", 402: "额度或余额不足", 429: "达到服务限流或额度限制", 400: "模型拒绝了请求参数或输入"}
            self.update(job["id"], status=status, finished_at=time.time(),
                message=f"{labels.get(response.status_code, '上游生图服务异常')}（HTTP {response.status_code}）；未自动重试。")
            return None
        if len(response.content) > MAX_OUTPUT * 1.4:
            raise ValueError("生图返回体超过保存上限")
        if response.headers.get("content-type", "").split(";")[0] in ("image/png", "image/jpeg"):
            result = response.content
        else:
            payload = response.json()
            items = payload.get("images") if job["provider"] == "image2" else payload.get("data")
            encoded = (items[0] if job["provider"] == "image2" else items[0].get("b64_json")) if items else None
            if not isinstance(encoded, str):
                raise ValueError("服务未返回可保存的图片数据；未自动重试")
            result = base64.b64decode(encoded, validate=True)
        if len(result) > MAX_OUTPUT:
            raise ValueError("生成图片超过保存上限")
        self.mime(result)
        return result

    async def run(self, job_id):
        with self.db() as con:
            claimed = con.execute("UPDATE prep_jobs SET status='running',started_at=?,updated_at=?,message='服务端正在生图；关闭网页不影响任务' WHERE id=? AND status='queued'", (time.time(), time.time(), job_id)).rowcount
        if not claimed:
            return
        job = self.get(job_id)
        key, _ = self.config(job["provider"])
        if not key:
            self.update(job_id, status="failed", finished_at=time.time(), message="服务端生图凭据未配置；未提交上游")
            return
        try:
            data = await asyncio.wait_for(self.generate(job, key), timeout=600)
            if data is not None:
                self.persist(job_id, "output", data)
                self.update(job_id, status="succeeded", output_mime=self.mime(data), finished_at=time.time(),
                    message="生成图已保存，可查看和下载；尚未通过拆层验收")
        except (TimeoutError, httpx.TransportError):
            self.update(job_id, status="uncertain", finished_at=time.time(),
                message="生图请求超时或连接中断；上游结果及扣费状态未知，未自动重试。")
        except asyncio.CancelledError:
            # Running persists for start() to recover; never blindly re-submit.
            raise
        except Exception:
            self.update(job_id, status="uncertain", finished_at=time.time(),
                message="上游响应或结果保存异常，暂未取得可下载图片；未自动重试，请检查服务端任务。")

    def routes(self):
        def auth(relay, device):
            self.authorize(relay, device)

        @self.router.get("/health")
        async def health(x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            return self.health()

        @self.router.post("/jobs", status_code=202)
        async def create(image: UploadFile = File(...), job_id: str = Form(...), provider: str = Form(...), name: str = Form("character"), x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            data = await image.read(MAX_INPUT + 1)
            if len(data) > MAX_INPUT:
                raise HTTPException(413, "参考图最大 20 MB")
            return self.create(job_id, name, provider, data)

        @self.router.get("/jobs")
        async def history(x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            with self.db() as con:
                return [dict(row) for row in con.execute("SELECT * FROM prep_jobs ORDER BY updated_at DESC LIMIT 100")]

        @self.router.get("/jobs/{job_id}")
        async def status(job_id: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            return self.get(job_id)

        @self.router.get("/jobs/{job_id}/output")
        async def output(job_id: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            job = self.get(job_id)
            if job["status"] != "succeeded":
                raise HTTPException(409, "生成图尚未就绪")
            suffix = "png" if job["output_mime"] == "image/png" else "jpg"
            return FileResponse(self.root / job_id / "output", media_type=job["output_mime"], filename=f"generated-{job_id}.{suffix}", headers={"Cache-Control": "no-store"})
