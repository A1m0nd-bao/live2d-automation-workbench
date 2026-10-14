"""Durable relay for the ModelScope See-Through Gradio queue.

Run this on a small CPU-only ModelScope Studio. It keeps the upstream Gradio
SSE connection open, saves job state, and exposes a compact polling API.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sqlite3
import sys
import uuid
import importlib.util
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, urlsplit, unquote

import httpx
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

# ModelScope preserves /mnt/workspace across normal restarts and redeployments.
# Keep the queue database and PSDs there rather than on the ephemeral /mnt/data.
DATA_ROOT = Path(os.environ.get("MORPH_DATA_ROOT", "/mnt/workspace/morph-live2d")).resolve()
DB_PATH = DATA_ROOT / "jobs.sqlite3"
UPSTREAM = os.environ.get("SEE_THROUGH_URL", "https://studio-ljsabc-see-through.api-inference.modelscope.net").rstrip("/")
BACKUP_UPSTREAM = 'https://studio-yangzxo-see-through.api-inference.modelscope.net'
SPLIT_ROUTES = ('default', 'yangzxo')

def pin_split_route(directory: Path, route: str = 'default') -> None:
    if route not in SPLIT_ROUTES:
        raise HTTPException(422, '未知拆图线路')
    target = directory / 'upstream-route.json'
    if target.exists():
        return  # Existing tasks never move when defaults/settings change.
    target.write_text(json.dumps({'route': route, 'upstream': BACKUP_UPSTREAM if route == 'yangzxo' else UPSTREAM}))

def job_upstream(job_id: str) -> str:
    target = DATA_ROOT / job_id / 'upstream-route.json'
    if not target.exists():
        return UPSTREAM  # Historical jobs retain their previous behavior.
    value = json.loads(target.read_text())['upstream']
    if value != BACKUP_UPSTREAM and value != UPSTREAM:
        raise RuntimeError('Saved split route no longer matches configured trusted upstreams')
    return value
# Use an explicit, relay-specific secret for outbound inference.
MODELSCOPE_TOKEN = os.environ.get("SEE_THROUGH_API_TOKEN", "")
RELAY_TOKEN = os.environ.get("MORPH_RELAY_TOKEN", "")
# A revocable browser-facing key. This is intentionally separate from the
# relay-to-relay credential and from the ModelScope upstream API token.
DEVICE_TOKEN = os.environ.get("MORPH_DEVICE_TOKEN", "")
LOCAL_BOOTSTRAP = os.environ.get("MORPH_LOCAL_BOOTSTRAP", "").lower() in {"1", "true", "yes"}
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "MORPH_ALLOWED_ORIGINS",
        "https://a1m0nd-bao.github.io,https://morph-live2d-workbench.shehaoli.chatgpt.site,http://localhost:4173,http://127.0.0.1:4173",
    ).split(",")
    if origin.strip()
]
INFERENCE_RESOLUTION = int(os.environ.get("SEE_THROUGH_RESOLUTION", "1024"))
SPLIT_LIMBS = os.environ.get("SEE_THROUGH_SPLIT_LIMBS", "true").lower() in {"1", "true", "yes"}
MAX_ATTEMPTS = 3
MAX_CONCURRENT_JOBS = 1  # See-Through cannot tolerate parallel inference.
PROCESSING_SLOTS = asyncio.Semaphore(MAX_CONCURRENT_JOBS)
ACTIVE: set[str] = set()


async def prepare_foreground(job_id: str) -> Path:
    """Bounded subprocess, outside inference retries; never silently bypass failure."""
    directory = DATA_ROOT / job_id
    source = directory / "source"
    if not (directory / "foreground-request.json").exists():
        return source  # Legacy jobs keep their exact historical input.
    target = directory / "cutout"
    report_path = target / "report.json"
    if report_path.exists() and (target / "submission.png").exists():
        return target / "submission.png"
    update_job(job_id, status="running", message="正在本地分离角色与背景…", error=None)
    record_event(job_id, "foreground_start", model="isnet-anime")
    process = await asyncio.create_subprocess_exec(
        sys.executable, str(Path(__file__).with_name("foreground.py")), str(source), str(target),
        env={**os.environ, "OMP_NUM_THREADS": "2"},
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=300)
    except BaseException:
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise
    if process.returncode or not report_path.exists():
        raise RuntimeError("本地抠图失败；未提交拆层。" + stderr.decode(errors="replace")[-600:])
    record_event(job_id, "foreground_complete", report=json.loads(report_path.read_text()))
    return target / "submission.png"


class JobStatus(BaseModel):
    id: str
    name: str
    status: Literal["queued", "running", "succeeded", "failed"]
    message: str
    queue_rank: int | None = None
    queue_eta_seconds: float | None = None
    output_psd: str | None = None
    error: str | None = None
    attempts: int


class JobHistory(JobStatus):
    """A durable queue record, including the timestamps needed by clients."""

    created_at: str
    updated_at: str


@contextmanager
def db():
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def init_db() -> None:
    with db() as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
                message TEXT NOT NULL, queue_rank INTEGER, queue_eta_seconds INTEGER,
                output_psd TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )"""
        )


