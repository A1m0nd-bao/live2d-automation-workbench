/* oxlint-disable react/react-compiler -- Browser-only storage hydration intentionally runs after SSR; effects synchronize IndexedDB and localStorage. */
import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  X,
  FolderOpen,
  Settings2,
  CircleHelp,
  UploadCloud,
  Sparkles,
  Layers3,
  Box,
  CheckCircle2,
  Clock3,
  ChevronRight,
  FileImage,
  ScanLine,
  ShieldCheck,
} from 'lucide-react';
import { connectService, serviceRequest } from './serviceBridge';
import { saveAsset, readAsset, downloadBlob } from './assets';
import { isJpeg, isPng } from './live2dPrep';
import { extractVariantManifest, importPsd } from './vendor/stretchystudio/io/psd.js';
import './production.css';

type Task = {
  id: string;
  name: string;
  referenceName: string;
  createdAt: string;
  remoteJobId?: string;
  remoteState?: string;
  remoteMessage?: string;
  psdFile?: string;
  inputFile?: string;
  inputKind?: string;
  preparedFile?: string;
  prepState?: 'queued' | 'succeeded' | 'failed';
  prepMessage?: string;
  prepAccepted?: boolean;
  qaPassed?: boolean;
  cmoFile?: string;
  runtimeFile?: string;
  hasGenerated?: boolean;
  cmoAccepted?: boolean;
  warnings?: string[];
};
type Job = {
  jobId?: string;
  status?: string;
  message?: string;
  error?: string;
};
type HistoryJob = Job & {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  message: string;
  created_at?: string;
  updated_at?: string;
  attempts?: number;
};
const STORAGE = 'morph.production.tasks';
const stage = (t: Task) =>
  t.cmoAccepted
    ? '运行时包已验收'
    : t.hasGenerated
      ? '运行时包已生成 · 待验收'
      : t.qaPassed
        ? '待生成运行时包'
        : t.psdFile || t.inputKind === 'stretch'
          ? '待确认输入'
          : t.remoteState === 'succeeded'
            ? 'PSD 已生成 · 待下载'
            : t.remoteState === 'failed'
              ? '拆分失败'
              : t.remoteJobId
                ? '后台拆分中'
                : t.inputKind === 'image' && !t.preparedFile
                  ? t.prepState === 'failed'
                    ? '豆包生图预处理失败'
                    : '待豆包生图预处理'
                  : '待提交参考图';
const kind = (f: File) =>
  /\.psd$/i.test(f.name)
    ? 'psd'
    : /\.stretch$/i.test(f.name)
      ? 'stretch'
      : /\.(png|jpe?g)$/i.test(f.name)
        ? 'image'
        : '';
function validate(f: File) {
  const k = kind(f);
  if (!k) throw new Error('请选择 PNG、JPG、PSD 或 .stretch 文件。');
  if (f.size > (k === 'image' ? 20 : 100) * 1024 * 1024)
    throw new Error('图片最大 20 MB，工程最大 100 MB。');
  return k;
}

