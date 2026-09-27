import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Path,
  QuadraticBezierCurve3,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  type Material,
  type Object3D,
} from "three";
import type { Glasses, Hat } from "@agentar/core";

/**
 * Head landmarks in world space, measured once in the rest pose. All
 * accessory sizes derive from the distance between the eyes so they fit
 * any head size, and hats and glasses are fitted to the measured surface.
 */
export interface HeadFrame {
  head: Object3D;
  eyeLeft: Vector3;
  eyeRight: Vector3;
  /** Unit vector the face points toward. */
  forward: Vector3;
  up: Vector3;
  /** World-space vertices that move with the head (skin, hair, brows), in the rest pose. */
  points: Vector3[];
}

/**
 * Build accessories and attach them to the head bone. Returns the group.
 *
 * Everything is modelled in "eye units": origin between the eyes, +X to the
 * model's left→right as seen from the front, +Y up, +Z forward, and 1 unit =
 * the distance between the eyes. The group is then scaled to world size.
 */
export function buildAccessories(frame: HeadFrame, glasses: Glasses, hat: Hat, color: string): Group | null {
  if ((glasses === "none" || glasses === "model") && hat === "none") return null;

  const ipd = frame.eyeLeft.distanceTo(frame.eyeRight);
  const mid = frame.eyeLeft.clone().add(frame.eyeRight).multiplyScalar(0.5);
  const right = new Vector3().crossVectors(frame.up, frame.forward).normalize();
  const up = new Vector3().crossVectors(frame.forward, right).normalize();
  const basis = new Matrix4().makeBasis(right, up, frame.forward);

  const group = new Group();
  group.name = "agentar-accessories";
  group.quaternion.setFromRotationMatrix(basis);
  group.position.copy(mid);
  group.scale.setScalar(ipd);

  const toLocal = new Matrix4().makeBasis(right, up, frame.forward).invert();
  const local = frame.points.map((p) => p.clone().sub(mid).applyMatrix4(toLocal).divideScalar(ipd));
  const head = HeadShape.fromPoints(local.length >= 200 ? local : syntheticHead());

  if (glasses === "round" || glasses === "square") group.add(buildGlasses(head, glasses, color));
  if (hat === "beanie") group.add(buildBeanie(head.smoothed(1), color));
  if (hat === "cap") group.add(buildCap(head.smoothed(3), color));

  // Attach to the head bone while keeping the world transform.
  group.updateMatrixWorld(true);
  frame.head.attach(group);
  return group;
}

// ---------------------------------------------------------------------------
// Head surface
// ---------------------------------------------------------------------------

const AZ_BINS = 96;
const EL_BINS = 48;

/**
 * The outer surface of the head (including hair) as a radius for every
 * direction from a centre point, in eye units. Built by keeping the farthest
 * vertex in each direction bin, then filling gaps and smoothing, so hats
 * shrink-wrap over hair instead of floating above it.
 */
class HeadShape {
  private constructor(
    readonly center: Vector3,
    private readonly grid: Float32Array,
    /** Raw points, for local measurements (glasses). */
    readonly points: Vector3[],
  ) {}

  static fromPoints(points: Vector3[]): HeadShape {
    // Centre: middle of the skull above the eyes.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
      if (p.y < 0 || p.y > 1.2) continue;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const center = new Vector3((minX + maxX) / 2, 0.35, (minZ + maxZ) / 2);

    const grid = new Float32Array(AZ_BINS * EL_BINS).fill(-1);
    const d = new Vector3();
    for (const p of points) {
      d.subVectors(p, center);
      const r = d.length();
      if (r < 1e-6) continue;
      const i = binIndex(d.divideScalar(r));
      if (r > grid[i]!) grid[i] = r;
    }

    // Fill empty bins from their neighbours until none are left.
    for (let pass = 0; pass < 64 && grid.includes(-1); pass++) {
      const next = grid.slice();
      for (let e = 0; e < EL_BINS; e++) {
        for (let a = 0; a < AZ_BINS; a++) {
          if (grid[e * AZ_BINS + a]! >= 0) continue;
          let sum = 0, n = 0;
          for (const [da, de] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const ee = e + de;
            if (ee < 0 || ee >= EL_BINS) continue;
            const v = grid[ee * AZ_BINS + ((a + da + AZ_BINS) % AZ_BINS)]!;
            if (v >= 0) (sum += v), n++;
          }
          if (n) next[e * AZ_BINS + a] = sum / n;
        }
      }
      grid.set(next);
    }

    // Below the middle of the skull the surface may only curve inward, so a
    // ponytail or long hair does not make hats flare out at the back.
    const equator = Math.floor(EL_BINS / 2);
    for (let e = equator - 1; e >= 0; e--) {
      for (let a = 0; a < AZ_BINS; a++) {
        const above = grid[(e + 1) * AZ_BINS + a]!;
        grid[e * AZ_BINS + a] = Math.min(grid[e * AZ_BINS + a]!, above * 1.01);
      }
    }

    // Close up the dips between hair strands, then smooth.
    dilate(grid);
    for (let i = 0; i < 3; i++) blur(grid);
    return new HeadShape(center, grid, points);
  }

