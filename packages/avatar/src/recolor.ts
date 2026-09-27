import { Color, type Material, type MeshStandardMaterial, type Texture } from "three";
import type { MaterialSlot } from "@agentar/core";

/**
 * Re-tints a textured PBR material while keeping its shading detail.
 *
 * Multiplying a texture by a color can only darken it (blond hair from a
 * brown texture is impossible), so instead we compute each texel's luminance
 * relative to the texture's average luminance and apply that "shade" to the
 * target color: result = tint × (luma / avgLuma). Folds, strands and fabric
 * weave survive; the base hue is replaced.
 */
interface RecolorState {
  tint: { value: Color };
  strength: { value: number };
  refLuma: { value: number };
  irisMask: { value: number };
}

const STRENGTH: Record<MaterialSlot, number> = {
  skin: 0.65,
  hair: 0.92,
  eyes: 0.85,
  top: 1,
  bottom: 1,
  shoes: 1,
  eyewear: 1,
};

const states = new WeakMap<Material, RecolorState>();

function ensurePatched(mat: MeshStandardMaterial, slot: MaterialSlot): RecolorState {
  let state = states.get(mat);
  if (state) return state;
  state = {
    tint: { value: new Color(1, 1, 1) },
    strength: { value: 0 },
    refLuma: { value: estimateLuma(mat) },
    irisMask: { value: slot === "eyes" ? 1 : 0 },
  };
  const s = state;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    shader.uniforms.agTint = s.tint;
    shader.uniforms.agStrength = s.strength;
    shader.uniforms.agRefLuma = s.refLuma;
    shader.uniforms.agIrisMask = s.irisMask;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform vec3 agTint;
uniform float agStrength;
uniform float agRefLuma;
uniform float agIrisMask;`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
{
  float agLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float agShade = clamp(agLuma / max(agRefLuma, 0.02), 0.0, 1.8);
  vec3 agRecolored = agTint * agShade;
  // Eyes: keep the bright sclera and dark pupil, recolor only the iris.
  float agMask = mix(1.0, (1.0 - smoothstep(0.35, 0.6, agLuma)) * smoothstep(0.01, 0.05, agLuma), agIrisMask);
  diffuseColor.rgb = mix(diffuseColor.rgb, agRecolored, agStrength * agMask);
}`,
      );
  };
  // All patched materials share one program variant.
  mat.customProgramCacheKey = () => "agentar-recolor";
  mat.needsUpdate = true;
  states.set(mat, state);
  return state;
}

/** Apply (or clear, with null) a tint to a material. */
export function setMaterialTint(mat: Material, slot: MaterialSlot, hex: string | null): void {
  const std = mat as MeshStandardMaterial;
  if (!("isMeshStandardMaterial" in std) || !std.isMeshStandardMaterial) return;
  if (hex === null && !states.has(mat)) return;
  const state = ensurePatched(std, slot);
  if (hex === null) {
    state.strength.value = 0;
    return;
  }
  state.tint.value.set(hex); // Color.set converts sRGB hex to linear working space
  state.strength.value = STRENGTH[slot];
}

/**
 * Average linear luminance of the material's base color (texture × color).
 * Reads a downscaled copy of the texture through a 2D canvas.
 */
function estimateLuma(mat: MeshStandardMaterial): number {
  const base = mat.color.clone();
  const baseLuma = 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b;
  const texLuma = mat.map ? textureLuma(mat.map) : 1;
  return Math.max(0.02, baseLuma * texLuma);
}

function textureLuma(tex: Texture): number {
  const img = tex.image as CanvasImageSource & { width?: number; height?: number };
  if (!img || typeof document === "undefined") return 0.5;
  try {
    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 0.5;
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! < 128) continue; // skip transparent texels (hair cards)
      const r = srgbToLinear(data[i]! / 255);
      const g = srgbToLinear(data[i + 1]! / 255);
      const b = srgbToLinear(data[i + 2]! / 255);
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count++;
    }
    return count ? sum / count : 0.5;
  } catch {
    return 0.5;
  }
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
