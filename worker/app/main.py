"""A minimal, GPU-hosted executor for See-Through PSD decomposition.

The static GitHub Pages frontend submits an image to POST /jobs and polls
GET /jobs/{id}. The actual model stays on a machine controlled by the team.
"""

from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path
from typing import Literal

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

ROOT = Path(os.environ.get("MORPH_WORK_ROOT", "./workspace")).resolve()
SEE_THROUGH_REPO = Path(os.environ.get("SEE_THROUGH_REPO", "./see-through")).resolve()
PYTHON = os.environ.get("SEE_THROUGH_PYTHON", "python")
ALLOWED_ORIGINS = os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(",")
JOBS: dict[str, dict[str, str]] = {}

app = FastAPI(title="Morph See-Through Worker")
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["*"], allow_headers=["*"])


class JobStatus(BaseModel):
    id: str
    status: Literal["queued", "running", "succeeded", "failed"]
    output_psd: str | None = None
    error: str | None = None


def run_job(job_id: str, source: Path) -> None:
    job = JOBS[job_id]
    job["status"] = "running"
    try:
        command = [PYTHON, "inference/scripts/inference_psd.py", "--srcp", str(source), "--save_to_psd"]
        subprocess.run(command, cwd=SEE_THROUGH_REPO, check=True, capture_output=True, text=True, timeout=3600)
        output_dir = SEE_THROUGH_REPO / "workspace" / "layerdiff_output"
        candidates = sorted(output_dir.glob("*.psd"), key=lambda item: item.stat().st_mtime, reverse=True)
        if not candidates:
            raise RuntimeError("See-Through finished without producing a PSD")
        job.update(status="succeeded", output_psd=str(candidates[0]))
    except Exception as error:  # Surface the specific inference failure to the UI.
        job.update(status="failed", error=str(error))


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": SEE_THROUGH_REPO.exists()}


@app.post("/jobs", response_model=JobStatus, status_code=202)
async def create_job(background_tasks: BackgroundTasks, image: UploadFile = File(...), name: str = "character") -> JobStatus:
    if image.content_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(status_code=415, detail="Only PNG and JPEG input is supported")
    job_id = uuid.uuid4().hex
    job_dir = ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    suffix = ".png" if image.content_type == "image/png" else ".jpg"
    source = job_dir / f"{name}{suffix}"
    source.write_bytes(await image.read())
    JOBS[job_id] = {"status": "queued"}
    background_tasks.add_task(run_job, job_id, source)
    return JobStatus(id=job_id, status="queued")


@app.get("/jobs/{job_id}", response_model=JobStatus)
def get_job(job_id: str) -> JobStatus:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job")
    return JobStatus(id=job_id, **job)
