import type { Gesture } from "@agentar/core";

type Rot = [number, number, number];

/** What a gesture adds on top of the idle animation in one frame. */
export interface GestureFrame {
  /** Head rotation offset (x: down, y: turn, z: tilt), radians. */
  head: { x: number; y: number; z: number };
  /** ARKit blendshape weights to add (mapped to VRM expressions on VRM models). */
  face: Record<string, number>;
  /**
   * Extra local rotations, applied after the pose. Keys are Mixamo arm/hand
   * bone names (mirrored with the pose) or the body bones "spine", "chest",
   * "upperChest".
   */
  bones: Record<string, Rot>;
}

export interface GestureSpec {
  /** Total length in seconds. */
  duration: number;
  /** Seconds to blend into and out of the pose. */
  attack?: number;
  release?: number;
  /**
   * Target arm and hand pose for Mixamo rigs: absolute local Euler XYZ
   * rotations, same convention as STANDING_POSE. Written for the model's
   * left hand unless `mirror` is set.
   */
  pose?: Record<string, Rot>;
  /** Play the pose with the model's right hand. */
  mirror?: boolean;
  /** Per-frame extras. `t` is seconds since the start, `w` the pose weight (0 – 1). */
  animate?(t: number, w: number, f: GestureFrame): void;
}

// Arm and hand poses below are adapted from the gesture templates in
// TalkingHead (https://github.com/met4citizen/TalkingHead, MIT License,
// (c) 2023-2024 Mika Suominen). See THIRD_PARTY_NOTICES.md.

/** Left arm raised, forearm up, hand beside the head. */
const ARM_UP: Record<string, Rot> = {
  LeftShoulder: [1.75, 0.3, -1.4],
  LeftArm: [1.6, -0.5, 1.1],
  LeftForeArm: [-0.815, -0.2, 1.575],
};

const OPEN_HAND: Record<string, Rot> = {
  LeftHand: [-0.529, -0.2, 0.022],
  LeftHandThumb1: [0.745, -0.526, 0.604],
  LeftHandThumb2: [-0.107, -0.01, -0.142],
  LeftHandThumb3: [0, 0.001, 0],
  LeftHandIndex1: [-0.126, -0.035, -0.087],
  LeftHandIndex2: [0.255, 0.007, -0.085],
  LeftHandIndex3: [0, 0, 0],
  LeftHandMiddle1: [-0.019, -0.128, -0.082],
  LeftHandMiddle2: [0.233, 0.019, -0.074],
  LeftHandMiddle3: [0, 0, 0],
  LeftHandRing1: [0.005, -0.241, -0.122],
  LeftHandRing2: [0.261, 0.021, -0.076],
  LeftHandRing3: [0, 0, 0],
  LeftHandPinky1: [0.059, -0.336, -0.2],
  LeftHandPinky2: [0.153, 0.019, 0.001],
  LeftHandPinky3: [0, 0, 0],
};

const FIST_WITH_THUMB: Record<string, Rot> = {
  LeftHandThumb1: [0.208, -0.189, 0.685],
  LeftHandThumb2: [0.129, -0.285, -0.163],
  LeftHandThumb3: [-0.047, 0.068, 0.401],
  LeftHandIndex1: [1.412, -0.102, -0.152],
  LeftHandIndex2: [1.903, -0.16, -0.114],
  LeftHandIndex3: [0.535, -0.017, -0.062],
  LeftHandMiddle1: [1.424, -0.103, -0.12],
  LeftHandMiddle2: [1.919, -0.162, -0.114],
  LeftHandMiddle3: [0.44, -0.012, -0.051],
  LeftHandRing1: [1.619, -0.127, -0.053],
  LeftHandRing2: [1.898, -0.16, -0.115],
  LeftHandRing3: [0.262, -0.004, -0.031],
  LeftHandPinky1: [1.661, -0.131, -0.016],
  LeftHandPinky2: [1.715, -0.067, -0.13],
  LeftHandPinky3: [0.627, -0.023, -0.071],
};

