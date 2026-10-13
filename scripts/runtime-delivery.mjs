/** Native package delivery. Verify actual compiled Core, never parameter names alone. */
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { faceParameterIds, expressionPresetSystem, resolveExpressionProfiles, boundExpressionValues } from './expression-profiles.mjs';

export function motion(curves, duration = 3, loop = false) {
  const result = { Version: 3, FadeInTime: 0, FadeOutTime: 0,
    Meta: { Duration: duration, Fps: 30, Loop: loop, AreBeziersRestricted: true,
      CurveCount: curves.length, TotalSegmentCount: 0, TotalPointCount: 0,
      UserDataCount: 0, TotalUserDataSize: 0 }, Curves: [] };
  for (const { id, keys, stepped = false } of curves) {
    assert.ok(keys.length >= 2 && keys[0][0] === 0 && keys.at(-1)[0] === duration);
    assert.ok(keys.every(([t, v], i) => Number.isFinite(v) && Number.isFinite(t) && (!i || t > keys[i - 1][0])));
    result.Curves.push({ Target: 'Parameter', Id: id, FadeInTime: 0, FadeOutTime: 0,
      Segments: [...keys[0], ...keys.slice(1).flatMap(([t, v]) => [stepped ? 2 : 0, t, v])] });
    result.Meta.TotalSegmentCount += keys.length - 1;
    result.Meta.TotalPointCount += keys.length;
  }
  return result;
}

export function stateMotions(catalog) {
  return catalog.flatMap(lane => lane.states.map(state => {
    const measured = lane.measuredWave && state.id === 'action_02_wave_arms_only';
    const duration = measured ? 5 : 3;
    const keys = measured ? [[0,0],[.25,0],[1.25,1],[1.85,2],[2.45,3],[3.05,2],[3.65,1],[4.65,0],[5,0]]
      : [[0,state.value],[2.8,state.value],[3,0]];
    return { id: state.id, kind: lane.kind, parameter: lane.parameter, value: state.value,
      file: `motions/${state.id}.motion3.json`, data: motion([{ id: lane.parameter, keys, stepped: !measured }], duration) };
  }));
}

function interpolate(keys, values, value) {
  if (value <= keys[0]) return values[0];
  const i = keys.findIndex(k => k >= value);
  if (i < 0) return values.at(-1);
  return values[i - 1] + (values[i] - values[i - 1]) * (value - keys[i - 1]) / (keys[i] - keys[i - 1]);
}

