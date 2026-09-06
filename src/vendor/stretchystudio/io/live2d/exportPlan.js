/**
 * Canonical runtime export plan.
 *
 * This is the single source of truth for the IDs shared by MOC3, CDI3 and
 * motion3.  Source node UUIDs are deliberately not exposed to the runtime:
 * they are regenerated whenever a PSD is imported and made every action
 * curve silently miss its target.
 */

const slug = (value, fallback) => {
  const normalized = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
};

const makeIdFactory = () => {
  const counts = new Map();
  return (prefix, name) => {
    const base = `${prefix}_${slug(name, prefix)}`;
    const ordinal = counts.get(base) ?? 0;
    counts.set(base, ordinal + 1);
    return ordinal === 0 ? base : `${base}_${ordinal + 1}`;
  };
};

/**
 * @param {object} project
 * @returns {{parts: Array<object>, partIdByNodeId: Map<string, string>}}
 */
export function buildRuntimeExportPlan(project) {
  const nodes = project.nodes ?? [];
  const groups = nodes.filter((node) => node.type === 'group');
  const meshes = nodes.filter((node) => node.type === 'part' && node.mesh);
  const nextId = makeIdFactory();
  const partIdByNodeId = new Map();

  for (const group of groups)
    partIdByNodeId.set(group.id, nextId('PartGroup', group.name || group.id));
  for (const mesh of meshes)
    partIdByNodeId.set(mesh.id, nextId('Part', mesh.name || mesh.id));

  const parts = [
    ...groups.map((group) => ({
      id: partIdByNodeId.get(group.id),
      sourceId: group.id,
      name: group.name || group.id,
      parent: group.parent ? partIdByNodeId.get(group.parent) ?? null : null,
      // Structural groups should never suppress their children.
      visible: true,
    })),
    ...meshes.map((mesh) => ({
      id: partIdByNodeId.get(mesh.id),
      sourceId: mesh.id,
      name: mesh.name || mesh.id,
      parent: mesh.parent ? partIdByNodeId.get(mesh.parent) ?? null : null,
      // Alternate layers start hidden at the Part level. Their ArtMesh stays
      // enabled, so a PartOpacity motion curve can reveal it later.
      visible: mesh.visible !== false && (mesh.opacity ?? 1) > 0,
    })),
  ];

  return { parts, partIdByNodeId };
}
