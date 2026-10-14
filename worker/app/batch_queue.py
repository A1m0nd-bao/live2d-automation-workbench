"""Durable batches using the same authenticated, globally serial split queue."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
import zipfile

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ID = re.compile(r"^[a-f0-9]{32}$")
MAX_IMAGE = 20 * 1024 * 1024


class SplitSettings(BaseModel):
    resolution: int = Field(default=1024, ge=768, le=1536)
    seed: int = Field(default=42, ge=0, le=9999)
    split_limbs: bool = True
    friendly: bool = True
    provider: str = Field(default='doubao', pattern='^(doubao|image2)$')
    upstream_route: str = Field(default='default', pattern='^(default|yangzxo)$')


class BatchItem(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=200)
    sha256: str
    reference_notes: str | None = Field(default=None, min_length=1, max_length=2000)


class BatchInput(BaseModel):
    id: str
    name: str = Field(default="批量拆件", min_length=1, max_length=120)
    settings: SplitSettings = Field(default_factory=SplitSettings)
    items: list[BatchItem] = Field(min_length=1, max_length=100)


class BatchRouteInput(BaseModel):
    upstream_route: str = Field(pattern='^(default|yangzxo)$')


class BatchPolicyInput(BaseModel):
    on_confirmed_failure: str = Field(pattern='^(pause|skip)$')


class BatchQueue:
    def __init__(self, root, authorize, split_create, split_get, prep=None):
        self.root = Path(root) / "batches"
        self.authorize = authorize
        self.split_create = split_create
        self.split_get = split_get
        self.prep = prep
        self.router = APIRouter(prefix="/batches")
        self.task = None
        self.routes()

    @contextmanager
    def db(self):
        self.root.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(self.root / "batches.sqlite3", timeout=10)
        con.row_factory = sqlite3.Row
        try:
            with con:
                con.execute("CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, state TEXT NOT NULL, created REAL NOT NULL)")
                con.execute("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, position INTEGER NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0)")
                con.execute("CREATE TABLE IF NOT EXISTS route_changes (batch_id TEXT NOT NULL, before_route TEXT NOT NULL, after_route TEXT NOT NULL, changed REAL NOT NULL)")
                con.execute("CREATE TABLE IF NOT EXISTS batch_policies (batch_id TEXT PRIMARY KEY, on_confirmed_failure TEXT NOT NULL, changed REAL NOT NULL)")
                con.execute("CREATE TABLE IF NOT EXISTS service_failure_acks (batch_id TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(batch_id,job_id))")
                yield con
        finally:
            con.close()

    def create(self, data):
        ids = [data.id, *[item.id for item in data.items]]
        if not all(ID.fullmatch(value) for value in ids) or len(set(ids)) != len(ids):
            raise HTTPException(422, "批次与文件编号必须唯一且为32位十六进制")
        for item in data.items:
            if not re.fullmatch(r"[a-f0-9]{64}", item.sha256) or not re.search(r"\.(png|jpe?g)$", item.name, re.I):
                raise HTTPException(422, "仅接受 PNG/JPEG，且必须提供原图校验值")
        manifest = json.dumps(data.model_dump(exclude_none=True), ensure_ascii=False, sort_keys=True)
        with self.db() as con:
            con.execute("BEGIN IMMEDIATE")
            old = con.execute("SELECT manifest FROM batches WHERE id=?", (data.id,)).fetchone()
            if old:
                previous = json.loads(old['manifest'])
                if 'upstream_route' not in previous['settings'] and data.settings.upstream_route == 'default':
                    current = json.loads(manifest)
                    current['settings'].pop('upstream_route', None)
                    manifest = json.dumps(current, ensure_ascii=False, sort_keys=True)
                if 'friendly' not in previous['settings'] and 'friendly' not in data.settings.model_fields_set:
                    legacy = data.model_dump(exclude_none=True)
                    legacy['settings'].pop('friendly', None)
                    legacy['settings'].pop('provider', None)
                    legacy['settings'].pop('upstream_route', None)
                    manifest = json.dumps(legacy, ensure_ascii=False, sort_keys=True)
                if old["manifest"] != manifest:
                    raise HTTPException(409, "相同批次编号的内容不一致")
            else:
                if data.settings.friendly and not self.prep:
                    raise HTTPException(503, '桥接尚未接入批量友好化；不会直接拆原图')
                if 'friendly' not in data.settings.model_fields_set:
                    raise HTTPException(409, '旧版工作台未明确友好化选项；请刷新并确认生图费用后创建新批次')
                if any(self.split_get(item.id) for item in data.items):
                    raise HTTPException(409, "文件编号已用于既有拆件任务")
                try:
                    con.execute("INSERT INTO batches VALUES (?,?,'uploading',?)", (data.id, manifest, time.time()))
                    con.executemany("INSERT INTO items (id,batch_id,position) VALUES (?,?,?)", [(item.id, data.id, i) for i, item in enumerate(data.items)])
                except sqlite3.IntegrityError:
                    raise HTTPException(409, "文件编号已用于其他批次")
        return self.read(data.id)

    @staticmethod
    def prep_id(item_id):
        return hashlib.sha256(('batch-neutral-master-v1:' + item_id).encode()).hexdigest()[:32]

    def friendly_job(self, item_id):
        if not self.prep:
            return None
        try:
            return self.prep.get(self.prep_id(item_id))
        except HTTPException as error:
            if error.status_code == 404:
                return None
            raise

    def read(self, batch_id):
        with self.db() as con:
            row = con.execute("SELECT * FROM batches WHERE id=?", (batch_id,)).fetchone()
            if not row:
                raise HTTPException(404, "批次不存在")
            uploaded = {item["id"]: bool(item["uploaded"]) for item in con.execute("SELECT * FROM items WHERE batch_id=?", (batch_id,))}
            policy = con.execute('SELECT on_confirmed_failure FROM batch_policies WHERE batch_id=?', (batch_id,)).fetchone()
        data = json.loads(row["manifest"])
        items = []
        for i, item in enumerate(data["items"]):
            job = self.split_get(item["id"])
            status = job["status"] if job else "pending" if uploaded[item["id"]] else "uploading"
            friendly = self.friendly_job(item['id']) if data['settings'].get('friendly', False) else None
            friendly_ok = bool(friendly and friendly['status'] == 'succeeded' and
                               (friendly.get('quality') or {}).get('status') == 'passed')
            message = (job.get('error') or job.get('message')) if job else '等待串行拆件' if uploaded[item['id']] else '等待上传'
            if not job and friendly:
                message = friendly.get('message') or '友好图未放行'
                status = ('pending' if friendly_ok else
                          'friendly-queued' if friendly['status'] == 'queued' else
                          'friendly-running' if friendly['status'] == 'running' else
                          'uncertain' if friendly['status'] == 'uncertain' else 'failed')
            safe_name = re.sub(r'[\\/\x00-\x1f:*?"<>|]', '_', item["name"]).rsplit('.', 1)[0]
            items.append({**item, "uploaded": uploaded[item["id"]], "status": status,
                          "message": message, 'friendly_ready': friendly_ok,
                          "filename": f"{i+1:03d}-{safe_name}.psd"})
        finished = sum(item["status"] in {"succeeded", "failed"} for item in items)
        data.update(items=items, state="completed" if finished == len(items) else row["state"], created_at=row["created"],
                    total=len(items), succeeded=sum(item["status"] == "succeeded" for item in items),
                    failed=sum(item["status"] == "failed" for item in items))
        data['friendly_succeeded'] = sum(item['friendly_ready'] for item in items)
        data['uncertain'] = sum(item['status'] == 'uncertain' for item in items)
        data['on_confirmed_failure'] = policy['on_confirmed_failure'] if policy else 'pause'
        return data

    def upload(self, batch_id, item_id, data):
        batch = self.read(batch_id)
        item = next((item for item in batch["items"] if item["id"] == item_id), None)
        if not item:
            raise HTTPException(404, "文件不属于该批次")
        if len(data) > MAX_IMAGE:
            raise HTTPException(413, "单张图片最大20 MB")
        if not (data.startswith(b"\x89PNG\r\n\x1a\n") or data.startswith(b"\xff\xd8\xff")):
            raise HTTPException(415, "图片格式无效")
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise HTTPException(409, "图片与批次清单不一致")
        directory = self.root / batch_id
        directory.mkdir(exist_ok=True)
        target = directory / f"{item_id}.source"
        temp = target.with_suffix(".tmp")
        temp.write_bytes(data)
        temp.replace(target)
        with self.db() as con:
            con.execute("UPDATE items SET uploaded=1 WHERE id=? AND batch_id=?", (item_id, batch_id))
        return self.read(batch_id)

    def control(self, batch_id, action):
        batch = self.read(batch_id)
        if batch["state"] == "completed":
            return batch
        if action == "start" and any(not item["uploaded"] for item in batch["items"]):
            raise HTTPException(409, "请先完成所有图片上传")
        acknowledged = [self.prep_id(item['id']) for item in batch['items']
                        if action == 'start' and (job := self.friendly_job(item['id']))
                        and job.get('blocked_provider')]
        with self.db() as con:
            con.execute("UPDATE batches SET state=? WHERE id=?", ("active" if action == "start" else "paused", batch_id))
            con.executemany('INSERT OR IGNORE INTO service_failure_acks VALUES (?,?)', [(batch_id, jid) for jid in acknowledged])
        return self.read(batch_id)

    def change_route(self, batch_id, route):
        if route not in {'default', 'yangzxo'}:
            raise HTTPException(422, '未知拆图线路')
        with self.db() as con:
            con.execute('BEGIN IMMEDIATE')
            row = con.execute('SELECT manifest,state FROM batches WHERE id=?', (batch_id,)).fetchone()
            if not row:
                raise HTTPException(404, '批次不存在')
            if row['state'] not in {'paused', 'uploading'}:
                raise HTTPException(409, '请先暂停批次再切换线路')
            manifest = json.loads(row['manifest'])
            if any(self.split_get(item['id']) for item in manifest['items']):
                raise HTTPException(409, '已有拆层任务的批次不可改线，避免重复提交或丢失原任务')
            before = manifest['settings'].get('upstream_route', 'default')
            if before != route:
                manifest['settings']['upstream_route'] = route
                con.execute('UPDATE batches SET manifest=? WHERE id=?',
                            (json.dumps(manifest, ensure_ascii=False, sort_keys=True), batch_id))
                con.execute('INSERT INTO route_changes VALUES (?,?,?,?)', (batch_id, before, route, time.time()))
        # Do not start the batch, clear quality gates or alter source/job IDs.
        return self.read(batch_id)

    def set_policy(self, batch_id, on_confirmed_failure):
        if on_confirmed_failure not in {'pause', 'skip'}:
            raise HTTPException(422, '未知失败策略')
        with self.db() as con:
            con.execute('BEGIN IMMEDIATE')
            row = con.execute('SELECT state FROM batches WHERE id=?', (batch_id,)).fetchone()
            if not row:
                raise HTTPException(404, '批次不存在')
            if row['state'] != 'paused':
                raise HTTPException(409, '请先暂停批次再确认失败处理方式')
            con.execute('INSERT INTO batch_policies VALUES (?,?,?) ON CONFLICT(batch_id) DO UPDATE SET on_confirmed_failure=excluded.on_confirmed_failure,changed=excluded.changed',
                        (batch_id, on_confirmed_failure, time.time()))
        # This is an explicit per-batch choice, not a global QA bypass or retry.
        return self.read(batch_id)

    def split_ready(self, batch_id):
        """Submit one already-approved output while paid generation stays paused."""
        batch = self.read(batch_id)
        if batch['state'] != 'paused' or not batch['settings'].get('friendly', False):
            raise HTTPException(409, '仅暂停中的友好化批次可单独拆分已通过结果')
        with self.db() as con:
            ids = [row['id'] for row in con.execute('SELECT id FROM batches')]
        if any(item['status'] in {'running', 'queued', 'friendly-running', 'friendly-queued', 'uncertain'}
               for other in ids for item in self.read(other)['items']):
            raise HTTPException(409, '已有运行中或结果未知的任务，不能重叠提交')
        item = next((i for i in batch['items'] if i['status'] == 'pending' and i['friendly_ready']), None)
        if not item:
            raise HTTPException(409, '没有尚未提交拆层且已通过质检的友好图')
        friendly = self.friendly_job(item['id'])
        source = self.prep.root / self.prep_id(item['id']) / 'output'
        if (not source.is_file() or
            hashlib.sha256(source.read_bytes()).hexdigest() != friendly['quality'].get('candidateSha256') or
            item['sha256'] != friendly['quality'].get('sourceSha256')):
            raise HTTPException(409, '质检记录与当前图片不一致，未提交拆层')
        settings = {key: batch['settings'][key] for key in ('resolution', 'seed', 'split_limbs')}
        settings['upstream_route'] = batch['settings'].get('upstream_route', 'default')
        self.split_create(item['id'], source, item['filename'], settings)
        return self.read(batch_id)

    async def advance(self):
        with self.db() as con:
            ids = [row["id"] for row in con.execute("SELECT id FROM batches WHERE state='active' ORDER BY created,id")]
            all_ids = [row["id"] for row in con.execute("SELECT id FROM batches WHERE state!='completed'")]
            acknowledged = {(row['batch_id'], row['job_id']) for row in con.execute('SELECT * FROM service_failure_acks')}
        active = {bid:self.read(bid) for bid in ids}
        blocked = {job['blocked_provider'] for bid,batch in active.items() for item in batch['items']
                   if (bid,self.prep_id(item['id'])) not in acknowledged
                   and (job := self.friendly_job(item['id'])) and job.get('blocked_provider')}
        if blocked:
            # All friendly generation uses Image2 for review, even when its
            # image generator is Doubao. Never reinterpret a service outage as
            # a skippable character QA failure. Running work is not cancelled.
            paused = [bid for bid,batch in active.items() if batch['settings'].get('friendly',False)
                      and ('image2' in blocked or batch['settings']['provider'] in blocked)]
            with self.db() as con:
                con.executemany("UPDATE batches SET state='paused' WHERE id=?",[(bid,) for bid in paused])
            return
        # Pausing future submissions does not make an in-flight/unknown job safe to overlap.
        if any(item["status"] in {"running", "queued", 'friendly-queued', 'friendly-running', 'uncertain'} for batch_id in all_ids for item in self.read(batch_id)["items"]):
            return
        # Never enqueue another batch item while a preceding item is in flight.
        for batch_id in ids:
            batch = self.read(batch_id)
            # A systematic prompt/review failure must not burn through the rest
            # of the paid batch. Keep candidates and await an explicit decision.
            if batch['on_confirmed_failure'] != 'skip' and batch['settings'].get('friendly', False) and any(
                not self.split_get(item['id']) and
                (friendly := self.friendly_job(item['id'])) and
                (friendly['status'] in {'needs-review', 'failed', 'uncertain'} or
                 (friendly['status'] == 'succeeded' and not item['friendly_ready']))
                for item in batch['items']
            ):
                self.control(batch_id, 'pause')
                return
            for item in batch["items"]:
                if item["status"] in {"succeeded", "failed"}:
                    continue
                if item["status"] == "pending":
                    source = self.root / batch_id / f"{item['id']}.source"
                    if batch['settings'].get('friendly', False):
                        friendly = self.friendly_job(item['id'])
                        if not friendly:
                            notes = {'reference_notes': item['reference_notes']} if item.get('reference_notes') else {}
                            self.prep.create(self.prep_id(item['id']), item['name'], batch['settings']['provider'], source.read_bytes(), **notes)
                            return
                        if not item['friendly_ready']:
                            return
                        source = self.prep.root / self.prep_id(item['id']) / 'output'
                    split_settings = {k: batch['settings'][k] for k in ('resolution', 'seed', 'split_limbs')}
                    if batch['settings'].get('upstream_route', 'default') != 'default':
                        split_settings['upstream_route'] = batch['settings']['upstream_route']
                    self.split_create(item["id"], source, item["filename"], split_settings)
                return
            with self.db() as con:
                con.execute("UPDATE batches SET state='completed' WHERE id=?", (batch_id,))

    async def start(self):
        with self.db():
            pass
        async def loop():
            while True:
                try:
                    await self.advance()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # Storage/service errors must not be interpreted as a new submission.
                    import logging
                    logging.exception("Batch scheduler could not advance")
                await asyncio.sleep(2)
        self.task = asyncio.create_task(loop())

    async def stop(self):
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

    def archive(self, batch_id):
        batch = self.read(batch_id)
        directory = self.root / batch_id
        directory.mkdir(exist_ok=True)
        target = directory / "results.zip"
        temporary = directory / "results.zip.tmp"
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            count = 0
            for item in batch["items"]:
                job = self.split_get(item["id"])
                if item["status"] == "succeeded" and job and job.get("output_psd"):
                    output = Path(job["output_psd"])
                    if not output.is_file() or output.read_bytes()[:6] != b"8BPS\x00\x01":
                        raise HTTPException(409, "成功记录缺少有效PSD，请检查服务端文件")
                    archive.write(output, item["filename"])
                    for report in ('psd-delivery.json', 'psd-delivery-upgrade.json'):
                        if (output.parent / report).is_file():
                            archive.write(output.parent / report, f'quality/{item["id"]}/{report}')
                    if item.get('friendly_ready'):
                        friendly_dir = self.prep.root / self.prep_id(item['id'])
                        suffix = '.png' if (friendly_dir / 'output').read_bytes().startswith(b'\x89PNG') else '.jpg'
                        archive.write(friendly_dir / 'output', 'friendly/' + item['filename'].replace('.psd', suffix))
                        for name in ('prompt.txt', 'identity-lock.json', 'quality.json'):
                            if (friendly_dir / name).is_file():
                                archive.write(friendly_dir / name, f'friendly/{item["id"]}/{name}')
                    count += 1
            if not count:
                raise HTTPException(409, "尚无完成的PSD")
            archive.writestr("manifest.json", json.dumps(batch, ensure_ascii=False, indent=2))
        temporary.replace(target)
        return target

    def routes(self):
        router = self.router
        def auth(relay, device):
            self.authorize(relay, device)

        @router.post("")
        async def create(data: BatchInput, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            return self.create(data)

        @router.get("")
        async def history(x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            with self.db() as con:
                ids = [row["id"] for row in con.execute("SELECT id FROM batches ORDER BY created DESC LIMIT 100")]
            return [self.read(batch_id) for batch_id in ids]

        @router.get("/{batch_id}")
        async def read(batch_id: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            return self.read(batch_id)

        @router.put("/{batch_id}/items/{item_id}")
        async def upload(batch_id: str, item_id: str, request: Request, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            data = bytearray()
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > MAX_IMAGE:
                    raise HTTPException(413, "单张图片最大20 MB")
            return self.upload(batch_id, item_id, bytes(data))

        @router.post("/{batch_id}/route")
        async def change_route(batch_id: str, data: BatchRouteInput, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            return self.change_route(batch_id, data.upstream_route)

        @router.post("/{batch_id}/split-ready")
        async def split_ready(batch_id: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            return self.split_ready(batch_id)

        @router.post("/{batch_id}/policy")
        async def policy(batch_id: str, data: BatchPolicyInput, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            return self.set_policy(batch_id, data.on_confirmed_failure)

        @router.post("/{batch_id}/{action}")
        async def control(batch_id: str, action: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            if action not in {"start", "pause"}:
                raise HTTPException(404, "未知操作")
            return self.control(batch_id, action)

        @router.get("/{batch_id}/output")
        async def output(batch_id: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            auth(x_relay_token, x_morph_device_token)
            return FileResponse(self.archive(batch_id), media_type="application/zip", filename=f"batch-{batch_id[:8]}.zip")
