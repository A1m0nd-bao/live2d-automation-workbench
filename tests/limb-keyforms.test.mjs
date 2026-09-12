import test from 'node:test';
import assert from 'node:assert/strict';
import { XmlBuilder } from '../src/vendor/stretchystudio/io/live2d/xmlbuilder.js';
import { emitLimbGrid } from '../src/vendor/stretchystudio/io/live2d/cmo3/limbKeyforms.js';
import { bindLimbMesh } from '../src/autoRigPreflight.js';

function fixture(action) {
  const x = new XmlBuilder();
  const [grid, gridPid] = x.shared('KeyformGridSource');
  const [binding, bindingPid] = x.shared('KeyformBindingSource');
  const angles = [-7, -3.5, 0, 3.5, 7];
  const forms = emitLimbGrid(x, {grid, gridPid, binding, bindingPid,
    bone:{pidParam:'#elbow',paramId:'ParamElbow'}, angles,
    action, actionPid:'#action',restForm:'#rest',name:'arm'});
  return {grid, forms, angles};
}
const child = (node, name) => node.children.find(c => c.attrs['xs.n'] === name);

for (const state of ['base', 'alternate']) await test(`${state}: full action × elbow grid, no overwritten dimension`, () => {
  const {grid, forms, angles} = fixture({id:'ParamActionWave',state});
  assert.equal(child(grid,'keyformBindings').children.length,2);
  assert.equal(forms.length,20);
  assert.equal(new Set(forms.map(f=>f.pid)).size,20);
  const cells = child(grid,'keyformsOnGrid').children;
  const coordinates = cells.map(cell => child(child(cell,'accessKey'),'_keyOnParameterList').children.map(k=>Number(child(k,'keyIndex').text)));
  assert.equal(new Set(coordinates.map(c=>c.join(','))).size,20);
  for(let a=0;a<4;a++) {
    assert.deepEqual(forms.slice(a*5,a*5+5).map(f=>f.angle),angles);
    const opacity = state === 'base' ? (a<2?1:0) : (a<2?0:1);
    assert.ok(forms.slice(a*5,a*5+5).every(f=>f.opacity===opacity));
  }
});

await test('non-action limb retains a one-axis five-key grid',()=>{
  const {grid,forms}=fixture(null);
  assert.equal(child(grid,'keyformBindings').children.length,1);
  assert.equal(forms.length,5);
  assert.ok(forms.every(f=>f.opacity===1));
});

await test('shoe and leg have identical spatial weights and knee pivots at their overlap',()=>{
  const skeleton={lKnee:{x:100,y:100},lAnkle:{x:100,y:300}};
  const groups=[{id:'knee',boneRole:'leftKnee'}];
  const overlap=[{x:93,y:260},{x:107,y:300},{x:110,y:325}];
  const leg={vertices:[{x:100,y:20},{x:100,y:100},...overlap]};
  const shoe={vertices:overlap};
  bindLimbMesh(leg,'legwear-l',skeleton,groups);
  bindLimbMesh(shoe,'footwear-l',skeleton,groups);
  assert.equal(shoe.jointBoneId,leg.jointBoneId);
  assert.deepEqual(shoe.jointPivot,leg.jointPivot);
  assert.deepEqual(shoe.boneWeights,leg.boneWeights.slice(2));
  assert.ok(shoe.boneWeights.every(w=>w===1));
});
