import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeadVolume } from '../src/vendor/stretchystudio/io/live2d/cmo3/headVolume.js';
const settings = {
  faceMeshBbox: { minX: 100, maxX: 300, minY: 60, maxY: 300 },
  faceUnionBbox: { minX: 40, maxX: 360, minY: 0, maxY: 500, W: 320, H: 500 },
  meshes: [],
};
const v = createHeadVolume(settings);
await test('neutral is exact for face and separate hair surfaces; neck stays anchored', () => {
  for (const s of ['face', 'front', 'back'])
    for (const [x, y] of [
      [40, 0],
      [200, 180],
      [160, 280],
      [250, 500],
    ])
      assert.deepEqual(v.project(x, y, 0, 0, s), [x, y]);
  for (const a of [-30, 30])
    assert.deepEqual(v.project(200, 500, a, a), [200, 500]);
});
await test('volume varies vertically, has nose prominence and separates hair depth', () => {
  assert.ok(v.depth(200, 180) > v.depth(200, 280));
  assert.ok(v.depth(200, 194) > v.depth(222, 194));
  assert.ok(
    v.project(200, 100, 30, 0, 'front')[0] >
      v.project(200, 100, 30, 0, 'back')[0],
  );
});
await test('analytic head grid triangles stay oriented across sampled angles', () => {
  const area = (a, b, c) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (const s of ['face', 'front', 'back'])
    for (const x of [-30, -15, 0, 15, 30])
      for (const y of [-30, -15, 0, 15, 30]) {
        const p = [];
        for (let r = 0; r < 11; r++)
          for (let c = 0; c < 11; c++)
            p.push(v.project(40 + c * 32, r * 50, x, y, s));
        for (let r = 0; r < 10; r++)
          for (let c = 0; c < 10; c++) {
            const i = r * 11 + c;
            assert.ok(area(p[i], p[i + 1], p[i + 11]) > 0);
            assert.ok(area(p[i + 1], p[i + 12], p[i + 11]) > 0);
          }
      }
});
await test('character scale and translation do not change normalized movement', () => {
  const shift = (b) => ({
    minX: b.minX * 2 + 50,
    maxX: b.maxX * 2 + 50,
    minY: b.minY * 2 + 70,
    maxY: b.maxY * 2 + 70,
    W: b.W * 2,
    H: b.H * 2,
  });
  const w = createHeadVolume({
    faceMeshBbox: shift(settings.faceMeshBbox),
    faceUnionBbox: shift(settings.faceUnionBbox),
  });
  for (const s of ['face', 'front', 'back']) {
    const a = v.project(180, 170, 30, -30, s),
      b = w.project(410, 410, 30, -30, s);
    assert.ok(Math.abs(b[0] - (a[0] * 2 + 50)) < 1e-8);
    assert.ok(Math.abs(b[1] - (a[1] * 2 + 70)) < 1e-8);
  }
});
const { refineHeadMesh } =
  await import('../src/vendor/stretchystudio/io/live2d/cmo3/headMeshRefine.js');
await test('head subdivision preserves UVs, area and winding across shared edges', () => {
  const mesh = {
    tag: 'face',
    name: 'slivers',
    vertices: [0, 0, 40, 0, 39, 0.1, 0, 20],
    uvs: [0, 0, 1, 0, 0.975, 0.005, 0, 1],
    triangles: [0, 1, 2, 0, 2, 3],
  };
  const { mesh: r, mapping } = refineHeadMesh(mesh);
  assert.ok(r.vertices.length > mesh.vertices.length);
  for (let i = 0; i < mapping.length; i++)
    for (let a = 0; a < 2; a++) {
      const interpolate = (src) =>
        Object.entries(mapping[i]).reduce(
          (s, [j, w]) => s + src[Number(j) * 2 + a] * w,
          0,
        );
      assert.ok(
        Math.abs(r.vertices[i * 2 + a] - interpolate(mesh.vertices)) < 1e-8,
      );
      assert.ok(Math.abs(r.uvs[i * 2 + a] - interpolate(mesh.uvs)) < 1e-8);
    }
  let area = 0;
  const edges = new Map();
  for (let i = 0; i < r.triangles.length; i += 3) {
    const [a, b, c] = r.triangles.slice(i, i + 3),
      p = r.vertices;
    const x =
      (p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) -
      (p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[a * 2]);
    assert.ok(x > 0);
    area += x / 2;
    for (const [e, f] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = [e, f].sort((a, b) => a - b).join(':');
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  assert.ok(Math.abs(area - 392) < 1e-8);
  assert.ok([...edges.values()].every((n) => n === 1 || n === 2));
  assert.equal(
    refineHeadMesh({ ...mesh, tag: 'topwear' }).mesh.vertices,
    mesh.vertices,
  );
});

await test('volume is opt-in and emits independent hair parents without changing the source mesh', async () => {
  const { generateCmo3 } = await import('../src/vendor/stretchystudio/io/live2d/cmo3writer.js');
  const meshes = ['face', 'front hair', 'back hair'].map((tag,i)=>({
    tag,name:tag,partId:`head${i}`,vertices:[100,60,300,60,300,300,100,300],
    triangles:[0,1,2,0,2,3],uvs:[0,0,1,0,1,1,0,1],
    pngData:new Uint8Array([137,80,78,71,13,10,26,10]),texWidth:400,texHeight:600,
  }));
  const before=structuredClone(meshes);
  const base={canvasW:400,canvasH:600,meshes,generateRig:true,generatePhysics:false};
  const old=await generateCmo3(base);
  const next=await generateCmo3({...base,headVolume:'volume-v2'});
  assert.match(old.rigDebugLog.faceParallax.algorithm,/cylindrical/);
  assert.equal(next.rigDebugLog.faceParallax.algorithm,'head-volume-v2');
  const audit=next.rigDebugLog.bindingAudit.meshes;
  assert.ok(audit.find(m=>m.name==='front hair').chain.includes('HeadVolumeFront'));
  assert.ok(audit.find(m=>m.name==='back hair').chain.includes('HeadVolumeBack'));
  assert.ok(audit.find(m=>m.name==='face').chain.includes('FaceParallax'));
  assert.deepEqual(meshes,before);
  await assert.rejects(generateCmo3({...base,headVolume:'typo'}),/Unsupported headVolume/);
});