  /** A copy with extra smoothing, for stiffer shapes like a cap crown. */
  smoothed(passes: number): HeadShape {
    const grid = this.grid.slice();
    for (let i = 0; i < passes; i++) blur(grid);
    return new HeadShape(this.center, grid, this.points);
  }

  /** Radius of the head surface in unit direction `dir` (bilinear). */
  radius(dir: Vector3): number {
    const az = Math.atan2(dir.x, dir.z);
    const el = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    const fa = ((az + Math.PI) / (2 * Math.PI)) * AZ_BINS - 0.5;
    const fe = Math.max(0, Math.min(EL_BINS - 1, ((el + Math.PI / 2) / Math.PI) * EL_BINS - 0.5));
    const a0 = Math.floor(fa), e0 = Math.floor(fe);
    const ta = fa - a0, te = fe - e0;
    const e1 = Math.min(EL_BINS - 1, e0 + 1);
    const at = (a: number, e: number) => this.grid[e * AZ_BINS + ((a + AZ_BINS * 2) % AZ_BINS)]!;
    const lo = at(a0, e0) * (1 - ta) + at(a0 + 1, e0) * ta;
    const hi = at(a0, e1) * (1 - ta) + at(a0 + 1, e1) * ta;
    return lo * (1 - te) + hi * te;
  }

  /** Point on the surface in direction (azimuth from +Z toward +X, elevation), pushed out by `offset`. */
  surface(az: number, el: number, offset = 0): Vector3 {
    const dir = new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    return dir.clone().multiplyScalar(this.radius(dir) + offset).add(this.center);
  }

  /** Elevation at which the surface at azimuth `az` reaches height `y`. */
  elevationAt(az: number, y: number): number {
    let el = 0;
    for (let i = 0; i < 6; i++) {
      const r = this.radius(new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)));
      el = Math.asin(Math.max(-0.99, Math.min(0.99, (y - this.center.y) / r)));
    }
    return el;
  }
}

function binIndex(dir: Vector3): number {
  const az = Math.atan2(dir.x, dir.z);
  const el = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  const a = Math.min(AZ_BINS - 1, Math.floor(((az + Math.PI) / (2 * Math.PI)) * AZ_BINS));
  const e = Math.min(EL_BINS - 1, Math.floor(((el + Math.PI / 2) / Math.PI) * EL_BINS));
  return e * AZ_BINS + a;
}

function dilate(grid: Float32Array): void {
  const src = grid.slice();
  for (let e = 0; e < EL_BINS; e++) {
    for (let a = 0; a < AZ_BINS; a++) {
      let m = src[e * AZ_BINS + a]!;
      for (let da = -1; da <= 1; da++) {
        for (let de = -1; de <= 1; de++) {
          const ee = e + de;
          if (ee < 0 || ee >= EL_BINS) continue;
          m = Math.max(m, src[ee * AZ_BINS + ((a + da + AZ_BINS) % AZ_BINS)]!);
        }
      }
      grid[e * AZ_BINS + a] = m;
    }
  }
}

function blur(grid: Float32Array): void {
  const src = grid.slice();
  for (let e = 0; e < EL_BINS; e++) {
    for (let a = 0; a < AZ_BINS; a++) {
      let sum = 0, n = 0;
      for (let da = -1; da <= 1; da++) {
        for (let de = -1; de <= 1; de++) {
          const ee = e + de;
          if (ee < 0 || ee >= EL_BINS) continue;
          sum += src[ee * AZ_BINS + ((a + da + AZ_BINS) % AZ_BINS)]!;
          n++;
        }
      }
      grid[e * AZ_BINS + a] = sum / n;
    }
  }
}

