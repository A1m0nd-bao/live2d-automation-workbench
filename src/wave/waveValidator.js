import { deformWaveVertices } from '../waveRig.js';
import { phaseAtTime, sampleWaveMesh } from './waveRenderer.js';

const area = (v, t) => {
  const [a,b,c]=t.map(i=>[v[2*i],v[2*i+1]]);
  return ((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
};

export function validateWaveGeometry(meshes, profile) {
  const entries=[],errors=[],warnings=[];
  for(const mesh of meshes){const action=mesh.actionSwitch;if(!action)continue;
    let foldedArea=0,maxStretch=1,baseArea=0;
    const triangles=[];for(let i=0;i<mesh.triangles.length;i+=3)triangles.push(mesh.triangles.slice(i,i+3));
    const restAreas=triangles.map(t=>area(mesh.vertices,t));baseArea=restAreas.reduce((s,a)=>s+Math.abs(a),0);
    const states=action.stateVertices;
    let worstPhase=0,waveFoldedArea=0;
    for(let state=0;state<states.length;state++){
      const v=states[state];if(v.length!==mesh.vertices.length||v.some(n=>!Number.isFinite(n))){errors.push(`${mesh.name} 包含无效顶点`);continue;}
      if(action.stateOpacities[state]<.05)continue;
      let fold=0;
      triangles.forEach((t,i)=>{const original=restAreas[i];if(Math.abs(original)<.1)return;
        const current=area(v,t);if(original*current<0)fold+=Math.abs(original);
        maxStretch=Math.max(maxStretch,Math.abs(current/original));});
      if(action.keys[state]>1)waveFoldedArea=Math.max(waveFoldedArea,fold);
      if(fold>foldedArea){foldedArea=fold;worstPhase=action.keys[state];}
    }
    const ratio=foldedArea/Math.max(1,baseArea);
    if(ratio>.01)warnings.push(`${mesh.name} 存在网格翻折（最大面积占比 ${(ratio*100).toFixed(1)}%），请检查肘部或缩小幅度。`);
    if(maxStretch>4)warnings.push(`${mesh.name} 局部三角形拉伸较大，请检查过渡。`);
    const isAlt=mesh.name.includes('__'), slot=isAlt?mesh.name.split('__').at(-1):mesh.name;
    const shoulder=profile.slots[slot].raised[0];
    const shoulderPos=deformWaveVertices([shoulder.x,shoulder.y],profile,slot,true,1.5);
    const shoulderDrift=Math.hypot(shoulderPos[0]-shoulder.x,shoulderPos[1]-shoulder.y);
    const start=states[action.keys.indexOf(1)],end=states[action.keys.indexOf(3)];
    const loopGap=start.reduce((max,n,i)=>Math.max(max,Math.abs(n-end[i])),0);
    if(loopGap>.01)errors.push(`${mesh.name} 挥手循环首尾不连续。`);
    if(shoulderDrift>Math.max(profile.width,profile.height)*.002)warnings.push(`${slot} 肩部有位移，请检查关节点和路径。`);
    entries.push({name:mesh.name,foldedAreaRatio:ratio,waveFoldedAreaRatio:waveFoldedArea/Math.max(1,baseArea),maxAreaStretch:maxStretch,worstPhase,loopGap,shoulderDrift});
  }
  if(!entries.length)errors.push('没有生成任何挥手绑定。');
  return {version:1,status:errors.length?'failed':'needs-visual-review',errors,warnings,entries,
    visualReviewRequired:true,
    visualChecks:['肩肘接缝和身体遮挡','中段两套手指的重影','皮肤或衣袖拉伸','手掌边缘及连续播放'],
    note:'自动检查覆盖网格数值和循环连续性，不能代替对露缝、重影和自然程度的视觉验收。'};
}

export function generateWithAmplitudeSearch(build, profile) {
  let result=build(profile),report=validateWaveGeometry(result,profile);
  const waveFold=r=>Math.max(0,...r.entries.map(e=>e.waveFoldedAreaRatio));
  const requested=profile.amplitude;
  if(waveFold(report)>.01){
    for(const factor of [.75,.5]){
      const candidate={...profile,amplitude:Math.max(1,requested*factor)};
      const next=build(candidate),qa=validateWaveGeometry(next,candidate);
      if(waveFold(qa)<waveFold(report)){profile=candidate;result=next;report=qa;}
      if(waveFold(report)<=.01)break;
    }
  }
  report.requestedAmplitude=requested;report.appliedAmplitude=profile.amplitude;
  report.sequence=validateWaveSequence(result);
  if(!report.sequence.finite){report.errors.push('完整动作采样发现无效顶点。');report.status='failed';}
  return {meshes:result,profile,report};
}

export function validateWaveSequence(meshes) {
  const animated=meshes.filter(m=>m.actionSwitch),frames=151;
  let finite=true,maxVertexStep=0,returnGap=0;
  let previous=null;
  for(let frame=0;frame<frames;frame++){
    const states=animated.map(m=>sampleWaveMesh(m,phaseAtTime(frame/30)));
    for(let i=0;i<states.length;i++){
      const state=states[i];finite&&=state.vertices.every(Number.isFinite)&&Number.isFinite(state.opacity);
      if(previous&&state.opacity>.05&&previous[i].opacity>.05)
        for(let j=0;j<state.vertices.length;j+=2)maxVertexStep=Math.max(maxVertexStep,Math.hypot(state.vertices[j]-previous[i].vertices[j],state.vertices[j+1]-previous[i].vertices[j+1]));
    }
    previous=states;
  }
  for(const mesh of animated){const start=sampleWaveMesh(mesh,phaseAtTime(0)),end=sampleWaveMesh(mesh,phaseAtTime(4.8));
    returnGap=start.vertices.reduce((max,v,i)=>Math.max(max,Math.abs(v-end.vertices[i])),returnGap);
  }
  return {durationSeconds:5,fps:30,frames,finite,maxVertexStep,returnGap,
    note:'最大顶点帧间位移是数值记录，不代表视觉连续性验收通过。'};
}