def row_to_job(row: sqlite3.Row) -> JobStatus:
    return JobStatus(**dict(row))


def row_to_history(row: sqlite3.Row) -> JobHistory:
    return JobHistory(**dict(row))


def get_job(job_id: str) -> JobStatus:
    with db() as connection:
        row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Unknown job")
    return row_to_job(row)


def update_job(job_id: str, **changes: Any) -> None:
    if not changes:
        return
    assignments = ", ".join(f"{column} = ?" for column in changes)
    with db() as connection:
        connection.execute(
            f"UPDATE jobs SET {assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (*changes.values(), job_id),
        )


def require_relay_token(
    x_relay_token: str | None,
    x_morph_device_token: str | None,
) -> None:
    """Allow the private proxy or one configured browser device, never both secrets interchangeably."""
    proxy_ok = bool(RELAY_TOKEN and x_relay_token and secrets.compare_digest(x_relay_token, RELAY_TOKEN))
    device_ok = bool(DEVICE_TOKEN and x_morph_device_token and secrets.compare_digest(x_morph_device_token, DEVICE_TOKEN))
    if proxy_ok or device_ok:
        return
    # Preserve existing local-development behavior only when no auth was
    # configured at all. Production documentation requires DEVICE_TOKEN.
    if not RELAY_TOKEN and not DEVICE_TOKEN:
        return
    raise HTTPException(status_code=401, detail="Invalid relay or device token")


def file_data(path: str, name: str, content_type: str) -> dict[str, Any]:
    return {"path": path, "orig_name": name, "mime_type": content_type, "meta": {"_type": "gradio.FileData"}}


def source_image_type(path: Path) -> tuple[str, str]:
    """Return the truthful Gradio MIME type and a usable filename suffix.

    The browser normally normalizes generated JPEGs to PNG before submitting,
    but the durable relay also accepts direct JPEG jobs.  Never label JPEG
    bytes as PNG: some Gradio versions defer validation until queue execution,
    where that mismatch can leave a job appearing to run indefinitely.
    """
    signature = path.read_bytes()[:8]
    if signature.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", ".png"
    if signature.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", ".jpg"
    raise RuntimeError("Source file is not a PNG or JPEG image")


def find_psd_output(value: Any) -> str | None:
    """Find the PSD file in Gradio's nested File/Gallery output payload.

    Different Gradio releases serialize a File component as a FileData object,
    a URL string, or inside a list.  The upstream endpoint also includes a
    preview gallery after the PSD, so inspect the full payload instead of
    assuming that the first item is the download file.
    """
    if isinstance(value, dict):
        for key in ("path", "url"):
            candidate = value.get(key)
            if isinstance(candidate, str) and ".psd" in candidate.lower():
                return candidate
        for nested in value.values():
            candidate = find_psd_output(nested)
            if candidate:
                return candidate
    elif isinstance(value, list):
        for nested in value:
            candidate = find_psd_output(nested)
            if candidate:
                return candidate
    elif isinstance(value, str) and ".psd" in value.lower():
        return value
    return None


