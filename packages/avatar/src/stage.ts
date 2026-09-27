import {
  ACESFilmicToneMapping,
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Timer,
  Vector3,
  WebGLRenderer,
  type Texture,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { AvatarConfig, Framing, Lighting } from "@agentar/core";
import type { Avatar } from "./avatar.js";
import { SpeechPlayer } from "./speech.js";

export interface StageOptions {
  /** Allow orbiting/zooming with the mouse. Default true. */
  interactive?: boolean;
  /** Preserve the drawing buffer (needed for canvas capture / screenshots). */
  preserveDrawingBuffer?: boolean;
}

interface LightRig {
  hemi: HemisphereLight;
  key: DirectionalLight;
  fill: DirectionalLight;
  rim: DirectionalLight;
}

const LIGHTING: Record<Lighting, { sky: number; ground: number; hemi: number; key: [number, number]; fill: [number, number]; rim: [number, number]; env: number }> = {
  studio: { sky: 0xffffff, ground: 0x445066, hemi: 0.5, key: [0xffffff, 2.2], fill: [0xdfe8ff, 0.8], rim: [0xffffff, 1.6], env: 0.55 },
  warm: { sky: 0xffe6c8, ground: 0x5a4030, hemi: 0.55, key: [0xffd2a0, 2.3], fill: [0xffe0c0, 0.7], rim: [0xffb070, 1.4], env: 0.5 },
  cool: { sky: 0xd8e8ff, ground: 0x223044, hemi: 0.5, key: [0xe0ecff, 2.1], fill: [0xa0c0ff, 0.8], rim: [0x80b0ff, 1.8], env: 0.55 },
  dramatic: { sky: 0x8090a0, ground: 0x101010, hemi: 0.15, key: [0xffffff, 3.2], fill: [0x8090ff, 0.15], rim: [0xffffff, 2.6], env: 0.2 },
};

/**
 * The 3D scene around an avatar: renderer, camera, lights, framing and the
 * render loop. Also owns the SpeechPlayer so audio and animation share one
 * clock.
 */
export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(28, 1, 0.05, 50);
  readonly speech = new SpeechPlayer();
  readonly controls: OrbitControls | null;

  private readonly lights: LightRig;
  private readonly floor: Mesh;
  private readonly envMap: Texture;
  private readonly timer = new Timer();
  private readonly resizeObserver: ResizeObserver;
  private avatar: Avatar | null = null;
  private config: AvatarConfig | null = null;
  private framing: Framing | null = null;
  private camGoal = { pos: new Vector3(0, 1.5, 2), target: new Vector3(0, 1.5, 0) };
  private camMoving = 0;
  private frameHandle = 0;
  private listeners = new Set<(dt: number) => void>();

  constructor(private readonly container: HTMLElement, opts: StageOptions = {}) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";

    // Image-based lighting gives skin and cloth believable reflections.
    const pmrem = new PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.envMap;

    const hemi = new HemisphereLight(0xffffff, 0x444444, 0.5);
    const key = new DirectionalLight(0xffffff, 2);
    key.position.set(1.2, 2.6, 2.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 8;
    key.shadow.camera.left = -1.2;
    key.shadow.camera.right = 1.2;
    key.shadow.camera.top = 2.2;
    key.shadow.camera.bottom = -0.2;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    const fill = new DirectionalLight(0xffffff, 0.8);
    fill.position.set(-2, 1.6, 1.5);
    const rim = new DirectionalLight(0xffffff, 1.5);
    rim.position.set(-0.6, 2.4, -2.2);
    this.scene.add(hemi, key, fill, rim);
    this.lights = { hemi, key, fill, rim };

    this.floor = new Mesh(new CircleGeometry(1.6, 64), new ShadowMaterial({ opacity: 0.28 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    if (opts.interactive ?? true) {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.enablePan = false;
      this.controls.minDistance = 0.35;
      this.controls.maxDistance = 6;
      this.controls.addEventListener("start", () => (this.camMoving = 0));
    } else {
      this.controls = null;
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  get currentAvatar(): Avatar | null {
    return this.avatar;
  }

  /** Swap in a new avatar (the previous one is disposed). */
  setAvatar(avatar: Avatar): void {
    this.speech.stop();
    this.avatar?.dispose();
    this.avatar = avatar;
    this.scene.add(avatar.root);
    if (this.config) avatar.applyAppearance(this.config.appearance);
    if (this.config) avatar.setMood(this.config.behavior.mood);
    this.framing = null;
    if (this.config) this.frame(this.config.scene.framing, true);
  }

  /** Apply scene, appearance and behaviour settings from a config. */
  applyConfig(config: AvatarConfig): void {
    const prev = this.config;
    this.config = config;
    this.scene.background = new Color(config.scene.background);
    this.floor.visible = config.scene.showFloor;
    this.applyLighting(config.scene.lighting);
    if (this.avatar) {
      this.avatar.applyAppearance(config.appearance);
      if (!prev || prev.behavior.mood !== config.behavior.mood) this.avatar.setMood(config.behavior.mood);
      if (!prev || prev.appearance.height !== config.appearance.height) this.framing = null;
    }
    this.frame(config.scene.framing);
  }

  /** Move the camera to a preset shot of the avatar. */
  frame(framing: Framing, instant = false): void {
    if (!this.avatar) return;
    if (framing === this.framing && !instant) return;
    this.framing = framing;
    const head = this.avatar.headPosition();
    const height = this.avatar.height();
    const aspect = this.camera.aspect || 1;
    // Portrait viewports need more distance to fit the same shot.
    const fit = aspect < 1 ? 1 / Math.max(aspect, 0.45) : 1;
    let target: Vector3;
    let dist: number;
    if (framing === "head") {
      target = head.clone().add(new Vector3(0, 0.06, 0));
      dist = 0.85 * fit;
    } else if (framing === "bust") {
      target = head.clone().add(new Vector3(0, -0.12, 0));
      dist = 1.35 * fit;
    } else {
      target = new Vector3(0, height * 0.52, 0);
      dist = (height * 2.35 + 0.3) * Math.max(1, fit * 0.8);
    }
    const pos = target.clone().add(new Vector3(0, 0.02 * dist, dist));
    this.camGoal = { pos, target };
    if (instant) {
      this.camera.position.copy(pos);
      this.controls?.target.copy(target);
      this.camera.lookAt(target);
      this.camMoving = 0;
    } else {
      this.camMoving = 1;
    }
  }

  /** Run a callback every frame (after animation, before render). */
  onFrame(fn: (dt: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
    this.speech.stop();
    this.avatar?.dispose();
    this.controls?.dispose();
    this.envMap.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private applyLighting(name: Lighting): void {
    const l = LIGHTING[name];
    this.lights.hemi.color.set(l.sky);
    this.lights.hemi.groundColor.set(l.ground);
    this.lights.hemi.intensity = l.hemi;
    this.lights.key.color.set(l.key[0]);
    this.lights.key.intensity = l.key[1];
    this.lights.fill.color.set(l.fill[0]);
    this.lights.fill.intensity = l.fill[1];
    this.lights.rim.color.set(l.rim[0]);
    this.lights.rim.intensity = l.rim[1];
    this.scene.environmentIntensity = l.env;
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.config && this.framing) {
      const f = this.framing;
      this.framing = null;
      this.frame(f);
    }
  }

  private loop = (): void => {
    this.frameHandle = requestAnimationFrame(this.loop);
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);

    if (this.camMoving > 0) {
      const k = 1 - Math.exp(-5 * dt);
      this.camera.position.lerp(this.camGoal.pos, k);
      const target = this.controls ? this.controls.target : new Vector3();
      target.lerp(this.camGoal.target, k);
      this.camera.lookAt(target);
      if (this.camera.position.distanceTo(this.camGoal.pos) < 0.002) this.camMoving = 0;
    }
    this.controls?.update();

    if (this.avatar && this.config) {
      this.avatar.update(dt, this.speech.frame(), this.config.behavior, this.camera);
    }
    for (const fn of this.listeners) fn(dt);
    this.renderer.render(this.scene, this.camera);
  };
}
