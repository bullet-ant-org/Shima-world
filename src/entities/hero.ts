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
import { paint } from '../rendering/assets';
import { defaultSpec, type CharacterSpec } from './character';
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

const hexNum = (h: string) => parseInt(h.slice(1), 16);
const shadeHex = (h: string, k: number) => { const c = new THREE.Color(h); c.multiplyScalar(k); return c.getHex(); };
const mixHex = (a: string, b: string, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();

/** Hero only needs these from the shared asset library (the character preview supplies its own cheap copies). */
export interface HeroAssets { rig: THREE.Material; pillarGlow: THREE.Material; ramp: THREE.Texture }

const EYE_SHAPE = [
  { wr: 1.0, hr: 1.0, lid: 0, flick: 1.0 },   // round
  { wr: 1.1, hr: 0.84, lid: 0.08, flick: 1.6 }, // sharp
  { wr: 1.05, hr: 0.88, lid: 0.34, flick: 0.6 },// sleepy
  { wr: 1.2, hr: 0.9, lid: 0.04, flick: 1.9 },  // cat
];

/** Hand-painted anime face driven by the spec: eye shape/size/spacing/height/tilt, iris colour, lashes, brows, nose, mouth, blush, freckles. */
export function faceTexture(spec: CharacterSpec): THREE.CanvasTexture {
  const f = spec.face, S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, S, S);
  const sp = EYE_SHAPE[f.eyeShape] ?? EYE_SHAPES0;
  const sep = 0.2 + 0.05 * f.eyeSpacing, cy = (0.5 + 0.04 * f.eyeHeight) * S, es = f.eyeSize;
  // blush
  for (const x of [0.2, 0.8]) { const r = g.createRadialGradient(x * S, 0.72 * S, 4, x * S, 0.72 * S, 46); r.addColorStop(0, `rgba(255,110,125,${0.6 * f.blush})`); r.addColorStop(1, 'rgba(255,110,125,0)'); g.fillStyle = r; g.fillRect(x * S - 50, 0.72 * S - 50, 100, 100); }
  if (f.freckles) { g.fillStyle = 'rgba(150,90,60,0.55)'; for (let i = 0; i < 16; i++) { const side = i & 1 ? 1 : -1, x = 0.5 + side * (0.1 + (i * 37 % 17) / 100), y = 0.66 + ((i * 53) % 9) / 100; g.beginPath(); g.arc(x * S, y * S, 2.2 + (i % 3) * 0.7, 0, 7); g.fill(); } }
  const iris0 = new THREE.Color(f.iris), irisTop = '#' + iris0.clone().multiplyScalar(0.35).getHexString(), irisMid = '#' + iris0.getHexString(), irisBot = '#' + iris0.clone().lerp(new THREE.Color('#ffffff'), 0.55).getHexString();
  const eye = (cx: number, flip: number) => {
    const ew = 82 * es * sp.wr, eh = 108 * es * sp.hr;
    g.save(); g.translate(cx, cy); g.scale(flip, 1); g.rotate(-f.eyeTilt * 0.22 * flip * flip);
    g.fillStyle = '#fbfcff'; g.beginPath(); g.ellipse(0, 0, ew * 0.5, eh * 0.5, 0, 0, 7); g.fill();
    const gr = g.createLinearGradient(0, -eh * 0.45, 0, eh * 0.5); gr.addColorStop(0, irisTop); gr.addColorStop(0.45, irisMid); gr.addColorStop(1, irisBot);
    g.fillStyle = gr; g.beginPath(); g.ellipse(2, 6, ew * 0.37, eh * 0.43, 0, 0, 7); g.fill();
    g.fillStyle = '#080f2a'; g.beginPath(); g.ellipse(2, 4, ew * 0.17, eh * 0.24, 0, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.96)'; g.beginPath(); g.ellipse(-ew * 0.14, -eh * 0.2, 13 * es, 17 * es, -0.3, 0, 7); g.fill(); g.beginPath(); g.ellipse(ew * 0.16, eh * 0.24, 7 * es, 9 * es, 0, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.ellipse(2, eh * 0.33, ew * 0.26, eh * 0.09, 0, 0, 7); g.fill();
    if (sp.lid > 0) { g.fillStyle = `rgb(${255},${217},${194})`; g.beginPath(); g.ellipse(0, -eh * (0.5 - sp.lid * 0.5) - 3, ew * 0.58, eh * sp.lid * 0.75 + 4, 0, 0, 7); g.fill(); }  // heavy lid (skin patch) for sleepy eyes
    const lw = 7 + 6 * f.lash;
    g.strokeStyle = '#120d24'; g.lineCap = 'round'; g.lineWidth = lw;
    g.beginPath(); g.ellipse(0, sp.lid * -6, ew * 0.5, eh * 0.5, 0, Math.PI * 1.05, Math.PI * 1.98); g.stroke();
    g.lineWidth = 4 + 5 * f.lash; g.beginPath(); g.moveTo(ew * 0.46, -eh * 0.18); g.quadraticCurveTo(ew * 0.62, -eh * 0.3, ew * (0.55 + 0.14 * sp.flick), -eh * (0.3 + 0.12 * sp.flick)); g.stroke();
    if (f.lash > 0.45) { g.lineWidth = 3 + 3 * f.lash; g.beginPath(); g.moveTo(ew * 0.42, -eh * 0.26); g.quadraticCurveTo(ew * 0.52, -eh * 0.42, ew * 0.5, -eh * 0.56); g.stroke(); }
    g.lineWidth = 3; g.globalAlpha = 0.5; g.beginPath(); g.ellipse(0, 0, ew * 0.48, eh * 0.49, 0, 0.1, Math.PI * 0.95); g.stroke(); g.globalAlpha = 1;
    g.restore();
  };
  eye((0.5 - sep) * S, 1); eye((0.5 + sep) * S, -1);
  // brows
  const bh = (0.3 - 0.03 * f.browHeight - 0.02 * (es - 1)) * S, bt = 5 + 11 * f.brow, ang = 0.04 * S * f.browAngle;
  g.strokeStyle = '#1a1736'; g.lineCap = 'round'; g.lineWidth = bt;
  for (const side of [-1, 1]) { const x0 = (0.5 + side * (sep + 0.14)) * S, x1 = (0.5 + side * (sep - 0.08)) * S; g.beginPath(); g.moveTo(x0, bh + ang * 0.2); g.quadraticCurveTo((x0 + x1) / 2, bh - 0.04 * S + ang * -0.3, x1, bh + 0.015 * S + ang); g.stroke(); }
  // nose
  const nw = f.noseWidth, ns = f.noseSize, ny = (0.7 + 0.03 * f.noseHeight) * S;
  g.fillStyle = 'rgba(185,115,105,0.75)'; g.beginPath(); g.ellipse(0.5 * S - 7 * nw, ny, 3.5 * ns, 3 * ns, 0, 0, 7); g.fill(); g.beginPath(); g.ellipse(0.5 * S + 7 * nw, ny, 3.5 * ns, 3 * ns, 0, 0, 7); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.28)'; g.beginPath(); g.ellipse(0.5 * S, ny - 12 * ns, 3 * ns, 6 * ns, 0, 0, 7); g.fill();
  // mouth
  const mx = 0.5 * S, my = (0.8 + 0.03 * f.mouthHeight) * S, mw = 0.06 * S * f.mouthWidth;
  g.strokeStyle = '#a24a55'; g.fillStyle = '#7a2e3c'; g.lineWidth = 6; g.lineCap = 'round';
  if (f.mouth === 0) { g.beginPath(); g.moveTo(mx - mw, my); g.quadraticCurveTo(mx, my + 0.05 * S, mx + mw, my); g.stroke(); }
  else if (f.mouth === 1) { g.beginPath(); g.moveTo(mx - mw * 0.8, my + 2); g.lineTo(mx + mw * 0.8, my + 2); g.stroke(); }
  else if (f.mouth === 2) { g.beginPath(); g.moveTo(mx - mw * 1.1, my - 2); g.quadraticCurveTo(mx, my + 0.08 * S, mx + mw * 1.1, my - 2); g.closePath(); g.fill(); g.fillStyle = '#ff7a8a'; g.beginPath(); g.ellipse(mx, my + 0.035 * S, mw * 0.5, 0.012 * S, 0, 0, 7); g.fill(); g.fillStyle = '#fff'; g.fillRect(mx - mw * 0.9, my - 2, mw * 1.8, 5); }
  else if (f.mouth === 3) { g.beginPath(); g.moveTo(mx - mw, my + 4); g.quadraticCurveTo(mx + mw * 0.2, my + 0.03 * S, mx + mw * 1.1, my - 0.02 * S); g.stroke(); }
  else { g.fillStyle = '#d0626f'; g.beginPath(); g.ellipse(mx, my + 3, mw * 0.4, 0.016 * S, 0, 0, 7); g.fill(); g.strokeStyle = '#8a3a48'; g.lineWidth = 3; g.stroke(); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const EYE_SHAPES0 = EYE_SHAPE[0];

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
  /** extra textures/geometries created for this hero, released by dispose() */
  private owned: { dispose(): void }[] = [];

  constructor(assets: HeroAssets, spec: CharacterSpec = defaultSpec(), ink = true) {
    const lit = assets.rig, glow = assets.pillarGlow;
    const F_ = spec.face, O = spec.outfit, H_ = spec.hair, male = spec.gender === 'male';
    const m = male ? 1 : 0, bd = spec.build;
    // ---- colours from the spec ----
    const C = {
      jacket: hexNum(O.primary), jacketL: hexNum(O.secondary), red: hexNum(O.accent), darkRed: shadeHex(O.accent, 0.62), gold: hexNum(O.trim), plate: shadeHex(O.primary, 1.35), plateL: mixHex(O.primary, '#ffffff', 0.35),
      white: 0xf7f8fd, skin: hexNum(spec.skin), skinS: shadeHex(spec.skin, 0.9), hair: hexNum(H_.color), hairM: mixHex(H_.color, H_.tip, 0.5), hairL: hexNum(H_.sheen), hairTip: hexNum(H_.tip), pants: hexNum(O.pants),
      boot: hexNum(O.bootColor), sock: shadeHex(O.pants, 0.7), cyan: hexNum(O.glow), scarf: hexNum(O.scarfColor), scarfD: shadeHex(O.scarfColor, 0.65), band: hexNum(O.headbandColor),
    };
    const mesh = (geos: THREE.BufferGeometry[], mat: THREE.Material, parent: THREE.Object3D) => {
      if (!geos.length) return null;
      const g = mergeGeometries(geos)!;
      const mm = new THREE.Mesh(g, mat); mm.castShadow = mat === lit; parent.add(mm); this.owned.push(g);
      if (mat === lit && ink) { const hg = hullGeo(g); const o = new THREE.Mesh(hg, outlineMat(0.0075)); parent.add(o); this.owned.push(hg); } // thin ink outline
      return mm;
    };
    const pivot = (parent: THREE.Object3D, x: number, y: number, z: number, joint = -1): THREE.Group => {
      const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); if (joint >= 0) this.J[joint] = g; return g;
    };
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
    const tuft = (r: number, h: number, x: number, y: number, z: number, rx: number, rz: number, root = C.hair, tip = C.hairM): THREE.BufferGeometry => {
      const g = new THREE.ConeGeometry(r, h, 7, 3); g.translate(0, h / 2, 0); colorize(g, root, tip); g.rotateX(rx); g.rotateZ(rz); g.translate(x, y, z); return g;
    };
    const kbox = (w: number, h: number, d: number, x: number, y: number, z: number, c: number): THREE.BufferGeometry => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return colorize(g, c, null); };
    void kbox;

    // ---- body proportions from gender + build ----
    const shoulder = 0.225 + 0.03 * m + 0.012 * bd, chestRx = 0.168 + 0.025 * m + 0.018 * bd, chestRz = 0.12 + 0.01 * m + 0.012 * bd, waistRx = 0.122 + 0.028 * m + 0.02 * bd;
    const hipsRx = 0.165 + 0.02 * (1 - m) + 0.018 * bd, limb = 0.96 + 0.1 * bd + 0.08 * m, bust = male ? 0 : 0.03;
    const sleeveC = O.top === 1 ? C.skin : C.jacket, sleeveC2 = O.top === 1 ? C.skin : C.jacketL;

    this.root.add(this.rig);
    this.rig.scale.setScalar(0.92 * spec.height);

    // =============================== pelvis: shorts/skirt/pants, obi, coat tails, katana ===============================
    const hip = pivot(this.rig, 0, HIP, 0, H);
    const pelvis: THREE.BufferGeometry[] = [
      E(hipsRx, 0.13, 0.135, 0, -0.01, 0, C.pants, 14),
      T(0.185 + 0.012 * m, 0.195 + 0.012 * m, 0.085, 0, 0.085, 0, C.red, 16), T(0.19 + 0.012 * m, 0.19 + 0.012 * m, 0.014, 0, 0.13, 0, C.gold, 16), T(0.19 + 0.012 * m, 0.19 + 0.012 * m, 0.014, 0, 0.04, 0, C.gold, 16),
      E(0.075, 0.055, 0.03, 0.075, 0.09, -0.2, C.red, 10, 0, 0.3), E(0.075, 0.055, 0.03, -0.075, 0.09, -0.2, C.red, 10, 0, -0.3), E(0.035, 0.04, 0.035, 0, 0.09, -0.2, C.darkRed, 8),
      E(0.03, 0.22, 0.014, 0.06, -0.1, -0.21, C.red, 8, 0.15), E(0.03, 0.2, 0.014, -0.06, -0.09, -0.21, C.darkRed, 8, 0.15), E(0.05, 0.05, 0.035, 0.15, 0.0, 0.11, C.plate, 8),
    ];
    if (O.bottom === 0) pelvis.push(T(0.2, 0.31, 0.3, 0, -0.14, 0, C.jacket, 14, 0, 0, C.jacketL), T(0.312, 0.318, 0.035, 0, -0.295, 0, C.red, 14), T(0.318, 0.318, 0.012, 0, -0.318, 0, C.gold, 14)); // pleated skirt
    if (O.bottom === 3) pelvis.push(T(0.21, 0.34, 0.5, 0, -0.22, 0, C.pants, 14), T(0.342, 0.345, 0.03, 0, -0.47, 0, C.gold, 14));                                                       // hakama
    if (O.top === 2) pelvis.push(E(0.19, 0.42, 0.03, 0, -0.3, -0.15, C.jacket, 12, -0.08, 0, C.jacketL), E(0.05, 0.4, 0.12, 0.2, -0.26, -0.02, C.jacket, 10, 0, -0.1), E(0.05, 0.4, 0.12, -0.2, -0.26, -0.02, C.jacket, 10, 0, 0.1)); // long coat tails
    else pelvis.push(E(0.17, 0.2, 0.03, 0, -0.17, -0.135, C.jacket, 12, -0.1), E(0.05, 0.16, 0.11, 0.17, -0.11, -0.01, C.jacket, 10, 0, -0.18), E(0.05, 0.16, 0.11, -0.17, -0.11, -0.01, C.jacket, 10, 0, 0.18));
    mesh(pelvis, lit, hip);
    mesh([E(0.04, 0.04, 0.012, 0, 0.085, 0.2, C.cyan, 10)], glow, hip);
    if (O.katana) {
      const KX = -0.34, tilt = -0.62;
      const kg = (len: number, w: number, y: number, z: number, c: number, h = w) => { const g = new THREE.CylinderGeometry(w / 2, w / 2, len, 8); g.rotateX(PI / 2 + tilt); g.scale(1, h / w, 1); g.translate(KX, y, z); return paint(g, c); };
      mesh([kg(0.95, 0.05, -0.1, -0.2, 0x14121c), kg(0.03, 0.1, 0.19, 0.215, C.gold), kg(0.26, 0.042, 0.3, 0.37, 0x1d2142), kg(0.05, 0.058, -0.385, -0.585, C.red), kg(0.18, 0.062, -0.03, -0.12, C.red)], lit, hip);
      mesh([kg(0.7, 0.012, -0.08, -0.2, C.cyan)], glow, hip);
    }

    // =============================== torso ===============================
    const spine = pivot(hip, 0, 0.09, 0, SP);
    const torso: THREE.BufferGeometry[] = [
      E(waistRx, 0.17, 0.1 + 0.01 * m, 0, 0.08, 0, O.top === 1 ? C.jacket : C.jacket, 14), E(chestRx, 0.2, chestRz, 0, 0.35, 0.005, C.jacket, 16, 0, 0, C.jacketL),
      E(0.085, 0.14, 0.03, 0, 0.4, chestRz - 0.012, C.white, 10),
      E(0.08, 0.21, 0.022, chestRx * 0.7, 0.37, chestRz - 0.018, C.jacketL, 10, 0, 0.12), E(0.08, 0.21, 0.022, -chestRx * 0.7, 0.37, chestRz - 0.018, C.jacketL, 10, 0, -0.12),
      E(0.012, 0.2, 0.012, chestRx * 1.08, 0.36, 0.05, C.gold, 6), E(0.012, 0.2, 0.012, -chestRx * 1.08, 0.36, 0.05, C.gold, 6),
      E(shoulder * 0.95, 0.065, 0.125, 0, 0.5, 0, C.jacket, 14),
      T(0.075, 0.09, 0.075, 0, 0.56, 0, C.jacketL, 12), E(0.055, 0.08, 0.034, 0.065, 0.585, -0.04, C.jacketL, 8, 0, 0.3), E(0.055, 0.08, 0.034, -0.065, 0.585, -0.04, C.jacketL, 8, 0, -0.3),
      T(waistRx + 0.06, waistRx + 0.05, 0.02, 0, 0.255, 0.003, C.red, 16),
      ...[0.31, 0.38, 0.45].flatMap((y) => [E(0.017, 0.017, 0.01, 0.06, y, chestRz + 0.013, C.gold, 8), E(0.017, 0.017, 0.01, -0.06, y, chestRz + 0.013, C.gold, 8)]),
      E(0.115, 0.14, 0.065, 0, 0.36, -0.165, C.plate, 12), E(0.095, 0.03, 0.07, 0, 0.5, -0.165, C.plateL, 10),
      T(0.034, 0.046, 0.075, 0.055, 0.23, -0.215, C.plateL, 8, PI / 2), T(0.034, 0.046, 0.075, -0.055, 0.23, -0.215, C.plateL, 8, PI / 2),
    ];
    if (!male) torso.push(E(0.07, 0.07, 0.06, 0.075, 0.33, 0.085 + bust, C.jacket, 10), E(0.07, 0.07, 0.06, -0.075, 0.33, 0.085 + bust, C.jacket, 10)); // bust curve under the jacket
    mesh(torso, lit, spine);
    mesh([
      E(0.034, 0.034, 0.01, 0, 0.355, chestRz + 0.016, C.cyan, 10), E(0.008, 0.07, 0.006, 0.08, 0.35, chestRz + 0.016, C.cyan, 6), E(0.008, 0.07, 0.006, -0.08, 0.35, chestRz + 0.016, C.cyan, 6),
      E(0.03, 0.03, 0.012, 0.055, 0.23, -0.26, C.cyan, 8), E(0.03, 0.03, 0.012, -0.055, 0.23, -0.26, C.cyan, 8),
    ], glow, spine);

    // =============================== head ===============================
    const head = pivot(spine, 0, 0.6, 0, HD);
    head.scale.setScalar(1.42 * spec.head);
    const wScale = 1 + 0.1 * F_.width, jaw = 1 + 0.18 * F_.jaw;
    const HR = { x: 0.135 * wScale, y: 0.15, z: 0.138, cy: 0.23 };
    const ens = F_.earSize, ear = F_.ears;
    const headGeos: THREE.BufferGeometry[] = [
      T(0.05 + 0.006 * m, 0.058 + 0.008 * m, 0.12, 0, 0.04, 0, C.skinS, 10),
      E(HR.x, HR.y, HR.z, 0, HR.cy, -0.005, C.skin, 22), E(0.095 * wScale * jaw, 0.09, 0.105, 0, 0.125, 0.034, C.skin, 16), E(0.045 * jaw, 0.04 * (1 + 0.2 * F_.jaw), 0.045, 0, 0.082, 0.065, C.skin, 10),
      // nose bump
      E(0.011 * F_.noseWidth * F_.noseSize, 0.015 * F_.noseSize, 0.014 * F_.noseSize, 0, 0.165 + 0.01 * F_.noseHeight, 0.134, C.skinS, 8),
    ];
    if (ear === 0) headGeos.push(E(0.022 * ens, 0.034 * ens, 0.024 * ens, HR.x - 0.002, 0.205, 0, C.skin, 8), E(0.022 * ens, 0.034 * ens, 0.024 * ens, -HR.x + 0.002, 0.205, 0, C.skin, 8));
    if (ear === 1) for (const sx of [-1, 1]) headGeos.push(tuft(0.026 * ens, 0.16 * ens, sx * (HR.x - 0.005), 0.2, 0, 0, sx * -1.3 + (sx > 0 ? 0 : 0), C.skin, C.skinS));
    if (ear === 2) { for (const sx of [-1, 1]) { headGeos.push(tuft(0.06 * ens, 0.17 * ens, sx * 0.1, 0.36, -0.02, 0, sx * -0.35, C.hair, C.hairM), tuft(0.035 * ens, 0.11 * ens, sx * 0.1, 0.365, 0.0, 0, sx * -0.35, 0xff9ab0, 0xffc0d0)); headGeos.push(E(0.02, 0.03, 0.022, sx * (HR.x - 0.002), 0.2, 0, C.skin, 6)); } }
    // hair
    const cap = (rx: number, ry: number, rz: number, y: number, z: number) => E(rx, ry, rz, 0, y, z, C.hair, 18, 0, 0, C.hairM);
    const bangs = H_.bangs, sheenBand = () => T(0.151, 0.153, 0.026, 0, 0.325, -0.026, C.hairL, 18);
    const fringe = (n: number, len: number, spread = 0.1) => { const out: THREE.BufferGeometry[] = []; for (let i = 0; i < n; i++) { const t = n === 1 ? 0 : i / (n - 1) - 0.5, x = t * 2 * spread; out.push(tuft(0.05, len * bangs, x, 0.34, 0.115, PI + 0.12, -t * 0.5, C.hair, i & 1 ? C.hairL : C.hairM)); } return out; };
    const tail1: THREE.BufferGeometry[] = [], tail2: THREE.BufferGeometry[] = [];
    const style = H_.style;
    const hairGeo: THREE.BufferGeometry[] = [];
    switch (style) {
      case 0: // Spiky
        hairGeo.push(cap(0.152, 0.165, 0.16, 0.265, -0.03), sheenBand(), ...fringe(5, 0.18), tuft(0.045, 0.2, 0.14, 0.33, 0.03, PI, 0.06), tuft(0.045, 0.2, -0.14, 0.33, 0.03, PI, -0.06),
          tuft(0.06, 0.3, 0.075, 0.37, -0.09, -1.15, -0.4, C.hair, C.hairL), tuft(0.06, 0.32, -0.075, 0.37, -0.09, -1.15, 0.4, C.hair, C.hairM), tuft(0.065, 0.33, 0, 0.39, -0.11, -1.3, 0, C.hair, C.hairL),
          tuft(0.05, 0.26, 0.14, 0.31, -0.05, -0.9, -0.8, C.hair, C.hairL), tuft(0.05, 0.26, -0.14, 0.31, -0.05, -0.9, 0.8, C.hair, C.hairM), tuft(0.04, 0.2, 0.06, 0.42, 0.06, -0.2, 0.5, C.hair, C.hairL), tuft(0.04, 0.2, -0.06, 0.42, 0.06, -0.2, -0.5, C.hair, C.hairL));
        break;
      case 1: // Ponytail
        hairGeo.push(cap(0.152, 0.165, 0.16, 0.265, -0.03), sheenBand(), ...fringe(5, 0.17), tuft(0.045, 0.34, 0.14, 0.33, 0.03, PI, 0.06, C.hair, C.hairL), tuft(0.045, 0.34, -0.14, 0.33, 0.03, PI, -0.06, C.hair, C.hairL),
          tuft(0.06, 0.28, 0.075, 0.37, -0.09, -1.15, -0.4), tuft(0.06, 0.3, -0.075, 0.37, -0.09, -1.15, 0.4, C.hair, C.hairL), tuft(0.065, 0.31, 0, 0.39, -0.11, -1.3, 0), tuft(0.018, 0.14, 0.02, 0.42, 0.04, 0.2, 0.7, C.hair, C.hairL));
        tail1.push(E(0.06, 0.06, 0.055, 0, 0, 0, C.hair, 10, 0, 0, C.hairM), T(0.055, 0.04, 0.32, 0, -0.17, 0, C.hair, 10, 0, 0, C.hairM), T(0.066, 0.066, 0.03, 0, -0.01, 0, C.band, 10));
        tail2.push(T(0.04, 0.008, 0.38, 0, -0.19, 0, C.hairM, 10, 0, 0, C.hairTip));
        break;
      case 2: // Bob
        hairGeo.push(E(0.17, 0.17, 0.172, 0, 0.255, -0.02, C.hair, 20, 0, 0, C.hairM), T(0.17, 0.16, 0.17, 0, 0.14, -0.03, C.hair, 20, 0, 0, C.hairM), sheenBand(), E(0.145, 0.052, 0.04, 0, 0.335, 0.122, C.hair, 14),
          ...fringe(4, 0.1, 0.09), E(0.04, 0.12, 0.05, 0.145, 0.15, 0.06, C.hair, 8), E(0.04, 0.12, 0.05, -0.145, 0.15, 0.06, C.hair, 8));
        break;
      case 3: // Long straight
        hairGeo.push(cap(0.155, 0.168, 0.165, 0.262, -0.03), sheenBand(), ...fringe(5, 0.15), E(0.19, 0.6, 0.075, 0, -0.18, -0.11, C.hair, 14, 0, 0, C.hairM), E(0.042, 0.34, 0.045, 0.145, 0.0, 0.05, C.hair, 8, 0, 0, C.hairM), E(0.042, 0.34, 0.045, -0.145, 0.0, 0.05, C.hair, 8, 0, 0, C.hairM));
        break;
      case 4: // Twin tails
        hairGeo.push(cap(0.152, 0.165, 0.16, 0.265, -0.03), sheenBand(), ...fringe(5, 0.16), tuft(0.04, 0.18, 0.14, 0.32, 0.03, PI, 0.06), tuft(0.04, 0.18, -0.14, 0.32, 0.03, PI, -0.06));
        for (const sx of [-1, 1]) { tail1.push(E(0.05, 0.05, 0.05, sx * 0.18, -0.02, 0.0, C.band, 10), T(0.06, 0.03, 0.42, sx * 0.2, -0.22, 0, C.hair, 10, 0, sx * 0.12, C.hairM)); tail2.push(T(0.035, 0.008, 0.4, sx * 0.23, -0.15, 0, C.hairM, 10, 0, sx * 0.1, C.hairTip)); }
        break;
      case 5: // Braid
        hairGeo.push(cap(0.152, 0.165, 0.16, 0.265, -0.03), sheenBand(), ...fringe(5, 0.16), tuft(0.045, 0.24, 0.14, 0.33, 0.03, PI, 0.06), tuft(0.045, 0.24, -0.14, 0.33, 0.03, PI, -0.06));
        for (let i = 0; i < 5; i++) tail1.push(E(0.05 - i * 0.003, 0.045, 0.05, (i & 1 ? 0.012 : -0.012), -0.04 - i * 0.07, 0, i & 1 ? C.hairM : C.hair, 10));
        for (let i = 0; i < 5; i++) tail2.push(E(0.043 - i * 0.004, 0.04, 0.043, (i & 1 ? 0.01 : -0.01), -0.04 - i * 0.07, 0, i & 1 ? C.hairTip : C.hairM, 10));
        tail2.push(E(0.03, 0.03, 0.03, 0, -0.4, 0, C.band, 8));
        break;
      case 6: // Odango buns
        hairGeo.push(cap(0.152, 0.165, 0.16, 0.265, -0.03), sheenBand(), ...fringe(5, 0.15), tuft(0.045, 0.22, 0.14, 0.33, 0.03, PI, 0.06), tuft(0.045, 0.22, -0.14, 0.33, 0.03, PI, -0.06),
          E(0.075, 0.075, 0.075, 0.12, 0.43, -0.02, C.hair, 14, 0, 0, C.hairM), E(0.075, 0.075, 0.075, -0.12, 0.43, -0.02, C.hair, 14, 0, 0, C.hairM), E(0.04, 0.02, 0.04, 0.12, 0.375, -0.02, C.band, 8), E(0.04, 0.02, 0.04, -0.12, 0.375, -0.02, C.band, 8),
          E(0.04, 0.12, 0.04, 0.15, 0.2, -0.06, C.hair, 8), E(0.04, 0.12, 0.04, -0.15, 0.2, -0.06, C.hair, 8));
        break;
      case 7: // Short messy
        hairGeo.push(cap(0.148, 0.16, 0.155, 0.268, -0.025), sheenBand(), ...fringe(6, 0.13, 0.11));
        for (let i = 0; i < 9; i++) { const a = (i / 9) * 6.283, x = Math.cos(a) * 0.09, z = Math.sin(a) * 0.09 - 0.01; hairGeo.push(tuft(0.04, 0.14 + (i % 3) * 0.04, x, 0.38, z, Math.sin(a) * 0.9, -Math.cos(a) * 0.9, C.hair, i & 1 ? C.hairL : C.hairM)); }
        break;
      case 8: // Side swept
        hairGeo.push(cap(0.152, 0.165, 0.16, 0.265, -0.03), sheenBand(), E(0.13, 0.04, 0.075, -0.02, 0.35, 0.1, C.hair, 14, 0.5, 0.2, C.hairM), tuft(0.07, 0.26 * bangs, 0.08, 0.34, 0.11, PI + 0.15, 0.95, C.hair, C.hairL), tuft(0.06, 0.2 * bangs, 0.0, 0.345, 0.12, PI + 0.1, 0.6, C.hair, C.hairM),
          tuft(0.045, 0.2, -0.14, 0.32, 0.03, PI, -0.06), tuft(0.05, 0.22, 0.14, 0.3, 0.02, PI, 0.1), tuft(0.06, 0.26, 0, 0.37, -0.1, -1.2, 0));
        break;
      case 9: // Topknot
        hairGeo.push(E(0.145, 0.158, 0.153, 0, 0.268, -0.02, C.hair, 18, 0, 0, C.hairM), sheenBand(), ...fringe(4, 0.1, 0.08), E(0.06, 0.072, 0.06, 0, 0.47, -0.03, C.hair, 12, 0, 0, C.hairM), T(0.07, 0.07, 0.02, 0, 0.415, -0.03, C.band, 10));
        tail1.push(E(0.001, 0.001, 0.001, 0, 0, 0, C.hair, 6));
        break;
      case 10: // Wavy long
        hairGeo.push(cap(0.155, 0.168, 0.165, 0.262, -0.03), sheenBand(), ...fringe(5, 0.15));
        for (let i = 0; i < 6; i++) { const x = (i & 1 ? 1 : -1) * 0.025; hairGeo.push(E(0.17 - i * 0.008, 0.11, 0.08, x, 0.12 - i * 0.13, -0.12, C.hair, 12, 0, 0, i > 2 ? C.hairTip : C.hairM)); }
        for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) hairGeo.push(E(0.04, 0.1, 0.045, sx * (0.145 + (i & 1) * 0.02), 0.1 - i * 0.1, 0.05, C.hair, 8, 0, 0, C.hairM));
        break;
      default: // Slick short
        hairGeo.push(E(0.142, 0.15, 0.15, 0, 0.268, -0.02, C.hair, 18, 0, 0, C.hairM), sheenBand(), E(0.13, 0.06, 0.1, 0, 0.345, 0.07, C.hair, 14, -0.3, 0, C.hairM), E(0.05, 0.1, 0.08, 0.13, 0.22, -0.02, C.hair, 8), E(0.05, 0.1, 0.08, -0.13, 0.22, -0.02, C.hair, 8));
    }
    headGeos.push(...hairGeo);
    if (O.headband) headGeos.push(T(0.142 * wScale, 0.142 * wScale, 0.03, 0, 0.3, -0.005, C.band, 20), E(0.042, 0.024, 0.014, 0, 0.3, 0.145, C.plate, 10));
    if (O.wings) headGeos.push(E(0.05, 0.014, 0.075, 0.16, 0.335, -0.01, C.gold, 8, 0.2, -0.5), E(0.05, 0.014, 0.075, -0.16, 0.335, -0.01, C.gold, 8, 0.2, 0.5), E(0.04, 0.012, 0.06, 0.185, 0.355, -0.02, C.gold, 8, 0.3, -0.7), E(0.04, 0.012, 0.06, -0.185, 0.355, -0.02, C.gold, 8, 0.3, 0.7));
    mesh(headGeos, lit, head);
    // painted face on a spherical patch just outside the skin
    {
      const phiLen = 1.55, g = new THREE.SphereGeometry(1, 28, 20, PI / 2 - phiLen / 2, phiLen, 1.2, 1.15);
      g.scale(HR.x * 1.006, HR.y * 1.006, HR.z * 1.006); g.translate(0, HR.cy, -0.005);
      const tex = faceTexture(spec);
      const fm = new THREE.MeshToonMaterial({ map: tex, transparent: true, gradientMap: assets.ramp, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, depthWrite: false });
      head.add(new THREE.Mesh(g, fm)); this.owned.push(g, tex, fm);
    }
    mesh([E(0.014, 0.014, 0.01, 0, 0.3, 0.152, C.cyan, 8)], glow, head);
    const t1 = pivot(head, 0, 0.34, -0.17, T1); mesh(tail1, lit, t1);
    const t2 = pivot(t1, 0, -0.33, 0, T2); mesh(tail2, lit, t2);

    // scarf
    const s1 = pivot(spine, 0, 0.58, -0.16, S1), s2 = pivot(s1, 0, -0.42, 0, S2);
    if (O.scarf) {
      mesh([E(0.14, 0.22, 0.022, 0, -0.21, 0, C.scarf, 10), E(0.155, 0.065, 0.155, 0, 0.04, 0.15, C.scarf, 12), E(0.02, 0.21, 0.026, 0.105, -0.21, 0, C.gold, 6)], lit, s1);
      mesh([E(0.13, 0.23, 0.02, 0, -0.21, 0, C.scarfD, 10), E(0.115, 0.075, 0.02, 0, -0.44, 0, C.scarfD, 8, 0, 0.4)], lit, s2);
    }

    // =============================== arms ===============================
    for (const side of [-1, 1] as const) {
      const sh = pivot(spine, shoulder * side, 0.5, 0, side < 0 ? SHL : SHR);
      const arm: THREE.BufferGeometry[] = [E(0.085 * limb, 0.085 * limb, 0.085 * limb, 0, 0, 0, sleeveC, 12), T(0.072 * limb, 0.056 * limb, 0.31, 0, -0.155, 0, sleeveC, 12, 0, 0, sleeveC2)];
      if (O.top !== 1) arm.push(E(0.108, 0.055, 0.115, 0.012 * side, 0.05, 0, C.plate, 12), E(0.106, 0.02, 0.113, 0.012 * side, 0.082, 0, C.gold, 12), E(0.1, 0.05, 0.108, 0.02 * side, 0.015, 0, C.jacketL, 10), T(0.066 * limb, 0.066 * limb, 0.02, 0, -0.29, 0, C.gold, 12));
      else arm.push(E(0.1, 0.05, 0.1, 0.01 * side, 0.03, 0, C.jacket, 10));
      mesh(arm, lit, sh);
      const el = pivot(sh, 0, -0.31, 0, side < 0 ? ELL : ELR);
      mesh([
        E(0.058 * limb, 0.058 * limb, 0.058 * limb, 0, 0, 0, sleeveC, 10), T(0.056 * limb, 0.043 * limb, 0.27, 0, -0.135, 0, sleeveC, 12),
        T(0.06 * limb, 0.053 * limb, 0.14, 0, -0.19, 0, C.plate, 12), T(0.064 * limb, 0.064 * limb, 0.02, 0, -0.12, 0, C.red, 12),
        E(0.046, 0.06, 0.034, 0, -0.325, 0.002, C.white, 10), E(0.014, 0.034, 0.014, -0.025, -0.388, 0.012, C.white, 6), E(0.014, 0.037, 0.014, -0.008, -0.394, 0.014, C.white, 6),
        E(0.014, 0.037, 0.014, 0.009, -0.394, 0.014, C.white, 6), E(0.014, 0.034, 0.014, 0.026, -0.388, 0.012, C.white, 6), E(0.015, 0.03, 0.015, 0.05 * side, -0.32, 0.024, C.white, 6, 0, 0.6 * side),
        T(0.052, 0.05, 0.02, 0, -0.275, 0, C.gold, 10),
      ], lit, el);
      mesh([E(0.008, 0.055, 0.008, 0, -0.19, 0.062, C.cyan, 6), E(0.036, 0.006, 0.006, 0, -0.27, 0.044, C.cyan, 6)], glow, el);
    }

    // =============================== legs ===============================
    const legMain = O.bottom === 2 || O.bottom === 3 ? C.pants : O.bottom === 1 ? C.skin : C.sock; // pants colour, bare legs for shorts, socks for skirt
    for (const side of [-1, 1] as const) {
      const th = pivot(hip, 0.105 * side, -0.02, 0, side < 0 ? THL : THR);
      const thigh: THREE.BufferGeometry[] = [E(0.1 * limb, 0.1 * limb, 0.1 * limb, 0, 0, 0, legMain, 12), T(0.098 * limb, 0.07 * limb, TH, 0, -TH / 2, 0, legMain, 14)];
      if (O.bottom === 0) thigh.push(T(0.1, 0.1, 0.02, 0, -0.1, 0, C.red, 14));
      if (O.bottom === 1) thigh.push(T(0.108 * limb, 0.1 * limb, 0.17, 0, -0.085, 0, C.pants, 14), T(0.103 * limb, 0.103 * limb, 0.02, 0, -0.17, 0, C.gold, 14));
      mesh(thigh, lit, th);
      const kn = pivot(th, 0, -TH, 0, side < 0 ? KNL : KNR);
      const shin: THREE.BufferGeometry[] = [E(0.07 * limb, 0.07 * limb, 0.07 * limb, 0, 0, 0, legMain, 12), T(0.07 * limb, 0.052 * limb, SH, 0, -SH / 2, 0, legMain, 12)];
      if (O.boots === 0) shin.push(T(0.082, 0.07, 0.24, 0, -0.25, 0, C.boot, 14, 0, 0, shadeHex(O.bootColor, 1.6)), T(0.087, 0.087, 0.022, 0, -0.14, 0, C.gold, 14), E(0.058, 0.075, 0.045, 0, -0.2, 0.066, C.plate, 10),
        T(0.086, 0.086, 0.018, 0, -0.25, 0, C.plateL, 14), E(0.02, 0.02, 0.012, 0, -0.25, 0.088, C.gold, 8), T(0.084, 0.084, 0.018, 0, -0.33, 0, C.plateL, 14), E(0.02, 0.02, 0.012, 0, -0.33, 0.086, C.gold, 8));
      else if (O.boots === 1) shin.push(T(0.078, 0.07, 0.1, 0, -0.34, 0, C.boot, 14), T(0.082, 0.082, 0.02, 0, -0.29, 0, C.gold, 14));
      else shin.push(T(0.062, 0.058, 0.06, 0, -0.37, 0, C.white, 12));
      if (O.bottom === 3) shin.push(T(0.1, 0.12, 0.16, 0, -0.1, 0, C.pants, 14));
      mesh(shin, lit, kn);
      if (O.boots === 0) mesh([E(0.006, 0.1, 0.006, 0, -0.24, 0.1, C.cyan, 6)], glow, kn);
      const an = pivot(kn, 0, -SH, 0, side < 0 ? ANL : ANR);
      const bc = O.boots === 2 ? C.white : C.boot, sole = O.boots === 2 ? C.red : C.red;
      mesh([E(0.058, 0.05, 0.135, 0, -0.035, 0.05, bc, 12), E(0.055, 0.04, 0.075, 0, -0.04, 0.155, bc, 10), E(0.056, 0.032, 0.045, 0, -0.03, 0.21, O.boots === 2 ? C.jacketL : C.plate, 8), E(0.064, 0.018, 0.185, 0, -0.082, 0.062, sole, 10)], lit, an);
    }
    this.hipY = HIP;
  }

  /** release geometries, textures and materials created for this hero */
  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
    this.root.removeFromParent();
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