const INDEX_UP: Record<string, Rot> = {
  LeftHand: [-0.276, -0.506, -0.208],
  LeftHandThumb1: [0.579, 0.228, 0.363],
  LeftHandThumb2: [-0.027, -0.04, -0.662],
  LeftHandThumb3: [0, 0.001, 0],
  LeftHandIndex1: [0, -0.105, 0.225],
  LeftHandIndex2: [0.256, -0.103, -0.213],
  LeftHandIndex3: [0, 0, 0],
  LeftHandMiddle1: [1.453, 0.07, 0.021],
  LeftHandMiddle2: [1.599, 0.062, 0.07],
  LeftHandMiddle3: [0, 0, 0],
  LeftHandRing1: [1.528, -0.073, 0.052],
  LeftHandRing2: [1.386, 0.044, 0.053],
  LeftHandRing3: [0, 0, 0],
  LeftHandPinky1: [1.65, -0.204, 0.031],
  LeftHandPinky2: [1.302, 0.071, 0.085],
  LeftHandPinky3: [0, 0, 0],
};

const SHRUG: Record<string, Rot> = {
  RightShoulder: [1.732, -0.058, 1.407],
  RightArm: [1.305, 0.46, 0.118],
  RightForeArm: [1.42, -0.123, -1.506],
  RightHand: [0.073, 0.138, -0.064],
  RightHandThumb1: [1.467, 0.599, -1.315],
  RightHandThumb2: [-0.255, -0.123, 0.119],
  RightHandIndex1: [-0.293, -0.066, -0.112],
  RightHandIndex2: [0.181, 0.007, 0.069],
  RightHandMiddle1: [-0.063, -0.041, 0.032],
  RightHandMiddle2: [0.149, 0.005, 0.05],
  RightHandRing1: [0.152, -0.03, 0.132],
  RightHandRing2: [0.194, 0.007, 0.058],
  RightHandPinky1: [0.306, -0.015, 0.257],
  RightHandPinky2: [0.15, -0.003, -0.003],
  LeftShoulder: [1.713, 0.141, -1.433],
  LeftArm: [1.136, -0.422, -0.416],
  LeftForeArm: [1.42, 0.123, 1.506],
  LeftHand: [0.073, -0.138, 0.064],
  LeftHandThumb1: [1.467, -0.599, 1.314],
  LeftHandThumb2: [-0.255, 0.123, -0.119],
  LeftHandIndex1: [-0.293, 0.066, 0.112],
  LeftHandIndex2: [0.181, -0.007, -0.069],
  LeftHandMiddle1: [-0.062, 0.041, -0.032],
  LeftHandMiddle2: [0.149, -0.005, -0.05],
  LeftHandRing1: [0.152, 0.03, -0.132],
  LeftHandRing2: [0.194, -0.007, -0.058],
  LeftHandPinky1: [0.306, 0.015, -0.257],
  LeftHandPinky2: [0.15, 0.003, 0.003],
};

const NAMASTE: Record<string, Rot> = {
  RightShoulder: [1.758, 0.099, 1.604],
  RightArm: [0.862, -0.292, -0.932],
  RightForeArm: [0.083, 0.066, -1.791],
  RightHand: [-0.52, -0.001, -0.176],
  RightHandThumb1: [0.227, 0.418, -0.776],
  RightHandThumb2: [-0.011, -0.003, 0.171],
  RightHandIndex1: [-0.236, 0.003, -0.028],
  RightHandMiddle1: [-0.236, 0.003, -0.028],
  RightHandRing1: [-0.236, 0.003, -0.028],
  RightHandPinky1: [-0.236, 0.003, -0.028],
  LeftShoulder: [1.711, -0.002, -1.625],
  LeftArm: [0.683, 0.334, 0.977],
  LeftForeArm: [0.086, -0.066, 1.843],
  LeftHand: [-0.595, -0.229, 0.096],
  LeftHandThumb1: [0.404, -0.05, 0.537],
  LeftHandThumb2: [-0.02, 0.004, -0.154],
  LeftHandIndex1: [-0.113, -0.001, 0.014],
  LeftHandMiddle1: [-0.113, -0.001, 0.014],
  LeftHandRing1: [-0.113, -0.001, 0.014],
  LeftHandPinky1: [-0.122, -0.001, -0.057],
};

const smile = (f: GestureFrame, amount: number) => {
  f.face.mouthSmileLeft = amount;
  f.face.mouthSmileRight = amount;
  f.face.cheekSquintLeft = amount * 0.5;
  f.face.cheekSquintRight = amount * 0.5;
};

const browsUp = (f: GestureFrame, amount: number) => {
  f.face.browInnerUp = amount;
  f.face.browOuterUpLeft = amount * 0.8;
  f.face.browOuterUpRight = amount * 0.8;
};

