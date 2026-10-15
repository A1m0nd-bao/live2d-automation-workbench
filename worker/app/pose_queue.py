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
import re
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
            con.execute('CREATE TABLE IF NOT EXISTS service_circuit (id INTEGER PRIMARY KEY CHECK(id=1), status INTEGER NOT NULL, message TEXT NOT NULL)')

    def service_blocker(self):
        with self.db() as con:
            row = con.execute('SELECT status,message FROM service_circuit WHERE id=1').fetchone()
        return dict(row) if row else None

    def block_service(self, status):
        if status not in (401, 402, 403, 429):
            return
        message = f'部件生图或视觉服务 HTTP {status}；已暂停全队列的新请求，已有素材保留；需明确恢复，不自动重试'
        with self.db() as con:
            con.execute('INSERT OR REPLACE INTO service_circuit VALUES (1,?,?)', (status, message))

    def resume_service(self):
        # An explicit authenticated action, never an automatic retry. Existing
        # failed/uncertain states keep their IDs and outcomes.
        with self.db() as con:
            con.execute('DELETE FROM service_circuit WHERE id=1')
        return {'resumed': True, 'failed_jobs_retried': False}

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

    def checked_output(self, jid):
        if self.get(jid)['status'] != 'ready':
            raise HTTPException(409, '多状态 PSD 尚未通过导出检查')
        output = self.root/jid/'merged.psd'
        try:
            pose.gates.validate_semantic_order(pose.PSDImage.open(output))
        except Exception:
            raise HTTPException(409, '已保存 PSD 不满足新版中立排序规则；保留原文件，需人工复核，未自动改写或重生') from None
        return output

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
                ('crossed_arms' in sid and 'handwear' in parts)):
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
        # Gateway transparency availability is provider-specific. Request a
        # plain-background asset, then use the existing CPU cutout + visual QA.
        # Never resubmit a rejected/unknown call with changed options silently.
        solid_background = run['provider'] == 'image2'
        prompt = pose.pose_prompt(state['id'], info, solid_background=solid_background)
        if state.get('correction_reasons'):
            prompt += '\nThis is an explicitly requested correction of an unsuccessful part. Fix the following proportion/attachment defects while preserving the reference outfit: '
            prompt += json.dumps(state['correction_reasons'], ensure_ascii=False)
            prompt += '\nMatch hand-to-forearm size and sleeve width-to-arm length from reference 2, not the previous generated part. Do not enlarge hands or lengthen forearms.'
        self.prep.persist(gid, 'source', (self.root/run['id']/'neutral.png').read_bytes())
        self.prep.persist(gid, 'prompt.txt', prompt.encode())
        self.prep.persist(gid, 'request-settings.json', json.dumps({
            'version':'pose-image-compat-v1', 'model':model, 'provider':run['provider'],
            'size':'1536x2400' if run['provider']=='doubao' else '1024x1536',
            'reference_count':2, 'background_strategy':'local_cutout' if solid_background else 'transparent_prompt',
            'automatic_retry':False,
        }).encode())
        def update(**fields):
            for field in ('status','message','request_id'):
                if field in fields:
                    state[field] = fields[field]
            self.save(run)
        try:
            data = await self.prep.generate({'id':gid, 'provider':run['provider'], 'model':model, '_update':update,
                '_references':[(self.root/run['id']/'arms.png').read_bytes()],
                '_options':{'size':'1536x2400' if run['provider']=='doubao' else '1024x1536'}}, key)
            if data is None:
                rejection = self.prep.root/gid/'rejection.json'
                if rejection.exists():
                    self.block_service(json.loads(rejection.read_text()).get('http_status'))
                match = re.search(r'HTTP (401|402|403|429)\b', state.get('message', ''))
                if match:
                    self.block_service(int(match[1]))
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
                + ('第三张含双臂：返回 shoulder（源 handwear-r 对应侧的肩连接中心）与 other_shoulder（另一侧肩连接中心）；第二张返回 source_shoulder 与 source_other_shoulder。' if both else
                   '第三张只含源 handwear-r 对应侧手臂：返回 shoulder、elbow、wrist；同时返回第二张该侧原臂的 source_shoulder、source_elbow、source_wrist。'
                   '肩是肩袖与躯干连接的中心，不是抬高的手掌、不是整张图的最高点。')
                + '\n另返回 draw_slot 的 after/before，值为原 PSD 唯一根层名或 null，至少一项非空。按这个角色实际肩袖遮挡决定动作组位置，必须高于被替换的双臂；不重排原层，不默认放在头发和脸之上。'
                + '\n原层按后到前的顺序：'+json.dumps([x['name'] for x in info['layers']],ensure_ascii=False)
                + '\n源层检查信息（肩位仅初步提示，必须按像素核对）：'+json.dumps(info['arms'])+'\n要求：'+pose.pose_prompt(state['id'], info))
            geometry = pose.validate_checks(await pose.vision(key, instruction,
                [(self.root/run['id']/'neutral.png').read_bytes(), (self.root/run['id']/'arms.png').read_bytes(),data],
                checks=pose.PART_CHECKS, geometry_fields=('shoulder','other_shoulder','source_shoulder','source_other_shoulder') if both else
                ('shoulder','elbow','wrist','source_shoulder','source_elbow','source_wrist')), pose.PART_CHECKS)
            self.persist(geometry_file, json.dumps(geometry, ensure_ascii=False).encode())
        # Raw canvases differ in scale and facing. Geometry is a localization
        # record, not acceptance of unaligned pixel sizes. Preserve its result,
        # then review the normalized part and actual assembly before export.
        state.update(status='assembling', message='按此 PSD 的肩位与骨段长度对齐；另一侧复用原层')
        self.save(run)
        report = await asyncio.to_thread(pose.assemble, source, directory, state['id'], data,
            {**geometry.get('geometry',{}), 'draw_slot': geometry.get('draw_slot')}, info)
        preview = (directory/'preview.png').read_bytes()
        replacement = (directory/'replacement.png').read_bytes()
        instruction = ('第一张是源角色中立图，第二张是原 PSD 的双臂层，第三张是待替换部件，已按原 PSD 骨长等比例缩放、校正朝向并固定到肩位，'
            '三张画布尺寸相同。请在这个相同像素尺度下检查 part_only/outfit/anatomy/pose，不能按原始生图画布的放大倍数判手大或袖粗。'
            '第三张单臂时不应出现另一条臂；袖型、针织、配饰和手/前臂比例仍需真实匹配。实际缺陷必须 fail，不确定为 uncertain。'
            'reasons 只列失败或不确定原因。要求：'+pose.POSES[state['id']])
        normalized = pose.validate_checks(await pose.vision(key, instruction,
            [(self.root/run['id']/'neutral.png').read_bytes(),(self.root/run['id']/'arms.png').read_bytes(),replacement],
            checks=pose.PART_CHECKS),pose.PART_CHECKS)
        self.persist(directory/'aligned-part-review.json',json.dumps({**normalized,'assembly':report,
            'replacementSha256':hashlib.sha256(replacement).hexdigest()},ensure_ascii=False).encode())
        if normalized['status'] != 'passed':
            state.update(status='needs-review',message='；'.join(normalized['reasons']) or '对齐后的部件检查未通过',preview=True)
            return
        # Verify the ACTUAL assembled preview, not just the generated asset.
        instruction = ('第一张中立原图，第二张为实际 PSD 合层预览，第三张肩部近景、第四张手腕手掌近景。检查指定姿势、肩袖腕手连续、手臂长度与手掌比例正确，'
            '数清恰好两条臂/两只手。躯干上残留的旧袖、双臂叠影、肩部断口或另一只手缺失均失败。头脸腿服装与源图保持不变。'
            'checks 必须恰好为 '+','.join(pose.PREVIEW_CHECKS)+'，值 pass/fail/uncertain；reasons 中文问题数组。'
            '本轮不修改嘴、表情或身体。要求：'+pose.POSES[state['id']])
        review = pose.validate_checks(await pose.vision(key, instruction, [(self.root/run['id']/'neutral.png').read_bytes(),preview,
            (directory/'shoulder-closeup.png').read_bytes(),(directory/'hand-closeup.png').read_bytes()],
            checks=pose.PREVIEW_CHECKS), pose.PREVIEW_CHECKS)
        self.persist(directory/'review.json', json.dumps({**review, 'assembly':report}, ensure_ascii=False).encode())
        state.update(status='succeeded' if review['status']=='passed' else 'needs-review',
                     message='实际合层检查通过，仍需人工验收' if review['status']=='passed' else '；'.join(review['reasons']) or '实际合层待复核',
                     preview=True)

    async def advance(self, run):
        if self.service_blocker():
            return
        info = json.loads((self.root/run['id']/'inspection.json').read_text())
        if (info.get('semanticOrder') or {}).get('policy') != pose.order.POLICY:
            run.update(status='needs_attention', message='中立语义排序规则已更新；旧任务的参考图与遮挡槽位需复核，未重生部件或改写原 PSD')
            self.save(run)
            return
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
                match = re.search(r'HTTP (401|402|403|429)\b', str(e))
                if match:
                    self.block_service(int(match[1]))
            self.save(run)
            break
        statuses = [s['status'] for s in run['states']]
        if all(s == 'succeeded' for s in statuses):
            try:
                directory = self.root/run['id']
                states = [{'id':s['id'], 'replacement':directory/s['generation_id']/'replacement.png',
                           'draw_slot':json.loads((directory/s['generation_id']/'aligned-part-review.json').read_text())['assembly']['drawSlot']}
                          for s in run['states'] if not s.get('reused')]
                temporary = directory/('merged-'+uuid.uuid4().hex+'.tmp.psd')
                report = await asyncio.to_thread(pose.export, directory/'source.psd', temporary, states)
                report['requestedStates'] = [s['id'] for s in run['states']]
                report['reusedStates'] = [s['id'] for s in run['states'] if s.get('reused')]
                report['sourceSha256'] = hashlib.sha256((directory/'source.psd').read_bytes()).hexdigest()
                report['outputSha256'] = hashlib.sha256(temporary.read_bytes()).hexdigest()
                temporary.replace(directory/'merged.psd')
                self.persist(directory/'report.json', json.dumps(report, ensure_ascii=False).encode())
                message = ('多状态 PSD 已生成并重开校验；已纠正强制语义顺序，图层像素和位置不变，按纠正后的中立基准验收。'
                           if report['semanticOrder']['changed'] else '多状态 PSD 已生成并重开校验；原层/中立像素不变。')
                run.update(status='ready', message=message+'动作组默认隐藏，仍需人工验收')
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
            # Reuse saved landmarks for deterministic re-alignment; keep the
            # original review record rather than deleting diagnostic history.
            state.update(status='reviewing', message='仅复核现有素材，不发起生图')
        else:
            # Only visual part/assembly feedback can guide an explicit retry.
            # Never rewrite a prompt to get around a provider safety rejection.
            reasons = []
            feedback_files = ('aligned-part-review.json','review.json') if (directory/'aligned-part-review.json').exists() else ('geometry.json','review.json')
            for filename in feedback_files:
                report_file = directory/filename
                if report_file.exists():
                    try:
                        report = json.loads(report_file.read_text())
                        if report.get('status') == 'rejected':
                            reasons += [r[:300] for r in report.get('reasons',[]) if isinstance(r,str)][:6]
                    except (ValueError, TypeError, AttributeError):
                        pass
            state.pop('correction_reasons', None)
            if reasons:
                state['correction_reasons'] = reasons[:6]
            state.setdefault('history', []).append({k:state[k] for k in ('generation_id','status','attempt')})
            state.update(generation_id=uuid.uuid4().hex, status='queued', message='用户明确请求重新生成该部件', attempt=state['attempt']+1, preview=False)
        run['status']='running'
        self.save(run)
        return run

    def select_candidate(self, jid, sid, generation_id):
        run = self.get(jid)
        state = next((s for s in run['states'] if s['id']==sid),None)
        if run['status'] != 'needs_attention' or not state:
            raise HTTPException(409,'仅可在本轮结束后选择已有候选')
        allowed = {state['generation_id'],*(s['generation_id'] for s in state.get('history',[]))}
        if len(generation_id)!=32 or any(c not in '0123456789abcdef' for c in generation_id) or generation_id not in allowed:
            raise HTTPException(404,'候选不属于这个动作；不会读取其他任务素材')
        if not (self.root/jid/generation_id/'candidate.png').is_file():
            raise HTTPException(409,'候选没有已保存的图片，不能复用')
        if generation_id != state['generation_id']:
            state.setdefault('history',[]).append({k:state[k] for k in ('generation_id','status','attempt')})
        state.update(generation_id=generation_id,status='reviewing',preview=False,
                     message='用户选择已有候选；仅重新对齐和复核，不发起生图')
        state.pop('correction_reasons',None)
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
                if run['status']=='running' and not self.service_blocker():
                    # Share the generation slot with neutral preparation.
                    slot = getattr(self.prep, 'execution_slots', None)
                    if slot is None:
                        await self.advance(run)
                    else:
                        async with slot:
                            await self.advance(run)
                    break
            await asyncio.sleep(2)

    def routes(self):
        @self.router.post('/provider/resume')
        async def resume_provider(x_relay_token: str|None=Header(None), x_morph_device_token: str|None=Header(None)):
            self.authorize(x_relay_token,x_morph_device_token)
            return self.resume_service()

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

        @self.router.post('/{jid}/states/{sid}/select/{generation_id}')
        async def select(jid: str, sid: str, generation_id: str, x_relay_token: str|None=Header(None), x_morph_device_token: str|None=Header(None)):
            self.authorize(x_relay_token,x_morph_device_token)
            return self.select_candidate(jid,sid,generation_id)

        @self.router.get('/{jid}/{kind}')
        async def output(jid: str, kind: str, x_relay_token: str|None=Header(None), x_morph_device_token: str|None=Header(None)):
            self.authorize(x_relay_token,x_morph_device_token)
            if kind not in ('output','report'):
                raise HTTPException(404,'文件类型不存在')
            if self.get(jid)['status']!='ready':
                raise HTTPException(409,'多状态 PSD 尚未通过导出检查')
            await asyncio.to_thread(self.checked_output, jid)
            return FileResponse(self.root/jid/('merged.psd' if kind=='output' else 'report.json'),
                                media_type='image/vnd.adobe.photoshop' if kind=='output' else 'application/json',
                                filename='psd-pose-variants.psd' if kind=='output' else 'psd-pose-report.json')