async function asPreparedPng(data: ArrayBuffer) {
  if (isPng(data)) return new Blob([data], { type: 'image/png' });
  if (!isJpeg(data))
    throw new Error('豆包生图返回的文件不是 PNG 或 JPEG。');
  const source = new Blob([data], { type: 'image/jpeg' });
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('无法读取豆包生图返回的 JPEG。'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法创建 PNG 转换画布。');
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!png) throw new Error('无法把豆包生图 JPEG 转为 PNG。');
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function assertLive2dFriendlyFrame(source: Blob) {
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('无法读取豆包生图结果。'));
      image.src = url;
    });
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height || height / width < 1.35)
      throw new Error(
        '豆包结果不是完整的 2:3 左右竖构图，已拦截，避免把半身或裁腿图送入拆层。请重试生成。',
      );

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    let transparent = 0;
    let visibleBottom = -1;
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const alpha = pixels[(y * width + x) * 4 + 3];
        if (alpha < 240) transparent += 1;
        if (alpha > 16) visibleBottom = y;
      }
    // Alpha outputs let us reliably reject a character whose body reaches the
    // image edge. Solid-background fallbacks cannot be segmented safely here.
    if (
      transparent > width * height * 0.01 &&
      visibleBottom >= height - Math.max(8, Math.round(height * 0.025))
    )
      throw new Error(
        '豆包结果的角色贴到了画幅底边，可能缺少脚部；已拦截，避免生成不合格 PSD。请重试生成。',
      );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]),
    [hydrated, setHydrated] = useState(false);
  const [selected, setSelected] = useState(''),
    [create, setCreate] = useState(false),
    [guide, setGuide] = useState(false);
  const [name, setName] = useState(''),
    [file, setFile] = useState<File | null>(null);
  const [toast, setToast] = useState(''),
    [connection, setConnection] = useState(
      '尚未连接；已有 PSD 可直接本地生成。',
    );
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(''),
    [preview, setPreview] = useState(''),
    [preparedPreview, setPreparedPreview] = useState('');
  const lock = useRef(false);
  const historyLoaded = useRef(false);
  const task = tasks.find((t) => t.id === selected);
  const featuredTask = task ?? tasks[0];
  const runningCount = tasks.filter(
    (t) =>
      Boolean(t.remoteJobId) &&
      !t.psdFile &&
      (t.remoteState === 'queued' || t.remoteState === 'running'),
  ).length;
  const deliveredCount = tasks.filter((t) => t.hasGenerated).length;
  const pipelineSteps = [
    {
      title: '参考图',
      note: featuredTask?.referenceName ?? '拖入角色参考图',
      state: featuredTask?.inputFile ? 'done' : 'queued',
      Icon: UploadCloud,
    },
    {
      title: '角色整理',
      note: featuredTask?.preparedFile
        ? '原画风已保留'
        : '全身构图与风格锁定',
      state: featuredTask?.preparedFile
        ? 'done'
        : featuredTask?.prepState === 'queued'
          ? 'working'
          : 'queued',
      Icon: Sparkles,
    },
    {
      title: '语义拆层',
      note: featuredTask?.remoteJobId
        ? featuredTask.remoteMessage || '服务端队列中'
        : 'See-Through PSD',
      state: featuredTask?.psdFile
        ? 'done'
        : featuredTask?.remoteJobId
          ? 'working'
          : 'queued',
      Icon: Layers3,
    },
    {
      title: 'PSD 质检',
      note: featuredTask?.psdFile ? '分层文件已保存' : '图层与边缘检查',
      state: featuredTask?.psdFile ? 'done' : 'queued',
      Icon: ScanLine,
    },
    {
      title: 'Cubism 交付',
      note: featuredTask?.hasGenerated ? 'CMO3 / 运行时包' : '自动生成待命',
      state: featuredTask?.hasGenerated ? 'done' : 'queued',
      Icon: Box,
    },
  ];
  const update = (id: string, patch: Partial<Task>) =>
    setTasks((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  async function loadServerHistory(notify = false) {
    const records = await serviceRequest<HistoryJob[]>('history');
    setTasks((current) => {
      const remote = new Map(records.map((record) => [record.id, record]));
      const localJobIds = new Set(
        current.map((item) => item.remoteJobId).filter(Boolean),
      );
      const refreshed = current.map((item) => {
        const record = item.remoteJobId
          ? remote.get(item.remoteJobId)
          : undefined;
        return record
          ? {
              ...item,
              remoteState: record.status,
              remoteMessage: record.error || record.message || record.status,
            }
          : item;
      });
      const recovered = records
        .filter((record) => !localJobIds.has(record.id))
        .map<Task>((record) => ({
          id: `server-${record.id}`,
          name: record.name,
          referenceName: `服务端任务 · ${record.id.slice(0, 8)}`,
          inputKind: 'image',
          remoteJobId: record.id,
          remoteState: record.status,
          remoteMessage: record.error || record.message || record.status,
          createdAt: (record.created_at || record.updated_at || '服务端记录')
            .replace('T', ' ')
            .replace('Z', '')
            .slice(0, 16),
        }));
      return [...refreshed, ...recovered];
    });
    setConnection(
      records.length
        ? `服务端历史已同步：${records.length} 条任务记录。`
        : '服务端历史已同步；当前持久化队列还没有可恢复记录。',
    );
    if (notify) setToast(`已同步 ${records.length} 条服务端任务记录。`);
  }
  useEffect(() => {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE) || '[]');
      if (Array.isArray(data))
        setTasks(data.filter((t) => t && typeof t.id === 'string'));
    } catch {
      /* old corrupt metadata is ignored */
    }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated || historyLoaded.current) return;
    historyLoaded.current = true;
    // Public Pages may not have its authenticated bridge open yet.  In that
    // case the explicit sync button retries after the user connects it.
    void loadServerHistory().catch(() => {});
  }, [hydrated]);
  useEffect(() => {
    if (hydrated) {
      try {
        localStorage.setItem(STORAGE, JSON.stringify(tasks));
      } catch {
        setToast('任务记录保存失败，请及时下载产物。');
      }
    }
  }, [tasks, hydrated]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 6500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    let alive = true,
      url = '';
    setPreview('');
    if (task?.hasGenerated)
      void readAsset(`${task.id}:preview`)
        .then((blob) => {
          if (blob && alive) {
            url = URL.createObjectURL(blob);
            setPreview(url);
          }
        })
        .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [task?.id, task?.hasGenerated]);
  useEffect(() => {
    let alive = true,
      url = '';
    setPreparedPreview('');
    if (task?.preparedFile)
      void readAsset(`${task.id}:prepared`)
        .then((blob) => {
          if (blob && alive) {
            url = URL.createObjectURL(blob);
            setPreparedPreview(url);
          }
        })
        .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [task?.id, task?.preparedFile]);
  async function operate(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setToast(e instanceof Error ? e.message : '操作失败');
    } finally {
      lock.current = false;
      setBusy(false);
      setProgress('');
    }
  }
  async function input(t: Task) {
    const blob = await readAsset(`${t.id}:input`);
    if (!blob)
      throw new Error(
        '此浏览器没有原始文件，请重新导入 PSD 或参考图。旧任务仅记录过文件名。',
      );
    return new File([blob], t.inputFile || t.psdFile || t.referenceName, {
      type: blob.type,
    });
  }
  async function prepared(t: Task) {
    const blob = await readAsset(`${t.id}:prepared`);
    if (!blob || !t.preparedFile)
      throw new Error('Live2D 友好图不在此浏览器，请重新生成。');
    return new File([blob], t.preparedFile, { type: 'image/png' });
  }
  async function psdInput(t: Task) {
    if (!t.psdFile) throw new Error('任务尚未取得 PSD。');
    const blob =
      (await readAsset(`${t.id}:psd`)) ?? (await readAsset(`${t.id}:input`));
    if (!blob) throw new Error('PSD 不在此浏览器，请重新导入或重新下载。');
    return new File([blob], t.psdFile, {
      type: 'image/vnd.adobe.photoshop',
    });
  }
  async function prepare(t: Task) {
    const source = await input(t);
    setProgress('豆包生图正在按 Live2D 规范重绘角色…');
    update(t.id, {
      prepState: 'queued',
      prepMessage: '正在生成 Live2D 友好图…',
    });
    try {
      const data = await serviceRequest<ArrayBuffer>('prepare', {
        image: source,
        name: source.name,
      });
      const png = await asPreparedPng(data);
      await assertLive2dFriendlyFrame(png);
      const filename = `${t.name}-live2d-friendly.png`;
      await saveAsset(
        `${t.id}:prepared`,
        png,
      );
      update(t.id, {
        preparedFile: filename,
        prepState: 'succeeded',
        prepAccepted: true,
        prepMessage: '已生成 Live2D 友好图，正在自动提交拆分。',
      });
      return new File([png], filename, { type: 'image/png' });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '豆包生图预处理失败。';
      update(t.id, { prepState: 'failed', prepMessage: message });
      throw error;
    }
  }
  async function submitToSeeThrough(t: Task, preparedImage?: File) {
    const f =
      preparedImage ??
      (t.inputKind === 'image' ? await prepared(t) : await input(t));
    setProgress('提交 Live2D 友好图到 See-Through…');
    const r = await serviceRequest<Job>('submit', { image: f, name: f.name });
    if (!r.jobId)
      throw new Error(r.error || '服务未返回任务编号，请检查服务端后再重试。');
    update(t.id, {
      remoteJobId: r.jobId,
      remoteState: 'queued',
      remoteMessage: r.message || '已提交，后台将自动下载 PSD。',
    });
  }
  async function startImagePipeline(t: Task) {
    const preparedImage = await prepare(t);
    await submitToSeeThrough(t, preparedImage);
    setToast('已自动生成友好图并提交 See-Through；PSD 完成后会自动下载。');
  }
  async function refresh(t: Task) {
    if (!t.remoteJobId) return;
    const result = await serviceRequest<Job>('status', {
      jobId: t.remoteJobId,
    });
    update(t.id, {
      remoteState: result.status,
      remoteMessage: result.error || result.message || result.status,
    });
    if (result.status === 'succeeded' && !t.psdFile) {
      setProgress('下载并保存拆分 PSD…');
      const data = await serviceRequest<ArrayBuffer>('output', {
        jobId: t.remoteJobId,
      });
      if (new TextDecoder().decode(data.slice(0, 4)) !== '8BPS')
        throw new Error('服务返回的文件不是 PSD。');
      const filename = `${t.name}.psd`;
      await saveAsset(`${t.id}:psd`, new Blob([data]));
      const readyTask = { ...t, psdFile: filename, qaPassed: true };
      update(t.id, {
        psdFile: filename,
        qaPassed: true,
      });
      setProgress('PSD 已下载，正在自动生成运行时包…');
      try {
        await generate(readyTask);
        setToast('PSD 已保存并自动生成运行时包；请在 Cubism 中验收 CMO3。');
      } catch (error) {
        const message = error instanceof Error ? error.message : '运行时包自动生成失败。';
        update(t.id, { qaPassed: false, warnings: [message] });
        setToast(`PSD 已保存，但自动生成未完成：${message}`);
      }
    }
  }
  useEffect(() => {
    if (!task?.remoteJobId || task.psdFile || task.remoteState === 'failed')
      return;
    const timer = setInterval(() => {
      if (!lock.current) void operate(() => refresh(task));
    }, 10000);
    return () => clearInterval(timer);
  }, [task]);
  async function generate(t: Task) {
    const f = t.psdFile ? await psdInput(t) : await input(t);
    const { generateCubism } = await import('./cubismEngine.js');
    const result = await generateCubism(f, t.name, setProgress);
    try {
      await saveAsset(`${t.id}:cmo`, result.cmo);
      await saveAsset(`${t.id}:bundle`, result.bundle);
      await saveAsset(`${t.id}:runtime`, result.runtimeBundle);
      await saveAsset(`${t.id}:stretch`, result.stretch);
      if (result.preview)
        await saveAsset(`${t.id}:preview`, result.preview as Blob);
    } catch {
      downloadBlob(result.bundle, `${result.name}-bundle.zip`);
      throw new Error(
        '浏览器空间不足，已尝试直接下载打包文件，请检查下载目录。',
      );
    }
    update(t.id, {
      cmoFile: `${result.name}.cmo3`,
      runtimeFile: result.runtimeFile,
      hasGenerated: true,
      cmoAccepted: false,
      warnings: result.report.warnings,
    });
    setToast('规范化运行时 MOC3 工程包已生成；CMO3 仍为实验性文件。');
  }
  async function download(t: Task, suffix: string, filename: string) {
    const blob = await readAsset(`${t.id}:${suffix}`);
    if (!blob) throw new Error('文件不在此浏览器，请重新导入或生成。');
    downloadBlob(blob, filename);
  }
  async function downloadPsd(t: Task) {
    const file = await psdInput(t);
    downloadBlob(file, t.psdFile!);
  }
  async function replace(t: Task, f: File) {
    const k = validate(f);
    await saveAsset(`${t.id}:input`, f);
    const patch: Partial<Task> = {
      inputFile: f.name,
      inputKind: k,
      preparedFile: undefined,
      prepState: undefined,
      prepMessage: undefined,
      prepAccepted: k === 'image',
      psdFile: k === 'psd' ? f.name : undefined,
      remoteJobId: undefined,
      remoteState: undefined,
      remoteMessage: undefined,
      qaPassed: false,
      hasGenerated: false,
      cmoFile: undefined,
      cmoAccepted: false,
      warnings: [],
    };
    update(t.id, patch);
    if (k === 'image')
      await startImagePipeline({
        ...t,
        ...patch,
        inputFile: f.name,
        inputKind: k,
      });
  }
  return (
    <main className="app-shell">
      <aside className="side-rail">
        <div className="brand-mark">
          <span className="brand-dot" />
          morph
        </div>
        <button className="new-task" onClick={() => setCreate(true)}>
          <Plus size={17} />
          新建生产任务
        </button>
        <nav className="main-nav">
          <button className="nav-item active" onClick={() => setSelected('')}>
            <FolderOpen size={18} />
            生产任务
          </button>
          <button className="nav-item" onClick={() => setGuide(true)}>
            <Settings2 size={18} />
            流程与隐私
          </button>
        </nav>
        <div className="rail-footer">真实文件 · 本地导出</div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="crumbs">生产任务 / Live2D 流程</div>
          <button className="help" onClick={() => setGuide(true)}>
            <CircleHelp size={18} />
            流程指南
          </button>
        </header>
        <div className="workspace-scroll">
          <section className="intro-row">
            <div>
              <p className="eyebrow">MORPH / CHARACTER FACTORY</p>
              <h1>角色生产控制台</h1>
              <p className="intro-copy">
                从原画保留、自动拆层到 Cubism 交付，每个文件和每一段状态都在同一条生产线内可见。
              </p>
            </div>
            <button className="primary-button" onClick={() => setCreate(true)}>
              <Plus size={17} /> 新建角色任务
            </button>
          </section>
          <section className="overview-grid" aria-label="生产概览">
            <article className="feature-card current-task">
              <div className="card-top">
                <div>
                  <span className="task-id">{featuredTask ? 'CURRENT CHARACTER' : 'READY FOR INPUT'}</span>
                  <h2>{featuredTask?.name ?? '等待第一位角色'}</h2>
                </div>
                <span className={featuredTask?.remoteJobId && !featuredTask.psdFile ? 'status-working' : 'status-done'}>
                  {featuredTask ? stage(featuredTask) : '生产线就绪'}
                </span>
              </div>
              <div className="production-visual" aria-hidden="true">
                <div className="visual-grid" />
                <div className="layer-planes">
                  <i /><i /><i /><i /><i />
                </div>
                <div className="visual-readout">
                  <span>LIVE LAYER MAP</span>
                  <b>{featuredTask?.psdFile ? 'PSD READY' : featuredTask?.preparedFile ? 'PREPARED' : 'INPUT'}</b>
                </div>
              </div>
              <div className="progress-copy">
                <span>{featuredTask?.remoteMessage || (featuredTask ? '自动化生产线已接管该任务' : '上传一张角色图，系统将自动开始处理')}</span>
                <b>{featuredTask?.hasGenerated ? '100%' : featuredTask?.remoteJobId ? '60%' : featuredTask ? '20%' : '0%'}</b>
              </div>
              <div className="progress-track"><span style={{ width: featuredTask?.hasGenerated ? '100%' : featuredTask?.remoteJobId ? '60%' : featuredTask ? '20%' : '0%' }} /></div>
              <div className="task-meta">
                <span><FileImage size={13} /> {featuredTask?.referenceName ?? '尚无源文件'}</span>
                <span><Clock3 size={13} /> {featuredTask?.createdAt ?? '立即开始'}</span>
              </div>
            </article>
            <article className="feature-card stats-card">
              <div className="card-heading">
                <div>
                  <p className="eyebrow">PRODUCTION PULSE</p>
                  <h2>今日生产概览</h2>
                </div>
                <ShieldCheck size={20} />
              </div>
              <div className="stats">
                <div><strong>{tasks.length}</strong><span>全部任务</span></div>
                <div><strong>{runningCount}</strong><span>正在拆分</span></div>
                <div><strong>{deliveredCount}</strong><span>已生成产物</span></div>
              </div>
              <div className="mini-chart" aria-label="任务活跃度">
                {[32, 48, 37, 68, 55, 83, 61].map((height, index) => <span key={height} className={index === 5 ? 'highlight' : ''} style={{ height: `${height}%` }} />)}
              </div>
              <div className="chart-labels"><span>输入</span><span>预处理</span><span>PSD</span><span>交付</span></div>
            </article>
          </section>
          <section className="pipeline-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">AUTOMATED PIPELINE</p>
                <h2>当前角色生产线</h2>
              </div>
              <div className="header-actions">
                <button className="ghost-button" onClick={() => { try { connectService(); setConnection('请在连接窗口登录，再点击检查连接。'); } catch (e) { setToast(String(e)); } }}>连接服务</button>
                <button className="ghost-button" disabled={busy} onClick={() => void operate(() => loadServerHistory(true))}>同步历史</button>
                <button className="ghost-button" disabled={busy} onClick={() => void operate(async () => {
                  const [relay, prep] = await Promise.allSettled([serviceRequest<{ ready?: boolean; message?: string }>('health'), serviceRequest<{ ready?: boolean; message?: string }>('prepHealth')]);
                  const relayMessage = relay.status === 'fulfilled' ? (relay.value.ready ? 'See-Through 已就绪' : relay.value.message) : relay.reason instanceof Error ? relay.reason.message : 'See-Through 不可用';
                  const prepMessage = prep.status === 'fulfilled' ? (prep.value.ready ? '豆包生图已就绪' : prep.value.message) : prep.reason instanceof Error ? prep.reason.message : '豆包生图不可用';
                  setConnection(`${relayMessage}；${prepMessage}`);
                  if (relay.status === 'fulfilled') await loadServerHistory();
                })}>检查服务</button>
              </div>
            </div>
            <div className="pipeline">
              {pipelineSteps.map(({ title, note, state: stepState, Icon }, index) => (
                <article className={`pipeline-step ${stepState}`} key={title}>
                  <div className="step-number"><Icon size={16} /></div>
                  <div className="step-title"><h3>{title}</h3>{stepState === 'done' && <CheckCircle2 size={13} />}</div>
                  <div className="step-content"><p>{note}</p></div>
                  <div className="step-footer"><span>STEP {String(index + 1).padStart(2, '0')}</span><b>{stepState === 'done' ? '已完成' : stepState === 'working' ? '处理中' : '等待触发'}</b></div>
                </article>
              ))}
            </div>
            <div className="service-strip"><span className="live-dot" /> {connection} <small>上传图片后由服务端持续跟踪 PSD，不依赖页面保持打开。</small></div>
          </section>
          <section className="bottom-grid">
            <article className="table-card">
              <div className="section-heading compact">
                <div><p className="eyebrow">CHARACTER QUEUE</p><h2>角色生产队列</h2></div>
                <span>{tasks.length} 个任务</span>
              </div>
              {tasks.length ? (
                <div className="task-card-grid">
                  {tasks.map((t) => (
                    <button
                      className="task-card task-link"
                      key={t.id}
                      onClick={() => setSelected(t.id)}
                    >
                      <div className="task-card-icon"><FileImage size={17} /></div>
                      <div className="task-card-copy">
                        <b>{t.name}</b>
                        <small>{t.referenceName}</small>
                      </div>
                      <span className="task-state">{stage(t)}</span>
                      <ChevronRight size={17} />
                    </button>
                  ))}
                </div>
              ) : (
                <button className="queue-empty" onClick={() => setCreate(true)}><UploadCloud size={21} /><span>还没有角色任务<br /><small>上传参考图，自动生产线会立即启动</small></span><ChevronRight size={17} /></button>
              )}
            </article>
            <article className="risk-card">
              <div className="risk-icon"><Box size={18} /></div>
              <p className="eyebrow">DELIVERY CHECKPOINT</p>
              <h2>Cubism 交付区</h2>
              <p>自动产出 PSD、CMO3 与运行时包；在 Cubism Editor 打开 CMO3 后确认变形、遮罩和动作参数。</p>
              <button className="text-button" onClick={() => setGuide(true)}>
                查看交付检查项 <ChevronRight size={14} />
              </button>
            </article>
          </section>
        </div>
      </section>
      {toast && (
        <output className="toast" aria-live="polite">
          {toast}
        </output>
      )}
      {create && (
        <Modal title="新建生产任务" close={() => setCreate(false)}>
          <p>
            原图保存在当前浏览器。PNG/JPG 上传后会自动生成 Live2D 友好图、提交
            See-Through、轮询下载 PSD 并尝试生成运行时包；PSD 与 .stretch 不经过生图步骤。
          </p>
          <label className="field-label">
            任务名称
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field-label">
            参考图 / 已验收 PSD / Stretchy 工程
            <input
              type="file"
              accept=".png,.jpg,.jpeg,.psd,.stretch"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() =>
              void operate(async () => {
                if (!name.trim() || !file)
                  throw new Error('请填写名称并选择文件。');
                const k = validate(file),
                  id = crypto.randomUUID();
                await saveAsset(`${id}:input`, file);
                const next: Task = {
                  id,
                  name: name.trim(),
                  referenceName: file.name,
                  inputFile: file.name,
                  inputKind: k,
                  psdFile: k === 'psd' ? file.name : undefined,
                  createdAt: new Date().toLocaleString('zh-CN'),
                };
                setTasks((all) => [next, ...all]);
                setSelected(id);
                setCreate(false);
                setName('');
                setFile(null);
                if (k === 'image') await startImagePipeline(next);
              })
            }
          >
            保存并建立任务
          </button>
        </Modal>
      )}
      {task && !create && (
        <Modal title={task.name} close={() => setSelected('')}>
          <span className="task-state">{stage(task)}</span>
          <p>{task.remoteMessage}</p>
          <div className="detail-stack">
            {task.remoteJobId && <small>服务端任务：{task.remoteJobId}</small>}
            {task.prepMessage && <small>{task.prepMessage}</small>}
            {task.inputKind === 'image' &&
              !task.preparedFile &&
              !task.remoteJobId &&
              task.prepState === 'failed' && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void operate(() => startImagePipeline(task))}
                >
                  重试自动化处理
                </button>
              )}
            {task.preparedFile && (
              <>
                <button
                  className="ghost-button"
                  disabled={busy}
                  onClick={() =>
                    void operate(() =>
                      download(task, 'prepared', task.preparedFile!),
                    )
                  }
                >
                  下载 Live2D 友好图
                </button>
                {preparedPreview && (
                  <figure>
                    {/* Local Blob preview has no public URL for server image optimization. */}
                    {/* oxlint-disable-next-line next/no-img-element */}
                    <img
                      className="psd-preview"
                      src={preparedPreview}
                      alt="经预处理的 Live2D 角色参考"
                    />
                    <figcaption>自动化预处理结果；已自动投递 See-Through。</figcaption>
                  </figure>
                )}
              </>
            )}
            {!task.psdFile &&
              task.inputKind !== 'stretch' &&
              !task.remoteJobId &&
              (task.inputKind !== 'image' || task.prepAccepted) && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void operate(() => submitToSeeThrough(task))}
                >
                  提交处理图到 See-Through
                </button>
              )}
            {task.remoteJobId && !task.psdFile && (
              <button
                className="ghost-button"
                disabled={busy}
                onClick={() => void operate(() => refresh(task))}
              >
                {task.remoteState === 'succeeded'
                  ? '下载服务端 PSD'
                  : '刷新状态 / 拉取 PSD'}
              </button>
            )}
            <label className="field-label">
              重新导入输入文件
              <input
                disabled={busy}
                type="file"
                accept=".psd,.stretch,.png,.jpg,.jpeg"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void operate(() => replace(task, f));
                  e.target.value = '';
                }}
              />
            </label>
            <button
              className="ghost-button"
              disabled={busy}
              onClick={() =>
                void operate(() =>
                  download(
                    task,
                    'input',
                    task.inputFile || task.psdFile || task.referenceName,
                  ),
                )
              }
            >
              下载原始输入文件
            </button>
            {task.psdFile && (
              <button
                className="ghost-button"
                disabled={busy}
                onClick={() => void operate(() => downloadPsd(task))}
              >
                下载拆分 PSD
              </button>
            )}
            {(task.psdFile || task.inputKind === 'stretch') &&
              !task.qaPassed && (
                <button
                  className="ghost-button"
                  disabled={busy}
                  onClick={() => update(task.id, { qaPassed: true })}
                >
                  确认输入质检通过
                </button>
              )}
            {task.qaPassed && (
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => void operate(() => generate(task))}
              >
                {task.hasGenerated ? '重新生成运行时包' : '在浏览器生成运行时包'}
              </button>
            )}
            {busy && <output>{progress || '处理中…'}</output>}
            {task.hasGenerated && (
              <>
                <button
                  className="ghost-button"
                  disabled={busy}
                  onClick={() =>
                    void operate(() => download(task, 'cmo', task.cmoFile!))
                  }
                >
                  下载实验性 CMO3
                </button>
                <button
                  className="ghost-button"
                  disabled={busy}
                  onClick={() =>
                    void operate(() =>
                      download(task, 'bundle', `${task.name}-bundle.zip`),
                    )
                  }
                >
                  下载工程包（含报告与 .stretch）
                </button>
                {task.runtimeFile && (
                  <button
                    className="ghost-button"
                    disabled={busy}
                    onClick={() =>
                      void operate(() =>
                        download(task, 'runtime', task.runtimeFile!),
                      )
                    }
                  >
                    下载运行时 MOC3 包
                  </button>
                )}
                <button
                  className="ghost-button"
                  disabled={busy || task.cmoAccepted}
                  onClick={() => {
                    if (
                      window.confirm(
                        '已在运行时 Viewer 中打开本次 MOC3 包并检查基础显示与动作切换了吗？',
                      )
                    )
                      update(task.id, { cmoAccepted: true });
                  }}
                >
                  记录 Cubism 动作验收通过
                </button>
              </>
            )}
            {task.warnings?.map((w, i) => (
              <small key={i}>{w}</small>
            ))}
            {preview && (
              <figure>
                {/* Local Blob preview has no public URL for server image optimization. */}
                {/* oxlint-disable-next-line next/no-img-element */}
                <img
                  className="psd-preview"
                  src={preview}
                  alt="输入 PSD 图层合成"
                />
                <figcaption>输入 PSD 合成图，不是 CMO3 动作预览。</figcaption>
              </figure>
            )}
            {task.psdFile && <PsdVariantPreview task={task} />}
          </div>
        </Modal>
      )}
      {guide && (
        <Modal title="流程与数据边界" close={() => setGuide(false)}>
          <ol className="guide-list">
            <li>有 PSD：直接新建任务并导入，确认图层质量后点击生成。</li>
            <li>
              仅有原图：连接私有服务、登录、检查连接，先用豆包生图
              生成全身中立的 Live2D
              友好图。确认身份、服装、四肢和附件都完整后才提交拆分。
            </li>
            <li>浏览器完成网格和规范化运行时导出，生成期间不要关闭页面。</li>
            <li>
              实验性 CMO3 仅供研究；运行时 MOC3 包用于
              SDK/播放器联调，生成文件仍需实际验收。
            </li>
          </ol>
          <p>
            本机文件和 Cubism 产物保存在此浏览器；服务端队列记录会自动同步，因此刷新或更换浏览器仍可看到任务状态。PSD 成功后请尽快下载备份，服务端任务持久化不等于永久资产存储。
          </p>
          <p>
            兼容路径固定 StretchyStudio
            24a83a2，使用标准自动绑定；手工原生变形器不保证无损。密钥不存入公开前端。
          </p>
          <p>
            豆包生图
            使用原图做身份保持编辑，不是无约束文生图。处理图只是拆分输入，仍不等同于已绑定的
            Live2D 模型。
          </p>
          <a
            href="https://editor.stretchy.studio/"
            target="_blank"
            rel="noreferrer"
          >
            打开 Stretchy Studio 官方编辑器 ↗
          </a>
        </Modal>
      )}
    </main>
  );
}

