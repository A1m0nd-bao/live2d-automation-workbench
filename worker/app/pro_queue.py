"""Durable Pro fan-out. Child IDs are persisted before any external request.

Only explicit retries allocate new children. Unknown paid outcomes never replay.
PSD collection finishes on the server; browser merge resumes on the next visit.
"""
import asyncio
import hashlib
import json
import sqlite3
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse

# These modules are also loaded directly by the lightweight local relay.
import importlib.util
_quality_spec = importlib.util.spec_from_file_location('morph_image_quality', Path(__file__).with_name('image_quality.py'))
_quality = importlib.util.module_from_spec(_quality_spec)
_quality_spec.loader.exec_module(_quality)
STYLE_LOCK = _quality.STYLE_LOCK
FRAME_LOCK = _quality.FRAME_LOCK

STATES = {
    'action_02_wave_arms_only': '仅改变手臂：一只手抬到肩旁自然挥手，另一只保持中立。肩、上臂、肘、前臂、腕、手掌、手指连续相连，不遮脸。',
    'action_03_hand_on_hip_arms_only': '仅改变手臂为自然叉腰，手臂与肩连续相连，手掌贴合腰部但不改变衣服。',
    'action_04_arms_crossed_crossed_arms': '仅改变双臂为胸前自然抱臂，双臂完整、位于上衣前方。',
    'action_05_thinking_arms_only': '仅改变双臂为轻微思考姿势，不遮住脸，不改变身体比例。',
    'expression_02_soft_smile_face_controls': '仅改变眼、眉、嘴为轻微微笑，身体和手臂保持中立。',
    'expression_04_embarrassed_face_controls': '仅增加克制脸红与羞赧表情，身体和手臂保持中立。',
    'expression_07_surprised_face_controls': '仅改变为轻度惊讶表情，身体和手臂保持中立。',
}

def state_prompt(state):
    return ('以所附中立主图为唯一权威参考，生成同一角色的单张 Live2D 状态图。'
            '固定脸型、五官比例、发型、非对称配饰、身体拓扑、服装结构、材质、配色和原画风，禁止重新设计。'
            + STYLE_LOCK + FRAME_LOCK + STATES[state] +
            '其余部分保持不变。保持同一全身正面相机、画布比例、人物大小、头部位置与脚底基线，不移动或缩放角色。'
            '保留完整四肢和鞋底，动作不得超出画布，不新增道具、文字、水印或角色。'
            '肢体数量严格与参考一致，每条手臂只连接一只手。挥手时移动原来的整条手臂，不得在肩旁残留原姿势的手掌或生成悬空手。'
            '背景为无纹理极浅灰纯色，不画棋盘格、地面阴影；这不是中立姿势重绘，必须体现指定状态。')

