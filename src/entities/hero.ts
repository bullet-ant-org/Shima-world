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
import { ends, grad, keys, loft, setLoftDetail, type ColorFn, type LoftOpts, type V3 } from './sculpt';

export type Mode = 'ground' | 'fly' | 'brace' | 'land' | 'ride';
export interface PoseIn { dt: number; mode: Mode; hs: number; speed: number; vy: number; grounded: boolean; boost: boolean; bank: number; gait?: number }

// joints
export const H = 0, SP = 1, HD = 2, T1 = 3, T2 = 4, S1 = 5, S2 = 6, SHL = 7, ELL = 8, SHR = 9, ELR = 10, THL = 11, KNL = 12, ANL = 13, THR = 14, KNR = 15, ANR = 16;
export const NJ = 17;
/** parent joint of each joint (-1 = rig root) */
export const JOINT_PARENT = [-1, 0, 1, 2, 3, 1, 5, 1, 7, 1, 9, 0, 11, 12, 0, 14, 15];
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
  { wr: 1.0, hr: 1.0, lid: 0, flick: 0.8 },     // round
  { wr: 1.12, hr: 0.8, lid: 0.06, flick: 1.5 }, // sharp
  { wr: 1.05, hr: 0.86, lid: 0.3, flick: 0.5 }, // sleepy
  { wr: 1.18, hr: 0.88, lid: 0.03, flick: 1.9 },// cat
];

/** face decal layout: the canvas covers head-local x in [-FW/2, FW/2] and y in [FY0, FY0 + FH] (canvas top = FY0 + FH) */
const FW = 0.25, FY0 = 0.045, FH = 0.24;
const css = (hex: number) => '#' + hex.toString(16).padStart(6, '0');
const rgbOf = (h: string) => `${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)}`;

