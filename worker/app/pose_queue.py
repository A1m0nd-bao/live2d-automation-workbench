"""Durable PSD-first Pro states. Paid generation has no automatic retries.

Old /pro/jobs stay recoverable. New /pro/pose-jobs never call See-Through.
"""
import asyncio
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import sqlite3
import sys
import time
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse

spec = importlib.util.spec_from_file_location('morph_psd_pose', Path(__file__).with_name('psd_pose.py'))
pose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pose)
MAX_PSD = 100 * 1024 * 1024
TERMINAL = ('succeeded', 'failed', 'uncertain', 'needs-review')


class PoseQueue:
    def __init__(self, root, prep, authorize):
        self.root = Path(root) / 'psd-poses'
        self.prep, self.authorize = prep, authorize
        self.router = APIRouter(prefix='/pro/pose-jobs')
        self.task = None
        self.input_slot = asyncio.Semaphore(1)
        self.routes()

    @contextmanager
    def db(self):
        self.root.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(self.root/'jobs.sqlite3', timeout=10)
        con.row_factory = sqlite3.Row
        try:
            with con:
                yield con
        finally:
            con.close()

    def init(self):
        with self.db() as con:
            con.execute('PRAGMA journal_mode=WAL')
            con.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL)')

    def get(self, jid):
        with self.db() as con:
            row = con.execute('SELECT payload FROM runs WHERE id=?', (jid,)).fetchone()
        if not row:
            raise HTTPException(404, 'PSD 部件任务不存在')
        return json.loads(row['payload'])

    def save(self, run):
        run['updated_at'] = time.time()
        with self.db() as con:
            con.execute('UPDATE runs SET payload=? WHERE id=?', (json.dumps(run, ensure_ascii=False), run['id']))

    @staticmethod
    def persist(path, data):
        path = Path(path)
        temp = path.with_suffix(path.suffix+'.tmp')
        temp.write_bytes(data)
        temp.replace(path)

    def create(self, jid, states, provider, data):
        if len(jid) != 32 or any(x not in '0123456789abcdef' for x in jid):
            raise HTTPException(400, '任务编号无效')
        if not isinstance(states, list) or not states or len(states) > 6 or any(not isinstance(x,str) or x not in pose.POSES for x in states) or len(set(states)) != len(states):
            raise HTTPException(400, '仅支持挥手、叉腰、抱臂、思考、托掌、握拳；表情与嘴部沿用已有参数')
        if provider not in ('doubao','image2'):
            raise HTTPException(400, '生图提供方无效')
        if not data.startswith(b'8BPS') or len(data) > MAX_PSD:
            raise HTTPException(415, '请上传不超过 100 MB 的分层 PSD')
        fingerprint = hashlib.sha256(json.dumps([pose.VERSION,states,provider]).encode()+data).hexdigest()
        # Recover a persisted run before checking credentials or doing work.
        with self.db() as con:
            old = con.execute('SELECT * FROM runs WHERE id=?', (jid,)).fetchone()
        if old:
            if old['fingerprint'] != fingerprint:
                raise HTTPException(409, '同一任务编号的 PSD、状态或提供方不一致；不会覆盖或重生')
            return json.loads(old['payload'])
        directory = self.root/jid
        directory.mkdir(exist_ok=True)
        self.persist(directory/'source.psd', data)
        try:
            info = pose.inspect(directory/'source.psd', directory)
        except Exception as e:
            raise HTTPException(422, str(e) if isinstance(e,ValueError) else 'PSD 无法解析；未提交生图') from None
        existing = set()
        for layer in info['layers']:
            sid = layer['name']
            if sid not in states:
                continue
            parts = {x.removeprefix(sid+'__') for x in layer['parts'] if x.startswith(sid+'__')}
            if not layer['isGroup'] or not ({'handwear-r','handwear-l'} <= parts or
                (('thinking' in sid or 'crossed_arms' in sid) and 'handwear' in parts)):
                raise HTTPException(422, f'原 PSD 的 {sid} 部件命名不完整；不会覆盖作者动作或再次收费生成')
            existing.add(sid)
        key, model = self.prep.config(provider)
        review_key, _ = self.prep.config('image2')
        if any(s not in existing for s in states) and (not key or not review_key):
            raise HTTPException(503, '所选生图或部件视觉检查凭据未配置；未提交收费任务')
        self.persist(directory/'inspection.json', json.dumps(info, ensure_ascii=False).encode())
        run = {'id':jid, 'pipeline':pose.VERSION, 'provider':provider, 'model':model,
               'status':'running', 'message':'基础 PSD 已保存；仅生成完整手臂部件，不再逐张拆件',
               'updated_at':time.time(), 'states':[
                   {'id':s, 'status':'succeeded' if s in existing else 'queued', 'reused':s in existing,
                    'message':'复用原 PSD 的内嵌动作' if s in existing else '等待部件生图', 'attempt':1,
                    'generation_id':uuid.uuid4().hex} for s in states]}
        with self.db() as con:
            con.execute('BEGIN IMMEDIATE')
            if con.execute('SELECT id FROM runs WHERE id=?', (jid,)).fetchone():
                return self.get(jid)
            active = sum(json.loads(r[0])['status'] == 'running' for r in con.execute('SELECT payload FROM runs'))
            if active >= 100:
                raise HTTPException(429, 'PSD 部件队列已满')
            con.execute('INSERT INTO runs VALUES (?,?,?)', (jid,fingerprint,json.dumps(run)))
        return run

    async def generate(self, run, state, directory, info):
        key, _ = self.prep.config(run['provider'])
        model = run['model']
        if not key:
            state.update(status='failed', message='生图凭据未配置；未提交上游')
            return
        # The durable transition is BEFORE POST. A crash without a saved
        # candidate becomes uncertain, never another generation submission.
        state.update(status='generating', message='正在生成完整肩袖手部件')
        self.save(run)
        gid = state['generation_id']
        prompt = pose.pose_prompt(state['id'], info)
        self.prep.persist(gid, 'source', (self.root/run['id']/'neutral.png').read_bytes())
        self.prep.persist(gid, 'prompt.txt', prompt.encode())
        def update(**fields):
            for field in ('status','message','request_id'):
                if field in fields:
                    state[field] = fields[field]
            self.save(run)
        try:
            data = await self.prep.generate({'id':gid, 'provider':run['provider'], 'model':model, '_update':update,
                '_references':[(self.root/run['id']/'arms.png').read_bytes()],
                '_options':{'size':'1536x2400' if run['provider']=='doubao' else '1024x1536',
                            'openai':{'background':'transparent'}}}, key)
            if data is None:
                return
            self.persist(directory/'candidate.png', data)
            state.update(status='reviewing', message='部件已保存；定位肩肘腕并校验比例')
            self.save(run)
        except asyncio.CancelledError:
            raise
        except Exception:
            state.update(status='uncertain', message='生图请求或保存中断；上游结果未知，未自动重试')

    async def process(self, run, state, directory, info):
        source = self.root/run['id']/'source.psd'
        data = (directory/'candidate.png').read_bytes()
        # Some providers paint a flat background instead of honoring Alpha.
        # CPU-only foreground extraction is NOT semantic re-decomposition and
        # is followed by the same whole-limb/hand/attachment review.
        from PIL import Image
        import io
        picture = Image.open(io.BytesIO(data))
        alpha = picture.getchannel('A') if 'A' in picture.getbands() else None
        if alpha is None or alpha.getextrema()[0] > 10:
            foreground = directory/'foreground'/'foreground.png'
            if not foreground.exists():
                process = await asyncio.create_subprocess_exec(sys.executable, str(Path(__file__).with_name('foreground.py')),
                    str(directory/'candidate.png'), str(directory/'foreground'), '--padding-ratio','0',
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                try:
                    await asyncio.wait_for(process.wait(), timeout=300)
                except BaseException:
                    if process.returncode is None:
                        process.kill(); await process.wait()
                    raise
                if process.returncode or not foreground.exists():
                    raise ValueError('部件背景透明化失败；素材保留，未重新生成或提交拆件')
            data = foreground.read_bytes()
        await asyncio.to_thread(pose.candidate_image, data)
        key, _ = self.prep.config('image2')
        geometry_file = directory/'geometry.json'
        if geometry_file.exists():
            geometry = json.loads(geometry_file.read_text())
        else:
            both = 'crossed_arms' in state['id']
            instruction = (
                '第一张是源角色，第二张是原 PSD 的双臂层，第三张是生成的完整部件。检查第三张仅有指定部件、衣袖/手与源角色一致、解剖正确、姿势正确。'
                'checks 必须恰好为 '+','.join(pose.PART_CHECKS)+'；值 pass/fail/uncertain，reasons 为中文问题数组。'
                'geometry 坐标必须是各自图片画布内归一化 [x,y]（0到1），不是裁剪框坐标。'
                + ('第三张含双臂：返回 shoulder（源 handwear-r 对应侧的肩连接中心）与 other_shoulder（另一侧肩连接中心）。' if both else
                   '第三张只含源 handwear-r 对应侧手臂：返回 shoulder、elbow、wrist；同时返回第二张该侧原臂的 source_shoulder、source_elbow、source_wrist。'
                   '肩是肩袖与躯干连接的中心，不是抬高的手掌、不是整张图的最高点。')
                + '\n源层检查信息：'+json.dumps(info['arms'])+'\n要求：'+pose.pose_prompt(state['id'], info))
            geometry = pose.validate_checks(await pose.vision(key, instruction,
                [(self.root/run['id']/'neutral.png').read_bytes(), (self.root/run['id']/'arms.png').read_bytes(),data]), pose.PART_CHECKS)
            self.persist(geometry_file, json.dumps(geometry, ensure_ascii=False).encode())
        if geometry['status'] != 'passed':
            state.update(status='needs-review', message='；'.join(geometry['reasons']) or '部件视觉检查未通过')
            return
        state.update(status='assembling', message='按此 PSD 的肩位与骨段长度对齐；另一侧复用原层')
        self.save(run)
        report = await asyncio.to_thread(pose.assemble, source, directory, state['id'], data, geometry.get('geometry',{}), info)
        preview = (directory/'preview.png').read_bytes()
        # Verify the ACTUAL assembled preview, not just the generated asset.
        instruction = ('第一张中立原图，第二张为实际 PSD 合层预览，第三张肩部近景、第四张手腕手掌近景。检查指定姿势、肩袖腕手连续、手臂长度与手掌比例正确，'
            '数清恰好两条臂/两只手。躯干上残留的旧袖、双臂叠影、肩部断口或另一只手缺失均失败。头脸腿服装与源图保持不变。'
            'checks 必须恰好为 '+','.join(pose.PREVIEW_CHECKS)+'，值 pass/fail/uncertain；reasons 中文问题数组。'
            '本轮不修改嘴、表情或身体。要求：'+pose.POSES[state['id']])
        review = pose.validate_checks(await pose.vision(key, instruction, [(self.root/run['id']/'neutral.png').read_bytes(),preview,
            (directory/'shoulder-closeup.png').read_bytes(),(directory/'hand-closeup.png').read_bytes()]), pose.PREVIEW_CHECKS)
        self.persist(directory/'review.json', json.dumps({**review, 'assembly':report}, ensure_ascii=False).encode())
        state.update(status='succeeded' if review['status']=='passed' else 'needs-review',
                     message='实际合层检查通过，仍需人工验收' if review['status']=='passed' else '；'.join(review['reasons']) or '实际合层待复核',
                     preview=True)

    async def advance(self, run):
        info = json.loads((self.root/run['id']/'inspection.json').read_text())
        for state in run['states']:
            if state['status'] in TERMINAL:
                continue
            directory = self.root/run['id']/state['generation_id']
            directory.mkdir(exist_ok=True)
            try:
                if state['status'] == 'queued' and not (directory/'candidate.png').exists():
                    await self.generate(run,state,directory,info)
                if state['status'] not in TERMINAL and (directory/'candidate.png').exists():
                    await self.process(run,state,directory,info)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                state.update(status='needs-review', message=str(e) if isinstance(e,(ValueError,RuntimeError)) else '本地合层或部件检查中断；已有素材保留，未重新生图')
            self.save(run)
            break
        statuses = [s['status'] for s in run['states']]
        if all(s == 'succeeded' for s in statuses):
            try:
                directory = self.root/run['id']
                states = [{'id':s['id'], 'replacement':directory/s['generation_id']/'replacement.png'} for s in run['states'] if not s.get('reused')]
                report = await asyncio.to_thread(pose.export, directory/'source.psd', directory/'merged.tmp.psd', states)
                (directory/'merged.tmp.psd').replace(directory/'merged.psd')
                self.persist(directory/'report.json', json.dumps(report, ensure_ascii=False).encode())
                run.update(status='ready', message='多状态 PSD 已生成并重开校验；原层/中立像素不变，动作组默认隐藏。仍需人工验收')
            except Exception as e:
                run.update(status='needs_attention', message=str(e) if isinstance(e,ValueError) else '多状态 PSD 导出检查未通过；原 PSD 与部件保留')
        elif all(s in TERMINAL for s in statuses):
            run.update(status='needs_attention', message='部分部件失败、结果未知或待复核；已保存素材保留，不会自动重生或拆件')
        self.save(run)

    def retry(self, jid, sid, review_only=False):
        run = self.get(jid)
        state = next((s for s in run['states'] if s['id']==sid), None)
        if run['status'] != 'needs_attention' or not state or state['status'] not in ('failed','uncertain','needs-review'):
            raise HTTPException(409, '仅可处理本轮结束后失败/未知/待复核的部件')
        directory = self.root/jid/state['generation_id']
        if review_only:
            if not (directory/'candidate.png').exists():
                raise HTTPException(409, '没有已保存素材可以复核')
            (directory/'geometry.json').unlink(missing_ok=True)
            state.update(status='reviewing', message='仅复核现有素材，不发起生图')
        else:
            state.setdefault('history', []).append({k:state[k] for k in ('generation_id','status','attempt')})
            state.update(generation_id=uuid.uuid4().hex, status='queued', message='用户明确请求重新生成该部件', attempt=state['attempt']+1, preview=False)
        run['status']='running'
        self.save(run)
        return run

    async def start(self):
        self.init()
        with self.db() as con:
            rows = con.execute('SELECT payload FROM runs').fetchall()
        for row in rows:
            run = json.loads(row[0])
            for state in run['states']:
                if state['status']=='generating':
                    found = (self.root/run['id']/state['generation_id']/'candidate.png').exists()
                    state.update(status='reviewing' if found else 'uncertain', message='恢复已保存部件' if found else '服务重启时生图未保存；结果未知，未自动重试')
            self.save(run)
        self.task = asyncio.create_task(self.loop())

    async def stop(self):
        if self.task:
            self.task.cancel()
            try: await self.task
            except asyncio.CancelledError: pass

    async def loop(self):
        while True:
            with self.db() as con:
                rows = con.execute('SELECT payload FROM runs ORDER BY rowid').fetchall()
            for row in rows:
                run = json.loads(row[0])
                if run['status']=='running':
                    await self.advance(run)
                    break
            await asyncio.sleep(2)

    def routes(self):
        @self.router.post('', status_code=202)
        async def create(job_id: str=Form(...), states: str=Form(...), provider: str=Form(...), psd: UploadFile=File(...),
                         x_relay_token: str|None=Header(None), x_morph_device_token: str|None=Header(None)):
            self.authorize(x_relay_token,x_morph_device_token)
            try: selected=json.loads(states)
            except ValueError: raise HTTPException(400,'状态清单无效') from None
            data = await psd.read(MAX_PSD+1)
            async with self.input_slot:
                return await asyncio.to_thread(self.create,job_id,selected,provider,data)

        @self.router.get('/{jid}')
        async def status(jid: str, x_relay_token: str|None=Header(None), x_morph_device_token: str|None=Header(None)):
            self.authorize(x_relay_token,x_morph_device_token)
            return self.get(jid)

        @self.router.post('/{jid}/states/{sid}/{action}')
        async def retry(jid: str, sid: str, action: str, x_relay_token: str|None=Header(None), x_morph_device_token: str|None=Header(None)):
            self.authorize(x_relay_token,x_morph_device_token)
            if action not in ('retry','review'):
                raise HTTPException(404,'操作不存在')
            return self.retry(jid,sid,action=='review')

        @self.router.get('/{jid}/states/{sid}/preview')
        async def preview(jid: str, sid: str, x_relay_token: str|None=Header(None), x_morph_device_token: str|None=Header(None)):
            self.authorize(x_relay_token,x_morph_device_token)
            state=next((s for s in self.get(jid)['states'] if s['id']==sid),None)
            if not state or not state.get('preview'):
                raise HTTPException(409,'合层预览尚未就绪')
            return FileResponse(self.root/jid/state['generation_id']/'preview.png', media_type='image/png')

        @self.router.get('/{jid}/{kind}')
        async def output(jid: str, kind: str, x_relay_token: str|None=Header(None), x_morph_device_token: str|None=Header(None)):
            self.authorize(x_relay_token,x_morph_device_token)
            if kind not in ('output','report'):
                raise HTTPException(404,'文件类型不存在')
            if self.get(jid)['status']!='ready':
                raise HTTPException(409,'多状态 PSD 尚未通过导出检查')
            return FileResponse(self.root/jid/('merged.psd' if kind=='output' else 'report.json'),
                                media_type='image/vnd.adobe.photoshop' if kind=='output' else 'application/json',
                                filename='psd-pose-variants.psd' if kind=='output' else 'psd-pose-report.json')
