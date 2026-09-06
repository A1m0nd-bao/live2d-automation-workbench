/* oxlint-disable react/react-compiler -- Browser-only storage hydration intentionally runs after SSR; effects synchronize IndexedDB and localStorage. */
import { useEffect, useRef, useState } from 'react';
import { Plus, X, FolderOpen, Settings2, CircleHelp } from 'lucide-react';
import { connectService, serviceRequest } from './serviceBridge';
import { saveAsset, readAsset, downloadBlob } from './assets';
import { isPng } from './live2dPrep';
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
const STORAGE = 'morph.production.tasks';
const stage = (t: Task) =>
  t.cmoAccepted
    ? 'CMO3 已验收'
    : t.hasGenerated
      ? 'CMO3 已生成 · 待验收'
      : t.qaPassed
        ? '待生成 CMO3'
        : t.psdFile || t.inputKind === 'stretch'
          ? '待确认输入'
          : t.inputKind === 'image' && !t.preparedFile
            ? t.prepState === 'failed'
              ? 'Image 2 预处理失败'
              : '待 Image 2 预处理'
            : t.inputKind === 'image' && !t.prepAccepted
              ? '待确认 Live2D 友好图'
              : t.remoteState === 'failed'
                ? '拆分失败'
                : t.remoteJobId
                  ? '后台拆分中'
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
  const task = tasks.find((t) => t.id === selected);
  const update = (id: string, patch: Partial<Task>) =>
    setTasks((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
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
    setProgress('Image 2 正在按 Live2D 规范重绘角色…');
    update(t.id, {
      prepState: 'queued',
      prepMessage: '正在生成 Live2D 友好图…',
    });
    try {
      const data = await serviceRequest<ArrayBuffer>('prepare', {
        image: source,
        name: source.name,
      });
      if (!isPng(data)) throw new Error('Image 2 返回的文件不是 PNG。');
      const filename = `${t.name}-live2d-friendly.png`;
      await saveAsset(
        `${t.id}:prepared`,
        new Blob([data], { type: 'image/png' }),
      );
      update(t.id, {
        preparedFile: filename,
        prepState: 'succeeded',
        prepAccepted: false,
        prepMessage:
          '已生成。请确认身份、全身、双手双脚和服装完整后再提交拆分。',
      });
      setToast('Live2D 友好图已生成，待你确认后才会提交 See-Through。');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Image 2 预处理失败。';
      update(t.id, { prepState: 'failed', prepMessage: message });
      throw error;
    }
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
      update(t.id, {
        psdFile: filename,
        qaPassed: false,
      });
      setToast('PSD 已下载并保存到当前浏览器，请确认图层质量。');
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
    setToast('CMO3 与运行时 MOC3 工程包已生成。');
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
    update(t.id, {
      inputFile: f.name,
      inputKind: k,
      preparedFile: undefined,
      prepState: undefined,
      prepMessage: undefined,
      prepAccepted: false,
      psdFile: k === 'psd' ? f.name : undefined,
      remoteJobId: undefined,
      remoteState: undefined,
      remoteMessage: undefined,
      qaPassed: false,
      hasGenerated: false,
      cmoFile: undefined,
      cmoAccepted: false,
      warnings: [],
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
              <p className="eyebrow">PRODUCTION WORKSPACE</p>
              <h1>Live2D 生产任务</h1>
              <p className="intro-copy">
                参考图 → Image 2 友好化 → See-Through → PSD 验收 → CMO3
              </p>
            </div>
            <button className="primary-button" onClick={() => setCreate(true)}>
              <Plus size={17} />
              新建任务
            </button>
          </section>
          <section className="pipeline-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">PRIVATE TASK SERVICE</p>
                <h2>Image 2 + See-Through 任务服务</h2>
              </div>
              <div className="header-actions">
                <button
                  className="ghost-button"
                  onClick={() => {
                    try {
                      connectService();
                      setConnection('请在连接窗口登录，再点击检查连接。');
                    } catch (e) {
                      setToast(String(e));
                    }
                  }}
                >
                  连接任务服务
                </button>
                <button
                  className="ghost-button"
                  disabled={busy}
                  onClick={() =>
                    void operate(async () => {
                      const [relay, prep] = await Promise.allSettled([
                        serviceRequest<{ ready?: boolean; message?: string }>(
                          'health',
                        ),
                        serviceRequest<{ ready?: boolean; message?: string }>(
                          'prepHealth',
                        ),
                      ]);
                      const relayMessage =
                        relay.status === 'fulfilled'
                          ? relay.value.ready
                            ? 'See-Through 已就绪'
                            : relay.value.message
                          : relay.reason instanceof Error
                            ? relay.reason.message
                            : 'See-Through 不可用';
                      const prepMessage =
                        prep.status === 'fulfilled'
                          ? prep.value.ready
                            ? 'Image 2 已就绪'
                            : prep.value.message
                          : prep.reason instanceof Error
                            ? prep.reason.message
                            : 'Image 2 不可用';
                      setConnection(`${relayMessage}；${prepMessage}`);
                    })
                  }
                >
                  检查连接
                </button>
              </div>
            </div>
            <p>{connection}</p>
            <small>
              Image 2 会先输出待确认的全身中立参考图；确认后才提交
              See-Through。密钥仅留在服务端。
            </small>
          </section>
          <section className="bottom-grid">
            <article className="table-card">
              <div className="section-heading compact">
                <h2>生产队列</h2>
                <span>{tasks.length} 个任务</span>
              </div>
              {tasks.length ? (
                <div className="task-table">
                  {tasks.map((t) => (
                    <button
                      className="table-row task-link"
                      key={t.id}
                      onClick={() => setSelected(t.id)}
                    >
                      <div>
                        <b>{t.name}</b>
                        <small>{t.referenceName}</small>
                      </div>
                      <span className="task-state">{stage(t)}</span>
                      <span>{t.hasGenerated ? '文件已保存' : '查看任务'}</span>
                      <time>{t.createdAt}</time>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="panel-body">
                  暂无任务。可直接导入已验收 PSD，不必重复拆分。
                </p>
              )}
            </article>
            <article className="risk-card">
              <p className="eyebrow">CUBISM COMPATIBILITY</p>
              <h2>可编辑 CMO3</h2>
                <p>
                固定兼容导出引擎，生成可编辑 CMO3 与运行时 MOC3 工程包。自动生成不等于动作质检通过，仍需在 Cubism/运行时中验收。
              </p>
              <button className="text-button" onClick={() => setGuide(true)}>
                查看流程边界 →
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
            原图保存在当前浏览器。PNG/JPG 先经 Image 2 生成待确认的 Live2D
            友好图，确认后才会提交 See-Through；PSD 与 .stretch 不经过生图步骤。
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
                setTasks((all) => [
                  {
                    id,
                    name: name.trim(),
                    referenceName: file.name,
                    inputFile: file.name,
                    inputKind: k,
                    psdFile: k === 'psd' ? file.name : undefined,
                    createdAt: new Date().toLocaleString('zh-CN'),
                  },
                  ...all,
                ]);
                setSelected(id);
                setCreate(false);
                setName('');
                setFile(null);
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
              !task.remoteJobId && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void operate(() => prepare(task))}
                >
                  {task.prepState === 'queued'
                    ? 'Image 2 处理中…'
                    : '用 Image 2 生成 Live2D 友好图'}
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
                    <figcaption>
                      请核查：身份、服装、完整全身、双手双脚、附件、无遮挡裁切和纯色背景。
                    </figcaption>
                  </figure>
                )}
                {!task.prepAccepted && (
                  <button
                    className="ghost-button"
                    disabled={busy}
                    onClick={() => update(task.id, { prepAccepted: true })}
                  >
                    确认 Live2D 友好图通过
                  </button>
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
                  onClick={() =>
                    void operate(async () => {
                      const f =
                        task.inputKind === 'image'
                          ? await prepared(task)
                          : await input(task);
                      setProgress('提交 Live2D 友好图到 See-Through…');
                      const r = await serviceRequest<Job>('submit', {
                        image: f,
                        name: f.name,
                      });
                      if (!r.jobId)
                        throw new Error(
                          r.error ||
                            '服务未返回任务编号，请检查服务端后再重试。',
                        );
                      update(task.id, {
                        remoteJobId: r.jobId,
                        remoteState: 'queued',
                        remoteMessage: r.message,
                      });
                    })
                  }
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
                刷新状态 / 拉取 PSD
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
                {task.hasGenerated ? '重新生成 CMO3' : '在浏览器生成 CMO3'}
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
                  下载 CMO3
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
                        '已在 Cubism 打开本次 CMO3，检查全身显示、眼口与身体参数动作了吗？',
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
              仅有原图：连接私有服务、登录、检查连接，先用 Image 2
              生成全身中立的 Live2D
              友好图。确认身份、服装、四肢和附件都完整后才提交拆分。
            </li>
            <li>浏览器完成网格和 CMO3 导出，生成期间不要关闭页面。</li>
            <li>
              下载 CMO3 到 Cubism 检查全身与参数动作；运行时 MOC3 包可直接用于
              SDK/播放器联调，生成文件仍需实际验收。
            </li>
          </ol>
          <p>
            文件与任务记录保存在此浏览器，清除站点数据或更换设备不会自动恢复，请及时下载备份。服务端任务持久化不等于永久资产存储。
          </p>
          <p>
            兼容路径固定 StretchyStudio
            24a83a2，使用标准自动绑定；手工原生变形器不保证无损。密钥不存入公开前端。
          </p>
          <p>
            Image 2
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
          setAction(
            manifest.variants.find((v) => v.kind === 'action' && !v.hidden)?.id || '',
          );
          setExpression(
            manifest.variants.find((v) => v.kind === 'expression' && !v.hidden)?.id || '',
          );
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
        if (!selected.has(variant.id) || !layer.visible) continue;
      } else if (!layer.visible) {
        continue;
      } else if ([...selectedSlots].some((slot) => replaces(layer.name, slot))) {
        continue;
      }
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