/** Hand-painted anime face driven by the spec: eye shape/size/spacing/height/tilt, iris, lash line, eyeshadow, brows, nose, lips, blush. */
export function faceTexture(spec: CharacterSpec): THREE.CanvasTexture {
  const f = spec.face, S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const sp = EYE_SHAPE[f.eyeShape] ?? EYE_SHAPE[0];
  const skinD = css(shadeHex(spec.skin, 0.72)), line = css(shadeHex(spec.skin, 0.42));
  const sep = 0.2 + 0.05 * f.eyeSpacing, cy = (0.5 + 0.04 * f.eyeHeight) * S, es = f.eyeSize;
  // blush (+ little hatch strokes when strong)
  for (const x of [0.22, 0.78]) {
    const r = g.createRadialGradient(x * S, 0.7 * S, 4, x * S, 0.7 * S, 50);
    r.addColorStop(0, `rgba(255,95,120,${0.55 * f.blush})`); r.addColorStop(1, 'rgba(255,95,120,0)');
    g.fillStyle = r; g.fillRect(x * S - 55, 0.7 * S - 55, 110, 110);
    if (f.blush > 0.45) {
      g.strokeStyle = `rgba(225,70,100,${Math.min(0.8, (f.blush - 0.45) * 1.4)})`; g.lineWidth = 3; g.lineCap = 'round';
      for (let i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(x * S + i * 12 - 4, 0.7 * S + 7); g.lineTo(x * S + i * 12 + 4, 0.7 * S - 7); g.stroke(); }
    }
  }
  if (f.freckles) { g.fillStyle = `rgba(${rgbOf(css(shadeHex(spec.skin, 0.55)))},0.6)`; for (let i = 0; i < 16; i++) { const side = i & 1 ? 1 : -1, x = 0.5 + side * (0.1 + (i * 37 % 17) / 100), y = 0.64 + ((i * 53) % 9) / 100; g.beginPath(); g.arc(x * S, y * S, 2.2 + (i % 3) * 0.7, 0, 7); g.fill(); } }
  // eyeshadow
  if (f.shadowAmt > 0) for (const sx of [-1, 1]) {
    const x = (0.5 + sx * sep) * S, y = cy - 36 * es, rgb = rgbOf(f.shadow), r = g.createRadialGradient(x, y, 4, x, y, 70 * es);
    r.addColorStop(0, `rgba(${rgb},${0.6 * f.shadowAmt})`); r.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = r; g.beginPath(); g.ellipse(x, y, 80 * es, 46 * es, 0, 0, 7); g.fill();
  }
  const iris = new THREE.Color(f.iris), hx = (c: THREE.Color) => '#' + c.getHexString();
  const irisTop = hx(iris.clone().multiplyScalar(0.3)), irisMid = hx(iris), irisBot = hx(iris.clone().lerp(new THREE.Color('#ffffff'), 0.5)), irisRim = hx(iris.clone().multiplyScalar(0.16));
  const ink = '#140c1e';
  const eye = (cx: number, flip: number) => {
    const ew = 100 * es * sp.wr, eh = 122 * es * sp.hr, hw = ew / 2, hh = eh / 2;
    g.save(); g.translate(cx, cy); g.scale(flip, 1); g.rotate(f.eyeTilt * 0.2);
    // local space: +x = inner corner (toward the nose), -x = outer corner; u runs 0 (inner) .. 1 (outer)
    const X = (u: number) => hw * Math.cos(Math.PI * u);
    const lidY = (u: number) => -hh * Math.sin(Math.PI * u) * (1 - sp.lid * 1.2) - hh * 0.08;
    const lowY = (u: number) => hh * 0.92 * Math.sin(Math.PI * u);
    const shapePath = () => { g.beginPath(); for (let k = 0; k <= 24; k++) g.lineTo(X(k / 24), lidY(k / 24)); for (let k = 24; k >= 0; k--) g.lineTo(X(k / 24), lowY(k / 24)); g.closePath(); };
    shapePath(); g.save(); g.clip();
    g.fillStyle = '#fbfcff'; g.fillRect(-hw - 4, -hh - 4, ew + 8, eh + 8);
    const ix = -ew * 0.03, iy = eh * 0.05, irx = ew * 0.36, iry = eh * 0.46;
    const gr = g.createLinearGradient(0, iy - iry, 0, iy + iry); gr.addColorStop(0, irisTop); gr.addColorStop(0.5, irisMid); gr.addColorStop(1, irisBot);
    g.fillStyle = gr; g.beginPath(); g.ellipse(ix, iy, irx, iry, 0, 0, 7); g.fill();
    g.strokeStyle = irisRim; g.lineWidth = 4; g.stroke();
    g.fillStyle = irisRim; g.beginPath(); g.ellipse(ix, iy - iry * 0.06, irx * 0.42, iry * 0.48, 0, 0, 7); g.fill();
    g.fillStyle = 'rgba(70,60,120,0.28)'; g.fillRect(-hw - 4, -hh - 4, ew + 8, hh * 0.62); // soft shadow cast by the upper lid
    g.fillStyle = 'rgba(255,255,255,0.97)'; g.beginPath(); g.ellipse(ix + irx * 0.36, iy - iry * 0.4, 12 * es, 15 * es, -0.4, 0, 7); g.fill();
    g.beginPath(); g.ellipse(ix - irx * 0.42, iy + iry * 0.45, 6 * es, 7 * es, 0, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.32)'; g.beginPath(); g.ellipse(ix, iy + iry * 0.58, irx * 0.62, iry * 0.2, 0, 0, 7); g.fill();
    g.restore();
    // upper lash line: a filled crescent, thin at the inner corner, heavy at the outer corner, ending in a winged flick
    const lw = 0.6 + 0.7 * f.lash;
    g.fillStyle = ink; g.beginPath();
    for (let k = 0; k <= 24; k++) g.lineTo(X(k / 24), lidY(k / 24) + 2);
    g.lineTo(-hw - ew * 0.13 * sp.flick * lw, -hh * 0.18 - eh * 0.11 * sp.flick);
    for (let k = 24; k >= 0; k--) { const u = k / 24; g.lineTo(X(u) * 1.03, lidY(u) - (3 + eh * (0.03 + 0.13 * Math.pow(u, 1.4)) * lw)); }
    g.closePath(); g.fill();
    if (f.lash > 0.3) {
      g.strokeStyle = ink; g.lineCap = 'round';
      for (const [u, l] of [[0.7, 0.15], [0.86, 0.2]]) {
        const x = X(u), y = lidY(u) - eh * 0.12 * lw; g.lineWidth = 3 + 3 * f.lash;
        g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x - ew * 0.05, y - eh * l * 0.6 * f.lash, x - ew * 0.13, y - eh * l * f.lash); g.stroke();
      }
    }
    // lower lash line (outer half) and lid crease
    g.strokeStyle = ink; g.lineWidth = 3; g.globalAlpha = 0.85; g.beginPath(); for (let k = 11; k <= 24; k++) g.lineTo(X(k / 24), lowY(k / 24)); g.stroke();
    g.globalAlpha = 0.4; g.lineWidth = 2.5; g.beginPath(); for (let k = 6; k <= 22; k++) g.lineTo(X(k / 24) * 0.95, lidY(k / 24) - eh * 0.32); g.stroke();
    g.globalAlpha = 1;
    g.restore();
  };
  eye((0.5 - sep) * S, 1); eye((0.5 + sep) * S, -1);
  // brows: tapered strokes, inner end lowered for a stern look
  const browC = hx(new THREE.Color(spec.hair.color).lerp(new THREE.Color('#000000'), 0.35));
  const bh = (0.3 - 0.03 * f.browHeight - 0.02 * (es - 1)) * S, bt = 4 + 10 * f.brow;
  g.fillStyle = browC;
  for (const sx of [-1, 1]) {
    const xi = (0.5 + sx * (sep - 0.08)) * S, xo = (0.5 + sx * (sep + 0.13)) * S, yi = bh + 0.03 * S * f.browAngle, yo = bh - 0.004 * S, ym = bh - 0.032 * S;
    g.beginPath(); g.moveTo(xi, yi - bt * 0.5); g.quadraticCurveTo((xi + xo) / 2, ym - bt * 0.5, xo, yo); g.quadraticCurveTo((xi + xo) / 2, ym + bt * 0.45, xi, yi + bt * 0.5); g.closePath(); g.fill();
  }
  // nose: a small side shadow stroke + soft nostrils (the bump itself is sculpted)
  const nw = f.noseWidth, ns = f.noseSize, ny = (0.7 + 0.03 * f.noseHeight) * S;
  g.strokeStyle = skinD; g.lineCap = 'round'; g.lineWidth = 3.5 * nw;
  g.beginPath(); g.moveTo(0.5 * S + 4 * nw, ny - 16 * ns); g.quadraticCurveTo(0.5 * S + 10 * nw, ny - 2 * ns, 0.5 * S + 2 * nw, ny + 3 * ns); g.stroke();
  g.fillStyle = skinD; g.globalAlpha = 0.55;
  for (const sx of [-1, 1]) { g.beginPath(); g.ellipse(0.5 * S + sx * 6 * nw, ny + 2, 2.6 * ns * nw, 2 * ns, 0, 0, 7); g.fill(); }
  g.globalAlpha = 1;
  // facial hair (painted in a darkened hair colour) and an optional scar over the left eye
  const hairInk = '#' + new THREE.Color(spec.hair.color).lerp(new THREE.Color('#000000'), 0.25).getHexString();
  if (f.beard > 0) {
    const my0 = (0.8 + 0.03 * f.mouthHeight) * S, mw0 = 0.055 * S * f.mouthWidth;
    const jaw = () => { g.beginPath(); g.moveTo(0.13 * S, 0.66 * S); g.quadraticCurveTo(0.16 * S, 0.94 * S, 0.5 * S, 1.02 * S); g.quadraticCurveTo(0.84 * S, 0.94 * S, 0.87 * S, 0.66 * S); g.lineTo(0.8 * S, 0.7 * S); g.quadraticCurveTo(0.72 * S, 0.86 * S, 0.5 * S, 0.88 * S); g.quadraticCurveTo(0.28 * S, 0.86 * S, 0.2 * S, 0.7 * S); g.closePath(); };
    g.save();
    if (f.beard === 1) { jaw(); g.clip(); g.fillStyle = hairInk; for (let i = 0; i < 900; i++) { const x = ((i * 7919) % 1000) / 1000, y = ((i * 104729) % 1000) / 1000; g.globalAlpha = 0.35; g.fillRect((0.1 + x * 0.8) * S, (0.55 + y * 0.47) * S, 2, 2); } }
    else if (f.beard === 3) { jaw(); g.fillStyle = hairInk; g.globalAlpha = 0.85; g.fill(); g.beginPath(); g.moveTo(0.5 * S - mw0 * 1.3, my0 + 4); g.quadraticCurveTo(0.5 * S, my0 - 0.055 * S, 0.5 * S + mw0 * 1.3, my0 + 4); g.quadraticCurveTo(0.5 * S, my0 - 0.022 * S, 0.5 * S - mw0 * 1.3, my0 + 4); g.fill(); }
    if (f.beard === 2 || f.beard === 4) {
      g.fillStyle = hairInk; g.globalAlpha = 0.9;
      g.beginPath(); g.moveTo(0.5 * S - mw0 * 1.25, my0 + 2); g.quadraticCurveTo(0.5 * S, my0 - 0.06 * S, 0.5 * S + mw0 * 1.25, my0 + 2); g.quadraticCurveTo(0.5 * S, my0 - 0.025 * S, 0.5 * S - mw0 * 1.25, my0 + 2); g.fill(); // moustache
      if (f.beard === 2) { g.beginPath(); g.moveTo(0.5 * S - mw0 * 0.6, my0 + 0.035 * S); g.quadraticCurveTo(0.5 * S, my0 + 0.03 * S, 0.5 * S + mw0 * 0.6, my0 + 0.035 * S); g.lineTo(0.5 * S, 1.0 * S); g.closePath(); g.fill(); } // goatee
    }
    g.restore();
  }
  if (f.scar) {
    const x = (0.5 + sep) * S + 10;
    g.strokeStyle = 'rgba(150,60,70,0.85)'; g.lineWidth = 6; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x - 22, cy - 95); g.lineTo(x + 18, cy + 70); g.stroke();
    g.lineWidth = 3; for (let k = 0; k < 4; k++) { const t = 0.15 + k * 0.23, px = x - 22 + 40 * t, py = cy - 95 + 165 * t; g.beginPath(); g.moveTo(px - 9, py + 2); g.lineTo(px + 9, py - 2); g.stroke(); }
  }
  // mouth
  const mx = 0.5 * S, my = (0.8 + 0.03 * f.mouthHeight) * S, mw = 0.055 * S * f.mouthWidth;
  if (f.lipAmt > 0 && f.mouth !== 2) { g.globalAlpha = f.lipAmt; g.fillStyle = f.lips; g.beginPath(); g.ellipse(mx, my + 5, mw * 0.7, 7, 0, 0, 7); g.fill(); g.globalAlpha = 1; }
  g.strokeStyle = line; g.lineWidth = 5; g.lineCap = 'round';
  if (f.mouth === 0) { g.beginPath(); g.moveTo(mx - mw, my - 2); g.quadraticCurveTo(mx, my + 0.045 * S, mx + mw, my - 2); g.stroke(); }
  else if (f.mouth === 1) { g.beginPath(); g.moveTo(mx - mw * 0.75, my + 2); g.quadraticCurveTo(mx, my + 4, mx + mw * 0.75, my + 2); g.stroke(); }
  else if (f.mouth === 2) {
    g.fillStyle = '#5a1a2a'; g.beginPath(); g.moveTo(mx - mw * 1.1, my - 3); g.quadraticCurveTo(mx, my + 0.085 * S, mx + mw * 1.1, my - 3); g.closePath(); g.fill();
    g.save(); g.clip(); g.fillStyle = '#ff7a8a'; g.beginPath(); g.ellipse(mx, my + 0.045 * S, mw * 0.55, 0.018 * S, 0, 0, 7); g.fill(); g.fillStyle = '#fff'; g.fillRect(mx - mw * 1.1, my - 4, mw * 2.2, 7); g.restore();
  } else if (f.mouth === 3) { g.beginPath(); g.moveTo(mx - mw, my + 3); g.quadraticCurveTo(mx + mw * 0.2, my + 0.03 * S, mx + mw * 1.05, my - 0.022 * S); g.stroke(); }
  else { g.fillStyle = f.lipAmt > 0 ? f.lips : '#d0626f'; g.beginPath(); g.ellipse(mx, my + 3, mw * 0.4, 0.016 * S, 0, 0, 7); g.fill(); g.lineWidth = 3; g.stroke(); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export class Hero {
  readonly root = new THREE.Group();
  private J: THREE.Group[] = [];
  private T = new Float32Array(NJ * 3);       // final target pose
  private X = new Float32Array(NJ * 3);       // current joint angles
  private V = new Float32Array(NJ * 3);       // joint angular velocities (springs)
  private G = new Float32Array(NJ * 3); private F = new Float32Array(NJ * 3); private B = new Float32Array(NJ * 3); private L = new Float32Array(NJ * 3); private A = new Float32Array(NJ * 3); private R = new Float32Array(NJ * 3);
  private clock = 0; private phase = 0;
  private wRide = 0; private wFly = 0; private wBrace = 0; private wLand = 0; private wAir = 0; private wSpeed = 0; private wMove = 0; private wRun = 0;
  private hipY = HIP;
  private prevHs = 0; private acc = 0;
  private readonly rig = new THREE.Group();
  /** extra textures/geometries created for this hero, released by dispose() */
  private owned: { dispose(): void }[] = [];
  /** 0 none, 1 katana at the waist, 2 back sword, 3 twin back swords (changes how the character runs) */
  weapon = 0;

  constructor(assets: HeroAssets, spec: CharacterSpec = defaultSpec(), ink = true, detail = 1) {
    const prevDetail = setLoftDetail(detail);
    const lit = assets.rig, glow = assets.pillarGlow;
    const F_ = spec.face, O = spec.outfit, H_ = spec.hair, male = spec.gender === 'male';
    const m = male ? 1 : 0, bd = spec.build;
    // ---- colours from the spec ----
    const C = {
      jacket: hexNum(O.primary), jacketL: hexNum(O.secondary), jacketD: shadeHex(O.primary, 0.62), red: hexNum(O.accent), darkRed: shadeHex(O.accent, 0.62), gold: hexNum(O.trim), plate: shadeHex(O.primary, 1.35),
      white: 0xf7f8fd, whiteD: 0xc9cbe0, skin: hexNum(spec.skin), skinS: shadeHex(spec.skin, 0.9), hair: hexNum(H_.color), hairM: mixHex(H_.color, H_.tip, 0.5), hairL: hexNum(H_.sheen), hairTip: hexNum(H_.tip), pants: hexNum(O.pants),
      boot: hexNum(O.bootColor), bootL: mixHex(O.bootColor, '#ffffff', 0.18), sole: shadeHex(O.bootColor, 0.5), sock: shadeHex(O.pants, 0.7), cyan: hexNum(O.glow), scarf: hexNum(O.scarfColor), scarfD: shadeHex(O.scarfColor, 0.65), band: hexNum(O.headbandColor),
      glove: hexNum(O.gloveColor), gloveD: shadeHex(O.gloveColor, 0.82), hat: hexNum(O.hatColor), hatD: shadeHex(O.hatColor, 0.68),
    };
    const mesh = (geos: THREE.BufferGeometry[], mat: THREE.Material, parent: THREE.Object3D, inkOn = true) => {
      if (!geos.length) return null;
      const g = mergeGeometries(geos)!;
      for (const s of geos) s.dispose();
      const mm = new THREE.Mesh(g, mat); mm.castShadow = mat === lit; parent.add(mm); this.owned.push(g);
      if (mat === lit && ink && inkOn) { const hg = hullGeo(g); const o = new THREE.Mesh(hg, outlineMat(0.0055)); parent.add(o); this.owned.push(hg); } // thin ink outline
      return mm;
    };
    const pivot = (parent: THREE.Object3D, x: number, y: number, z: number, joint = -1): THREE.Group => {
      const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); if (joint >= 0) this.J[joint] = g; return g;
    };
    const E = (rx: number, ry: number, rz: number, x: number, y: number, z: number, c: number, seg = 14, rotX = 0, rotZ = 0): THREE.BufferGeometry => {
      const g = new THREE.SphereGeometry(1, seg, Math.max(8, seg - 4)); g.deleteAttribute('uv'); g.scale(rx, ry, rz); g.rotateX(rotX); g.rotateZ(rotZ); g.translate(x, y, z); return paint(g, c);
    };
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, c: number): THREE.BufferGeometry => { const g = new THREE.BoxGeometry(w, h, d); g.deleteAttribute('uv'); g.translate(x, y, z); return paint(g, c); };
    /** vertical loft: radii from height-keyed profiles */
    const lathe = (y0: number, y1: number, rx: (y: number) => number, rz: (y: number) => number, color: number | ColorFn,
      o: { seg?: number; steps?: number; shape?: LoftOpts['shape']; x?: number; z?: number; flip?: boolean; capStart?: boolean; capEnd?: boolean } = {}) =>
      loft({ path: [[o.x ?? 0, y0, o.z ?? 0], [o.x ?? 0, y1, o.z ?? 0]], steps: o.steps ?? 12, seg: o.seg ?? 18, r: (_t, p) => [rx(p.y), rz(p.y)], shape: o.shape, color, flip: o.flip, capStart: o.capStart, capEnd: o.capEnd });
    const vgrad = (a: number, b: number, y0: number, y1: number) => grad(a, b, (_t, _a, p) => (p.y - y0) / (y1 - y0));
    /** flared garment (skirt, peplum, dress, hakama): outer shell with folds + darker inner shell + hem trim */
    const skirt = (out: THREE.BufferGeometry[], inner: THREE.BufferGeometry[], yTop: number, yHem: number, top: [number, number], hem: [number, number], folds: number, amp: number, cTop: number, cHem: number, trim: number | null, sharp = false) => {
      const sOf = (y: number) => clamp((yTop - y) / (yTop - yHem), 0, 1), prof = (y: number) => 1 - Math.pow(1 - sOf(y), 1.7);
      const sh = (_t: number, a: number, p: THREE.Vector3) => { const w = Math.cos(a * folds); return 1 + amp * sOf(p.y) * (sharp ? Math.sign(w) * Math.pow(Math.abs(w), 0.35) : w); };
      const rx = (y: number) => top[0] + (hem[0] - top[0]) * prof(y), rz = (y: number) => top[1] + (hem[1] - top[1]) * prof(y);
      const seg = Math.max(28, folds * 4);
      out.push(lathe(yTop, yHem, rx, rz, vgrad(cTop, cHem, yTop, yHem), { seg, steps: 10, shape: sh }));
      inner.push(lathe(yTop, yHem, (y) => rx(y) * 0.975, (y) => rz(y) * 0.975, shadeHex('#' + cHem.toString(16).padStart(6, '0'), 0.55), { seg, steps: 10, shape: sh, flip: true }));
      if (trim !== null) out.push(lathe(yHem + 0.022, yHem - 0.002, (y) => rx(y) + 0.004, (y) => rz(y) + 0.004, trim, { seg, steps: 3, shape: sh }));
    };

    // ---- body proportions from gender + build ----
    const sw = (spec.shoulders ?? 0.5) - 0.5;
    const shoulder = 0.2 + 0.035 * m + 0.012 * bd + 0.035 * sw;
    const chestRx = 0.148 + 0.032 * m + 0.02 * bd + 0.025 * sw, chestRz = 0.102 + 0.016 * m + 0.012 * bd;
    const waistRx = 0.108 + 0.036 * m + 0.026 * bd, waistRz = 0.088 + 0.014 * m + 0.012 * bd;
    const hipsRx = 0.152 + 0.022 * (1 - m) + 0.02 * bd, hipsRz = 0.108 + 0.01 * bd;
    const limb = 0.94 + 0.12 * bd + 0.08 * m, bust = male ? 0 : 0.1 + 0.3 * (spec.bust ?? 0.5);
    const coat = O.top !== 1, gloves = O.gloves;
    const armor = O.top === 5, STEEL = 0xd6dae4, STEEL_D = 0x9aa0ae;
    const sleeve = O.top === 1 ? C.skin : armor ? C.pants : C.jacket, sleeveL = O.top === 1 ? C.skin : armor ? shadeHex(O.pants, 1.25) : C.jacketL;

    this.root.add(this.rig);
    this.rig.scale.setScalar(0.92 * spec.height);

    // =============================== pelvis + garments hanging from the waist ===============================
    const hip = pivot(this.rig, 0, HIP, 0, H);
    const pel: THREE.BufferGeometry[] = [], pelIn: THREE.BufferGeometry[] = [];
    {
      const rx = keys([[-0.15, 0.05], [-0.13, 0.11], [-0.07, hipsRx], [0.0, hipsRx * 0.97], [0.07, waistRx + 0.02], [0.13, waistRx + 0.012]]);
      const rz = keys([[-0.15, 0.04], [-0.13, 0.085], [-0.06, hipsRz], [0.04, hipsRz * 0.95], [0.13, waistRz + 0.01]]);
      const butt = (_t: number, a: number, p: THREE.Vector3) => 1 + (0.14 - 0.05 * m) * Math.pow(Math.max(0, -Math.sin(a)), 2) * Math.exp(-(((p.y + 0.05) / 0.06) ** 2));
      pel.push(lathe(-0.15, 0.13, rx, rz, C.pants, { seg: 20, steps: 10, shape: butt, capStart: true }));
    }
    if (O.top === 0) skirt(pel, pelIn, 0.12, -0.15, [waistRx + 0.022, waistRz + 0.02], [hipsRx + 0.05, hipsRz + 0.05], 6, 0.04, C.jacket, C.jacketL, C.gold);
    if (O.top === 2) {
      skirt(pel, pelIn, 0.12, -0.17, [waistRx + 0.022, waistRz + 0.02], [hipsRx + 0.05, hipsRz + 0.05], 6, 0.04, C.jacket, C.jacketL, C.gold);
      for (const sx of [-1, 1]) pel.push(loft({ path: [[sx * 0.07, -0.05, -0.15], [sx * 0.1, -0.3, -0.19], [sx * 0.12, -0.6, -0.2]], steps: 10, seg: 10, up: [0, 0, -1], r: (t) => [0.075 * (1 - 0.35 * t) * ends(t, 0, 0.12) + 0.004, 0.01], color: vgrad(C.jacket, C.jacketL, -0.05, -0.6) }));
    }
    if (O.top === 3) skirt(pel, pelIn, 0.13, -0.2, [waistRx + 0.016, waistRz + 0.016], [hipsRx + 0.11, hipsRz + 0.1], 7, 0.05, C.jacket, C.jacketL, C.red);
    if (armor) { // knight's tunic: a split, lightly pleated skirt under a leather belt with a pouch
      skirt(pel, pelIn, 0.12, -0.27, [waistRx + 0.02, waistRz + 0.02], [hipsRx + 0.055, hipsRz + 0.05], 4, 0.035, C.jacket, C.jacketL, C.gold);
      pel.push(lathe(0.08, 0.03, (y) => waistRx + 0.03 + (0.08 - y) * 0.3, (y) => waistRz + 0.03 + (0.08 - y) * 0.3, 0x5a3a22, { seg: 22, steps: 2 }));
      pel.push(box(0.05, 0.05, 0.015, 0.03, 0.055, waistRz + 0.05, C.gold), box(0.09, 0.09, 0.05, -0.13, -0.0, waistRz * 0.7 + 0.04, 0x6a4428));
    }
    if (O.top === 4) skirt(pel, pelIn, 0.13, -0.37, [waistRx + 0.014, waistRz + 0.014], [0.3, 0.27], 9, 0.06, C.jacket, C.jacketL, C.red);
    if (O.bottom === 0 && O.top !== 4) skirt(pel, pelIn, 0.1, -0.3, [waistRx + 0.03, waistRz + 0.03], [0.29, 0.26], 12, 0.05, C.jacketD, C.jacket, C.red, true);
    if (O.bottom === 3) skirt(pel, pelIn, 0.1, -0.52, [waistRx + 0.03, waistRz + 0.03], [0.33, 0.29], 6, 0.06, C.pants, shadeHex(O.pants, 0.8), C.gold, true);
    mesh(pel, lit, hip); mesh(pelIn, lit, hip, false);
    this.weapon = O.weapon ?? (O.katana ? 1 : 0);
    if (this.weapon === 1) {
      const KX = -0.34, tilt = -0.62;
      const kg = (len: number, w: number, y: number, z: number, c: number, h = w) => { const g = new THREE.CylinderGeometry(w / 2, w / 2, len, 10); g.deleteAttribute('uv'); g.rotateX(PI / 2 + tilt); g.scale(1, h / w, 1); g.translate(KX, y, z); return paint(g, c); };
      mesh([kg(0.95, 0.05, -0.1, -0.2, 0x14121c), kg(0.03, 0.1, 0.19, 0.215, C.gold), kg(0.26, 0.042, 0.3, 0.37, 0x1d2142), kg(0.05, 0.058, -0.385, -0.585, C.red), kg(0.18, 0.062, -0.03, -0.12, C.red)], lit, hip);
      mesh([kg(0.7, 0.012, -0.08, -0.2, C.cyan)], glow, hip);
    }
    // swords worn on the back are built on the spine below (they follow the torso)

    // =============================== torso ===============================
    const spine = pivot(hip, 0, 0.09, 0, SP);
    const tRx = keys([[-0.04, waistRx + 0.012], [0.07, waistRx], [0.17, waistRx + 0.008], [0.27, chestRx * 0.95], [0.36, chestRx], [0.45, shoulder * 0.86], [0.51, shoulder * 0.8], [0.56, 0.115], [0.6, 0.066]]);
    const tRz = keys([[-0.04, waistRz + 0.01], [0.08, waistRz], [0.2, chestRz * 0.95], [0.33, chestRz], [0.45, chestRz * 0.94], [0.53, 0.085], [0.6, 0.056]]);
    const tShape = (y: number, a: number) => {
      if (bust > 0) {
        const gy = Math.exp(-(((y - 0.33) / 0.065) ** 2)), l = Math.exp(-((a - PI / 2 - 0.45) ** 2) / 0.12) + Math.exp(-((a - PI / 2 + 0.45) ** 2) / 0.12);
        return 1 + bust * gy * l;
      }
      return 1 + 0.06 * Math.exp(-(((y - 0.38) / 0.07) ** 2)) * Math.max(0, Math.sin(a)) + 0.05 * Math.exp(-(((y - 0.42) / 0.08) ** 2)) * Math.max(0, -Math.sin(a));
    };
    const tsurf = (y: number, a: number, off: number): V3 => { const k = tShape(y, a); return [Math.cos(a) * (tRx(y) * k + off), y, Math.sin(a) * (tRz(y) * k + off)]; };
    const torso: THREE.BufferGeometry[] = [];
    torso.push(lathe(-0.04, 0.6, tRx, tRz, grad(C.jacket, C.jacketL, (_t, _a, p) => (p.y - 0.2) / 0.5), { seg: 26, steps: 22, shape: (_t, a, p) => tShape(p.y, a) }));
    // belt / sash
    torso.push(lathe(0.095, 0.15, (y) => tRx(y) + 0.008, (y) => tRz(y) + 0.008, O.top === 3 ? C.red : O.top === 4 ? C.red : C.red, { seg: 26, steps: 2, shape: (_t, a, p) => tShape(p.y, a) }));
    torso.push(box(0.045, 0.045, 0.012, 0, 0.122, tRz(0.122) + 0.012, C.gold));
    // collar: white band + two folded points
    if (!armor) torso.push(lathe(0.52, 0.625, keys([[0.52, 0.105], [0.625, 0.072]]), keys([[0.52, 0.088], [0.625, 0.064]]), C.white, { seg: 22, steps: 3 }));
    if (!armor) for (const sx of [-1, 1]) {
      const a0 = PI / 2 - sx * 0.62, a1 = PI / 2 - sx * 0.1;
      torso.push(loft({ path: [tsurf(0.58, a0, 0.016), tsurf(0.54, (a0 + a1) / 2, 0.014), tsurf(0.49, a1, 0.012)], steps: 6, seg: 8, up: [Math.cos(a0), 0.4, Math.sin(a0)], r: (t) => [0.042 * (1 - 0.85 * t) + 0.003, 0.006], color: C.white }));
    }
    if (O.top === 0 || O.top === 2) {
      // lapels + zip line + glowing chest emblem
      for (const sx of [-1, 1]) torso.push(loft({ path: [tsurf(0.53, PI / 2 - sx * 0.34, 0.006), tsurf(0.4, PI / 2 - sx * 0.24, 0.007), tsurf(0.2, PI / 2 - sx * 0.07, 0.006)], steps: 10, seg: 8, up: [0, 0, 1], r: (t) => [0.032 * (1 - 0.6 * t) + 0.006, 0.006], color: C.jacketL }));
      torso.push(loft({ path: [tsurf(0.16, PI / 2, 0.004), tsurf(0.33, PI / 2, 0.006), tsurf(0.5, PI / 2, 0.005)], steps: 10, seg: 6, up: [0, 0, 1], r: () => [0.008, 0.004], color: C.gold }));
    } else if (O.top === 3) {
      // double-breasted military coat: placket + two columns of gold buttons + shoulder boards
      torso.push(loft({ path: [tsurf(0.15, PI / 2 + 0.05, 0.004), tsurf(0.33, PI / 2 + 0.05, 0.006), tsurf(0.5, PI / 2 + 0.05, 0.005)], steps: 12, seg: 6, up: [0, 0, 1], r: () => [0.02, 0.005], color: C.jacketL }));
      for (const y of [0.22, 0.31, 0.4]) for (const sx of [-1, 1]) { const p = tsurf(y, PI / 2 - sx * 0.3, 0.008); torso.push(E(0.012, 0.012, 0.008, p[0], p[1], p[2], C.gold, 10)); }
      for (const sx of [-1, 1]) torso.push(E(0.07, 0.016, 0.06, sx * (shoulder - 0.02), 0.535, 0, C.jacketL, 14, 0, sx * -0.25), E(0.06, 0.006, 0.052, sx * (shoulder - 0.02), 0.548, 0, C.gold, 12, 0, sx * -0.25));
    } else if (armor) {
      // breastplate: a polished shell over the chest with a centre ridge, gorget at the neck, gold trim at the lower edge
      const bp = (y: number) => y;
      torso.push(lathe(0.2, 0.56, (y) => tRx(bp(y)) + 0.016, (y) => tRz(bp(y)) + 0.016, grad(STEEL_D, STEEL, (_t, a2, q) => 0.35 + 0.65 * Math.max(0, Math.sin(a2)) * (q.y > 0.3 ? 1 : 0.7)), { seg: 26, steps: 14, shape: (_t, a2, q) => tShape(q.y, a2) * (1 + 0.025 * Math.exp(-((a2 - PI / 2) ** 2) / 0.02)) }));
      torso.push(lathe(0.215, 0.195, (y) => tRx(y) + 0.02, (y) => tRz(y) + 0.02, C.gold, { seg: 26, steps: 1, shape: (_t, a2, q) => tShape(q.y, a2) }));
      torso.push(lathe(0.545, 0.64, keys([[0.545, 0.115], [0.64, 0.078]]), keys([[0.545, 0.095], [0.64, 0.07]]), grad(STEEL_D, STEEL, (t) => t), { seg: 22, steps: 3 }));
      torso.push(lathe(0.6, 0.615, () => 0.08, () => 0.072, C.gold, { seg: 22, steps: 1 }));
    } else if (O.top === 4) {
      for (const y of [0.25, 0.35, 0.45]) { const p = tsurf(y, PI / 2, 0.006); torso.push(E(0.011, 0.011, 0.007, p[0], p[1], p[2], C.red, 10)); }
    } else {
      torso.push(loft({ path: [tsurf(0.15, PI / 2, 0.004), tsurf(0.33, PI / 2, 0.006), tsurf(0.5, PI / 2, 0.005)], steps: 10, seg: 6, up: [0, 0, 1], r: () => [0.008, 0.004], color: C.gold }));
    }
    mesh(torso, lit, spine);
    if (this.weapon >= 2) {
      // diagonal back scabbard(s): hilt over the right shoulder (twin: crossed, second hilt over the left)
      const blade = (sx: number) => {
        const ang = sx * 0.62, ax = Math.sin(-ang), ay = Math.cos(ang); // axis pointing to the hilt (sx = 1: over the right shoulder, -x)
        const seg = (len: number, w: number, at: number, c: number, sq = 1) => { const g = new THREE.CylinderGeometry(w / 2, w / 2, len, 10); g.deleteAttribute('uv'); g.scale(1, 1, sq); g.rotateZ(ang); g.translate(ax * at, 0.3 + ay * at, -tRz(0.3) - 0.06); return paint(g, c); };
        return [seg(0.95, 0.055, 0, 0x14121c, 0.7), seg(0.035, 0.11, 0.49, C.gold), seg(0.27, 0.045, 0.64, 0x1d2142), seg(0.04, 0.06, 0.79, C.gold), seg(0.06, 0.06, -0.49, C.red, 0.7), seg(0.16, 0.062, 0.2, C.red, 0.75)];
      };
      const geos = blade(1); if (this.weapon === 3) geos.push(...blade(-1));
      geos.push(loft({ path: [tsurf(0.52, PI / 2 + 0.9, 0.012), tsurf(0.3, PI / 2, 0.02), tsurf(0.12, PI / 2 - 0.9, 0.012)], steps: 10, seg: 6, r: () => [0.022, 0.006], color: 0x3a2418 })); // strap across the chest
      mesh(geos, lit, spine);
    }
    if (O.top === 0 || O.top === 2) { const p = tsurf(0.36, PI / 2, 0.012); mesh([E(0.026, 0.026, 0.008, p[0], p[1], p[2], C.cyan, 10)], glow, spine); }

    // =============================== head ===============================
    const head = pivot(spine, 0, 0.575, 0, HD);
    head.scale.setScalar(1.42 * spec.head);
    const wS = 1 + 0.1 * F_.width, jw = 1 + 0.16 * F_.jaw;
    const crownC = 0.228, crownR = 0.152;
    // anime lower face: narrow, tapering to a small rounded chin point; the Jaw slider moves the jaw angle, not the chin tip
    // soft, round anime face: full cheeks down to a wide, rounded chin (the Jaw slider moves the jaw angle)
    const cw = 1 + 0.5 * (F_.chinWidth ?? 0); // chin width slider (affects the lower face only)
    const ck = 1 + 0.16 * (F_.cheekWidth ?? 0); // cheek width slider (mid face)
    const faceX = keys([[0.04, 0], [0.043, 0.022 * cw], [0.052, 0.038 * cw], [0.07, 0.062 * jw * (1 + 0.6 * (cw - 1))], [0.095, 0.092 * jw * (1 + 0.6 * (ck - 1))], [0.125, 0.114 * wS * Math.sqrt(jw) * ck], [0.155, 0.126 * wS * (1 + 0.5 * (ck - 1))], [0.2, 0.134 * wS], [crownC, 0.135 * wS]]);
    const faceZ = keys([[0.04, 0], [0.043, 0.02], [0.052, 0.036], [0.07, 0.06], [0.095, 0.088], [0.125, 0.113], [0.155, 0.128], [0.2, 0.136], [crownC, 0.14]]);
    const dome = (y: number) => Math.sqrt(Math.max(0, 1 - ((y - crownC) / crownR) ** 2));
    const hx = (y: number) => (y > crownC ? 0.135 * wS * dome(y) : faceX(y)), hz = (y: number) => (y > crownC ? 0.14 * dome(y) : faceZ(y));
    const LOWER = keys([[0.04, 0.03], [0.055, 0.036], [0.075, 0.03], [0.095, 0.026], [0.115, 0.02], [0.14, 0.01], [0.16, 0.003], [0.18, 0]]);
    const headShape = (_t: number, a: number, p: THREE.Vector3) => {
      const s = Math.sin(a), c = Math.cos(a), y = p.y;
      const jawK = 0.08 * (1 - smooth(0.06, 0.13, y));                                     // V-shaped chin seen from above
      const back = 0.07 * Math.max(0, -s) * smooth(0.12, 0.24, y);                        // fuller back of the skull
      const cheek = 0.035 * c * c * Math.exp(-(((y - 0.12) / 0.04) ** 2));                // soft cheeks
      // jaw: the back half of the lower rings reaches toward the neck/ear, giving a real jawline and jaw angle in profile
      const jawZone = smooth(0.06, 0.1, y) * (1 - smooth(0.13, 0.17, y)), bs = Math.max(0, -s);
      const jawBack = (0.16 + 0.1 * F_.jaw) * c * c * (1 - smooth(-0.25, 0.45, s)) * jawZone + 0.06 * bs * jawZone; void bs;
      const chin = 0.12 * Math.pow(Math.max(0, s), 1.5) * Math.exp(-(((y - 0.058) / 0.02) ** 2)); // broad, rounded chin
      // anime side view (absolute offsets on the front of the face): the lower face comes forward, the nose bridge slopes out
      // from between the eyes to a pointed tip that clears the eye line, the mouth sits back under it, then the chin
      const ny = 0.117 + 0.007 * F_.noseHeight, frontN = Math.exp(-((c / 0.16) ** 2)) * Math.max(0, s), frontW = Math.pow(Math.max(0, s), 0.8);
      const bridge = y >= ny ? Math.max(0, 1 - (y - ny) / 0.045) ** 1.5 : Math.exp(-(((y - ny) / 0.0075) ** 2));
      const add = LOWER(y) * frontW + 0.03 * F_.noseSize * bridge * frontN + 0.004 * frontN * Math.exp(-(((y - (0.093 + 0.007 * F_.mouthHeight)) / 0.007) ** 2));
      const chinF = (F_.chin ?? 0) * 0.022 * frontW * Math.exp(-(((y - 0.058) / 0.026) ** 2)); // chin slider: how far the chin comes forward
      const nose = (add + chinF) / Math.max(0.02, hz(y)), lips = 0;
      return 1 - jawK * c * c * Math.max(0, s) + back + cheek + jawBack + chin + nose + lips;
    };
    const headG = loft({ path: [[0, 0.04, 0], [0, crownC, 0], [0, crownC + crownR, 0]], steps: 52, seg: 32, r: (_t, p) => [hx(p.y), hz(p.y)], shape: headShape, color: C.skin });
    // front of the face at a given height (for placing the nose)
    // anime faces read flat: bend the normals on the front of the face toward the viewer so the toon ramp doesn't shade the
    // nose / mouth / chin area into a grey muzzle (the silhouette and outline keep the sculpted profile)
    {
      const P = headG.attributes.position, Nn = headG.attributes.normal, v = new THREE.Vector3();
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        if (z <= 0 || y > 0.24) continue;
        const w = Math.max(0, 1 - Math.abs(x) / 0.11) * Math.min(1, z / 0.05) * 0.75;
        if (w <= 0) continue;
        v.set(Nn.getX(i), Nn.getY(i), Nn.getZ(i)).lerp(new THREE.Vector3(x * 2.5, 0.15, 1).normalize(), w).normalize();
        Nn.setXYZ(i, v.x, v.y, v.z);
      }
      Nn.needsUpdate = true;
    }
    // painted face decal: the head's own front faces, lifted a hair along their normals, with planar UVs
    {
      const P = headG.attributes.position, Nn = headG.attributes.normal, I = headG.index!;
      const inside = (i: number) => Math.abs(P.getX(i)) < FW * 0.5 && P.getY(i) > FY0 && P.getY(i) < FY0 + FH;
      const ok = (i: number) => P.getZ(i) > 0 && Nn.getZ(i) > 0.1;
      const map = new Map<number, number>(), pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
      const vid = (i: number) => {
        let k = map.get(i);
        if (k === undefined) {
          k = pos.length / 3; map.set(i, k);
          pos.push(P.getX(i) + Nn.getX(i) * 0.0012, P.getY(i) + Nn.getY(i) * 0.0012, P.getZ(i) + Nn.getZ(i) * 0.0012); nor.push(Nn.getX(i), Nn.getY(i), Nn.getZ(i));
          uv.push(P.getX(i) / FW + 0.5, (P.getY(i) - FY0) / FH);
        }
        return k;
      };
      for (let f = 0; f < I.count; f += 3) {
        const a = I.getX(f), b = I.getX(f + 1), c = I.getX(f + 2);
        if ((inside(a) || inside(b) || inside(c)) && ok(a) && ok(b) && ok(c)) idx.push(vid(a), vid(b), vid(c));
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
      const tex = faceTexture(spec); tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      const fm = new THREE.MeshToonMaterial({ map: tex, transparent: true, gradientMap: assets.ramp, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, depthWrite: false });
      const fmesh = new THREE.Mesh(g, fm); fmesh.renderOrder = 1; head.add(fmesh); this.owned.push(g, tex, fm);
    }
    const headGeos: THREE.BufferGeometry[] = [headG];
    // neck
    headGeos.push(loft({ path: [[0, -0.06, -0.008], [0, 0.1, 0.0]], steps: 4, seg: 14, r: () => 0.047 + 0.008 * m, color: vgrad(C.skinS, C.skin, -0.06, 0.1) }));
    // ears
    const ens = F_.earSize, earX = 0.133 * wS - 0.006;
    if (F_.ears === 0) for (const sx of [-1, 1]) headGeos.push(loft({ path: [[sx * earX, 0.15, -0.01], [sx * (earX + 0.012), 0.205, -0.02]], steps: 8, seg: 10, r: (t) => { const k = ends(t, 0.4, 0.4); return [0.011 * ens * k, 0.024 * ens * k]; }, color: C.skin }));
    if (F_.ears === 1) for (const sx of [-1, 1]) headGeos.push(loft({ path: [[sx * earX, 0.15, -0.01], [sx * (earX + 0.045), 0.195, -0.03], [sx * (earX + 0.11), 0.245, -0.055]], steps: 10, seg: 10, r: (t) => [0.011 * ens * (1 - t) + 0.001, 0.03 * ens * Math.pow(1 - t, 0.8) * ends(t, 0.25, 0) + 0.001], color: C.skin }));
    if (F_.ears === 2) for (const sx of [-1, 1]) {
      headGeos.push(loft({ path: [[sx * 0.08, 0.33, -0.02], [sx * 0.105, 0.41, -0.03], [sx * 0.125, 0.47, -0.035]], steps: 8, seg: 10, r: (t) => [0.055 * ens * (1 - t) + 0.002, 0.02 * (1 - t) + 0.002], color: vgrad(C.hair, C.hairTip, 0.33, 0.47) }));
      headGeos.push(loft({ path: [[sx * 0.082, 0.34, -0.005], [sx * 0.104, 0.405, -0.012], [sx * 0.118, 0.445, -0.015]], steps: 6, seg: 8, r: (t) => [0.034 * ens * (1 - t) + 0.001, 0.01 * (1 - t) + 0.001], color: 0xff9ab0 }));
    }
    if (O.earrings) for (const sx of [-1, 1]) { const g = new THREE.TorusGeometry(0.017, 0.0035, 6, 16); g.deleteAttribute('uv'); g.rotateY(PI / 2); g.translate(sx * (earX + 0.008), 0.128, -0.012); headGeos.push(paint(g, C.gold)); }

    if (F_.glasses) {
      const gz = 0.148, gy = FY0 + FH * (0.5 - 0.04 * F_.eyeHeight), gx = FW * (0.2 + 0.05 * F_.eyeSpacing), R = 0.027 * F_.eyeSize, frame = F_.glasses === 3 ? 0x101014 : 0x2a2a34;
      for (const sx of [-1, 1]) {
        if (F_.glasses === 2) { for (const [w, h, dx, dy] of [[R * 2.2, 0.004, 0, R * 0.85], [R * 2.2, 0.004, 0, -R * 0.85], [0.004, R * 1.7, R * 1.1, 0], [0.004, R * 1.7, -R * 1.1, 0]]) headGeos.push(box(w, h, 0.004, sx * gx + dx, gy + dy, gz, frame)); }
        else { const t = new THREE.TorusGeometry(R, F_.glasses === 3 ? 0.004 : 0.0026, 6, 24); t.deleteAttribute('uv'); t.translate(sx * gx, gy, gz); headGeos.push(paint(t, frame)); }
        if (F_.glasses === 3) { const l = new THREE.CircleGeometry(R * 1.02, 20); l.deleteAttribute('uv'); l.translate(sx * gx, gy, gz + 0.001); headGeos.push(paint(l, 0x1a1c2c)); }
        headGeos.push(box(0.006, 0.006, 0.15, sx * (gx + R * 1.08), gy + 0.004, gz - 0.075, frame));         // temple arm back to the ear
      }
      headGeos.push(box(gx * 2 - R * 2.1, 0.006, 0.006, 0, gy + R * 0.3, gz + 0.004, frame));              // bridge
    }
    // ---- hair: a cap shell plus sculpted locks (flattened, tapered sweeps lying on the scalp) ----
    const HC = new THREE.Vector3(0, 0.245, -0.018), HR = 0.163, _o = new THREE.Vector3();
    const cHair = new THREE.Color(C.hair), cMid = new THREE.Color(C.hairM), cTip = new THREE.Color(C.hairTip), cSheen = new THREE.Color(C.hairL);
    const hc = (s: number, p: THREE.Vector3, out: THREE.Color) => {
      out.copy(cHair).lerp(cMid, smooth(0.15, 0.7, s)).lerp(cTip, smooth(0.6, 1, s));
      const ang = Math.atan2(p.x - HC.x, p.z - HC.z), band = Math.abs(p.y - (0.335 + 0.008 * Math.sin(ang * 9)));
      if (band < 0.013 && Math.cos(ang) > -0.5) out.lerp(cSheen, 0.7 * (1 - band / 0.013));
    };
    const sph = (th: number, ph: number, r: number): V3 => [HC.x + r * Math.sin(th) * Math.sin(ph), HC.y + r * Math.cos(th), HC.z + r * Math.sin(th) * Math.cos(ph)];
    const outward = (p: THREE.Vector3) => { _o.set(p.x - HC.x, p.y > HC.y ? p.y - HC.y : 0, p.z - HC.z); if (_o.lengthSq() < 1e-8) _o.set(0, 0, -1); return _o.normalize(); };
    const hairGeo: THREE.BufferGeometry[] = [], tail1: THREE.BufferGeometry[] = [], tail2: THREE.BufferGeometry[] = [];
    const cap = (sx = 1, sy = 1, sz = 1, cy = 0.262, cz = -0.03) => hairGeo.push(loft({
      path: [[0, cy - 0.165 * sy, cz], [0, cy + 0.165 * sy, cz]], steps: 18, seg: 28,
      r: (t) => { const e = Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)); return [0.152 * sx * e, 0.16 * sz * e]; },
      color: (t, _a, p, out) => hc(0.15 + 0.35 * (1 - t), p, out),
    }));
    interface Lock { ph: number; th1: number; th0?: number; r1?: number; drop?: number; out?: number; curl?: number; w?: number; th?: number; sweep?: number; blunt?: boolean; wave?: number }
    const lock = (L: Lock) => {
      const th0 = L.th0 ?? 0.35, r0 = 0.9, r1 = L.r1 ?? 1.06, sw = L.sweep ?? 0, ph1 = L.ph + sw, w = L.w ?? 0.05, thk = L.th ?? 0.02;
      const pts: V3[] = [sph(th0, L.ph, HR * r0), sph((th0 + L.th1) / 2, L.ph + sw * 0.5, HR * (r0 + r1) * 0.5 * 1.04), sph(L.th1, ph1, HR * r1)];
      const drop = L.drop ?? 0, out = L.out ?? 0.02, curl = L.curl ?? 0, hX = Math.sin(ph1), hZ = Math.cos(ph1), e = pts[2];
      if (drop > 0) {
        const n = Math.max(2, Math.round(drop / 0.07));
        for (let k = 1; k <= n; k++) { const u = k / n, wv = (L.wave ?? 0) * Math.sin(u * PI * 2.5), c = k === n ? curl : 0; pts.push([e[0] + hX * (out * u + wv + c), e[1] - drop * u + (k === n ? Math.abs(curl) * 0.4 : 0), e[2] + hZ * (out * u + wv + c)]); }
      } else if (curl) pts.push([e[0] + hX * curl, e[1] - 0.015, e[2] + hZ * curl]);
      hairGeo.push(loft({
        path: pts, steps: 4 + Math.round(pts.length * 1.5), seg: 7, up: outward,
        r: (t) => { const k = L.blunt ? ends(t, 0, 0.08) : 1 - Math.pow(t, 1.6), b = 0.78 + 0.45 * Math.sin(PI * Math.min(t, 0.5)); return [w * k * b + 0.0015, thk * k * b + 0.0015]; },
        color: (t, _a, p, o) => hc(t, p, o),
      }));
    };
    const spike = (th: number, ph: number, len: number, w: number, lift = 0, bend = 0) => {
      const o = new THREE.Vector3(Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph)), d = o.clone().add(new THREE.Vector3(0, lift, 0)).normalize();
      const p0 = sph(th, ph, HR * 0.85), P = (s: number): V3 => [p0[0] + d.x * len * s, p0[1] + d.y * len * s + bend * s * s, p0[2] + d.z * len * s];
      const mer = new THREE.Vector3(Math.cos(th) * Math.sin(ph), -Math.sin(th), Math.cos(th) * Math.cos(ph));
      hairGeo.push(loft({ path: [P(0), P(0.5), P(1)], steps: 8, seg: 7, up: [mer.x, mer.y, mer.z], r: (t) => { const k = 1 - Math.pow(t, 1.3); return [w * k + 0.001, w * 0.5 * k + 0.001]; }, color: (t, _a, p, out) => hc(0.2 + 0.8 * t, p, out) }));
    };
    const bangs = H_.bangs;
    const fringe = (n: number, spread: number, len = 1, o: Partial<Lock> = {}) => {
      for (let i = 0; i < n; i++) { const u = n === 1 ? 0 : i / (n - 1) - 0.5; lock({ ph: u * 2 * spread, th0: 0.25, th1: (1.25 + 0.3 * bangs) * len + (o.blunt ? 0 : 0.12 * Math.abs(u) * 2), w: 0.044, th: 0.016, r1: 1.07, sweep: u * 0.22, ...o }); }
    };
    const sides = (th1: number, drop: number, o: Partial<Lock> = {}) => { for (const sx of [-1, 1]) lock({ ph: sx * 1.25, th0: 0.7, th1, drop, w: 0.05, th: 0.02, r1: 1.05, out: 0.004, curl: -0.012, ...o }); };
    const back = (n: number, ph0: number, ph1: number, th1: number, drop: number, o: Partial<Lock> = {}) => {
      for (let i = 0; i < n; i++) { const ph = ph0 + (ph1 - ph0) * (n === 1 ? 0.5 : i / (n - 1)); lock({ ph, th0: 0.4, th1, drop: drop * (1 + 0.12 * (((i * 7) % 3) - 1)), w: 0.07, th: 0.03, r1: 1.08, out: 0.03, ...o }); }
    };
    let hv = 1; // hair volume (hats scale with it)
    let tailL1 = 0.33; // length of the first tail segment (T1 -> T2 pivot)
    switch (H_.style) {
      case 0: // Spiky
        cap(); fringe(5, 0.5, 0.92, { w: 0.045 }); sides(1.75, 0.02); back(8, 1.7, 2 * PI - 1.7, 2.05, 0.03, { r1: 1.02, w: 0.06 });
        for (let i = 0; i < 9; i++) spike(0.9 + (i % 2) * 0.3, PI + (i - 4) * 0.42, 0.22 + (i % 3) * 0.03, 0.065, 0.35, -0.02);
        spike(0.35, 0.6, 0.17, 0.05, 0.4); spike(0.35, -0.6, 0.17, 0.05, 0.4); spike(1.4, 1.9, 0.2, 0.055, 0.1); spike(1.4, -1.9, 0.2, 0.055, 0.1);
        break;
      case 1: // Ponytail
        cap(); fringe(5, 0.5); sides(1.8, 0.14); back(7, 1.9, 4.38, 2.0, 0, { r1: 1.0, w: 0.06 });
        tail1.push(loft({ path: [[0, 0.0, 0.02], [0, -0.06, -0.04], [0, -0.18, -0.06], [0, -0.33, -0.03]], steps: 12, seg: 12, r: (t) => [0.058 * (1 - 0.25 * t) * ends(t, 0.12, 0) + 0.004, 0.048 * (1 - 0.2 * t) * ends(t, 0.12, 0) + 0.004], color: (t, _a, p, o) => hc(0.2 + 0.4 * t, p, o) }));
        tail1.push(lathe(0.015, -0.015, () => 0.04, () => 0.04, C.band, { seg: 12, steps: 2, z: 0.0 }));
        tail2.push(loft({ path: [[0, 0.02, -0.03], [0, -0.15, -0.01], [0, -0.3, 0.03], [0, -0.42, 0.07]], steps: 12, seg: 12, r: (t) => { const k = 1 - Math.pow(t, 1.4); return [0.044 * k + 0.001, 0.038 * k + 0.001]; }, color: (t, _a, p, o) => hc(0.6 + 0.4 * t, p, o) }));
        break;
      case 2: // Bob
        cap(1.06, 1.0, 1.06); fringe(6, 0.55, 1.02); back(11, 1.0, 2 * PI - 1.0, 2.25, 0.04, { r1: 1.12, out: 0.01, curl: -0.025, w: 0.06 });
        break;
      case 3: // Long straight
        cap(); fringe(5, 0.5); sides(1.85, 0.42, { w: 0.055 }); back(9, 1.6, 2 * PI - 1.6, 2.1, 0.55, { w: 0.075, r1: 1.08 });
        break;
      case 4: // Twin tails
        cap(); fringe(5, 0.5); sides(1.8, 0.1); back(7, 1.9, 4.38, 2.0, 0, { r1: 1.0, w: 0.06 });
        for (const sx of [-1, 1]) {
          tail1.push(E(0.035, 0.035, 0.035, sx * 0.15, -0.01, 0.09, C.band, 12));
          tail1.push(loft({ path: [[sx * 0.15, -0.01, 0.09], [sx * 0.21, -0.08, 0.06], [sx * 0.24, -0.2, 0.04], [sx * 0.24, -0.33, 0.03]], steps: 12, seg: 12, r: (t) => [0.052 * (1 - 0.2 * t) * ends(t, 0.15, 0) + 0.004, 0.044 * ends(t, 0.15, 0) + 0.004], color: (t, _a, p, o) => hc(0.2 + 0.4 * t, p, o) }));
          tail2.push(loft({ path: [[sx * 0.24, 0.02, 0.03], [sx * 0.25, -0.15, 0.04], [sx * 0.24, -0.32, 0.07], [sx * 0.22, -0.42, 0.1]], steps: 12, seg: 12, r: (t) => { const k = 1 - Math.pow(t, 1.4); return [0.042 * k + 0.001, 0.036 * k + 0.001]; }, color: (t, _a, p, o) => hc(0.6 + 0.4 * t, p, o) }));
        }
        break;
      case 5: // Braid
        cap(); fringe(5, 0.5); sides(1.8, 0.08); back(7, 1.9, 4.38, 2.0, 0, { r1: 1.0, w: 0.06 });
        for (let i = 0; i < 6; i++) tail1.push(E(0.046 - i * 0.002, 0.04, 0.042, (i & 1 ? 0.014 : -0.014), -0.03 - i * 0.058, 0, i & 1 ? C.hairM : C.hair, 12, 0, i & 1 ? 0.5 : -0.5));
        for (let i = 0; i < 6; i++) tail2.push(E(0.04 - i * 0.004, 0.036, 0.038, (i & 1 ? 0.012 : -0.012), -0.03 - i * 0.055, 0, i & 1 ? C.hairTip : C.hairM, 12, 0, i & 1 ? 0.5 : -0.5));
        tail2.push(E(0.026, 0.02, 0.026, 0, -0.36, 0, C.band, 10));
        break;
      case 6: // Odango buns
        cap(); fringe(5, 0.5); sides(1.8, 0.18); back(7, 1.9, 4.38, 2.0, 0, { r1: 1.0, w: 0.06 });
        for (const sx of [-1, 1]) {
          hairGeo.push(loft({ path: [[sx * 0.12, 0.37, -0.03], [sx * 0.125, 0.5, -0.03]], steps: 12, seg: 16, r: (t) => 0.072 * Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)) + 0.001, shape: (t, a) => 1 + 0.06 * Math.sin(a * 3 + t * 9), color: (t, _a, p, o) => hc(0.2 + 0.3 * t, p, o) }));
          hairGeo.push(lathe(0.385, 0.37, () => 0.045, () => 0.045, C.band, { x: sx * 0.12, z: -0.03, seg: 12, steps: 2 }));
        }
        break;
      case 7: // Short messy
        cap(1.02); fringe(7, 0.6, 0.85, { w: 0.04, curl: 0.012 });
        for (let i = 0; i < 10; i++) lock({ ph: 0.9 + (2 * PI - 1.8) * (i / 9), th0: 0.4, th1: 1.9 + 0.08 * (i % 3), r1: 1.1, w: 0.055, th: 0.022, curl: 0.022 });
        spike(0.3, 0.4, 0.12, 0.045, 0.3); spike(0.3, -0.7, 0.11, 0.045, 0.3); spike(0.5, PI, 0.12, 0.05, 0.2);
        break;
      case 8: // Side swept
        cap(); for (let i = 0; i < 5; i++) lock({ ph: -0.7 + i * 0.25, th0: 0.25, th1: 1.62 + 0.05 * i * bangs, sweep: 0.6, w: 0.05, th: 0.016, r1: 1.08 });
        lock({ ph: 0.25, th0: 0.3, th1: 1.85, sweep: 0.45, w: 0.06, th: 0.018, r1: 1.1, curl: -0.01 });
        sides(1.8, 0.06); back(7, 1.9, 4.38, 2.0, 0.02, { r1: 1.02, w: 0.06 });
        break;
      case 9: // Topknot
        cap(0.98, 0.98, 0.98); fringe(3, 0.3, 0.75, { w: 0.04 });
        for (let i = 0; i < 12; i++) lock({ ph: (i / 12) * 2 * PI + 0.26, th0: 2.0, th1: 0.15, r1: 0.98, w: 0.05, th: 0.014 });
        hairGeo.push(loft({ path: [[0, 0.4, -0.04], [0, 0.52, -0.05]], steps: 10, seg: 14, r: (t) => 0.062 * Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)) + 0.001, color: (t, _a, p, o) => hc(0.2 + 0.3 * t, p, o) }));
        hairGeo.push(lathe(0.42, 0.4, () => 0.05, () => 0.05, C.band, { z: -0.04, seg: 12, steps: 2 }));
        break;
      case 10: // Wavy long
        cap(); fringe(5, 0.5); sides(1.85, 0.4, { wave: 0.02, w: 0.055 }); back(9, 1.6, 2 * PI - 1.6, 2.1, 0.55, { w: 0.075, wave: 0.025, r1: 1.1 });
        break;
      case 11: // Slick short
        cap(); for (let i = 0; i < 5; i++) lock({ ph: -0.6 + i * 0.3, th0: 1.25, th1: -0.9, r1: 1.04, w: 0.05, th: 0.02 });
        back(8, 1.3, 2 * PI - 1.3, 1.95, 0, { r1: 1.02, w: 0.06 });
        break;
      case 12: // Big volume
        hv = 1.14; cap(1.12, 1.08, 1.12, 0.268, -0.04);
        { // the big rounded mass behind the head, scalloped, pulled in at the front so the face stays open
          const rx = keys([[0.43, 0.0], [0.4, 0.12], [0.3, 0.21], [0.14, 0.27], [0.02, 0.24], [-0.05, 0.16], [-0.08, 0.0]]);
          const rz = keys([[0.43, 0.0], [0.4, 0.1], [0.3, 0.17], [0.14, 0.19], [0.02, 0.16], [-0.05, 0.1], [-0.08, 0.0]]);
          hairGeo.push(loft({ path: [[0, 0.43, -0.05], [0, 0.2, -0.085], [0, -0.08, -0.08]], steps: 22, seg: 30, r: (_t, p) => [rx(p.y), rz(p.y)],
            shape: (_t, a, p) => (1 - 0.6 * Math.pow(Math.max(0, Math.sin(a)), 2) * smooth(0.36, 0.26, p.y)) * (1 + 0.05 * Math.cos(a * 7) * smooth(0.25, 0.0, p.y)),
            color: (_t, _a, p, o) => hc(clamp((0.38 - p.y) / 0.42, 0, 1), p, o) }));
        }
        for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) lock({ ph: sx * (0.12 + i * 0.25), th0: 0.25, th1: 1.45 + 0.12 * i + 0.15 * (bangs - 1), sweep: sx * 0.35, w: 0.052, th: 0.018, r1: 1.1, curl: 0.01 });
        sides(1.8, 0.3, { w: 0.068, out: 0.03, curl: -0.02, r1: 1.1, th0: 0.6 });
        back(10, 1.5, 2 * PI - 1.5, 2.05, 0.33, { w: 0.11, th: 0.04, r1: 1.38, out: 0.07, curl: -0.03 });
        back(8, 1.8, 2 * PI - 1.8, 1.75, 0.22, { w: 0.12, th: 0.045, r1: 1.5, out: 0.09, curl: -0.02 });
        for (const sx of [-1, 1]) lock({ ph: sx * 1.55, th0: 0.5, th1: 1.9, drop: 0.22, w: 0.1, th: 0.04, r1: 1.35, out: 0.06, curl: -0.03 });
        break;
      case 13: // Wild spikes
        cap(1.04); fringe(5, 0.55, 0.95, { w: 0.046 }); sides(1.8, 0.12, { w: 0.055 });
        for (let i = 0; i < 5; i++) spike(1.05 + 0.18 * (i % 2), PI + (i - 2) * 0.5, 0.24 + 0.04 * (i % 2), 0.08, 0.12, 0.04);
        for (const sx of [-1, 1]) { spike(1.15, sx * 1.7, 0.25, 0.08, 0.15, 0.04); spike(1.55, sx * 2.3, 0.2, 0.07, -0.05, 0.02); spike(0.55, sx * 0.9, 0.16, 0.065, 0.3, 0.02); spike(0.6, sx * 2.6, 0.2, 0.07, 0.2, 0.03); }
        back(7, 1.9, 2 * PI - 1.9, 2.05, 0.04, { r1: 1.03, w: 0.06 });
        break;
      case 15: // Undercut: shaved sides, long top swept over to one side
        cap(0.97, 0.97, 0.97);
        for (let i = 0; i < 7; i++) lock({ ph: -0.55 + i * 0.16, th0: 0.9, th1: 1.55 + 0.04 * (i % 3), sweep: 0.75, r0: 0, w: 0.06, th: 0.022, r1: 1.12, curl: 0.01 } as Lock);
        for (let i = 0; i < 6; i++) lock({ ph: PI - 0.6 + i * 0.24, th0: 1.3, th1: 0.15, r1: 1.08, w: 0.06, th: 0.022 });
        break;
      case 16: // Mohawk: a crest of spikes from brow to nape
        cap(0.96, 0.96, 0.96);
        for (let k = 0; k < 9; k++) { const t = -1.1 + (k / 8) * 2.2; spike(Math.abs(t) + 0.05, t >= 0 ? 0 : PI, 0.2 + 0.08 * (1 - Math.abs(t) / 1.1), 0.075, 0.7, -0.02); }
        break;
      case 17: // Man bun: slicked back with a knot at the crown
        cap(); for (let i = 0; i < 8; i++) lock({ ph: -0.9 + i * 0.26, th0: 1.35, th1: -0.6, r1: 1.03, w: 0.055, th: 0.018 });
        sides(1.7, 0.02, { w: 0.04 });
        hairGeo.push(loft({ path: [[0, 0.355, -0.15], [0, 0.45, -0.18]], steps: 10, seg: 14, r: (t) => 0.06 * Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)) + 0.001, shape: (t, a) => 1 + 0.07 * Math.sin(a * 3 + t * 8), color: (t, _a, p, o) => hc(0.25 + 0.3 * t, p, o) }));
        hairGeo.push(lathe(0.37, 0.35, () => 0.045, () => 0.045, C.band, { z: -0.152, seg: 12, steps: 2 }));
        break;
      case 18: // Afro: a big round cloud of curls
        hv = 1.3;
        hairGeo.push(loft({ path: [[0, 0.11, -0.04], [0, 0.5, -0.04]], steps: 22, seg: 32, r: (t) => { const e = Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)); return [0.215 * e + 0.001, 0.215 * e + 0.001]; },
          shape: (t, a) => (1 + 0.05 * Math.sin(a * 11) * Math.sin(t * 19) + 0.04 * Math.sin(a * 7 + t * 13)) * (1 - 0.55 * Math.pow(Math.max(0, Math.sin(a)), 3) * (1 - smooth(0.45, 0.62, t))),
          color: (t, _a, p, o) => hc(0.15 + 0.5 * (1 - t), p, o) }));
        break;
      case 19: // Buzz cut
        cap(0.955, 0.95, 0.955); fringe(5, 0.5, 0.62, { w: 0.03, th: 0.008, r1: 1.0 });
        break;
      case 20: // Wolf cut: shaggy layers, short crown, longer flicked-out ends
        cap(1.04); fringe(7, 0.62, 0.95, { w: 0.042, curl: 0.012 });
        sides(1.85, 0.12, { curl: 0.025, out: 0.02 });
        back(10, 1.3, 2 * PI - 1.3, 2.05, 0.14, { r1: 1.12, w: 0.065, curl: 0.03, out: 0.035 });
        spike(0.35, 0.3, 0.1, 0.05, 0.2); spike(0.4, -0.5, 0.09, 0.05, 0.2); spike(0.6, PI, 0.11, 0.055, 0.1);
        break;
      case 21: { // Long ponytail: high tie, flowing to the waist, long face-framing locks
        cap(); fringe(6, 0.55, 1.0, { w: 0.046 }); sides(1.75, 0.5, { w: 0.05, wave: 0.012, curl: -0.01 });
        back(7, 1.9, 4.38, 2.0, 0, { r1: 1.0, w: 0.06 });
        tailL1 = 0.36;
        tail1.push(lathe(0.02, -0.02, () => 0.045, () => 0.045, C.band, { seg: 12, steps: 2, z: 0.0 }));
        tail1.push(loft({ path: [[0, 0.02, 0.02], [0, -0.05, -0.06], [0, -0.19, -0.07], [0, -0.36, -0.03]], steps: 16, seg: 14, r: (t) => [0.075 * (1 + 0.25 * Math.sin(PI * t)) * ends(t, 0.1, 0) + 0.004, 0.055 * ends(t, 0.1, 0) + 0.004], shape: (_t, a) => 1 + 0.12 * Math.abs(Math.sin(a * 3)), color: (t, _a, p, o) => hc(0.15 + 0.4 * t, p, o) }));
        tail2.push(loft({ path: [[0, 0.02, -0.03], [0.015, -0.17, 0.0], [-0.01, -0.34, 0.04], [0, -0.5, 0.08]], steps: 18, seg: 14, r: (t) => { const k = 1 - Math.pow(t, 1.5); return [0.085 * k + 0.002, 0.055 * k + 0.002]; }, shape: (_t, a) => 1 + 0.14 * Math.abs(Math.sin(a * 3)), color: (t, _a, p, o) => hc(0.55 + 0.45 * t, p, o) }));
        break;
      }
      default: // Hime cut
        cap(1.03); fringe(7, 0.6, 1.0, { blunt: true, w: 0.04, sweep: 0 }); sides(1.8, 0.12, { blunt: true, curl: 0, out: 0 });
        back(9, 1.6, 2 * PI - 1.6, 2.1, 0.6, { w: 0.075, blunt: true, r1: 1.08 });
    }
    headGeos.push(...hairGeo);
    // ---- hats / headband / wings ----
    const wing = (sx: number, x: number, y: number, z: number) => {
      for (let k = 0; k < 3; k++) {
        const d = new THREE.Vector3(sx * 0.35, 1, -0.5 - 0.4 * k).normalize(), len = 0.13 - 0.025 * k;
        headGeos.push(loft({ path: [[x, y, z], [x + d.x * len * 0.5, y + d.y * len * 0.5, z + d.z * len * 0.5], [x + d.x * len + sx * 0.012, y + d.y * len, z + d.z * len]], steps: 8, seg: 8, up: [sx, 0, 0],
          r: (t) => [0.03 * (1 - Math.pow(t, 1.5)) * ends(t, 0.15, 0) + 0.002, 0.006], color: vgrad(C.gold, mixHex('#' + C.gold.toString(16).padStart(6, '0'), '#ffffff', 0.4), y, y + 0.12) }));
      }
    };
    if (O.hat === 1) {
      const rx = keys([[0, 0.158], [0.5, 0.166], [0.85, 0.182], [1, 0.18]]), rz = keys([[0, 0.168], [0.5, 0.18], [0.85, 0.2], [1, 0.198]]);
      headGeos.push(loft({ path: [[0, 0.33, -0.02], [0, 0.47, -0.04]], steps: 10, seg: 28, r: (t) => [rx(t) * hv, rz(t) * hv], color: vgrad(C.hatD, C.hat, 0.36, 0.45), capEnd: true }));
      headGeos.push(lathe(0.325, 0.37, () => 0.162 * hv, () => 0.172 * hv, C.red, { z: -0.022, seg: 28, steps: 2 }));
      headGeos.push(E(0.15 * hv, 0.012, 0.09 * hv, 0, 0.33, 0.13 * hv, C.hatD, 22, 0.32, 0));
      headGeos.push(E(0.022, 0.022, 0.008, 0, 0.405, 0.2 * hv, C.gold, 12), box(0.06, 0.008, 0.006, 0, 0.405, 0.198 * hv, C.gold));
      if (O.wings) for (const sx of [-1, 1]) wing(sx, sx * 0.17 * hv, 0.39, 0.05);
    } else if (O.hat === 2) {
      headGeos.push(E(0.2 * hv, 0.065, 0.2 * hv, 0.025, 0.39 * (hv > 1 ? 1.04 : 1), -0.03, C.hat, 22, 0, -0.22), E(0.012, 0.025, 0.012, 0.04, 0.46, -0.03, C.hatD, 8));
      if (O.wings) for (const sx of [-1, 1]) wing(sx, sx * 0.16, 0.335, -0.01);
    } else {
      if (O.headband) headGeos.push(lathe(0.315, 0.285, () => 0.145 * wS, () => 0.15, C.band, { z: -0.005, seg: 26, steps: 2 }));
      if (O.wings) for (const sx of [-1, 1]) wing(sx, sx * 0.16 * hv, 0.335, -0.01);
    }
    mesh(headGeos, lit, head);
    const t1 = pivot(head, 0, 0.34, -0.17, T1); mesh(tail1, lit, t1);
    const t2 = pivot(t1, 0, -tailL1, 0, T2); mesh(tail2, lit, t2);

    // scarf
    const s1 = pivot(spine, 0, 0.58, -0.16, S1), s2 = pivot(s1, 0, -0.42, 0, S2);
    if (O.scarf) {
      mesh([lathe(0.035, -0.035, () => 0.15, () => 0.15, C.scarf, { z: 0.15, seg: 22, steps: 3 }),
        loft({ path: [[0, 0.02, 0.0], [0.01, -0.2, -0.01], [0, -0.42, 0]], steps: 10, seg: 10, up: [0, 0, -1], r: () => [0.13, 0.018], color: C.scarf }), E(0.016, 0.2, 0.024, 0.1, -0.21, -0.004, C.gold, 8)], lit, s1);
      mesh([loft({ path: [[0, 0.01, 0], [-0.01, -0.22, -0.01], [0.01, -0.46, 0]], steps: 10, seg: 10, up: [0, 0, -1], r: (t) => [0.12 * (1 - 0.2 * t), 0.016], color: vgrad(C.scarf, C.scarfD, 0, -0.46) })], lit, s2);
    }

    // =============================== arms ===============================
    for (const side of [-1, 1] as const) {
      const sh = pivot(spine, shoulder * side, 0.5, 0, side < 0 ? SHL : SHR);
      const up = coat ? keys([[0, 0.07], [0.12, O.top === 3 ? 0.1 : 0.088], [0.3, 0.072], [0.7, 0.057], [1, 0.053]]) : keys([[0, 0.064], [0.15, 0.068], [0.5, 0.055], [1, 0.046]]);
      const arm: THREE.BufferGeometry[] = [loft({ path: [[0, 0.055, 0], [0, -0.14, 0], [0, -0.31, 0]], steps: 14, seg: 16, r: (t) => up(t) * limb * ends(t, 0.16, 0), color: vgrad(sleeve, sleeveL, 0.05, -0.31) })];
      if (coat) arm.push(lathe(-0.27, -0.31, () => 0.056 * limb, () => 0.056 * limb, O.top === 3 ? C.jacketL : C.gold, { seg: 16, steps: 2 }));
      if (armor) {
        // layered pauldron: three overlapping curved plates, trimmed
        for (let k = 0; k < 3; k++) {
          const y = 0.06 - k * 0.045, r = 0.1 - k * 0.006;
          arm.push(loft({ path: [[0, y + 0.02, 0], [0, y - 0.05, 0]], steps: 4, seg: 18, r: () => [r * limb, r * limb * 1.05], shape: (t, a2) => (1 + 0.15 * t) * (Math.cos(a2) * side > -0.3 ? 1 : 0.55), color: k === 0 ? STEEL : STEEL_D }));
          arm.push(loft({ path: [[0, y - 0.05, 0], [0, y - 0.058, 0]], steps: 1, seg: 18, r: () => [r * limb * 1.15 + 0.004, r * limb * 1.2 + 0.004], shape: (_t, a2) => (Math.cos(a2) * side > -0.3 ? 1 : 0.55), color: C.gold }));
        }
        arm.push(loft({ path: [[0, 0.13, 0], [0, 0.02, 0]], steps: 8, seg: 18, r: (t) => [0.118 * limb * Math.sqrt(Math.max(0.02, t)), 0.124 * limb * Math.sqrt(Math.max(0.02, t))], color: STEEL }));
      }
      mesh(arm, lit, sh);
      const el = pivot(sh, 0, -0.31, 0, side < 0 ? ELL : ELR);
      const fore: THREE.BufferGeometry[] = [], foreIn: THREE.BufferGeometry[] = [];
      const fr = coat ? keys([[0, 0.052], [0.25, 0.055], [1, 0.042]]) : keys([[0, 0.046], [0.3, 0.05], [1, 0.036]]);
      fore.push(loft({ path: [[0, 0.035, 0], [0, -0.12, 0.004], [0, -0.27, 0]], steps: 12, seg: 16, r: (t) => fr(t) * limb * ends(t, 0.14, 0), color: vgrad(sleeveL, sleeve, 0.03, -0.27) }));
      const hand = gloves ? C.glove : C.skin;
      if (gloves) {
        // flared gauntlet cuff, open at the elbow end
        const cr = keys([[-0.13, 0.078], [-0.17, 0.062], [-0.26, 0.044], [-0.28, 0.042]]);
        fore.push(lathe(-0.13, -0.28, (y) => cr(y) * limb, (y) => cr(y) * limb, vgrad(C.glove, C.gloveD, -0.13, -0.28), { seg: 18, steps: 6 }));
        foreIn.push(lathe(-0.13, -0.2, (y) => cr(y) * limb * 0.95, (y) => cr(y) * limb * 0.95, C.gloveD, { seg: 18, steps: 4, flip: true }));
        fore.push(lathe(-0.125, -0.138, () => 0.08 * limb, () => 0.08 * limb, C.gold, { seg: 18, steps: 1 }));
      } else if (coat) fore.push(lathe(-0.2, -0.24, () => 0.05 * limb, () => 0.05 * limb, C.red, { seg: 16, steps: 2 }));
      // hand: palm + four curled fingers + thumb (palm faces the body)
      const ix = -side;
      fore.push(loft({ path: [[0, -0.255, 0], [0, -0.3, 0.003], [0, -0.338, 0.006]], steps: 8, seg: 12, r: (t) => { const k = ends(t, 0, 0.3); return [0.022 * k + 0.002, 0.038 * k + 0.002]; }, color: hand }));
      for (let k = 0; k < 4; k++) {
        const z = 0.027 - k * 0.018, len = k === 1 ? 1 : k === 3 ? 0.8 : 0.93;
        fore.push(loft({ path: [[0, -0.322, z], [ix * 0.006, -0.35 * len - 0.322 * (1 - len) + 0.0, z * 1.05], [ix * 0.022 * len, -0.368 + 0.012 * (1 - len), z * 1.05]], steps: 6, seg: 8, r: (t) => (0.0095 - 0.002 * t) * ends(t, 0, 0.3) + 0.001, color: hand }));
      }
      fore.push(loft({ path: [[ix * 0.012, -0.285, 0.026], [ix * 0.02, -0.318, 0.042], [ix * 0.024, -0.342, 0.04]], steps: 6, seg: 8, r: (t) => 0.011 * ends(t, 0, 0.3) + 0.001, color: hand }));
      if (armor) { const vr = keys([[0.0, 0.062], [-0.12, 0.058], [-0.2, 0.05]]); fore.push(lathe(0.0, -0.2, (y) => vr(y) * limb, (y) => vr(y) * limb * 1.05, grad(STEEL_D, STEEL, (_t, a2) => 0.4 + 0.6 * Math.max(0, Math.sin(a2))), { seg: 18, steps: 5 }), lathe(-0.195, -0.21, () => 0.054 * limb, () => 0.056 * limb, C.gold, { seg: 18, steps: 1 }), E(0.06 * limb, 0.05 * limb, 0.062 * limb, 0, 0.02, -0.01, STEEL, 14)); }
      mesh(fore, lit, el); mesh(foreIn, lit, el, false);
      if (O.top === 0 || O.top === 2) mesh([E(0.007, 0.05, 0.007, 0, -0.17, 0.056 * limb, C.cyan, 6)], glow, el);
    }

    // =============================== legs ===============================
    const legMain = O.bottom === 2 || O.bottom === 3 || O.bottom === 4 ? C.pants : O.bottom === 1 ? C.skin : C.sock;
    const legCol = O.bottom === 0 ? grad(C.skin, C.sock, (_t, _a, p) => (p.y > -0.17 ? 0 : 1)) : legMain;   // thigh-high socks under a skirt
    for (const side of [-1, 1] as const) {
      const th = pivot(hip, 0.1 * side, -0.02, 0, side < 0 ? THL : THR);
      const tr = keys([[0, 0.092], [0.1, 0.102], [0.45, 0.086], [0.8, 0.068], [1, 0.062]]);
      const thigh: THREE.BufferGeometry[] = [loft({ path: [[0, 0.07, 0], [0, -0.2, 0.004], [0, -TH, 0]], steps: 14, seg: 16, r: (t) => tr(t) * limb * ends(t, 0.12, 0), color: legCol })];
      if (O.bottom === 1) thigh.push(lathe(0.06, -0.17, keys([[0.06, 0.108], [-0.17, 0.104]]), keys([[0.06, 0.108], [-0.17, 0.104]]), C.pants, { seg: 16, steps: 4 }), lathe(-0.15, -0.172, () => 0.106 * limb, () => 0.106 * limb, C.gold, { seg: 16, steps: 1 }));
      if (O.bottom === 0) thigh.push(lathe(-0.16, -0.18, () => tr(0.42) * limb + 0.004, () => tr(0.42) * limb + 0.004, C.red, { seg: 16, steps: 1 }));
      mesh(thigh, lit, th);
      const kn = pivot(th, 0, -TH, 0, side < 0 ? KNL : KNR);
      const sr = keys([[0, 0.06], [0.25, 0.064], [0.6, 0.05], [1, 0.04]]);
      const shin: THREE.BufferGeometry[] = [loft({ path: [[0, 0.04, 0], [0, -0.2, -0.004], [0, -SH, 0]], steps: 14, seg: 16, r: (t) => sr(t) * limb * ends(t, 0.12, 0),
        shape: (t, a) => 1 + 0.2 * Math.exp(-(((t - 0.28) / 0.16) ** 2)) * Math.pow(Math.max(0, -Math.sin(a)), 1.5), color: legMain })];
      const shinIn: THREE.BufferGeometry[] = [];
      if (O.boots === 0) {
        const br = keys([[-0.02, 0.08], [-0.08, 0.074], [-0.3, 0.066], [-0.4, 0.064]]);
        shin.push(lathe(-0.02, -0.4, br, br, vgrad(C.bootL, C.boot, -0.02, -0.4), { seg: 18, steps: 10, shape: (_t, a) => 1 + 0.08 * Math.max(0, Math.sin(a)) }));
        shinIn.push(lathe(-0.02, -0.06, (y) => br(y) * 0.95, (y) => br(y) * 0.95, C.sole, { seg: 18, steps: 2, flip: true }));
        shin.push(lathe(-0.02, -0.045, () => 0.083, () => 0.083, C.gold, { seg: 18, steps: 1 }));
        for (const y of [-0.2, -0.29]) shin.push(lathe(y + 0.01, y - 0.01, (yy) => br(yy) + 0.006, (yy) => br(yy) + 0.006, C.plate, { seg: 18, steps: 1, shape: (_t, a) => 1 + 0.08 * Math.max(0, Math.sin(a)) }), box(0.024, 0.026, 0.01, 0, y, br(y) * 1.08 + 0.01, C.gold));
      } else if (O.boots === 1) {
        shin.push(lathe(-0.27, -0.4, () => 0.07, () => 0.072, vgrad(C.bootL, C.boot, -0.27, -0.4), { seg: 18, steps: 4 }), lathe(-0.27, -0.29, () => 0.074, () => 0.076, C.gold, { seg: 18, steps: 1 }));
      } else if (O.boots === 4) {
        // plate greaves with a knee cop over a leather shoe
        const gr = keys([[0.02, 0.076], [-0.1, 0.08], [-0.3, 0.068], [-0.4, 0.064]]);
        shin.push(lathe(0.02, -0.4, gr, gr, grad(STEEL_D, STEEL, (_t, a2) => 0.35 + 0.65 * Math.max(0, Math.sin(a2))), { seg: 18, steps: 10, shape: (t2, a2) => 1 + 0.12 * Math.max(0, Math.sin(a2)) + 0.22 * Math.exp(-(((t2 - 0.3) / 0.2) ** 2)) * Math.max(0, -Math.sin(a2)) }));
        shin.push(loft({ path: [[0, 0.07, 0.04], [0, -0.03, 0.055]], steps: 6, seg: 14, up: [0, 0, 1], r: (t) => { const k = Math.sin(PI * Math.min(1, t * 1.05)); return [0.07 * k + 0.004, 0.035 * k + 0.004]; }, color: STEEL }));
        shin.push(lathe(-0.385, -0.4, () => 0.066, () => 0.07, C.gold, { seg: 18, steps: 1 }));
      } else if (O.boots === 2) {
        shin.push(lathe(-0.33, -0.4, () => 0.054, () => 0.056, C.white, { seg: 16, steps: 2 }));
      } else {
        // chunky platform boots with straps and buckles
        const br = keys([[0.0, 0.098], [-0.06, 0.09], [-0.25, 0.086], [-0.42, 0.088]]);
        shin.push(lathe(0.0, -0.42, br, br, vgrad(C.bootL, C.boot, 0, -0.42), { seg: 20, steps: 10, shape: (_t, a) => 1 + 0.06 * Math.max(0, Math.sin(a)) }));
        shinIn.push(lathe(0.0, -0.05, (y) => br(y) * 0.95, (y) => br(y) * 0.95, C.sole, { seg: 20, steps: 2, flip: true }));
        shin.push(lathe(0.0, -0.025, () => 0.102, () => 0.102, C.boot, { seg: 20, steps: 1 }));
        for (const y of [-0.12, -0.22, -0.32]) {
          shin.push(lathe(y + 0.014, y - 0.014, (yy) => br(yy) + 0.008, (yy) => br(yy) + 0.008, C.sole, { seg: 20, steps: 1, shape: (_t, a) => 1 + 0.06 * Math.max(0, Math.sin(a)) }));
          shin.push(box(0.03, 0.034, 0.012, side * 0.05, y, br(y) * 0.98, C.bootL), box(0.016, 0.02, 0.014, side * 0.05, y, br(y) * 0.98 + 0.002, C.boot));
        }
      }
      if (O.bottom === 3) { shin.push(lathe(0.05, -0.25, keys([[0.05, 0.1], [-0.25, 0.13]]), keys([[0.05, 0.1], [-0.25, 0.13]]), C.pants, { seg: 18, steps: 4 })); shinIn.push(lathe(0.05, -0.25, keys([[0.05, 0.095], [-0.25, 0.125]]), keys([[0.05, 0.095], [-0.25, 0.125]]), C.sock, { seg: 18, steps: 4, flip: true })); }
      mesh(shin, lit, kn); mesh(shinIn, lit, kn, false);
      if (O.boots === 0) mesh([E(0.005, 0.09, 0.005, 0, -0.25, 0.082, C.cyan, 6)], glow, kn);
      const an = pivot(kn, 0, -SH, 0, side < 0 ? ANL : ANR);
      const chunky = O.boots === 3, sneaker = O.boots === 2, fs = chunky ? 1.22 : 1;
      const bc = sneaker ? C.white : O.boots === 4 ? 0x5a3a22 : C.boot, solec = sneaker ? C.red : chunky ? C.sole : C.red;
      const fw = keys([[0, 0.05], [0.3, 0.06], [0.75, 0.058], [1, 0.034]]), fh = keys([[0, 0.055], [0.4, 0.05], [1, 0.032]]);
      mesh([
        loft({ path: [[0, -0.02, -0.055], [0, -0.035, 0.04], [0, -0.045, 0.13 * fs], [0, -0.05, 0.19 * fs]], steps: 14, seg: 14, up: [0, 1, 0], r: (t) => { const k = ends(t, 0.15, 0.2); return [fw(t) * fs * k + 0.002, fh(t) * fs * k + 0.002]; }, color: bc }),
        loft({ path: [[0, chunky ? -0.07 : -0.072, -0.065], [0, -0.075, 0.07], [0, chunky ? -0.07 : -0.075, 0.2 * fs + 0.005]], steps: 12, seg: 12, up: [0, 1, 0], r: (t) => { const k = ends(t, 0.12, 0.12); return [0.064 * fs * k + 0.002, (chunky ? 0.024 : 0.013) * k + 0.002]; }, color: solec }),
        ...(sneaker ? [loft({ path: [[0, -0.03, 0.05], [0, -0.05, 0.13], [0, -0.06, 0.17]], steps: 6, seg: 8, up: [0, 1, 0], r: () => [0.05, 0.012], color: C.jacketL })] : []),
      ], lit, an);
    }
    this.hipY = HIP;
    setLoftDetail(prevDetail);
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

  /**
   * Walk / run / idle on the ground. Gaits are keyframed over one cycle (u = 0..1, u = 0 is the left heel strike, the right
   * leg runs half a cycle later), blended walk -> run by speed. Feet stay flat while planted (ankle cancels thigh + knee),
   * then roll to the toes; the run adds knee drive, a flight phase, a forward lean and pumping arms.
   */
  private poseGround(a: Float32Array, p: PoseIn, c: number): number {
    const S = Hero.set, hs = p.hs;
    this.wMove += (smooth(0.3, 1.8, hs) - this.wMove) * Math.min(1, p.dt * 10);
    this.wRun += (smooth(4.6, 7.2, hs) - this.wRun) * Math.min(1, p.dt * 6);
    const w = this.wMove, run = this.wRun, walk = 1 - run;
    const stride = 1.7 + hs * 0.32;                       // metres per full cycle (two steps)
    if (w > 0.02) this.phase += p.dt * (hs / stride);
    const u = this.phase - Math.floor(this.phase);
    const K = Hero.cyc;
    // per-leg channels: thigh (- forward), knee (+ bend), foot pitch relative to the ground (+ toes down)
    const WT = [[0, -0.42], [0.12, -0.3], [0.3, 0.02], [0.55, 0.38], [0.68, 0.1], [0.85, -0.38], [1, -0.42]];
    const WK = [[0, 0.06], [0.12, 0.26], [0.32, 0.08], [0.55, 0.38], [0.72, 1.05], [0.9, 0.22], [1, 0.06]];
    const WF = [[0, -0.22], [0.1, 0], [0.42, 0], [0.58, 0.55], [0.72, 0.15], [0.92, -0.1], [1, -0.22]];
    const RT = [[0, -0.55], [0.14, -0.15], [0.33, 0.55], [0.48, 0.42], [0.66, -0.55], [0.82, -0.95], [1, -0.55]];
    const RK = [[0, 0.32], [0.14, 0.55], [0.33, 0.28], [0.48, 1.25], [0.64, 2.0], [0.82, 1.25], [1, 0.32]];
    const RF = [[0, -0.05], [0.12, 0.05], [0.3, 0.45], [0.42, 0.75], [0.62, 0.45], [0.85, 0.05], [1, -0.05]];
    const leg = (uu: number) => {
      const t = walk * K(WT, uu) + run * K(RT, uu), k = walk * K(WK, uu) + run * K(RK, uu), f = walk * K(WF, uu) + run * K(RF, uu);
      return { t: t * w, k: k * w + 0.03, a: -(t * w + k * w) + f * w };
    };
    const L = leg(u), R = leg((u + 0.5) % 1);
    S(a, THL, L.t, 0, -0.03 * w); S(a, KNL, L.k, 0, 0); S(a, ANL, L.a, 0, 0);
    S(a, THR, R.t, 0, 0.03 * w); S(a, KNR, R.k, 0, 0); S(a, ANR, R.a, 0, 0);
    // pelvis: walk rises at mid-stance; run compresses at mid-stance and floats in the flight phase
    const ph2 = u * 4 * PI;
    const bob = w * (walk * 0.028 * -Math.cos(ph2) + run * (-0.055 * Math.cos(ph2 - 0.25 * 4 * PI * 0.17) - 0.04));
    const twist = w * (0.13 + 0.07 * run) * Math.sin(u * 2 * PI), roll = w * (0.05 * walk + 0.03 * run) * Math.sin(u * 2 * PI + PI / 2);
    const lean = w * (0.06 + 0.3 * run);
    const idle = 1 - w, breathe = Math.sin(c * 1.6);
    S(a, H, 0.0, twist, roll + idle * 0.02 * Math.sin(c * 0.5));
    S(a, SP, lean * 0.7 + idle * 0.015 * breathe, -twist * 1.4, -roll * 0.8);
    S(a, HD, -lean * 0.6 - idle * 0.01 * breathe, -twist * 0.4 + idle * 0.06 * Math.sin(c * 0.45), 0);
    // arms counter the opposite leg; walk: loose and nearly straight, run: elbows ~90 deg pumping across the body
    const armL = R.t, armR = L.t;
    const sw = walk * 0.85 + run * 1.15;
    const elW = (x: number) => -0.22 - 0.3 * Math.max(0, -x), elR = -1.5;
    S(a, SHL, armL * sw - idle * 0.02 * breathe, run * 0.15 * w, -0.08 - 0.05 * run - idle * 0.04);
    S(a, ELL, (walk * elW(armL) + run * elR) * w - idle * 0.15, 0, 0);
    S(a, SHR, armR * sw - idle * 0.02 * breathe, -run * 0.15 * w, 0.08 + 0.05 * run + idle * 0.04);
    S(a, ELR, (walk * elW(armR) + run * elR) * w - idle * 0.15, 0, 0);
    // weapon-specific running styles (blended in with the run)
    if (this.weapon && run * w > 0.01) {
      const k = run * w, J = (j: number, x: number, y: number, z: number) => { a[j * 3] += (x - a[j * 3]) * k; a[j * 3 + 1] += (y - a[j * 3 + 1]) * k; a[j * 3 + 2] += (z - a[j * 3 + 2]) * k; };
      const bobA = 0.06 * Math.sin(u * 4 * PI);
      if (this.weapon === 1) {
        // samurai dash: one hand grips the scabbard at the hip, the other forearm raised across the face, deep forward lean
        J(SHL, 0.35, 0.2, -0.4); J(ELL, -1.0, 0, 0);
        J(SHR, -1.7 + bobA, -0.3, -0.45); J(ELR, -2.15, 0, 0);
        J(SP, 0.55, a[SP * 3 + 1] * 0.5, a[SP * 3 + 2]); J(HD, -0.42, 0, 0);
      } else {
        // anime ninja run: chest low, arms swept straight back, head up
        J(SHL, 1.3 + bobA, 0.1, -0.28); J(ELL, -0.1, 0, 0);
        J(SHR, 1.3 + bobA, -0.1, 0.28); J(ELR, -0.1, 0, 0);
        J(SP, 0.78, a[SP * 3 + 1] * 0.3, a[SP * 3 + 2] * 0.5); J(HD, -0.62, 0, 0);
      }
    }
    // secondary joints get their own motion targets (springs add the follow-through)
    const wag = 0.3 * Math.sin(c * 1.8), acc = clamp(-this.acc * 0.012, -0.4, 0.4), st = Math.sin(u * 2 * PI);
    S(a, S1, 0.16 + hs * 0.05 + acc, 0, 0.04 * Math.sin(c * 2.1)); S(a, S2, 0.08 + hs * 0.03 + acc * 0.7, 0, 0.08 * Math.sin(c * 2.7) * (0.4 + w));
    S(a, T1, 0.2 + hs * 0.045 + acc + 0.05 * Math.cos(ph2) * w, 0, 0.06 * st * w + 0.03 * wag * (1 - w));
    S(a, T2, 0.1 + hs * 0.03 + acc * 0.8, 0, 0.1 * Math.sin(u * 2 * PI + 1.2) * w);
    return HIP + bob;
  }

  /** periodic keyframe curve (keys sorted by u in 0..1, last = first), smooth cosine interpolation */
  private static cyc(k: number[][], u: number): number {
    let i = 0; while (i < k.length - 2 && u > k[i + 1][0]) i++;
    const [u0, v0] = k[i], [u1, v1] = k[i + 1], t = (u - u0) / Math.max(1e-6, u1 - u0), e = (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, t)))) / 2;
    return v0 + (v1 - v0) * e;
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

  /** riding: seated straddle, hands forward on the reins; leans into the gallop and posts with the gait */
  private poseRide(a: Float32Array, p: PoseIn, c: number): void {
    const S = Hero.set, g = p.gait ?? 0, sp = p.speed, gal = smooth(8, 11, sp), move = smooth(0.2, 1.2, sp);
    const b = (0.05 * (1 - gal) * Math.sin(g * 2) + 0.07 * gal * Math.sin(g + 0.4)) * move;
    S(a, H, -0.04 - b * 0.5, 0, 0);
    S(a, SP, 0.08 + gal * 0.38 + b, 0, 0);
    S(a, HD, -0.08 - gal * 0.34 - b, 0.04 * Math.sin(c * 0.5) * (1 - move), 0);
    S(a, THL, -1.2, 0.12, -0.42); S(a, KNL, 1.5 + b, 0, 0); S(a, ANL, -0.3, 0, 0);
    S(a, THR, -1.2, -0.12, 0.42); S(a, KNR, 1.5 + b, 0, 0); S(a, ANR, -0.3, 0, 0);
    S(a, SHL, -0.7 - gal * 0.3 + b, 0.1, -0.22); S(a, ELL, -1.15 + gal * 0.25, 0, 0);
    S(a, SHR, -0.7 - gal * 0.3 + b, -0.1, 0.22); S(a, ELR, -1.15 + gal * 0.25, 0, 0);
    S(a, S1, 0.2 + sp * 0.06, 0, 0.05 * Math.sin(c * 2)); S(a, S2, 0.1 + sp * 0.05, 0, 0.1 * Math.sin(c * 2.6));
    S(a, T1, 0.25 + sp * 0.05 + 0.08 * Math.sin(g * 2) * move, 0, 0.04 * Math.sin(c * 1.7)); S(a, T2, 0.15 + sp * 0.04, 0, 0.08 * Math.sin(g + 1) * move);
  }

  /** height of the seat (pelvis underside) above the model's origin, for placing the rider on a saddle */
  get seatHeight(): number { return (this.hipY - 0.1) * this.rig.scale.y; }

  pose(p: PoseIn): void {
    const dt = Math.min(0.05, p.dt);
    this.clock += dt;
    const c = this.clock, T = this.T;
    // body acceleration (smoothed): drives the follow-through of hair / scarf
    const da = (p.hs - this.prevHs) / Math.max(dt, 1e-3); this.prevHs = p.hs; this.acc += (da - this.acc) * Math.min(1, dt * 6);

    // state weights glide instead of snapping (takeoff, landing and braking blend over ~0.2-0.35 s)
    const rate = (cur: number, tgt: number, r: number) => cur + (tgt - cur) * Math.min(1, dt * r);
    this.wFly = rate(this.wFly, p.mode === 'fly' ? 1 : 0, 6);
    this.wRide = rate(this.wRide, p.mode === 'ride' ? 1 : 0, 9);
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
    this.poseBrace(this.B, c); this.poseLand(this.L); this.poseRide(this.R, p, c);

    const wg = Math.max(0, 1 - this.wFly - this.wBrace - this.wLand - this.wRide), wa = this.wAir;
    for (let i = 0; i < NJ * 3; i++) {
      const ground = this.G[i] * (1 - wa) + this.A[i] * wa;
      T[i] = ground * wg + this.F[i] * this.wFly + this.B[i] * this.wBrace + this.L[i] * this.wLand + this.R[i] * this.wRide;
    }
    let hipY = hipG * wg + (HIP + Math.sin(c * 1.9) * 0.04 * (1 - this.wSpeed)) * this.wFly + 0.72 * this.wBrace + 0.62 * this.wLand + HIP * this.wRide;
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

  /** standing height in metres (for framing cameras) */
  get height(): number { return 1.95 * this.rig.scale.y / 0.92; }
  get faceY(): number { return 1.66 * this.rig.scale.y / 0.92; }
  get headSize(): number { return 0.5 * this.rig.scale.y / 0.92; }

  /** joint pivots (read by the skeleton retargeter) */
  get joints(): readonly THREE.Group[] { return this.J; }
  /** current pelvis height in rig units (HIP at rest) */
  get pelvisY(): number { return this.hipY; }
  /** drop every mesh, keeping only the animated joint hierarchy (used when another body is driven by this rig) */
  stripMeshes(): void {
    const meshes: THREE.Object3D[] = [];
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o); });
    for (const m of meshes) m.removeFromParent();
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
  }
}
