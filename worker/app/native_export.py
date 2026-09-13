"""Authenticated, persisted CMO3-only native compiler jobs. No GUI or rebinding."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import zipfile
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse


class NativeExport:
    def __init__(self, root, authorize):
        self.root = Path(root) / 'native-export'
        self.root.mkdir(parents=True, exist_ok=True)
        self.authorize = authorize
        self.router = APIRouter(prefix='/native-export')
        self.active = {}
        self.slot = asyncio.Semaphore(1)
        self.java = os.environ.get('MORPH_EXPORT_JAVA', '')
        self.classes = os.environ.get('MORPH_EXPORT_CLASSES', '')
        self.libs = os.environ.get('MORPH_CUBISM_LIBS', '')

        @self.router.post('/jobs')
        async def submit(request: Request, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            authorize(x_relay_token, x_morph_device_token)
            if not all(Path(p).exists() for p in [self.java, self.classes, self.libs]) or not self.java:
                raise HTTPException(503, '本机原生导出器尚未配置')
            data = bytearray()
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > 200 * 1024 * 1024:
                    raise HTTPException(413, 'CMO3 超过 200 MB')
            if data[:4] != b'CAFF':
                raise HTTPException(400, '需要真实 CMO3 文件')
            job = hashlib.sha256(data).hexdigest()
            folder = self.root / job
            if not folder.exists():
                folder.mkdir()
                (folder / 'input.cmo3').write_bytes(data)
                self.save(job, 'queued', '等待原生编译')
            status = self.read(job)
            if status['status'] in ('queued', 'running'):
                self.launch(job)
            return status

        @self.router.get('/jobs/{job}')
        async def status(job: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            authorize(x_relay_token, x_morph_device_token)
            return self.read(job)

        @self.router.get('/jobs/{job}/output')
        async def output(job: str, x_relay_token: str | None = Header(None), x_morph_device_token: str | None = Header(None)):
            authorize(x_relay_token, x_morph_device_token)
            if self.read(job)['status'] != 'succeeded':
                raise HTTPException(409, '原生编译尚未完成')
            return FileResponse(self.root / job / 'runtime.zip', filename='native-runtime.zip')

    def read(self, job):
        if len(job) != 64 or any(c not in '0123456789abcdef' for c in job):
            raise HTTPException(400, '无效任务 ID')
        p = self.root / job / 'status.json'
        if not p.exists():
            raise HTTPException(404, '任务不存在')
        return json.loads(p.read_text())

    def save(self, job, status, message):
        p = self.root / job / 'status.json'
        temp = p.with_suffix('.tmp')
        temp.write_text(json.dumps(dict(id=job, status=status, message=message), ensure_ascii=False))
        temp.replace(p)

    def launch(self, job):
        if job not in self.active:
            task = asyncio.create_task(self.run(job))
            self.active[job] = task
            task.add_done_callback(lambda _: self.active.pop(job, None))

    async def start(self):
        for p in self.root.glob('*/status.json'):
            if self.read(p.parent.name)['status'] in ('queued', 'running'):
                self.launch(p.parent.name)

    async def stop(self):
        tasks = list(self.active.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def run(self, job):
        async with self.slot:
            directory = self.root / job
            process = None
            self.save(job, 'running', '原生编译与 Core 参数检查中')
            try:
                with (directory / 'compiler.log').open('wb') as log:
                    process = await asyncio.create_subprocess_exec(
                        self.java, '-Xmx2g', '-Djava.awt.headless=true', f'-Djava.library.path={self.libs}',
                        f'-DlogsFilePath={directory / "logs"}', f'-DlogFilename={directory / "native.log"}',
                        '-cp', self.classes + os.pathsep + self.libs + '/*', 'autolive2d.bridge.ArchiveExportBridge',
                        str(directory / 'input.cmo3'), str(directory / 'model.moc3'), str(directory / 'progress.txt'),
                        cwd=directory, stdout=log, stderr=log)
                    await asyncio.wait_for(process.wait(), 240)
                report = json.loads((directory / 'model.moc3.report.json').read_text())
                if process.returncode or report.get('status') != 'ok' or not report.get('consistency'):
                    raise RuntimeError('编译或 Core 校验失败；已保留日志')
                for kind in ('Meshes', 'Parameters', 'Deformers'):
                    if report.get('source' + kind) != report.get('runtime' + kind):
                        raise RuntimeError('导出结构数量不一致')
                if report.get('runtimeMeshes', 0) <= 0 or report.get('textureCount', 0) <= 0:
                    raise RuntimeError('阻止空模型交付')
                textures = [f'texture_{i}.png' for i in range(report['textureCount'])]
                manifest = dict(Version=3, FileReferences=dict(Moc='model.moc3', Textures=textures), Groups=[dict(Target='Parameter', Name='EyeBlink', Ids=['ParamEyeLOpen', 'ParamEyeROpen']), dict(Target='Parameter', Name='LipSync', Ids=['ParamMouthOpenY'])])
                (directory / 'model.model3.json').write_text(json.dumps(manifest))
                with zipfile.ZipFile(directory / 'runtime.tmp', 'w', zipfile.ZIP_DEFLATED) as archive:
                    for name in ['model.moc3', 'model.model3.json', 'model.moc3.report.json', *textures]:
                        if not (directory / name).stat().st_size:
                            raise RuntimeError('产物为空')
                        archive.write(directory / name, name)
                (directory / 'runtime.tmp').replace(directory / 'runtime.zip')
                self.save(job, 'succeeded', '原生运行包已生成，Core 检查通过；视觉效果请在预览中确认')
            except asyncio.CancelledError:
                self.save(job, 'queued', '服务重启后继续编译')
                raise
            except Exception as error:
                self.save(job, 'failed', str(error) or '编译超时；CMO3 已保留')
            finally:
                if process and process.returncode is None:
                    process.kill()
                    await process.wait()
