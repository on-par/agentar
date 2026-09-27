import {
  Box3,
  Color,
  Euler,
  Group,
  Object3D,
  Quaternion,
  Vector3,
  type Camera,
  type Material,
  type Mesh,
  type SkinnedMesh,
} from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import {
  MOOD_PRESETS,
  VISEME_TO_ARKIT,
  VISEME_TO_VRM,
  oculusMorphName,
  slotForMaterial,
  type Appearance,
  type Behavior,
  type BuiltinModel,
  type Gesture,
  type Mood,
  type Viseme,
  type VisemeWeights,
} from "@agentar/core";
import { MorphController } from "./morphs.js";
import { MIXAMO_CORE_BONES, STANDING_POSE } from "./pose.js";
import { setMaterialTint } from "./recolor.js";
import { buildAccessories, type HeadFrame } from "./accessories.js";
import { ARKIT_TO_VRM, GESTURE_SPECS, mirrorBoneName, type GestureFrame, type GestureSpec } from "./gestures.js";
import type { SpeechFrame } from "./speech.js";

export interface AvatarSource {
  url: string;
  format?: "glb" | "vrm";
  /** Registry entry for built-in models (explicit material slots etc.). */
  builtin?: BuiltinModel;
}

type BoneKey = "hips" | "spine" | "chest" | "upperChest" | "neck" | "head" | "leftEye" | "rightEye";

const MIXAMO_NAMES: Record<BoneKey, string> = {
  hips: "Hips",
  spine: "Spine",
  chest: "Spine1",
  upperChest: "Spine2",
  neck: "Neck",
  head: "Head",
  leftEye: "LeftEye",
  rightEye: "RightEye",
};

/** Face state for one frame, independent of the rig format. */
interface FaceState {
  arkit: Record<string, number>;
  visemes: VisemeWeights;
  mood: Mood;
  moodAmount: number;
  blink: number;
  gaze: { x: number; y: number };
  /** Extra ARKit weights from the current gesture. */
  gestureFace: Record<string, number>;
}

interface ActiveGesture {
  kind: Gesture;
  spec: GestureSpec;
  t: number;
  /** Limb rotations when the gesture started, to blend from. */
  from: Map<Object3D, Quaternion>;
  /** Target limb rotations for the pose. */
  targets: Map<Object3D, Quaternion>;
  frame: GestureFrame;
  weight: number;
}

/** Arm and hand bones that gestures may pose (Mixamo names). */
const LIMB_BONE = /^(Left|Right)(Shoulder|Arm|ForeArm|Hand)/;

/**
 * A loaded, animated humanoid. Owns everything that happens *on* the body:
 * rest pose, idle life (breathing, blinking, glancing), mood, gestures,
 * lip-sync and appearance. The Stage owns the scene around it.
 */
export class Avatar {
  /** Container we position and scale. Add this to the scene. */
  readonly root = new Group();
  readonly kind: "glb" | "vrm";

  private readonly model: Object3D;
  private readonly vrm: VRM | null;
  private readonly builtin?: BuiltinModel;
  private readonly bones: Partial<Record<BoneKey, Object3D>> = {};
  /** Posable arm and hand bones by Mixamo name (GLB rigs only). */
  private readonly limbs = new Map<string, Object3D>();
  private readonly baseQuat = new Map<Object3D, Quaternion>();
  private readonly morphs: MorphController | null;
  private readonly hasOculusVisemes: boolean;
  private readonly vrmCurrent = new Map<string, number>();
  private readonly baseScale: number;
  private readonly footOffset: number;
  private accessories: Group | null = null;
  private accessoryKey = "";

  // Animation state
  private time = 0;
  private mood: Mood = "neutral";
  private blinkT = -1;
  private nextBlink = 1.5;
  private doubleBlink = false;
  private gaze = { x: 0, y: 0 };
  private nextSaccade = 0.8;
  private gesture: ActiveGesture | null = null;
  private energySlow = 0;
  private emphasis = 0;
  private lastEmphasis = 0;
  private wasSpeaking = false;
  private readonly gazeTarget = new Object3D();

