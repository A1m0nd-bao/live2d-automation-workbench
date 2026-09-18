import JSZip from 'jszip';
import baseline from './data/ana-motion-baseline-v1.json' with { type: 'json' };

export const BASELINE_ID = baseline.id;
export const APPROVED_ANA_MOC = '97f14b10bb8924ba03c25f6751352170303c6a448afc4e3f822db950ce849711';
const REPORT = '_morph_motion_workflow.json';
const PREFIX = '_morph_baseline_v1';

export function resolvePackagePath(modelPath, reference) {
  if (typeof reference !== 'string' || !reference || /[\\:?#%]/.test(reference) || reference.startsWith('/')) {
    throw Error(`运行包只能引用本包内的相对文件：${reference}`);
  }
  const parts = modelPath.split('/').slice(0, -1);
  for (const part of reference.split('/')) {
    if (part === '..') { if (!parts.length) throw Error('文件引用越过运行包根目录'); parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

export async function readRuntimePackage(blob) {
  const input = blob instanceof Blob ? await blob.arrayBuffer() : blob;
  const zip = await JSZip.loadAsync(input);
  const entries = Object.values(zip.files).filter(f => !f.dir);
  if (entries.length > 2000) throw Error('运行包文件数超过 2000');
  for (const entry of entries) {
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) throw Error('运行包包含被规范化的危险路径');
    if (entry.name.startsWith('/') || /[\\:?#%]/.test(entry.name) || entry.name.split('/').includes('..')) throw Error('运行包路径不安全');
  }
  const models = entries.filter(f => f.name.endsWith('.model3.json'));
  if (models.length !== 1) throw Error('请导入仅含一个 model3.json 的运行包，避免预览错模型。');
  const modelPath = models[0].name;
  const manifest = JSON.parse(await models[0].async('string'));
  const refs = manifest.FileReferences;
  if (!refs?.Moc || !Array.isArray(refs.Textures) || !refs.Textures.length) throw Error('运行包缺少 MOC 或纹理引用');
  const references = [refs.Moc, ...refs.Textures, refs.Physics, refs.DisplayInfo, refs.Pose,
    ...(refs.Expressions || []).map(x => x.File),
    ...Object.values(refs.Motions || {}).flatMap(list => list.flatMap(x => [x.File, x.Sound])),
  ].filter(Boolean);
  for (const reference of references) {
    const path = resolvePackagePath(modelPath, reference);
    if (!zip.file(path)) throw Error(`运行包缺少引用文件：${path}`);
  }
  const mocBytes = await zip.file(resolvePackagePath(modelPath, refs.Moc)).async('uint8array');
  const digest = await crypto.subtle.digest('SHA-256', mocBytes);
  const mocHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return { zip, modelPath, manifest, mocHash };
}

function scaleToModel(motion, parameters) {
  const result = structuredClone(motion);
  for (const curve of result.Curves) {
    const p = parameters.find(p => p.id === curve.Id);
    if (!p) throw Error(`不能套用此规范：模型缺少 ${curve.Id}`);
    const s = curve.Segments, positions = [1];
    for (let i = 2; i < s.length;) {
      const count = { 0: 2, 1: 6, 2: 2, 3: 2 }[s[i]];
      if (!count || i + count >= s.length) throw Error('动作曲线结构无效');
      for (let j = 2; j <= count; j += 2) positions.push(i + j);
      i += count + 1;
    }
    const center = p.defaultValue;
    if (center < p.min || center > p.max) throw Error(`模型参数默认值异常：${p.id}`);
    let factor = 1;
    for (const i of positions) {
      const delta = s[i] - center;
      if (delta > 0) factor = Math.min(factor, (p.max - center) / delta);
      if (delta < 0) factor = Math.min(factor, (p.min - center) / delta);
    }
    for (const i of positions) s[i] = center + (s[i] - center) * factor;
  }
  return result;
}

/** Derive a new ZIP; never patch MOC/CMO, never overwrite the original blob. */
export async function prepareMotionWorkflow(blob, { trialParameters } = {}) {
  const pkg = await readRuntimePackage(blob);
  const { zip, modelPath, manifest, mocHash } = pkg;
  const approved = mocHash === APPROVED_ANA_MOC;
  // Always validate the marker against this actual MOC. A stale marker cannot bless a new model.
  if (zip.file(REPORT)) {
    const report = JSON.parse(await zip.file(REPORT).async('string'));
    if (report.baselineId !== BASELINE_ID || report.mocSha256 !== mocHash) throw Error('动作规范记录与 MOC 不一致，请重新导入原始运行包');
    report.status = approved ? 'approved-ana-motion-profile' : 'trial-requires-visual-review';
    report.automaticAcceptance = false;
    return { ...pkg, report, derived: blob, baselineApplied: true };
  }
  if (!approved && !trialParameters) {
    return { ...pkg, derived: blob, baselineApplied: false, report: {
      baselineId: null, mocSha256: mocHash, status: 'unverified-model',
      note: '不是已验收 Ana 的同一份 MOC：保留原包动作，不自动套用 Ana 绑定假设。可人工试配并重新验收。',
    } };
  }
  if (trialParameters && !trialParameters.some(p => p.id === 'ParamActionWave' && p.min <= 0 && p.max >= 1)) throw Error('此模型不支持当前 Wave 0–1 姿势控制规范');
  if (Object.keys(zip.files).some(name => name.includes(`${PREFIX}/`))) throw Error('运行包已含保留的动作目录，请从原始包试配');
  const actionEntries = [];
  const folder = modelPath.split('/').slice(0, -1).join('/');
  for (const source of baseline.motions) {
    const File = `${PREFIX}/${source.file}`;
    const path = folder ? `${folder}/${File}` : File;
    const motion = trialParameters ? scaleToModel(source.adapted, trialParameters) : source.adapted;
    zip.file(path, JSON.stringify(motion, null, 2));
    zip.file(`${PREFIX}/original-v9/${source.file}`, JSON.stringify(source.originalV9, null, 2));
    actionEntries.push({ File, Name: source.name });
  }
  const motions = manifest.FileReferences.Motions ||= {};
  if (motions.MorphBaseline) throw Error('原包已经存在 MorphBaseline 动作组；不会覆盖');
  motions.MorphBaseline = actionEntries;
  zip.file(modelPath, JSON.stringify(manifest, null, 2));
  const report = {
    baselineId: BASELINE_ID, mocSha256: mocHash,
    status: approved ? 'approved-ana-motion-profile' : 'trial-requires-visual-review',
    policy: baseline.policy, group: 'MorphBaseline', motions: actionEntries.length,
    mocModified: false, nativeExportPerformed: false, automaticAcceptance: false,
    note: '仅追加已确认的动作曲线与记录，保留原包所有动作/纹理/物理/模型。整体摆动 35%，膝 ±4°；原始 ZIP 另存于任务。当前绑定不等于 v9 软膝。',
  };
  zip.file(REPORT, JSON.stringify(report, null, 2));
  return { ...pkg, report, baselineApplied: true, derived: await zip.generateAsync({ type: 'blob' }) };
}

export async function runtimeDataFiles(pkg) {
  const result = [];
  for (const file of Object.values(pkg.zip.files)) {
    if (!file.dir && file.name.endsWith('.json')) result.push({ name: file.name, content: await file.async('string') });
  }
  result.push({ name: 'workflow-status.json', content: JSON.stringify(pkg.report, null, 2) });
  return result;
}
