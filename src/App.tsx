/* oxlint-disable react/react-compiler -- Browser-only storage hydration intentionally runs after SSR; effects synchronize IndexedDB and localStorage. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MorphUser } from './morphBackend';
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
  ArrowRight,
  Combine,
  GitBranch,
  WandSparkles,
} from 'lucide-react';
import { connectLocalRelay, hasDirectServiceConfig, saveDirectServiceConfig, serviceDiagnostics, serviceRequest } from './serviceBridge';
import { prepRequest, submitPrep, recoverPrepState, type PrepJob } from './prepQueue';
import { selectPreparation, type PrepMode } from './prepPolicy';
import { saveAsset, readAsset, downloadBlob } from './assets';
import {
  isJpeg,
  isPng,
  LIVE2D_PREP_PROVIDERS,
  type Live2dPrepProvider,
} from './live2dPrep';
import { LIVE2D_PRO_STATES, buildLive2DProManifest, selectedProStates } from './live2dPro';
import { mergeLive2dProPsd } from './live2dProMerge';
import { extractVariantManifest, importPsd } from './vendor/stretchystudio/io/psd.js';
import { ProductionAccess } from './ProductionAccess';
import { createProjectFromLocalTask, uploadProjectArtifact } from './productionLedger';
import { NativeRuntimeViewer } from './NativeRuntimeViewer';
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
  prepProvider?: Live2dPrepProvider;
  prepMode?: PrepMode;
  prepState?: 'connecting' | 'queued' | 'running' | 'succeeded' | 'user-confirmed' | 'failed' | 'uncertain' | 'needs-review';
  prepJobId?: string;
  prepAutoSplit?: boolean;
  prepMessage?: string;
  prepAccepted?: boolean;
  qaPassed?: boolean;
  cmoFile?: string;
  runtimeFile?: string;
  /** A native package exported by Cubism Editor, saved only in this browser. */
  nativeRuntimeFile?: string;
  hasGenerated?: boolean;
  cmoAccepted?: boolean;
  warnings?: string[];
  mode?: 'standard' | 'pro';
  proStateIds?: string[];
  proStateAssets?: Record<string, { filename: string; uploadedAt: string }>;
  /** States found inside a professionally authored multi-state PSD. */
  proEmbeddedStateIds?: string[];
  proMergedFile?: string;
  proMergeReportFile?: string;
  proStage?: 'persona_lock' | 'base_processing' | 'base_psd_ready' | 'embedded_states_ready' | 'state_generation' | 'state_decomposition' | 'merge_ready';
  cloudProjectId?: string;
  cloudSyncState?: 'syncing' | 'synced' | 'failed';
  cloudArtifactKeys?: string[];
};
type Job = {
  jobId?: string;
  status?: string;
  message?: string;
  error?: string;
};
type PrepHealth = {
  ready?: boolean;
  message?: string;
  providers?: Partial<Record<Live2dPrepProvider, { ready?: boolean; message?: string }>>;
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
  t.mode === 'pro' && t.proStage === 'base_psd_ready'
    ? 'Pro：基础 PSD 已就绪 · 待状态图'
    : t.mode === 'pro' && t.proStage === 'embedded_states_ready'
      ? 'Pro：已识别内嵌差分 · 可生成 CMO3'
    : t.mode === 'pro' && t.proStage === 'state_generation'
      ? 'Pro：等待状态图生成'
      : t.mode === 'pro' && t.proStage === 'persona_lock'
        ? 'Pro：等待基础状态处理'
        : t.cmoAccepted
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
                : t.prepState === 'needs-review'
                  ? '生成图已保存 · 待构图复核'
                : t.prepState === 'uncertain'
                  ? '生图结果待确认 · 未自动重试'
                : ['connecting', 'queued', 'running'].includes(t.prepState || '')
                  ? '服务端生图处理中'
                : t.inputKind === 'image' && !t.preparedFile
                  ? t.prepState === 'failed'
                    ? '生图预处理失败'
                    : '待生图预处理'
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
    throw new Error('生图服务返回的文件不是 PNG 或 JPEG。');
  const source = new Blob([data], { type: 'image/jpeg' });
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('无法读取生图服务返回的 JPEG。'));
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
    if (!png) throw new Error('无法把生图服务 JPEG 转为 PNG。');
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
      image.onerror = () => reject(new Error('无法读取生图服务结果。'));
      image.src = url;
    });
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height || height / width < 1.35)
      throw new Error(
        '生成结果不是完整的 2:3 左右竖构图，已拦截，避免把半身或裁腿图送入拆层。请重试生成。',
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
        '生成结果的角色贴到了画幅底边，可能缺少脚部；已拦截，避免生成不合格 PSD。请重试生成。',
      );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * See-Through's current inference canvas is square.  Feeding it a 2:3 image
 * directly makes some deployments centre-crop the legs before decomposition.
 * Preserve every source pixel by centring the validated portrait on a square,
 * transparent canvas instead of scaling or cropping it.
 */
