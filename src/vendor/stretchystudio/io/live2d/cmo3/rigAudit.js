// Structural preflight of the exact XML objects about to be serialized.
// This is not a replacement for Cubism's evaluator or a visual acceptance test.
export function auditRigObjects(objects, parameters) {
  const byId = new Map(objects.map(n => [n.attrs['xs.id'], n]));
  const walk = function* (n) { yield n; for (const c of n.children ?? []) yield* walk(c); };
  const field = (n, name) => [...walk(n)].find(c => c.attrs?.['xs.n'] === name);
  const resolve = n => n?.attrs?.['xs.ref'] ? byId.get(n.attrs['xs.ref']) : n;
  const pids = new Map(parameters.map(p => [p.pid, p.id]));
  const sources = objects.filter(n => ['CArtMeshSource','CWarpDeformerSource','CRotationDeformerSource'].includes(n.tag));
  const entries = sources.map(n => {
    const grid = resolve(field(n, 'keyformGridSource'));
    const bindings = grid ? (field(grid, 'keyformBindings')?.children ?? []).map(resolve) : [];
    const controls = bindings.map(b => pids.get(field(b, 'parameterGuid')?.attrs['xs.ref'])).filter(Boolean);
    const forms = field(n, 'keyforms')?.children ?? [];
    const formsByGuid = new Map(forms.map(f => [field(f,'guid')?.attrs['xs.ref'], f]));
    const cells = field(grid ?? {}, 'keyformsOnGrid')?.children ?? [];
    // Inspect one dimension while holding all the others fixed. Merely seeing
    // opacity variation must not certify that an elbow actually deforms.
    const parameterVariation = Object.fromEntries(controls.map((control, axis) => {
      const slices = new Map();
      for (const cell of cells) {
        const coordinates = field(cell,'_keyOnParameterList')?.children ?? [];
        const slice = coordinates.filter((_, i) => i !== axis).map(k => field(k,'keyIndex')?.text).join(',');
        const form = formsByGuid.get(field(cell,'keyformGuid')?.attrs['xs.ref']);
        if (!form) continue;
        const values = slices.get(slice) ?? {geometry:new Set(),opacity:new Set()};
        values.geometry.add(JSON.stringify([field(form,'positions')?.text,form.attrs?.angle,form.attrs?.scale,form.attrs?.originX,form.attrs?.originY]));
        values.opacity.add(field(form,'opacity')?.text);
        slices.set(slice, values);
      }
      return [control, {geometry:[...slices.values()].some(s=>s.geometry.size>1),opacity:[...slices.values()].some(s=>s.opacity.size>1)}];
    }));
    const signatures = forms.map(f => JSON.stringify({
      positions:field(f,'positions')?.text,
      angle:f.attrs?.angle, scale:f.attrs?.scale, originX:f.attrs?.originX, originY:f.attrs?.originY,
      opacity:field(f,'opacity')?.text,
    }));
    return { name:field(n,'localName')?.text, kind:n.tag,
      guid:field(n,'guid')?.attrs['xs.ref'], target:field(n,'targetDeformerGuid')?.attrs['xs.ref'],
      parameters:controls, parameterVariation, keyforms:forms.length, hasVariation:new Set(signatures).size > 1 };
  });
  const byGuid = new Map(entries.filter(e=>e.guid).map(e=>[e.guid,e]));
  const used = new Set(), errors = [];
  for (const e of entries.filter(e=>e.kind==='CArtMeshSource')) {
    const seen = new Set(); let cursor = e;
    while (cursor) {
      if (seen.has(cursor)) { errors.push(`Deformer cycle: ${e.name}`); break; }
      seen.add(cursor); used.add(cursor); cursor = byGuid.get(cursor.target);
    }
  }
  const summary = parameters.map(p => {
    const bindings = entries.filter(e=>e.parameters.includes(p.id));
    const targets = bindings.filter(e=>used.has(e) && (e.parameterVariation[p.id]?.geometry || e.parameterVariation[p.id]?.opacity));
    return { id:p.id, bindingCount:bindings.length, effectiveTargets:targets.map(e=>e.name),
      status:targets.length ? 'structural-variation' : bindings.length ? 'no-effective-target' : 'unbound' };
  });
  const meshes = entries.filter(e=>e.kind==='CArtMeshSource').map(e=>{
    const chain=[];let c=byGuid.get(e.target);const seen=new Set();
    while(c&&!seen.has(c)){seen.add(c);chain.push(c.name);c=byGuid.get(c.target);}
    return { name:e.name, parameters:e.parameters, parameterVariation:e.parameterVariation, hasVariation:e.hasVariation, chain };
  });
  return { version:2, scope:'Structural reachability and per-axis keyform variation; not native evaluation', errors, parameters:summary, meshes };
}
