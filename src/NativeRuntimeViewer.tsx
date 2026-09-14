import { useEffect, useEffectEvent, useRef, useState } from 'react';
import JSZip from 'jszip';
import { prepareMotionWorkflow, readRuntimePackage, runtimeDataFiles } from './runtimeMotionWorkflow.mjs';
import { installAnaGrounding } from './anaGrounding.mjs';
import { APPROVED_ANA_MOC } from './runtimeMotionWorkflow.mjs';
import { installAnaTalkingMouth } from './anaTalkingMouth.mjs';
import { sampleMouthTrack, advanceOpening } from './anaVoiceMouthTrack.mjs';
// oxlint-disable-next-line import/default
import groundingSource from './anaGrounding.mjs?raw';
// Vite's ?raw loader supplies default string exports (not JS module exports).
// oxlint-disable-next-line import/default
import workflowSource from './runtimeMotionWorkflow.mjs?raw';
// oxlint-disable-next-line import/default
import viewerSource from './NativeRuntimeViewer.tsx?raw';

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
    motionManager: { on: (event: string, callback: () => void) => void };
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
  drawables: { vertexPositions: Float32Array[]; opacities: Float32Array };
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
const BASELINE_LABEL = 'Ana 小幅动作规范 v1';

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
      if (event.data?.ok) resolve(); else reject(new Error(event.data?.error || '本机 Runtime 缓存失败。'));
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

async function modelUrlFromZip(file: Blob, trialParameters?: Live2dParameter[]) {
  const pkg = await prepareMotionWorkflow(file, { trialParameters });
  const zip: JSZip = pkg.zip;
  const packageId = crypto.randomUUID();
  const root = new URL(`${nativeBase}${packageId}/`, window.location.origin).href;
  const files = await Promise.all(Object.values(zip.files).filter((item) => !item.dir).map(async (item) => ({
    url: new URL(item.name.split('/').map(encodeURIComponent).join('/'), root).href,
    bytes: await item.async('arraybuffer'),
    type: mimeType(item.name),
  })));
  const worker = await runtimeWorker();
  await serviceWorkerMessage(worker, { type: 'cache-runtime-package', files });
  const dataFiles = await runtimeDataFiles(pkg);
  dataFiles.push({ name: 'code/runtimeMotionWorkflow.mjs', content: workflowSource }, { name: 'code/NativeRuntimeViewer.tsx', content: viewerSource });
  dataFiles.push({ name: 'code/anaGrounding.mjs', content: groundingSource });
  return { modelUrl: new URL(pkg.modelPath.split('/').map(encodeURIComponent).join('/'), root).href, urls: files.map((item) => item.url), worker, pkg, dataFiles };
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
  savePreparedPackage?: (file: Blob) => Promise<void>;
};

