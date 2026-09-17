import { useEffect, useRef, useState } from 'react';
import { downloadBlob } from './assets';
import { loadWaveFile, buildWaveMeshes, bindWaveMeshes, exportWavePackage } from './wave/wavePipeline.js';
import { validateWaveProfile } from './wave/armPoseAnalyzer.js';
import { renderWave, phaseAtTime } from './wave/waveRenderer.js';
import './wave-workbench.css';

const labels=['肩膀','肘部','手腕'];
const poses={neutral:'基础姿态',raised:'抬手姿态'};

function layerImage(layer) {
  const c=document.createElement('canvas');c.width=layer.width;c.height=layer.height;
  c.getContext('2d').putImageData(layer.imageData,0,0);return c.toDataURL('image/png');
}

function JointEditor({input,images,profile,slot,pose,onChange}) {
  const svg=useRef(null),drag=useRef(null);const [joint,setJoint]=useState(1);
  const layer=input.pairs[slot][pose],points=profile.slots[slot][pose];
  const pad=Math.max(layer.width,layer.height)*.12;
  const bounds={x:layer.x-pad,y:layer.y-pad,w:layer.width+pad*2,h:layer.height+pad*2};
  const pointSize=Math.max(bounds.w,bounds.h)*.022;
  const edit=(index,x,y)=>onChange(p=>{p.slots[slot][pose][index]={x:Math.max(0,Math.min(input.width-1,x)),y:Math.max(0,Math.min(input.height-1,y))};});
  const move=e=>{if(drag.current===null)return;const matrix=svg.current.getScreenCTM();if(!matrix)return;
    const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse());edit(drag.current,p.x,p.y);};
  return <section className="wave-joint-card">
    <h3>{poses[pose]} <small>拖动圆点校正</small></h3>
    <svg ref={svg} viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`} aria-label={`${poses[pose]}关节点`} onPointerMove={move}
      onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
      <image href={images[layer.name]} x={layer.x} y={layer.y} width={layer.width} height={layer.height}/>
      <polyline points={profile.slots[slot][`${pose}Path`].map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke="#1a8b78" strokeWidth={pointSize*.25} opacity=".7"/>
      <polyline points={points.map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke="#d45b36" strokeWidth={pointSize*.3}/>
      {points.map((p,i)=><g key={i}>
        <circle data-joint={`${pose}-${i}`} cx={p.x} cy={p.y} r={pointSize} fill={i===joint?'#c14623':'#fff'} stroke="#c14623" strokeWidth={pointSize*.2}
          onPointerDown={e=>{e.preventDefault();drag.current=i;setJoint(i);svg.current.setPointerCapture(e.pointerId);}}/>
        <text x={p.x+pointSize*1.5} y={p.y} fontSize={pointSize*1.7} fill="#933819" paintOrder="stroke" stroke="#fff" strokeWidth={pointSize*.3}>{labels[i]}</text>
      </g>)}
    </svg>
    <div className="wave-coordinate-fields">
      <label>关节点<select aria-label={`${poses[pose]}选择关节`} value={joint} onChange={e=>setJoint(Number(e.target.value))}>{labels.map((n,i)=><option key={n} value={i}>{n}</option>)}</select></label>
      {['x','y'].map(axis=><label key={axis}>{axis.toUpperCase()}<input aria-label={`${poses[pose]}${axis.toUpperCase()}`} type="number" step="1" min="0" max={axis==='x'?input.width-1:input.height-1} value={Math.round(points[joint][axis])}
        onChange={e=>{if(e.target.value==='')return;edit(joint,axis==='x'?Number(e.target.value):points[joint].x,axis==='y'?Number(e.target.value):points[joint].y);}}/></label>)}
    </div>
  </section>;
}

function WavePreview({result,onSnapshot}) {
  const canvas=useRef(null),phaseRef=useRef(0),clock=useRef(null);
  const [phase,setPhase]=useState(0),[playing,setPlaying]=useState(false),[mode,setMode]=useState('full'),[wire,setWire]=useState(false);
  useEffect(()=>{phaseRef.current=phase;if(canvas.current)renderWave(canvas.current.getContext('2d'),result,phase,wire);},[result,phase,wire]);
  useEffect(()=>{
    if(!playing)return;let frame,start=null,last=0;
    const animate=now=>{if(start===null)start=now;if(now-last>=1000/30){const value=phaseAtTime((now-start)/1000,mode);phaseRef.current=value;renderWave(canvas.current.getContext('2d'),result,value,wire);if(clock.current)clock.current.textContent=value.toFixed(2);last=now;}frame=requestAnimationFrame(animate);};
    frame=requestAnimationFrame(animate);return()=>cancelAnimationFrame(frame);
  },[playing,result,mode,wire]);
  return <section className="wave-preview-card">
    <div className="wave-section-title"><h2>4 / 动作预览</h2><label><input type="checkbox" checked={wire} onChange={e=>setWire(e.target.checked)}/> 网格</label></div>
    <div className="wave-stage"><canvas ref={canvas} width={result.width} height={result.height} aria-label="挥手动作预览"/></div>
    <div className="wave-playback">
      <button type="button" onClick={()=>{if(playing)setPhase(phaseRef.current);setPlaying(!playing);}}>{playing?'暂停':'播放'}</button>
      <select aria-label="播放动作" value={mode} onChange={e=>setMode(e.target.value)}><option value="full">抬手 → 挥动 → 放下</option><option value="wave">只循环挥手</option></select>
      <button type="button" onClick={()=>canvas.current.toBlob(blob=>blob&&onSnapshot(blob),'image/png')}>保存当前画面</button>
    </div>
    <label className="wave-phase">动作进度 <output ref={clock}>{phase.toFixed(2)}</output><input aria-label="动作进度" type="range" min="0" max="3" step=".01" value={phase} onChange={e=>{setPlaying(false);setPhase(Number(e.target.value));}}/></label>
    <small>0–1 抬手；1–3 挥动。拖动滑块检查中间形态。</small>
  </section>;
}

export default function WaveWorkbench({onBack}) {
  const [document,setDocument]=useState(null),[profile,setProfile]=useState(null),[images,setImages]=useState({}),[slot,setSlot]=useState('handwear-r');
  const [busy,setBusy]=useState(false),[progress,setProgress]=useState(''),[error,setError]=useState(''),[result,setResult]=useState(null),[notice,setNotice]=useState('');
  const meshes=useRef(null),operation=useRef(0);
  useEffect(()=>()=>{operation.current++;},[]);
  const update=fn=>{setProfile(p=>{const next=structuredClone(p);fn(next);next.reviewed=false;return next;});setResult(null);setNotice('配置已修改，请重新生成动作。');};
  async function upload(file){if(!file)return;const id=++operation.current;setBusy(true);setError('');setResult(null);setDocument(null);setProfile(null);meshes.current=null;setProgress('1 / 读取图层并估计关节…');
    try{const loaded=await loadWaveFile(file);if(operation.current!==id)return;
      const picture={};for(const pair of Object.values(loaded.input.pairs))for(const l of Object.values(pair))picture[l.name]=layerImage(l);
      setDocument(loaded);setImages(picture);setProfile(loaded.profile);setSlot(Object.keys(loaded.profile.slots).find(s=>loaded.profile.slots[s].active));
      setNotice('自动标定已完成，请检查肩、肘、腕。绿色线为图层轮廓估计出的手臂路径。');
    }catch(e){if(operation.current===id)setError(e.message);}finally{if(operation.current===id){setBusy(false);setProgress('');}}}
  async function generate(){setBusy(true);setError('');setResult(null);const id=operation.current;
    try{validateWaveProfile(profile,document.input);if(!meshes.current)meshes.current=await buildWaveMeshes(document.input,setProgress);
      const next=bindWaveMeshes(document.input,profile,meshes.current);if(operation.current!==id)return;setResult(next);setProfile(next.profile);setNotice('已生成预览和检查结果，请检查抬手中段与关节接缝。');
    }catch(e){setError(e.message);}finally{setBusy(false);setProgress('');}}
  async function exportPackage(){setBusy(true);setError('');try{downloadBlob(await exportWavePackage(document.input,result,setProgress),'wave-first-version.zip');setNotice('已导出 CMO3、动作曲线、人物配置和预览图。');}catch(e){setError(e.message);}finally{setBusy(false);setProgress('');}}
  async function importProfile(file){if(!file||!document)return;try{const p=JSON.parse(await file.text());validateWaveProfile(p,document.input);setProfile(p);setResult(null);setError('');setNotice('配置已导入，请重新生成。');}catch(e){setError(e.message);}}
  return <main className="wave-workbench">
    <header className="wave-header"><div><button className="wave-back" onClick={onBack}>← 返回生产工作台</button><p>LOCAL / WAVE LAB · 第一版</p><h1>为这个角色定制挥手</h1><span>读取同名图层，估计关节，校正后生成动作。PSD 保留原样。</span></div><span className="wave-local">本地处理 · 无需上传图片</span></header>
    <ol className="wave-steps">{['读取素材','标定关节','建立绑定','生成动作','渲染验收'].map((name,i)=><li key={name} className={(document&&i<2)||(result&&i<4)?'done':''}><b>{i+1}</b>{name}</li>)}</ol>
    <section className="wave-upload"><div><h2>1 / 导入分层 PSD</h2><p>需要 handwear-l、handwear-r，以及 action_02_wave_arms_only 下对应的两张替换手臂。</p></div><label className="wave-file">选择 PSD<input aria-label="选择 PSD" type="file" accept=".psd" disabled={busy} onChange={e=>{upload(e.target.files?.[0]);e.target.value='';}}/></label>{document&&<strong>{document.filename} · {document.input.width} × {document.input.height}</strong>}</section>
    {error&&<div role="alert" className="wave-error">{error}</div>}
    {busy&&<p role="status" className="wave-status">{progress||'处理中…'}</p>}
    {!busy&&notice&&document&&<p role="status" className="wave-status">{notice}</p>}
    {document&&profile&&<>
      <section className="wave-calibration"><div className="wave-section-title"><h2>2 / 校正关节点</h2><select aria-label="选择手臂" value={slot} disabled={busy} onChange={e=>setSlot(e.target.value)}><option value="handwear-r">handwear-r</option><option value="handwear-l">handwear-l</option></select></div>
        <p>直臂的肘部按比例估计，需要人工检查。手掌范围用于辅助分析，第一版保持手指原有形态。</p>
        <fieldset disabled={busy}><div className="wave-joints">{Object.keys(poses).map(pose=><JointEditor key={`${slot}-${pose}`} input={document.input} images={images} profile={profile} slot={slot} pose={pose} onChange={update}/>)}</div>
          <div className="wave-options"><label><input type="checkbox" checked={profile.slots[slot].active} onChange={e=>update(p=>{p.slots[slot].active=e.target.checked;})}/> 让这侧手臂挥动</label>
            <label>挥动幅度 <input aria-label="挥动幅度" type="number" min="1" max="15" value={profile.amplitude} onChange={e=>update(p=>{p.amplitude=Number(e.target.value);})}/> °</label>
            <button type="button" onClick={()=>{setProfile(structuredClone(document.profile));setResult(null);setNotice('已恢复自动标定。');}}>恢复自动标定</button>
          </div></fieldset>
        <div className="wave-actions"><button className="wave-primary" disabled={busy} onClick={generate}>3 / 生成绑定与动作</button><button disabled={busy} onClick={()=>downloadBlob(new Blob([JSON.stringify(profile,null,2)],{type:'application/json'}),'wave-profile.json')}>保存人物配置</button><label className="wave-file secondary">导入配置<input aria-label="导入人物配置" type="file" accept=".json" disabled={busy} onChange={e=>{importProfile(e.target.files?.[0]);e.target.value='';}}/></label></div>
      </section>
      {result&&<div className="wave-results"><WavePreview result={result} onSnapshot={blob=>downloadBlob(blob,'wave-frame.png')}/>
        <section className="wave-qa"><h2>5 / 检查与导出</h2><b className={result.report.errors.length?'wave-bad':'wave-review'}>{result.report.errors.length?'需要修正':'待视觉验收'}</b>
          <p>数值检查不等于自然效果通过。重点检查肘部、肩部接缝，以及两套手指切换时的重影。</p>
          <dl><dt>请求 / 实际挥动幅度</dt><dd>{result.report.requestedAmplitude}° / {result.report.appliedAmplitude}°</dd><dt>循环最大接缝</dt><dd>{Math.max(0,...result.report.entries.map(e=>e.loopGap)).toFixed(3)} px</dd><dt>最大翻折面积占比</dt><dd>{(Math.max(0,...result.report.entries.map(e=>e.foldedAreaRatio))*100).toFixed(2)}%</dd></dl>
          {result.report.errors.concat(result.report.warnings).map((w,i)=><p key={i} className="wave-warning">{w}</p>)}
          <button className="wave-primary" disabled={busy||result.report.errors.length>0} onClick={exportPackage}>导出工程与动作包</button>
          <p className="wave-export-note">包含 CMO3、motion3、人物配置、检查结果和预览图。第一版不直接编译 MOC3。</p>
        </section></div>}
    </>}
  </main>;
}
