// Timeline-only controller. Never invents a missing rig or edits the model.
export const actions = {
  elbows: {label:'轻屈肘', duration:3.2},
  knees: {label:'轻屈膝', duration:3.2},
  combined: {label:'屈肘＋轻屈膝', duration:4.4},
  blink: {label:'眨眼', duration:.42},
};
export const ownedIds = ['ParamAngleX','ParamAngleY','ParamAngleZ','ParamBodyAngleX','ParamBodyAngleY','ParamBodyAngleZ','ParamBreath','ParamEyeLOpen','ParamEyeROpen','ParamRotation_leftElbow','ParamRotation_rightElbow','ParamRotation_leftLeg','ParamRotation_rightLeg','ParamRotation_leftKnee','ParamRotation_rightKnee','ParamActionWave'];
const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
export function envelope(t,d){return smooth(t/.6)*smooth((d-t)/.7);}
export function eyeOpen(t){
  if(t<0||t>=.32)return 1;
  if(t<.1)return 1-smooth(t/.1);
  if(t<.14)return 0;
  return smooth((t-.14)/.18);
}
export function sampleFrame(seconds, parameters, options={}) {
  const values={};
  for(const id of ownedIds)if(parameters[id])values[id]=parameters[id].default;
  const put=(id,value)=>{const p=parameters[id];if(p)values[id]=Math.max(p.min,Math.min(p.max,value))||0;};
  const offset=(id,amount)=>put(id,(parameters[id]?.default??0)+amount);
  if(options.idle!==false){
    offset('ParamAngleX',2*Math.sin(seconds*.65));
    offset('ParamAngleY',.8*Math.sin(seconds*.91));
    offset('ParamAngleZ',1.2*Math.sin(seconds*.7));
    offset('ParamBodyAngleZ',.7*Math.sin(seconds*.7-.5));
    put('ParamBreath',.5-.5*Math.cos(seconds*1.5));
  }
  if(options.blink!==false){
    const open=eyeOpen((seconds+2)%4.6);
    for(const id of ['ParamEyeLOpen','ParamEyeROpen'])put(id,(parameters[id]?.default??1)*open);
  }
  const action=actions[options.action],t=options.elapsed??0;
  if(action&&t>=0&&t<action.duration){
    const e=envelope(t,action.duration);
    if(options.action==='elbows'||options.action==='combined'){
      const pulse=.8+.2*Math.cos(t*4);
      put('ParamRotation_leftElbow',6*e*pulse);put('ParamRotation_rightElbow',-6*e*pulse);
    }
    if(options.action==='knees'||options.action==='combined'){
      put('ParamRotation_leftKnee',4*e);put('ParamRotation_rightKnee',-4*e);
      put('ParamRotation_leftLeg',2*e);put('ParamRotation_rightLeg',-2*e);
    }
    if(options.action==='blink')for(const id of ['ParamEyeLOpen','ParamEyeROpen'])put(id,(parameters[id]?.default??1)*eyeOpen(t));
  }
  return values;
}