export async function deliver(corePath, modelPath, metadataPath, directory) {
  const ctx = { console, WebAssembly, performance, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    URL, fetch, atob, btoa, document: { currentScript: { src: 'file:///local/core.js' } } };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx); vm.runInContext(await fs.readFile(corePath, 'utf8'), ctx);
  await new Promise(r => setTimeout(r, 200));
  const bytes = await fs.readFile(modelPath);
  const moc = ctx.Live2DCubismCore.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.ok(moc, 'Invalid MOC3');
  const model = ctx.Live2DCubismCore.Model.fromMoc(moc);
  assert.ok(model, 'Invalid runtime model');
  try {
    const meta = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    assert.ok(meta.version === 1 && Array.isArray(meta.stateCatalog) && meta.stateCatalog.length <= 2, 'Invalid delivery catalog');
    assert.ok(Array.isArray(meta.meshes) && meta.meshes.length <= 1000, 'Invalid delivery meshes');
    for (const lane of meta.stateCatalog) {
      assert.ok(['action','expression'].includes(lane.kind) && /^Param[A-Za-z0-9_]+$/.test(lane.parameter), 'Invalid selector');
      assert.ok(lane.states.length <= 32 && Number.isFinite(lane.max) && lane.max <= 40, 'Too many states');
      for (const state of lane.states) assert.ok(/^(action|expression)_[A-Za-z0-9_-]{1,120}$/.test(state.id) && Number.isFinite(state.value), 'Unsafe state identifier');
    }
    const p = model.parameters, d = model.drawables;
    const pose = values => { p.values.set(p.defaultValues); for (const [id, value] of Object.entries(values)) {
      const i = p.ids.indexOf(id); assert.ok(i >= 0, `Unbound parameter ${id}`); p.values[i] = value;
    } model.update(); };
    const snapshot = () => ({ opacity: Array.from(d.opacities), vertices: d.vertexPositions.map(v => Array.from(v)) });
    pose({}); const neutral = snapshot();
    const difference = () => Math.max(...d.opacities.map((v,i) => Math.abs(v-neutral.opacity[i])),
      ...d.vertexPositions.map((v,i) => v.reduce((delta,n,k) => Math.max(delta,Math.abs(n-neutral.vertices[i][k])),0)));
    const report = { version: 'native-delivery-v3', status: 'passed', visualAcceptance: 'pending',
      sampledStates: 0, motions: [], expressions: [], skippedExpressions: [], neutralReturnDelta: 0 };
    report.expressionPresetSystem = expressionPresetSystem;
    report.selectors = meta.stateCatalog.map(lane => ({ kind:lane.kind,parameter:lane.parameter,
      measuredWave:lane.measuredWave,states:lane.states.map(s=>({id:s.id,value:s.value})) }));
    for (const lane of meta.stateCatalog ?? []) {
      const param = p.ids.indexOf(lane.parameter);
      assert.ok(param >= 0 && p.maximumValues[param] >= lane.max, 'State selector missing or truncated');
      const controlled = meta.meshes.filter(m => m.action?.id === lane.parameter && m.action.keys?.length);
      assert.ok(controlled.length, 'No bound state meshes');
      const samples = [...new Set([0, ...lane.states.map(s => s.value), ...controlled.flatMap(m => m.action.keys)])];
      for (const sample of samples) {
        pose({ [lane.parameter]: sample }); report.sampledStates++;
        for (const m of controlled) {
          const i = d.ids.indexOf(m.id); assert.ok(i >= 0, `Missing drawable ${m.id}`);
          const expected = interpolate(m.action.keys, m.action.opacities, sample);
          assert.ok(Math.abs(d.opacities[i] - expected) < .015, `${m.name}: incorrect state opacity at ${sample}`);
        }
        for (const v of d.vertexPositions) assert.ok(v.every(Number.isFinite), 'Nonfinite state geometry');
      }
      for (const s of lane.states) { pose({[lane.parameter]:s.value}); assert.ok(difference() > .00001, `${s.id} ineffective`); }
    }
    const clips = stateMotions(meta.stateCatalog ?? []);
    const write = async (file, data) => { const target = path.join(directory,file);
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(data,null,2)); };
    const groups = { Actions: [], Expressions: [], Idle: [], Talk: [] }, expressions = [], files = [];
    for (const clip of clips) {
      await write(clip.file, clip.data); files.push(clip.file);
      groups[clip.kind === 'expression' ? 'Expressions' : 'Actions'].push({ Name: clip.id, File: clip.file, FadeInTime: 0, FadeOutTime: 0 });
      report.motions.push(clip.id);
    }
    const faceIds = ['ParamExpressionPose',...faceParameterIds].filter(id => p.ids.includes(id));
    const faceDefaults = Object.fromEntries(faceIds.map(id => [id,p.defaultValues[p.ids.indexOf(id)]]));
    const presets = [{ id:'neutral', values: faceDefaults, source: 'bound-parameter-preset' }];
    const expressionLane = (meta.stateCatalog ?? []).find(lane => lane.kind === 'expression');
    let expressionConfig = {};
    try {
      const profileBytes = await fs.readFile(path.join(directory,'expression-profile.json'));
      assert.ok(profileBytes.length <= 65536,'Expression profile too large');
      expressionConfig = JSON.parse(profileBytes.toString('utf8'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const definitions = resolveExpressionProfiles(expressionConfig);
    report.requestedExpressions = definitions.map(([id])=>id);
    if (expressionLane) for (const s of expressionLane.states) presets.push({id:s.id,values:{...faceDefaults,[expressionLane.parameter]:s.value},source:'authored-PSD'});
    else {
      for (const [id, requested] of definitions) {
        const {missing,values} = boundExpressionValues(requested,p);
        if (missing.length) { report.skippedExpressions.push({id,parameters:missing,reason:'required parameter absent'}); continue; }
        const ineffective = Object.entries(values).filter(([key,value]) => {
          if (value === p.defaultValues[p.ids.indexOf(key)]) return false;
          pose({[key]:value}); return difference() <= .00001;
        }).map(([key])=>key);
        if (ineffective.length) { report.skippedExpressions.push({id,parameters:ineffective,reason:'required expression parameter has no effective target'}); continue; }
        pose(values);
        if (difference() <= .00001) { report.skippedExpressions.push({id,reason:'compiled parameters have no effective target'}); continue; }
        presets.push({id,values:{...faceDefaults,...values},source:expressionPresetSystem});
      }
    }
    for (const preset of presets) {
      const file = `expressions/${preset.id}.exp3.json`;
      await write(file,{Type:'Live2D Expression',FadeInTime:.2,FadeOutTime:.2,
        Parameters:Object.entries(preset.values).map(([Id,Value])=>({Id,Value,Blend:'Overwrite'}))});
      files.push(file); expressions.push({Name:preset.id,File:file}); report.expressions.push({id:preset.id,source:preset.source});
      if (preset.source !== 'authored-PSD') {
        const motionFile = `motions/expression_${preset.id}.motion3.json`;
        const curves = Object.entries(preset.values).map(([id,value])=>({id,
          keys:[[0,value],[2.8,value],[3,faceDefaults[id]]],stepped:id==='ParamExpressionPose'}));
        await write(motionFile,motion(curves));files.push(motionFile);
        groups.Expressions.push({Name:preset.id,File:motionFile,FadeInTime:0,FadeOutTime:0});
      }
    }
    if (['ParamEyeLOpen','ParamEyeROpen'].every(id=>p.ids.includes(id))) {
      const effective=['ParamEyeLOpen','ParamEyeROpen'].every(id=>{pose({[id]:0});return difference()>.00001;});
      if (effective) {
        const file='motions/blink.motion3.json';await write(file,motion(['ParamEyeLOpen','ParamEyeROpen'].map(id=>({id,keys:[[0,1],[.12,0],[.25,1],[1,1]]})),1));
        files.push(file);groups.Idle.push({Name:'blink',File:file});
      }
    }
    report.compiledFrameSamples=0;
    report.validation='Compiled Core keyform/linear/stepped samples; separate SDK playback and visual acceptance required';
    for (const file of files.filter(f=>f.endsWith('.motion3.json'))) {
      const clip=JSON.parse(await fs.readFile(path.join(directory,file),'utf8'));
      const tracks=clip.Curves.map(c=>{
        const s=c.Segments,points=[{time:s[0],value:s[1],type:0}];
        for(let j=2;j<s.length;j+=3){assert.ok(s[j]===0||s[j]===2,'Unsupported generated segment');points.push({time:s[j+1],value:s[j+2],type:s[j]});}
        return {id:c.Id,points};
      });
      for(let frame=0;frame<=Math.ceil(clip.Meta.Duration*30);frame++){
        const time=Math.min(frame/30,clip.Meta.Duration),values={};
        for(const track of tracks){
          const i=track.points.findIndex(k=>k.time>=time);
          const b=track.points[i<0?track.points.length-1:i],a=track.points[Math.max(0,i-1)];
          const value=i<=0?b.value:time===b.time?b.value:b.type===2?a.value:a.value+(b.value-a.value)*(time-a.time)/(b.time-a.time);
          const pi=p.ids.indexOf(track.id);
          assert.ok(pi>=0&&Number.isFinite(value)&&value>=p.minimumValues[pi]-1e-6&&value<=p.maximumValues[pi]+1e-6,'Motion parameter out of range');
          values[track.id]=value;
        }
        pose(values);report.compiledFrameSamples++;
        for(const v of d.vertexPositions)assert.ok(v.every(Number.isFinite),'Nonfinite motion geometry');
        for(const m of meta.meshes.filter(m=>m.action?.keys?.length)){
          const pi=p.ids.indexOf(m.action.id),di=d.ids.indexOf(m.id);
          const expected=interpolate(m.action.keys,m.action.opacities,p.values[pi]);
          assert.ok(Math.abs(d.opacities[di]-expected)<.015,'Motion has inconsistent replacement opacity');
        }
      }
    }
    for (const [group,name,id,keys,duration] of [
      ['Idle','idle','ParamAngleX',[[0,0],[1,0],[3,2],[5,2],[7,0],[9,-2],[11,-2],[13,0],[14,0]],14],
      ['Talk','talk','ParamMouthOpenY',[[0,0],[.1,0],[.2,.56],[.31,.14],[.44,.78],[.58,.22],[.72,.48],[.85,0],[1.02,.64],[1.16,0],[1.32,.35],[1.48,0]],1.48],
    ]) {
      const i=p.ids.indexOf(id);if(i<0)continue;
      const bounded=keys.map(([t,v])=>[t,Math.min(p.maximumValues[i],Math.max(p.minimumValues[i],v))]);
      pose({[id]:bounded.find(([,v])=>v!==p.defaultValues[i])?.[1]??p.defaultValues[i]});
      if(difference()<=.00001)continue;
      const file=`motions/${name}.motion3.json`;await write(file,motion([{id,keys:bounded}],duration,true));
      files.push(file);groups[group].push({Name:name,File:file});
    }
    pose({});report.neutralReturnDelta=difference();assert.ok(report.neutralReturnDelta<.00001,'Neutral return drift');
    const manifest=JSON.parse(await fs.readFile(path.join(directory,'model.model3.json'),'utf8'));
    manifest.FileReferences.Motions=Object.fromEntries(Object.entries(groups).filter(([,v])=>v.length));
    manifest.FileReferences.Expressions=expressions;
    await write('model.model3.json',manifest);await write('runtime-delivery.json',report);
    return [...files,'runtime-delivery.json'];
  } finally { model.release();moc._release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [core,model,metadata,directory]=process.argv.slice(2);
  const files=await deliver(core,model,metadata,directory);
  await fs.writeFile(path.join(directory,'runtime-delivery-files.json'),JSON.stringify(files));
}