class ProQueue:
    def __init__(self, root, prep, authorize, split_create, split_get, split_path):
        self.root = Path(root) / 'pro'
        self.prep, self.authorize = prep, authorize
        self.split_create, self.split_get, self.split_path = split_create, split_get, split_path
        self.router = APIRouter(prefix='/pro')
        self.task = None
        self.routes()

    def db(self):
        self.root.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(self.root / 'jobs.sqlite3', timeout=10)
        con.row_factory = sqlite3.Row
        return con

    def init(self):
        with self.db() as c:
            c.execute('PRAGMA journal_mode=WAL')
            c.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL)')

    def get(self, run_id):
        with self.db() as c:
            row = c.execute('SELECT payload FROM runs WHERE id=?', (run_id,)).fetchone()
        if not row:
            raise HTTPException(404, 'Pro 任务不存在')
        return json.loads(row['payload'])

    def save(self, run):
        run['updated_at'] = time.time()
        with self.db() as c:
            c.execute('UPDATE runs SET payload=? WHERE id=?', (json.dumps(run), run['id']))

    def create(self, run_id, base_id, states, provider, image):
        if len(run_id) != 32 or any(x not in '0123456789abcdef' for x in run_id):
            raise HTTPException(400, '任务编号无效')
        if not states or len(states) > 4 or len(set(states)) != len(states) or any(s not in STATES or not s.startswith('action_') for s in states):
            raise HTTPException(400, '自动队列仅支持特殊手势；表情不进入生图和拆分')
        if provider not in ('doubao', 'image2'):
            raise HTTPException(400, '生图提供方无效')
        if len(image) > 20 * 1024 * 1024:
            raise HTTPException(413, '主图最大 20 MB')
        try:
            self.prep.mime(image)
        except ValueError:
            raise HTTPException(415, '主图必须为 PNG/JPEG')
        base = self.split_get(base_id)
        if base['status'] != 'succeeded':
            raise HTTPException(409, '基础 PSD 尚未就绪')
        fingerprint = hashlib.sha256(json.dumps([base_id, states, provider]).encode() + image).hexdigest()
        with self.db() as c:
            c.execute('BEGIN IMMEDIATE')
            old = c.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
            if old:
                if old['fingerprint'] != fingerprint:
                    raise HTTPException(409, '该编号已用于其他 Pro 输入；不会覆盖')
                return json.loads(old['payload'])
            active = sum(json.loads(r['payload'])['status'] == 'running' for r in c.execute('SELECT payload FROM runs'))
            if active >= 10:
                raise HTTPException(429, 'Pro 队列已满，请等待已有任务完成')
            directory = self.root / run_id
            directory.mkdir(exist_ok=True)
            temp = directory / 'reference.tmp'
            temp.write_bytes(image)
            temp.replace(directory / 'reference')
            run = {'id': run_id, 'base_id': base_id, 'provider': provider, 'status': 'running',
                   'message': '状态队列已保存；关闭网页不影响生图与拆分', 'updated_at': time.time(),
                   'states': [{'id': s, 'prompt': state_prompt(s), 'status': 'queued', 'message': '等待生图',
                               'prep_id': uuid.uuid4().hex, 'split_id': uuid.uuid4().hex, 'attempt': 1} for s in states]}
            c.execute('INSERT INTO runs VALUES (?,?,?)', (run_id, fingerprint, json.dumps(run)))
        return run

    async def advance(self, run):
        # Sequential states bound cost and GPU pressure; one failure does not
        # discard successful siblings or prevent remaining states from running.
        for state in run['states']:
            if state['status'] in ('succeeded', 'failed', 'uncertain'):
                continue
            try:
                prep = self.prep.create(state['prep_id'], state['id'], run['provider'],
                                        (self.root / run['id'] / 'reference').read_bytes(), prompt=state.get('prompt', state_prompt(state['id'])))
                state['status'], state['message'] = 'generating', prep['message']
                if prep['status'] in ('failed', 'uncertain', 'needs-review'):
                    state['status'] = 'failed' if prep['status'] == 'needs-review' else prep['status']
                elif prep['status'] == 'succeeded':
                    if (prep.get('quality') or {}).get('status') != 'passed' or (prep.get('quality') or {}).get('version') != _quality.VERSION:
                        state['status'], state['message'] = 'failed', '该生图没有通过视觉检查，已阻止状态拆层；请先复核生成图'
                        self.save(run)
                        break
                    # Idempotent local insertion; monitor owns upstream work.
                    self.split_create(state['split_id'], self.prep.root / state['prep_id'] / 'output', state['id'])
                    split = self.split_get(state['split_id'])
                    state['status'] = {'succeeded': 'succeeded', 'failed': 'failed'}.get(split['status'], 'splitting')
                    state['message'] = split.get('error') or split.get('message') or state['status']
            except HTTPException as e:
                state['status'], state['message'] = 'failed', str(e.detail)
            except Exception:
                # Keep the same IDs. A transient local/read error must not
                # trigger another generation or expose provider secrets.
                state['message'] = '状态暂未同步，服务端将使用原编号恢复'
            self.save(run)
            break
        statuses = [s['status'] for s in run['states']]
        if all(s == 'succeeded' for s in statuses):
            run['status'], run['message'] = 'ready', '全部状态 PSD 已保存；打开工作台自动下载并合层，仍需视觉验收'
        elif all(s in ('succeeded', 'failed', 'uncertain') for s in statuses):
            run['status'], run['message'] = 'needs_attention', '部分状态失败或结果未知；已成功状态保留，请选择单项重试'
        self.save(run)

    def retry(self, run_id, state_id):
        run = self.get(run_id)
        if run['status'] != 'needs_attention':
            raise HTTPException(409, '请等待本轮队列完成后重试')
        state = next((s for s in run['states'] if s['id'] == state_id), None)
        if not state or state['status'] not in ('failed', 'uncertain'):
            raise HTTPException(409, '只能重试失败或未知的状态')
        try:
            prep = self.prep.get(state['prep_id'])
        except HTTPException as e:
            if e.status_code != 404:
                raise
            prep = {'status': 'missing'}
        state.setdefault('history', []).append({k: state[k] for k in ('prep_id', 'split_id', 'attempt')})
        if prep['status'] != 'succeeded':
            state['prep_id'] = uuid.uuid4().hex
        state.update(split_id=uuid.uuid4().hex, status='queued', message='已明确请求单项重试', attempt=state['attempt'] + 1)
        run['status'] = 'running'
        self.save(run)
        return run

    async def start(self):
        self.init()
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
            with self.db() as c:
                rows = c.execute('SELECT payload FROM runs').fetchall()
            for row in rows:
                run = json.loads(row['payload'])
                if run['status'] == 'running':
                    await self.advance(run)
                    break  # One entire Pro run at a time, including split waits.
            await asyncio.sleep(3)

    def routes(self):
        @self.router.post('/jobs', status_code=202)
        async def create(job_id: str = Form(...), base_id: str = Form(...), states: str = Form(...),
                         provider: str = Form(...), image: UploadFile = File(...),
                         x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            self.authorize(x_relay_token, x_morph_device_token)
            try:
                selected = json.loads(states)
                if not isinstance(selected, list) or any(not isinstance(s, str) for s in selected):
                    raise ValueError()
            except (ValueError, TypeError):
                raise HTTPException(400, '状态清单无效')
            return self.create(job_id, base_id, selected, provider, await image.read(20 * 1024 * 1024 + 1))

        @self.router.get('/jobs/{run_id}')
        async def status(run_id: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            self.authorize(x_relay_token, x_morph_device_token)
            return self.get(run_id)

        @self.router.post('/jobs/{run_id}/states/{state_id}/retry')
        async def retry(run_id: str, state_id: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            self.authorize(x_relay_token, x_morph_device_token)
            return self.retry(run_id, state_id)

        @self.router.get('/jobs/{run_id}/states/{state_id}/output')
        async def output(run_id: str, state_id: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            self.authorize(x_relay_token, x_morph_device_token)
            run = self.get(run_id)
            state = next((s for s in run['states'] if s['id'] == state_id), None)
            if not state or state['status'] != 'succeeded':
                raise HTTPException(409, '状态 PSD 尚未就绪')
            return FileResponse(self.split_path(state['split_id']), media_type='image/vnd.adobe.photoshop', filename=f'{state_id}.psd')
