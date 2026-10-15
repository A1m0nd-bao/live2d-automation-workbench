import { useEffect, useRef, useState } from 'react';
import { BATCH_DEFAULTS, batchRequest, fingerprint, validateBatchFiles, type SplitBatch } from './batchQueue';
import { connectLocalRelay, hasDirectServiceConfig, assertSplitRouteSupported, type SplitRoute } from './serviceBridge';
import { downloadBlob, readAsset, saveAsset } from './assets';
import './batch.css';
import { LIVE2D_PRO_STATES } from './live2dPro';
import type { Live2dPrepProvider } from './live2dPrep';
import { proRequest } from './proQueue';

const PENDING = 'morph.batch-upload.v1';
const LABELS = { uploading: '待上传', pending: '排队', queued: '排队', running: '拆件中', succeeded: 'PSD 已保存', failed: '失败', 'friendly-queued': '友好图排队', 'friendly-running': '友好化中', uncertain: '结果未知（已停队）' };
type Props = {
  onProduce: (batch: SplitBatch, profile: 'standard' | 'pro', states: string[], provider: Live2dPrepProvider) => Promise<void>;
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
  const [syncError, setSyncError] = useState('');
  const [autoDownload, setAutoDownload] = useState(true);
  const [autoVariants, setAutoVariants] = useState(false);
  const autoDownloadRef = useRef(autoDownload);
  const [profile, setProfile] = useState<'standard' | 'pro'>('standard');
  const [poseIds, setPoseIds] = useState(['action_02_wave_arms_only']);
  const [poseProvider, setPoseProvider] = useState<Live2dPrepProvider>('image2');
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
      setSyncError('');
      for (const batch of list) {
        const multi = !!batch.delivery;
        const key = `morph.batch-downloaded.${batch.id}${multi ? '.multi-state.v1' : ''}`;
        // Partial archives remain manually available; auto-download once only at terminal state.
        if (autoDownloadRef.current && (multi ? batch.delivery?.state === 'completed' && batch.delivery.ready > 0 : batch.state === 'completed' && batch.succeeded > 0) && !localStorage.getItem(key) && !downloaded.current.has(key)) {
          downloaded.current.add(key);
          try {
            const zip = await batchRequest<Blob>(`/${batch.id}${multi ? '/delivery' : ''}/output`);
            downloadBlob(zip, `${batch.name}-${batch.id.slice(0, 8)}-${multi ? '多状态' : '基础'}-psd.zip`);
            localStorage.setItem(key, '1');
            setMessage(`${batch.name}：${multi ? batch.delivery?.ready : batch.succeeded}/${batch.total} 份${multi ? '多状态' : '基础'} PSD 已打包下载；未完成项见清单。`);
          } catch (reason) {
            downloaded.current.delete(key);
            throw reason;
          }
        }
      }
    } catch (reason) {
      setSyncError(reason instanceof Error ? reason.message : '无法同步批次');
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
    await assertSplitRouteSupported(batch.settings.upstream_route);
    setSelected(batch.id);
    // The manifest is already persisted before the first remote mutation.
    const remote = await batchRequest<SplitBatch>('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: batch.id, name: batch.name, settings: batch.settings,
        items: batch.items.map(({ id, name, sha256 }) => ({ id, name, sha256 })) }) });
    let uploaded = remote.items.filter(item => item.uploaded).length;
    for (const item of remote.items) {
      if (item.uploaded) continue;
      const source = await readAsset(`batch-source:${item.id}`);
      if (!source) throw new Error(`${item.name} 不在当前浏览器，请重新选择原图以恢复上传。`);
      setMessage(`已上传 ${uploaded}/${remote.total} · 正在上传 ${item.name}`);
      try {
        await batchRequest(`/${batch.id}/items/${item.id}`, { method: 'PUT', body: source });
      } catch (reason) {
        setMessage(`上传中断 · 已确认 ${uploaded}/${remote.total}，尚未启动处理。`);
        const detail = reason instanceof Error ? reason.message : '网络请求失败';
        throw new Error(`${item.name} 上传失败：${detail}。请检查本机桥接版本与连接，再点击「恢复未完成上传」；恢复完成后会按原设置开始处理。`);
      }
      uploaded += 1;
      setMessage(`已上传 ${uploaded}/${remote.total}`);
    }
    if (batch.pose_plan) await batchRequest(`/${batch.id}/delivery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...batch.pose_plan, start: true }) });
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
      items, state: 'uploading', total: items.length, succeeded: 0, failed: 0,
      ...(autoVariants ? { pose_plan: { states: [...poseIds], provider: poseProvider } } : {}) };
    if (autoVariants && !poseIds.length) throw new Error('自动接续多状态时至少选择一个动作。');
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
    <p>多张原图一次上传，默认先生成 Live2D 友好母版，通过检查后逐张 See-Through。基础 PSD 再生成局部动作替换层、本地绑定并交付动作与表情文件。</p>
    <div className="batch-inputs">
      <label>批次名称<input value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：角色母版第二批" /></label>
      <label>原图（PNG/JPG，最多 100 张）<input type="file" multiple accept=".png,.jpg,.jpeg" onChange={e => setFiles(Array.from(e.target.files ?? []))} /></label>
      <label>分辨率<select value={settings.resolution} onChange={e => setSettings(s => ({ ...s, resolution: Number(e.target.value) }))}><option>768</option><option>1024</option><option>1280</option><option>1536</option></select></label>
      <label>随机种子<input type="number" min="0" max="9999" value={settings.seed} onChange={e => setSettings(s => ({ ...s, seed: Number(e.target.value) }))} /></label>
    </div>
    <div className="batch-options">
      <label>拆图线路<select aria-label="批量拆图线路" value={settings.upstream_route ?? 'default'} onChange={e=>setSettings(s=>({...s,upstream_route:e.target.value as SplitRoute}))}><option value="default">默认线路（现有配置）</option><option value="yangzxo">备用：yangzxo / See-Through</option></select></label>
      <small>备用线路会上传到 yangzxo 空间；仅新批次生效，不自动切换已有任务。</small>
      <label><input type="checkbox" checked={settings.friendly ?? true} onChange={e => setSettings(s => ({ ...s, friendly: e.target.checked }))} />先生成友好图（会产生生图费用）</label>
      {settings.friendly && <label>友好图提供方<select value={settings.provider} onChange={e => setSettings(s => ({ ...s, provider: e.target.value as 'doubao' | 'image2' }))}><option value="doubao">豆包</option><option value="image2">Image-2</option></select></label>}
      <label><input type="checkbox" checked={settings.split_limbs} onChange={e => setSettings(s => ({ ...s, split_limbs: e.target.checked }))} />拆分左右手臂与腿</label>
      <label><input type="checkbox" checked={autoVariants} onChange={e => setAutoVariants(e.target.checked)} />新批次拆层后自动接续多状态 PSD（部件生图另计费）</label>
      <label><input type="checkbox" checked={autoDownload} onChange={e => setAutoDownload(e.target.checked)} />所选交付阶段结束后自动下载 ZIP</label>
      <span>{settings.friendly ? '友好化 → 检查 → 串行拆件' : '已是友好母版：原图直传'} · 失败记录保留</span>
    </div>
    {files.length > 0 && <ol className="batch-file-order">{files.map((f, i) => <li key={`${f.name}:${i}`}><span>{f.name}</span><button aria-label={`上移 ${f.name}`} disabled={busy || i === 0} onClick={() => setFiles(all => { const next = [...all]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; return next; })}>↑</button><button aria-label={`移除 ${f.name}`} disabled={busy} onClick={() => setFiles(all => all.filter((_, index) => i !== index))}>×</button></li>)}</ol>}
    <div className="batch-actions">
      <button className="primary-button" disabled={busy || !files.length} onClick={() => void operate(createBatch)}>开始批量{settings.friendly ? '友好化与' : ''}拆件{files.length ? `（${files.length} 张）` : ''}</button>
      <button className="ghost-button" disabled={busy} onClick={() => void operate(resumeUpload)}>恢复未完成上传</button>
      <button className="ghost-button" disabled={busy} onClick={() => void load()}>同步批次</button>
    </div>
    {message && <p role="status">{message}</p>}{(error || syncError) && <p role="alert" className="batch-error">{error || syncError}</p>}
    {batches.length > 0 && <label className="batch-history">历史批次<select value={active?.id ?? ''} onChange={e => setSelected(e.target.value)}>{batches.map(b => <option key={b.id} value={b.id}>{b.name} · {b.succeeded}/{b.total}</option>)}</select></label>}
    {active && <>
      <div className="batch-summary">{active.settings.friendly && <b>友好图 {active.friendly_succeeded ?? 0}/{active.total}</b>}<b>基础拆件 {active.succeeded}/{active.total}</b><b>多状态 PSD {active.delivery?.ready ?? 0}/{active.total}</b><span>失败 {active.failed}</span>{!!active.uncertain && <span>结果未知 {active.uncertain}，未重试</span>}<span>MOC3 {runtimeCounts[active.id] ?? 0}/{active.total}</span><span>{active.state === 'paused' ? '基础拆件已暂停' : active.state === 'completed' ? '仅基础拆件结束' : active.state === 'uploading' ? '上传待完成' : '串行处理中'}</span></div>
      {active.delivery && <p><output>可复用基础 PSD {active.delivery.resolved_base_count}/{active.total} · 多状态：{active.delivery.state === 'blocked' ? '服务暂停' : active.delivery.state === 'paused' ? '已暂停新任务' : active.delivery.state === 'completed' ? '本阶段结束（失败项仍保留）' : '服务端接续处理中'} · {active.delivery.needs_attention} 项需处理。{active.delivery.message}</output></p>}
      {active.delivery && <p>本批已锁定：{active.delivery.provider === 'image2' ? 'Image-2' : '豆包'} · {active.delivery.states.map(id => LIVE2D_PRO_STATES.find(s => s.id === id)?.label ?? id).join('、')}。下方动作选择仅用于新批次或尚未接续的批次。</p>}
      <progress value={active.succeeded + active.failed} max={active.total} />
      <div className="batch-actions">
        {active.state !== 'completed' && <button className="ghost-button" disabled={busy || active.state === 'uploading'} onClick={() => void operate(async () => { await batchRequest(`/${active.id}/${active.state === 'paused' ? 'start' : 'pause'}`, { method: 'POST' }); await load(); })}>{active.state === 'paused' ? '继续拆件' : '暂停后续拆件'}</button>}
        <button className="ghost-button" disabled={busy || !active.succeeded} onClick={() => void operate(async () => { const zip = await batchRequest<Blob>(`/${active.id}/output`); downloadBlob(zip, `${active.name}-${active.id.slice(0, 8)}-基础-psd.zip`); })}>下载基础 PSD（不含新动作）</button>
        <button className="ghost-button" disabled={busy || !active.delivery?.ready} onClick={() => void operate(async () => { const zip = await batchRequest<Blob>(`/${active.id}/delivery/output`); downloadBlob(zip, `${active.name}-多状态-psd.zip`); })}>下载已完成多状态 PSD</button>
        {!active.delivery && <button className="primary-button" disabled={busy || !poseIds.length} onClick={() => void operate(async () => { await batchRequest(`/${active.id}/delivery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ states: poseIds, provider: poseProvider, start: true }) }); await load(); setMessage('已接续多状态队列：只复用现有及随后完成的基础 PSD，不重生基础图，不再逐张 See-Through。部件生图可能计费。'); })}>接续本批多状态 PSD（可能计费）</button>}
        {active.delivery && <button className="ghost-button" disabled={busy || active.delivery.state === 'blocked' || active.delivery.state === 'completed'} onClick={() => void operate(async () => { await batchRequest(`/${active.id}/delivery/${active.delivery?.state === 'paused' ? 'start' : 'pause'}`, { method: 'POST' }); await load(); })}>{active.delivery.state === 'paused' ? '继续多状态队列' : '暂停接收新角色'}</button>}
        {active.delivery?.state === 'blocked' && <button className="ghost-button" disabled={busy} onClick={() => void operate(async () => { await proRequest('/pose-jobs/provider/resume', new FormData()); await load(); setMessage('已明确解除服务暂停；后续未提交部件可能计费，失败和结果未知的旧任务不会重生。'); })}>上游限制已解除，恢复后续请求（可能计费，不重试失败项）</button>}
        <select aria-label="批量制作模式" value={profile} onChange={e => setProfile(e.target.value as 'standard' | 'pro')}><option value="standard">标准 CMO3 / MOC3</option><option value="pro">Pro CMO3 / MOC3</option></select>
        <button className="primary-button" disabled={busy || !active.succeeded || (profile === 'pro' && !poseIds.length)} onClick={() => void operate(async () => { setMessage(profile === 'pro' ? '从基础 PSD 生成局部部件（可能计费），不再逐张状态拆件；本地建模阶段请保持页面打开。' : '本地制作队列已开始，请保持此页面打开。'); await onProduce(active, profile, poseIds, poseProvider); setMessage('本批已完成项的本地制作结束，可在工作台查看文件与失败原因。'); })}>批量制作已完成的 PSD{profile === 'pro' ? '（部件生图可能计费）' : ''}</button>
      </div>
      {active.delivery && <ul>{active.delivery.items.filter(item => item.status !== 'ready').map(item => <li key={item.item_id}>{active.items.find(base => base.id === item.item_id)?.name}：{item.message}</li>)}</ul>}
    </>}
      <fieldset className="pro-state-picker"><legend>PSD 局部动作 · 供自动接续与 Pro 制作使用</legend>
        <div>{LIVE2D_PRO_STATES.filter(s => s.kind === 'action').map(s => <label key={s.id}><input type="checkbox" disabled={busy} checked={poseIds.includes(s.id)} onChange={e => setPoseIds(ids => e.target.checked ? [...ids,s.id] : ids.filter(id => id !== s.id))} />{s.label}</label>)}</div>
        <label>部件生图提供方<select value={poseProvider} disabled={busy} onChange={e => setPoseProvider(e.target.value as Live2dPrepProvider)}><option value="doubao">豆包</option><option value="image2">Image-2</option></select></label>
        <small>整臂替换、另一侧复用；原像素和位置不变，仅纠正同侧虹膜/眼白、脸/脖子/上衣的强制顺序。嘴部与表情不改动；失败或未知结果不自动重生。</small>
      </fieldset>
    {active && <>
      <small>暂停仅停止后续提交，当前拆件会继续。拆件由常驻 Relay 跟踪；本地建模时保持此页打开。</small>
      <div className="batch-table"><table><thead><tr><th>顺序</th><th>原图</th><th>状态</th><th>说明</th></tr></thead><tbody>{active.items.map((item, i) => <tr key={item.id}><td>{i + 1}</td><td>{item.name}</td><td>{LABELS[item.status]}</td><td>{item.message}</td></tr>)}</tbody></table></div>
    </>}
  </section>;
}
