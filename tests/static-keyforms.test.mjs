import test from 'node:test';
import assert from 'node:assert/strict';
import { XmlBuilder } from '../src/vendor/stretchystudio/io/live2d/xmlbuilder.js';
import { generateCmo3 } from '../src/vendor/stretchystudio/io/live2d/cmo3writer.js';

const walk = function* (n) { yield n; for (const c of n.children ?? []) yield* walk(c); };
const field = (n, name) => [...walk(n)].find(c => c.attrs?.['xs.n'] === name);

for (const generateRig of [false, true]) await test(`static mesh has no dummy opacity axis (rig=${generateRig})`, async t => {
  let objects, xml;
  const serialize = XmlBuilder.prototype.serialize;
  t.mock.method(XmlBuilder.prototype, 'serialize', function (...args) {
    objects = this._shared;
    xml = serialize.apply(this, args);
    return xml;
  });
  await generateCmo3({canvasW:100,canvasH:200,generateRig,generatePhysics:false,
    meshes:[{name:'accessory',tag:null,partId:'accessory',
      vertices:[10,10,20,10,20,20,10,20],triangles:[0,1,2,0,2,3],uvs:[0,0,1,0,1,1,0,1],
      pngData:new Uint8Array([137,80,78,71,13,10,26,10]),texWidth:100,texHeight:200}]});
  assert.ok(!xml.includes('ParamOpacity'));
  const ids=new Map(objects.map(n=>[n.attrs['xs.id'],n]));
  const mesh=objects.find(n=>n.tag==='CArtMeshSource');
  const grid=ids.get(field(mesh,'keyformGridSource').attrs['xs.ref']);
  assert.equal(field(grid,'keyformBindings').children.length,0);
  const cells=field(grid,'keyformsOnGrid').children;
  assert.equal(cells.length,1);
  assert.equal(field(cells[0],'_keyOnParameterList').children.length,0);
  assert.ok(ids.has(field(cells[0],'keyformGuid').attrs['xs.ref']));
  assert.equal(field(field(mesh,'keyforms').children[0],'opacity').text,'1.00');
  for (const node of objects) for (const ref of walk(node)) {
    if (ref.attrs['xs.ref']) assert.ok(ids.has(ref.attrs['xs.ref']), `dangling reference ${ref.attrs['xs.ref']}`);
  }
});
