/* oxlint-disable react/react-compiler -- Browser-only storage hydration intentionally runs after SSR; effects synchronize IndexedDB and localStorage. */
import { useEffect, useRef, useState } from 'react';
import { Plus, X, FolderOpen, Settings2, CircleHelp } from 'lucide-react';
import { connectService, serviceRequest } from './serviceBridge';
import { saveAsset, readAsset, downloadBlob } from './assets';
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
  qaPassed?: boolean;
  cmoFile?: string;
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
    [preview, setPreview] = useState('');
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
      await saveAsset(`${t.id}:input`, new Blob([data]));
      update(t.id, {
        psdFile: filename,
        inputFile: filename,
        inputKind: 'psd',
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
    const f = await input(t);
    const { generateCubism } = await import('./cubismEngine.js');
    const result = await generateCubism(f, t.name, setProgress);
    try {
      await saveAsset(`${t.id}:cmo`, result.cmo);
      await saveAsset(`${t.id}:bundle`, result.bundle);
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
      hasGenerated: true,
      cmoAccepted: false,
      warnings: result.report.warnings,
    });
    setToast('CMO3 已真实生成。请下载到 Cubism 检查全身显示及动作。');
  }
  async function download(t: Task, suffix: string, filename: string) {
    const blob = await readAsset(`${t.id}:${suffix}`);
    if (!blob) throw new Error('文件不在此浏览器，请重新导入或生成。');
    downloadBlob(blob, filename);
  }
  async function replace(t: Task, f: File) {
    const k = validate(f);
    await saveAsset(`${t.id}:input`, f);
    update(t.id, {
      inputFile: f.name,
      inputKind: k,
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
                参考图拆分 → PSD 验收 → 浏览器生成 CMO3 → Cubism 动作验收
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
                <h2>See-Through 任务服务</h2>
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
                      const r = await serviceRequest<{
                        ready?: boolean;
                        message?: string;
                      }>('health');
                      setConnection(
                        r.ready
                          ? '已连接私有任务服务'
                          : r.message || '服务尚未就绪',
                      );
                    })
                  }
                >
                  检查连接
                </button>
              </div>
            </div>
            <p>{connection}</p>
            <small>
              密钥仅留在服务端。推理可后台运行；查询状态时请保持登录窗口打开。
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
                固定兼容导出引擎，生成网格、标准绑定与物理配置。自动生成不等于动作质检通过；MOC3
                仍由 Cubism 编译。
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
          <p>文件保存在当前浏览器；仅点击提交参考图时上传到任务服务。</p>
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
            {!task.psdFile &&
              task.inputKind !== 'stretch' &&
              !task.remoteJobId && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() =>
                    void operate(async () => {
                      const f = await input(task);
                      setProgress('提交参考图…');
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
                  提交参考图到 See-Through
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
              下载输入文件
            </button>
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
          </div>
        </Modal>
      )}
      {guide && (
        <Modal title="流程与数据边界" close={() => setGuide(false)}>
          <ol className="guide-list">
            <li>有 PSD：直接新建任务并导入，确认图层质量后点击生成。</li>
            <li>
              仅有原图：连接私有服务、登录、检查连接，然后在任务中提交。打开任务后每
              10 秒查询一次真实状态。
            </li>
            <li>浏览器完成网格和 CMO3 导出，生成期间不要关闭页面。</li>
            <li>
              下载 CMO3 到 Cubism 检查全身与参数动作。生成文件不代表动作质检或
              MOC3 编译通过。
            </li>
          </ol>
          <p>
            文件与任务记录保存在此浏览器，清除站点数据或更换设备不会自动恢复，请及时下载备份。服务端任务持久化不等于永久资产存储。
          </p>
          <p>
            兼容路径固定 StretchyStudio
            24a83a2，使用标准自动绑定；手工原生变形器不保证无损。密钥不存入公开前端。
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
