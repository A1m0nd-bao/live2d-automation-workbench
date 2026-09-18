import { useCallback, useEffect, useState } from 'react';
import JSZip from 'jszip';
import { NativeRuntimeViewer } from './NativeRuntimeViewer';
import { readAsset, saveAsset } from './assets';
import { readRuntimePackage } from './runtimeMotionWorkflow.mjs';

const KEY = 'standalone-preview:runtime:v1';
const SAMPLE = `${import.meta.env.BASE_URL}preview-assets/ana-runtime.zip`;
export default function RuntimePreviewPage() {
  useEffect(() => { const title = document.title; document.title = 'Live2D 交互预览 · Morph'; return () => { document.title = title; }; }, []);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('首次打开演示 Ana；之后恢复本浏览器导入的角色。');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const saved = await readAsset(KEY);
    if (saved) return saved;
    const response = await fetch(SAMPLE);
    if (!response.ok) throw Error('Ana 范例加载失败');
    return response.blob();
  }, []);
  const save = useCallback(async (file: File) => {
    await saveAsset(KEY, file);
    setMessage(`当前自定义角色：${file.name}（仅保存在本浏览器）`);
  }, []);
  async function importFiles(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true);
    try {
      let blob: Blob;
      if (files.length === 1 && /\.zip$/i.test(files[0].name)) blob = files[0];
      else {
        if (!files.some(f => f.name.endsWith('.model3.json'))) throw Error('MOC3 不包含纹理。请一起选择 model3.json、MOC3 和纹理，或导入完整 ZIP／文件夹。');
        const zip = new JSZip();
        for (const file of files) zip.file(file.webkitRelativePath || file.name, await file.arrayBuffer());
        blob = await zip.generateAsync({ type: 'blob' });
      }
      await readRuntimePackage(blob);
      await save(new File([blob], files.length === 1 ? files[0].name : 'custom-runtime.zip'));
      setRevision(n => n + 1);
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }
  return <main className="standalone-preview" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void importFiles(Array.from(e.dataTransfer.files)); }}>
    <header><a href={import.meta.env.BASE_URL}>← 返回自动化工作台</a><h1>Live2D 交互预览</h1><p>Ana 标准范例 · 自定义角色 · 参数滑块 · 动作播放</p></header>
    <section className="preview-import-panel">
      <label className="ghost-button">选择 ZIP / 模型配套文件<input disabled={busy} type="file" multiple accept=".zip,.moc3,.json,.png,.jpg,.jpeg" onChange={e => { void importFiles(Array.from(e.target.files || [])); e.target.value = ''; }} /></label>
      <label className="ghost-button">选择完整文件夹<input disabled={busy} type="file" multiple {...{ webkitdirectory: '' }} onChange={e => { void importFiles(Array.from(e.target.files || [])); e.target.value = ''; }} /></label>
      <button className="ghost-button" disabled={busy} onClick={async () => { setBusy(true); try { const r = await fetch(SAMPLE); if (!r.ok) throw Error('范例加载失败'); await saveAsset(KEY, await r.blob()); setMessage('已恢复 Ana 标准范例'); setRevision(n => n + 1); } catch(e) { setMessage(String(e)); } finally { setBusy(false); } }}>恢复 Ana 范例</button>
      <p role="status">{message}</p><small>可将完整 ZIP 拖到页面。MOC3 必须配套其自己的纹理与 model3.json；文件夹导入可保留子目录。文件不会上传。</small>
    </section>
    <NativeRuntimeViewer key={revision} savedPackageName="独立预览" loadSavedPackage={load} savePackage={save} />
  </main>;
}