def upstream_file_url(value: str, upstream: str | None = None) -> str:
    """Turn a FileData path into Gradio's authenticated download URL."""
    upstream = upstream or UPSTREAM
    browser_host = 'yangzxo-see-through.ms.show' if upstream == BACKUP_UPSTREAM else 'ljsabc-see-through.ms.show'
    if value.startswith(("http://", "https://")):
        parsed = urlsplit(value)
        if parsed.scheme == "https" and parsed.netloc == urlsplit(upstream).netloc:
            return value
        # Gradio may advertise a browser-facing Studio URL. Only translate
        # file routes belonging to this specific upstream; never send tokens
        # to an arbitrary URL in an inference response.
        if parsed.scheme == "https" and parsed.netloc == browser_host:
            if parsed.path.startswith(("/gradio_api/file=", "/file=")):
                value = unquote(parsed.path.split("file=", 1)[1])
            else:
                raise RuntimeError("Unsupported upstream download route")
        else:
            raise RuntimeError("Untrusted upstream download origin")
    elif value.startswith(("/gradio_api/file=", "/file=")):
        value = unquote(value.split("file=", 1)[1])
    return f"{upstream}/gradio_api/file={quote(value, safe='/')}"


def record_event(job_id: str, stage: str, **data: Any) -> None:
    """Keep diagnostics private and remove configured credentials."""
    entry = json.dumps({"stage": stage, **data}, ensure_ascii=False, default=str)
    for secret in (MODELSCOPE_TOKEN, RELAY_TOKEN):
        if secret:
            entry = entry.replace(secret, "[REDACTED]")
    with (DATA_ROOT / job_id / "events.jsonl").open("a") as handle:
        handle.write(entry + "\n")


async def upstream_error(response: httpx.Response) -> str:
    body = response.text
    try:
        parsed = response.json()
        if isinstance(parsed, dict) and isinstance(parsed.get("error") or parsed.get("message"), str):
            return parsed.get("error") or parsed.get("message")
    except ValueError:
        pass
    return body or f"Upstream returned HTTP {response.status_code}"


