/**
 * "Ronin" rig: a fully articulated cyber-samurai.
 *
 * Skeleton (17 joints): hip -> spine -> head; ponytail x2; scarf x2; shoulder -> elbow (x2 sides); hip -> knee -> ankle (x2 sides).
 * Detail comes from merged low-poly parts per bone (armour plates, bracers, greaves, boots, hair spikes, katana, jet-pack),
 * so the whole hero is ~24 draw calls / ~7k triangles and shares two materials: lit vertex-colour + unlit glow.
 *
 * Pose = a target rotation per joint (walk / run / jump / hover / fly / boost / brace-slide / land crouch) that the joints
 * ease toward every frame. Zero allocations per frame.
 *
 * Rotation conventions (character faces +z): on a hanging limb, +x swings it BACK, -x swings it FORWARD.
 * Knee/elbow: +x bends the shin back / -x folds the forearm forward. Foot: +x points the toes down.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assets } from '../rendering/assets';
import { paint } from '../rendering/assets';
import { hullGeo, outlineMat } from '../rendering/outline';

export type Mode = 'ground' | 'fly' | 'brace' | 'land';
export interface PoseIn { dt: number; mode: Mode; hs: number; speed: number; vy: number; grounded: boolean; boost: boolean; bank: number }

// joints
const H = 0, SP = 1, HD = 2, T1 = 3, T2 = 4, S1 = 5, S2 = 6, SHL = 7, ELL = 8, SHR = 9, ELR = 10, THL = 11, KNL = 12, ANL = 13, THR = 14, KNR = 15, ANR = 16;
const NJ = 17;

const C = {
  jacket: 0x1d2142, jacketL: 0x2e3676, plate: 0x2a2f45, plateL: 0x4a516e, red: 0xc8283c, darkRed: 0x8f1f2f, gold: 0xd9a441, skin: 0xf2c7a5,
  skinS: 0xd9a888, hair: 0x14121c, hairH: 0x2c2a4a, pants: 0x232a4a, pantsD: 0x1b2038, boot: 0x15161c, white: 0xf2f4fb, cyan: 0x40e8ff,
};
const PI = Math.PI;
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** rotated + translated primitive helpers (geometry is painted, ready to merge) */
function rbox(w: number, h: number, d: number, x: number, y: number, z: number, hex: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d); g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz); g.translate(x, y, z); return paint(g, hex);
}
function rcyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, hex: number, rx = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg); g.rotateX(rx); g.rotateZ(rz); g.translate(x, y, z); return paint(g, hex);
}
function ball(r: number, sx: number, sy: number, sz: number, x: number, y: number, z: number, hex: number, seg = 8): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, seg, Math.max(5, seg - 2)); g.scale(sx, sy, sz); g.translate(x, y, z); return paint(g, hex);
}
/** cone with its base at the origin, leaning by (rx, rz) */
function spike(r: number, h: number, x: number, y: number, z: number, hex: number, rx: number, rz: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, 5); g.translate(0, h / 2, 0); g.rotateX(rx); g.rotateZ(rz); g.translate(x, y, z); return paint(g, hex);
}

export class Hero {
  readonly root = new THREE.Group();
  private J: THREE.Group[] = [];
  private T = new Float32Array(NJ * 3);
  private A = new Float32Array(NJ * 3);
  private B = new Float32Array(NJ * 3);
  private clock = 0; private phase = 0;
  private hipY = 1; private hipYT = 1;
  private readonly rig = new THREE.Group();

