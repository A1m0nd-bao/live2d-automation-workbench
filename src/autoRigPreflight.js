// Pure PSD preflight: preserve source files, clean only the working raster.
// Keep soft edges within 3px of substantial alpha, not a full-canvas haze.
export function cleanRigLayer(layer, { seedAlpha = 32, edgeRadius = 3 } = {}) {
  const { width: w, height: h, data } = layer.imageData;
  let maxAlpha = 0, beforeMass = 0, beforePixels = 0, visibleMass = 0;
  for (let i = 3; i < data.length; i += 4) {
    maxAlpha = Math.max(maxAlpha, data[i]); beforeMass += data[i];
    if (data[i]) beforePixels++;
    if (data[i] > 8) visibleMass += data[i];
  }
  if (!maxAlpha) throw Error(`${layer.name} 没有有效像素`);
  const threshold = Math.min(seedAlpha, Math.max(1, Math.ceil(maxAlpha * 0.5)));
  const seeds = new Uint8Array(w * h), seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  for (let i = 0; i < seeds.length; i++) seeds[i] = data[i*4+3] >= threshold ? 1 : 0;
  // Tiny corner specks occur even above the seed threshold in See-Through.
  // Reject only <=2px seed components at the crop edge; keep detached interior
  // details and every substantial component, including separated halo strokes.
  let rejectedBorderSeeds = 0;
  for (let i=0;i<seeds.length;i++) {
    if (!seeds[i] || seen[i]) continue;
    let head=0,tail=1;queue[0]=i;seen[i]=1;
    while(head<tail){
      const p=queue[head++],x=p%w,y=Math.floor(p/w);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const nx=x+dx,ny=y+dy;if(nx<0||nx>=w||ny<0||ny>=h)continue;
        const q=ny*w+nx;if(seeds[q]&&!seen[q]){seen[q]=1;queue[tail++]=q;}
      }
    }
    if(tail<=2 && tail<beforePixels/10 && Array.from(queue.subarray(0,tail)).every(p=>{
      const x=p%w,y=Math.floor(p/w);return x<3||y<3||x>=w-3||y>=h-3;
    }))for(let j=0;j<tail;j++){seeds[queue[j]]=0;rejectedBorderSeeds++;}
  }
  // Separable dilation is linear in image size and preserves detached strong
  // features (halo, hair wisps, dots); never keep only the largest component.
  const horizontal = new Uint8Array(w * h), support = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    for (let x = 0; x < w; x++) {
      if (seeds[y * w + x]) last = x;
      if (x - last <= edgeRadius) horizontal[y * w + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (seeds[y * w + x]) last = x;
      if (last - x <= edgeRadius) horizontal[y * w + x] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (horizontal[y * w + x]) last = y;
      if (y - last <= edgeRadius) support[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (horizontal[y * w + x]) last = y;
      if (last - y <= edgeRadius) support[y * w + x] = 1;
    }
  }
  let minX = w, minY = h, maxX = -1, maxY = -1, removedPixels = 0, removedMass = 0, visibleRemovedMass = 0;
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3];
    if (!a) continue;
    if (!support[i]) {
      removedPixels++; removedMass += a;
      const x=i%w,y=Math.floor(i/w);
      const sparseEdgeResidue = a <= 64 && (x<3||y<3||x>=w-3||y>=h-3);
      if (a > 8 && !sparseEdgeResidue) visibleRemovedMass += a;
      continue;
    }
    const x = i % w, y = Math.floor(i / w);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (maxX < minX) throw Error(`${layer.name} 清理后没有有效区域`);
  // Large changes need a person to distinguish noise from intentional translucency.
  // A million alpha=1 background pixels must not outweigh a small real mouth.
  // Guard visible (>8/255) artwork separately from quantified near-zero haze.
  if (visibleRemovedMass / Math.max(1, visibleMass) > 0.15)
    throw Error(`${layer.name} 清理将影响超过 15% 的可见 Alpha 总量，需核查原图层，未自动删除`);
  const width = maxX - minX + 1, height = maxY - minY + 1;
  const cropped = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y + minY) * w + x + minX, j = (y * width + x) * 4;
    if (support[i]) cropped.set(data.subarray(i * 4, i * 4 + 4), j);
  }
  const imageData = typeof ImageData === 'function'
    ? new ImageData(cropped, width, height) : { data: cropped, width, height };
  const cleaned = { ...layer, x: (layer.x ?? 0) + minX, y: (layer.y ?? 0) + minY, width, height, imageData };
  return { layer: cleaned, audit: { name: layer.name, threshold, edgeRadius,
    beforePixels, removedPixels, rejectedBorderSeeds, removedAlphaFraction: removedMass / beforeMass,
    visibleRemovedFraction: visibleRemovedMass / Math.max(1, visibleMass),
    bounds: { x: cleaned.x, y: cleaned.y, width, height }, translucent: maxAlpha < seedAlpha } };
}