async def monitor(job_id: str) -> None:
    """Submit (or resubmit after restart) and own the upstream SSE connection."""
    if job_id in ACTIVE:
        return
    ACTIVE.add(job_id)
    acquired_slot = False
    try:
        await PROCESSING_SLOTS.acquire()
        acquired_slot = True
        source = DATA_ROOT / job_id / "source"
        if not source.exists():
            update_job(job_id, status="failed", message="原始参考图不存在", error="source image missing")
            return
        try:
            source = await prepare_foreground(job_id)
        except Exception as error:
            detail = str(error) or "本地抠图超时（300 秒）"
            record_event(job_id, "foreground_failure", error=detail)
            update_job(job_id, status="failed", message="抠图未通过，已停止拆层", error=detail)
            return
        batch_options_path = DATA_ROOT / job_id / 'batch-options.json'
        batch_options = json.loads(batch_options_path.read_text()) if batch_options_path.exists() else None
        upstream = job_upstream(job_id)
        record_event(job_id, 'route', upstream=upstream)
        if batch_options is None and (DATA_ROOT / job_id / 'upstream-route.json').exists():
            batch_options = {}  # New single jobs also use durable no-replay checkpoints.
        durable = batch_options is not None
        checkpoint = DATA_ROOT / job_id / 'batch-inference.json'
        for attempt in range(1, MAX_ATTEMPTS + 1):
            stage = "upload"
            terminal_error = False
            update_job(job_id, status="queued", message="正在连接 See-Through 队列…", attempts=attempt, error=None)
            headers = {"Authorization": f"Bearer {MODELSCOPE_TOKEN}"}
            timeout = httpx.Timeout(connect=30, read=90, write=60, pool=30)
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    saved = json.loads(checkpoint.read_text()) if durable and checkpoint.exists() else None
                    if saved:
                        if not saved.get('event_id'):
                            update_job(job_id, status='running', message='上游提交结果未知，批次已等待人工确认；不会重复提交', error='uncertain submission')
                            return
                        event_id = saved['event_id']
                    else:
                        source_mime, source_suffix = source_image_type(source)
                        source_name = f"source{source_suffix}"
                        with source.open("rb") as handle:
                            upload = await client.post(
                                f"{upstream}/gradio_api/upload", headers=headers,
                                files={"files": (source_name, handle, source_mime)},
                            )
                        if not upload.is_success:
                            raise RuntimeError(await upstream_error(upload))
                        uploaded: Any = upload.json()
                        if isinstance(uploaded, list):
                            uploaded = uploaded[0] if uploaded else None
                        if isinstance(uploaded, dict):
                            uploaded = (uploaded.get("files") or uploaded.get("data") or [None])[0]
                        if not uploaded:
                            raise RuntimeError("See-Through did not return an uploaded file reference")
                        input_file = file_data(uploaded, source_name, source_mime) if isinstance(uploaded, str) else uploaded
                        stage = "submit"
                        if durable:
                            checkpoint.write_text(json.dumps({'event_id': None}))
                        call = await client.post(
                            f"{upstream}/gradio_api/call/inference",
                            headers={**headers, "Content-Type": "application/json"},
                            json={"data": [input_file, (batch_options or {}).get('resolution', INFERENCE_RESOLUTION),
                                           (batch_options or {}).get('seed', 42), (batch_options or {}).get('split_limbs', SPLIT_LIMBS)]},
                        )
                        if not call.is_success:
                            if durable and call.status_code < 500:
                                checkpoint.unlink(missing_ok=True)
                            raise RuntimeError(await upstream_error(call))
                        event_id = (call.json() or {}).get("event_id")
                        if not isinstance(event_id, str) or not event_id:
                            raise RuntimeError("See-Through did not return a Gradio event id")
                        if durable:
                            checkpoint.write_text(json.dumps({'event_id': event_id}))
                        record_event(job_id, "submitted", attempt=attempt, event_id=event_id)
                    update_job(job_id, status="running", message="上游已接收，等待处理结果（可能仍在排队）", queue_rank=None, queue_eta_seconds=None)
                    stage = "listen"
                    deadline = asyncio.get_running_loop().time() + 1200
                    async with client.stream(
                        "GET",
                        f"{upstream}/gradio_api/call/inference/{event_id}",
                        headers={**headers, "Accept": "text/event-stream"},
                    ) as stream:
                        if not stream.is_success:
                            raise RuntimeError(await upstream_error(stream))
                        event_type = ""
                        async for line in stream.aiter_lines():
                            if asyncio.get_running_loop().time() > deadline:
                                raise TimeoutError("No terminal event within 20 minutes")
                            if line.startswith("event:"):
                                event_type = line[6:].strip()
                                continue
                            if not line.startswith("data:"):
                                continue
                            raw = line[5:].strip()
                            if not raw:
                                continue
                            record_event(job_id, "upstream_event", attempt=attempt, event=event_type, data=json.loads(raw))
                            if event_type == "error":
                                terminal_error = True
                                raise RuntimeError(f"See-Through emitted error: {raw}")
                            if event_type == "complete":
                                terminal_error = durable
                                output = json.loads(raw)
                                output_url = find_psd_output(output)
                                if not output_url:
                                    snapshot = json.dumps(output, ensure_ascii=False, default=str)[:1200]
                                    raise RuntimeError(f"See-Through completed without a PSD output: {snapshot}")
                                output_file = DATA_ROOT / job_id / "output.psd"
                                stage = "download"
                                download_url = upstream_file_url(output_url, upstream)
                                record_event(job_id, "download", url=download_url)
                                response = await client.get(download_url, headers=headers, timeout=120)
                                if not response.is_success:
                                    raise RuntimeError(await upstream_error(response))
                                if len(response.content) < 26 or response.content[:6] != b"8BPS\x00\x01":
                                    raise RuntimeError("Downloaded response is not a PSD file")
                                output_file.write_bytes(response.content)
                                update_job(job_id, status="succeeded", message="PSD 已生成", output_psd=str(output_file), queue_rank=None, queue_eta_seconds=None)
                                return
                raise RuntimeError("See-Through closed the event stream before completion")
            except Exception as error:
                detail = f"{stage}: {error}"
                record_event(job_id, "failure", attempt=attempt, error=detail)
                if durable and terminal_error:
                    update_job(job_id, status='failed', message='See-Through 已明确返回失败，批次继续下一张', error=detail)
                    return
                if attempt == MAX_ATTEMPTS:
                    if durable and checkpoint.exists():
                        update_job(job_id, status='running', message='已提交任务连接中断，保留任务等待恢复；不会重复推理', error=detail)
                    else:
                        update_job(job_id, status="failed", message="See-Through 任务失败", error=detail)
                else:
                    update_job(job_id, status="queued", message="上次尝试失败，准备重试…", error=detail)
                    await asyncio.sleep(2**attempt)
    finally:
        if acquired_slot:
            PROCESSING_SLOTS.release()
        ACTIVE.discard(job_id)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    await PREP.start()
    await PRO.start()
    with db() as connection:
        recover = connection.execute("SELECT id FROM jobs WHERE status IN ('queued', 'running')").fetchall()
    for row in recover:
        asyncio.create_task(monitor(row["id"]))
    try:
        await NATIVE_EXPORT.start()
        await BATCH.start()
        yield
    finally:
        await BATCH.stop()
        await PRO.stop()
        await PREP.stop()
        await NATIVE_EXPORT.stop()


