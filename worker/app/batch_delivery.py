"""Durable hand-off from base PSDs to PSD-first action variants.

No base regeneration, no state See-Through calls, no implicit paid retries.
Base counts and delivery counts deliberately have different meanings.
"""
import asyncio
import hashlib
import json
import re
from pathlib import Path
import time
import zipfile

from fastapi import HTTPException

POSES = {
    'action_02_wave_arms_only', 'action_03_hand_on_hip_arms_only',
    'action_04_arms_crossed_crossed_arms', 'action_05_thinking_arms_only',
    'action_07_palm_up_arms_only', 'action_08_clenched_fist_arms_only',
}


class BatchDelivery:
    def __init__(self, batch, poses):
        self.batch, self.poses = batch, poses

    def configure(self, bid, states, provider, start=False, base_jobs=None):
        batch = self.batch.read(bid)
        if not self.poses:
            raise HTTPException(503, 'Relay 尚未安装 PSD 多状态队列；不会退回整图拆件')
        if (not isinstance(states, list) or not states or len(states) > 6 or
            any(not isinstance(s, str) or s not in POSES for s in states) or len(set(states)) != len(states)):
            raise HTTPException(422, '请选择 1–6 个受支持的完整手臂动作；嘴部与表情不在此生图阶段修改')
        if provider not in ('image2', 'doubao'):
            raise HTTPException(422, '未知部件生图提供方')
        base_jobs = base_jobs or {}
        source_hashes = {i['id']: i['sha256'] for i in batch['items']}
        with self.batch.db() as con:
            all_sources = {i['id']: i['sha256'] for row in con.execute('SELECT manifest FROM batches') for i in json.loads(row[0])['items']}
        for item_id, job_id in base_jobs.items():
            if (item_id not in source_hashes or not re.fullmatch('[a-f0-9]{32}', job_id) or
                all_sources.get(job_id) != source_hashes[item_id]):
                raise HTTPException(409, '恢复基础 PSD 必须属于同一原图校验值；不能按文件名猜角色')
            job = self.batch.split_get(job_id)
            if not job or job['status'] != 'succeeded' or not job.get('output_psd'):
                raise HTTPException(409, '恢复映射的基础 PSD 尚未成功保存')
        plan = json.dumps({'states': sorted(states), 'provider': provider, 'base_jobs': base_jobs}, sort_keys=True)
        with self.batch.db() as con:
            old = con.execute('SELECT plan FROM pose_deliveries WHERE batch_id=?', (bid,)).fetchone()
            if old and old[0] != plan:
                raise HTTPException(409, '本批多状态设置已锁定；不会覆盖已有任务或静默重复计费')
            con.execute("INSERT OR IGNORE INTO pose_deliveries VALUES (?,?,'paused')", (bid, plan))
            if start:
                con.execute("UPDATE pose_deliveries SET state='active' WHERE batch_id=?", (bid,))
        return self.summary(bid)

    def control(self, bid, action):
        if action not in ('start', 'pause'):
            raise HTTPException(404, '未知多状态操作')
        if not self.summary(bid):
            raise HTTPException(409, '请先保存本批的多状态设置')
        with self.batch.db() as con:
            con.execute('UPDATE pose_deliveries SET state=? WHERE batch_id=?', ('active' if action == 'start' else 'paused', bid))
        # Never clears a provider circuit or retries an existing failed child.
        return self.summary(bid)

    def summary(self, bid):
        with self.batch.db() as con:
            row = con.execute('SELECT * FROM pose_deliveries WHERE batch_id=?', (bid,)).fetchone()
            entries = [dict(r) for r in con.execute('SELECT * FROM pose_delivery_items WHERE batch_id=?', (bid,))]
        if not row:
            return None
        plan = json.loads(row['plan'])
        with self.batch.db() as con:
            manifest = json.loads(con.execute('SELECT manifest FROM batches WHERE id=?', (bid,)).fetchone()[0])
        eligible = sum(bool((job := self.batch.split_get(plan.get('base_jobs', {}).get(i['id'], i['id']))) and job['status'] == 'succeeded') for i in manifest['items'])
        for entry in entries:
            if self.poses and entry['status'] not in ('invalid_base', 'preparing'):
                try:
                    run = self.poses.get(entry['run_id'])
                    entry.update(status=run['status'], message=run['message'])
                except HTTPException as error:
                    if error.status_code != 404:
                        raise
        blocker = self.poses.service_blocker() if self.poses else None
        return {**plan, 'state': 'blocked' if blocker and row['state'] == 'active' else row['state'],
                'message': blocker['message'] if blocker else '', 'items': entries,
                'ready': sum(e['status'] == 'ready' for e in entries),
                'needs_attention': sum(e['status'] in ('needs_attention', 'invalid_base') for e in entries),
                'running': sum(e['status'] in ('preparing', 'running') for e in entries),
                'resolved_base_count': eligible,
                'expressions': 'existing_runtime_presets_only', 'mouth_modified': False}

    async def advance(self):
        if not self.poses or self.poses.service_blocker():
            return
        with self.batch.db() as con:
            ids = [r[0] for r in con.execute("SELECT batch_id FROM pose_deliveries WHERE state='active' ORDER BY rowid")]
        for bid in ids:
            batch = self.batch.read(bid)
            summary = batch['delivery']
            # One durable child at a time; review failures stop this batch.
            if summary['running'] or summary['needs_attention']:
                continue
            known = {e['item_id']: e for e in summary['items']}
            for item in batch['items']:
                base_id = summary.get('base_jobs', {}).get(item['id'], item['id'])
                job = self.batch.split_get(base_id)
                if not job or job['status'] != 'succeeded' or item['id'] in known:
                    continue
                # Duplicate source positions mapped to one checked base reuse
                # one action run, rather than paying twice for the same PSD.
                jid = hashlib.sha256(('batch-psd-poses-v1:' + bid + ':' + base_id).encode()).hexdigest()[:32]
                with self.batch.db() as con:
                    con.execute("INSERT OR IGNORE INTO pose_delivery_items VALUES (?,?,?,'preparing','读取基础 PSD；尚未提交生图')", (bid, item['id'], jid))
                await self.prepare(bid, item, jid, summary)
                return
            if batch['state'] == 'completed' and not summary['running']:
                with self.batch.db() as con:
                    con.execute("UPDATE pose_deliveries SET state='completed' WHERE batch_id=?", (bid,))

        # A crash between saving the child ID and creating it is recoverable.
        with self.batch.db() as con:
            pending = [dict(r) for r in con.execute("SELECT i.* FROM pose_delivery_items i JOIN pose_deliveries d USING(batch_id) WHERE i.status='preparing' AND d.state='active'")]
        for entry in pending:
            batch = self.batch.read(entry['batch_id'])
            item = next(i for i in batch['items'] if i['id'] == entry['item_id'])
            await self.prepare(batch['id'], item, entry['run_id'], batch['delivery'])
            return

    async def prepare(self, bid, item, jid, plan):
        try:
            job = self.batch.split_get(plan.get('base_jobs', {}).get(item['id'], item['id']))
            if not job or job['status'] != 'succeeded' or not job.get('output_psd'):
                raise ValueError('基础 PSD 文件尚未保存；不会重生基础图')
            data = await asyncio.to_thread(Path(job['output_psd']).read_bytes)
            # Same input slot as direct uploads; no concurrent PSD parsers.
            async with self.poses.input_slot:
                run = await asyncio.to_thread(self.poses.create, jid, plan['states'], plan['provider'], data)
            status, message = run['status'], run['message']
        except Exception as error:
            status = 'invalid_base'
            message = (error.detail if isinstance(error, HTTPException) else str(error)) if isinstance(error, (HTTPException, ValueError)) else '基础 PSD 读取或检查失败；未提交生图'
        with self.batch.db() as con:
            con.execute('UPDATE pose_delivery_items SET status=?,message=? WHERE batch_id=? AND item_id=?', (status, str(message), bid, item['id']))

    def archive(self, bid):
        batch = self.batch.read(bid)
        delivery = batch.get('delivery')
        ready = [e for e in (delivery or {}).get('items', []) if e['status'] == 'ready']
        if not ready:
            raise HTTPException(409, '尚无通过导出校验的多状态 PSD；基础 PSD 不能冒充多状态交付')
        target = self.batch.root / bid / 'multi-state-results.zip'
        tmp = target.with_suffix('.zip.tmp')
        names = {i['id']: i['filename'] for i in batch['items']}
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as archive:
            for entry in ready:
                directory = self.poses.root / entry['run_id']
                report = json.loads((directory / 'report.json').read_text())
                if (not report.get('sourceLayersUnchanged') or not report.get('neutralPixelsUnchanged') or
                    report.get('outputSha256') != hashlib.sha256((directory/'merged.psd').read_bytes()).hexdigest() or
                    set(report.get('requestedStates', [])) != set(delivery['states'])):
                    raise HTTPException(409, '多状态交付校验与文件或请求动作不一致；未将其打包交付')
                archive.write(directory / 'merged.psd', 'multi-state/' + names[entry['item_id']])
                archive.write(directory / 'report.json', 'reports/' + entry['item_id'] + '.json')
            archive.writestr('manifest.json', json.dumps({
                'batch_id': bid, 'scope': 'multi-state-action-psds', 'total': batch['total'],
                'delivered': len(ready), 'partial': len(ready) != batch['total'],
                'visualAcceptance': 'pending_human_review', 'delivery': delivery,
                'expressions': 'existing runtime presets; no new expression pixel layers',
                'mouthModified': False, 'created_at': time.time(),
            }, ensure_ascii=False, indent=2))
        tmp.replace(target)
        return target
