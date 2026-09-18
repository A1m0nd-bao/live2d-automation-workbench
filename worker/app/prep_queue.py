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
import sys
from urllib.request import getproxies

import httpx
from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse

# These modules are also loaded directly by the lightweight local relay.
import importlib.util
_quality_spec = importlib.util.spec_from_file_location('morph_image_quality', Path(__file__).with_name('image_quality.py'))
_quality = importlib.util.module_from_spec(_quality_spec)
_quality_spec.loader.exec_module(_quality)
neutral_prompt = _quality.neutral_prompt
review = _quality.review
VERSION = _quality.VERSION

MAX_INPUT = 20 * 1024 * 1024
MAX_OUTPUT = 64 * 1024 * 1024
ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
PROMPTS = {
    provider: Path(__file__).with_name(f"prep_prompt_{provider}.txt").read_text()
    for provider in ("doubao", "image2")
}


def rejection_detail(response):
    """Publish only fixed labels, never provider messages or arbitrary fields."""
    try:
        payload = response.json()
    except (ValueError, UnicodeError):
        return ""
    labels = {
        "size": "输出尺寸", "image": "输入图片", "images": "输入图片",
        "files": "输入图片", "model": "模型", "prompt": "提示词",
        "output_format": "输出格式", "outputFormat": "输出格式",
        "background": "背景设置", "input_fidelity": "输入保真度",
        "n": "生成数量", "quality": "画质设置",
    }
    # Gateway may wrap the provider error under error/cause. Do not traverse
    # arbitrary input fields, copy messages, or retain raw response bodies.
    pending = [(payload, 0)]
    while pending:
        error, depth = pending.pop(0)
        if not isinstance(error, dict):
            continue
        code = error.get("code")
        if isinstance(code, str) and code in {"content_policy_violation", "moderation_blocked", "safety_violations"}:
            return "上游内容安全检查拒绝了本次请求"
        # Gateway can wrap OpenAI's rejection as AI_APICallError with no code
        # and an object-valued param. Recognize its message without publishing it.
        message = error.get("message")
        if isinstance(message, str) and "request was rejected by the safety system" in message.lower():
            if "safety_violations=[sexual]" in message.lower():
                return "上游内容安全检查拒绝了本次请求（性内容标记）"
            return "上游内容安全检查拒绝了本次请求"
        param = error.get("param")
        if isinstance(param, str) and param in labels:
            return f"上游指出需检查：{labels[param]}"
        if depth < 3:
            for field in ("error", "cause", "param"):
                pending.append((error.get(field), depth + 1))
    return ""