export function NativeRuntimeViewer({ savedPackageName, loadSavedPackage, savePackage, savePreparedPackage }: NativeRuntimeViewerProps) {
  const view = useRef({ zoom: 1, x: 0, y: 0 });
  const refit = useRef<(() => void) | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [speechText, setSpeechText] = useState('你好，我是 Ana，很高兴见到你。');
  const [speechStatus, setSpeechStatus] = useState('未播放');
  const talkingMouth = useRef<ReturnType<typeof installAnaTalkingMouth> extends Promise<infer T> ? T | null : never>(null);
  const mouthState = useRef({ enabled: true, opening: 0, form: 0 });
  const demoTrack = useRef(false);
  const [mouthAvailable, setMouthAvailable] = useState(false);
  const [newMouth, setNewMouth] = useState(true);
  const speaking = useRef(false);
  const speechJob = useRef<SpeechSynthesisUtterance | null>(null);
  const sound = useRef<{ audio: HTMLAudioElement; context: AudioContext; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer>; url: string } | null>(null);
  const stopSpeech = () => {
    speaking.current = false;
    demoTrack.current = false;
    mouthState.current.opening = 0;
    const core = runtime.current?.model.internalModel.coreModel;
    if (core) {
      const mouth = parameterSnapshot(core._model).find(p => p.id === 'ParamMouthOpenY');
      if (mouth) writeParameter(core, mouth.id, values.current.get(mouth.id) ?? mouth.defaultValue);
    }
    if (speechJob.current) { speechJob.current.onend = null; speechJob.current.onerror = null; window.speechSynthesis?.cancel(); speechJob.current = null; }
    const s = sound.current; sound.current = null;
    if (s) { s.audio.onended = null; s.audio.onerror = null; s.audio.pause(); s.audio.src = ''; void s.context.close(); URL.revokeObjectURL(s.url); }
    setSpeechStatus('已停止，口型交还动作／手动参数');
  };
  const changeZoom = (z: number) => { view.current.zoom = Math.max(0.25, Math.min(4, z)); setZoom(view.current.zoom); refit.current?.(); };
  const resetView = () => { view.current.x = view.current.y = 0; changeZoom(1); };
  const speakText = () => {
    stopSpeech();
    if (!window.speechSynthesis) { setSpeechStatus('浏览器不支持朗读，请导入音频'); return; }
    const voices = window.speechSynthesis.getVoices().filter(v => v.localService);
    const voice = voices.find(v => v.lang.startsWith('zh')) || voices[0];
    if (!voice) { setSpeechStatus('暂无本机语音，请稍后重试或导入音频'); return; }
    const utterance = new SpeechSynthesisUtterance(speechText); utterance.voice = voice; utterance.lang = voice.lang;
    speechJob.current = utterance;
    utterance.onstart = () => { speaking.current = true; setSpeechStatus('正在朗读（近似口型）'); };
    utterance.onend = () => { stopSpeech(); setSpeechStatus('朗读结束'); };
    utterance.onerror = () => { stopSpeech(); setSpeechStatus('朗读失败，请导入音频'); };
    setSpeechStatus('正在启动本机朗读…');
    window.speechSynthesis.speak(utterance);
  };
  const playAudio = async (file: File, useDemoTrack = false) => {
    stopSpeech();
    demoTrack.current = useDemoTrack;
    let owned: HTMLAudioElement | undefined;
    try {
      const context = new AudioContext(); const audio = new Audio(); const url = URL.createObjectURL(file);
      owned = audio;
      const analyser = context.createAnalyser(); analyser.fftSize = 1024;
      sound.current = { audio, context, analyser, samples: new Float32Array(analyser.fftSize), url };
      audio.src = url; const source = context.createMediaElementSource(audio); source.connect(analyser); analyser.connect(context.destination);
      audio.onended = () => stopSpeech(); audio.onerror = () => { stopSpeech(); setSpeechStatus('音频解码失败，请换用 MP3/WAV'); };
      await context.resume();
      if (sound.current?.audio !== audio) return;
      await audio.play();
      if (sound.current?.audio === audio) setSpeechStatus(`音频播放：${file.name}`);
    } catch(error) { if (sound.current?.audio === owned) { stopSpeech(); setSpeechStatus(`音频播放失败：${String(error)}`); } }
  };
  const stage = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ app: PixiApp; model: RuntimeModel; urls: string[]; worker: ServiceWorker } | null>(null);
  const values = useRef(new Map<string, number>());
  const skipNextRestore = useRef(false);
  const generation = useRef(0);
  const playing = useRef<RuntimeMotion | null>(null);
  const repeating = useRef(true);
  const pose = useRef({ from: 0, current: 0, target: 0, began: -Infinity, active: false });
  const originalPackage = useRef<Blob | null>(null);
  const derivedPackage = useRef<Blob | null>(null);
  const frame = useRef(0);
  const grounding = useRef<ReturnType<typeof installAnaGrounding>>(null);
  const [groundEnabled, setGroundEnabled] = useState(false);
  const [groundAvailable, setGroundAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [baselineApplied, setBaselineApplied] = useState(false);
  const [workflowStatus, setWorkflowStatus] = useState('');
  const [repeat, setRepeat] = useState(true);
  const [dataFiles, setDataFiles] = useState<Array<{ name: string; content: string }>>([]);
  const [dataIndex, setDataIndex] = useState(0);
  const [dataOpen, setDataOpen] = useState(false);
  const [liveValues, setLiveValues] = useState<number[]>([]);
  const [status, setStatus] = useState('导入 Cubism 原生运行时包以开始预览。');
  const [parameters, setParameters] = useState<Live2dParameter[]>([]);
  const [motions, setMotions] = useState<RuntimeMotion[]>([]);
  const [measurement, setMeasurement] = useState('');

  const dispose = () => {
    stopSpeech(); refit.current = null;
    talkingMouth.current?.dispose(); talkingMouth.current = null; setMouthAvailable(false);
    generation.current++;
    cancelAnimationFrame(frame.current);
    playing.current = null;
    grounding.current?.dispose(); grounding.current = null;
    const current = runtime.current;
    if (!current) return;
    current.app.destroy(true, { children: true, texture: false, baseTexture: false });
    current.worker.postMessage({ type: 'clear-runtime-package', urls: current.urls });
    runtime.current = null;
    values.current.clear();
  };

  useEffect(() => () => dispose(), []);
  useEffect(() => {
    const element = stage.current;
    const wheel = (event: WheelEvent) => { event.preventDefault(); changeZoom(view.current.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)); };
    element?.addEventListener('wheel', wheel, { passive: false });
    window.speechSynthesis?.getVoices();
    return () => element?.removeEventListener('wheel', wheel);
  }, []);

  const importPackage = async (file: Blob, restored = false, trialParameters?: Live2dParameter[]) => {
    dispose();
    const version = generation.current;
    setBusy(true);
    pose.current = { from: 0, current: 0, target: 0, began: -Infinity, active: false };
    originalPackage.current = file;
    derivedPackage.current = null;
    setDataFiles([]); setDataIndex(0); setBaselineApplied(false); setLiveValues([]);
    setGroundAvailable(false); setGroundEnabled(false);
    if (stage.current) stage.current.replaceChildren();
    setParameters([]);
    setMotions([]);
    setMeasurement('');
    setStatus('正在读取原生包并初始化官方 Cubism Runtime…');
    let pending: Awaited<ReturnType<typeof modelUrlFromZip>> | undefined;
    let pendingApp: PixiApp | undefined;
    try {
      // Own each resource before the next await, so a failed SDK load cannot leak cached packages.
      pending = await modelUrlFromZip(file, trialParameters);
      const { modelUrl, urls, worker, pkg, dataFiles: files } = pending;
      const PIXI = await loadRuntime();
      if (version !== generation.current) throw new Error('已取消旧的预览载入');
      if (!stage.current) throw new Error('预览区域已关闭。');
      const app = new PIXI.Application({
        resizeTo: stage.current,
        backgroundAlpha: 0,
        preserveDrawingBuffer: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });
      pendingApp = app;
      stage.current.appendChild(app.view);
      const model = await PIXI.live2d.Live2DModel.from(modelUrl, { autoInteract: false });
      if (version !== generation.current) { model.destroy?.(); throw new Error('已取消旧的预览载入'); }
      app.stage.addChild(model);
      const fit = () => {
        const scale = Math.min(app.screen.width / model.internalModel.width, app.screen.height / model.internalModel.height) * 0.88 * view.current.zoom;
        model.anchor.set(0.5, 0.5);
        model.scale.set(scale);
        model.position.set(app.screen.width / 2 + view.current.x, app.screen.height / 2 + view.current.y);
      };
      refit.current = fit;
      fit();
      app.renderer.on('resize', fit);
      const coreModel = model.internalModel.coreModel;
      const core = coreModel._model;
      grounding.current = installAnaGrounding(model.internalModel, pkg.mocHash);
      grounding.current?.setEnabled(false);
      setGroundAvailable(Boolean(grounding.current));
      const snapshot = parameterSnapshot(core);
      if (pkg.mocHash === APPROVED_ANA_MOC) {
        const mouth = await installAnaTalkingMouth({ model, assetBase: `${import.meta.env.BASE_URL}preview-assets/`, getState: () => mouthState.current });
        if (version !== generation.current) { mouth.dispose(); throw new Error('已取消旧的预览载入'); }
        talkingMouth.current = mouth;
        setMouthAvailable(true);
      }
      const motionList = Object.entries(model.internalModel.settings.motions ?? {}).flatMap(([group, entries]) =>
        entries.map((entry, index) => ({
          group,
          index,
          file: entry.File,
          label: entry.Name || entry.File.split('/').pop()?.replace('.motion3.json', '') || `${group} ${index + 1}`,
          isAction: group === 'Action' || group === 'MorphBaseline',
        })),
      );
      let lastRead = 0;
      let mouthTime = performance.now();
      model.internalModel.on('beforeModelUpdate', () => {
        for (const [id, value] of values.current) writeParameter(coreModel, id, value);
        const now = performance.now(), dt = Math.min(.1, (now - mouthTime) / 1000); mouthTime = now;
        const previousOpening = mouthState.current.opening;
        mouthState.current.opening = values.current.get('ParamMouthOpenY') ?? core.parameters.values[core.parameters.ids.indexOf('ParamMouthOpenY')] ?? 0;
        mouthState.current.form = values.current.get('ParamMouthForm') ?? core.parameters.values[core.parameters.ids.indexOf('ParamMouthForm')] ?? 0;
        if (speaking.current || sound.current) {
          let amount = Math.abs(Math.sin(performance.now() / 95)) * (0.35 + 0.65 * Math.abs(Math.sin(performance.now() / 233)));
          const s = sound.current;
          if (s) { s.analyser.getFloatTimeDomainData(s.samples); const rms = Math.sqrt(s.samples.reduce((sum, n) => sum + n * n, 0) / s.samples.length); const hint = demoTrack.current ? sampleMouthTrack(s.audio.currentTime) : null; amount = advanceOpening(previousOpening, rms, dt, hint?.closed ?? false); if (hint) mouthState.current.form = hint.form; }
          mouthState.current.opening = amount;
          const i = core.parameters.ids.indexOf('ParamMouthOpenY');
          if (i >= 0) writeParameter(coreModel, 'ParamMouthOpenY', core.parameters.minimumValues[i] + amount * (core.parameters.maximumValues[i] - core.parameters.minimumValues[i]));
        }
        const state = pose.current;
        if (state.active) {
          const t = Math.min(1, Math.max(0, (performance.now() - state.began) / 500));
          state.current = state.from + (state.target - state.from) * t * t * (3 - 2 * t);
          writeParameter(coreModel, 'ParamActionWave', state.current);
        }
        if (performance.now() - lastRead > 200 && version === generation.current) {
          lastRead = performance.now(); setLiveValues(Array.from(core.parameters.values));
        }
      });
      model.internalModel.motionManager.on('motionFinish', () => {
        const last = playing.current;
        if (last && repeating.current && version === generation.current) {
          window.setTimeout(() => {
            if (version === generation.current && last === playing.current && repeating.current) {
              void model.motion(last.group, last.index, PIXI.live2d.MotionPriority.FORCE);
            }
          }, 50);
        }
      });
      runtime.current = { app, model, urls, worker };
      pending = undefined; pendingApp = undefined;
      derivedPackage.current = pkg.derived as Blob;
      setDataFiles(files); setBaselineApplied(pkg.baselineApplied);
      setWorkflowStatus(pkg.report.note);
      setParameters(snapshot);
      setMotions(motionList);
      setStatus(`${restored ? '已恢复本机保存的' : '官方'} Runtime 已加载 · ${core.drawables.vertexPositions.length} 个网格 · ${snapshot.length} 个参数 · ${motionList.length} 段动作。`);
      if (pkg.baselineApplied && savePreparedPackage) {
        try { await savePreparedPackage(pkg.derived as Blob); }
        catch { if (version === generation.current) setWorkflowStatus(`${pkg.report.note} 本机派生包保存失败，请先下载运行包留存。`); }
        if (version !== generation.current) return;
      }
      const start = motionList.find(m => m.group === 'MorphBaseline' && m.index === 5);
      if (start) {
        playing.current = start;
        const ok = await model.motion(start.group, start.index, PIXI.live2d.MotionPriority.FORCE);
        if (version === generation.current) setStatus(ok ? `已自动接入 ${BASELINE_LABEL} · 正在播放：${start.label}` : '动作已接入，但默认播放未启动，请手动选择动作。');
      }
    } catch (error) {
      pendingApp?.destroy(true, { children: true, texture: false, baseTexture: false });
      pending?.worker.postMessage({ type: 'clear-runtime-package', urls: pending.urls });
      if (version === generation.current) {
        setStatus(error instanceof Error ? `预览失败：${error.message}` : '预览失败。');
      }
    } finally {
      if (version === generation.current) setBusy(false);
    }
  };

  const restoreSaved = useEffectEvent(async (isCancelled: () => boolean) => {
    try {
      const file = await loadSavedPackage();
      if (file && !isCancelled()) await importPackage(file, true);
    } catch {
      if (!isCancelled()) setStatus('已记录原生运行时包，但本机文件缓存不可用；请重新导入 ZIP。');
    }
  });

  useEffect(() => {
    if (!savedPackageName) return;
    // A newly chosen file is already being imported below.  Updating the task
    // metadata must not begin a second concurrent Runtime load from IndexedDB.
    if (skipNextRestore.current) {
      skipNextRestore.current = false;
      return;
    }
    let cancelled = false;
    void restoreSaved(() => cancelled);
    return () => { cancelled = true; };
  }, [savedPackageName]);

  const setParameter = (id: string, value: number) => {
    if (id === 'ParamActionWave') pose.current.active = false;
    values.current.set(id, value);
    setParameters((current) => current.map((item) => item.id === id ? { ...item, value } : item));
  };

  const reset = () => {
    const current = runtime.current;
    if (!current) return;
    const snapshot = parameterSnapshot(current.model.internalModel.coreModel._model);
    values.current.clear();
    pose.current.active = false;
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
    setMeasurement('播放检测不等于成品验收；请检查鞋子跟随、挥手换图及组合动作。');
    playing.current = motion;
    const version = generation.current;
    const before = core.drawables.vertexPositions.map((points) => Float32Array.from(points));
    const started = await current.model.motion(motion.group, motion.index, window.PIXI.live2d.MotionPriority.FORCE);
    if (!started) {
      setMeasurement(`动作未能启动：${motion.group}[${motion.index}]。`);
      return;
    }
    setStatus(`正在播放：${motion.label}`);
    // Executed only by the asynchronous play button handler, never during render.
    // oxlint-disable-next-line react/react-compiler
    const began = performance.now();
    let maxDelta = 0;
    const measure = () => {
      if (version !== generation.current || playing.current !== motion) return;
      core.drawables.vertexPositions.forEach((points, drawable) => {
        points.forEach((value, vertex) => {
          maxDelta = Math.max(maxDelta, Math.abs(value - before[drawable][vertex]));
        });
      });
      if (performance.now() - began < 3500) {
        frame.current = requestAnimationFrame(measure);
        return;
      }
      setMeasurement(maxDelta > 0.00001
        ? `播放已启动，观察到最大顶点位移 ${maxDelta.toFixed(5)}（包含自然摆动/物理，不代表该动作已通过验收）。`
        : `动作文件可以启动，但 ${motion.label} 在 3.5 秒内没有产生网格变化；不能作为有效动作交付。`);
    };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
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
    const beforeOpacity = Array.from(core.drawables.opacities);
    writeParameter(coreModel, wave.id, wave.max);
    if (coreModel.update) coreModel.update(); else core.update();
    const after = vertices();
    const delta = before.reduce((max, point, index) => Math.max(max, Math.abs(point - after[index])), 0);
    const opacityDelta = beforeOpacity.reduce((max, value, index) => Math.max(max, Math.abs(value - core.drawables.opacities[index])), 0);
    pose.current.active = false;
    setParameter(wave.id, wave.max);
    setMeasurement(delta > 0.00001 || opacityDelta > 0.00001
      ? `Wave 响应检测：顶点差 ${delta.toFixed(5)}，图层透明度差 ${opacityDelta.toFixed(3)}。换图主要可能体现在透明度；最终效果仍需目视验收。`
      : 'Wave 参数存在，但没有检测到顶点或图层透明度响应。请检查工程关键形与参数精度；不会自动修改 MOC。');
  };

  const selectPose = (target: number) => {
    values.current.delete('ParamActionWave');
    const p = runtime.current?.model.internalModel.coreModel._model.parameters;
    const current = p ? p.values[p.ids.indexOf('ParamActionWave')] : pose.current.current;
    pose.current = { from: current, current, target, began: performance.now(), active: true };
  };
  const download = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const downloadData = async () => {
    const zip = new JSZip();
    for (const file of dataFiles) zip.file(file.name, file.content);
    download(await zip.generateAsync({ type: 'blob' }), 'morph-motion-data-and-code.zip');
  };

  const priority = parameters.filter((item) => /ActionWave|Rotation_(left|right)(Elbow|Knee)|Leg[LR]Bend/.test(item.id));
  const mouthParameters = parameters.filter(item => /mouth|lip/i.test(item.id));
  const remaining = parameters.filter((item) => !priority.includes(item) && !mouthParameters.includes(item));
  const hasBaselineGroup = motions.some(motion => motion.group === 'MorphBaseline');
  const actionMotions = motions.filter((motion) => hasBaselineGroup ? motion.group === 'MorphBaseline' : motion.isAction);
  const otherMotions = motions.filter((motion) => !actionMotions.includes(motion));
  const control = (item: Live2dParameter) => (
    <label key={item.id} className="runtime-parameter">
      <span>{item.id}<b>{item.value.toFixed(2)}</b></span>
      <input aria-label={item.id} type="range" min={/Rotation_(left|right)Leg$/.test(item.id) ? Math.max(-2, item.min) : item.min} max={/Rotation_(left|right)Leg$/.test(item.id) ? Math.min(2, item.max) : item.max} step={(item.max - item.min) / 100 || 0.01}
        value={item.value} onChange={(event) => setParameter(item.id, Number(event.target.value))} />
    </label>
  );

  return (
    <section className="native-runtime-viewer">
      <div className="variant-preview-heading">
        <div><p className="eyebrow">OFFICIAL CUBISM RUNTIME</p><h3>原生 MOC3 交互验收</h3><small>本机导入、官方 Web Runtime 加载；文件不会上传。{savedPackageName ? ` 当前包：${savedPackageName}` : ''}</small></div>
        <label className="ghost-button runtime-import">导入原生运行时 ZIP<input aria-label="导入原生运行时 ZIP" disabled={busy} type="file" accept=".zip,application/zip" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void (async () => {
            skipNextRestore.current = true;
            const version = generation.current;
            try { await readRuntimePackage(file); await savePackage(file); if (generation.current === version && stage.current) await importPackage(file); }
            catch (error) { skipNextRestore.current = false; setStatus(`原始包保存失败：${String(error)}`); }
          })();
          event.target.value = '';
        }} /></label>
      </div>
      <div className="runtime-preview-grid">
        <div className="runtime-stage" ref={stage} style={{ touchAction: 'none', cursor: 'grab' }}
          onPointerDown={e => { if (e.button !== 0) return; drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={e => { if (!drag.current) return; view.current.x += e.clientX - drag.current.x; view.current.y += e.clientY - drag.current.y; drag.current = { x: e.clientX, y: e.clientY }; refit.current?.(); }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}><span>等待导入 MOC3 运行时包</span></div>
        <div className="runtime-controls">
          <section aria-label="视图与说话控制">
            <b>视图 · 拖动平移 / 滚轮缩放</b>
            <div className="modal-actions"><button className="ghost-button" onClick={() => changeZoom(zoom / 1.2)}>缩小</button><button className="ghost-button" onClick={() => changeZoom(zoom * 1.2)}>放大</button><button className="ghost-button" onClick={resetView}>复位视图</button></div>
            <label>缩放 {Math.round(zoom * 100)}%<input aria-label="预览缩放" type="range" min="0.25" max="4" step="0.05" value={zoom} onChange={e => changeZoom(+e.target.value)} /></label>
            <p>说话与口型</p><textarea aria-label="朗读文本" value={speechText} maxLength={1000} onChange={e => setSpeechText(e.target.value)} style={{ width: '100%' }} />
            {mouthAvailable && <section aria-label="Ana 新嘴部"><label><input type="checkbox" checked={newMouth} onChange={e => { setNewMouth(e.target.checked); mouthState.current.enabled = e.target.checked; }} />使用 Ana 新嘴巴（与参考页一致）</label><button className="ghost-button" onClick={async () => { try { const response = await fetch(`${import.meta.env.BASE_URL}preview-assets/ana-voice-demo.wav`); if (!response.ok) throw Error('示例语音加载失败'); await playAudio(new File([await response.blob()], 'ana-voice-demo.wav', { type: 'audio/wav' }), true); } catch (error) { setSpeechStatus(String(error)); } }}>播放 Ana 示例语音</button><button className="ghost-button" onClick={() => { if (runtime.current) talkingMouth.current?.focus(runtime.current.app); }}>脸部近看</button><small style={{ display: 'block' }}>复用参考页的嘴部贴图、网格跟随与示例语音轨迹；仅在网页预览中生效，不写入 MOC3。取消勾选可对比原嘴巴。</small></section>}
            <div className="modal-actions"><button className="ghost-button" disabled={!parameters.some(p => p.id === 'ParamMouthOpenY') || !speechText.trim()} onClick={speakText}>朗读文字</button><button className="ghost-button" disabled={!parameters.some(p => p.id === 'ParamMouthOpenY')} onClick={() => { stopSpeech(); speaking.current = true; setSpeechStatus('口型演示（无声音）'); }}>口型演示</button><button className="ghost-button" onClick={stopSpeech}>停止说话</button></div>
            <label>音频驱动口型<input aria-label="音频驱动口型" type="file" accept="audio/*" disabled={!parameters.some(p => p.id === 'ParamMouthOpenY')} onChange={e => { const f = e.target.files?.[0]; if (f) void playAudio(f); e.target.value = ''; }} /></label>
            <small role="status">{speechStatus}</small><small style={{ display: 'block' }}>文字使用本机语音＋近似口型；音频按音量驱动。说话期间覆盖嘴部开合，停止后恢复；不改模型文件。{parameters.length > 0 && !parameters.some(p => p.id === 'ParamMouthOpenY') ? '此模型缺少 ParamMouthOpenY，无法驱动口型。' : ''}</small>
            {mouthParameters.length > 0 && <section aria-label="嘴部控制"><h4>嘴部控制</h4><small>开合控制张嘴幅度；嘴形控制模型已有的表情绑定。拖动前先停止说话，避免开合被语音覆盖。</small><div className="runtime-parameter-list">{mouthParameters.map(control)}</div><button className="ghost-button" onClick={() => { stopSpeech(); mouthParameters.forEach(p => setParameter(p.id, p.defaultValue)); }}>嘴部复位</button></section>}
          </section>
          <p>{status}</p>
          <small>{workflowStatus}</small>
          <div className="modal-actions"><button className="ghost-button" disabled={busy || !parameters.length} onClick={reset}>释放手动参数</button><button className="primary-button" disabled={busy || !parameters.length} onClick={auditWave}>检测 Wave 响应</button></div>
          {parameters.some(p => p.id === 'ParamActionWave') && <div className="modal-actions"><button className="ghost-button" onClick={() => selectPose(0)}>默认姿势</button><button className="ghost-button" onClick={() => selectPose(1)}>挥手姿势</button></div>}
          <label><input type="checkbox" checked={repeat} onChange={event => { repeating.current = event.target.checked; setRepeat(event.target.checked); }} />循环当前动作（姿势切换不中断）</label>
          {groundAvailable && <div><label><input type="checkbox" checked={groundEnabled} onChange={event => { grounding.current?.setEnabled(event.target.checked); setGroundEnabled(event.target.checked); }} />脚底贴地（垂直补偿）</label><small style={{ display: 'block' }}>保留呼吸与轻屈膝，仅播放器生效。下载的 MOC3 / 动作 JSON 不包含此约束，其他播放器需接入补偿代码；不是双脚 IK。</small></div>}
          {!baselineApplied && parameters.length > 0 && <button className="ghost-button" disabled={busy} onClick={() => { if (originalPackage.current) void importPackage(originalPackage.current, false, parameters); }}>试配 Ana 小幅动作规范（新模型需重新验收）</button>}
          <div className="modal-actions"><button className="ghost-button" disabled={!dataFiles.length || busy} onClick={() => { if (derivedPackage.current) download(derivedPackage.current, 'morph-runtime-with-motions.zip'); }}>下载模型＋动作运行包</button><button className="ghost-button" disabled={!dataFiles.length} onClick={() => setDataOpen(!dataOpen)}>全部数据与代码</button></div>
          {measurement && <small>{measurement}</small>}
          <div className="runtime-motion-panel">
            <b>动作播放兼容性</b>
            {actionMotions.length > 0 && <div className="runtime-motion-list">{actionMotions.map((motion) => <button key={`${motion.group}-${motion.index}`} className="runtime-motion runtime-motion--action" onClick={() => void playMotion(motion)}>★ {motion.label}<small>{motion.file}</small></button>)}</div>}
            {otherMotions.length > 0 && <details><summary>其他 {otherMotions.length} 段原生动作</summary><div className="runtime-motion-list">{otherMotions.map((motion) => <button key={`${motion.group}-${motion.index}`} className="runtime-motion" onClick={() => void playMotion(motion)}>{motion.label}<small>{motion.group} · {motion.file}</small></button>)}</div></details>}
            {motions.length === 0 && <small>原包未注册动作。已验收 Ana 将自动接入 9 段基准动作；其他模型只在明确试配后添加，不凭参数名宣称绑定合格。</small>}
          </div>
          {priority.length > 0 && <div className="runtime-parameter-list">{priority.map(control)}</div>}
          {remaining.length > 0 && <details><summary>其他 {remaining.length} 个运行时参数</summary><div className="runtime-parameter-list">{remaining.map(control)}</div></details>}
        </div>
      </div>
      {dataOpen && <section className="runtime-data-panel"><h4>完整动作数据与执行代码 · {parameters.length} 个实时参数</h4>
        <label>源文件<select value={dataIndex} onChange={event => setDataIndex(Number(event.target.value))}>{dataFiles.map((file, index) => <option key={file.name} value={index}>{file.name}</option>)}</select></label>
        <button className="ghost-button" onClick={() => void downloadData()}>下载全部 JSON 与控制代码</button>
        <pre>{dataFiles[dataIndex]?.content}</pre>
        <p>当前值含动作、自然摆动及物理叠加。腿部测试限 ±2°；下表列出模型原始范围。</p>
        <div className="runtime-data-table"><table><thead><tr><th>参数 ID</th><th>最小</th><th>默认</th><th>最大</th><th>当前</th></tr></thead><tbody>{parameters.map((p, i) => <tr key={p.id}><td>{p.id}</td><td>{p.min}</td><td>{p.defaultValue}</td><td>{p.max}</td><td>{(liveValues[i] ?? p.defaultValue).toFixed(4)}</td></tr>)}</tbody></table></div>
      </section>}
    </section>
  );
}
