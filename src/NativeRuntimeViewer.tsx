import { useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';

type Live2dParameter = { id: string; min: number; max: number; value: number; defaultValue: number };
type RuntimeMotion = { group: string; index: number; label: string; file: string; isAction: boolean };
type MotionEntry = { File: string; Name?: string };
type RuntimeModel = {
  destroy?: () => void;
  anchor: { set: (x: number, y?: number) => void };
  scale: { set: (value: number) => void };
  position: { set: (x: number, y: number) => void };
  motion: (group: string, index: number, priority?: number) => Promise<boolean>;
  internalModel: {
    width: number;
    height: number;
    on: (event: string, callback: () => void) => void;
    coreModel: RuntimeCoreFacade;
    settings: { motions?: Record<string, MotionEntry[]> };
  };
};
type RuntimeCore = {
  parameters: {
    ids: string[];
    minimumValues: number[];
    maximumValues: number[];
    defaultValues: number[];
    values: number[];
  };
  drawables: { vertexPositions: Float32Array[] };
  update: () => void;
};
type RuntimeCoreFacade = {
  _model: RuntimeCore;
  setParameterValueById?: (id: string, value: number) => void;
  update?: () => void;
};
type PixiApp = {
  view: HTMLCanvasElement;
  stage: { addChild: (model: RuntimeModel) => void };
  screen: { width: number; height: number };
  renderer: { on: (event: string, callback: () => void) => void };
  destroy: (removeView?: boolean, options?: unknown) => void;
};
type PixiGlobal = {
  Application: new (options: Record<string, unknown>) => PixiApp;
  live2d: {
    Live2DModel: { from: (url: string, options?: Record<string, unknown>) => Promise<RuntimeModel> };
    MotionPriority: { FORCE: number };
  };
};

declare global {
  interface Window { PIXI?: PixiGlobal }
}

const CDN = [
  'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
  'https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js',
  'https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js',
];

function loadScript(source: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[data-morph-runtime="${source}"]`) as HTMLScriptElement | null;
    if (existing?.dataset.ready === 'true') return resolve();
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`无法加载运行时：${source}`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = source;
    script.async = true;
    script.dataset.morphRuntime = source;
    script.onload = () => { script.dataset.ready = 'true'; resolve(); };
    script.onerror = () => reject(new Error(`无法加载运行时：${source}`));
    document.head.appendChild(script);
  });
}

async function loadRuntime() {
  for (const script of CDN) await loadScript(script);
  if (!window.PIXI?.live2d?.Live2DModel) throw new Error('官方 Cubism Web Runtime 未能初始化。');
  return window.PIXI;
}

const nativeBase = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/native-runtime/`;

function mimeType(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.moc3')) return 'application/octet-stream';
  return 'application/octet-stream';
}

function serviceWorkerMessage(worker: ServiceWorker, message: unknown) {
  return new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => reject(new Error('本机 Runtime 缓存等待超时。')), 15000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      event.data?.ok ? resolve() : reject(new Error(event.data?.error || '本机 Runtime 缓存失败。'));
    };
    worker.postMessage(message, [channel.port2]);
  });
}

