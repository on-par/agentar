/**
 * Visemes are the mouth shapes that correspond to groups of speech sounds.
 *
 * agentar uses the 15 Oculus/Meta LipSync visemes as its canonical set. Most
 * realistic avatar pipelines (Ready Player Me style rigs, Avaturn, MPFB/
 * MakeHuman exports, Character Creator) ship `viseme_*` morph targets that
 * use these exact names. For models that only have ARKit blendshapes, or
 * VRM models, we translate each viseme into a blend of what the model has.
 */
export const VISEMES = [
  "sil", // silence / neutral
  "PP", // p, b, m
  "FF", // f, v
  "TH", // th
  "DD", // t, d
  "kk", // k, g
  "CH", // ch, j, sh
  "SS", // s, z
  "nn", // n, l
  "RR", // r
  "aa", // a (father)
  "E", // e (bed)
  "I", // i (tip, see)
  "O", // o (toe)
  "U", // u (book, boot)
] as const;

export type Viseme = (typeof VISEMES)[number];

export type VisemeWeights = Partial<Record<Viseme, number>>;

export function isViseme(value: string): value is Viseme {
  return (VISEMES as readonly string[]).includes(value);
}

/** Morph target name used for a viseme on Oculus-compatible rigs. */
export function oculusMorphName(viseme: Viseme): string {
  return `viseme_${viseme}`;
}

/**
 * Fallback for rigs that only have the 52 ARKit blendshapes. Values were
 * tuned by eye against the ARKit reference faces; they are intentionally
 * conservative so that blending two neighbouring visemes never over-drives
 * the jaw.
 */
export const VISEME_TO_ARKIT: Record<Viseme, Record<string, number>> = {
  sil: {},
  PP: { mouthClose: 0.45, mouthPressLeft: 0.4, mouthPressRight: 0.4, mouthRollLower: 0.2 },
  FF: { mouthRollLower: 0.55, mouthUpperUpLeft: 0.2, mouthUpperUpRight: 0.2, jawOpen: 0.08 },
  TH: { jawOpen: 0.15, tongueOut: 0.35, mouthStretchLeft: 0.1, mouthStretchRight: 0.1 },
  DD: { jawOpen: 0.2, mouthStretchLeft: 0.15, mouthStretchRight: 0.15 },
  kk: { jawOpen: 0.25, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 },
  CH: { jawOpen: 0.15, mouthFunnel: 0.5, mouthPucker: 0.2 },
  SS: { jawOpen: 0.08, mouthStretchLeft: 0.35, mouthStretchRight: 0.35, mouthSmileLeft: 0.1, mouthSmileRight: 0.1 },
  nn: { jawOpen: 0.15, mouthStretchLeft: 0.1, mouthStretchRight: 0.1 },
  RR: { jawOpen: 0.15, mouthFunnel: 0.3, mouthPucker: 0.25 },
  aa: { jawOpen: 0.55, mouthLowerDownLeft: 0.25, mouthLowerDownRight: 0.25 },
  E: { jawOpen: 0.3, mouthStretchLeft: 0.3, mouthStretchRight: 0.3, mouthSmileLeft: 0.1, mouthSmileRight: 0.1 },
  I: { jawOpen: 0.18, mouthStretchLeft: 0.4, mouthStretchRight: 0.4, mouthSmileLeft: 0.15, mouthSmileRight: 0.15 },
  O: { jawOpen: 0.35, mouthFunnel: 0.55, mouthPucker: 0.15 },
  U: { jawOpen: 0.15, mouthPucker: 0.7, mouthFunnel: 0.25 },
};

/** VRM 1.0 preset expressions available for the mouth. */
export type VrmMouthExpression = "aa" | "ih" | "ou" | "ee" | "oh";

/** Fallback for VRM models, which only define five vowel mouth shapes. */
export const VISEME_TO_VRM: Record<Viseme, Partial<Record<VrmMouthExpression, number>>> = {
  sil: {},
  PP: {},
  FF: { ih: 0.2 },
  TH: { ih: 0.3, aa: 0.1 },
  DD: { ih: 0.35, aa: 0.1 },
  kk: { aa: 0.35, ih: 0.15 },
  CH: { ou: 0.35, oh: 0.15 },
  SS: { ih: 0.45 },
  nn: { ih: 0.3, aa: 0.1 },
  RR: { ou: 0.4 },
  aa: { aa: 0.9 },
  E: { ee: 0.7, aa: 0.15 },
  I: { ih: 0.75 },
  O: { oh: 0.8 },
  U: { ou: 0.85 },
};
