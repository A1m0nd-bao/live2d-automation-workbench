import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCmo3 } from '../src/vendor/stretchystudio/io/live2d/cmo3writer.js';

const pngHeader = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

test('CMO3 writer emits a bounded three-state knee flex control', async () => {
  const bend = {
    tag: 'legwear-l', id: 'ParamLegLBend', name: 'Leg L Bend',
    pivot: { x: 35, y: 100 }, endpoint: { x: 35, y: 180 }, maxAngle: 5,
  };
  const { cmo3 } = await generateCmo3({
    canvasW: 100,
    canvasH: 200,
    generateRig: true,
    limbBends: [bend],
    meshes: [{
      name: 'legwear-l', tag: 'legwear-l', partId: 'leg',
      parentGroupId: null, drawOrder: 1,
      vertices: [20, 60, 50, 60, 50, 190, 20, 190],
      triangles: [0, 1, 2, 0, 2, 3],
      uvs: [0.2, 0.3, 0.5, 0.3, 0.5, 0.95, 0.2, 0.95],
      pngData: pngHeader, texWidth: 100, texHeight: 200,
      limbBend: bend,
    }],
  });

  assert.deepEqual([...cmo3.slice(0, 4)], [67, 65, 70, 70]);
  assert.ok(cmo3.length > 1000);
});