async function runtimeWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('当前浏览器不支持本机 Runtime 缓存。');
  const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}morph-native-runtime-sw.js`, {
    scope: import.meta.env.BASE_URL,
  });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 4000);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
  if (!navigator.serviceWorker.controller) {
    throw new Error('本机预览模块已安装；请刷新此工作台一次后重新导入 ZIP。');
  }
  return registration.active || navigator.serviceWorker.controller;
}

async function modelUrlFromZip(file: Blob) {
  const zip = await JSZip.loadAsync(file);
  const entry = Object.values(zip.files).find((item) => !item.dir && item.name.toLowerCase().endsWith('.model3.json'));
  if (!entry) throw new Error('压缩包中未找到 model3.json。请导入 Cubism 原生运行时包。');
  const packageId = crypto.randomUUID();
  const root = new URL(`${nativeBase}${packageId}/`, window.location.origin).href;
  const files = await Promise.all(Object.values(zip.files).filter((item) => !item.dir).map(async (item) => ({
    url: new URL(item.name, root).href,
    bytes: await item.async('arraybuffer'),
    type: mimeType(item.name),
  })));
  const worker = await runtimeWorker();
  await serviceWorkerMessage(worker, { type: 'cache-runtime-package', files });
  return { modelUrl: new URL(entry.name, root).href, urls: files.map((item) => item.url), worker };
}

function parameterSnapshot(core: RuntimeCore): Live2dParameter[] {
  return core.parameters.ids.map((id, index) => ({
    id,
    min: core.parameters.minimumValues[index],
    max: core.parameters.maximumValues[index],
    defaultValue: core.parameters.defaultValues[index],
    value: core.parameters.defaultValues[index],
  }));
}

function writeParameter(coreModel: RuntimeCoreFacade, id: string, value: number) {
  if (coreModel.setParameterValueById) {
    coreModel.setParameterValueById(id, value);
    return;
  }
  const core = coreModel._model;
  const index = core.parameters.ids.indexOf(id);
  if (index >= 0) core.parameters.values[index] = value;
}

type NativeRuntimeViewerProps = {
  /** The runtime archive is kept in the same local IndexedDB store as the PSD. */
  savedPackageName?: string;
  loadSavedPackage: () => Promise<Blob | undefined>;
  savePackage: (file: File) => Promise<void>;
};

export function NativeRuntimeViewer({ savedPackageName, loadSavedPackage, savePackage }: NativeRuntimeViewerProps) {
  const stage = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ app: PixiApp; model: RuntimeModel; urls: string[]; worker: ServiceWorker } | null>(null);
  const values = useRef(new Map<string, number>());
  const skipNextRestore = useRef(false);
  const [status, setStatus] = useState('导入 Cubism 原生运行时包以开始预览。');
  const [parameters, setParameters] = useState<Live2dParameter[]>([]);
  const [motions, setMotions] = useState<RuntimeMotion[]>([]);
  const [measurement, setMeasurement] = useState('');

  const dispose = () => {
    const current = runtime.current;
    if (!current) return;
    current.model.destroy?.();
    current.app.destroy(true, { children: true, texture: false, baseTexture: false });
    current.worker.postMessage({ type: 'clear-runtime-package', urls: current.urls });
    runtime.current = null;
    values.current.clear();
  };

  useEffect(() => () => dispose(), []);

  const importPackage = async (file: Blob, restored = false) => {
    dispose();
    if (stage.current) stage.current.replaceChildren();
    setParameters([]);
    setMotions([]);
    setMeasurement('');
    setStatus('正在读取原生包并初始化官方 Cubism Runtime…');
    try {
      const [{ modelUrl, urls, worker }, PIXI] = await Promise.all([modelUrlFromZip(file), loadRuntime()]);
      if (!stage.current) throw new Error('预览区域已关闭。');
      const app = new PIXI.Application({
        resizeTo: stage.current,
        backgroundAlpha: 0,
        preserveDrawingBuffer: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });
      stage.current.appendChild(app.view);
      const model = await PIXI.live2d.Live2DModel.from(modelUrl, { autoInteract: false });
      app.stage.addChild(model);
      const fit = () => {
        const scale = Math.min(app.screen.width / model.internalModel.width, app.screen.height / model.internalModel.height) * 0.88;
        model.anchor.set(0.5, 0.5);
        model.scale.set(scale);
        model.position.set(app.screen.width / 2, app.screen.height / 2);
      };
      fit();
      app.renderer.on('resize', fit);
      const coreModel = model.internalModel.coreModel;
      const core = coreModel._model;
      const snapshot = parameterSnapshot(core);
      const motionList = Object.entries(model.internalModel.settings.motions ?? {}).flatMap(([group, entries]) =>
        entries.map((entry, index) => ({
          group,
          index,
          file: entry.File,
          label: entry.Name || entry.File.split('/').pop()?.replace('.motion3.json', '') || `${group} ${index + 1}`,
          isAction: group === 'Action',
        })),
      );
      model.internalModel.on('beforeModelUpdate', () => {
        for (const [id, value] of values.current) writeParameter(coreModel, id, value);
      });
      runtime.current = { app, model, urls, worker };
      setParameters(snapshot);
      setMotions(motionList);
      setStatus(`${restored ? '已恢复本机保存的' : '官方'} Runtime 已加载 · ${core.drawables.vertexPositions.length} 个网格 · ${snapshot.length} 个参数 · ${motionList.length} 段动作。`);
    } catch (error) {
      dispose();
      setStatus(error instanceof Error ? `预览失败：${error.message}` : '预览失败。');
    }
  };

  useEffect(() => {
    if (!savedPackageName) return;
    // A newly chosen file is already being imported below.  Updating the task
    // metadata must not begin a second concurrent Runtime load from IndexedDB.
    if (skipNextRestore.current) {
      skipNextRestore.current = false;
      return;
    }
    let cancelled = false;
    void loadSavedPackage().then((file) => {
      if (file && !cancelled) void importPackage(file, true);
    }).catch(() => {
      if (!cancelled) setStatus('已记录原生运行时包，但本机文件缓存不可用；请重新导入 ZIP。');
    });
    return () => { cancelled = true; };
  }, [savedPackageName]);

  const setParameter = (id: string, value: number) => {
    values.current.set(id, value);
    setParameters((current) => current.map((item) => item.id === id ? { ...item, value } : item));
  };

  const reset = () => {
    const current = runtime.current;
    if (!current) return;
    const snapshot = parameterSnapshot(current.model.internalModel.coreModel._model);
    values.current.clear();
    setParameters(snapshot);
    setMeasurement('已恢复到 Cubism 导出的默认参数值。');
  };

  const playMotion = async (motion: RuntimeMotion) => {
    const current = runtime.current;
    if (!current || !window.PIXI) return;
    const core = current.model.internalModel.coreModel._model;
    // A hand-adjusted slider must not pin a motion's parameter at its old
    // value. This mirrors the official sample player: start the action from
    // the neutral parameter state, then sample real runtime geometry.
    values.current.clear();
    setParameters(parameterSnapshot(core));
    setMeasurement('正在播放并测量实际网格变化…');
    const before = core.drawables.vertexPositions.map((points) => Float32Array.from(points));
    const started = await current.model.motion(motion.group, motion.index, window.PIXI.live2d.MotionPriority.FORCE);
    if (!started) {
      setMeasurement(`动作未能启动：${motion.group}[${motion.index}]。`);
      return;
    }
    setStatus(`正在播放：${motion.label}`);
    const began = performance.now();
    let maxDelta = 0;
    const measure = () => {
      core.drawables.vertexPositions.forEach((points, drawable) => {
        points.forEach((value, vertex) => {
          maxDelta = Math.max(maxDelta, Math.abs(value - before[drawable][vertex]));
        });
      });
      if (performance.now() - began < 3500) {
        requestAnimationFrame(measure);
        return;
      }
      setMeasurement(maxDelta > 0.00001
        ? `动作兼容通过：${motion.label} 在官方 Runtime 中产生最大顶点位移 ${maxDelta.toFixed(5)}。`
        : `动作文件可以启动，但 ${motion.label} 在 3.5 秒内没有产生网格变化；不能作为有效动作交付。`);
    };
    requestAnimationFrame(measure);
  };

  const auditWave = () => {
    const current = runtime.current;
    if (!current) return;
    const coreModel = current.model.internalModel.coreModel;
    const core = coreModel._model;
    const wave = parameterSnapshot(core).find((item) => item.id === 'ParamActionWave');
    if (!wave) return setMeasurement('运行时包没有 ParamActionWave，不能验收挥手。');
    const vertices = () => core.drawables.vertexPositions.flatMap((points) => Array.from(points));
    writeParameter(coreModel, wave.id, wave.defaultValue);
    if (coreModel.update) coreModel.update(); else core.update();
    const before = vertices();
    writeParameter(coreModel, wave.id, wave.max);
    if (coreModel.update) coreModel.update(); else core.update();
    const after = vertices();
    const delta = before.reduce((max, point, index) => Math.max(max, Math.abs(point - after[index])), 0);
    setParameter(wave.id, wave.max);
    setMeasurement(delta > 0.00001
      ? `挥手验收通过：ParamActionWave 0 → ${wave.max} 产生最大顶点位移 ${delta.toFixed(5)}。`
      : '挥手参数存在，但 0→1 没有产生网格变化；这份导出不应验收为动作可用。');
  };

  const priority = parameters.filter((item) => /ActionWave|Rotation_(left|right)(Elbow|Knee)|Leg[LR]Bend/.test(item.id));
  const remaining = parameters.filter((item) => !priority.includes(item));
  const actionMotions = motions.filter((motion) => motion.isAction);
  const otherMotions = motions.filter((motion) => !motion.isAction);
  const control = (item: Live2dParameter) => (
    <label key={item.id} className="runtime-parameter">
      <span>{item.id}<b>{item.value.toFixed(2)}</b></span>
      <input type="range" min={item.min} max={item.max} step={(item.max - item.min) / 100 || 0.01}
        value={item.value} onChange={(event) => setParameter(item.id, Number(event.target.value))} />
    </label>
  );

  return (
    <section className="native-runtime-viewer">
      <div className="variant-preview-heading">
        <div><p className="eyebrow">OFFICIAL CUBISM RUNTIME</p><h3>原生 MOC3 交互验收</h3><small>本机导入、官方 Web Runtime 加载；文件不会上传。{savedPackageName ? ` 当前包：${savedPackageName}` : ''}</small></div>
        <label className="ghost-button runtime-import">导入原生运行时 ZIP<input type="file" accept=".zip,application/zip" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void (async () => {
            skipNextRestore.current = true;
            await savePackage(file);
            await importPackage(file);
          })();
          event.target.value = '';
        }} /></label>
      </div>
      <div className="runtime-preview-grid">
        <div className="runtime-stage" ref={stage}><span>等待导入 MOC3 运行时包</span></div>
        <div className="runtime-controls">
          <p>{status}</p>
          <div className="modal-actions"><button className="ghost-button" disabled={!runtime.current} onClick={reset}>参数复位</button><button className="primary-button" disabled={!runtime.current} onClick={auditWave}>验收挥手网格变化</button></div>
          {measurement && <small>{measurement}</small>}
          <div className="runtime-motion-panel">
            <b>动作播放兼容性</b>
            {actionMotions.length > 0 && <div className="runtime-motion-list">{actionMotions.map((motion) => <button key={`${motion.group}-${motion.index}`} className="runtime-motion runtime-motion--action" onClick={() => void playMotion(motion)}>★ {motion.label}<small>{motion.file}</small></button>)}</div>}
            {otherMotions.length > 0 && <details><summary>其他 {otherMotions.length} 段原生动作</summary><div className="runtime-motion-list">{otherMotions.map((motion) => <button key={`${motion.group}-${motion.index}`} className="runtime-motion" onClick={() => void playMotion(motion)}>{motion.label}<small>{motion.group} · {motion.file}</small></button>)}</div></details>}
            {motions.length === 0 && <small>该 ZIP 尚未注册任何 .motion3.json。先由动作生成器写入并注册到 model3.json，再重新导入这个原生包。</small>}
          </div>
          {priority.length > 0 && <div className="runtime-parameter-list">{priority.map(control)}</div>}
          {remaining.length > 0 && <details><summary>其他 {remaining.length} 个运行时参数</summary><div className="runtime-parameter-list">{remaining.map(control)}</div></details>}
        </div>
      </div>
    </section>
  );
}
