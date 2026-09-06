/**
 * PSD import — wraps ag-psd to produce a flat list of layers.
 *
 * Returns only rasterized layers (those with pixel data). Group/folder nodes
 * are walked but not emitted as parts (M3 will add hierarchy).
 */
import { readPsd } from 'ag-psd';

/**
 * @typedef {Object} PsdLayer
 * @property {string}    name
 * @property {number}    x         - left offset in PSD canvas space
 * @property {number}    y         - top offset in PSD canvas space
 * @property {number}    width
 * @property {number}    height
 * @property {ImageData} imageData - full-canvas-size imageData (pre-composited into PSD space)
 * @property {string}    blendMode
 * @property {number}    opacity   - 0-1
 * @property {boolean}   visible
 */

/**
 * Parse an ArrayBuffer containing a PSD file.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ width: number, height: number, layers: PsdLayer[] }}
 */
export function importPsd(buffer) {
  const psd = readPsd(buffer, { skipLayerImageData: false, useImageData: true });

  const layers = [];

  function walk(children) {
    if (!children) return;
    for (const layer of children) {
      if (layer.children) {
        // group — recurse, skip as a part for now
        walk(layer.children);
        continue;
      }
      // Only emit layers that have pixel content
      if (!layer.canvas && !layer.imageData) continue;

      const left   = layer.left   ?? 0;
      const top    = layer.top    ?? 0;
      const right  = layer.right  ?? psd.width;
      const bottom = layer.bottom ?? psd.height;
      const w = right  - left;
      const h = bottom - top;
      if (w <= 0 || h <= 0) continue;

      // Get imageData from the layer's canvas (ag-psd provides this)
      let imageData;
      if (layer.canvas) {
        const ctx = layer.canvas.getContext('2d');
        imageData = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
      } else {
        imageData = layer.imageData;
      }

      layers.push({
        name:      layer.name || `Layer ${layers.length + 1}`,
        x:         left,
        y:         top,
        width:     w,
        height:    h,
        imageData,
        blendMode: layer.blendMode ?? 'normal',
        opacity:   layer.opacity !== undefined ? layer.opacity : 1,
        visible:   !layer.hidden,
      });
    }
  }

  walk(psd.children);

  // Reverse so bottom PSD layer → lowest draw_order (drawn first)
  layers.reverse();

  return { width: psd.width, height: psd.height, layers };
}

/**
 * Extract the discrete action/expression replacement protocol used by the
 * Live2D PSD workflow. A variant group is named `action_*` or `expression_*`
 * and its raster children use `variant_name__slot_name` names. The returned
 * manifest deliberately keeps hidden groups: hidden layers are the source of
 * alternate states and must not be discarded during import.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ width: number, height: number, baseSlots: Array<Object>, variants: Array<Object> }}
 */
export function extractVariantManifest(buffer) {
  const psd = readPsd(buffer, {
    skipLayerImageData: true,
    skipCompositeImageData: true,
    useImageData: false,
  });
  const variants = [];
  const baseSlots = [];

  const isVariantGroup = (name) => /^(action|expression)_[^]+/.test(name || '');
  const kindFor = (name) => name?.startsWith('action_') ? 'action' : 'expression';

  function collectRasterChildren(children, out, path) {
    if (!children) return;
    for (const layer of children) {
      const name = layer.name || '';
      const nextPath = [...path, name];
      if (layer.children) {
        collectRasterChildren(layer.children, out, nextPath);
        continue;
      }
      const separator = name.indexOf('__');
      if (separator > 0) {
        out.push({
          name,
          slot: name.slice(separator + 2),
          path: nextPath,
          hidden: Boolean(layer.hidden),
          bounds: [layer.left ?? 0, layer.top ?? 0, layer.right ?? 0, layer.bottom ?? 0],
        });
      }
    }
  }

  function walk(children, path = []) {
    if (!children) return;
    for (const layer of children) {
      const name = layer.name || '';
      const nextPath = [...path, name];
      if (layer.children) {
        if (isVariantGroup(name)) {
          const parts = [];
          collectRasterChildren(layer.children, parts, nextPath);
          variants.push({
            id: name,
            kind: kindFor(name),
            path: nextPath,
            hidden: Boolean(layer.hidden),
            parts,
          });
        }
        walk(layer.children, nextPath);
        continue;
      }

      // Only unqualified raster layers are considered canonical/base slots.
      if (!name.includes('__')) {
        baseSlots.push({
          name,
          path: nextPath,
          hidden: Boolean(layer.hidden),
          bounds: [layer.left ?? 0, layer.top ?? 0, layer.right ?? 0, layer.bottom ?? 0],
        });
      }
    }
  }

  walk(psd.children);

  return {
    width: psd.width,
    height: psd.height,
    baseSlots,
    variants,
  };
}
