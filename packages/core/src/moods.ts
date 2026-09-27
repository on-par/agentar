/**
 * Moods are sustained facial expressions layered under speech. They are
 * expressed as ARKit blendshape weights (supported by all built-in models)
 * plus a small head pose bias, and scaled by `behavior.expressiveness`.
 */
export const MOODS = ["neutral", "happy", "thinking", "surprised", "concerned", "amused"] as const;
export type Mood = (typeof MOODS)[number];

export interface MoodPreset {
  /** ARKit blendshape weights. */
  face: Record<string, number>;
  /** Head rotation bias in radians: x = nod (down +), y = turn, z = tilt. */
  head: { x: number; y: number; z: number };
  /** VRM preset expression equivalents. */
  vrm: Partial<Record<"happy" | "angry" | "sad" | "relaxed" | "surprised", number>>;
}

export const MOOD_PRESETS: Record<Mood, MoodPreset> = {
  neutral: {
    face: { mouthSmileLeft: 0.08, mouthSmileRight: 0.08 },
    head: { x: 0, y: 0, z: 0 },
    vrm: {},
  },
  happy: {
    face: {
      mouthSmileLeft: 0.55, mouthSmileRight: 0.55, cheekSquintLeft: 0.3, cheekSquintRight: 0.3,
      eyeSquintLeft: 0.15, eyeSquintRight: 0.15, browInnerUp: 0.1, mouthDimpleLeft: 0.2, mouthDimpleRight: 0.2,
    },
    head: { x: -0.03, y: 0, z: 0.03 },
    vrm: { happy: 0.6 },
  },
  thinking: {
    face: {
      browDownLeft: 0.25, browOuterUpRight: 0.35, mouthPressLeft: 0.3, mouthPressRight: 0.2,
      mouthLeft: 0.15, eyeSquintLeft: 0.2, eyeSquintRight: 0.2, eyeLookUpLeft: 0.25, eyeLookUpRight: 0.25,
    },
    head: { x: -0.04, y: 0.08, z: 0.06 },
    vrm: { relaxed: 0.3 },
  },
  surprised: {
    face: {
      browInnerUp: 0.7, browOuterUpLeft: 0.6, browOuterUpRight: 0.6, eyeWideLeft: 0.5, eyeWideRight: 0.5,
      jawOpen: 0.12,
    },
    head: { x: -0.05, y: 0, z: 0 },
    vrm: { surprised: 0.6 },
  },
  concerned: {
    face: {
      browInnerUp: 0.55, browDownLeft: 0.15, browDownRight: 0.15, mouthFrownLeft: 0.3, mouthFrownRight: 0.3,
      mouthPressLeft: 0.2, mouthPressRight: 0.2,
    },
    head: { x: 0.04, y: 0, z: -0.04 },
    vrm: { sad: 0.4 },
  },
  amused: {
    face: {
      mouthSmileLeft: 0.6, mouthSmileRight: 0.3, cheekSquintLeft: 0.35, browOuterUpRight: 0.25,
      eyeSquintLeft: 0.25, mouthDimpleLeft: 0.25,
    },
    head: { x: -0.02, y: -0.05, z: 0.07 },
    vrm: { happy: 0.4, relaxed: 0.2 },
  },
};

export function isMood(v: unknown): v is Mood {
  return typeof v === "string" && (MOODS as readonly string[]).includes(v);
}
