/** Character-normalized head surface. Evaluated at authoring time only. */
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smooth = (x) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};
function bounds(meshes) {
  const points = meshes.flatMap((m) => Array.from(m.vertices || []));
  if (!points.length) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    x0 = Math.min(x0, points[i]);
    x1 = Math.max(x1, points[i]);
    y0 = Math.min(y0, points[i + 1]);
    y1 = Math.max(y1, points[i + 1]);
  }
  return x1 > x0 && y1 > y0 ? { minX: x0, maxX: x1, minY: y0, maxY: y1 } : null;
}
export function createHeadVolume({ faceMeshBbox, faceUnionBbox, meshes = [] }) {
  const box = faceMeshBbox || faceUnionBbox;
  const cx = (box.minX + box.maxX) / 2,
    cy = (box.minY + box.maxY) / 2;
  const rx = Math.max(1, (box.maxX - box.minX) / 2),
    ry = Math.max(1, (box.maxY - box.minY) / 2);
  const nose = bounds(meshes.filter((m) => m.tag === 'nose'));
  const nu = nose ? ((nose.minX + nose.maxX) / 2 - cx) / rx : 0;
  const nv = nose ? ((nose.minY + nose.maxY) / 2 - cy) / ry : 0.12;
  const regions = [];
  for (const [tags, protection] of [
    [['eyelash-l', 'eyewhite-l', 'irides-l'], 0.8],
    [['eyelash-r', 'eyewhite-r', 'irides-r'], 0.8],
    [['eyelash', 'eyewhite', 'irides'], 0.8],
    [['mouth'], 0.35],
    [['eyebrow-l'], 0.35],
    [['eyebrow-r'], 0.35],
  ]) {
    const b = bounds(meshes.filter((m) => tags.includes(m.tag)));
    if (!b) continue;
    regions.push({
      x: (b.minX + b.maxX) / 2,
      y: (b.minY + b.maxY) / 2,
      hx: Math.max(rx * 0.06, (b.maxX - b.minX) / 2),
      hy: Math.max(ry * 0.045, (b.maxY - b.minY) / 2),
      protection,
      tags,
    });
  }
  function depth(x, y, surface = 'face') {
    const u = (x - cx) / rx,
      v = (y - cy) / ry;
    if (surface === 'front')
      return rx * 0.95 * Math.exp(-0.16 * u * u - 0.1 * v * v);
    if (surface === 'back')
      return rx * 0.5 * Math.exp(-0.16 * u * u - 0.1 * v * v);
    const dome =
      rx * 0.82 * Math.sqrt(Math.max(0.08, 1 - 0.58 * u * u - 0.24 * v * v));
    const noseLift =
      rx * 0.12 * Math.exp(-(((u - nu) / 0.22) ** 2 + ((v - nv) / 0.25) ** 2));
    return dome + noseLift;
  }
  function rotate(x, y, z, ax, ay) {
    // Keep the legacy angular envelope so a volume comparison does not just
    // reward larger motion. Camera distance scales with the character.
    const yaw = ((clamp(ax, -30, 30) / 30) * 15 * Math.PI) / 180;
    const pitch = ((clamp(ay, -30, 30) / 30) * 8 * Math.PI) / 180;
    const X = (x - cx) * Math.cos(yaw) + z * Math.sin(yaw);
    const Z = -(x - cx) * Math.sin(yaw) + z * Math.cos(yaw);
    const pivot = cy + ry * 0.55,
      Y = y - pivot;
    const Yp = Y * Math.cos(pitch) - Z * Math.sin(pitch);
    const Zp = Y * Math.sin(pitch) + Z * Math.cos(pitch);
    // Rest-calibrated pinhole scale: exact identity at neutral.
    const camera = rx * 8;
    const scale = (camera - z) / (camera - Zp);
    return [cx + X * scale, pivot + Yp * scale];
  }
  function project(x, y, ax, ay, surface = 'face') {
    if (!ax && !ay) return [x, y];
    const z = depth(x, y, surface);
    let [X, Y] = rotate(x, y, z, ax, ay);
    if (surface === 'face') {
      let sum = 0,
        dx = 0,
        dy = 0;
      for (const r of regions) {
        const ux = Math.max(0, Math.abs(x - r.x) - r.hx) / (rx * 0.18);
        const vy = Math.max(0, Math.abs(y - r.y) - r.hy) / (ry * 0.12);
        const w = r.protection * (1 - smooth(Math.max(ux, vy)));
        if (!w) continue;
        // A feature is a small tangent-plane patch, not a rigid translation:
        // all eye sublayers share it, retaining foreshortening and perspective.
        const [px, py] = rotate(x, y, depth(r.x, r.y), ax, ay);
        dx += w * (px - X);
        dy += w * (py - Y);
        sum += w;
      }
      if (sum) {
        const norm = Math.max(1, sum);
        X += dx / norm;
        Y += dy / norm;
      }
    }
    const v = (y - cy) / ry;
    const anchor = 1 - smooth((v - 0.85) / (surface === 'face' ? 0.8 : 2.0));
    // Outside the head union, smoothly approach identity rather than extrapolate.
    const lateral = 1 - smooth((Math.abs((x - cx) / rx) - 1.5) / 1.5);
    return [x + (X - x) * anchor * lateral, y + (Y - y) * anchor * lateral];
  }
  return {
    project,
    depth,
    profile: {
      algorithm: 'head-volume-v2',
      center: [cx, cy],
      radius: [rx, ry],
      nose: [nu, nv],
      yawDegrees: 15,
      pitchDegrees: 8,
      cameraRadiusRatio: 8,
      regions,
    },
  };
}