app = FastAPI(title="Morph See-Through Relay", lifespan=lifespan)
# Load by file path as both ModelScope and the desktop use custom entrypoints.
_prep_spec = importlib.util.spec_from_file_location("morph_prep_queue", Path(__file__).with_name("prep_queue.py"))
_prep_module = importlib.util.module_from_spec(_prep_spec)
_prep_spec.loader.exec_module(_prep_module)


def require_prep_token(relay, device):
    if not RELAY_TOKEN and not DEVICE_TOKEN:
        raise HTTPException(503, "生图队列必须先配置服务端或设备访问凭据")
    require_relay_token(relay, device)


PREP = _prep_module.PrepQueue(DATA_ROOT, require_prep_token, PROCESSING_SLOTS)
app.include_router(PREP.router)

def pro_split_create(job_id, source, name):
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        if connection.execute('SELECT id FROM jobs WHERE id=?', (job_id,)).fetchone():
            return
        directory = DATA_ROOT / job_id
        directory.mkdir(exist_ok=True)
        (directory / 'source').write_bytes(source.read_bytes())
        (directory / 'foreground-request.json').write_text(json.dumps({'model': 'isnet-anime', 'background': '#d0d0d0', 'version': 1}))
        connection.execute("INSERT INTO jobs (id,name,status,message) VALUES (?,?,'queued','Pro 状态等待拆分')", (job_id, name))
    asyncio.create_task(monitor(job_id))

def pro_split_get(job_id):
    return get_job(job_id).model_dump()

def pro_split_path(job_id):
    job = get_job(job_id)
    if job.status != 'succeeded' or not job.output_psd:
        raise HTTPException(409, 'PSD 尚未就绪')
    return job.output_psd

_pro_spec = importlib.util.spec_from_file_location('morph_pro_queue', Path(__file__).with_name('pro_queue.py'))
_pro_module = importlib.util.module_from_spec(_pro_spec)
_pro_spec.loader.exec_module(_pro_module)
PRO = _pro_module.ProQueue(DATA_ROOT, PREP, require_prep_token, pro_split_create, pro_split_get, pro_split_path)
app.include_router(PRO.router)
app.include_router(PRO.poses.router)
_native_spec = importlib.util.spec_from_file_location("morph_native_export", Path(__file__).with_name("native_export.py"))
_native_module = importlib.util.module_from_spec(_native_spec)
_native_spec.loader.exec_module(_native_module)
NATIVE_EXPORT = _native_module.NativeExport(DATA_ROOT, require_prep_token)
app.include_router(NATIVE_EXPORT.router)

def batch_split_create(job_id, source, name, settings):
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        if not connection.execute('SELECT id FROM jobs WHERE id=?', (job_id,)).fetchone():
            directory = DATA_ROOT / job_id
            directory.mkdir(exist_ok=True)
            (directory / 'source').write_bytes(source.read_bytes())
            (directory / 'batch-options.json').write_text(json.dumps(settings))
            pin_split_route(directory, settings.get('upstream_route', 'default'))
            connection.execute("INSERT INTO jobs (id,name,status,message) VALUES (?,?,'queued','批次等待串行拆件')", (job_id, name))
    if job_id not in ACTIVE and get_job(job_id).status in {'queued', 'running'}:
        asyncio.create_task(monitor(job_id))

def batch_split_get(job_id):
    try:
        return get_job(job_id).model_dump()
    except HTTPException as error:
        if error.status_code == 404:
            return None
        raise

