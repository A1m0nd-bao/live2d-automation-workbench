import test from 'node:test';
import assert from 'node:assert/strict';
import {expressionProfiles,faceParameterIds,resolveExpressionProfiles,boundExpressionValues} from '../scripts/expression-profiles.mjs';

test('reuse the six existing batch expression presets without changing values',()=>{
 assert.deepEqual(Object.keys(expressionProfiles),['Smile','Laugh','Shy','Surprised','Angry','Sad']);
 assert.deepEqual(expressionProfiles.Smile,{ParamMouthForm:.7,ParamMouthOpenY:.08,ParamEyeLOpen:.9,ParamEyeROpen:.9,ParamBrowLY:.12,ParamBrowRY:.12});
 assert.equal(expressionProfiles.Shy.ParamBlush,.45);
 assert.deepEqual(resolveExpressionProfiles(),Object.entries(expressionProfiles));
 assert.ok(faceParameterIds.includes('ParamEyeBallX'));
});
test('preserve per-character overrides and explicit disabling without mutating shared presets',()=>{
 assert.deepEqual(resolveExpressionProfiles({enabled:[]}),[]);
 const entries=resolveExpressionProfiles({enabled:['Smile'],profiles:{Smile:{ParamEyeBallX:.2,ParamMouthForm:.5}},character:'source'});
 assert.equal(entries.length,1);assert.equal(entries[0][1].ParamMouthForm,.5);assert.equal(entries[0][1].ParamEyeBallX,.2);
 assert.equal(expressionProfiles.Smile.ParamMouthForm,.7);
});
test('reject unknown presets, nonfacial overrides and nonfinite values',()=>{
 for(const config of [{enabled:'Smile'},{enabled:['NewSmile']},{profiles:{Unknown:{}}},{profiles:{Smile:{ParamActionPose:1}}},{profiles:{Smile:{ParamAngleX:20}}},{profiles:{Smile:{ParamMouthForm:NaN}}},{profiles:[]}])
  assert.throws(()=>resolveExpressionProfiles(config));
});
test('clamp to actual model ranges while exposing missing bindings',()=>{
 assert.deepEqual(boundExpressionValues({ParamMouthForm:.7,ParamBlush:.45},{ids:['ParamMouthForm'],minimumValues:[-.3],maximumValues:[.3]}),
  {values:{ParamMouthForm:.3},missing:['ParamBlush']});
});
