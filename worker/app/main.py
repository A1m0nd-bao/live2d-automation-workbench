"""Durable relay for the ModelScope See-Through Gradio queue.

Run this on a small CPU-only ModelScope Studio. It keeps the upstream Gradio
SSE connection open, saves job state, and exposes a compact polling API.
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

import httpx
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

DATA_ROOT = Path(os.environ.get("MORPH_DATA_ROOT", "/mnt/data/morph-live2d")).resolve()
DB_PATH = DATA_ROOT / "jobs.sqlite3"
UPSTREAM = os.environ.get("SEE_THROUGH_URL", "https://studio-ljsabc-see-through.api-inference.modelscope.net").rstrip("/")
# ModelScope reserves MODELSCOPE_API_TOKEN for its internal SDK credential.
# Use a relay-specific secret so outbound inference receives the user's API token.
MODELSCOPE_TOKEN = os.environ.get("SEE_THROUGH_API_TOKEN", "")
RELAY_TOKEN = os.environ.get("MORPH_RELAY_TOKEN", "")
INFERENCE_RESOLUTION = int(os.environ.get("SEE_THROUGH_RESOLUTION", "1024"))
SPLIT_LIMBS = os.environ.get("SEE_THROUGH_SPLIT_LIMBS", "true").lower() in {"1", "true", "yes"}
MAX_ATTEMPTS = 3
ACTIVE: set[str] = set()


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


def db() -> sqlite3.Connection:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


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


def require_relay_token(x_relay_token: str | None) -> None:
    if RELAY_TOKEN and x_relay_token != RELAY_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid relay token")


def file_data(path: str, name: str, content_type: str) -> dict[str, Any]:
    return {"path": path, "orig_name": name, "mime_type": content_type, "meta": {"_type": "gradio.FileData"}}


def find_psd_output(value: Any) -> str | None:
    """Find the PSD file in Gradio's nested File/Gallery output payload.

    Different Gradio releases serialize a File component as a FileData object,
    a URL string, or inside a list.  The upstream endpoint also includes a
    preview gallery after the PSD, so inspect the full payload instead of
    assuming that the first item is the download file.
    """
    if isinstance(value, dict):
        for key in ("url", "path"):
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


def upstream_file_url(value: str) -> str:
    """Turn a FileData path into Gradio's authenticated download URL."""
    if value.startswith(("http://", "https://")):
        return value
    return f"{UPSTREAM}/gradio_api/file={quote(value, safe='/')}"


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
    try:
        source = DATA_ROOT / job_id / "source"
        if not source.exists():
            update_job(job_id, status="failed", message="原始参考图不存在", error="source image missing")
            return
        for attempt in range(1, MAX_ATTEMPTS + 1):
            update_job(job_id, status="queued", message="正在连接 See-Through 队列…", attempts=attempt, error=None)
            headers = {"Authorization": f"Bearer {MODELSCOPE_TOKEN}"}
            timeout = httpx.Timeout(connect=30, read=None, write=60, pool=30)
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    with source.open("rb") as handle:
                        upload = await client.post(f"{UPSTREAM}/gradio_api/upload", headers=headers, files={"files": (source.name, handle, "image/png")})
                    if not upload.is_success:
                        raise RuntimeError(await upstream_error(upload))
                    uploaded: Any = upload.json()
                    if isinstance(uploaded, list):
                        uploaded = uploaded[0] if uploaded else None
                    if isinstance(uploaded, dict):
                        uploaded = (uploaded.get("files") or uploaded.get("data") or [None])[0]
                    if not uploaded:
                        raise RuntimeError("See-Through did not return an uploaded file reference")
                    input_file = file_data(uploaded, source.name, "image/png") if isinstance(uploaded, str) else uploaded
                    call = await client.post(
                        f"{UPSTREAM}/gradio_api/call/inference",
                        headers={**headers, "Content-Type": "application/json"},
                        json={"data": [input_file, INFERENCE_RESOLUTION, 42, SPLIT_LIMBS]},
                    )
                    if not call.is_success:
                        raise RuntimeError(await upstream_error(call))
                    event_id = (call.json() or {}).get("event_id")
                    if not isinstance(event_id, str) or not event_id:
                        raise RuntimeError("See-Through did not return a Gradio event id")
                    update_job(job_id, status="running", message="See-Through 正在拆分图层…", queue_rank=None, queue_eta_seconds=None)
                    async with client.stream(
                        "GET",
                        f"{UPSTREAM}/gradio_api/call/inference/{event_id}",
                        headers={**headers, "Accept": "text/event-stream"},
                    ) as stream:
                        if not stream.is_success:
                            raise RuntimeError(await upstream_error(stream))
                        event_type = ""
                        async for line in stream.aiter_lines():
                            if line.startswith("event:"):
                                event_type = line[6:].strip()
                                continue
                            if not line.startswith("data:"):
                                continue
                            raw = line[5:].strip()
                            if not raw or raw == "null":
                                continue
                            if event_type == "complete":
                                output = json.loads(raw)
                                output_url = find_psd_output(output)
                                if not output_url:
                                    snapshot = json.dumps(output, ensure_ascii=False, default=str)[:1200]
                                    raise RuntimeError(f"See-Through completed without a PSD output: {snapshot}")
                                output_file = DATA_ROOT / job_id / "output.psd"
                                response = await client.get(upstream_file_url(output_url), headers=headers)
                                if not response.is_success:
                                    raise RuntimeError(await upstream_error(response))
                                output_file.write_bytes(response.content)
                                update_job(job_id, status="succeeded", message="PSD 已生成", output_psd=str(output_file), queue_rank=None, queue_eta_seconds=None)
                                return
                            if event_type == "error":
                                raise RuntimeError(f"See-Through returned an error: {raw}")
                raise RuntimeError("See-Through closed the event stream before completion")
            except Exception as error:
                if attempt == MAX_ATTEMPTS:
                    update_job(job_id, status="failed", message="See-Through 任务失败", error=str(error))
                else:
                    update_job(job_id, status="queued", message="连接中断，正在自动重试…", error=str(error))
                    await asyncio.sleep(2**attempt)
    finally:
        ACTIVE.discard(job_id)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    with db() as connection:
        recover = connection.execute("SELECT id FROM jobs WHERE status IN ('queued', 'running')").fetchall()
    for row in recover:
        asyncio.create_task(monitor(row["id"]))
    yield


