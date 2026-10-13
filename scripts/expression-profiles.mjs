// Reused unchanged from the existing batch expression system. These are
// starting values, not newly generated mouth artwork or proof of binding.
export const expressionProfiles = {
 Smile:{ParamMouthForm:.7,ParamMouthOpenY:.08,ParamEyeLOpen:.9,ParamEyeROpen:.9,ParamBrowLY:.12,ParamBrowRY:.12},
 Laugh:{ParamMouthForm:.85,ParamMouthOpenY:.35,ParamEyeLOpen:.65,ParamEyeROpen:.65,ParamBrowLY:.15,ParamBrowRY:.15},
 Shy:{ParamMouthForm:.35,ParamMouthOpenY:.04,ParamEyeLOpen:.82,ParamEyeROpen:.82,ParamBrowLY:.15,ParamBrowRY:.15,ParamBlush:.45},
 Surprised:{ParamMouthForm:0,ParamMouthOpenY:.45,ParamEyeLOpen:1,ParamEyeROpen:1,ParamBrowLY:.55,ParamBrowRY:.55},
 Angry:{ParamMouthForm:-.45,ParamMouthOpenY:.05,ParamEyeLOpen:.85,ParamEyeROpen:.85,ParamBrowLY:-.45,ParamBrowRY:-.45},
 Sad:{ParamMouthForm:-.5,ParamMouthOpenY:0,ParamEyeLOpen:.85,ParamEyeROpen:.85,ParamBrowLY:.25,ParamBrowRY:.25},
};
export const faceParameterIds = [...new Set([...Object.values(expressionProfiles).flatMap(p=>Object.keys(p)), 'ParamEyeBallX', 'ParamEyeBallY'])];
export const expressionPresetSystem = 'batch-expression-profiles-v1';

// Keep the existing per-character enabled/profiles format. Treat profile
// files as data: neither arm/pose changes nor script execution are permitted.
export function resolveExpressionProfiles(config = {}) {
 const object = value => value && typeof value === 'object' && !Array.isArray(value);
 if (!object(config)) throw Error('Invalid expression profile');
 const names = Object.keys(expressionProfiles);
 if (config.enabled !== undefined && (!Array.isArray(config.enabled) || config.enabled.some(name=>!names.includes(name))))
  throw Error('Invalid enabled expressions');
 if (config.profiles !== undefined && !object(config.profiles)) throw Error('Invalid expression overrides');
 for (const [name,values] of Object.entries(config.profiles ?? {})) {
  if (!names.includes(name) || !object(values)) throw Error('Invalid expression override '+name);
  for (const [id,value] of Object.entries(values)) {
   if (!faceParameterIds.includes(id)) throw Error('Non-facial expression override '+id);
   if (!Number.isFinite(value)) throw Error('Invalid expression value '+id);
  }
 }
 return Object.entries(expressionProfiles).filter(([name])=>config.enabled === undefined || config.enabled.includes(name))
  .map(([name,values])=>[name,{...values,...(config.profiles?.[name] ?? {})}]);
}

export function boundExpressionValues(values, parameters) {
 const missing = Object.keys(values).filter(id=>!parameters.ids.includes(id));
 const bounded = Object.fromEntries(Object.entries(values).filter(([id])=>parameters.ids.includes(id)).map(([id,value])=>{
  const i=parameters.ids.indexOf(id);
  return [id,Math.min(parameters.maximumValues[i],Math.max(parameters.minimumValues[i],value))];
 }));
 return {missing,values:bounded};
}