const boxDistance = (p, l) => {
  if (!p || !l) return Infinity;
  return Math.hypot(Math.max(l.x - p.x, 0, p.x - l.x - l.width), Math.max(l.y - p.y, 0, p.y - l.y - l.height));
};
const valid = (p, w, h) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h;

export function calibratePose(bounds, detected, layers, w, h) {
  const skeleton = { ...bounds }, decisions = [];
  const byName = new Map(layers.map(l => [l.name.toLowerCase().trim(), l]));
  for (const [name, p] of Object.entries(detected ?? {})) if (valid(p, w, h)) skeleton[name] = p;
  // Left/right is a producer convention. Choose the joint chain spatially,
  // then require elbow/wrist to actually lie near that layer. Never rename art.
  for (const [base, joints] of [['handwear', ['Shoulder', 'Elbow', 'Wrist']], ['legwear', ['Hip', 'Knee', 'Ankle']]]) {
    const left = byName.get(base + '-l'), right = byName.get(base + '-r');
    if (!left && !right) continue;
    const score = (flip) => {
      let value = 0, count = 0;
      for (const [side, l] of [['l', left], ['r', right]]) if (l) {
        const from = flip ? (side === 'l' ? 'r' : 'l') : side;
        for (const joint of joints.slice(1)) {
          const p = detected?.[from + joint];
          if (!valid(p, w, h)) return Infinity;
          value += boxDistance(p, l); count++;
        }
      }
      return count ? value / count : Infinity;
    };
    const direct = score(false), swapped = score(true), flip = swapped + 1 < direct;
    for (const [side, l] of [['l', left], ['r', right]]) if (l) {
      const from = flip ? (side === 'l' ? 'r' : 'l') : side;
      const tolerance = Math.max(6, Math.hypot(l.width, l.height) * 0.12);
      const accepted = joints.slice(1).every(j => valid(detected?.[from+j], w, h) && boxDistance(detected[from+j], l) <= tolerance);
      for (const j of joints) skeleton[side+j] = accepted && valid(detected?.[from+j], w, h) ? detected[from+j] : bounds[side+j];
      decisions.push({ layer: l.name, sourceSide: accepted ? from : null, swapped: accepted && flip,
        method: accepted ? 'spatial-dwpose' : 'clean-bounds-fallback', directScore: direct, swappedScore: swapped });
    }
  }
  // Visible face/eye/neck layers are more authoritative than guessed human
  // keypoints, especially for anime eyes. Use the same anchor for CMO export.
  const face = byName.get('face'), neck = byName.get('neck');
  if (face) {
    const chin = face.y + face.height;
    const neckBottom = neck ? neck.y + neck.height : chin;
    const y = neck && neckBottom >= chin - face.height * 0.3 && neckBottom <= chin + face.height * 0.6 ? neckBottom : chin;
    skeleton.headBase = { x: neck ? neck.x + neck.width / 2 : face.x + face.width / 2, y };
    // Reject corrupt full-canvas face bounds; don't pass a bad anchor onward.
    if (face.height > h * 0.6 || face.width > w * 0.75 || !valid(skeleton.headBase,w,h))
      throw Error('脸部有效边界异常，已拦截头部绑定；请检查 face 图层');
  }
  for (const side of ['l','r']) {
    const eye = byName.get('irides-'+side) ?? byName.get('eyewhite-'+side);
    if (eye) skeleton[side+'Eye'] = { x: eye.x + eye.width / 2, y: eye.y + eye.height / 2 };
  }
  if (skeleton.lEye && skeleton.rEye) skeleton.midEye = { x:(skeleton.lEye.x+skeleton.rEye.x)/2, y:(skeleton.lEye.y+skeleton.rEye.y)/2 };
  if (neck) skeleton.neck = { x:neck.x+neck.width/2, y:neck.y+neck.height };
  return { skeleton, decisions };
}

export function assertRigMesh(mesh, layer, w, h) {
  if (!mesh.triangles.length) throw Error(`${layer.name} 无有效网格`);
  for (const v of mesh.vertices) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || v.x < 0 || v.y < 0 || v.x > w || v.y > h ||
        v.x < layer.x - 3 || v.y < layer.y - 3 || v.x > layer.x + layer.width + 3 || v.y > layer.y + layer.height + 3)
      throw Error(`${layer.name} 网格越出有效区域，已阻止导出`);
  }
}

export function limbWeights(vertices, pivot, endpoint) {
  const dx = endpoint.x - pivot.x, dy = endpoint.y - pivot.y;
  const length2 = dx * dx + dy * dy;
  if (length2 < 4) throw Error('肢体关节点重合，无法生成权重');
  return vertices.map(v => {
    const t = Math.max(0, Math.min(1, ((v.x - pivot.x) * dx + (v.y - pivot.y) * dy) / length2));
    return t * t * (3 - 2 * t);
  });
}
