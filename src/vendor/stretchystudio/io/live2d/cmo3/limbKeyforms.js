import { uuid } from '../xmlbuilder.js';

// A drawable can vary geometry and opacity independently. Every combination
// must exist in Cubism's keyform grid, including the invisible bent states.
export function emitLimbGrid(x, { grid, gridPid, binding, bindingPid, bone, angles,
  action, actionPid, restForm, name }) {
  const actionKeys = !action ? [0] : Array.isArray(action.stateOpacities)
    ? action.stateOpacities.map((_, i) => i)
    : [0, action.transitionStart ?? 0.35, action.transitionEnd ?? 0.65, 1];
  const opacities = !action ? [1] : Array.isArray(action.stateOpacities)
    ? action.stateOpacities
    : action.state === 'alternate' ? [0, 0, 1, 1] : [1, 1, 0, 0];
  const dimensions = [{ node: binding, pid: bindingPid, param: bone.pidParam, id: bone.paramId, keys: angles }];
  if (action) {
    const [node, pid] = x.shared('KeyformBindingSource');
    dimensions.push({ node, pid, param: actionPid, id: action.id, keys: actionKeys });
  }
  const bindings = x.sub(grid, 'array_list', { 'xs.n': 'keyformBindings', count: String(dimensions.length) });
  for (const d of dimensions) {
    x.subRef(bindings, 'KeyformBindingSource', d.pid);
    x.subRef(d.node, 'KeyformGridSource', gridPid, { 'xs.n': '_gridSource' });
    x.subRef(d.node, 'CParameterGuid', d.param, { 'xs.n': 'parameterGuid' });
    const keys = x.sub(d.node, 'array_list', { 'xs.n': 'keys', count: String(d.keys.length) });
    for (const value of d.keys) x.sub(keys, 'f').text = String(value);
    x.sub(d.node, 'InterpolationType', { 'xs.n': 'interpolationType', v: 'LINEAR' });
    x.sub(d.node, 'ExtendedInterpolationType', { 'xs.n': 'extendedInterpolationType', v: 'LINEAR' });
    x.sub(d.node, 'i', { 'xs.n': 'insertPointCount' }).text = '1';
    x.sub(d.node, 'f', { 'xs.n': 'extendedInterpolationScale' }).text = '1.0';
    x.sub(d.node, 's', { 'xs.n': 'description' }).text = d.id;
  }
  const forms = [];
  const cells = x.sub(grid, 'array_list', { 'xs.n': 'keyformsOnGrid', count: String(angles.length * actionKeys.length) });
  for (let a = 0; a < actionKeys.length; a++) for (let b = 0; b < angles.length; b++) {
    const pid = a === 0 && angles[b] === 0 ? restForm
      : x.shared('CFormGuid', { uuid: uuid(), note: `${name}_action${a}_bend${b}` })[1];
    const cell = x.sub(cells, 'KeyformOnGrid');
    const access = x.sub(cell, 'KeyformGridAccessKey', { 'xs.n': 'accessKey' });
    const keys = x.sub(access, 'array_list', { 'xs.n': '_keyOnParameterList', count: String(dimensions.length) });
    dimensions.forEach((d, i) => {
      const key = x.sub(keys, 'KeyOnParameter');
      x.subRef(key, 'KeyformBindingSource', d.pid, { 'xs.n': 'binding' });
      x.sub(key, 'i', { 'xs.n': 'keyIndex' }).text = String(i === 0 ? b : a);
    });
    x.subRef(cell, 'CFormGuid', pid, { 'xs.n': 'keyformGuid' });
    forms.push({ pid, angle: angles[b], opacity: opacities[a] });
  }
  return forms;
}