/** A plausible head for rigs whose head vertices could not be found. */
function syntheticHead(): Vector3[] {
  const pts: Vector3[] = [];
  for (let i = 0; i < 4000; i++) {
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    pts.push(new Vector3(s * Math.cos(t) * 1.25, u * 1.6 + 0.35, s * Math.sin(t) * 1.5 - 1.0));
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Hats
// ---------------------------------------------------------------------------

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Height of a hat's lower edge above the eyes, blending front → side → back. */
function rimHeight(az: number, front: number, side: number, back: number): number {
  const f = Math.cos(az);
  return f >= 0 ? side + (front - side) * f * f : side + (back - side) * f * f;
}

/**
 * A shell that follows the head from its lower edge (rimHeight) to the crown.
 * `offset(v, az, heightAboveRim)` pushes the surface out (v: 0 at the edge, 1 at the top).
 */
function crownGeometry(
  head: HeadShape,
  rim: (az: number) => number,
  offset: (v: number, az: number, h: number) => number,
  azSegments: number,
  elSegments: number,
): { geometry: BufferGeometry; edge: Vector3[]; edgeInner: Vector3[] } {
  const topEl = Math.PI / 2 - 0.02;
  const positions: number[] = [];
  const edge: Vector3[] = [];
  const edgeInner: Vector3[] = [];
  // Radius near the top is averaged so the pole closes smoothly.
  let topR = 0;
  for (let a = 0; a < 32; a++) topR += head.radius(new Vector3(Math.sin(a) * 0.17, 0.985, Math.cos(a) * 0.17).normalize());
  topR /= 32;

  for (let i = 0; i <= elSegments; i++) {
    const v = i / elSegments;
    for (let j = 0; j <= azSegments; j++) {
      const az = (j / azSegments) * Math.PI * 2 - Math.PI;
      const y0 = rim(az);
      const el0 = head.elevationAt(az, y0);
      // Spend more rings near the edge, where the shape changes most.
      const el = el0 + (topEl - el0) * (1 - Math.cos((v * Math.PI) / 2));
      const dir = new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      const k = smoothstep(1.2, 1.5, el);
      const r = head.radius(dir) * (1 - k) + topR * k;
      const h = head.center.y + dir.y * r - y0;
      const p = dir.clone().multiplyScalar(r + offset(v, az, h)).add(head.center);
      positions.push(p.x, p.y, p.z);
      if (i === 0 && j < azSegments) {
        edge.push(p);
        edgeInner.push(dir.clone().multiplyScalar(r).add(head.center));
      }
    }
  }
  const index: number[] = [];
  const row = azSegments + 1;
  for (let i = 0; i < elSegments; i++) {
    for (let j = 0; j < azSegments; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      index.push(a, b, c, b, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return { geometry, edge, edgeInner };
}

/** A rounded lip that closes the gap between a hat's edge and the head. */
function rolledEdge(edge: Vector3[], inner: Vector3[], material: Material): Mesh {
  const mids = edge.map((p, i) => p.clone().add(inner[i]!).multiplyScalar(0.5));
  const radius = edge.reduce((s, p, i) => s + p.distanceTo(inner[i]!), 0) / edge.length / 2;
  const curve = new CatmullRomCurve3(mids, true, "centripetal");
  return new Mesh(new TubeGeometry(curve, edge.length, radius, 10, true), material);
}

function buildBeanie(head: HeadShape, color: string): Group {
  const g = new Group();
  const knit = new MeshStandardMaterial({ color, roughness: 0.95, metalness: 0, side: DoubleSide });
  const rim = (az: number) => rimHeight(az, 0.8, 0.45, -0.25);
  const cuffTop = 0.62;
  const { geometry, edge, edgeInner } = crownGeometry(
    head,
    rim,
    (v, az, h) => {
      const cuff = 1 - smoothstep(cuffTop - 0.06, cuffTop + 0.04, h);
      const rib = 0.5 + 0.5 * Math.cos(az * 72);
      return (
        0.07 + // knit thickness and a little slack
        0.2 * Math.pow(v, 2.2) + // soft slouch at the top
        cuff * (0.09 + 0.022 * rib) + // folded cuff with ribbing
        (1 - cuff) * 0.01 * rib
      );
    },
    288,
    40,
  );
  g.add(new Mesh(geometry, knit));
  g.add(rolledEdge(edge, edgeInner, knit));
  return g;
}

function buildCap(head: HeadShape, color: string): Group {
  const g = new Group();
  const fabric = new MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, side: DoubleSide });
  const rim = (az: number) => rimHeight(az, 0.95, 0.55, 0.3);
  const { geometry, edge, edgeInner } = crownGeometry(
    head,
    rim,
    // Structured front panels stand a little proud of the forehead.
    (v, az) => 0.05 + 0.06 * Math.sin(v * Math.PI) * Math.max(0, Math.cos(az)),
    128,
    28,
  );
  g.add(new Mesh(geometry, fabric));
  g.add(rolledEdge(edge, edgeInner, fabric));

  // Button on top.
  const top = head.surface(0, Math.PI / 2 - 0.02, 0.05);
  const button = new Mesh(new SphereGeometry(0.1, 20, 10), fabric);
  button.scale.set(1, 0.45, 1);
  button.position.copy(top);
  g.add(button);

  // Brim: a curved visor growing out of the front edge.
  const azMax = 1.2;
  const cols = 40;
  const rows = 10;
  const positions: number[] = [];
  const outer: Vector3[] = [];
  for (let i = 0; i <= rows; i++) {
    const s = i / rows;
    for (let j = 0; j <= cols; j++) {
      const az = (j / cols) * 2 * azMax - azMax;
      const el0 = head.elevationAt(az, rim(az));
      // Start just inside the crown so the seam is hidden.
      const base = head.surface(az, el0 + 0.03, 0.03);
      const across = az / azMax;
      const len = 1.3 * Math.sqrt(Math.max(0, 1 - across * across)) + 0.02;
      const out = new Vector3(Math.sin(az), 0, Math.cos(az)).lerp(new Vector3(0, 0, 1), 0.55).normalize();
      const p = base
        .clone()
        .addScaledVector(out, len * s)
        .add(new Vector3(0, -0.2 * s * len - 0.18 * across * across * s, 0));
      positions.push(p.x, p.y, p.z);
      if (i === rows) outer.push(p);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j, b = a + 1, c = a + cols + 1, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const brimGeo = new BufferGeometry();
  brimGeo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  brimGeo.setIndex(index);
  brimGeo.computeVertexNormals();
  g.add(new Mesh(brimGeo, fabric));
  const lip = new CatmullRomCurve3(outer);
  g.add(new Mesh(new TubeGeometry(lip, 48, 0.025, 8, false), fabric));
  return g;
}

// ---------------------------------------------------------------------------
// Glasses
// ---------------------------------------------------------------------------

function buildGlasses(head: HeadShape, style: "round" | "square", color: string): Group {
  const g = new Group();
  const round = style === "round";
  const frameMat = round
    ? new MeshPhysicalMaterial({ color, roughness: 0.28, metalness: 0.85 })
    : new MeshPhysicalMaterial({ color, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.15 });
  const lensMat = new MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.02,
    metalness: 0,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    side: DoubleSide,
  });

  const lensW = round ? 0.64 : 0.84;
  const lensH = round ? 0.64 : 0.6;
  const band = round ? 0.03 : 0.06;
  const outline = (inset: number) =>
    round ? circlePath(lensW / 2 - inset) : roundedRectPath(lensW - 2 * inset, lensH - 2 * inset, 0.22 - inset * 0.6);

  // Put the frame just in front of the face: find the most forward skin,
  // brow or lash point behind any part of the frame outline or the bridge.
  const behind: Array<[number, number]> = [];
  for (const side of [-1, 1]) {
    for (const p of outline(0).getSpacedPoints(48)) {
      const x = side * 0.5 + p.x;
      const y = p.y - 0.02;
      // The lower inner corners may overlap the sides of the nose; the bridge rests on it.
      if (Math.abs(x) > 0.24 || y > 0.05) behind.push([x, y]);
    }
  }
  const depths: number[] = [];
  const lashes: number[] = [];
  for (const p of head.points) {
    if (p.z < -0.3) continue;
    if (behind.some(([x, y]) => Math.abs(p.x - x) < 0.06 && Math.abs(p.y - y) < 0.06)) depths.push(p.z);
    if (Math.abs(Math.abs(p.x) - 0.5) < 0.3 && Math.abs(p.y) < 0.15) lashes.push(p.z);
  }
  // A percentile rather than the maximum: a prominent brow ridge or a stray
  // strand of hair may overlap the frame edge slightly instead of pushing the
  // whole frame off the face.
  const z = Math.max(
    0.3,
    (depths.length ? percentile(depths, 0.97) : 0.4) + 0.05,
    (lashes.length ? percentile(lashes, 0.99) : 0.3) + 0.08,
  );

  // Half-width of the head at the temples, just in front of the ears.
  const temples = head.points.filter((p) => p.y > -0.2 && p.y < 0.4 && p.z < z - 0.6 && p.z > z - 1.3).map((p) => Math.abs(p.x));
  const headHalf = temples.length ? percentile(temples, 0.98) : 1.15;

  for (const side of [-1, 1]) {
    const eye = new Group();
    eye.position.set(side * 0.5, -0.02, z);
    eye.rotation.y = -side * 0.07; // gentle wrap around the face
    g.add(eye);

    if (round) {
      eye.add(new Mesh(new TorusGeometry(lensW / 2, band * 0.6, 12, 64), frameMat));
    } else {
      const shape = outline(0) as Shape;
      shape.holes.push(outline(band) as Path);
      const rimGeo = new ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 3, curveSegments: 24 });
      rimGeo.translate(0, 0, -0.025);
      eye.add(new Mesh(rimGeo, frameMat));
    }
    const lens = new Mesh(new ShapeGeometry(outline(band * 0.5) as Shape, 32), lensMat);
    lens.renderOrder = 1;
    eye.add(lens);

    // Temple arm: from the hinge, back along the side of the head, and down behind the ear.
    const hingeX = side * (0.5 + lensW / 2 + (round ? 0.0 : 0.01));
    const armX = side * (headHalf + 0.05);
    const earZ = z - 2.15;
    const curve = new CatmullRomCurve3([
      new Vector3(hingeX, 0.08, z - 0.03),
      new Vector3(hingeX + side * 0.05, 0.09, z - 0.2),
      new Vector3(armX, 0.1, z - 0.9),
      new Vector3(armX, 0.08, earZ),
      new Vector3(armX - side * 0.05, -0.1, earZ - 0.2),
      new Vector3(armX - side * 0.1, -0.4, earZ - 0.32),
    ]);
    g.add(new Mesh(new TubeGeometry(curve, 48, round ? 0.022 : 0.032, 8, false), frameMat));
    if (!round) {
      const hinge = new Mesh(new SphereGeometry(0.05, 12, 8), frameMat);
      hinge.scale.set(0.8, 1.3, 1.2);
      hinge.position.set(hingeX, 0.08, z - 0.03);
      g.add(hinge);
    }
  }

  // Bridge over the nose, bowed forward far enough to clear it.
  const inner = 0.5 - lensW / 2 + band * 0.3;
  const bridgeY = round ? 0.16 : 0.13;
  const nose = head.points.filter((p) => Math.abs(p.x) < 0.12 && Math.abs(p.y - bridgeY) < 0.08).map((p) => p.z);
  const bridgeZ = Math.max(z + 0.03, (nose.length ? percentile(nose, 0.99) : 0) + 0.06);
  const bridge = new QuadraticBezierCurve3(
    new Vector3(-inner, round ? 0.08 : 0.1, z),
    // A quadratic curve reaches halfway to its control point.
    new Vector3(0, 2 * bridgeY - (round ? 0.08 : 0.1), 2 * bridgeZ - z),
    new Vector3(inner, round ? 0.08 : 0.1, z),
  );
  g.add(new Mesh(new TubeGeometry(bridge, 16, round ? 0.022 : 0.04, 8, false), frameMat));
  return g;
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function circlePath(r: number): Shape {
  const s = new Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  return s;
}

function roundedRectPath(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2, y = -h / 2;
  // Slightly narrower at the bottom inner corner, like most frames.
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
