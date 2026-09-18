---
name: character-persona-live2d
description: "Turn one or more character references into a visual-persona lock and Live2D-ready generation brief. Use before creating, redrawing, or rigging a Live2D character when identity drift would undermine the intended first impression."
---

# Character Persona Live2d

Create a reusable identity lock before producing a Live2D source image, layered asset, expression sheet, or rig brief. The goal is design continuity: later images should read as the same character at first glance, not merely share hair colour or outfit.

## Start with evidence, not diagnosis

Treat reference images as evidence of character-design intent, not evidence of a real person's personality. Separate:

- **Observed signals:** expression, gaze, posture, silhouette, palette, materials, clothes, prop, lighting, composition, and rendering style.
- **Design interpretation:** the intended first impression (for example, guarded, gentle, playful, composed). Mark each interpretation with confidence: high, medium, or low.
- **User canon:** details the user states directly. User canon overrides visual inference.

If the references conflict on high-impact identity cues (age presentation, hairstyle, body type, palette, genre, emotional tone, or signature prop), stop before generation and ask which reference is canonical. Do not average contradictory designs into an indistinct character.

## Build the persona lock

Before image generation, create `character-bible.md` using [the template](references/character-bible-template.md). Keep it concise enough to reuse in every prompt. It must include:

1. **First-glance promise:** one sentence describing the instant emotional read the design must preserve.
2. **Five identity pillars:** role/archetype, emotional temperature, social energy, behavioural rhythm, and one memorable contradiction.
3. **Visual lock:** face geometry, hair silhouette and parting, body proportions, wardrobe structure, palette, materials, and signature prop/markings.
4. **Expression grammar:** neutral baseline plus allowed emotional range; distinguish quiet intensity from anger, warmth from flirtation, and shyness from blankness when relevant.
5. **Hard locks / controlled variables / forbidden drift:** hard locks never change; variables may change only with a stated reason; forbidden drift lists the common wrong reads the result must avoid.
6. **Prompt lock:** an identity suffix reused verbatim for all later visual prompts plus a negative constraint line.

Do not use vague adjectives as the only control mechanism. Pair every personality claim with observable direction: e.g. “reserved confidence” becomes a level chin, controlled mouth, steady gaze, low gesture amplitude, and restrained palette rather than “serious”.

## Convert the lock into Live2D-ready art direction

Read [the Live2D handoff section](references/character-bible-template.md) when the task involves source art, expressions, or rigging. Produce `live2d-generation-brief.md` that contains:

- canonical reference image(s), ranked by authority;
- a front-facing neutral master pose with complete, uncropped body parts;
- a layer-separation map for hair, face, eyes, brows, mouth, torso, clothing, hands, props, and optional accessories;
- expression set and parameter intent. Each expression must preserve the first-glance promise rather than turn the character into a different archetype;
- pose and camera limits: front or near-front orientation, stable focal length, no dramatic perspective, no hands obscuring the face, no inconsistent light source;
- immutable palette/material notes and what is allowed to vary by state;
- a preflight checklist for identity, riggability, clipping, and layer completeness.

For emotion sheets, hold face geometry, hairstyle, costume architecture, prop side, palette, and camera fixed. Change only the expression grammar and small pose cues needed for the requested state. Do not add new lore, props, relationships, jobs, or mood cues merely to make an expression feel more dramatic.

## Prompt and review loop

Use this prompt order for each derivative: **deliverable → prompt lock → requested state/pose → allowed variation → rendering/technical constraints → negative constraints**. Keep the same prompt lock across the set.

Before accepting a generated result, compare it to the persona lock and label each item `pass`, `soft drift`, or `fail`. Regenerate only for a fail or for accumulated soft drift that changes the first impression. A technically clean image fails if it reads as a different character type.

When the user asks to intentionally redesign the character, create a new versioned lock instead of silently editing the canonical one.