  private constructor(gltf: GLTF, source: AvatarSource) {
    this.builtin = source.builtin;
    this.vrm = (gltf.userData.vrm as VRM | undefined) ?? null;
    this.kind = this.vrm ? "vrm" : "glb";

    if (this.vrm) {
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.rotateVRM0(this.vrm);
      this.model = this.vrm.scene;
      const h = this.vrm.humanoid;
      const map: Record<BoneKey, Parameters<typeof h.getNormalizedBoneNode>[0]> = {
        hips: "hips", spine: "spine", chest: "chest", upperChest: "upperChest",
        neck: "neck", head: "head", leftEye: "leftEye", rightEye: "rightEye",
      };
      for (const [k, name] of Object.entries(map) as Array<[BoneKey, typeof map[BoneKey]]>) {
        const node = h.getNormalizedBoneNode(name);
        if (node) this.bones[k] = node;
      }
      if (this.vrm.lookAt) this.vrm.lookAt.target = this.gazeTarget;
      this.morphs = null;
      this.hasOculusVisemes = false;
    } else {
      this.model = gltf.scene;
      const byName = new Map<string, Object3D>();
      this.model.traverse((o) => {
        if (o.name && !byName.has(o.name)) byName.set(o.name, o);
      });
      for (const [k, name] of Object.entries(MIXAMO_NAMES) as Array<[BoneKey, string]>) {
        const node = byName.get(name);
        if (node) this.bones[k] = node;
      }
      if (MIXAMO_CORE_BONES.every((n) => byName.has(n))) {
        for (const [name, [x, y, z]] of Object.entries(STANDING_POSE)) {
          byName.get(name)?.quaternion.setFromEuler(new Euler(x, y, z, "XYZ"));
        }
        for (const name of Object.keys(STANDING_POSE)) {
          const bone = byName.get(name);
          if (bone && LIMB_BONE.test(name)) this.limbs.set(name, bone);
        }
      }
      this.morphs = new MorphController(this.model);
      this.hasOculusVisemes = this.morphs.has("viseme_aa");
    }

    this.model.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Skinned bounds are computed in bind pose and are unreliable once posed.
      mesh.frustumCulled = false;
    });

    this.poseVrmArms();
    this.root.add(this.model);
    this.root.add(this.gazeTarget);

    // Normalise size: some exports are in centimetres, some in metres.
    this.model.updateMatrixWorld(true);
    const box = new Box3().setFromObject(this.model);
    const height = box.max.y - box.min.y;
    this.baseScale = height > 0.5 && height < 3 ? 1 : 1.7 / Math.max(height, 1e-3);
    this.footOffset = -box.min.y;

    // Face the camera (+Z). Eyes sit in front of the head joint; if they are
    // behind it, the model was exported facing -Z.
    const head = this.bones.head;
    const eyeL = this.bones.leftEye;
    if (head && eyeL) {
      const hp = head.getWorldPosition(new Vector3());
      const ep = eyeL.getWorldPosition(new Vector3());
      if (ep.z < hp.z - 0.005) this.model.rotation.y = Math.PI;
    }

    for (const bone of [...Object.values(this.bones), ...this.limbs.values()]) this.baseQuat.set(bone, bone.quaternion.clone());
    this.setHeight(1);
  }

  static async load(source: AvatarSource, onProgress?: (fraction: number) => void): Promise<Avatar> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(source.url, (e) => {
      if (onProgress && e.total) onProgress(e.loaded / e.total);
    });
    return new Avatar(gltf, source);
  }

  /** Available morph target / expression names, for debugging and tools. */
  get expressionNames(): string[] {
    if (this.vrm) return this.vrm.expressionManager?.expressions.map((e) => e.expressionName) ?? [];
    return this.morphs?.names ?? [];
  }

  /** World position of the head joint (for camera framing). */
  headPosition(target = new Vector3()): Vector3 {
    this.root.updateMatrixWorld(true);
    const head = this.bones.head;
    if (head) return head.getWorldPosition(target);
    const box = new Box3().setFromObject(this.model);
    return target.set(0, box.max.y - 0.12, 0);
  }

  /** Current overall height in metres (feet at y = 0). */
  height(): number {
    this.root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(this.model);
    return box.max.y - box.min.y;
  }

  setHeight(multiplier: number): void {
    const s = this.baseScale * multiplier;
    this.root.scale.setScalar(s);
    this.root.position.y = this.footOffset * s;
  }

  setMood(mood: Mood): void {
    this.mood = mood;
  }

  /**
   * Play a gesture. Arm and hand poses need a Mixamo-style rig (all built-in
   * models); on other rigs only the head and face parts play.
   */
  playGesture(kind: Gesture): void {
    const spec = GESTURE_SPECS[kind];
    const from = new Map<Object3D, Quaternion>();
    for (const bone of this.limbs.values()) from.set(bone, bone.quaternion.clone());
    const targets = new Map<Object3D, Quaternion>();
    for (const [name, [x, y, z]] of Object.entries(spec.pose ?? {})) {
      const q = new Quaternion().setFromEuler(new Euler(x, y, z, "XYZ"));
      // Mirror across the body's midplane: swap sides and flip the y/z rotation.
      if (spec.mirror) q.set(q.x, -q.y, -q.z, q.w);
      const bone = this.limbs.get(spec.mirror ? mirrorBoneName(name) : name);
      if (bone) targets.set(bone, q);
    }
    this.gesture = { kind, spec, t: 0, from, targets, frame: emptyFrame(), weight: 0 };
  }

  /** Apply colors, accessories and size. Cheap to call repeatedly. */
  applyAppearance(a: Appearance): void {
    this.setHeight(a.height);
    this.model.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const mats: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        const slot = slotForMaterial(mat.name, this.builtin);
        if (!slot) continue;
        if (slot === "eyewear") {
          mesh.visible = a.glasses === "model";
          continue;
        }
        const hex = a[slot];
        if (this.vrm) tintVrmMaterial(mat, hex);
        else setMaterialTint(mat, slot, hex);
      }
    });

    const key = `${a.glasses}|${a.hat}|${a.accessoryColor}|${a.height}`;
    if (key !== this.accessoryKey) {
      this.accessoryKey = key;
      this.rebuildAccessories(a);
    }
  }

  private rebuildAccessories(a: Appearance): void {
    if (this.accessories) {
      this.accessories.removeFromParent();
      this.accessories.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (m.material as Material).dispose();
        }
      });
      this.accessories = null;
    }
    const frame = this.headFrame();
    if (!frame) return;
    this.accessories = buildAccessories(frame, a.glasses, a.hat, a.accessoryColor);
  }

  /** Measure head landmarks in the un-animated rest pose. */
  private headFrame(): HeadFrame | null {
    const head = this.bones.head;
    if (!head) return null;
    // Temporarily restore rest rotations so accessories are built aligned.
    const saved = new Map<Object3D, Quaternion>();
    for (const [bone, q] of this.baseQuat) {
      saved.set(bone, bone.quaternion.clone());
      bone.quaternion.copy(q);
    }
    if (this.vrm) this.vrm.humanoid.update();
    this.root.updateMatrixWorld(true);

    const hp = head.getWorldPosition(new Vector3());
    const forward = new Vector3(0, 0, 1).applyQuaternion(this.model.getWorldQuaternion(new Quaternion())).normalize();
    const up = new Vector3(0, 1, 0);
    let eyeLeft: Vector3;
    let eyeRight: Vector3;
    if (this.bones.leftEye && this.bones.rightEye) {
      eyeLeft = this.bones.leftEye.getWorldPosition(new Vector3());
      eyeRight = this.bones.rightEye.getWorldPosition(new Vector3());
    } else {
      // Rough estimate for rigs without eye bones.
      const side = new Vector3().crossVectors(up, forward).normalize();
      const scale = this.root.scale.x;
      const center = hp.clone().addScaledVector(up, 0.07 * scale).addScaledVector(forward, 0.08 * scale);
      eyeLeft = center.clone().addScaledVector(side, 0.032 * scale);
      eyeRight = center.clone().addScaledVector(side, -0.032 * scale);
    }
    const frame: HeadFrame = { head, eyeLeft, eyeRight, forward, up, points: this.headPoints() };

    for (const [bone, q] of saved) bone.quaternion.copy(q);
    return frame;
  }

  /**
   * World positions of the vertices that move with the head (skin, hair,
   * brows), so accessories can be fitted to the real shape. Call with the
   * rest pose applied and world matrices up to date.
   */
  private headPoints(): Vector3[] {
    const headBone = this.vrm?.humanoid.getRawBoneNode("head") ?? this.bones.head;
    if (!headBone) return [];
    const headNodes = new Set<Object3D>();
    headBone.traverse((o) => headNodes.add(o));

    const points: Vector3[] = [];
    const v = new Vector3();
    this.model.traverse((o) => {
      const mesh = o as SkinnedMesh;
      if (!mesh.isMesh) return;
      // Rigid (unskinned) meshes only count when they hang off the head.
      if (!mesh.isSkinnedMesh && !headNodes.has(mesh)) return;
      for (let a: Object3D | null = mesh; a; a = a.parent) if (a === this.accessories) return;
      if (slotForMaterial(materialName(mesh), this.builtin) === "eyewear") return;
      const geo = mesh.geometry;
      const pos = geo.getAttribute("position");
      if (!pos) return;
      let isHead: (i: number) => boolean = () => true;
      if (mesh.isSkinnedMesh) {
        const skinIndex = geo.getAttribute("skinIndex");
        const skinWeight = geo.getAttribute("skinWeight");
        if (!skinIndex || !skinWeight) return;
        const headBones = new Set(mesh.skeleton.bones.flatMap((b, i) => (headNodes.has(b) ? [i] : [])));
        if (!headBones.size) return;
        isHead = (i) => {
          let w = 0;
          for (let k = 0; k < 4; k++) if (headBones.has(skinIndex.getComponent(i, k))) w += skinWeight.getComponent(i, k);
          return w > 0.5;
        };
      }
      const stride = Math.max(1, Math.floor(pos.count / 40_000));
      for (let i = 0; i < pos.count; i += stride) {
        if (!isHead(i)) continue;
        mesh.getVertexPosition(i, v);
        points.push(v.clone().applyMatrix4(mesh.matrixWorld));
      }
    });
    return points;
  }

  /** VRM models load in T-pose; lower the arms to a relaxed stance. */
  private poseVrmArms(): void {
    if (!this.vrm) return;
    const h = this.vrm.humanoid;
    const set = (name: Parameters<typeof h.getNormalizedBoneNode>[0], x: number, y: number, z: number) =>
      h.getNormalizedBoneNode(name)?.rotation.set(x, y, z);
    set("leftUpperArm", 0, 0, -1.25);
    set("rightUpperArm", 0, 0, 1.25);
    set("leftLowerArm", 0, -0.25, -0.1);
    set("rightLowerArm", 0, 0.25, 0.1);
    h.update();
  }

  /** Advance animation by dt seconds. */
  update(dt: number, speech: SpeechFrame, behavior: Behavior, camera: Camera): void {
    this.time += dt;
    const t = this.time;
    const expr = behavior.expressiveness;
    const idle = behavior.idleMotion;

    // --- speech dynamics ---------------------------------------------------
    this.energySlow += (speech.energy - this.energySlow) * (1 - Math.exp(-3 * dt));
    if (speech.speaking && speech.energy - this.energySlow > 0.3 && t - this.lastEmphasis > 0.7) {
      this.emphasis = 1;
      this.lastEmphasis = t;
    }
    this.emphasis *= Math.exp(-4 * dt);
    if (this.wasSpeaking && !speech.speaking) this.nextBlink = Math.min(this.nextBlink, t + 0.25);
    this.wasSpeaking = speech.speaking;

    // --- blinking ----------------------------------------------------------
    let blink = 0;
    if (this.blinkT < 0 && t >= this.nextBlink) this.blinkT = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const p = this.blinkT;
      blink = p < 0.07 ? p / 0.07 : p < 0.1 ? 1 : p < 0.2 ? 1 - (p - 0.1) / 0.1 : 0;
      if (p >= 0.2) {
        this.blinkT = -1;
        if (!this.doubleBlink && Math.random() < 0.15) {
          this.doubleBlink = true;
          this.nextBlink = t + 0.12;
        } else {
          this.doubleBlink = false;
          this.nextBlink = t + 2 + Math.random() * 4;
        }
      }
    }

    // --- gaze (saccades) ----------------------------------------------------
    if (t >= this.nextSaccade) {
      const lookAtCamera = Math.random() < (speech.speaking ? 0.35 + 0.6 * behavior.eyeContact : 0.2 + 0.7 * behavior.eyeContact);
      this.gaze = lookAtCamera
        ? { x: (Math.random() - 0.5) * 0.08, y: (Math.random() - 0.5) * 0.06 }
        : { x: (Math.random() - 0.5) * 0.7, y: (Math.random() - 0.4) * 0.35 };
      this.nextSaccade = t + (lookAtCamera ? 1.2 + Math.random() * 2.5 : 0.4 + Math.random() * 1.2);
    }

    // --- body & head --------------------------------------------------------
    const moodPreset = MOOD_PRESETS[this.mood];
    const head = new Euler(
      idle * (0.018 * Math.sin(t * 0.61) + 0.01 * Math.sin(t * 1.37 + 1)) + moodPreset.head.x * expr,
      idle * (0.03 * Math.sin(t * 0.43 + 2) + 0.012 * Math.sin(t * 1.1)) + moodPreset.head.y * expr,
      idle * 0.015 * Math.sin(t * 0.37 + 4) + moodPreset.head.z * expr,
    );
    if (speech.speaking) {
      const e = this.energySlow * expr;
      head.x += 0.035 * e * Math.sin(t * 2.3) + 0.05 * this.emphasis * expr;
      head.y += 0.04 * e * Math.sin(t * 1.3 + 1);
      head.z += 0.02 * e * Math.sin(t * 1.7 + 2);
    }
    // The head follows the eyes a little.
    head.y += this.gaze.x * 0.12;
    head.x -= this.gaze.y * 0.08;
    const gesture = this.advanceGesture(dt);
    if (gesture) {
      head.x += gesture.head.x;
      head.y += gesture.head.y;
      head.z += gesture.head.z;
    }

    const breathe = Math.sin(t * Math.PI * 2 * 0.22) * idle;
    this.offsetBone("head", head.x * 0.6, head.y * 0.6, head.z * 0.6);
    this.offsetBone("neck", head.x * 0.4, head.y * 0.4, head.z * 0.4);
    this.offsetBone("upperChest", 0.012 * breathe, 0, 0);
    this.offsetBone("chest", 0.006 * breathe, 0.01 * idle * Math.sin(t * 0.29), 0.006 * idle * Math.sin(t * 0.23 + 1));
    this.offsetBone("spine", 0, 0, 0.008 * idle * Math.sin(t * 0.19 + 3));
    this.applyGesturePose();

    // --- face --------------------------------------------------------------
    const arkit: Record<string, number> = {};
    for (const [k, v] of Object.entries(moodPreset.face)) arkit[k] = v * expr;
    arkit.browInnerUp = (arkit.browInnerUp ?? 0) + 0.3 * this.emphasis * expr;
    arkit.browOuterUpLeft = (arkit.browOuterUpLeft ?? 0) + 0.15 * this.emphasis * expr;
    arkit.browOuterUpRight = (arkit.browOuterUpRight ?? 0) + 0.15 * this.emphasis * expr;
    if (speech.speaking) {
      // Smiles fight with lip shapes; soften them while talking.
      for (const k of ["mouthSmileLeft", "mouthSmileRight"]) if (arkit[k]) arkit[k] *= 0.6;
    }

    this.applyFace(
      { arkit, visemes: speech.visemes, mood: this.mood, moodAmount: expr, blink, gaze: this.gaze, gestureFace: gesture?.face ?? {} },
      dt,
      camera,
    );

    if (this.vrm) this.vrm.update(dt);
  }

  private offsetBone(key: BoneKey, x: number, y: number, z: number): void {
    const bone = this.bones[key];
    const base = bone && this.baseQuat.get(bone);
    if (!bone || !base) return;
    bone.quaternion.copy(base).multiply(new Quaternion().setFromEuler(new Euler(x, y, z)));
  }

  /** Advance the current gesture and return this frame's contribution. */
  private advanceGesture(dt: number): GestureFrame | null {
    const g = this.gesture;
    if (!g) return null;
    g.t += dt;
    const { duration, attack = 0.2, release = 0.3 } = g.spec;
    if (g.t >= duration) {
      for (const bone of this.limbs.values()) bone.quaternion.copy(this.baseQuat.get(bone)!);
      this.gesture = null;
      return null;
    }
    const ease = (x: number) => {
      const c = Math.max(0, Math.min(1, x));
      return c * c * (3 - 2 * c);
    };
    const inW = ease(g.t / attack);
    const outW = ease((duration - g.t) / release);
    g.weight = Math.min(inW, outW);
    g.frame = emptyFrame();
    g.spec.animate?.(g.t, g.weight, g.frame);
    return g.frame;
  }

  /** Blend limbs toward the gesture pose, then add its per-bone motion. */
  private applyGesturePose(): void {
    const g = this.gesture;
    if (!g) return;
    const inW = Math.min(1, g.t / (g.spec.attack ?? 0.2));
    const { weight } = g;
    for (const bone of this.limbs.values()) {
      const base = this.baseQuat.get(bone)!;
      const target = g.targets.get(bone) ?? base;
      // Blend in from wherever the limb was (so gestures can interrupt each
      // other smoothly), and out to the rest pose.
      if (inW < 1) bone.quaternion.slerpQuaternions(g.from.get(bone)!, target, weight);
      else bone.quaternion.slerpQuaternions(base, target, weight);
    }
    const q = new Quaternion();
    for (const [name, [x, y, z]] of Object.entries(g.frame.bones)) {
      const bone = this.limbs.get(g.spec.mirror ? mirrorBoneName(name) : name) ?? this.bones[name as BoneKey];
      if (!bone) continue;
      q.setFromEuler(new Euler(x, y, z));
      if (g.spec.mirror && this.limbs.has(mirrorBoneName(name))) q.set(q.x, -q.y, -q.z, q.w);
      bone.quaternion.multiply(q);
    }
  }

  private applyFace(face: FaceState, dt: number, camera: Camera): void {
    if (this.vrm) {
      this.applyVrmFace(face, dt, camera);
      return;
    }
    const morphs = this.morphs!;
    const targets = face.arkit;
    for (const [k, v] of Object.entries(face.gestureFace)) targets[k] = Math.max(targets[k] ?? 0, v);

    targets.eyeBlinkLeft = Math.max(targets.eyeBlinkLeft ?? 0, face.blink);
    targets.eyeBlinkRight = Math.max(targets.eyeBlinkRight ?? 0, face.blink);

    const { x, y } = face.gaze;
    if (x > 0) {
      targets.eyeLookOutLeft = (targets.eyeLookOutLeft ?? 0) + x;
      targets.eyeLookInRight = (targets.eyeLookInRight ?? 0) + x;
    } else {
      targets.eyeLookInLeft = (targets.eyeLookInLeft ?? 0) - x;
      targets.eyeLookOutRight = (targets.eyeLookOutRight ?? 0) - x;
    }
    const upKey = y > 0 ? "Up" : "Down";
    targets[`eyeLook${upKey}Left`] = (targets[`eyeLook${upKey}Left`] ?? 0) + Math.abs(y);
    targets[`eyeLook${upKey}Right`] = (targets[`eyeLook${upKey}Right`] ?? 0) + Math.abs(y);

    for (const [v, w] of Object.entries(face.visemes) as Array<[Viseme, number]>) {
      if (!w) continue;
      if (this.hasOculusVisemes) {
        const name = oculusMorphName(v);
        targets[name] = Math.max(targets[name] ?? 0, w);
      } else {
        for (const [shape, amount] of Object.entries(VISEME_TO_ARKIT[v])) {
          targets[shape] = Math.max(targets[shape] ?? 0, amount * w);
        }
      }
    }

    morphs.update(targets, dt, morphSpeed);
  }

  private applyVrmFace(face: FaceState, dt: number, camera: Camera): void {
    const em = this.vrm!.expressionManager;
    const targets: Record<string, number> = { blink: face.blink };
    for (const [k, v] of Object.entries(MOOD_PRESETS[face.mood].vrm)) targets[k] = (v ?? 0) * face.moodAmount;
    for (const [k, v] of Object.entries(face.gestureFace)) {
      for (const [name, amount] of ARKIT_TO_VRM[k] ?? []) targets[name] = Math.max(targets[name] ?? 0, v * amount);
    }
    for (const [v, w] of Object.entries(face.visemes) as Array<[Viseme, number]>) {
      for (const [shape, amount] of Object.entries(VISEME_TO_VRM[v])) {
        targets[shape] = Math.max(targets[shape] ?? 0, (amount ?? 0) * w);
      }
    }
    if (em) {
      for (const expr of em.expressions) {
        const name = expr.expressionName;
        const target = targets[name] ?? 0;
        const prev = this.vrmCurrent.get(name) ?? 0;
        const k = 1 - Math.exp(-morphSpeed(name) * dt);
        const next = prev + (target - prev) * k;
        this.vrmCurrent.set(name, next);
        em.setValue(name, next);
      }
    }
    // Look at the camera, offset by the current saccade.
    const camPos = camera.getWorldPosition(new Vector3());
    this.root.worldToLocal(camPos);
    this.gazeTarget.position.set(camPos.x + face.gaze.x * 0.6, camPos.y + face.gaze.y * 0.4, camPos.z);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) m.dispose();
    });
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
  }
}

function emptyFrame(): GestureFrame {
  return { head: { x: 0, y: 0, z: 0 }, face: {}, bones: {} };
}

function materialName(mesh: Mesh): string {
  return (Array.isArray(mesh.material) ? mesh.material[0]?.name : mesh.material.name) ?? "";
}

function morphSpeed(name: string): number {
  if (name.startsWith("viseme_") || name.startsWith("mouth") || name.startsWith("jaw") || name === "tongueOut") return 22;
  if (["aa", "ih", "ou", "ee", "oh"].includes(name)) return 22;
  if (name.startsWith("eyeBlink") || name === "blink") return 45;
  if (name.startsWith("eyeLook")) return 18;
  return 5;
}

/** VRM MToon materials expose `color`; tint it and remember the original. */
function tintVrmMaterial(mat: Material, hex: string | null): void {
  const m = mat as Material & { color?: Color };
  if (!m.color) return;
  const original = (m.userData.agentarOriginalColor as Color | undefined) ?? m.color.clone();
  m.userData.agentarOriginalColor = original;
  if (hex === null) m.color.copy(original);
  else m.color.set(hex);
}
