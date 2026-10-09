/**
 * "Ronin" — stylised anime courier-samurai.
 *
 * Look: chunky stylised proportions (big head, long legs, slim waist), a hand-painted anime face texture (large glossy eyes,
 * lashes, blush) on a face patch, voluminous gradient-shaded hair with a light sheen band and gold wing ornaments, a double-breasted
 * jacket with buttons and trim, pleated skirt, thigh-high socks, strapped knee boots, gloves, scarf, ponytail and a katana at the hip.
 * Everything is smooth ellipsoids / tapered limbs merged per bone (about 7k triangles, ~25 draws, 2 shared materials + 1 face texture).
 *
 * Skeleton (17 joints): hip -> spine -> head; ponytail x2; scarf x2; shoulder -> elbow (x2); hip -> knee -> ankle (x2).
 *
 * Animation: every state (idle / walk / run / jump / hover / fly / boost / brace-slide / land crouch) is a *target pose*; states are
 * mixed with smoothly changing weights, then each joint follows its target through a damped spring (stiff for the body, loose and
 * under-damped for hair, scarf and ponytail so they trail and overshoot). The gait phase advances with distance travelled
 * (stride length grows with speed) so the feet don't skate.
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
const LOOSE = [T1, T2, S1, S2]; // secondary-motion joints (springy)

const HIP = 0.9;               // pelvis height above the soles at rest (thigh .42 + shin .40 + foot)
const TH = 0.42, SH = 0.4;     // limb lengths

const C = {
  jacket: 0x1b2352, jacketL: 0x34439a, red: 0xd02e48, darkRed: 0x8f1f35, gold: 0xe6b24a, plate: 0x2c3150, plateL: 0x4c5578, white: 0xf7f8fd,
  skin: 0xffd9c2, skinS: 0xf0b99d, hair: 0x1a1736, hairM: 0x2b2f76, hairL: 0x5a6fe0, pants: 0x242a49, boot: 0x181a26, cyan: 0x45ecff, sock: 0x171b33,
};
const PI = Math.PI;
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Hand-painted anime face: huge glossy eyes with layered highlights, lashes, brows, tiny nose, smile and blush. */
function faceTexture(): THREE.CanvasTexture {
  const S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, S, S);
  // blush
  for (const x of [0.2, 0.8]) { const r = g.createRadialGradient(x * S, 0.72 * S, 4, x * S, 0.72 * S, 46); r.addColorStop(0, 'rgba(255,120,130,0.55)'); r.addColorStop(1, 'rgba(255,120,130,0)'); g.fillStyle = r; g.fillRect(x * S - 50, 0.72 * S - 50, 100, 100); }
  const eye = (cx: number, flip: number) => {
    const cy = 0.5 * S, ew = 82, eh = 108;
    g.save(); g.translate(cx, cy); g.scale(flip, 1);
    // sclera
    g.fillStyle = '#fbfcff'; g.beginPath(); g.ellipse(0, 0, ew * 0.5, eh * 0.5, 0, 0, 7); g.fill();
    // iris with vertical gradient (deep top -> bright bottom)
    const gr = g.createLinearGradient(0, -eh * 0.45, 0, eh * 0.5); gr.addColorStop(0, '#16206b'); gr.addColorStop(0.45, '#2f6ee0'); gr.addColorStop(1, '#6ff0ff');
    g.fillStyle = gr; g.beginPath(); g.ellipse(2, 6, ew * 0.37, eh * 0.43, 0, 0, 7); g.fill();
    g.fillStyle = '#091238'; g.beginPath(); g.ellipse(2, 4, ew * 0.17, eh * 0.24, 0, 0, 7); g.fill();     // pupil
    g.fillStyle = 'rgba(255,255,255,0.95)'; g.beginPath(); g.ellipse(-ew * 0.14, -eh * 0.2, 13, 17, -0.3, 0, 7); g.fill();   // main highlight
    g.beginPath(); g.ellipse(ew * 0.16, eh * 0.24, 7, 9, 0, 0, 7); g.fill();                                   // second highlight
    g.fillStyle = 'rgba(160,240,255,0.55)'; g.beginPath(); g.ellipse(2, eh * 0.33, ew * 0.26, eh * 0.09, 0, 0, 7); g.fill(); // bottom glow
    // thick upper lash line with outward flick, thin lower line
    g.strokeStyle = '#120d24'; g.lineCap = 'round'; g.lineWidth = 11;
    g.beginPath(); g.ellipse(0, 0, ew * 0.5, eh * 0.5, 0, Math.PI * 1.05, Math.PI * 1.98); g.stroke();
    g.lineWidth = 8; g.beginPath(); g.moveTo(ew * 0.46, -eh * 0.18); g.quadraticCurveTo(ew * 0.62, -eh * 0.3, ew * 0.7, -eh * 0.42); g.stroke();
    g.lineWidth = 5; g.beginPath(); g.moveTo(ew * 0.42, -eh * 0.26); g.quadraticCurveTo(ew * 0.52, -eh * 0.42, ew * 0.5, -eh * 0.56); g.stroke();
    g.lineWidth = 3; g.globalAlpha = 0.5; g.beginPath(); g.ellipse(0, 0, ew * 0.48, eh * 0.49, 0, 0.1, Math.PI * 0.95); g.stroke(); g.globalAlpha = 1;
    g.restore();
  };
  eye(0.3 * S, 1); eye(0.7 * S, -1);
  g.strokeStyle = '#1a1736'; g.lineCap = 'round'; g.lineWidth = 9;                                              // brows
  g.beginPath(); g.moveTo(0.16 * S, 0.3 * S); g.quadraticCurveTo(0.26 * S, 0.24 * S, 0.38 * S, 0.285 * S); g.stroke();
  g.beginPath(); g.moveTo(0.84 * S, 0.3 * S); g.quadraticCurveTo(0.74 * S, 0.24 * S, 0.62 * S, 0.285 * S); g.stroke();
  g.fillStyle = 'rgba(190,120,110,0.8)'; g.beginPath(); g.ellipse(0.5 * S, 0.7 * S, 6, 4, 0, 0, 7); g.fill();     // nose
  g.strokeStyle = '#a24a55'; g.lineWidth = 6; g.beginPath(); g.moveTo(0.44 * S, 0.8 * S); g.quadraticCurveTo(0.5 * S, 0.85 * S, 0.56 * S, 0.8 * S); g.stroke(); // smile
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export class Hero {
  readonly root = new THREE.Group();
  private J: THREE.Group[] = [];
  private T = new Float32Array(NJ * 3);       // final target pose
  private X = new Float32Array(NJ * 3);       // current joint angles
  private V = new Float32Array(NJ * 3);       // joint angular velocities (springs)
  private G = new Float32Array(NJ * 3); private F = new Float32Array(NJ * 3); private B = new Float32Array(NJ * 3); private L = new Float32Array(NJ * 3); private A = new Float32Array(NJ * 3);
  private clock = 0; private phase = 0;
  private wFly = 0; private wBrace = 0; private wLand = 0; private wAir = 0; private wSpeed = 0; private wMove = 0; private wRun = 0;
  private hipY = HIP;
  private prevHs = 0; private acc = 0;
  private readonly rig = new THREE.Group();

  constructor(assets: Assets) {
    const lit = assets.rig, glow = assets.pillarGlow;
    const mesh = (geos: THREE.BufferGeometry[], mat: THREE.Material, parent: THREE.Object3D) => {
      const g = mergeGeometries(geos)!;
      const m = new THREE.Mesh(g, mat); m.castShadow = mat === lit; parent.add(m);
      if (mat === lit) { const o = new THREE.Mesh(hullGeo(g), outlineMat(0.016)); parent.add(o); } // ink outline
      return m;
    };
    const pivot = (parent: THREE.Object3D, x: number, y: number, z: number, joint = -1): THREE.Group => {
      const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); if (joint >= 0) this.J[joint] = g; return g;
    };
    // smooth primitives; `grad` paints a vertical gradient (colour a at the bottom -> b at the top of the shape)
    const colorize = (g: THREE.BufferGeometry, a: number, b: number | null): THREE.BufferGeometry => {
      g.deleteAttribute('uv');
      if (b === null) return paint(g, a);
      const p = g.attributes.position, n = p.count, col = new Float32Array(n * 3), ca = new THREE.Color(a), cb = new THREE.Color(b);
      let lo = 1e9, hi = -1e9; for (let i = 0; i < n; i++) { lo = Math.min(lo, p.getY(i)); hi = Math.max(hi, p.getY(i)); }
      const tmp = new THREE.Color();
      for (let i = 0; i < n; i++) { tmp.copy(ca).lerp(cb, (p.getY(i) - lo) / Math.max(1e-6, hi - lo)); col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('kind', new THREE.BufferAttribute(new Float32Array(n), 1)); return g;
    };
    const E = (rx: number, ry: number, rz: number, x: number, y: number, z: number, c: number, seg = 12, rotX = 0, rotZ = 0, c2: number | null = null): THREE.BufferGeometry => {
      const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg - 4)); g.scale(rx, ry, rz); g.rotateX(rotX); g.rotateZ(rotZ); g.translate(x, y, z); return colorize(g, c, c2);
    };
    const T = (rTop: number, rBot: number, h: number, x: number, y: number, z: number, c: number, seg = 12, rotX = 0, rotZ = 0, c2: number | null = null): THREE.BufferGeometry => {
      const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, false); g.rotateX(rotX); g.rotateZ(rotZ); g.translate(x, y, z); return colorize(g, c, c2);
    };
    /** hair tuft: cone with its base at the origin, painted dark at the root -> bright at the tip, then leaned */
    const tuft = (r: number, h: number, x: number, y: number, z: number, rx: number, rz: number, root = C.hair, tip = C.hairM): THREE.BufferGeometry => {
      const g = new THREE.ConeGeometry(r, h, 7, 3); g.translate(0, h / 2, 0); colorize(g, root, tip); g.rotateX(rx); g.rotateZ(rz); g.translate(x, y, z); return g;
    };
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, c: number, rx = 0, rz = 0): THREE.BufferGeometry => {
      const g = new THREE.BoxGeometry(w, h, d); g.rotateX(rx); g.rotateZ(rz); g.translate(x, y, z); return colorize(g, c, null);
    };

    this.root.add(this.rig);
    this.rig.scale.setScalar(0.92);

    // =============================== pelvis: shorts, pleated skirt, obi, coat tails, katana ===============================
    const hip = pivot(this.rig, 0, HIP, 0, H);
    mesh([
      E(0.18, 0.13, 0.135, 0, -0.01, 0, C.pants, 14),
      // pleated skirt: 14-gon flared cone, two-tone pleats + red hem + gold hem line
      T(0.2, 0.31, 0.3, 0, -0.14, 0, C.jacket, 14, 0, 0, C.jacketL), T(0.312, 0.318, 0.035, 0, -0.295, 0, C.red, 14), T(0.318, 0.318, 0.012, 0, -0.318, 0, C.gold, 14),
      // obi sash with big bow and tails
      T(0.185, 0.195, 0.085, 0, 0.085, 0, C.red, 16), T(0.19, 0.19, 0.014, 0, 0.13, 0, C.gold, 16), T(0.19, 0.19, 0.014, 0, 0.04, 0, C.gold, 16),
      E(0.075, 0.055, 0.03, 0.075, 0.09, -0.2, C.red, 10, 0, 0.3), E(0.075, 0.055, 0.03, -0.075, 0.09, -0.2, C.red, 10, 0, -0.3), E(0.035, 0.04, 0.035, 0, 0.09, -0.2, C.darkRed, 8),
      E(0.03, 0.22, 0.014, 0.06, -0.1, -0.21, C.red, 8, 0.15), E(0.03, 0.2, 0.014, -0.06, -0.09, -0.21, C.darkRed, 8, 0.15),
      E(0.05, 0.05, 0.035, 0.15, 0.0, 0.11, C.plate, 8),
    ], lit, hip);
    mesh([E(0.04, 0.04, 0.012, 0, 0.085, 0.198, C.cyan, 10)], glow, hip);
    const KX = -0.34, tilt = -0.62;
    const kg = (len: number, w: number, y: number, z: number, c: number, h = w) => {
      const g = new THREE.CylinderGeometry(w / 2, w / 2, len, 8); g.rotateX(PI / 2 + tilt); g.scale(1, h / w, 1); g.translate(KX, y, z); return paint(g, c);
    };
    mesh([kg(0.95, 0.05, -0.1, -0.2, 0x14121c), kg(0.03, 0.1, 0.19, 0.215, C.gold), kg(0.26, 0.042, 0.3, 0.37, 0x1d2142), kg(0.05, 0.058, -0.385, -0.585, C.red), kg(0.18, 0.062, -0.03, -0.12, C.red)], lit, hip);
    mesh([kg(0.7, 0.012, -0.08, -0.2, C.cyan)], glow, hip);

    // =============================== torso: waist curve, chest, jacket with buttons + trim, collar, harness, jet-pack ===============================
    const spine = pivot(hip, 0, 0.09, 0, SP);
    mesh([
      E(0.14, 0.17, 0.1, 0, 0.08, 0, C.jacket, 14), E(0.19, 0.2, 0.13, 0, 0.35, 0.005, C.jacket, 16, 0, 0, C.jacketL),
      E(0.085, 0.14, 0.03, 0, 0.4, 0.118, C.white, 10),                                                           // undershirt V
      E(0.08, 0.21, 0.022, 0.12, 0.37, 0.112, C.jacketL, 10, 0, 0.12), E(0.08, 0.21, 0.022, -0.12, 0.37, 0.112, C.jacketL, 10, 0, -0.12),   // lapels
      E(0.012, 0.2, 0.012, 0.185, 0.36, 0.05, C.gold, 6), E(0.012, 0.2, 0.012, -0.185, 0.36, 0.05, C.gold, 6),    // gold edge trim
      E(0.215, 0.065, 0.125, 0, 0.5, 0, C.jacket, 14),                                                            // trapezius
      T(0.075, 0.09, 0.075, 0, 0.56, 0, C.jacketL, 12), E(0.055, 0.08, 0.034, 0.065, 0.585, -0.04, C.jacketL, 8, 0, 0.3), E(0.055, 0.08, 0.034, -0.065, 0.585, -0.04, C.jacketL, 8, 0, -0.3),
      T(0.195, 0.18, 0.02, 0, 0.255, 0.003, C.red, 16),                                                           // waist belt
      // double-breasted gold buttons
      ...[0.31, 0.38, 0.45].flatMap((y) => [E(0.017, 0.017, 0.01, 0.06, y, 0.133, C.gold, 8), E(0.017, 0.017, 0.01, -0.06, y, 0.133, C.gold, 8)]),
      E(0.012, 0.23, 0.012, 0.09, 0.36, 0.13, C.gold, 6, 0, 0.5), E(0.012, 0.23, 0.012, -0.09, 0.36, 0.13, C.gold, 6, 0, -0.5),
      E(0.115, 0.14, 0.065, 0, 0.36, -0.165, C.plate, 12), E(0.095, 0.03, 0.07, 0, 0.5, -0.165, C.plateL, 10),
      T(0.034, 0.046, 0.075, 0.055, 0.23, -0.215, C.plateL, 8, PI / 2), T(0.034, 0.046, 0.075, -0.055, 0.23, -0.215, C.plateL, 8, PI / 2),
    ], lit, spine);
    mesh([
      E(0.034, 0.034, 0.01, 0, 0.355, 0.133, C.cyan, 10), E(0.008, 0.07, 0.006, 0.08, 0.35, 0.133, C.cyan, 6), E(0.008, 0.07, 0.006, -0.08, 0.35, 0.133, C.cyan, 6),
      E(0.03, 0.03, 0.012, 0.055, 0.23, -0.26, C.cyan, 8), E(0.03, 0.03, 0.012, -0.055, 0.23, -0.26, C.cyan, 8),
    ], glow, spine);

    // =============================== head: big rounded cranium, painted face, voluminous hair with sheen + gold wings ===============================
    const head = pivot(spine, 0, 0.6, 0, HD);
    head.scale.setScalar(1.42);
    const HR = { x: 0.135, y: 0.15, z: 0.138, cy: 0.23 };
    mesh([
      T(0.05, 0.058, 0.12, 0, 0.04, 0, C.skinS, 10),
      E(HR.x, HR.y, HR.z, 0, HR.cy, -0.005, C.skin, 22), E(0.095, 0.09, 0.105, 0, 0.125, 0.034, C.skin, 16), E(0.045, 0.04, 0.045, 0, 0.082, 0.065, C.skin, 10),
      E(0.022, 0.034, 0.024, 0.133, 0.205, 0, C.skin, 8), E(0.022, 0.034, 0.024, -0.133, 0.205, 0, C.skin, 8),
      // hair: back mass with vertical gradient, sheen band, fringe tufts, long side locks, swept spikes, ahoge, bun
      E(0.152, 0.165, 0.16, 0, 0.265, -0.03, C.hair, 18, 0, 0, C.hairM), T(0.151, 0.153, 0.026, 0, 0.325, -0.026, C.hairL, 18),
      tuft(0.05, 0.17, 0.095, 0.345, 0.105, PI + 0.2, 0.28, C.hair, C.hairM), tuft(0.055, 0.19, 0.05, 0.36, 0.12, PI + 0.12, 0.1, C.hair, C.hairL), tuft(0.055, 0.18, 0, 0.365, 0.125, PI + 0.1, 0, C.hair, C.hairM),
      tuft(0.055, 0.19, -0.05, 0.36, 0.12, PI + 0.12, -0.1, C.hair, C.hairL), tuft(0.05, 0.17, -0.095, 0.345, 0.105, PI + 0.2, -0.28, C.hair, C.hairM),
      tuft(0.045, 0.34, 0.14, 0.33, 0.03, PI, 0.06, C.hair, C.hairL), tuft(0.045, 0.34, -0.14, 0.33, 0.03, PI, -0.06, C.hair, C.hairL),
      tuft(0.06, 0.3, 0.075, 0.37, -0.09, -1.15, -0.4, C.hair, C.hairM), tuft(0.06, 0.32, -0.075, 0.37, -0.09, -1.15, 0.4, C.hair, C.hairL), tuft(0.065, 0.33, 0, 0.39, -0.11, -1.3, 0, C.hair, C.hairM),
      tuft(0.05, 0.26, 0.14, 0.31, -0.05, -0.9, -0.8, C.hair, C.hairL), tuft(0.05, 0.26, -0.14, 0.31, -0.05, -0.9, 0.8, C.hair, C.hairL),
      tuft(0.018, 0.14, 0.02, 0.42, 0.04, 0.2, 0.7, C.hair, C.hairL),
      T(0.142, 0.142, 0.03, 0, 0.3, -0.005, C.red, 20), E(0.042, 0.024, 0.014, 0, 0.3, 0.145, C.plate, 10),
      // gold wing hair ornaments
      E(0.05, 0.014, 0.075, 0.16, 0.335, -0.01, C.gold, 8, 0.2, -0.5), E(0.05, 0.014, 0.075, -0.16, 0.335, -0.01, C.gold, 8, 0.2, 0.5),
      E(0.04, 0.012, 0.06, 0.185, 0.355, -0.02, C.gold, 8, 0.3, -0.7), E(0.04, 0.012, 0.06, -0.185, 0.355, -0.02, C.gold, 8, 0.3, 0.7),
    ], lit, head);
    // face: painted texture on a spherical patch just outside the skin
    {
      const phiLen = 1.55, g = new THREE.SphereGeometry(1, 28, 20, PI / 2 - phiLen / 2, phiLen, 1.2, 1.15);
      g.scale(HR.x * 1.006, HR.y * 1.006, HR.z * 1.006); g.translate(0, HR.cy, -0.005);
      const fm = new THREE.MeshToonMaterial({ map: faceTexture(), transparent: true, gradientMap: assets.ramp, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, depthWrite: false });
      const face = new THREE.Mesh(g, fm); head.add(face);
    }
    mesh([
      E(0.014, 0.014, 0.01, 0, 0.3, 0.152, C.cyan, 8), E(0.012, 0.022, 0.012, 0.138, 0.205, 0.0, C.cyan, 8), E(0.012, 0.022, 0.012, -0.138, 0.205, 0.0, C.cyan, 8),
    ], glow, head);
    // ponytail: bun + two chained tapered segments with a gradient to bright tips
    const t1 = pivot(head, 0, 0.34, -0.17, T1);
    mesh([E(0.06, 0.06, 0.055, 0, 0, 0.0, C.hair, 10, 0, 0, C.hairM), T(0.055, 0.04, 0.32, 0, -0.17, 0, C.hair, 10, 0, 0, C.hairM), T(0.066, 0.066, 0.03, 0, -0.01, 0, C.red, 10)], lit, t1);
    const t2 = pivot(t1, 0, -0.33, 0, T2);
    mesh([T(0.04, 0.008, 0.38, 0, -0.19, 0, C.hairM, 10, 0, 0, C.hairL)], lit, t2);

    // scarf: chained cloth
    const s1 = pivot(spine, 0, 0.58, -0.16, S1);
    mesh([E(0.14, 0.22, 0.022, 0, -0.21, 0, C.red, 10), E(0.155, 0.065, 0.155, 0, 0.04, 0.15, C.red, 12), E(0.02, 0.21, 0.026, 0.105, -0.21, 0, C.gold, 6)], lit, s1);
    const s2 = pivot(s1, 0, -0.42, 0, S2);
    mesh([E(0.13, 0.23, 0.02, 0, -0.21, 0, C.darkRed, 10), E(0.115, 0.075, 0.02, 0, -0.44, 0, C.darkRed, 8, 0, 0.4)], lit, s2);

    // =============================== arms: round shoulder, tapered sleeve with gold cuffs, bracer, gloved hand ===============================
    for (const side of [-1, 1] as const) {
      const sh = pivot(spine, 0.245 * side, 0.5, 0, side < 0 ? SHL : SHR);
      mesh([
        E(0.085, 0.085, 0.085, 0, 0, 0, C.jacket, 12), T(0.072, 0.056, 0.31, 0, -0.155, 0, C.jacket, 12, 0, 0, C.jacketL),
        E(0.108, 0.055, 0.115, 0.012 * side, 0.05, 0, C.plate, 12), E(0.106, 0.02, 0.113, 0.012 * side, 0.082, 0, C.gold, 12), E(0.1, 0.05, 0.108, 0.02 * side, 0.015, 0, C.jacketL, 10),
        T(0.066, 0.066, 0.02, 0, -0.29, 0, C.gold, 12),
      ], lit, sh);
      const el = pivot(sh, 0, -0.31, 0, side < 0 ? ELL : ELR);
      mesh([
        E(0.058, 0.058, 0.058, 0, 0, 0, C.jacket, 10), T(0.056, 0.043, 0.27, 0, -0.135, 0, C.jacket, 12),
        T(0.06, 0.053, 0.14, 0, -0.19, 0, C.plate, 12), T(0.064, 0.064, 0.02, 0, -0.12, 0, C.red, 12),
        E(0.046, 0.06, 0.034, 0, -0.325, 0.002, C.white, 10), E(0.014, 0.034, 0.014, -0.025, -0.388, 0.012, C.white, 6), E(0.014, 0.037, 0.014, -0.008, -0.394, 0.014, C.white, 6),
        E(0.014, 0.037, 0.014, 0.009, -0.394, 0.014, C.white, 6), E(0.014, 0.034, 0.014, 0.026, -0.388, 0.012, C.white, 6), E(0.015, 0.03, 0.015, 0.05 * side, -0.32, 0.024, C.white, 6, 0, 0.6 * side),
        T(0.052, 0.05, 0.02, 0, -0.275, 0, C.gold, 10),
      ], lit, el);
      mesh([E(0.008, 0.055, 0.008, 0, -0.19, 0.062, C.cyan, 6), E(0.036, 0.006, 0.006, 0, -0.27, 0.044, C.cyan, 6)], glow, el);
    }

    // =============================== legs: thigh-high socks, strapped knee boots with chunky soles ===============================
    for (const side of [-1, 1] as const) {
      const th = pivot(hip, 0.105 * side, -0.02, 0, side < 0 ? THL : THR);
      mesh([E(0.1, 0.1, 0.1, 0, 0, 0, C.sock, 12), T(0.098, 0.07, TH, 0, -TH / 2, 0, C.sock, 14, 0, 0, 0x242b52), T(0.1, 0.1, 0.02, 0, -0.1, 0, C.red, 14)], lit, th);
      const kn = pivot(th, 0, -TH, 0, side < 0 ? KNL : KNR);
      mesh([
        E(0.07, 0.07, 0.07, 0, 0, 0, C.sock, 12), T(0.07, 0.052, SH, 0, -SH / 2, 0, C.sock, 12),
        T(0.082, 0.07, 0.24, 0, -0.25, 0, C.boot, 14, 0, 0, 0x2a2d44),                                           // boot shaft
        T(0.087, 0.087, 0.022, 0, -0.14, 0, C.gold, 14), E(0.058, 0.075, 0.045, 0, -0.2, 0.066, C.plate, 10),  // top cuff + shin plate
        // buckle straps
        T(0.086, 0.086, 0.018, 0, -0.25, 0, C.plateL, 14), E(0.02, 0.02, 0.012, 0, -0.25, 0.088, C.gold, 8), T(0.084, 0.084, 0.018, 0, -0.33, 0, C.plateL, 14), E(0.02, 0.02, 0.012, 0, -0.33, 0.086, C.gold, 8),
      ], lit, kn);
      mesh([E(0.006, 0.1, 0.006, 0, -0.24, 0.1, C.cyan, 6)], glow, kn);
      const an = pivot(kn, 0, -SH, 0, side < 0 ? ANL : ANR);
      mesh([
        E(0.058, 0.05, 0.135, 0, -0.035, 0.05, C.boot, 12), E(0.055, 0.04, 0.075, 0, -0.04, 0.155, C.boot, 10), E(0.056, 0.032, 0.045, 0, -0.03, 0.21, C.plate, 8), E(0.064, 0.018, 0.185, 0, -0.082, 0.062, C.red, 10),
      ], lit, an);
    }
    this.hipY = HIP;
  }

  // =====================================================================================================================
  // pose targets (all angles in radians, joint order: x, y, z)
  // =====================================================================================================================
  private static set(a: Float32Array, j: number, x: number, y: number, z: number): void { a[j * 3] = x; a[j * 3 + 1] = y; a[j * 3 + 2] = z; }

  /** walk / run / idle on the ground, plus the airborne tuck (blended in by `air`). */
  private poseGround(a: Float32Array, p: PoseIn, c: number): number {
    const S = Hero.set, hs = p.hs;
    this.wMove += (smooth(0.4, 2.2, hs) - this.wMove) * Math.min(1, p.dt * 10);
    this.wRun += (smooth(5.2, 7.6, hs) - this.wRun) * Math.min(1, p.dt * 8);
    const w = this.wMove, run = this.wRun;
    // stride length (two steps) grows with speed; phase advances by distance travelled, so feet plant instead of skating
    const stride = 1.3 + hs * 0.3;
    if (w > 0.02) this.phase += p.dt * (hs / stride) * PI * 2;
    const ph = this.phase, s = Math.sin(ph), co = Math.cos(ph), s2 = -s, co2 = -co;
    const A = clamp(Math.asin(clamp(stride / (4 * 0.88), 0, 0.98)), 0.3, 0.92) * w;
    const kMax = 0.5 + run * 1.0;
    const leg = (th: number, kn: number, an: number, sn: number, cs: number, side: number, j: number) => {
      const thigh = -A * sn - 0.05 * w - run * 0.1 * Math.max(0, -sn) * 0 ;
      const swing = Math.max(0, cs);                                                    // leg is moving forward
      const knee = kMax * w * (swing * swing * 0.9 + 0.22 * Math.max(0, -cs) * (1 - Math.abs(sn))) + 0.07 * w;
      const toeOff = 0.4 * w * Math.max(0, -sn) * Math.max(0, cs + 0.25);
      const ankle = -(thigh + knee) * 0.72 + toeOff;
      S(a, th, thigh, 0, 0.025 * side * w); S(a, kn, knee, 0, 0); S(a, an, ankle, 0, 0);
      void j;
    };
    leg(THL, KNL, ANL, s, co, -1, 0); leg(THR, KNR, ANR, s2, co2, 1, 1);
    // pelvis: bobs twice per stride (highest at mid-stance), rotates and rolls with the steps; torso and head counter it
    const bob = (0.02 + 0.03 * run) * w * Math.cos(2 * ph);
    const crouch = run * 0.035;
    const pelY = 0.1 * w * (0.55 + run * 0.45) * Math.sin(ph), pelZ = 0.045 * w * Math.sin(ph + PI / 2);
    const lean = 0.05 * w + 0.2 * run;
    S(a, H, 0, pelY, pelZ);
    S(a, SP, lean + 0.012 * Math.sin(c * 1.7) * (1 - w) + 0.02 * w * Math.sin(2 * ph + 0.5), -pelY * 1.15, -pelZ * 0.9);
    S(a, HD, -lean * 0.85, -pelY * 0.5 + 0.05 * Math.sin(c * 0.5) * (1 - w), 0);
    // arms counter-swing with the legs; elbows fold deeper when running and on the forward swing
    const asw = A * 0.95, fold = (v: number) => 0.2 + 0.1 * w + run * 0.55 + run * 0.4 * Math.max(0, -v);
    S(a, SHL, asw * s + 0.05 * Math.sin(c * 1.4) * (1 - w), 0, -0.1 - run * 0.12 - (1 - w) * 0.03); S(a, ELL, -fold(s), 0, 0);
    S(a, SHR, -asw * s - 0.05 * Math.sin(c * 1.4 + 1) * (1 - w), 0, 0.1 + run * 0.12 + (1 - w) * 0.03); S(a, ELR, -fold(-s), 0, 0);
    // secondary joints get their own motion targets (springs add the follow-through)
    const wag = 0.3 * Math.sin(c * 1.8), acc = clamp(-this.acc * 0.012, -0.4, 0.4);
    S(a, S1, 0.16 + hs * 0.05 + acc, 0, 0.04 * Math.sin(c * 2.1)); S(a, S2, 0.08 + hs * 0.03 + acc * 0.7, 0, 0.08 * Math.sin(c * 2.7) * (0.4 + w));
    S(a, T1, 0.2 + hs * 0.045 + acc + 0.04 * Math.sin(2 * ph) * w, 0, 0.05 * Math.sin(ph) * w + 0.03 * wag * (1 - w));
    S(a, T2, 0.1 + hs * 0.03 + acc * 0.8, 0, 0.1 * Math.sin(ph + 1.2) * w);
    return HIP + bob - crouch;
  }

  /** jump / fall tuck */
  private poseAir(a: Float32Array, p: PoseIn): void {
    const S = Hero.set, up = p.vy > 0 ? 1 : 0, k = clamp(Math.abs(p.vy) / 8, 0, 1);
    const ex = up ? 1 : 0.4; // rising: knees tucked; falling: legs reach for the ground
    S(a, THL, -0.7 * ex - 0.1, 0, -0.04); S(a, KNL, 1.15 * ex, 0, 0); S(a, ANL, 0.3, 0, 0);
    S(a, THR, 0.12 + (1 - ex) * -0.3, 0, 0.04); S(a, KNR, 0.55 + (1 - ex) * 0.2, 0, 0); S(a, ANR, 0.5, 0, 0);
    S(a, SHL, -0.9 - k * 0.3 * ex, 0, -0.6); S(a, ELL, -0.45, 0, 0); S(a, SHR, -1.05 - k * 0.3 * ex, 0, 0.6); S(a, ELR, -0.45, 0, 0);
    S(a, H, 0, 0, 0); S(a, SP, up ? -0.05 : 0.1, 0, 0); S(a, HD, up ? 0.05 : -0.1, 0, 0);
    S(a, S1, 0.3 + (up ? 0 : 0.7), 0, 0); S(a, S2, 0.2 + (up ? 0 : 0.6), 0, 0); S(a, T1, 0.3 + (up ? 0 : 0.8), 0, 0); S(a, T2, 0.2 + (up ? 0 : 0.7), 0, 0);
  }

  /** hover: relaxed Superman-style float (one knee raised, toes pointed, arms open and bent), with slow breathing sway. */
  private poseHover(a: Float32Array, c: number): void {
    const S = Hero.set, f = Math.sin(c * 1.9) * 0.05, g = Math.sin(c * 1.9 + 1.3) * 0.06;
    S(a, H, 0.1 + f * 0.6, Math.sin(c * 0.7) * 0.06, Math.sin(c * 1.3) * 0.035);
    S(a, SP, 0.04 + f * 0.3, 0, 0); S(a, HD, -0.06 - f * 0.4, Math.sin(c * 0.6) * 0.1, 0);
    S(a, THR, -1.0 + g, 0, 0.12); S(a, KNR, 1.35 - g, 0, 0); S(a, ANR, 0.55, 0, 0);
    S(a, THL, 0.2 - f, 0, -0.06); S(a, KNL, 0.2, 0, 0); S(a, ANL, 0.85, 0, 0);
    S(a, SHL, -0.18 + f, 0, -0.9 + g); S(a, ELL, -0.9 + g * 0.5, 0, 0); S(a, SHR, -0.18 - f, 0, 0.9 - g); S(a, ELR, -0.9 - g * 0.5, 0, 0);
    S(a, S1, 0.22 + Math.sin(c * 3) * 0.1, 0, Math.sin(c * 1.7) * 0.08); S(a, S2, 0.12 + Math.sin(c * 3 + 1) * 0.14, 0, Math.sin(c * 2.2) * 0.12);
    S(a, T1, 0.3 + Math.sin(c * 2.4) * 0.1, 0, Math.sin(c * 1.6) * 0.06); S(a, T2, 0.2 + Math.sin(c * 2.4 + 1) * 0.14, 0, Math.sin(c * 1.9) * 0.08);
  }

  /** flying: body tilts into the direction of travel; one fist forward (both when boosting), legs trailing with pointed toes. */
  private poseFly(a: Float32Array, boost: boolean, tilt: number, bank: number, c: number): void {
    const S = Hero.set, fl = Math.sin(c * 15) * (boost ? 0.16 : 0.07);
    S(a, H, tilt, 0, bank);
    S(a, SP, 0.06, 0, 0); S(a, HD, -tilt * 0.75, 0, -bank * 0.4);
    S(a, THL, 0.08, 0, -0.04); S(a, KNL, 0.12, 0, 0); S(a, ANL, 0.9, 0, 0);
    S(a, THR, boost ? 0.1 : 0.34, 0, 0.04); S(a, KNR, boost ? 0.12 : 0.5, 0, 0); S(a, ANR, 0.9, 0, 0);
    if (boost) { S(a, SHL, -(PI - 0.22), 0, -0.1); S(a, SHR, -(PI - 0.22), 0, 0.1); S(a, ELL, -0.08, 0, 0); S(a, ELR, -0.08, 0, 0); }
    else { S(a, SHR, -(PI - 0.3), 0, 0.14); S(a, ELR, -0.1, 0, 0); S(a, SHL, 0.35, 0, -0.18); S(a, ELL, -0.35, 0, 0); }
    S(a, S1, 0.12 + fl, 0, 0); S(a, S2, fl * 1.6, 0, Math.sin(c * 11) * 0.1); S(a, T1, 0.12 + fl * 0.8, 0, 0); S(a, T2, fl, 0, Math.sin(c * 9) * 0.1);
  }

  private poseBrace(a: Float32Array, c: number): void {
    const S = Hero.set;
    // landed fast: lean back, front leg planted straight as a brake, rear leg folded, arms wide for balance
    S(a, H, -0.2, 0, 0); S(a, SP, -0.12, 0, 0); S(a, HD, 0.1, 0, 0);
    S(a, THL, -1.0, 0, -0.08); S(a, KNL, 0.12, 0, 0); S(a, ANL, 0.2, 0, 0);
    S(a, THR, 0.4, 0, 0.1); S(a, KNR, 1.25, 0, 0); S(a, ANR, 0.7, 0, 0);
    S(a, SHL, -0.3, 0, -1.15); S(a, ELL, -0.5, 0, 0); S(a, SHR, -0.3, 0, 1.15); S(a, ELR, -0.5, 0, 0);
    S(a, S1, 0.55 + Math.sin(c * 12) * 0.08, 0, 0); S(a, S2, 0.4, 0, 0); S(a, T1, 0.5, 0, 0); S(a, T2, 0.3, 0, 0);
  }

  private poseLand(a: Float32Array): void {
    const S = Hero.set;
    S(a, SP, 0.35, 0, 0); S(a, HD, -0.25, 0, 0);
    S(a, THL, -1.0, 0, -0.1); S(a, KNL, 1.7, 0, 0); S(a, ANL, 0.1, 0, 0); S(a, THR, -1.0, 0, 0.1); S(a, KNR, 1.7, 0, 0); S(a, ANR, 0.1, 0, 0);
    S(a, SHL, -0.5, 0, -0.45); S(a, ELL, -0.7, 0, 0); S(a, SHR, -0.5, 0, 0.45); S(a, ELR, -0.7, 0, 0);
    S(a, S1, 0.6, 0, 0); S(a, T1, 0.5, 0, 0);
  }

  pose(p: PoseIn): void {
    const dt = Math.min(0.05, p.dt);
    this.clock += dt;
    const c = this.clock, T = this.T;
    // body acceleration (smoothed): drives the follow-through of hair / scarf
    const da = (p.hs - this.prevHs) / Math.max(dt, 1e-3); this.prevHs = p.hs; this.acc += (da - this.acc) * Math.min(1, dt * 6);

    // state weights glide instead of snapping (takeoff, landing and braking blend over ~0.2-0.35 s)
    const rate = (cur: number, tgt: number, r: number) => cur + (tgt - cur) * Math.min(1, dt * r);
    this.wFly = rate(this.wFly, p.mode === 'fly' ? 1 : 0, 6);
    this.wBrace = rate(this.wBrace, p.mode === 'brace' ? 1 : 0, 12);
    this.wLand = rate(this.wLand, p.mode === 'land' ? 1 : 0, 14);
    this.wAir = rate(this.wAir, p.mode === 'ground' && !p.grounded ? 1 : 0, 14);
    this.wSpeed = rate(this.wSpeed, smooth(1.5, 9, p.speed), 4);

    const hipG = this.poseGround(this.G, p, c);
    this.poseAir(this.A, p);
    this.poseHover(this.F, c);
    const hov = this.F.slice();
    const e = Math.atan2(p.vy, Math.max(0.01, p.hs));
    const tilt = clamp((PI / 2 - e) * 0.85 + (p.boost ? 0.12 : 0), 0, 2.7);
    this.poseFly(this.B, p.boost, tilt, p.bank, c); // B temporarily holds the fly pose
    for (let i = 0; i < NJ * 3; i++) this.F[i] = hov[i] * (1 - this.wSpeed) + this.B[i] * this.wSpeed;
    this.poseBrace(this.B, c); this.poseLand(this.L);

    const wg = Math.max(0, 1 - this.wFly - this.wBrace - this.wLand), wa = this.wAir;
    for (let i = 0; i < NJ * 3; i++) {
      const ground = this.G[i] * (1 - wa) + this.A[i] * wa;
      T[i] = ground * wg + this.F[i] * this.wFly + this.B[i] * this.wBrace + this.L[i] * this.wLand;
    }
    let hipY = hipG * wg + (HIP + Math.sin(c * 1.9) * 0.04 * (1 - this.wSpeed)) * this.wFly + 0.72 * this.wBrace + 0.62 * this.wLand;
    hipY = clamp(hipY, 0.5, 1.1);

    // damped springs: stiff for the body, loose + under-damped for hair/scarf/ponytail so they swing and settle.
    // Integrated in fixed 1/240 s substeps so they stay stable at any frame rate.
    const n = Math.min(14, Math.ceil(dt * 240)), h = dt / n;
    for (let i = 0; i < NJ; i++) {
      const loose = LOOSE.includes(i), w0 = loose ? 11 : 26, zeta = loose ? 0.38 : 0.95, k = w0 * w0, d = 2 * zeta * w0;
      for (let q = 0; q < 3; q++) {
        const idx = i * 3 + q;
        let x = this.X[idx], v = this.V[idx];
        const t = T[idx];
        for (let s2 = 0; s2 < n; s2++) { v += ((t - x) * k - v * d) * h; x += v * h; }
        this.X[idx] = x; this.V[idx] = v;
      }
      this.J[i].rotation.set(this.X[i * 3], this.X[i * 3 + 1], this.X[i * 3 + 2]);
    }
    this.hipY += (hipY - this.hipY) * Math.min(1, dt * 16);
    this.J[H].position.y = this.hipY;
  }

  get hipHeight(): number { return this.hipY * 0.92; }
}
