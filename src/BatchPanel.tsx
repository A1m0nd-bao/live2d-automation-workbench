import { useEffect, useRef, useState } from 'react';
import { BATCH_DEFAULTS, batchRequest, fingerprint, validateBatchFiles, type SplitBatch } from './batchQueue';
import { connectLocalRelay, hasDirectServiceConfig } from './serviceBridge';
import { downloadBlob, readAsset, saveAsset } from './assets';
import './batch.css';

const PENDING = 'morph.batch-upload.v1';
const LABELS = { uploading: '待上传', pending: '排队', queued: '排队', running: '拆件中', succeeded: 'PSD 已保存', failed: '失败' };
type Props = {
  onProduce: (batch: SplitBatch, profile: 'standard' | 'pro') => Promise<void>;
  runtimeCounts: Record<string, number>;
  seedFiles: File[];
};

export default function BatchPanel({ onProduce, runtimeCounts, seedFiles }: Props) {
  const [batches, setBatches] = useState<SplitBatch[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState('');
  const [settings, setSettings] = useState({ ...BATCH_DEFAULTS });
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [autoDownload, setAutoDownload] = useState(true);
  const autoDownloadRef = useRef(autoDownload);
  const [profile, setProfile] = useState<'standard' | 'pro'>('standard');
  const downloaded = useRef(new Set<string>());
  const actionLock = useRef(false);
  const refreshing = useRef(false);
  const active = batches.find(b => b.id === selected) ?? batches[0];
  useEffect(() => { autoDownloadRef.current = autoDownload; }, [autoDownload]);
  useEffect(() => { if (seedFiles.length) setFiles(seedFiles); }, [seedFiles]);

  async function load() {
    if (refreshing.current || !hasDirectServiceConfig()) return;
    refreshing.current = true;
    try {
      const list = await batchRequest<SplitBatch[]>('');
      setBatches(list);
      setError('');
      for (const batch of list) {
        const key = `morph.batch-downloaded.${batch.id}`;
        // Partial archives remain manually available; auto-download once only at terminal state.
        if (autoDownloadRef.current && batch.state === 'completed' && batch.succeeded && !localStorage.getItem(key) && !downloaded.current.has(batch.id)) {
          downloaded.current.add(batch.id);
          try {
            const zip = await batchRequest<Blob>(`/${batch.id}/output`);
            downloadBlob(zip, `${batch.name}-${batch.id.slice(0, 8)}-psd.zip`);
            localStorage.setItem(key, '1');
            setMessage(`${batch.name}：${batch.succeeded}/${batch.total} 份 PSD 已打包下载。`);
          } catch (reason) {
            downloaded.current.delete(batch.id);
            throw reason;
          }
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法同步批次');
    } finally { refreshing.current = false; }
  }
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, []);

  async function operate(action: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true); setError('');
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作未完成'); }
    finally { actionLock.current = false; setBusy(false); }
  }

  async function upload(batch: SplitBatch) {
    setSelected(batch.id);
    // The manifest is already persisted before the first remote mutation.
    const remote = await batchRequest<SplitBatch>('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: batch.id, name: batch.name, settings: batch.settings,
        items: batch.items.map(({ id, name, sha256 }) => ({ id, name, sha256 })) }) });
    for (const [i, item] of remote.items.entries()) {
      if (item.uploaded) continue;
      const source = await readAsset(`batch-source:${item.id}`);
      if (!source) throw new Error(`${item.name} 不在当前浏览器，请重新选择原图以恢复上传。`);
      setMessage(`上传 ${i + 1}/${remote.total} · ${item.name}`);
      await batchRequest(`/${batch.id}/items/${item.id}`, { method: 'PUT', body: source });
    }
    await batchRequest(`/${batch.id}/start`, { method: 'POST' });
    localStorage.removeItem(PENDING);
    setMessage(`已提交 ${remote.total} 张，服务器按清单顺序逐张拆件。`);
    setFiles([]);
    await load();
  }

  async function createBatch() {
    if (localStorage.getItem(PENDING)) throw new Error('已有上传待恢复，请先点击「恢复未完成上传」。');
    validateBatchFiles(files);
    const id = crypto.randomUUID().replaceAll('-', '');
    const items: SplitBatch['items'] = [];
    for (const file of files) {
      const itemId = crypto.randomUUID().replaceAll('-', '');
      await saveAsset(`batch-source:${itemId}`, file);
      items.push({ id: itemId, name: file.name, sha256: await fingerprint(file), uploaded: false,
        status: 'uploading', message: '等待上传', filename: '' });
    }
    const batch: SplitBatch = { id, name: title.trim() || `拆件-${new Date().toLocaleDateString('sv')}`, settings,
      items, state: 'uploading', total: items.length, succeeded: 0, failed: 0 };
    localStorage.setItem(PENDING, JSON.stringify(batch));
    await upload(batch);
  }

  async function resumeUpload() {
    const pending = localStorage.getItem(PENDING);
    const batch: SplitBatch | undefined = pending ? JSON.parse(pending) : active?.state === 'uploading' ? active : undefined;
    if (!batch) throw new Error('当前没有待恢复的上传。');
    // If browser storage was cleared, match by hash rather than by potentially duplicated filename.
    for (const file of files) {
      const digest = await fingerprint(file);
      for (const item of batch.items.filter(item => item.sha256 === digest)) await saveAsset(`batch-source:${item.id}`, file);
    }
    await upload(batch);
  }

  return <section className="batch-panel" aria-label="批量生产">
    <div className="batch-heading"><div><p className="eyebrow">BATCH PRODUCTION</p><h2>批量生产</h2></div>
      <button className="ghost-button" disabled={busy} onClick={() => void operate(async () => { await connectLocalRelay(); await load(); setMessage('已接入本机批处理队列。'); })}>接入本机桥接</button></div>
    <p>多张原图一次上传，See-Through 按顺序拆件。完成后打包 PSD，再接入本地 CMO3 / MOC3 制作。</p>
    <div className="batch-inputs">
      <label>批次名称<input value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：角色母版第二批" /></label>
      <label>原图（PNG/JPG，最多 100 张）<input type="file" multiple accept=".png,.jpg,.jpeg" onChange={e => setFiles(Array.from(e.target.files ?? []))} /></label>
      <label>分辨率<select value={settings.resolution} onChange={e => setSettings(s => ({ ...s, resolution: Number(e.target.value) }))}><option>768</option><option>1024</option><option>1280</option><option>1536</option></select></label>
      <label>随机种子<input type="number" min="0" max="9999" value={settings.seed} onChange={e => setSettings(s => ({ ...s, seed: Number(e.target.value) }))} /></label>
    </div>
    <div className="batch-options">
      <label><input type="checkbox" checked={settings.split_limbs} onChange={e => setSettings(s => ({ ...s, split_limbs: e.target.checked }))} />拆分左右手臂与腿</label>
      <label><input type="checkbox" checked={autoDownload} onChange={e => setAutoDownload(e.target.checked)} />完成后自动下载 ZIP</label>
      <span>原图直传 · 单张串行 · 失败记录保留</span>
    </div>
    {files.length > 0 && <ol className="batch-file-order">{files.map((f, i) => <li key={`${f.name}:${i}`}><span>{f.name}</span><button aria-label={`上移 ${f.name}`} disabled={busy || i === 0} onClick={() => setFiles(all => { const next = [...all]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; return next; })}>↑</button><button aria-label={`移除 ${f.name}`} disabled={busy} onClick={() => setFiles(all => all.filter((_, index) => i !== index))}>×</button></li>)}</ol>}
    <div className="batch-actions">
      <button className="primary-button" disabled={busy || !files.length} onClick={() => void operate(createBatch)}>开始批量拆件{files.length ? `（${files.length} 张）` : ''}</button>
      <button className="ghost-button" disabled={busy} onClick={() => void operate(resumeUpload)}>恢复未完成上传</button>
      <button className="ghost-button" disabled={busy} onClick={() => void load()}>同步批次</button>
    </div>
    {message && <p role="status">{message}</p>}{error && <p role="alert" className="batch-error">{error}</p>}
    {batches.length > 0 && <label className="batch-history">历史批次<select value={active?.id ?? ''} onChange={e => setSelected(e.target.value)}>{batches.map(b => <option key={b.id} value={b.id}>{b.name} · {b.succeeded}/{b.total}</option>)}</select></label>}
    {active && <>
      <div className="batch-summary"><b>拆件 {active.succeeded}/{active.total}</b><span>失败 {active.failed}</span><span>MOC3 {runtimeCounts[active.id] ?? 0}/{active.total}</span><span>{active.state === 'paused' ? '已暂停新提交' : active.state === 'completed' ? '拆件已结束' : active.state === 'uploading' ? '上传待完成' : '串行处理中'}</span></div>
      <progress value={active.succeeded + active.failed} max={active.total} />
      <div className="batch-actions">
        {active.state !== 'completed' && <button className="ghost-button" disabled={busy || active.state === 'uploading'} onClick={() => void operate(async () => { await batchRequest(`/${active.id}/${active.state === 'paused' ? 'start' : 'pause'}`, { method: 'POST' }); await load(); })}>{active.state === 'paused' ? '继续拆件' : '暂停后续拆件'}</button>}
        <button className="ghost-button" disabled={busy || !active.succeeded} onClick={() => void operate(async () => { const zip = await batchRequest<Blob>(`/${active.id}/output`); downloadBlob(zip, `${active.name}-${active.id.slice(0, 8)}-psd.zip`); })}>下载{active.state === 'completed' ? '本批' : '已完成'} PSD ZIP</button>
        <select aria-label="批量制作模式" value={profile} onChange={e => setProfile(e.target.value as 'standard' | 'pro')}><option value="standard">标准 CMO3 / MOC3</option><option value="pro">Pro CMO3 / MOC3</option></select>
        <button className="primary-button" disabled={busy || !active.succeeded} onClick={() => void operate(async () => { setMessage('本地制作队列已开始，请保持此页面打开。'); await onProduce(active, profile); setMessage('本批已完成项的本地制作结束，可在工作台查看文件与失败原因。'); })}>批量制作已完成的 PSD</button>
      </div>
      <small>暂停仅停止后续提交，当前拆件会继续。拆件由常驻 Relay 跟踪；本地建模时保持此页打开。</small>
      <div className="batch-table"><table><thead><tr><th>顺序</th><th>原图</th><th>状态</th><th>说明</th></tr></thead><tbody>{active.items.map((item, i) => <tr key={item.id}><td>{i + 1}</td><td>{item.name}</td><td>{LABELS[item.status]}</td><td>{item.message}</td></tr>)}</tbody></table></div>
    </>}
  </section>;
}