type VariantPreviewProps = { task: Task };
type VariantPart = { name: string; slot: string; hidden: boolean };
type Variant = {
  id: string;
  kind: 'action' | 'expression';
  hidden: boolean;
  parts: VariantPart[];
};
type VariantManifest = { variants: Variant[] };
type PreviewLayer = {
  name: string;
  imageData: ImageData;
  visible: boolean;
  opacity: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
type PreviewModel = {
  width: number;
  height: number;
  layers: PreviewLayer[];
  manifest: VariantManifest;
};

function PsdVariantPreview({ task }: VariantPreviewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [model, setModel] = useState<PreviewModel | null>(null);
  const [action, setAction] = useState('');
  const [expression, setExpression] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setModel(null);
    setError('');
    void (async () => {
      try {
        const blob =
          (await readAsset(`${task.id}:psd`)) ??
          (await readAsset(`${task.id}:input`));
        if (!blob) throw new Error('PSD 不在当前浏览器，无法预览动作替换。');
        const buffer = await blob.arrayBuffer();
        const parsed = importPsd(buffer) as Omit<PreviewModel, 'manifest'>;
        const manifest = extractVariantManifest(buffer) as unknown as VariantManifest;
        if (alive) {
          setModel({ ...parsed, manifest });
          // A PSD can be saved while an action group is open and its neutral
          // parts are hidden.  Preview always begins from the production
          // canonical pose; actions and expressions are opt-in replacements.
          setAction('');
          setExpression('');
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'PSD 动作预览失败。');
      }
    })();
    return () => {
      alive = false;
    };
  }, [task.id]);

  useEffect(() => {
    if (!model || !canvas.current) return;
    const target = canvas.current;
    target.width = model.width;
    target.height = model.height;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, model.width, model.height);
    ctx.fillStyle = '#f1f3f7';
    ctx.fillRect(0, 0, model.width, model.height);
    const variants = model.manifest.variants;
    const selected = new Set([action, expression].filter(Boolean));
    const selectedParts = variants
      .filter((v) => selected.has(v.id))
      .flatMap((v) => v.parts);
    const selectedSlots = new Set(selectedParts.map((p) => p.slot));
    const variantByPart = new Map<string, Variant>();
    for (const variant of variants)
      for (const part of variant.parts) variantByPart.set(part.name, variant);

    const replaces = (base: string, replacement: string) =>
      base === replacement || replacement === base.replace(/-[lr]$/, '');

    for (const layer of [...model.layers].reverse()) {
      const variant = variantByPart.get(layer.name);
      if (variant) {
        // Variant groups are only drawn when explicitly selected. Their
        // authored PSD visibility is not meaningful here because an ancestor
        // action group may have been hidden when the file was saved.
        if (!selected.has(variant.id)) continue;
      } else if ([...selectedSlots].some((slot) => replaces(layer.name, slot))) {
        continue;
      }
      // Unqualified layers are the canonical pose. Draw them even when the
      // PSD saved them hidden: e.g. neutral handwear is commonly hidden while
      // an action pose was being authored.
      const tile = document.createElement('canvas');
      tile.width = layer.width;
      tile.height = layer.height;
      tile.getContext('2d')?.putImageData(layer.imageData, 0, 0);
      ctx.globalAlpha = layer.opacity ?? 1;
      ctx.drawImage(tile, layer.x, layer.y);
    }
    ctx.globalAlpha = 1;
  }, [model, action, expression]);

  if (!task.psdFile) return null;
  const actions = model?.manifest.variants.filter((v) => v.kind === 'action') || [];
  const expressions =
    model?.manifest.variants.filter((v) => v.kind === 'expression') || [];
  return (
    <section className="variant-preview">
      <div className="variant-preview-heading">
        <div>
          <p className="eyebrow">PSD VARIANT PREVIEW</p>
          <h3>动作 / 表情替换预览</h3>
        </div>
        {model && <small>{model.width}×{model.height} · 不修改原始 PSD</small>}
      </div>
      {error && <small>{error}</small>}
      {model && (
        <>
          <div className="variant-controls">
            <div>
              <span>动作</span>
              <button className={!action ? 'is-active' : ''} onClick={() => setAction('')}>基础</button>
              {actions.map((v) => (
                <button key={v.id} className={action === v.id ? 'is-active' : ''} onClick={() => setAction(v.id)}>
                  {v.id.replace(/^action_\d+_/, '')}
                </button>
              ))}
            </div>
            <div>
              <span>表情</span>
              <button className={!expression ? 'is-active' : ''} onClick={() => setExpression('')}>基础</button>
              {expressions.map((v) => (
                <button key={v.id} className={expression === v.id ? 'is-active' : ''} onClick={() => setExpression(v.id)}>
                  {v.id.replace(/^expression_\d+_/, '')}
                </button>
              ))}
            </div>
          </div>
          <canvas ref={canvas} className="variant-canvas" aria-label="PSD 动作替换预览" />
        </>
      )}
    </section>
  );
}

function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const root = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.showModal();
    return () => before?.focus();
  }, []);
  return (
    <div className="modal-backdrop">
      <dialog
        ref={root}
        tabIndex={-1}
        className="create-modal panel-modal"
        aria-modal="true"
        aria-label={title}
        onCancel={close}
      >
        <button className="close-modal" aria-label="关闭" onClick={close}>
          <X size={20} />
        </button>
        <h2>{title}</h2>
        <div className="panel-body">{children}</div>
      </dialog>
    </div>
  );
}