app = FastAPI(title="Morph See-Through Relay", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, bool | str | int]:
    return {
        "ok": bool(MODELSCOPE_TOKEN),
        "upstream": UPSTREAM,
        "resolution": INFERENCE_RESOLUTION,
        "split_limbs": SPLIT_LIMBS,
    }


@app.post("/jobs", response_model=JobStatus, status_code=202)
async def create_job(image: UploadFile = File(...), name: str = "character", x_relay_token: str | None = Header(default=None)) -> JobStatus:
    require_relay_token(x_relay_token)
    if image.content_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(status_code=415, detail="Only PNG and JPEG input is supported")
    job_id = uuid.uuid4().hex
    job_dir = DATA_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    source = job_dir / "source"
    source.write_bytes(await image.read())
    with db() as connection:
        connection.execute("INSERT INTO jobs (id, name, status, message) VALUES (?, ?, 'queued', '已建立服务端任务')", (job_id, name[:120]))
    asyncio.create_task(monitor(job_id))
    return get_job(job_id)


@app.get("/jobs/{job_id}", response_model=JobStatus)
async def read_job(job_id: str, x_relay_token: str | None = Header(default=None)) -> JobStatus:
    require_relay_token(x_relay_token)
    return get_job(job_id)


@app.get("/jobs/{job_id}/output")
async def download_output(job_id: str, x_relay_token: str | None = Header(default=None)) -> FileResponse:
    require_relay_token(x_relay_token)
    job = get_job(job_id)
    if job.status != "succeeded" or not job.output_psd:
        raise HTTPException(status_code=409, detail="PSD is not ready")
    return FileResponse(job.output_psd, media_type="image/vnd.adobe.photoshop", filename=f"{job.name}.psd")