_batch_spec = importlib.util.spec_from_file_location('morph_batch_queue', Path(__file__).with_name('batch_queue.py'))
_batch_module = importlib.util.module_from_spec(_batch_spec)
sys.modules[_batch_spec.name] = _batch_module
_batch_spec.loader.exec_module(_batch_module)
BATCH = _batch_module.BatchQueue(DATA_ROOT, require_prep_token, batch_split_create, batch_split_get, PREP)
app.include_router(BATCH.router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Content-Type", "X-Relay-Token", "X-Morph-Device-Token"],
    expose_headers=["Content-Disposition"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": bool(MODELSCOPE_TOKEN),
        "upstream": UPSTREAM,
        "resolution": INFERENCE_RESOLUTION,
        "split_limbs": SPLIT_LIMBS,
        "version": "stage-diagnostics-v1",
        "split_routes": list(SPLIT_ROUTES),
    }


@app.get("/local-bootstrap")
async def local_bootstrap(origin: str | None = Header(default=None)) -> dict[str, str]:
    """One-click browser setup, available only from the loopback desktop bridge."""
    if not LOCAL_BOOTSTRAP or not DEVICE_TOKEN or origin not in ALLOWED_ORIGINS:
        raise HTTPException(status_code=404, detail="Local bootstrap is unavailable")
    return {"deviceToken": DEVICE_TOKEN}


@app.get("/local-models/dwpose")
async def local_dwpose(x_morph_device_token: str | None = Header(default=None)):
    if not LOCAL_BOOTSTRAP:
        raise HTTPException(404, "Local models are unavailable")
    require_prep_token(None, x_morph_device_token)
    model = Path(os.environ.get("MORPH_DWPOSE_MODEL", str(Path.home() / ".morph-local-relay/models/dw-ll_ucoco_384.onnx")))
    if not model.is_file() or model.stat().st_size != 134399116:
        raise HTTPException(404, "Validated local DWPose model is unavailable")
    return FileResponse(model, media_type="application/octet-stream")


@app.post("/jobs", response_model=JobStatus, status_code=202)
async def create_job(image: UploadFile = File(...), name: str = "character", foreground: bool = False, route: Literal['default', 'yangzxo'] = 'default', x_relay_token: str | None = Header(default=None), x_morph_device_token: str | None = Header(default=None)) -> JobStatus:
    require_relay_token(x_relay_token, x_morph_device_token)
    if image.content_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(status_code=415, detail="Only PNG and JPEG input is supported")
    job_id = uuid.uuid4().hex
    job_dir = DATA_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    pin_split_route(job_dir, route)
    source = job_dir / "source"
    source.write_bytes(await image.read())
    if foreground:
        (job_dir / "foreground-request.json").write_text(json.dumps({"model": "isnet-anime", "background": "#d0d0d0", "version": 1}))
    with db() as connection:
        connection.execute("INSERT INTO jobs (id, name, status, message) VALUES (?, ?, 'queued', '已建立服务端任务')", (job_id, name[:120]))
    asyncio.create_task(monitor(job_id))
    return get_job(job_id)


@app.get("/jobs", response_model=list[JobHistory])
async def list_jobs(limit: int = 40, x_relay_token: str | None = Header(default=None), x_morph_device_token: str | None = Header(default=None)) -> list[JobHistory]:
    """Return recent queue records so a fresh browser can recover its history."""
    require_relay_token(x_relay_token, x_morph_device_token)
    safe_limit = min(max(limit, 1), 100)
    with db() as connection:
        rows = connection.execute(
            "SELECT * FROM jobs ORDER BY updated_at DESC, created_at DESC LIMIT ?",
            (safe_limit,),
        ).fetchall()
    return [row_to_history(row) for row in rows]


@app.post('/jobs/{job_id}/retry-upload', response_model=JobStatus, status_code=202)
async def retry_upload(job_id: str, retry_id: str, route: Literal['default','yangzxo'] = 'default', x_relay_token: str | None = Header(default=None), x_morph_device_token: str | None = Header(default=None)):
    require_relay_token(x_relay_token, x_morph_device_token)
    if not all(len(value)==32 and all(c in '0123456789abcdef' for c in value) for value in [job_id,retry_id]):
        raise HTTPException(422,'无效任务编号')
    old = get_job(job_id)
    previous = DATA_ROOT / job_id
    # An upload-stage failure is safe to resubmit: inference was never called.
    # Never move a queued/running/ambiguous/completed inference to another route.
    if old.status != 'failed' or not (old.error or '').startswith('upload:') or (previous / 'batch-inference.json').exists():
        raise HTTPException(409,'只允许恢复明确在上传阶段失败的任务；已提交或结果未知的推理不会重跑。')
    events = previous / 'events.jsonl'
    if events.exists() and any(json.loads(line).get('stage')=='submitted' for line in events.read_text().splitlines() if line.strip()):
        raise HTTPException(409,'此任务已有推理提交记录，不能切线重跑。')
    target = DATA_ROOT / retry_id
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        existing=connection.execute('SELECT id FROM jobs WHERE id=?',(retry_id,)).fetchone()
        marker={'parent':job_id,'route':route}
        if existing:
            if not (target / 'retry-parent.json').exists() or json.loads((target / 'retry-parent.json').read_text())!=marker:
                raise HTTPException(409,'恢复编号已用于其他任务')
        else:
            target.mkdir(exist_ok=False)
            (target / 'source').write_bytes((previous / 'source').read_bytes())
            (target / 'retry-parent.json').write_text(json.dumps(marker))
            for name in ['foreground-request.json','batch-options.json']:
                if (previous / name).exists(): (target / name).write_bytes((previous / name).read_bytes())
            pin_split_route(target,route)
            connection.execute("INSERT INTO jobs (id,name,status,message) VALUES (?,?,'queued','已复用保存图片，等待备用线路上传')",(retry_id,old.name))
    if get_job(retry_id).status in ('queued','running') and retry_id not in ACTIVE:
        asyncio.create_task(monitor(retry_id))
    return get_job(retry_id)


@app.get("/jobs/{job_id}", response_model=JobStatus)
async def read_job(job_id: str, x_relay_token: str | None = Header(default=None), x_morph_device_token: str | None = Header(default=None)) -> JobStatus:
    require_relay_token(x_relay_token, x_morph_device_token)
    return get_job(job_id)


@app.get("/jobs/{job_id}/source")
async def download_source(job_id: str, x_relay_token: str | None = Header(default=None), x_morph_device_token: str | None = Header(default=None)) -> FileResponse:
    """Return the actual Live2D-friendly image submitted to See-Through."""
    require_relay_token(x_relay_token, x_morph_device_token)
    job = get_job(job_id)
    path = DATA_ROOT / job_id / "source"
    prepared = DATA_ROOT / job_id / "cutout/submission.png"
    if prepared.exists() and prepared.with_name("report.json").exists():
        path = prepared
    if not path.exists():
        raise HTTPException(status_code=404, detail="Submitted source image is not available")
    content_type, suffix = source_image_type(path)
    return FileResponse(
        path,
        media_type=content_type,
        filename=f"{job.name}-live2d-input{suffix}",
    )


@app.get("/jobs/{job_id}/foreground")
async def download_foreground(job_id: str, x_relay_token: str | None = Header(default=None), x_morph_device_token: str | None = Header(default=None)) -> FileResponse:
    require_relay_token(x_relay_token, x_morph_device_token)
    get_job(job_id)
    path = DATA_ROOT / job_id / "cutout/foreground.png"
    if not path.exists():
        raise HTTPException(404, "Foreground image is not ready")
    return FileResponse(path, media_type="image/png", filename="foreground.png")


@app.get("/jobs/{job_id}/output")
async def download_output(job_id: str, x_relay_token: str | None = Header(default=None), x_morph_device_token: str | None = Header(default=None)) -> FileResponse:
    require_relay_token(x_relay_token, x_morph_device_token)
    job = get_job(job_id)
    if job.status != "succeeded" or not job.output_psd:
        raise HTTPException(status_code=409, detail="PSD is not ready")
    return FileResponse(job.output_psd, media_type="image/vnd.adobe.photoshop", filename=f"{job.name}.psd")


@app.get("/jobs/{job_id}/diagnostics")
async def diagnostics(job_id: str, x_relay_token: str | None = Header(default=None), x_morph_device_token: str | None = Header(default=None)) -> FileResponse:
    require_relay_token(x_relay_token, x_morph_device_token)
    get_job(job_id)
    path = DATA_ROOT / job_id / "events.jsonl"
    if not path.exists():
        raise HTTPException(status_code=404, detail="No diagnostics yet")
    return FileResponse(path, media_type="application/x-ndjson", filename="events.jsonl")