class PrepQueue:
    def __init__(self, root: Path, authorize, execution_slots=None):
        self.root = root / "prep"
        self.authorize = authorize
        self.execution_slots = execution_slots or asyncio.Semaphore(1)
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
        result = dict(row)
        report = self.root / job_id / 'quality.json'
        result['quality'] = json.loads(report.read_text()) if report.exists() else None
        if result['quality'] and result['quality'].get('version') != VERSION:
            result['quality'] = {**result['quality'], 'status': 'outdated', 'reasons': ['旧版检查未覆盖手部细节，需按新版复核后才能拆层']}
        return result

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

    def create(self, job_id, name, provider, data, *, prompt=None):
        if not ID_PATTERN.fullmatch(job_id):
            raise HTTPException(400, "任务编号无效")
        key, model = self.config(provider)
        try:
            self.mime(data)
        except ValueError:
            raise HTTPException(415, "请上传有效 PNG/JPEG")
        fingerprint = hashlib.sha256(provider.encode() + b"\0" + data + (b"\0" + prompt.encode() if prompt is not None else b"")).hexdigest()
        # Check idempotency BEFORE credentials: an existing job remains recoverable
        # even when the provider key has since expired or been removed.
        with self.db() as con:
            con.execute("BEGIN IMMEDIATE")
            existing = con.execute("SELECT * FROM prep_jobs WHERE id=?", (job_id,)).fetchone()
            if existing:
                if existing["fingerprint"] != fingerprint:
                    raise HTTPException(409, "这个任务编号已用于另一张图或另一提供方")
                return self.get(job_id)
            if not key:
                raise HTTPException(503, self.health()["providers"][provider]["message"])
            if not (key if provider == 'image2' else self.config('image2')[0]):
                raise HTTPException(503, '视觉检查凭据未配置；未发起生图，避免产生无法验收的图片')
            count = con.execute("SELECT COUNT(*) FROM prep_jobs WHERE status IN ('queued','running')").fetchone()[0]
            if count >= 20:
                raise HTTPException(429, "队列已满，请等待已有任务完成")
            self.persist(job_id, "source", data)
            self.persist(job_id, "prompt.txt", (prompt if prompt is not None else neutral_prompt()).encode())
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
                state_file = output.parent / 'generation-state.json'
                if state_file.exists() and json.loads(state_file.read_text()).get('pending'):
                    raise ValueError('Generation outcome unknown')
                mime = self.mime(output.read_bytes())
            except (OSError, ValueError):
                self.update(row["id"], status="uncertain", finished_at=time.time(),
                    message="服务重启前已发起生图，但未保存到结果；上游是否完成或扣费未知，未自动重试。")
            else:
                # Never turn an interrupted, unreviewed candidate into success.
                await self.review_saved(row["id"])

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
                async with self.execution_slots:
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
        proxy = (os.getenv('MORPH_IMAGE_REVIEW_PROXY') or getproxies().get('https')) if job['provider'] == 'image2' else None
        async with httpx.AsyncClient(timeout=httpx.Timeout(570, connect=20), proxy=proxy) as client:
            response = await client.post(url, headers=headers, json=body)
        self.update(job["id"], request_id=response.headers.get("x-request-id"))
        if not response.is_success:
            # Do not persist raw provider bodies: they can contain credentials,
            # embedded input images, signed URLs or internal diagnostics.
            status = "uncertain" if response.status_code >= 500 else "failed"
            labels = {401: "生图凭据无效", 403: "无模型使用权限", 402: "额度或余额不足", 429: "达到服务限流或额度限制", 400: "模型拒绝了请求参数或输入"}
            detail = rejection_detail(response) if response.status_code == 400 else ""
            self.update(job["id"], status=status, finished_at=time.time(),
                message=f"{labels.get(response.status_code, '上游生图服务异常')}（HTTP {response.status_code}）"
                        f"{'；' + detail if detail else ''}；未自动重试。")
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

    async def review_saved(self, job_id, finalize=True):
        directory = self.root / job_id
        candidate = (directory / 'output').read_bytes()
        try:
            key, _ = self.config('image2')
            result = await review((directory / 'source').read_bytes(), candidate, self.mime,
                                  key, (directory / 'prompt.txt').read_text())
        except Exception as error:
            result = {'version': VERSION, 'status': 'unavailable',
                      'reasons': [str(error) if isinstance(error, RuntimeError) else '视觉检查中断或响应无效；未放行拆层']}
        self.persist(job_id, 'quality.json', json.dumps(result, ensure_ascii=False).encode())
        if finalize:
            self.finish_review(job_id, result, candidate)
        return result

    def finish_review(self, job_id, result, candidate):
        passed = result['status'] == 'passed'
        self.update(job_id, status='succeeded' if passed else 'needs-review',
            output_mime=self.mime(candidate), finished_at=time.time(),
            message='生图视觉检查通过；可自动拆层，成品仍需人工验收' if passed else
                    '已阻止拆层：' + '；'.join(result.get('reasons') or ['完整性或一致性未通过']))

    async def normalize_candidate(self, job_id, result, attempt):
        checks = result.get('checks', {})
        # Never conceal a cropped body, drifted design or extra limb with padding.
        if result.get('status') != 'rejected' or set(checks) != set(_quality.CHECKS):
            return result
        if any(checks[k] != 'pass' for k in checks if k not in ('frame_margin', 'background')):
            return result
        directory = self.root / job_id
        self.persist(job_id, f'raw-quality-{attempt}.json', json.dumps(result, ensure_ascii=False).encode())
        self.persist(job_id, f'raw-{attempt}', (directory / 'output').read_bytes())
        target = directory / f'normalized-{attempt}'
        padding = '.125' if checks['frame_margin'] != 'pass' else '0'
        process = await asyncio.create_subprocess_exec(
            sys.executable, str(Path(__file__).with_name('foreground.py')),
            str(directory / f'raw-{attempt}'), str(target), '--padding-ratio', padding,
            env={**os.environ, 'OMP_NUM_THREADS': '2'},
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            await asyncio.wait_for(process.wait(), timeout=300)
        except TimeoutError:
            if process.returncode is None:
                process.kill()
                await process.wait()
            return result
        except BaseException:
            if process.returncode is None:
                process.kill()
                await process.wait()
            raise
        if process.returncode or not (target / 'submission.png').exists():
            return result  # Original rejected candidate remains blocked.
        self.persist(job_id, 'output', (target / 'submission.png').read_bytes())
        # Segmentation may damage halos/fingers: it must pass the full review again.
        return await self.review_saved(job_id, finalize=False)

    async def run(self, job_id):
        with self.db() as con:
            claimed = con.execute("UPDATE prep_jobs SET status='running',started_at=?,updated_at=?,message='服务端正在生图并进行视觉检查' WHERE id=? AND status='queued'", (time.time(), time.time(), job_id)).rowcount
        if not claimed:
            return
        job = self.get(job_id)
        key, _ = self.config(job["provider"])
        if not key:
            self.update(job_id, status="failed", finished_at=time.time(), message="服务端生图凭据未配置；未提交上游")
            return
        # Bound cost to two confirmed generations. Never retry uncertain calls.
        original_prompt = (self.root / job_id / 'prompt.txt').read_text()
        for attempt in range(1, 3):
            try:
                self.persist(job_id, 'generation-state.json', json.dumps({'attempt': attempt, 'pending': True}).encode())
                self.persist(job_id, f'prompt-{attempt}.txt', (self.root / job_id / 'prompt.txt').read_bytes())
                data = await asyncio.wait_for(self.generate(job, key), timeout=600)
                if data is None:
                    return
                self.persist(job_id, f'candidate-{attempt}', data)
                self.persist(job_id, 'output', data)
                self.persist(job_id, 'generation-state.json', json.dumps({'attempt': attempt, 'pending': False}).encode())
                result = await self.review_saved(job_id, finalize=False)
                result = await self.normalize_candidate(job_id, result, attempt)
                data = (self.root / job_id / 'output').read_bytes()
                self.persist(job_id, f'quality-{attempt}.json', json.dumps(result, ensure_ascii=False).encode())
                if result['status'] != 'rejected' or attempt == 2:
                    self.finish_review(job_id, result, data)
                    return
                correction = '\n本次必须修正：' + '；'.join(result.get('reasons') or [])
                # Always regenerate from the canonical source, never a drifted candidate.
                self.persist(job_id, 'prompt.txt', (original_prompt + correction).encode())
                self.update(job_id, status='running', message='首次结果质检未通过，正在按原因修正（最多两次，不提交拆层）')
            except (TimeoutError, httpx.TransportError):
                self.update(job_id, status="uncertain", finished_at=time.time(),
                    message="生图请求超时或连接中断；上游结果及扣费状态未知，未自动重试。")
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                self.update(job_id, status="uncertain", finished_at=time.time(),
                    message="上游响应或结果保存异常；未自动重试，请检查服务端任务。")
                return

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

        @self.router.post("/jobs/{job_id}/review")
        async def rereview(job_id: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            job = self.get(job_id)
            if job['status'] not in ('succeeded', 'needs-review'):
                raise HTTPException(409, '仅可复核已保存的完整结果')
            await self.review_saved(job_id)
            return self.get(job_id)

        @self.router.get("/jobs/{job_id}/output")
        async def output(job_id: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            job = self.get(job_id)
            if job["status"] not in ("succeeded", "needs-review"):
                raise HTTPException(409, "生成图尚未就绪")
            suffix = "png" if job["output_mime"] == "image/png" else "jpg"
            return FileResponse(self.root / job_id / "output", media_type=job["output_mime"], filename=f"generated-{job_id}.{suffix}", headers={"Cache-Control": "no-store"})
