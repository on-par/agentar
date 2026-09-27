import type { Mesh, Object3D } from "three";

interface Binding {
  mesh: Mesh;
  index: number;
}

/**
 * Drives morph targets (blendshapes) by name across every mesh of a model.
 * Realistic rigs split the face over several meshes (head, teeth, tongue,
 * eyelashes, eyebrows) that each carry the same target names, so a single
 * `jawOpen` must move all of them together.
 *
 * Each frame the caller supplies the *target* weights; the controller eases
 * the current weights toward them so nothing ever pops.
 */
export class MorphController {
  private readonly bindings = new Map<string, Binding[]>();
  private readonly current = new Map<string, number>();

  constructor(root: Object3D) {
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
      for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
        const list = this.bindings.get(name) ?? [];
        list.push({ mesh, index });
        this.bindings.set(name, list);
      }
    });
  }

  get names(): string[] {
    return [...this.bindings.keys()];
  }

  has(name: string): boolean {
    return this.bindings.has(name);
  }

  get(name: string): number {
    return this.current.get(name) ?? 0;
  }

  /**
   * Ease every known target toward `targets` (missing names ease to 0).
   * @param speed per-name easing speed in 1/s; higher is snappier.
   */
  update(targets: Record<string, number>, dt: number, speed: (name: string) => number): void {
    for (const [name, list] of this.bindings) {
      const target = clamp01(targets[name] ?? 0);
      const prev = this.current.get(name) ?? 0;
      const k = 1 - Math.exp(-speed(name) * dt);
      const next = prev + (target - prev) * k;
      const value = Math.abs(next) < 1e-4 ? 0 : next;
      this.current.set(name, value);
      for (const { mesh, index } of list) mesh.morphTargetInfluences![index] = value;
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
