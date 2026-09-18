/** Conforming subdivision of long sliver triangles before curved head warps.
 * UVs and source positions are interpolated, never regenerated. Shared edge
 * midpoints keep neighboring triangles watertight at every refinement step.
 */
const HEAD_TAGS = new Set([
  'face',
  'front hair',
  'back hair',
  'headwear',
  'ears',
  'ears-l',
  'ears-r',
  'nose',
  'mouth',
  'eyelash',
  'eyelash-l',
  'eyelash-r',
  'eyewhite',
  'eyewhite-l',
  'eyewhite-r',
  'irides',
  'irides-l',
  'irides-r',
  'eyebrow',
  'eyebrow-l',
  'eyebrow-r',
]);
export function refineHeadMesh(mesh, project = null) {
  if (!HEAD_TAGS.has(mesh.tag) || mesh.boneWeights?.length)
    return { mesh, mapping: null };
  const vertices = Array.from(mesh.vertices),
    uvs = Array.from(mesh.uvs),
    mapping = Array.from({ length: vertices.length / 2 }, (_, i) => ({
      [i]: 1,
    }));
  let triangles = Array.from(mesh.triangles);
  const key = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const edge = (a, b) =>
    (vertices[a * 2] - vertices[b * 2]) ** 2 +
    (vertices[a * 2 + 1] - vertices[b * 2 + 1]) ** 2;
  const xs = vertices.filter((_, i) => i % 2 === 0),
    ys = vertices.filter((_, i) => i % 2 === 1);
  // Scale with artwork; 0.5% of a part span, bounded away from numerical noise.
  const minEdge = Math.max(
    0.35,
    Math.max(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
    ) * 0.005,
  );
  for (let pass = 0; pass < 8; pass++) {
    const split = new Map();
    for (let i = 0; i < triangles.length; i += 3) {
      const [a, b, c] = triangles.slice(i, i + 3),
        ab = edge(a, b),
        bc = edge(b, c),
        ca = edge(c, a),
        max = Math.max(ab, bc, ca);
      const area = Math.abs(
        (vertices[b * 2] - vertices[a * 2]) *
          (vertices[c * 2 + 1] - vertices[a * 2 + 1]) -
          (vertices[b * 2 + 1] - vertices[a * 2 + 1]) *
            (vertices[c * 2] - vertices[a * 2]),
      );
      let risky = area / max < 0.035;
      if (risky && project) {
        const signed =
          (vertices[b * 2] - vertices[a * 2]) *
            (vertices[c * 2 + 1] - vertices[a * 2 + 1]) -
          (vertices[b * 2 + 1] - vertices[a * 2 + 1]) *
            (vertices[c * 2] - vertices[a * 2]);
        risky = false;
        for (const ax of [-30, -15, 0, 15, 30])
          for (const ay of [-30, -15, 0, 15, 30]) {
            const [A, B, C] = [a, b, c].map((i) =>
              project(vertices[i * 2], vertices[i * 2 + 1], ax, ay),
            );
            const changed =
              (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
            if (changed * Math.sign(signed) < area * 0.25) risky = true;
          }
      }
      if (max > minEdge * minEdge && risky) {
        const pair = max === ab ? [a, b] : max === bc ? [b, c] : [c, a];
        split.set(key(...pair), pair);
      }
    }
    if (!split.size) break;
    if (vertices.length / 2 + split.size > 10000)
      throw new Error(
        `Head mesh refinement exceeds vertex budget: ${mesh.name}`,
      );
    const mids = new Map();
    for (const [k, [a, b]] of split) {
      const n = vertices.length / 2;
      mids.set(k, n);
      vertices.push(
        (vertices[a * 2] + vertices[b * 2]) / 2,
        (vertices[a * 2 + 1] + vertices[b * 2 + 1]) / 2,
      );
      uvs.push(
        (uvs[a * 2] + uvs[b * 2]) / 2,
        (uvs[a * 2 + 1] + uvs[b * 2 + 1]) / 2,
      );
      const weights = {};
      for (const p of [a, b])
        for (const [j, w] of Object.entries(mapping[p]))
          weights[j] = (weights[j] || 0) + w / 2;
      mapping.push(weights);
    }
    const next = [];
    for (let i = 0; i < triangles.length; i += 3) {
      let [a, b, c] = triangles.slice(i, i + 3);
      let ab = mids.get(key(a, b)),
        bc = mids.get(key(b, c)),
        ca = mids.get(key(c, a));
      const count = [ab, bc, ca].filter((v) => v !== undefined).length;
      if (!count) {
        next.push(a, b, c);
        continue;
      }
      if (count === 3) {
        next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
        continue;
      }
      // Rotate until AB is split and CA is the uncut edge for a two-edge split.
      while (ab === undefined || (count === 2 && ca !== undefined)) {
        [a, b, c] = [b, c, a];
        [ab, bc, ca] = [bc, ca, ab];
      }
      if (count === 1) next.push(a, ab, c, ab, b, c);
      else next.push(b, bc, ab, a, ab, c, ab, bc, c);
    }
    triangles = next;
  }
  return { mesh: { ...mesh, vertices, uvs, triangles }, mapping };
}
