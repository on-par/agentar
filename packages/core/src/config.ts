/**
 * The avatar configuration: everything a user can customise about how their
 * agent looks and sounds. Persisted by the bridge as JSON
 * (~/.agentar/config.json) and edited live from the web UI.
 */
import { MOODS, type Mood } from "./moods.js";

export type ColorHex = `#${string}`;

/** A color override for a part of the model; null keeps the model's own texture. */
export type ColorOverride = ColorHex | null;

export type ModelRef =
  | { source: "builtin"; id: string }
  | { source: "url"; url: string; format?: "glb" | "vrm" };

export const GLASSES = ["none", "model", "round", "square"] as const;
export type Glasses = (typeof GLASSES)[number];

export const HATS = ["none", "beanie", "cap"] as const;
export type Hat = (typeof HATS)[number];

export const VOICE_PROVIDERS = ["system", "browser", "edge", "openai", "elevenlabs", "xai"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export const FRAMINGS = ["head", "bust", "full"] as const;
export type Framing = (typeof FRAMINGS)[number];

export const LIGHTINGS = ["studio", "warm", "cool", "dramatic"] as const;
export type Lighting = (typeof LIGHTINGS)[number];

export interface Appearance {
  skin: ColorOverride;
  hair: ColorOverride;
  eyes: ColorOverride;
  top: ColorOverride;
  bottom: ColorOverride;
  shoes: ColorOverride;
  glasses: Glasses;
  hat: Hat;
  accessoryColor: ColorHex;
  /** Uniform height scale, 0.85 – 1.15. */
  height: number;
}

export interface VoiceSettings {
  provider: VoiceProvider;
  /** Provider-specific voice id/name. Empty string = provider default. */
  voice: string;
  /** Speaking rate multiplier, 0.5 – 2. */
  rate: number;
  /** Pitch multiplier, 0.5 – 2 (browser provider only). */
  pitch: number;
  /** Output volume, 0 – 1. */
  volume: number;
}

export interface Behavior {
  mood: Mood;
  /** How strongly facial expressions and head motion play, 0 – 1. */
  expressiveness: number;
  /** Amount of idle body motion (breathing, sway), 0 – 1. */
  idleMotion: number;
  /** How much the avatar looks at the camera vs. around, 0 – 1. */
  eyeContact: number;
}

export interface SceneSettings {
  background: ColorHex;
  framing: Framing;
  lighting: Lighting;
  showFloor: boolean;
}

export interface AvatarConfig {
  version: 1;
  name: string;
  model: ModelRef;
  appearance: Appearance;
  voice: VoiceSettings;
  behavior: Behavior;
  scene: SceneSettings;
}

/** Customisable regions of a model; materials are mapped onto these slots. */
export type MaterialSlot = "skin" | "hair" | "eyes" | "top" | "bottom" | "shoes" | "eyewear";

export interface BuiltinModel {
  id: string;
  label: string;
  file: string;
  license: string;
  attribution: string;
  /** Material name → slot. Unlisted materials fall back to name heuristics. */
  slots?: Record<string, MaterialSlot>;
}

/**
 * Models fetched by `agentar fetch-models` (or `npm run fetch:models` in a checkout). All use the same rig standard:
 * Mixamo-style bone names + ARKit blendshapes + Oculus viseme morphs.
 */
export const BUILTIN_MODELS: BuiltinModel[] = [
  {
    id: "mpfb",
    label: "Alex (MPFB, CC0)",
    file: "mpfb.glb",
    license: "CC0-1.0",
    attribution: "Created with Blender + MPFB (MakeHuman). Distributed with TalkingHead.",
    slots: {
      "Human.body": "skin",
      "Human.female_casualsuit01": "top",
      "Human.ponytail01": "hair",
      "Human.mindfront_eyebrows_02": "hair",
      "Human.high-poly": "eyes",
    },
  },
  {
    id: "avaturn",
    label: "Avaturn sample (non-commercial)",
    file: "avaturn.glb",
    license: "Non-commercial use",
    attribution: "Created at avaturn.me. Distributed with TalkingHead.",
    slots: {
      Body: "skin",
      Head: "skin",
      Eyes: "eyes",
      avaturn_hair_0_material: "hair",
      avaturn_hair_1_material: "hair",
      avaturn_look_0_material: "top",
      avaturn_shoes_0_material: "shoes",
    },
  },
  {
    id: "brunette",
    label: "Brunette (Ready Player Me, CC BY-NC 4.0)",
    file: "brunette.glb",
    license: "CC-BY-NC-4.0",
    attribution: "Created at Ready Player Me. Distributed with TalkingHead.",
    slots: {
      Wolf3D_Skin: "skin",
      Wolf3D_Body: "skin",
      Wolf3D_Hair: "hair",
      Wolf3D_Eye: "eyes",
      Wolf3D_Outfit_Top: "top",
      Wolf3D_Outfit_Bottom: "bottom",
      Wolf3D_Outfit_Footwear: "shoes",
      Wolf3D_Glasses: "eyewear",
    },
  },
  {
    id: "avatarsdk",
    label: "AvatarSDK sample (non-commercial)",
    file: "avatarsdk.glb",
    license: "Non-commercial use",
    attribution: "Created at avatarsdk.com. Distributed with TalkingHead.",
  },
];

const SLOT_HEURISTICS: Array<[RegExp, MaterialSlot]> = [
  [/glass|eyewear|spectacle/i, "eyewear"],
  [/hair|ponytail|brow|beard|bun/i, "hair"],
  [/eye(?!lash|ao|brow)|iris|cornea/i, "eyes"],
  [/shoe|boot|foot|sneaker/i, "shoes"],
  [/bottom|pant|jean|skirt|short|trouser|leg/i, "bottom"],
  [/top|shirt|suit|jacket|look|outfit|dress|hoodie|coat|cloth/i, "top"],
  [/skin|body|head|face|arm|hand/i, "skin"],
];

/** Decide which customisation slot a material belongs to. */
export function slotForMaterial(materialName: string, model?: BuiltinModel): MaterialSlot | null {
  const explicit = model?.slots?.[materialName];
  if (explicit) return explicit;
  for (const [re, slot] of SLOT_HEURISTICS) if (re.test(materialName)) return slot;
  return null;
}

export const DEFAULT_CONFIG: AvatarConfig = {
  version: 1,
  name: "Agentar",
  model: { source: "builtin", id: "mpfb" },
  appearance: {
    skin: null,
    hair: null,
    eyes: null,
    top: null,
    bottom: null,
    shoes: null,
    glasses: "none",
    hat: "none",
    accessoryColor: "#222222",
    height: 1,
  },
  voice: { provider: "system", voice: "", rate: 1, pitch: 1, volume: 1 },
  behavior: { mood: "neutral", expressiveness: 0.7, idleMotion: 0.6, eyeContact: 0.8 },
  scene: { background: "#1b1f27", framing: "bust", lighting: "studio", showFloor: false },
};

// ---------------------------------------------------------------------------
// Validation. Hand-rolled so @agentar/core has no runtime dependencies and can
// run unchanged in the browser. Unknown or invalid values fall back to the
// base value instead of throwing, so an old config file never bricks the app.
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function color(v: unknown, fallback: ColorHex): ColorHex {
  return typeof v === "string" && HEX_RE.test(v) ? (v.toLowerCase() as ColorHex) : fallback;
}
function colorOverride(v: unknown, fallback: ColorOverride): ColorOverride {
  if (v === null) return null;
  return typeof v === "string" && HEX_RE.test(v) ? (v.toLowerCase() as ColorHex) : fallback;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
function str(v: unknown, maxLen: number, fallback: string): string {
  return typeof v === "string" ? v.slice(0, maxLen) : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function model(v: unknown, fallback: ModelRef): ModelRef {
  if (!isDict(v)) return fallback;
  if (v.source === "builtin" && typeof v.id === "string" && BUILTIN_MODELS.some((m) => m.id === v.id)) {
    return { source: "builtin", id: v.id };
  }
  if (v.source === "url" && typeof v.url === "string" && isAllowedModelUrl(v.url)) {
    const format = v.format === "vrm" || v.format === "glb" ? v.format : undefined;
    return format ? { source: "url", url: v.url, format } : { source: "url", url: v.url };
  }
  return fallback;
}

/** Custom models may come from the bridge (/models/...) or http(s) URLs. */
export function isAllowedModelUrl(url: string): boolean {
  if (url.startsWith("/models/")) return !url.includes("..");
  return /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(url);
}

/**
 * Apply a (possibly partial, possibly untrusted) patch on top of a base
 * config and return a fully valid config.
 */
export function mergeConfig(base: AvatarConfig, patch: unknown): AvatarConfig {
  const p = isDict(patch) ? patch : {};
  const a = isDict(p.appearance) ? p.appearance : {};
  const v = isDict(p.voice) ? p.voice : {};
  const b = isDict(p.behavior) ? p.behavior : {};
  const s = isDict(p.scene) ? p.scene : {};
  const A = base.appearance;
  const V = base.voice;
  const B = base.behavior;
  const S = base.scene;
  return {
    version: 1,
    name: str(p.name, 64, base.name).trim() || base.name,
    model: model(p.model, base.model),
    appearance: {
      skin: "skin" in a ? colorOverride(a.skin, A.skin) : A.skin,
      hair: "hair" in a ? colorOverride(a.hair, A.hair) : A.hair,
      eyes: "eyes" in a ? colorOverride(a.eyes, A.eyes) : A.eyes,
      top: "top" in a ? colorOverride(a.top, A.top) : A.top,
      bottom: "bottom" in a ? colorOverride(a.bottom, A.bottom) : A.bottom,
      shoes: "shoes" in a ? colorOverride(a.shoes, A.shoes) : A.shoes,
      glasses: oneOf(a.glasses, GLASSES, A.glasses),
      hat: oneOf(a.hat, HATS, A.hat),
      accessoryColor: color(a.accessoryColor, A.accessoryColor),
      height: num(a.height, 0.85, 1.15, A.height),
    },
    voice: {
      provider: oneOf(v.provider, VOICE_PROVIDERS, V.provider),
      voice: str(v.voice, 128, V.voice),
      rate: num(v.rate, 0.5, 2, V.rate),
      pitch: num(v.pitch, 0.5, 2, V.pitch),
      volume: num(v.volume, 0, 1, V.volume),
    },
    behavior: {
      mood: oneOf(b.mood, MOODS, B.mood),
      expressiveness: num(b.expressiveness, 0, 1, B.expressiveness),
      idleMotion: num(b.idleMotion, 0, 1, B.idleMotion),
      eyeContact: num(b.eyeContact, 0, 1, B.eyeContact),
    },
    scene: {
      background: color(s.background, S.background),
      framing: oneOf(s.framing, FRAMINGS, S.framing),
      lighting: oneOf(s.lighting, LIGHTINGS, S.lighting),
      showFloor: bool(s.showFloor, S.showFloor),
    },
  };
}

/** Parse a stored config, filling anything missing from the defaults. */
export function resolveConfig(input: unknown): AvatarConfig {
  return mergeConfig(DEFAULT_CONFIG, input);
}