async function padForSeeThrough(source: File) {
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('无法读取待提交的 Live2D 友好图。'));
      image.src = url;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error('待提交的 Live2D 友好图尺寸无效。');
    const edge = Math.max(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = edge;
    canvas.height = edge;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法创建 See-Through 安全画布。');
    context.clearRect(0, 0, edge, edge);
    context.drawImage(image, Math.round((edge - width) / 2), 0);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!png) throw new Error('无法生成 See-Through 安全画布。');
    return new File([png], source.name.replace(/\.[^.]+$/, '.png'), {
      type: 'image/png',
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]),
    [hydrated, setHydrated] = useState(false);
  const [selected, setSelected] = useState(''),
    [create, setCreate] = useState(false),
    [guide, setGuide] = useState(false),
    [directSetup, setDirectSetup] = useState(false),
    [upstreamDiagnostics, setUpstreamDiagnostics] = useState<{
      name: string;
      jobId: string;
      events: string;
    } | null>(null);
  const [name, setName] = useState(''),
    [file, setFile] = useState<File | null>(null);
  const [directRelayUrl, setDirectRelayUrl] = useState(''),
    [directDeviceToken, setDirectDeviceToken] = useState('');
  const [productionMode, setProductionMode] = useState<'standard' | 'pro'>('standard');
  const [prepProvider, setPrepProvider] = useState<Live2dPrepProvider>('doubao');
  const [prepMode, setPrepMode] = useState<PrepMode>('generate');
  const [proStateIds, setProStateIds] = useState<string[]>([
    'action_02_wave_arms_only',
    'action_03_hand_on_hip_arms_only',
    'action_04_arms_crossed_crossed_arms',
    'action_05_thinking_arms_only',
  ]);
  const [toast, setToast] = useState(''),
    [connection, setConnection] = useState(
      '尚未连接；已有 PSD 可直接本地生成。',
    );
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(''),
    [preview, setPreview] = useState(''),
    [preparedPreview, setPreparedPreview] = useState('');
  const [productionUser, setProductionUser] = useState<MorphUser | null>(null);
  const handleProductionUser = useCallback((user: MorphUser | null) => {
    setProductionUser(user);
  }, []);
  const lock = useRef(false);
  const historyLoaded = useRef(false);
  const productionSyncing = useRef(new Set<string>());
  const productionAttempted = useRef(new Set<string>());
  const productionArtifactsSyncing = useRef(new Set<string>());
  const prepRefreshing = useRef(new Set<string>());
  const prepHistoryLoaded = useRef(false);
  const currentTasks = useRef(tasks);
  useEffect(() => { currentTasks.current = tasks; }, [tasks]);
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
        ? (featuredTask.prepState === 'needs-review' ? '生成图可下载，构图待复核' : '构图基础检查完成')
        : '全身构图与风格锁定',
      state: featuredTask?.preparedFile && featuredTask.prepState !== 'needs-review'
        ? 'done'
        : ['connecting', 'queued', 'running'].includes(featuredTask?.prepState || '')
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
  async function loadPrepHistory() {
    const records = await prepRequest<PrepJob[]>('/jobs');
    setTasks((current) => {
      const existing = new Set(current.map((item) => item.prepJobId));
      const recovered: Task[] = records.filter((job) => !existing.has(job.id)).map((job) => ({
        id: `prep-${job.id}`, name: job.name, referenceName: '服务端生图记录', inputKind: 'image',
        prepJobId: job.id, prepProvider: job.provider, prepAutoSplit: false,
        // Re-download saved results through the same validation path.
        prepState: job.status === 'succeeded' ? 'queued' : job.status,
        prepMessage: job.message, createdAt: new Date(job.created_at * 1000).toLocaleString('zh-CN'),
      }));
      return [...current, ...recovered];
    });
  }
  useEffect(() => {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE) || '[]');
      if (Array.isArray(data))
        setTasks(data.filter((t) => t && typeof t.id === 'string').map((item: Task) => {
          const t = recoverPrepState(item);
          if (!t.prepMessage?.startsWith('直连模式：')) return t;
          // Preserve existing jobs/artifacts; never silently re-submit old work.
          return { ...t, prepAccepted: false,
            prepState: t.remoteJobId ? undefined : 'failed',
            preparedFile: t.remoteJobId ? t.preparedFile : undefined,
            prepMessage: '历史直传输入：未经过生图处理，也未经过 AI 验收。已有拆分任务保留；未提交任务需重新处理。',
          };
        }));
    } catch {
      /* old corrupt metadata is ignored */
    }
    setHydrated(true);
  }, []);
  useEffect(() => {
    // A local setup link carries its values in the URL fragment, which is not
    // sent to GitHub Pages.  It configures only this browser, then immediately
    // removes itself from the visible URL so a device key is never retained in
    // page history or copied links.
    const setup = new URLSearchParams(window.location.hash.slice(1));
    if (setup.get('morph-direct-setup') !== '1') return;
    try {
      saveDirectServiceConfig({
        relayUrl: setup.get('relay') || '',
        deviceToken: setup.get('device') || '',
      });
      setConnection('直连常驻 Relay 已在此浏览器启用；无需登录窗口。');
      setToast('直连 Relay 已启用。');
    } catch (error) {
      setToast(error instanceof Error ? error.message : '直连配置无效。');
    } finally {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  }, []);
  useEffect(() => {
    if (!hydrated || historyLoaded.current) return;
    historyLoaded.current = true;
    // Public Pages may not have its authenticated bridge open yet.  In that
    // case the explicit sync button retries after the user connects it.
    void loadServerHistory().catch(() => {});
  }, [hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    let alive = true;
    const synchronize = async () => {
      const [relay, prep] = await Promise.allSettled([
        serviceRequest<{ ready?: boolean; message?: string }>('health'),
        serviceRequest<{ ready?: boolean; message?: string }>('prepHealth'),
      ]);
      if (!alive) return;
      const relayMessage = relay.status === 'fulfilled'
        ? (relay.value.ready ? 'See-Through 服务端队列就绪' : relay.value.message || 'See-Through 服务不可用')
        : 'See-Through 正在等待服务端授权';
      const prepMessage = prep.status === 'fulfilled'
        ? (prep.value.ready ? '角色整理服务就绪' : prep.value.message || '角色整理服务不可用')
        : (prep.reason instanceof Error ? prep.reason.message : '常驻生图服务未连接');
      setConnection(`${relayMessage}；${prepMessage}。`);
      if (relay.status === 'fulfilled') void loadServerHistory().catch(() => {});
      if (prep.status === 'fulfilled' && !prepHistoryLoaded.current) {
        prepHistoryLoaded.current = true;
        void loadPrepHistory().catch(() => { prepHistoryLoaded.current = false; });
      }
    };
    void synchronize();
    const timer = window.setInterval(() => void synchronize(), 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
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
    if (!hydrated || !productionUser) return;
    const pending = tasks.filter((item) =>
      !item.cloudProjectId && !productionAttempted.current.has(item.id) && !productionSyncing.current.has(item.id),
    );
    for (const item of pending) {
      productionSyncing.current.add(item.id);
      productionAttempted.current.add(item.id);
      update(item.id, { cloudSyncState: 'syncing' });
      void readAsset(`${item.id}:input`)
        .then((source) => createProjectFromLocalTask(item, source ?? null))
        .then(({ projectId }) => {
          update(item.id, { cloudProjectId: projectId, cloudSyncState: 'synced' });
        })
        .catch((error) => {
          update(item.id, { cloudSyncState: 'failed' });
          setToast(error instanceof Error ? `团队账本未同步：${error.message}` : '团队账本同步失败。');
        })
        .finally(() => productionSyncing.current.delete(item.id));
    }
  }, [tasks, hydrated, productionUser]);
  useEffect(() => {
    if (!hydrated || !productionUser) return;
    const candidates: Array<{ task: Task; key: string; suffix: string; kind: 'prepared_image' | 'psd' | 'cmo3' | 'moc3_bundle' | 'stretch' | 'report' | 'preview'; filename?: string }> = [];
    for (const item of tasks) {
      if (!item.cloudProjectId) continue;
      if (item.preparedFile) candidates.push({ task: item, key: 'prepared', suffix: 'prepared', kind: 'prepared_image', filename: item.preparedFile });
      if (item.psdFile) candidates.push({ task: item, key: 'psd', suffix: 'psd', kind: 'psd', filename: item.psdFile });
      if (item.cmoFile) candidates.push({ task: item, key: 'cmo', suffix: 'cmo', kind: 'cmo3', filename: item.cmoFile });
      if (item.runtimeFile) candidates.push({ task: item, key: 'runtime', suffix: 'runtime', kind: 'moc3_bundle', filename: item.runtimeFile });
      if (item.hasGenerated) candidates.push({ task: item, key: 'bundle', suffix: 'bundle', kind: 'moc3_bundle', filename: `${item.name}-bundle.zip` });
      if (item.hasGenerated) candidates.push({ task: item, key: 'stretch', suffix: 'stretch', kind: 'stretch', filename: `${item.name}.stretch` });
      if (item.hasGenerated) candidates.push({ task: item, key: 'preview', suffix: 'preview', kind: 'preview', filename: `${item.name}-preview.png` });
      if (item.proMergeReportFile) candidates.push({ task: item, key: 'pro-merge-report', suffix: 'pro-merge-report', kind: 'report', filename: item.proMergeReportFile });
    }
    for (const candidate of candidates) {
      const token = `${candidate.task.id}:${candidate.key}`;
      if (candidate.task.cloudArtifactKeys?.includes(candidate.key) || productionArtifactsSyncing.current.has(token)) continue;
      productionArtifactsSyncing.current.add(token);
      void readAsset(`${candidate.task.id}:${candidate.suffix}`)
        .then((blob) => {
          if (!blob || !candidate.filename) throw new Error(`${candidate.filename || candidate.key} 不在当前浏览器。`);
          return uploadProjectArtifact({ projectId: candidate.task.cloudProjectId!, kind: candidate.kind, filename: candidate.filename, blob });
        })
        .then(() => update(candidate.task.id, { cloudArtifactKeys: [...(candidate.task.cloudArtifactKeys || []), candidate.key] }))
        .catch((error) => setToast(error instanceof Error ? `产物未同步：${error.message}` : '产物未同步到团队账本。'))
        .finally(() => productionArtifactsSyncing.current.delete(token));
    }
  }, [tasks, hydrated, productionUser]);
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
    if (t.prepState !== 'succeeded' && t.prepState !== 'user-confirmed')
      throw new Error('此输入尚未完成生图处理或用户确认，不能提交拆分。');
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
  async function proStatePsd(t: Task, stateId: string) {
    const asset = t.proStateAssets?.[stateId];
    if (!asset) throw new Error('缺少该状态的 PSD。');
    const blob = await readAsset(`${t.id}:pro-state:${stateId}:psd`);
    if (!blob) throw new Error(`${asset.filename} 不在此浏览器，请重新导入。`);
    return { data: await blob.arrayBuffer(), filename: asset.filename };
  }
  async function attachProStatePsd(t: Task, stateId: string, file: File) {
    if (kind(file) !== 'psd')
      throw new Error('状态输入应为 See-Through 输出的 PSD；状态原图会在后续队列入口单独提交。');
    const state = selectedProStates(t.proStateIds ?? []).find((item) => item.id === stateId);
    if (!state) throw new Error('这个状态不属于当前 Pro 任务。');
    await saveAsset(`${t.id}:pro-state:${stateId}:psd`, file);
    update(t.id, {
      proStateAssets: {
        ...t.proStateAssets,
        [stateId]: { filename: file.name, uploadedAt: new Date().toLocaleString('zh-CN') },
      },
      proStage: 'state_decomposition',
      remoteMessage: `${state.label} PSD 已保存；等待其他状态后即可执行本地语义合层。`,
    });
  }
  async function mergeProStates(t: Task) {
    if (!t.psdFile) throw new Error('请先准备基础 PSD。');
    const states = selectedProStates(t.proStateIds ?? []);
    const missing = states.filter((state) => !t.proStateAssets?.[state.id]);
    if (missing.length)
      throw new Error(`仍缺少状态 PSD：${missing.map((state) => state.label).join('、')}`);
    setProgress('正在本地识别语义槽位并写入隐藏状态图层…');
    const base = await psdInput(t);
    const inputs = await Promise.all(states.map(async (state) => {
      const source = await proStatePsd(t, state.id);
      return { state, ...source };
    }));
    const result = mergeLive2dProPsd(await base.arrayBuffer(), inputs);
    const filename = `${t.name}-live2d-pro-merged.psd`;
    const reportName = `${t.name}-live2d-pro-merge-report.json`;
    await saveAsset(`${t.id}:pro-merged-psd`, result.psd);
    await saveAsset(`${t.id}:pro-merge-report`, new Blob([
      JSON.stringify(result.report, null, 2),
    ], { type: 'application/json' }));
    update(t.id, {
      proMergedFile: filename,
      proMergeReportFile: reportName,
      proStage: 'merge_ready',
      qaPassed: false,
      remoteMessage: `已合并 ${states.length} 个状态；替换层默认隐藏，等待 PSD 预览验收。`,
    });
    setToast('多状态 PSD 已在本地合并；请下载并在 Cubism 前检查替换层。');
  }
  function rememberPrep(t: Task, patch: Partial<Task>) {
    // Save the request ID before issuing HTTP, not only in a later React effect.
    // If this fails, do not submit a paid request.
    const saved = JSON.parse(localStorage.getItem(STORAGE) || '[]') as Task[];
    const exists = saved.some((item) => item.id === t.id);
    localStorage.setItem(STORAGE, JSON.stringify(exists
      ? saved.map((item) => item.id === t.id ? { ...item, ...patch } : item)
      : [...saved, { ...t, ...patch }]));
    update(t.id, patch);
  }
  async function prepare(t: Task): Promise<File | undefined> {
    const provider = t.prepProvider ?? 'doubao';
    update(t.id, { prepState: 'connecting', prepAccepted: false, prepMessage: '正在检查常驻生图服务（最多 15 秒）…' });
    try {
      const source = await input(t);
      const health = await serviceRequest<PrepHealth>('prepHealth');
      if (!health.providers?.[provider]?.ready)
        throw new Error(health.providers?.[provider]?.message || '所选生图服务未配置。');
      const jobId = t.prepJobId || crypto.randomUUID().replaceAll('-', '');
      rememberPrep(t, { prepJobId: jobId, prepAutoSplit: true, prepState: 'queued', prepMessage: '正在保存服务端任务；相同编号不会重复生图。' });
      const job = await submitPrep(jobId, source, provider, t.name);
      update(t.id, { prepState: job.status, prepMessage: job.message });
      return undefined;
    } catch (error) {
      update(t.id, { prepState: 'failed', prepAccepted: false,
        prepMessage: error instanceof Error ? error.message : '无法连接常驻生图队列。请查询任务状态，不要重复生成。' });
      throw error;
    }
  }
  async function refreshPrep(t: Task) {
    if (!t.prepJobId || prepRefreshing.current.has(t.id)) return;
    prepRefreshing.current.add(t.id);
    try {
      const job = await prepRequest<PrepJob>(`/jobs/${t.prepJobId}`);
      if (job.status === 'succeeded' && t.preparedFile) return;
      update(t.id, { prepState: job.status === 'succeeded' ? 'queued' : job.status,
        prepMessage: job.status === 'succeeded' ? '服务端已出图，正在取回并检查构图…' : job.message });
      if (job.status !== 'succeeded' || t.preparedFile) return;
      const bytes = await prepRequest<ArrayBuffer>(`/jobs/${job.id}/output`);
      const png = await asPreparedPng(bytes);
      const filename = `${t.name}-generated.png`;
      // Persist and expose the candidate BEFORE the heuristic can reject it.
      await saveAsset(`${t.id}:prepared`, png);
      update(t.id, { preparedFile: filename, prepState: 'needs-review', prepAccepted: false });
      try {
        await assertLive2dFriendlyFrame(png);
      } catch (error) {
        update(t.id, { prepState: 'needs-review', prepAccepted: false,
          prepMessage: `生成图已保存，可预览和下载。构图检查需复核：${error instanceof Error ? error.message : '构图存疑'} 尚未提交拆层。` });
        return;
      }
      update(t.id, { prepState: 'succeeded', prepAccepted: true,
        prepMessage: '生成图已保存，构图基础检查通过（非 AI 语义验收）。' });
      if (!t.remoteJobId && t.prepAutoSplit) {
        try {
          await submitToSeeThrough({ ...t, preparedFile: filename, prepState: 'succeeded' }, new File([png], filename, { type: 'image/png' }));
        } catch (error) {
          update(t.id, { prepMessage: `生图已完成并保存；拆层提交未确认：${error instanceof Error ? error.message : '连接失败'}。请先查询拆层历史。` });
        }
      }
    } finally {
      prepRefreshing.current.delete(t.id);
    }
  }
  async function regenerate(t: Task) {
    if (!window.confirm('这会新建一次生图请求，可能产生费用。之前的服务端记录会保留，确定继续？')) return;
    const next = { ...t, prepJobId: undefined, preparedFile: undefined, prepAccepted: false, prepState: undefined };
    rememberPrep(t, next);
    await startImagePipeline(next);
  }
  async function submitToSeeThrough(t: Task, preparedImage?: File) {
    const f =
      preparedImage ??
      (t.inputKind === 'image' ? await prepared(t) : await input(t));
    const splitterInput = await padForSeeThrough(f);
    setProgress('已保留全身安全留白，提交到 See-Through…');
    const r = await serviceRequest<Job>('submit', {
      image: splitterInput,
      name: splitterInput.name,
    });
    if (!r.jobId)
      throw new Error(r.error || '服务未返回任务编号，请检查服务端后再重试。');
    update(t.id, {
      remoteJobId: r.jobId,
      remoteState: 'queued',
      remoteMessage:
        r.message || '已按全身安全画布提交，后台将自动下载 PSD。',
    });
  }
  async function startImagePipeline(t: Task) {
    const preparedImage = await selectPreparation(t.prepMode, {
      generate: () => prepare(t),
      confirmedSource: async () => {
        try {
          const source = await input(t);
          setProgress('正在进行用户确认图的构图基础检查…');
          await assertLive2dFriendlyFrame(source);
          const png = await asPreparedPng(await source.arrayBuffer());
          const filename = `${t.name}-user-confirmed.png`;
          await saveAsset(`${t.id}:prepared`, png);
          update(t.id, {
            preparedFile: filename,
            prepState: 'user-confirmed',
            prepAccepted: false,
            prepMessage: '用户明确确认使用已处理图；已跳过生图，仅做构图基础检查，非 AI 验收。',
          });
          return new File([png], filename, { type: 'image/png' });
        } catch (error) {
          update(t.id, { prepState: 'failed', prepAccepted: false, prepMessage: error instanceof Error ? error.message : '输入检查失败。' });
          throw error;
        }
      },
    });
    if (!preparedImage) {
      setToast('生图任务已交给常驻服务；可关闭网页，回来后自动恢复状态。');
      return;
    }
    await submitToSeeThrough(t, preparedImage);
    setToast('已提交 See-Through；PSD 完成后会自动下载。');
  }
  async function startProBasePipeline(t: Task) {
    update(t.id, { proStage: 'base_processing' });
    await startImagePipeline(t);
    setToast('Pro 基础状态处理已启动；可在任务详情查看服务端进度。');
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
      if (t.mode === 'pro') {
        update(t.id, {
          psdFile: filename,
          qaPassed: false,
          proStage: 'base_psd_ready',
          remoteMessage: '基础 PSD 已就绪。下一步将按 Persona Lock 生成并拆分所选状态图。',
        });
        setToast('Pro 基础 PSD 已保存；状态图生成与差分合并入口已准备。');
        return;
      }
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
  async function inspectUpstream(t: Task) {
    if (!t.remoteJobId) return;
    setProgress('读取上游事件…');
    const events = await serviceDiagnostics(t.remoteJobId);
    setUpstreamDiagnostics({ name: t.name, jobId: t.remoteJobId, events });
  }
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    let running = false;
    const poll = async () => {
      if (running || lock.current) return;
      running = true;
      try {
        for (const item of currentTasks.current) {
          if (cancelled) break;
          if (!item.prepJobId || item.preparedFile || !['queued', 'running', 'succeeded'].includes(item.prepState || '')) continue;
          try { await refreshPrep(item); }
          catch (error) {
            update(item.id, { prepMessage: error instanceof Error ? error.message : '状态暂未同步，稍后继续查询。' });
          }
        }
      } finally { running = false; }
    };
    // Do not poll on every state update: the fixed interval also bounds retries.
    const timer = window.setInterval(() => void poll(), 8000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [hydrated]);
  useEffect(() => {
    if (!task?.remoteJobId || task.psdFile || task.remoteState === 'failed')
      return;
    const timer = setInterval(() => {
      if (!lock.current) void operate(() => refresh(task));
    }, 10000);
    return () => clearInterval(timer);
  }, [task]);
  async function generate(t: Task) {
    const merged = t.proMergedFile
      ? await readAsset(`${t.id}:pro-merged-psd`)
      : undefined;
    const f = merged
      ? new File([merged], t.proMergedFile!, { type: 'image/vnd.adobe.photoshop' })
      : t.psdFile ? await psdInput(t) : await input(t);
    const { generateCubism } = await import('./cubismEngine.js');
    const result = await generateCubism(f, t.name, setProgress, {
      variantIds: t.mode === 'pro' ? t.proStateIds : undefined,
    });
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
      prepJobId: undefined,
      prepMessage: undefined,
      prepAccepted: false,
      prepMode: 'generate',
      psdFile: k === 'psd' ? f.name : undefined,
      remoteJobId: undefined,
      remoteState: undefined,
      remoteMessage: undefined,
      qaPassed: false,
      hasGenerated: false,
      cmoFile: undefined,
      runtimeFile: undefined,
      nativeRuntimeFile: undefined,
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
          <div className="topbar-actions">
            <ProductionAccess onUserChange={handleProductionUser} />
            <button className="help" onClick={() => setGuide(true)}>
              <CircleHelp size={18} />
              流程指南
            </button>
          </div>
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
              <div className="automation-status">
                <span className="live-dot" /> 自动追踪已开启
                <small>{productionUser ? '已登录工作区；任务与产物将写入项目账本。' : '当前为公开展示或本地任务；登录生产工作区后启用团队账本。'}</small>
              </div>
            </div>
            {featuredTask?.mode === 'pro' ? (
              <ProProductionLine task={featuredTask} />
            ) : (
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
            )}
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
          <fieldset className="workflow-mode">
            <button
              type="button"
              className={productionMode === 'standard' ? 'is-selected' : ''}
              onClick={() => setProductionMode('standard')}
            >
              <b>标准 Live2D</b><small>单图拆层与基础交付</small>
            </button>
            <button
              type="button"
              className={productionMode === 'pro' ? 'is-selected' : ''}
              onClick={() => setProductionMode('pro')}
            >
              <b>Live2D Pro</b><small>同角色多动作 / 表情差分</small>
            </button>
          </fieldset>
          <fieldset className="workflow-mode" aria-label="角色整理生图提供方">
            <legend>角色整理生图</legend>
            {(Object.entries(LIVE2D_PREP_PROVIDERS) as Array<[Live2dPrepProvider, typeof LIVE2D_PREP_PROVIDERS.doubao]>).map(([provider, details]) => (
              <button
                key={provider}
                type="button"
                className={prepProvider === provider ? 'is-selected' : ''}
                onClick={() => setPrepProvider(provider)}
              >
                <b>{details.label}</b>
                <small>身份保持 · 全身中立构图</small>
              </button>
            ))}
          </fieldset>
          <label className="field-label">
            <span><input type="checkbox" checked={prepMode === 'confirmed-source'}
              onChange={(e) => setPrepMode(e.target.checked ? 'confirmed-source' : 'generate')} />
              我确认这张图已处理完毕，跳过生图直接拆层</span>
            <small>默认调用上方选中的一个生图服务。勾选只代表用户确认，不代表 AI 验收；直连设置不会跳过生图。</small>
          </label>
          <button type="button" className="ghost-button" onClick={() => void operate(async () => { await connectLocalRelay(); setToast('本机常驻服务已接入，无需登录弹窗。'); })}>接入本机桥接（免登录）</button>
          {productionMode === 'pro' && (
            <section className="pro-state-picker">
              <b>选择首批状态</b>
              <small>基础 PSD 完成后，这些状态会按同一 Persona Lock 逐一生成、拆层与合并。</small>
              <div>
                {LIVE2D_PRO_STATES.map((state) => {
                  const checked = proStateIds.includes(state.id);
                  return (
                    <label key={state.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setProStateIds((current) =>
                          checked ? current.filter((id) => id !== state.id) : [...current, state.id],
                        )}
                      />
                      {state.label}<small>{state.kind === 'action' ? '动作' : '表情'}</small>
                    </label>
                  );
                })}
              </div>
            </section>
          )}
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
                const selectedStates = productionMode === 'pro' ? selectedProStates(proStateIds) : [];
                if (productionMode === 'pro' && !selectedStates.length)
                  throw new Error('Live2D Pro 至少选择一个动作或表情状态。');
                if (productionMode === 'pro') {
                  const manifest = buildLive2DProManifest(file.name, proStateIds);
                  await saveAsset(`${id}:pro-manifest`, new Blob([
                    JSON.stringify(manifest, null, 2),
                  ], { type: 'application/json' }));
                }
                // Some artist-authored PSDs already include their approved
                // action/expression differences in hidden action_* and
                // expression_* groups. They are a complete Pro source, not
                // a base PSD waiting for a second See-Through pass.
                const embeddedStateIds = productionMode === 'pro' && k === 'psd'
                  ? (() => {
                    const bufferPromise = file.arrayBuffer();
                    return bufferPromise.then((buffer) => {
                      const manifest = extractVariantManifest(buffer) as unknown as VariantManifest;
                      const available = new Set(manifest.variants.map((variant) => variant.id));
                      return proStateIds.filter((stateId) => available.has(stateId));
                    });
                  })()
                  : Promise.resolve([] as string[]);
                const embedded = await embeddedStateIds;
                const hasAllSelectedEmbeddedStates = productionMode === 'pro'
                  && selectedStates.length > 0
                  && embedded.length === selectedStates.length;
                const next: Task = {
                  id,
                  name: name.trim(),
                  referenceName: file.name,
                  inputFile: file.name,
                  inputKind: k,
                  prepProvider: k === 'image' ? prepProvider : undefined,
                  prepMode: k === 'image' ? prepMode : undefined,
                  psdFile: k === 'psd' ? file.name : undefined,
                  createdAt: new Date().toLocaleString('zh-CN'),
                  mode: productionMode,
                  proStateIds: productionMode === 'pro' ? proStateIds : undefined,
                  proEmbeddedStateIds: hasAllSelectedEmbeddedStates ? embedded : undefined,
                  proStage: productionMode === 'pro'
                    ? (k === 'image'
                      ? 'persona_lock'
                      : hasAllSelectedEmbeddedStates ? 'embedded_states_ready' : 'base_psd_ready')
                    : undefined,
                  remoteMessage: hasAllSelectedEmbeddedStates
                    ? `已从 PSD 识别 ${embedded.length} 个内嵌状态；无需重复拆分，确认基础姿势后即可生成 CMO3。`
                    : undefined,
                };
                setTasks((all) => [next, ...all]);
                setSelected(id);
                setCreate(false);
                setName('');
                setFile(null);
                setPrepMode('generate');
                if (k === 'image') {
                  if (productionMode === 'pro') await startProBasePipeline(next);
                  else await startImagePipeline(next);
                }
              })
            }
          >
            保存并建立任务
          </button>
        </Modal>
      )}
      {directSetup && (
        <Modal title="直连常驻 Relay" close={() => setDirectSetup(false)}>
          <p>
            配置一次后，GitHub Pages 会直接访问你的常驻队列，不再弹出登录窗口。
            设备密钥只保存在这台浏览器，可在 Relay 环境中随时更换。
          </p>
          <label className="field-label">
            Relay HTTPS 地址
            <input placeholder="https://your-relay.example.com" value={directRelayUrl} onChange={(event) => setDirectRelayUrl(event.target.value)} />
          </label>
          <label className="field-label">
            设备密钥
            <input type="password" autoComplete="off" value={directDeviceToken} onChange={(event) => setDirectDeviceToken(event.target.value)} />
          </label>
          <div className="modal-actions">
            <button className="primary-button" onClick={() => {
              try {
                saveDirectServiceConfig({ relayUrl: directRelayUrl, deviceToken: directDeviceToken });
                setConnection('直连配置已保存；后续提交不再需要登录窗口。');
                setDirectSetup(false);
                setToast('直连 Relay 已启用。');
              } catch (error) {
                setToast(error instanceof Error ? error.message : '直连配置无效。');
              }
            }}>保存直连设置</button>
            {hasDirectServiceConfig() && (
              <button className="ghost-button" onClick={() => {
                saveDirectServiceConfig(null);
                setDirectRelayUrl('');
                setDirectDeviceToken('');
                setConnection('直连设置已清除；将回退到私有登录服务。');
                setDirectSetup(false);
              }}>清除本机直连设置</button>
            )}
          </div>
          <small>直连只负责 See-Through 拆分队列；原图仍会调用所选生图服务，需连接私有生图服务并登录。只有新建任务时明确勾选“跳过生图”才直传。</small>
        </Modal>
      )}
      {task && !create && (
        <Modal title={task.name} close={() => setSelected('')}>
          <span className="task-state">{stage(task)}</span>
          <p>{task.remoteMessage}</p>
          <div className="detail-stack">
            {task.remoteJobId && <small>服务端任务：{task.remoteJobId}</small>}
            {task.prepMessage && <small>{task.prepMessage}</small>}
            {task.mode === 'pro' && (
              <section className="pro-task-card">
                <p className="eyebrow">LIVE2D PRO</p>
                <b>Persona Lock + 多状态差分</b>
                <small>
                  已选择：{selectedProStates(task.proStateIds ?? []).map((state) => state.label).join('、') || '尚未选择'}
                </small>
                <button
                  className="ghost-button"
                  disabled={busy}
                  onClick={() => void operate(() => download(task, 'pro-manifest', `${task.name}-live2d-pro-manifest.json`))}
                >
                  下载 Pro 状态清单与提示词约束
                </button>
                {task.proStage === 'base_psd_ready' && (
                  <small>基础 PSD 已完成。导入每个状态经 See-Through 拆分后的 PSD，随后可在此浏览器本地合层。</small>
                )}
                {task.proStage === 'embedded_states_ready' && (
                  <small>
                    已在当前 PSD 内识别到：{selectedProStates(task.proEmbeddedStateIds ?? []).map((state) => state.label).join('、')}。
                    将以未带状态前缀的图层作为中性基准，直接写入所选差分；不需要额外上传状态 PSD。
                  </small>
                )}
                {task.psdFile && task.proStage !== 'embedded_states_ready' && (
                  <section className="pro-state-imports">
                    <div>
                      <b>状态 PSD 收集</b>
                      <small>每个文件应对应同一 Persona Lock 下的一个状态，并与基础 PSD 画布一致。</small>
                    </div>
                    {selectedProStates(task.proStateIds ?? []).map((state) => {
                      const asset = task.proStateAssets?.[state.id];
                      return (
                        <label key={state.id}>
                          <span>{state.kind === 'action' ? '动作' : '表情'} · {state.label}</span>
                          <input
                            disabled={busy}
                            type="file"
                            accept=".psd"
                            onChange={(event) => {
                              const selectedFile = event.target.files?.[0];
                              if (selectedFile)
                                void operate(() => attachProStatePsd(task, state.id, selectedFile));
                              event.target.value = '';
                            }}
                          />
                          <small>{asset ? `已就绪：${asset.filename}` : '等待状态 PSD'}</small>
                        </label>
                      );
                    })}
                    <button
                      className="primary-button"
                      disabled={busy || selectedProStates(task.proStateIds ?? []).some((state) => !task.proStateAssets?.[state.id])}
                      onClick={() => void operate(() => mergeProStates(task))}
                    >
                      本地合并为多状态 PSD
                    </button>
                  </section>
                )}
                {task.proMergedFile && (
                  <>
                    <button
                      className="ghost-button"
                      disabled={busy}
                      onClick={() => void operate(() => download(task, 'pro-merged-psd', task.proMergedFile!))}
                    >
                      下载多状态合并 PSD
                    </button>
                    {task.proMergeReportFile && (
                      <button
                        className="ghost-button"
                        disabled={busy}
                        onClick={() => void operate(() => download(task, 'pro-merge-report', task.proMergeReportFile!))}
                      >
                        下载合层质检报告
                      </button>
                    )}
                  </>
                )}
              </section>
            )}
            {task.inputKind === 'image' &&
              !task.preparedFile &&
              !task.remoteJobId &&
              task.prepState === 'failed' && (
                <>
                <button className="ghost-button" disabled={busy} onClick={() => void operate(async () => { await connectLocalRelay(); setToast('本机常驻服务已接入。'); })}>接入本机桥接（免登录）</button>
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void operate(() => startImagePipeline(task))}
                >
                  {task.prepJobId ? '恢复提交（同一编号，不重复生图）' : '启动常驻生图任务'}
                </button>
                </>
              )}
            {task.prepJobId && (
              <section>
                <p>生图任务：{task.prepJobId.slice(0, 12)} · {task.prepMessage}</p>
                <button className="ghost-button" disabled={busy} onClick={() => void operate(() => refreshPrep(task))}>查询／恢复生图任务</button>
                {!task.remoteJobId && ['failed', 'uncertain', 'needs-review'].includes(task.prepState || '') && (
                  <button className="ghost-button" disabled={busy} onClick={() => void operate(() => regenerate(task))}>重新生成（新任务，可能计费）</button>
                )}
              </section>
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
                  {task.prepAccepted || task.prepState === 'user-confirmed' ? '下载拆分输入图' : '下载生成原图（未通过验收）'}
                </button>
                {preparedPreview && (
                  <figure>
                    {/* Local Blob preview has no public URL for server image optimization. */}
                    {/* oxlint-disable-next-line next/no-img-element */}
                    <img
                      className="psd-preview"
                      src={preparedPreview}
                      alt="本任务的拆分输入图"
                    />
                    <figcaption>{task.prepMessage || '拆分输入图；预处理来源尚未确认。'}{task.remoteJobId ? '已提交拆分队列。' : '尚未提交拆分队列。'}</figcaption>
                  </figure>
                )}
              </>
            )}
            {!task.psdFile &&
              task.inputKind !== 'stretch' &&
              !task.remoteJobId &&
              (task.inputKind !== 'image' || (task.preparedFile && (task.prepState === 'succeeded' || task.prepState === 'user-confirmed'))) && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void operate(() => submitToSeeThrough(task))}
                >
                  提交处理图到 See-Through
                </button>
              )}
            {task.remoteJobId && !task.psdFile && (
              <>
                <button
                  className="ghost-button"
                  disabled={busy}
                  onClick={() => void operate(() => refresh(task))}
                >
                  {task.remoteState === 'succeeded'
                    ? '下载服务端 PSD'
                    : '刷新状态 / 拉取 PSD'}
                </button>
                <button
                  className="ghost-button"
                  disabled={busy || !hasDirectServiceConfig()}
                  title={hasDirectServiceConfig() ? '查看此任务在 See-Through 上游的最近事件' : '请先点击「接入本机桥接」'}
                  onClick={() => void operate(() => inspectUpstream(task))}
                >
                  查看上游诊断
                </button>
                {!hasDirectServiceConfig() && <small>接入本机桥接后可查看上游的限流、心跳、进度与完成事件。</small>}
              </>
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
            {task.psdFile && (
              <NativeRuntimeViewer
                savedPackageName={task.nativeRuntimeFile}
                loadSavedPackage={() => readAsset(`${task.id}:native-runtime`)}
                savePackage={async (file) => {
                  await saveAsset(`${task.id}:native-runtime`, file);
                  update(task.id, { nativeRuntimeFile: file.name, cmoAccepted: false });
                  setToast('原生 Cubism 运行时包已仅在此浏览器保存，可随时回到此任务预览。');
                }}
              />
            )}
          </div>
        </Modal>
      )}
      {upstreamDiagnostics && (
        <Modal title={`上游诊断 · ${upstreamDiagnostics.name}`} close={() => setUpstreamDiagnostics(null)}>
          <p>
            服务端任务：<code>{upstreamDiagnostics.jobId}</code>
          </p>
          <p>
            这是本机 Relay 保存的最近上游事件。持续出现 <code>heartbeat</code> 但没有 <code>progress</code>、<code>complete</code> 或 <code>error</code>，通常表示上游接住了连接但没有实际产出。
          </p>
          <pre className="upstream-diagnostics">{formatUpstreamDiagnostics(upstreamDiagnostics.events)}</pre>
        </Modal>
      )}
      {guide && (
        <Modal title="流程与数据边界" close={() => setGuide(false)}>
          <ol className="guide-list">
            <li>有 PSD：直接新建任务并导入，确认图层质量后点击生成。</li>
            <li>
              仅有原图：上传后会自动进入角色整理、全身构图检查与 See-Through 队列；无需连接服务、检查服务或手动刷新。
              确认身份、服装、四肢和附件都完整后才进入拆分。
            </li>
            <li>
              Live2D Pro：先验收基础 PSD，再按同一 Persona Lock 生成所选动作和表情；每张状态图分别拆层，
              通过语义差分检查后合并为隐藏状态层。
            </li>
            <li>浏览器完成网格和规范化运行时导出，生成期间不要关闭页面。</li>
            <li>
              实验性 CMO3 仅供研究；运行时 MOC3 包用于
              SDK/播放器联调，生成文件仍需实际验收。
            </li>
          </ol>
          <p>
            未登录的公开展示仍使用浏览器临时存储。生产工作区启用后，项目、任务状态、审核记录与正式产物会迁移到私有团队账本；服务端队列会自动同步，刷新页面不需要手动检查。
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

function formatUpstreamDiagnostics(events: string) {
  const lines = events.trim().split('\n').filter(Boolean).slice(-60);
  if (!lines.length) return '暂无事件。';
  return lines.map((line) => {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const timestamp = typeof event.at === 'string' ? event.at : typeof event.timestamp === 'string' ? event.timestamp : '';
      const stage = typeof event.stage === 'string' ? event.stage : '';
      const name = typeof event.event === 'string' ? event.event : '';
      const attempt = typeof event.attempt === 'number' ? ` · 第 ${event.attempt} 次` : '';
      const detail = typeof event.error === 'string' ? event.error : typeof event.message === 'string' ? event.message : '';
      return [timestamp, stage || name, attempt, detail].filter(Boolean).join(' ');
    } catch {
      return line;
    }
  }).join('\n');
}

type ProFlowState = 'queued' | 'working' | 'done';
function proFlowState(task: Task, step: 'source' | 'persona' | 'basePsd' | 'states' | 'statePsd' | 'merge' | 'delivery'): ProFlowState {
  const stage = task.proStage;
  const embedded = stage === 'embedded_states_ready';
  const expectedStates = task.proStateIds?.length || 0;
  const collectedStates = Object.keys(task.proStateAssets || {}).filter((id) => task.proStateIds?.includes(id)).length;
  if (step === 'source') return task.inputFile ? 'done' : 'queued';
  if (embedded && ['persona', 'basePsd', 'states', 'statePsd', 'merge'].includes(step)) return 'done';
  if (step === 'persona') return task.preparedFile ? 'done' : stage === 'persona_lock' || stage === 'base_processing' ? 'working' : 'queued';
  if (step === 'basePsd') return task.psdFile ? 'done' : task.remoteJobId ? 'working' : 'queued';
  if (step === 'states') return expectedStates > 0 && collectedStates === expectedStates ? 'done' : task.psdFile ? 'working' : 'queued';
  if (step === 'statePsd') return expectedStates > 0 && collectedStates === expectedStates ? 'done' : collectedStates ? 'working' : task.psdFile ? 'working' : 'queued';
  if (step === 'merge') return stage === 'merge_ready' ? 'done' : stage === 'state_decomposition' ? 'working' : 'queued';
  return task.hasGenerated ? 'done' : stage === 'merge_ready' || embedded ? 'working' : 'queued';
}

function ProFlowNode({
  title,
  note,
  state,
  children,
}: {
  title: string;
  note: string;
  state: ProFlowState;
  children: ReactNode;
}) {
  return (
    <article className={`pro-flow-node ${state}`}>
      <div className="pro-flow-icon">{children}</div>
      <div><b>{title}</b><small>{note}</small></div>
      <span>{state === 'done' ? '已完成' : state === 'working' ? '处理中' : '等待'}</span>
    </article>
  );
}

function ProProductionLine({ task }: { task: Task }) {
  const states = selectedProStates(task.proStateIds ?? []);
  return (
    <section className="pro-production-line" aria-label="Live2D Pro 双分支生产线">
      <div className="pro-flow-heading">
        <div><p className="eyebrow">LIVE2D PRO / DUAL PATH</p><h3>基础形态与状态形态会在合层前分别质检</h3></div>
        <span><GitBranch size={15} /> {states.length} 个选定状态</span>
      </div>
      <div className="pro-flow-entry">
        <ProFlowNode title="人物角色图" note={task.referenceName} state={proFlowState(task, 'source')}><UploadCloud size={17} /></ProFlowNode>
        <ArrowRight className="pro-flow-arrow" size={19} />
        <ProFlowNode title="Persona Lock" note="身份、服装、镜头固定" state={proFlowState(task, 'persona')}><WandSparkles size={17} /></ProFlowNode>
      </div>
      <div className="pro-flow-fork">
        <div className="pro-flow-lane base-lane">
          <div className="pro-lane-label"><span>基础形态</span><small>中立全身主图</small></div>
          <ArrowRight className="pro-flow-arrow" size={19} />
          <ProFlowNode title="See-Through" note="基础图拆分 PSD" state={proFlowState(task, 'basePsd')}><Layers3 size={17} /></ProFlowNode>
        </div>
        <div className="pro-flow-lane state-lane">
          <div className="pro-lane-label"><span>状态形态</span><small>Persona Lock 差分图</small></div>
          <ArrowRight className="pro-flow-arrow" size={19} />
          <ProFlowNode title="批量状态图" note="生成或导入每个指定状态" state={proFlowState(task, 'states')}><FileImage size={17} /></ProFlowNode>
          <ArrowRight className="pro-flow-arrow" size={19} />
          <ProFlowNode title="逐张 See-Through" note="每个状态独立拆分 PSD" state={proFlowState(task, 'statePsd')}><Layers3 size={17} /></ProFlowNode>
        </div>
      </div>
      <div className="pro-state-chips" aria-label="本任务选择的状态">
        {states.map((state) => <span key={state.id}>{state.kind === 'action' ? '动作' : '表情'} · {state.label}</span>)}
      </div>
      <div className="pro-flow-exit">
        <ProFlowNode title="语义差分合层" note="写入默认隐藏的 action / expression 图层" state={proFlowState(task, 'merge')}><Combine size={17} /></ProFlowNode>
        <ArrowRight className="pro-flow-arrow" size={19} />
        <ProFlowNode title="Cubism 交付" note="CMO3 整理，MOC3 官方编译验收" state={proFlowState(task, 'delivery')}><Box size={17} /></ProFlowNode>
      </div>
    </section>
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