  constructor(assets: Assets) {
    const lit = assets.props, glow = assets.pillarGlow;
    const mesh = (geos: THREE.BufferGeometry[], mat: THREE.Material, parent: THREE.Object3D) => {
      const g = mergeGeometries(geos)!;
      const m = new THREE.Mesh(g, mat); m.castShadow = mat === lit; parent.add(m);
      if (mat === lit) { const o = new THREE.Mesh(hullGeo(g), outlineMat(0.017)); parent.add(o); } // ink outline
      return m;
    };
    const pivot = (parent: THREE.Object3D, x: number, y: number, z: number, joint = -1): THREE.Group => {
      const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); if (joint >= 0) this.J[joint] = g; return g;
    };
    // smooth organic primitives (their normals are smooth, so toon shading reads as soft curved forms, not facets)
    const E = (rx: number, ry: number, rz: number, x: number, y: number, z: number, hexc: number, seg = 12, rotX = 0, rotZ = 0): THREE.BufferGeometry => {
      const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg - 4)); g.scale(rx, ry, rz); g.rotateX(rotX); g.rotateZ(rotZ); g.translate(x, y, z); return paint(g, hexc);
    };
    const T = (rTop: number, rBot: number, h: number, x: number, y: number, z: number, hexc: number, seg = 12, rotX = 0, rotZ = 0): THREE.BufferGeometry => {
      const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, false); g.rotateX(rotX); g.rotateZ(rotZ); g.translate(x, y, z); return paint(g, hexc);
    };
    const skin = 0xffd6bd, skinS = 0xeab89a, hairC = 0x1b1730, hairH = 0x3b4ba8, eyeC = 0x3fc8f0;
    const jacket = 0x1c2350, jacketL = 0x2f3b84, pants = 0x2a3050, boot = 0x16171f, glove = 0x1a1c28;

    this.root.add(this.rig);
    this.rig.scale.setScalar(0.9);

    // ---------- hip / pelvis: rounded hips, red obi sash with bow, short coat tails ----------
    const hip = pivot(this.rig, 0, 1, 0, H);
    mesh([
      E(0.175, 0.13, 0.13, 0, -0.01, 0, pants, 14),
      T(0.178, 0.186, 0.075, 0, 0.075, 0, C.red, 16), T(0.181, 0.181, 0.014, 0, 0.115, 0, C.gold, 16), T(0.181, 0.181, 0.014, 0, 0.035, 0, C.gold, 16),
      E(0.062, 0.05, 0.03, 0.065, 0.085, -0.19, C.red, 10), E(0.062, 0.05, 0.03, -0.065, 0.085, -0.19, C.red, 10), E(0.03, 0.035, 0.03, 0, 0.085, -0.19, C.darkRed, 8),
      E(0.026, 0.17, 0.014, 0.05, -0.1, -0.2, C.red, 8, 0.12), E(0.026, 0.15, 0.014, -0.05, -0.09, -0.2, C.darkRed, 8, 0.12),
      E(0.17, 0.2, 0.03, 0, -0.17, -0.135, jacket, 12, -0.1), E(0.05, 0.16, 0.11, 0.17, -0.11, -0.01, jacket, 10, 0, -0.18), E(0.05, 0.16, 0.11, -0.17, -0.11, -0.01, jacket, 10, 0, 0.18),
      E(0.05, 0.05, 0.035, 0.14, 0.0, 0.1, C.plate, 8),
    ], lit, hip);
    mesh([E(0.036, 0.036, 0.012, 0, 0.078, 0.188, C.cyan, 10)], glow, hip);

    // katana: sheathed at the left hip, tucked through the sash; scabbard angled back-and-down, hilt forward at hand height
    const KX = -0.31, tilt = -0.62;
    const kg = (len: number, w: number, y: number, z: number, hexc: number, h = w) => {
      const g = new THREE.CylinderGeometry(w / 2, w / 2, len, 8); g.rotateX(Math.PI / 2 + tilt); g.scale(1, h / w, 1); g.translate(KX, y, z); return paint(g, hexc);
    };
    mesh([
      kg(0.95, 0.05, -0.12, -0.2, 0x14121c), kg(0.03, 0.095, 0.17, 0.215, C.gold), kg(0.26, 0.042, 0.28, 0.37, 0x1d2142),
      kg(0.05, 0.055, -0.405, -0.585, C.red), kg(0.18, 0.06, -0.05, -0.12, C.red),
    ], lit, hip);
    mesh([kg(0.7, 0.012, -0.1, -0.2, C.cyan)], glow, hip);

    // ---------- spine / torso: waist curve into a chest with shoulders, collar, harness and a rounded jet-pack ----------
    const spine = pivot(hip, 0, 0.1, 0, SP);
    mesh([
      E(0.135, 0.17, 0.095, 0, 0.08, 0, jacket, 14), E(0.185, 0.2, 0.125, 0, 0.35, 0.005, jacket, 16),
      E(0.08, 0.13, 0.03, 0, 0.39, 0.112, 0xf2f4fb, 10),                                                    // white undershirt V
      E(0.075, 0.2, 0.02, 0.115, 0.37, 0.108, jacketL, 10, 0, 0.12), E(0.075, 0.2, 0.02, -0.115, 0.37, 0.108, jacketL, 10, 0, -0.12), // lapels
      E(0.205, 0.06, 0.12, 0, 0.5, 0, jacket, 14),                                                           // trapezius / shoulder line
      T(0.07, 0.085, 0.07, 0, 0.56, 0, jacketL, 12), E(0.05, 0.075, 0.03, 0.06, 0.58, -0.04, jacketL, 8, 0, 0.3), E(0.05, 0.075, 0.03, -0.06, 0.58, -0.04, jacketL, 8, 0, -0.3),
      T(0.185, 0.17, 0.016, 0, 0.255, 0.003, C.red, 16),                                                     // chest strap
      E(0.012, 0.22, 0.012, 0.09, 0.36, 0.126, C.gold, 6, 0, 0.5), E(0.012, 0.22, 0.012, -0.09, 0.36, 0.126, C.gold, 6, 0, -0.5),
      E(0.115, 0.14, 0.065, 0, 0.36, -0.16, C.plate, 12), E(0.095, 0.03, 0.07, 0, 0.5, -0.16, C.plateL, 10),
      T(0.034, 0.046, 0.075, 0.055, 0.23, -0.21, C.plateL, 8, Math.PI / 2), T(0.034, 0.046, 0.075, -0.055, 0.23, -0.21, C.plateL, 8, Math.PI / 2),
    ], lit, spine);
    mesh([
      E(0.032, 0.032, 0.01, 0, 0.355, 0.128, C.cyan, 10), E(0.008, 0.07, 0.006, 0.075, 0.35, 0.128, C.cyan, 6), E(0.008, 0.07, 0.006, -0.075, 0.35, 0.128, C.cyan, 6),
      E(0.03, 0.03, 0.012, 0.055, 0.23, -0.255, C.cyan, 8), E(0.03, 0.03, 0.012, -0.055, 0.23, -0.255, C.cyan, 8),
    ], glow, spine);

    // ---------- head: rounded cranium + pointed chin, big anime eyes, layered hair ----------
    const head = pivot(spine, 0, 0.62, 0, HD);
    head.scale.setScalar(1.12);
    mesh([
      T(0.045, 0.052, 0.11, 0, 0.04, 0, skinS, 10),
      E(0.128, 0.142, 0.13, 0, 0.225, -0.005, skin, 18), E(0.088, 0.085, 0.1, 0, 0.125, 0.032, skin, 14), E(0.045, 0.04, 0.04, 0, 0.085, 0.06, skin, 10),
      E(0.02, 0.032, 0.022, 0.125, 0.2, 0, skin, 8), E(0.02, 0.032, 0.022, -0.125, 0.2, 0, skin, 8),
      E(0.038, 0.05, 0.014, 0.053, 0.215, 0.117, 0xffffff, 12), E(0.038, 0.05, 0.014, -0.053, 0.215, 0.117, 0xffffff, 12),         // eye whites
      E(0.03, 0.044, 0.014, 0.053, 0.212, 0.125, eyeC, 12), E(0.03, 0.044, 0.014, -0.053, 0.212, 0.125, eyeC, 12),                   // irises
      E(0.014, 0.026, 0.014, 0.053, 0.208, 0.133, 0x0a1830, 10), E(0.014, 0.026, 0.014, -0.053, 0.208, 0.133, 0x0a1830, 10),         // pupils
      E(0.034, 0.008, 0.01, 0.056, 0.27, 0.121, hairC, 8, 0, -0.18), E(0.034, 0.008, 0.01, -0.056, 0.27, 0.121, hairC, 8, 0, 0.18), // brows
      E(0.012, 0.016, 0.014, 0, 0.165, 0.13, skinS, 8), E(0.02, 0.005, 0.008, 0, 0.12, 0.118, 0xa05555, 8), E(0.034, 0.02, 0.01, 0.075, 0.155, 0.1, 0xffb4a8, 8), E(0.034, 0.02, 0.01, -0.075, 0.155, 0.1, 0xffb4a8, 8),
      // hair: back cap, forehead fringe (down-pointing tufts), side locks, swept-back spikes, one stray antenna
      E(0.142, 0.152, 0.15, 0, 0.255, -0.025, hairC, 16),
      spike(0.045, 0.15, 0.09, 0.33, 0.1, hairC, Math.PI + 0.15, 0.25), spike(0.05, 0.17, 0.045, 0.345, 0.115, hairH, Math.PI + 0.1, 0.1), spike(0.05, 0.16, 0, 0.35, 0.12, hairC, Math.PI + 0.1, 0),
      spike(0.05, 0.17, -0.045, 0.345, 0.115, hairH, Math.PI + 0.1, -0.1), spike(0.045, 0.15, -0.09, 0.33, 0.1, hairC, Math.PI + 0.15, -0.25),
      spike(0.04, 0.26, 0.128, 0.31, 0.04, hairC, Math.PI, 0.1), spike(0.04, 0.26, -0.128, 0.31, 0.04, hairH, Math.PI, -0.1),
      spike(0.06, 0.27, 0.07, 0.34, -0.08, hairC, -1.15, -0.4), spike(0.06, 0.28, -0.07, 0.34, -0.08, hairH, -1.15, 0.4), spike(0.06, 0.3, 0, 0.36, -0.1, hairC, -1.3, 0),
      spike(0.016, 0.12, 0.02, 0.38, 0.04, hairC, 0.2, 0.6),
      T(0.134, 0.134, 0.028, 0, 0.3, -0.005, C.red, 18), E(0.04, 0.022, 0.012, 0, 0.3, 0.135, C.plate, 10),
    ], lit, head);
    mesh([
      E(0.012, 0.014, 0.01, 0.035, 0.228, 0.14, 0xffffff, 8), E(0.012, 0.014, 0.01, -0.071, 0.228, 0.14, 0xffffff, 8), // eye highlights
      E(0.016, 0.016, 0.01, 0, 0.3, 0.145, C.cyan, 8), E(0.012, 0.022, 0.012, 0.13, 0.2, 0.0, C.cyan, 8), E(0.012, 0.022, 0.012, -0.13, 0.2, 0.0, C.cyan, 8),
    ], glow, head);
    // ponytail: two chained tapered segments off a hair bun
    const t1 = pivot(head, 0, 0.33, -0.15, T1);
    mesh([E(0.055, 0.055, 0.05, 0, 0, 0.0, hairC, 10), T(0.05, 0.034, 0.3, 0, -0.16, 0, hairC, 10), T(0.06, 0.06, 0.03, 0, -0.01, 0, C.red, 10)], lit, t1);
    const t2 = pivot(t1, 0, -0.3, 0, T2);
    mesh([T(0.034, 0.008, 0.34, 0, -0.17, 0, hairH, 10)], lit, t2);

    // ---------- scarf: two chained cloth segments ----------
    const s1 = pivot(spine, 0, 0.58, -0.15, S1);
    mesh([E(0.135, 0.21, 0.022, 0, -0.2, 0, C.red, 10), E(0.15, 0.06, 0.15, 0, 0.04, 0.14, C.red, 12), E(0.02, 0.2, 0.026, 0.1, -0.2, 0, C.gold, 6)], lit, s1);
    const s2 = pivot(s1, 0, -0.4, 0, S2);
    mesh([E(0.125, 0.22, 0.02, 0, -0.2, 0, C.darkRed, 10), E(0.11, 0.07, 0.02, 0, -0.42, 0, C.darkRed, 8, 0, 0.4)], lit, s2);

    // ---------- arms: round shoulder -> tapered sleeve -> elbow -> bracer -> gloved hand ----------
    for (const side of [-1, 1] as const) {
      const sh = pivot(spine, 0.235 * side, 0.5, 0, side < 0 ? SHL : SHR);
      mesh([
        E(0.078, 0.078, 0.078, 0, 0, 0, jacket, 12), T(0.066, 0.052, 0.3, 0, -0.15, 0, jacket, 12),
        E(0.1, 0.05, 0.105, 0.012 * side, 0.045, 0, C.plate, 12), E(0.098, 0.018, 0.103, 0.012 * side, 0.074, 0, C.red, 12), E(0.095, 0.045, 0.1, 0.02 * side, 0.012, 0, jacketL, 10),
      ], lit, sh);
      const el = pivot(sh, 0, -0.3, 0, side < 0 ? ELL : ELR);
      mesh([
        E(0.053, 0.053, 0.053, 0, 0, 0, jacket, 10), T(0.052, 0.04, 0.26, 0, -0.13, 0, jacket, 12),
        T(0.057, 0.05, 0.13, 0, -0.18, 0, C.plate, 12), T(0.06, 0.06, 0.018, 0, -0.115, 0, C.red, 12),
        E(0.04, 0.055, 0.03, 0, -0.315, 0.002, glove, 10), E(0.012, 0.03, 0.012, -0.022, -0.375, 0.012, glove, 6), E(0.012, 0.033, 0.012, -0.007, -0.38, 0.014, glove, 6),
        E(0.012, 0.033, 0.012, 0.008, -0.38, 0.014, glove, 6), E(0.012, 0.03, 0.012, 0.023, -0.375, 0.012, glove, 6), E(0.013, 0.028, 0.013, 0.045 * side, -0.31, 0.022, glove, 6, 0, 0.6 * side),
      ], lit, el);
      mesh([E(0.007, 0.05, 0.007, 0, -0.18, 0.058, C.cyan, 6), E(0.034, 0.006, 0.006, 0, -0.26, 0.042, C.cyan, 6)], glow, el);
    }

    // ---------- legs: loose trousers -> knee -> greave + boot with rounded toe and red sole ----------
    for (const side of [-1, 1] as const) {
      const th = pivot(hip, 0.1 * side, -0.02, 0, side < 0 ? THL : THR);
      mesh([E(0.1, 0.1, 0.1, 0, 0, 0, pants, 12), T(0.1, 0.072, 0.46, 0, -0.23, 0, pants, 14), T(0.104, 0.104, 0.02, 0, -0.07, 0, C.red, 14)], lit, th);
      const kn = pivot(th, 0, -0.46, 0, side < 0 ? KNL : KNR);
      mesh([
        E(0.068, 0.068, 0.068, 0, 0, 0, pants, 12), T(0.068, 0.05, 0.44, 0, -0.22, 0, 0x1f2540, 12),
        E(0.052, 0.17, 0.03, 0, -0.19, 0.056, C.plate, 10), E(0.06, 0.05, 0.04, 0, -0.01, 0.052, C.plateL, 10), T(0.07, 0.062, 0.17, 0, -0.355, 0, boot, 12), T(0.07, 0.07, 0.02, 0, -0.275, 0, C.red, 12),
      ], lit, kn);
      mesh([E(0.006, 0.12, 0.006, 0, -0.19, 0.068, C.cyan, 6)], glow, kn);
      const an = pivot(kn, 0, -0.44, 0, side < 0 ? ANL : ANR);
      mesh([
        E(0.052, 0.045, 0.125, 0, -0.035, 0.045, boot, 12), E(0.048, 0.036, 0.07, 0, -0.04, 0.145, boot, 10), E(0.05, 0.03, 0.04, 0, -0.03, 0.2, C.plate, 8), E(0.058, 0.014, 0.17, 0, -0.078, 0.06, C.red, 10),
      ], lit, an);
    }
    this.hipY = this.hipYT = 1;
  }

  /** Fill a target pose array for the hover (Superman-style hover): one knee raised and bent, toes pointed, arms out and bent. */
  private poseHover(a: Float32Array, c: number): void {
    a.fill(0);
    const f = Math.sin(c * 2) * 0.05, g = Math.sin(c * 2 + 1.3) * 0.06;
    set(a, H, 0.12 + f * 0.5, 0, Math.sin(c * 1.3) * 0.03);
    set(a, SP, 0.04, 0, 0); set(a, HD, -0.08, 0, 0);
    set(a, THR, -1.0 + g, 0, 0.12); set(a, KNR, 1.35 - g, 0, 0); set(a, ANR, 0.55, 0, 0);
    set(a, THL, 0.22 - f, 0, -0.06); set(a, KNL, 0.18, 0, 0); set(a, ANL, 0.8, 0, 0);
    set(a, SHL, -0.15 + f, 0, -0.95 + g); set(a, ELL, -0.95, 0, 0);
    set(a, SHR, -0.15 - f, 0, 0.95 - g); set(a, ELR, -0.95, 0, 0);
    set(a, S1, 0.22 + Math.sin(c * 3) * 0.08, 0, 0); set(a, S2, 0.12 + Math.sin(c * 3 + 1) * 0.12, 0, Math.sin(c * 2.2) * 0.1);
    set(a, T1, 0.3 + Math.sin(c * 2.4) * 0.08, 0, 0); set(a, T2, 0.2 + Math.sin(c * 2.4 + 1) * 0.12, 0, 0);
  }

  /** Flying: body tilts into the direction of travel; one fist forward (both when boosting), legs trailing with pointed toes. */
  private poseFly(a: Float32Array, boost: boolean, tilt: number, bank: number, c: number): void {
    a.fill(0);
    const fl = Math.sin(c * 16) * (boost ? 0.16 : 0.08);
    set(a, H, tilt, 0, bank);
    set(a, SP, 0.06, 0, 0); set(a, HD, -tilt * 0.72, 0, -bank * 0.4);
    set(a, THL, 0.08, 0, -0.04); set(a, KNL, 0.12, 0, 0); set(a, ANL, 0.9, 0, 0);
    set(a, THR, boost ? 0.1 : 0.32, 0, 0.04); set(a, KNR, boost ? 0.12 : 0.45, 0, 0); set(a, ANR, 0.9, 0, 0);
    if (boost) { // both arms thrust forward, hands together
      set(a, SHL, -(PI - 0.22), 0, -0.1); set(a, SHR, -(PI - 0.22), 0, 0.1); set(a, ELL, -0.08, 0, 0); set(a, ELR, -0.08, 0, 0);
    } else { // right fist forward, left arm along the side
      set(a, SHR, -(PI - 0.3), 0, 0.14); set(a, ELR, -0.1, 0, 0);
      set(a, SHL, 0.35, 0, -0.18); set(a, ELL, -0.35, 0, 0);
    }
    set(a, S1, 0.1 + fl, 0, 0); set(a, S2, fl * 1.6, 0, Math.sin(c * 11) * 0.1);
    set(a, T1, 0.1 + fl * 0.8, 0, 0); set(a, T2, fl, 0, Math.sin(c * 9) * 0.1);
  }

  pose(p: PoseIn): void {
    const { dt } = p;
    this.clock += dt;
    const c = this.clock, T = this.T;
    T.fill(0);
    let hipYt = 1;

    if (p.mode === 'fly') {
      const f = smooth(1.5, 9, p.speed);
      const e = Math.atan2(p.vy, Math.max(0.01, p.hs)); // elevation of the velocity vector
      const tilt = Math.max(0, Math.min(2.7, (PI / 2 - e) * 0.85 + (p.boost ? 0.12 : 0)));
      this.poseHover(this.A, c);
      this.poseFly(this.B, p.boost, tilt, p.bank, c);
      for (let i = 0; i < NJ * 3; i++) T[i] = this.A[i] * (1 - f) + this.B[i] * f;
      hipYt = 1 + Math.sin(c * 2) * 0.04 * (1 - f);
    } else if (p.mode === 'brace') {
      // landed diagonally at speed: lean back, one leg planted forward as a brake, the other folded, arms out for balance
      set(T, H, -0.2, 0, 0); set(T, SP, -0.12, 0, 0); set(T, HD, 0.1, 0, 0);
      set(T, THL, -1.0, 0, -0.08); set(T, KNL, 0.12, 0, 0); set(T, ANL, 0.2, 0, 0);
      set(T, THR, 0.4, 0, 0.1); set(T, KNR, 1.25, 0, 0); set(T, ANR, 0.7, 0, 0);
      set(T, SHL, -0.3, 0, -1.15); set(T, ELL, -0.5, 0, 0); set(T, SHR, -0.3, 0, 1.15); set(T, ELR, -0.5, 0, 0);
      set(T, S1, 0.55 + Math.sin(c * 12) * 0.08, 0, 0); set(T, S2, 0.4, 0, 0); set(T, T1, 0.5, 0, 0); set(T, T2, 0.3, 0, 0);
      hipYt = 0.74;
    } else if (p.mode === 'land') {
      set(T, SP, 0.35, 0, 0); set(T, HD, -0.25, 0, 0);
      set(T, THL, -1.0, 0, -0.1); set(T, KNL, 1.7, 0, 0); set(T, ANL, 0.1, 0, 0); set(T, THR, -1.0, 0, 0.1); set(T, KNR, 1.7, 0, 0); set(T, ANR, 0.1, 0, 0);
      set(T, SHL, -0.5, 0, -0.45); set(T, ELL, -0.7, 0, 0); set(T, SHR, -0.5, 0, 0.45); set(T, ELR, -0.7, 0, 0);
      hipYt = 0.7;
    } else if (!p.grounded) {
      // jump / fall: tucked legs, arms up
      set(T, THL, -0.75, 0, -0.05); set(T, KNL, 1.2, 0, 0); set(T, ANL, 0.3, 0, 0); set(T, THR, 0.15, 0, 0.05); set(T, KNR, 0.55, 0, 0); set(T, ANR, 0.5, 0, 0);
      set(T, SHL, -0.9, 0, -0.55); set(T, ELL, -0.4, 0, 0); set(T, SHR, -1.1, 0, 0.55); set(T, ELR, -0.4, 0, 0);
      set(T, SP, p.vy < 0 ? 0.08 : -0.04, 0, 0); set(T, HD, -0.05, 0, 0);
      set(T, S1, 0.3 + (p.vy < 0 ? 0.5 : 0), 0, 0); set(T, T1, 0.4, 0, 0);
    } else {
      // idle -> walk -> run blend
      const w = smooth(0.3, 2, p.hs), run = smooth(5.5, 8.5, p.hs);
      this.phase += dt * (1.6 + p.hs * 1.05);
      const ph = this.phase, s = Math.sin(ph), co = Math.cos(ph), amp = w * (0.55 + run * 0.6);
      const s2 = Math.sin(ph + PI), c2 = Math.cos(ph + PI);
      const br = Math.sin(c * 1.8) * (1 - w);
      // legs: forward swing on thigh, knee folds during the swing, ankle keeps the foot level
      const thL = -s * amp * 0.85, knL = Math.max(0, co) * amp * 1.15 + w * 0.08, thR = -s2 * amp * 0.85, knR = Math.max(0, c2) * amp * 1.15 + w * 0.08;
      set(T, THL, thL, 0, -0.03); set(T, KNL, knL, 0, 0); set(T, ANL, -(thL + knL) * 0.6, 0, 0);
      set(T, THR, thR, 0, 0.03); set(T, KNR, knR, 0, 0); set(T, ANR, -(thR + knR) * 0.6, 0, 0);
      // arms counter-swing; elbows bend more as speed rises
      const bend = 0.18 + run * 0.95;
      set(T, SHL, s * amp * 0.9 + br * 0.03, 0, -0.07 - (1 - w) * 0.03); set(T, ELL, -(bend + Math.max(0, -s) * amp * 0.3), 0, 0);
      set(T, SHR, -s * amp * 0.9 - br * 0.03, 0, 0.07 + (1 - w) * 0.03); set(T, ELR, -(bend + Math.max(0, s) * amp * 0.3), 0, 0);
      // torso: lean + counter-twist + breathing; head stays level
      const lean = w * 0.05 + run * 0.22;
      set(T, H, 0, -s * 0.08 * amp, Math.sin(ph) * 0.02 * amp);
      set(T, SP, lean + br * 0.02, s * 0.14 * amp, 0);
      set(T, HD, -lean * 0.8, -s * 0.1 * amp, 0);
      set(T, S1, 0.16 + p.hs * 0.05 + Math.sin(c * 7) * 0.05 * w, 0, 0); set(T, S2, 0.08 + Math.sin(c * 7 + 1) * 0.12 * (0.3 + w), 0, Math.sin(c * 5) * 0.08);
      set(T, T1, 0.2 + p.hs * 0.04, 0, Math.sin(c * 4) * 0.06); set(T, T2, 0.12 + Math.sin(c * 5 + 1) * 0.1, 0, 0);
      hipYt = 1 + Math.abs(co) * 0.045 * amp - 0.02 * amp - br * 0.005;
    }
    this.hipYT = hipYt;

    // ease every joint toward its target (fast enough to follow the gait cycle, slow enough to smooth transitions)
    const k = 1 - Math.exp(-dt * 16);
    for (let i = 0; i < NJ; i++) {
      const r = this.J[i].rotation;
      r.x += (T[i * 3] - r.x) * k; r.y += (T[i * 3 + 1] - r.y) * k; r.z += (T[i * 3 + 2] - r.z) * k;
    }
    this.hipY += (this.hipYT - this.hipY) * (1 - Math.exp(-dt * 14));
    this.J[H].position.y = this.hipY;
  }

  /** world-space-ish anchor helpers for FX (relative to root) */
  get hipHeight(): number { return this.hipY * 0.88; }
}

function set(a: Float32Array, j: number, x: number, y: number, z: number): void { a[j * 3] = x; a[j * 3 + 1] = y; a[j * 3 + 2] = z; }
