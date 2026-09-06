export const LIVE2D_PREP_MODEL = 'gpt-image-2';
export const LIVE2D_PREP_SIZE = '1024x1536';

/**
 * A deliberately small, repeatable character lock for one source image.
 * It prepares an input for PSD decomposition; it does not claim to rig it.
 */
export function live2dPrepPrompt() {
  return `Create one production-ready character reference for later Live2D PSD layer decomposition.

Use the supplied image as the sole authority for the character's identity, face, hair, body topology, proportions, outfit construction, accessories, palette, material and rendering family. Preserve those hard locks; do not redesign the character.

Output exactly one complete character in a neutral, upright, front-facing production pose. Show the full head, hair, torso, both arms, both hands, hips, both legs, feet and all signature accessories. Keep left and right limbs anatomically continuous from attachment to tip, visibly separated where practical, and entirely inside the frame. Keep hands relaxed and simple, with no foreshortening. Center the grounded full body on a vertical 2:3 canvas with generous clear padding around head, hands and feet.

Use clean, even studio lighting and a plain opaque very-light-gray background. Do not use a checkerboard, transparency simulation, scenery, floor shadow, text, watermark, frame, collage, duplicate character or extra prop.

Avoid identity drift, changed clothing, missing accessories, cropped limbs, detached joints, extra or missing fingers/limbs, fused limbs, impossible overlaps, heavy perspective, dramatic pose, motion blur and style replacement. This is a neutral source asset, not a rigged Live2D model.`;
}

export function isPng(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer.slice(0, 8));
  return (
    bytes.length === 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}