/** A quick bump that peaks at `at` seconds and lasts about `width` seconds. */
const pulse = (t: number, at: number, width: number) => Math.exp(-(((t - at) / (width / 2)) ** 2));

export const GESTURE_SPECS: Record<Gesture, GestureSpec> = {
  nod: {
    duration: 0.9,
    animate(t, _w, f) {
      const p = t / 0.9;
      f.head.x += 0.14 * Math.sin(p * Math.PI * 3) * (1 - p);
    },
  },
  shake: {
    duration: 1.1,
    animate(t, _w, f) {
      const p = t / 1.1;
      f.head.y += 0.16 * Math.sin(p * Math.PI * 4) * (1 - p);
    },
  },
  tilt: {
    duration: 1.2,
    animate(t, _w, f) {
      f.head.z += 0.13 * Math.sin((t / 1.2) * Math.PI);
    },
  },
  wave: {
    duration: 2.8,
    attack: 0.45,
    release: 0.5,
    mirror: true,
    pose: { ...ARM_UP, ...OPEN_HAND },
    animate(t, w, f) {
      // Swing the forearm side to side from the elbow.
      const swing = Math.sin((t - 0.35) * Math.PI * 2 * 1.8) * w;
      f.bones.LeftForeArm = [0, 0, 0.15 * w + 0.22 * swing];
      f.bones.LeftHand = [0, 0, 0.15 * swing];
      f.head.z += 0.06 * w;
      smile(f, 0.6 * w);
      browsUp(f, 0.2 * w);
    },
  },
  "high-five": {
    duration: 2.0,
    attack: 0.4,
    release: 0.55,
    mirror: true,
    pose: { ...ARM_UP, ...OPEN_HAND },
    animate(t, w, f) {
      // Raise the palm toward the viewer, then slap forward.
      const slap = pulse(t, 0.8, 0.25);
      f.bones.LeftArm = [0.25 * w + 0.2 * slap, 0, 0.1 * w];
      f.head.x += -0.05 * w + 0.08 * slap;
      smile(f, 0.8 * w);
      browsUp(f, 0.35 * w);
      f.face.eyeWideLeft = 0.3 * w;
      f.face.eyeWideRight = 0.3 * w;
    },
  },
  "thumbs-up": {
    duration: 2.2,
    attack: 0.4,
    release: 0.5,
    mirror: true,
    pose: {
      ...ARM_UP,
      LeftForeArm: [-0.415, 0.206, 1.575],
      LeftHand: [-0.276, -0.506, -0.208],
      ...FIST_WITH_THUMB,
    },
    animate(t, w, f) {
      const pump = pulse(t, 0.75, 0.3);
      f.bones.LeftForeArm = [0, 0, -0.18 * pump];
      f.head.x += 0.07 * pump;
      f.head.z += 0.05 * w;
      smile(f, 0.65 * w);
    },
  },
  "thumbs-down": {
    duration: 2.2,
    attack: 0.4,
    release: 0.5,
    mirror: true,
    pose: {
      ...ARM_UP,
      LeftForeArm: [-2.015, 0.406, 1.575],
      LeftHand: [-0.176, -0.206, -0.208],
      ...FIST_WITH_THUMB,
    },
    animate(t, w, f) {
      // Bring the fist forward and low, rolled so the thumb points down.
      f.bones.LeftArm = [0.5 * w, 0, -0.5 * w];
      f.bones.LeftForeArm = [0, 1.2 * w, 0];
      f.head.y += 0.08 * Math.sin(t * Math.PI * 2 * 1.5) * w;
      f.face.mouthFrownLeft = 0.5 * w;
      f.face.mouthFrownRight = 0.5 * w;
      f.face.browDownLeft = 0.4 * w;
      f.face.browDownRight = 0.4 * w;
    },
  },
  idea: {
    duration: 2.0,
    attack: 0.35,
    release: 0.5,
    pose: { ...ARM_UP, ...INDEX_UP },
    animate(_t, w, f) {
      f.head.x -= 0.06 * w;
      f.head.z -= 0.05 * w;
      browsUp(f, 0.7 * w);
      f.face.eyeWideLeft = 0.35 * w;
      f.face.eyeWideRight = 0.35 * w;
      smile(f, 0.3 * w);
    },
  },
  shrug: {
    duration: 2.0,
    attack: 0.4,
    release: 0.55,
    pose: SHRUG,
    animate(_t, w, f) {
      // Elbows bent, palms up in front of the body.
      f.bones.LeftArm = [0.3 * w, 0, 0];
      f.bones.RightArm = [0.3 * w, 0, 0];
      f.head.z += 0.1 * w;
      f.head.x -= 0.04 * w;
      browsUp(f, 0.55 * w);
      f.face.mouthShrugLower = 0.5 * w;
      f.face.mouthShrugUpper = 0.2 * w;
      f.face.mouthPressLeft = 0.3 * w;
      f.face.mouthPressRight = 0.3 * w;
    },
  },
  namaste: {
    duration: 2.6,
    attack: 0.5,
    release: 0.6,
    pose: NAMASTE,
    animate(_t, w, f) {
      // Turn the upper arms in so the palms meet.
      f.bones.LeftArm = [0, 0.22 * w, 0];
      f.bones.RightArm = [0, -0.22 * w, 0];
      f.head.x += 0.18 * w;
      f.bones.upperChest = [0.08 * w, 0, 0];
      smile(f, 0.35 * w);
      f.face.eyeBlinkLeft = 0.45 * w;
      f.face.eyeBlinkRight = 0.45 * w;
    },
  },
  wink: {
    duration: 1.0,
    attack: 0.15,
    release: 0.3,
    animate(t, w, f) {
      const close = pulse(t, 0.4, 0.45);
      f.face.eyeBlinkLeft = Math.min(1, close * 1.4);
      f.face.eyeSquintLeft = 0.4 * w;
      f.face.cheekSquintLeft = 0.5 * w;
      f.face.mouthSmileLeft = 0.7 * w;
      f.face.mouthSmileRight = 0.25 * w;
      f.head.z += 0.08 * w;
      f.head.x += 0.03 * w;
    },
  },
  laugh: {
    duration: 2.2,
    attack: 0.25,
    release: 0.6,
    animate(t, w, f) {
      const bob = Math.sin(t * Math.PI * 2 * 3.5);
      f.head.x += (-0.12 + 0.035 * bob) * w;
      f.bones.chest = [0.02 * bob * w, 0, 0];
      smile(f, 0.95 * w);
      f.face.jawOpen = (0.3 + 0.12 * bob) * w;
      f.face.eyeSquintLeft = 0.55 * w;
      f.face.eyeSquintRight = 0.55 * w;
      f.face.browInnerUp = 0.25 * w;
    },
  },
  surprised: {
    duration: 1.6,
    attack: 0.12,
    release: 0.6,
    animate(_t, w, f) {
      f.head.x -= 0.09 * w;
      browsUp(f, 0.95 * w);
      f.face.eyeWideLeft = 0.85 * w;
      f.face.eyeWideRight = 0.85 * w;
      f.face.jawOpen = 0.35 * w;
      f.face.mouthFunnel = 0.25 * w;
    },
  },
  bow: {
    duration: 2.2,
    attack: 0.6,
    release: 0.7,
    animate(_t, w, f) {
      f.bones.spine = [0.22 * w, 0, 0];
      f.bones.chest = [0.14 * w, 0, 0];
      f.head.x += 0.2 * w;
      f.face.eyeBlinkLeft = 0.3 * w;
      f.face.eyeBlinkRight = 0.3 * w;
    },
  },
};

/** Map a mirrored bone name: LeftArm ↔ RightArm. */
export function mirrorBoneName(name: string): string {
  if (name.startsWith("Left")) return `Right${name.slice(4)}`;
  if (name.startsWith("Right")) return `Left${name.slice(5)}`;
  return name;
}

/** ARKit blendshapes → VRM expressions, for gesture faces on VRM models. */
export const ARKIT_TO_VRM: Record<string, Array<[string, number]>> = {
  eyeBlinkLeft: [["blinkLeft", 1]],
  eyeBlinkRight: [["blinkRight", 1]],
  mouthSmileLeft: [["happy", 0.5]],
  mouthSmileRight: [["happy", 0.5]],
  mouthFrownLeft: [["sad", 0.5]],
  mouthFrownRight: [["sad", 0.5]],
  browInnerUp: [["surprised", 0.6]],
  eyeWideLeft: [["surprised", 0.2]],
  eyeWideRight: [["surprised", 0.2]],
  jawOpen: [["aa", 0.8]],
};
