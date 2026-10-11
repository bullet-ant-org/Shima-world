/**
 * Hairstyles and head accessories for the rigged base model, built from a measured profile of the head.
 *
 * The Dresser samples the bare head into a radius table (height x angle around the skull axis) and measures how far back the
 * upper back reaches at each height. Hair is then a set of columns that start at the crown, follow the skull outward by the
 * hair's volume and end at a per-angle length (bangs over the forehead, locks at the cheeks, a curtain down the back). Below
 * the jaw the hanging hair is kept behind the back and shoulders, so long hair drapes instead of cutting through the body.
 * Everything here is in the model's bind space and is carried rigidly by the head bone.
 */
import * as THREE from 'three/webgpu';

export interface HeadShape {
  y0: number; y1: number; cz: number; hx: number;
  /** radius table: NY rows (yc 0 chin .. 1 crown) x NA angles (phi -PI..PI, 0 = facing forward) */
  prof: Float32Array; NY: number; NA: number;
  /** how far back (min z) the body reaches at height y, for hair hanging below the head */
  backZ(y: number): number;
  /** ear lobe position on the character's left (+x); mirror for the right */
  ear: THREE.Vector3;
}

export const BASE_HAIR = [
  'Long (original)', 'Short Crop', 'Buzz', 'Bob', 'Spiky', 'Ponytail', 'Man Bun', 'Bald',
  'Long Straight', 'Long Wavy', 'Hime Cut', 'Shoulder Length', 'Wolf Cut', 'Pixie', 'Side Part', 'Twin Tails',
  'High Ponytail', 'Braid', 'Space Buns', 'Afro', 'Curly Top', 'Mohawk', 'Slick Back', 'Pompadour', 'Dreadlocks', 'Top Knot', 'Cornrows', 'Messy Layers',
];
/** styles whose sides are a short buzz (the scalp wrap) with hair only on top / in pieces */
export const BUZZ_SIDES = new Set([21, 22, 23, 25, 26]);

export const HATS_BASE = ['None', 'Cap', 'Backwards Cap', 'Beanie', 'Bucket Hat', 'Fedora', 'Straw Kasa', 'Headband', 'Headphones', 'Cat Ears', 'Fox Ears', 'Oni Horns', 'Crown', 'Halo'];
export const GLASSES_BASE = ['None', 'Round', 'Square', 'Shades', 'Aviators', 'Cyber Visor', 'Monocle'];
export const EARRINGS = ['None', 'Studs', 'Hoops', 'Drops', 'Cyber Cuffs', 'Tassels'];
export const NECKWEAR = ['None', 'Chain', 'Pendant', 'Choker', 'Bead Necklace', 'Dog Tags', 'Scarf'];
export const WRISTWEAR = ['None', 'Watch', 'Bracelets', 'Cyber Band', 'Prayer Beads'];
export const MASKS = ['None', 'Face Mask', 'Oni Half Mask', 'Bandana', 'Fox Mask (side)', 'Cyber Respirator'];
export const BACKWEAR = ['None', 'Backpack', 'Sling Bag', 'Waist Pouch', 'Jetpack', 'Cape'];
export const FACE_PAINT = ['None', 'War Paint', 'Ink Stripes', 'Cyber Lines', 'Blush Hearts', 'Kitsune Marks'];

const C = (h: string | THREE.Color) => (h instanceof THREE.Color ? h.clone() : new THREE.Color(h));
const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hash = (i: number) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

/** radius of the head at (yc, phi), bilinear in the table */
export function headR(S: HeadShape, yc: number, phi: number): number {
  const fy = Math.min(S.NY - 1.001, Math.max(0, yc * (S.NY - 1))), y0 = Math.floor(fy), ty = fy - y0;
  let fa = ((phi + Math.PI) / (Math.PI * 2)) * S.NA; fa = ((fa % S.NA) + S.NA) % S.NA;
  const a0 = Math.floor(fa) % S.NA, a1 = (a0 + 1) % S.NA, ta = fa - Math.floor(fa);
  const P = S.prof, N = S.NA;
  const r0 = P[y0 * N + a0] * (1 - ta) + P[y0 * N + a1] * ta, r1 = P[(y0 + 1) * N + a0] * (1 - ta) + P[(y0 + 1) * N + a1] * ta;
  return r0 * (1 - ty) + r1 * ty;
}

interface Style {
  /** where each column ends (yc; negative = below the chin, in head heights) */
  bottom(phi: number): number;
  vol: number; jag: number; clumps: number; flare?: number; wave?: number; curlIn?: number; bump?: number;
  /** extra volume rising over the forehead (pompadour) or swept back over the top */
  front?: number; sweep?: number; top?: number;
  /** thin the hair out toward its bottom edge (short tops over shaved sides) */
  taper?: boolean;
}

/** smooth blend between the front length, side length and back length of a cut */
function cut(front: number, side: number, back: number, fW = 0.6, sW = 1.75) {
  return (phi: number) => {
    const a = Math.abs(phi);
    if (a < fW) return front;
    if (a < fW + 0.35) return front + (side - front) * sstep(fW, fW + 0.35, a);
    if (a < sW) return side;
    return side + (back - side) * sstep(sW, sW + 0.5, a);
  };
}

function styleFor(id: number, len: number, bangs: number): Style | null {
  const L = (v: number) => (v < 0.2 ? 0.2 - (0.2 - v) * len : v);       // length slider stretches what hangs below the jaw
  const B = (v: number) => 1 - (1 - v) * bangs;                            // bangs slider lengthens the fringe
  switch (id) {
    case 3: return { bottom: cut(B(0.62), 0.12, 0.06), vol: 0.07, jag: 0.02, clumps: 26, curlIn: 0.25 };
    case 8: return { bottom: cut(B(0.6), 0.02, L(-2.5), 0.55, 1.15), vol: 0.06, jag: 0.12, clumps: 30, flare: 0.16 };
    case 9: return { bottom: cut(B(0.62), 0.0, L(-2.3), 0.55, 1.15), vol: 0.09, jag: 0.16, clumps: 22, flare: 0.22, wave: 1 };
    case 10: return { bottom: (p) => { const a = Math.abs(p); return a < 0.62 ? B(0.6) : a < 1.65 ? 0.06 : L(-2.6) + 0 * a; }, vol: 0.06, jag: 0, clumps: 34, flare: 0.12 };
    case 11: return { bottom: cut(B(0.62), -0.15, L(-0.75)), vol: 0.07, jag: 0.1, clumps: 26, flare: 0.08 };
    case 12: return { bottom: cut(B(0.6), 0.28, L(-0.6), 0.7, 1.6), vol: 0.1, jag: 0.24, clumps: 16, flare: 0.16, bump: 0.2 };
    case 13: return { bottom: cut(B(0.7), 0.42, 0.3), vol: 0.05, jag: 0.12, clumps: 20 };
    case 14: return { bottom: (p) => (Math.abs(p) < 0.7 ? B(p > 0 ? 0.5 : 0.82) : cut(0.6, -0.1, L(-2.2), 0.7, 1.5)(p)), vol: 0.07, jag: 0.12, clumps: 26, flare: 0.16, wave: 0.4 };
    case 15: case 16: case 17: return { bottom: cut(B(0.64), 0.3, 0.32), vol: 0.035, jag: 0.06, clumps: 30 };
    case 18: return { bottom: cut(B(0.66), 0.3, 0.3), vol: 0.04, jag: 0.08, clumps: 30 };
    case 19: return { bottom: cut(0.78, 0.4, 0.25), vol: 0.25, jag: 0, clumps: 0, bump: 1, flare: -0.4 };
    case 20: return { bottom: cut(0.72, 0.6, 0.58), vol: 0.14, jag: 0, clumps: 0, bump: 0.8, taper: true };
    case 22: return { bottom: cut(0.8, 0.62, 0.55), vol: 0.05, jag: 0, clumps: 40, sweep: 1, taper: true };
    case 23: return { bottom: cut(0.8, 0.62, 0.55), vol: 0.05, jag: 0, clumps: 36, front: 1, sweep: 0.6, taper: true };
    case 24: return { bottom: cut(0.8, 0.5, 0.45), vol: 0.05, jag: 0, clumps: 0 };
    case 27: return { bottom: cut(B(0.6), 0.25, L(-0.25)), vol: 0.1, jag: 0.25, clumps: 14, flare: 0.12, bump: 0.15 };
    default: return null;
  }
}

/** the hair columns as one indexed grid with root-to-tip colour, groove shading and a glossy band */
function shell(S: HeadShape, st: Style, root: THREE.Color, tip: THREE.Color, seed: number): THREE.BufferGeometry {
  const Hh = S.y1 - S.y0, NA = 96, yh = 0.3;
  const bots: number[] = [];
  let minB = 1;
  for (let i = 0; i < NA; i++) {
    const phi = -Math.PI + (i / NA) * Math.PI * 2;
    let b = st.bottom(phi);
    if (st.jag) b -= st.jag * (i % 2 ? 0.25 + 0.75 * hash(i + seed) : 0.1) * (b < 0.4 ? 1.6 : 0.6);
    bots.push(b); minB = Math.min(minB, b);
  }
  const top = st.top ?? 0.995, levels: number[] = [];
  for (let y = top; y > minB; y -= y > yh ? 0.035 : 0.09) levels.push(y);
  levels.push(minB);
  const M = levels.length, pos: number[] = [], col: number[] = [], idx: number[] = [];
  const glossC = root.clone().lerp(new THREE.Color(1, 1, 1), 0.35);
  for (let i = 0; i <= NA; i++) {
    const ii = i % NA, phi = -Math.PI + (ii / NA) * Math.PI * 2, b = bots[ii], sp = Math.sin(phi), cp = Math.cos(phi);
    const ridge = st.clumps ? 0.5 - 0.5 * Math.cos(phi * st.clumps) : 0.5;
    for (let k = 0; k < M; k++) {
      const yc = Math.max(levels[k], b), endT = sstep(b + 0.18, b, yc);
      let off = Hh * st.vol * (0.75 + 0.5 * ridge);
      if (st.bump) off += Hh * 0.05 * st.bump * (Math.sin(phi * 9 + yc * 21) * Math.sin(phi * 5 - yc * 17 + 1.3) * 0.5 + 0.5);
      off += Hh * 0.06 * sstep(0.78, 0.6, yc) * sstep(0.3, 0.9, cp);   // bangs stand off the brows
      if (st.front) off += Hh * 0.22 * st.front * sstep(0.6, 0.9, yc) * Math.max(0, cp) ** 2;
      let rad: number;
      if (yc >= yh) rad = headR(S, yc, phi) + off;
      else rad = (headR(S, yh, phi) + off) * (1 + (st.flare ?? 0) * (yh - yc));
      if (st.taper) { const k = sstep(b, b + 0.25, yc); off *= k; rad = headR(S, yc, phi) + off + Hh * 0.01; }
      rad *= 1 - (st.curlIn ?? 0) * 0.12 * endT;
      let x = sp * rad, z = S.cz + cp * rad;
      const y = S.y0 + yc * Hh + Math.min(off, Hh * 0.12) * Math.max(0, (yc - 0.55) / 0.45) ** 1.2 * 1.1;   // volume rises over the crown too
      if (st.sweep && yc > 0.62) z -= Hh * 0.05 * st.sweep * sstep(0.62, 0.95, yc);
      if (st.wave && yc < 0.45) { const w = Hh * 0.045 * st.wave * sstep(0.45, 0.1, yc); x += w * Math.sin(yc * 7 + phi * 3) * cp; z += w * Math.sin(yc * 7 + phi * 3) * -sp; }
      // hanging hair goes behind the back and the shoulders
      const hang = sstep(0.3, 0.05, yc);
      if (hang > 0) { const bz = S.backZ(y) - Hh * 0.16; if (z > bz) z += (bz - z) * hang; }
      pos.push(x, y, z);
      const t = sstep(0.75, minB, yc);
      const c = root.clone().lerp(tip, t * 0.85).multiplyScalar(0.8 + 0.22 * ridge);
      const gl = Math.exp(-(((yc - 0.8) / 0.045) ** 2)) * (0.5 + 0.5 * ridge);   // anime "angel ring" highlight
      if (gl > 0.02 && (st.bump ?? 0) < 0.5) c.lerp(glossC, gl * 0.6);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < NA; i++) for (let k = 0; k < M - 1; k++) {
    const a = i * M + k, b = (i + 1) * M + k;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** tapered tube through points; radius(t) gives the thickness along it; coloured root -> tip */
function tube(S: HeadShape, pts: THREE.Vector3[], radius: (t: number) => number, root: THREE.Color, tip: THREE.Color, hang = true): THREE.BufferGeometry {
  const Hh = S.y1 - S.y0;
  if (hang) for (const p of pts) { const yc = (p.y - S.y0) / Hh, w = sstep(0.3, 0.05, yc); if (w > 0) { const bz = S.backZ(p.y) - Hh * 0.18; if (p.z > bz) p.z += (bz - p.z) * w; } }
  const curve = new THREE.CatmullRomCurve3(pts), seg = Math.max(8, pts.length * 6), rs = 10;
  const frames = curve.computeFrenetFrames(seg, false), pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (let s = 0; s <= seg; s++) {
    const t = s / seg, P = curve.getPointAt(t), N = frames.normals[s], Bn = frames.binormals[s], r = radius(t);
    const c = root.clone().lerp(tip, t * 0.8);
    for (let k = 0; k <= rs; k++) {
      const a = (k / rs) * Math.PI * 2, cs = Math.cos(a), sn = Math.sin(a);
      pos.push(P.x + (N.x * cs + Bn.x * sn) * r, P.y + (N.y * cs + Bn.y * sn) * r, P.z + (N.z * cs + Bn.z * sn) * r);
      const sh = 0.85 + 0.15 * Math.cos(a * 3);
      col.push(c.r * sh, c.g * sh, c.b * sh);
    }
  }
  for (let s = 0; s < seg; s++) for (let k = 0; k < rs; k++) { const a = s * (rs + 1) + k, b = a + rs + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function paintSolid(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const n = g.getAttribute('position').count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  return g;
}

/** a point on the hair surface (skull + volume) at (yc, phi), with an extra outward push */
function onHead(S: HeadShape, yc: number, phi: number, push: number): THREE.Vector3 {
  const r = headR(S, yc, phi) + push;
  return new THREE.Vector3(Math.sin(phi) * r, S.y0 + yc * (S.y1 - S.y0), S.cz + Math.cos(phi) * r);
}

/** rigid hair geometry for the style (empty for the styles the scalp wrap covers on its own) */
export function hairGeos(S: HeadShape, id: number, color: string, tipColor: string, len = 1, bangs = 1): THREE.BufferGeometry[] {
  const root = C(color), tip = C(tipColor).lerp(root, 0.45), Hh = S.y1 - S.y0, out: THREE.BufferGeometry[] = [];
  const st = styleFor(id, len, bangs);
  if (st) out.push(shell(S, st, root, tip, id * 7));
  const P = (yc: number, phi: number, push = Hh * 0.06) => onHead(S, yc, phi, push);
  const hangLen = Math.max(0.6, len);
  if (id === 15) for (const s of [-1, 1]) {                                     // twin tails from high on the sides
    const a = P(0.84, s * 2.2, Hh * 0.04), dx = s * Hh * 0.35;
    const pts = [a, a.clone().add(new THREE.Vector3(dx * 0.6, Hh * 0.05, -Hh * 0.08)), a.clone().add(new THREE.Vector3(dx, -Hh * 0.5, -Hh * 0.12)), a.clone().add(new THREE.Vector3(dx * 1.05, -Hh * 1.4 * hangLen, -Hh * 0.1)), a.clone().add(new THREE.Vector3(dx * 0.85, -Hh * 2.4 * hangLen, -Hh * 0.05))];
    out.push(tube(S, pts, (t) => Hh * (0.1 + 0.08 * Math.sin(Math.min(1, t * 2.2) * Math.PI * 0.8)) * (1 - 0.8 * t * t), root, tip, false));
    const tie = new THREE.TorusGeometry(Hh * 0.08, Hh * 0.025, 6, 14); tie.rotateY(Math.PI / 2); tie.translate(a.x + dx * 0.15, a.y + Hh * 0.01, a.z - Hh * 0.02); out.push(paintSolid(tie, C('#d02e48')));
  }
  if (id === 16) {                                                              // high ponytail from the crown
    const a = P(0.95, Math.PI, Hh * 0.02);
    const pts = [a, a.clone().add(new THREE.Vector3(0, Hh * 0.12, -Hh * 0.22)), a.clone().add(new THREE.Vector3(0, -Hh * 0.35, -Hh * 0.42)), a.clone().add(new THREE.Vector3(0, -Hh * 1.3 * hangLen, -Hh * 0.38)), a.clone().add(new THREE.Vector3(0, -Hh * 2.3 * hangLen, -Hh * 0.3))];
    out.push(tube(S, pts, (t) => Hh * (0.13 + 0.09 * Math.sin(Math.min(1, t * 2) * Math.PI * 0.8)) * (1 - 0.85 * t * t), root, tip));
    const tie = new THREE.TorusGeometry(Hh * 0.1, Hh * 0.03, 6, 14); tie.rotateX(1.1); tie.translate(a.x, a.y + Hh * 0.03, a.z - Hh * 0.05); out.push(paintSolid(tie, C('#d02e48')));
  }
  if (id === 17) {                                                              // braid: beads alternating left/right down the back
    const a = P(0.45, Math.PI, Hh * 0.05), n = Math.round(13 * hangLen);
    for (let k = 0; k < n; k++) {
      const t = k / n, r = Hh * (0.11 - 0.05 * t), y = a.y - k * Hh * 0.17, x = (k % 2 ? 1 : -1) * Hh * 0.035;
      const pt = new THREE.Vector3(x, y, a.z - Hh * 0.02);
      const w = sstep(0.3, 0.05, (y - S.y0) / Hh); const bz = S.backZ(y) - Hh * 0.2; if (pt.z > bz) pt.z += (bz - pt.z) * w;
      const bead = new THREE.SphereGeometry(r, 10, 8); bead.scale(1.15, 1.25, 0.85); bead.rotateZ((k % 2 ? 1 : -1) * 0.5); bead.translate(pt.x, pt.y, pt.z);
      out.push(paintSolid(bead, root.clone().lerp(tip, t * 0.7).multiplyScalar(0.9 + 0.1 * (k % 2))));
    }
  }
  if (id === 18) for (const s of [-1, 1]) {                                     // space buns
    const a = P(0.9, s * 2.0, Hh * 0.1), bun = new THREE.SphereGeometry(Hh * 0.17, 16, 12); bun.translate(a.x, a.y, a.z);
    out.push(paintSolid(bun, root.clone().multiplyScalar(0.95)));
    const twist = new THREE.TorusGeometry(Hh * 0.12, Hh * 0.04, 6, 16); twist.rotateX(Math.PI / 2 - 0.4); twist.translate(a.x, a.y + Hh * 0.07, a.z); out.push(paintSolid(twist, root.clone().multiplyScalar(0.8)));
  }
  if (id === 21) for (let k = 0; k < 9; k++) {                                  // mohawk fin
    const t = k / 8, yc = t < 0.5 ? 0.8 + 0.4 * t : 1.0 - (t - 0.5) * 0.8, base = P(Math.min(0.99, yc), t < 0.5 ? 0 : Math.PI, Hh * 0.01);
    const h = Hh * (0.32 + 0.12 * Math.sin(t * Math.PI)), cone = new THREE.ConeGeometry(Hh * 0.07, h, 6); cone.scale(0.5, 1, 1.4);
    const n = base.clone().sub(new THREE.Vector3(0, S.y0 + 0.45 * Hh, S.cz)).normalize();
    cone.translate(0, h / 2, 0); cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n.add(new THREE.Vector3(0, 0, -0.35)).normalize()));
    cone.translate(0, base.y, base.z); out.push(paintSolid(cone, root.clone().lerp(tip, 0.3 + 0.2 * (k % 2))));
  }
  if (id === 24) for (let k = 0; k < 34; k++) {                                // dreadlocks
    const phi = -Math.PI + ((k + 0.5) / 34) * Math.PI * 2;
    if (Math.abs(phi) < 0.55) continue;
    const yc = Math.abs(phi) < 1.3 ? 0.66 : 0.52, a = P(yc, phi, Hh * 0.04), out1 = new THREE.Vector3(Math.sin(phi), 0, Math.cos(phi)).multiplyScalar(Hh * 0.12);
    const L = Hh * (Math.abs(phi) < 1.3 ? 0.9 : 1.7) * hangLen * (0.85 + 0.3 * hash(k));
    const pts = [a, a.clone().add(out1).add(new THREE.Vector3(0, -Hh * 0.15, 0)), a.clone().add(out1.clone().multiplyScalar(1.4)).add(new THREE.Vector3(0, -L * 0.6, 0)), a.clone().add(out1.clone().multiplyScalar(1.5)).add(new THREE.Vector3(0, -L, 0))];
    out.push(tube(S, pts, (t) => Hh * 0.045 * (1 - 0.3 * t), root, tip));
  }
  if (id === 25) {                                                              // samurai chonmage: a short tail folded forward over the crown
    const pts = [P(0.8, Math.PI, Hh * 0.03), P(0.95, Math.PI, Hh * 0.05), P(0.995, 0, Hh * 0.06), P(0.88, 0, Hh * 0.05)];
    out.push(tube(S, pts, (t) => Hh * (0.07 - 0.03 * t), root, root.clone().multiplyScalar(0.8), false));
    const at = pts[1], tie = new THREE.CylinderGeometry(Hh * 0.08, Hh * 0.08, Hh * 0.06, 10); tie.rotateX(Math.PI / 2 - 0.5); tie.translate(at.x, at.y, at.z); out.push(paintSolid(tie, C('#f2ecd8')));
  }
  if (id === 26) for (let k = 0; k < 7; k++) {                                  // cornrows: tight braids running front to back
    const u = (k - 3) / 3.4, pts: THREE.Vector3[] = [];
    for (let j = 0; j <= 10; j++) { const s2 = j / 10, yc = s2 < 0.45 ? 0.78 + 0.21 * Math.sin((s2 / 0.45) * Math.PI / 2) : 0.99 - 0.66 * ((s2 - 0.45) / 0.55) ** 1.2; const phi = s2 < 0.45 ? u * 0.95 : Math.PI - u * 1.1; pts.push(P(yc, phi, Hh * 0.015)); }
    // flatten the jump across the crown: average the two points either side
    pts.splice(5, 1);
    out.push(tube(S, pts, (t) => Hh * (0.04 + 0.01 * Math.sin(t * 60)), root, root.clone().multiplyScalar(0.85), false));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// head accessories
export interface HeadAcc { geos: THREE.BufferGeometry[]; glow: THREE.BufferGeometry[] }

/** hats and things worn on the head; hairVol lifts them clear of big hairstyles */
export function hatGeos(S: HeadShape, id: number, color: string, metal: string, hairVol: number): HeadAcc {
  const Hh = S.y1 - S.y0, out: THREE.BufferGeometry[] = [], glow: THREE.BufferGeometry[] = [], c = C(color), dk = c.clone().multiplyScalar(0.7), m = C(metal);
  const pad = Hh * (0.07 + hairVol);
  const rx = Math.max(headR(S, 0.7, Math.PI / 2), headR(S, 0.7, -Math.PI / 2)) + pad, rzF = headR(S, 0.7, 0) + pad, rzB = headR(S, 0.7, Math.PI) + pad;
  const rz = (rzF + rzB) / 2, czh = S.cz + (rzF - rzB) / 2, yb = S.y0 + 0.66 * Hh;
  const dome = (h: number, y = yb, k = 1) => { const g = new THREE.SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2); g.scale(rx * k, h + pad * 1.2, rz * k); g.translate(0, y, czh); return g; };
  const ring = (r1x: number, r1z: number, y: number, th: number, col: THREE.Color, tilt = 0) => { const g = new THREE.TorusGeometry(1, th, 6, 36); g.rotateX(Math.PI / 2); g.scale(r1x, 1, r1z); g.rotateX(tilt); g.translate(0, y, czh); return paintSolid(g, col); };
  /** flat brim: a half-ellipse peak in front (caps) or a full ring (fedora / bucket), tilted down by slope */
  const brim = (_r: number, w: number, y: number, frontOnly: boolean, slope: number, col: THREE.Color) => {
    let g: THREE.BufferGeometry;
    if (frontOnly) { g = new THREE.CircleGeometry(1, 20, 0, Math.PI); g.scale(rx * 0.95, rz * 0.85, 1); g.rotateX(Math.PI / 2 - slope); g.translate(0, y, czh + rz * 0.62); }
    else { g = new THREE.RingGeometry(1, 1 + w, 36, 1); g.scale(rx, rz, 1); g.rotateX(-Math.PI / 2); g.translate(0, y, czh); const p = g.getAttribute('position') as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) { const d = Math.hypot(p.getX(i) / rx, (p.getZ(i) - czh) / rz); p.setY(i, y - Math.max(0, d - 1) * slope * rx * 2); } }
    return paintSolid(g, col);
  };
  switch (id) {
    case 1: case 2: { // baseball cap (forward / backwards)
      out.push(paintSolid(dome(Hh * 0.36), c));
      const b = brim(1, 0, yb + Hh * 0.01, true, 0.12, dk); if (id === 2) b.rotateY(Math.PI); out.push(b);
      const btn = new THREE.SphereGeometry(Hh * 0.035, 8, 6); btn.translate(0, yb + Hh * 0.36, czh); out.push(paintSolid(btn, dk));
      break;
    }
    case 3: out.push(paintSolid(dome(Hh * 0.45, yb - Hh * 0.04, 1.02), c), ring(rx * 1.04, rz * 1.04, yb - Hh * 0.02, Hh * 0.06, dk));
      { const pom = new THREE.SphereGeometry(Hh * 0.1, 10, 8); pom.translate(0, yb + Hh * 0.43, czh); out.push(paintSolid(pom, c.clone().lerp(new THREE.Color(1, 1, 1), 0.5))); }
      break;
    case 4: { out.push(paintSolid(dome(Hh * 0.4, yb, 1.04), c)); const g = new THREE.CylinderGeometry(1.0, 1.35, Hh * 0.14, 32, 1, true); g.scale(rx * 1.04, 1, rz * 1.04); g.translate(0, yb - Hh * 0.06, czh); out.push(paintSolid(g, dk)); break; }
    case 5: { const cr = new THREE.CylinderGeometry(0.82, 1, Hh * 0.38, 28); cr.scale(rx * 1.02, 1, rz * 1.02); cr.translate(0, yb + Hh * 0.18, czh); out.push(paintSolid(cr, c)); out.push(brim(1, 0.55, yb, false, 0.06, c.clone().multiplyScalar(0.9))); out.push(ring(rx * 1.02, rz * 1.02, yb + Hh * 0.05, Hh * 0.035, C('#1a1a22'))); break; }
    case 6: { const g = new THREE.ConeGeometry(1, Hh * 0.42, 32, 1, true); g.scale(rx * 2.5, 1, rz * 2.5); g.translate(0, yb + Hh * 0.16, czh); out.push(paintSolid(g, C('#d8c088'))); out.push(paintSolid(dome(Hh * 0.2, yb - Hh * 0.02, 0.95), C('#b89a60'))); break; }
    case 7: out.push(ring(headR(S, 0.74, Math.PI / 2) + Hh * 0.04 + hairVol * Hh, (headR(S, 0.74, 0) + headR(S, 0.74, Math.PI)) / 2 + Hh * 0.04 + hairVol * Hh, S.y0 + 0.74 * Hh, Hh * 0.045, c, 0.12)); break;
    case 8: { // headphones: band over the top, cups over the ears
      const band = new THREE.TorusGeometry(rx * 1.02, Hh * 0.035, 6, 24, Math.PI); band.scale(1, (S.y1 - S.ear.y + pad) / rx / 1.02, 1); band.translate(0, S.ear.y + Hh * 0.08, S.ear.z); out.push(paintSolid(band, C('#1a1a22')));
      for (const s of [-1, 1]) { const cup = new THREE.CylinderGeometry(Hh * 0.15, Hh * 0.15, Hh * 0.1, 18); cup.rotateZ(Math.PI / 2); cup.translate(s * (S.ear.x + Hh * 0.06 + hairVol * Hh * 0.6), S.ear.y + Hh * 0.08, S.ear.z); out.push(paintSolid(cup, c)); const led = new THREE.TorusGeometry(Hh * 0.1, Hh * 0.015, 4, 18); led.rotateY(Math.PI / 2); led.translate(s * (S.ear.x + Hh * 0.115 + hairVol * Hh * 0.6), S.ear.y + Hh * 0.08, S.ear.z); glow.push(paintSolid(led, C('#45ecff'))); }
      break;
    }
    case 9: case 10: for (const s of [-1, 1]) { // cat / fox ears
      const base = onHead(S, 0.92, s * 0.85, pad * 0.7), h = Hh * (id === 10 ? 0.34 : 0.26), e = new THREE.ConeGeometry(Hh * (id === 10 ? 0.12 : 0.13), h, 4); e.scale(1, 1, 0.45);
      e.translate(0, h / 2, 0); e.rotateZ(-s * 0.35); e.rotateY(s * 0.3); e.translate(base.x, base.y, base.z); out.push(paintSolid(e, c));
      const inner = new THREE.ConeGeometry(Hh * 0.07, h * 0.7, 4); inner.scale(1, 1, 0.3); inner.translate(0, h * 0.35, Hh * 0.025); inner.rotateZ(-s * 0.35); inner.rotateY(s * 0.3); inner.translate(base.x, base.y, base.z); out.push(paintSolid(inner, C('#ffb0c8')));
    } break;
    case 11: for (const s of [-1, 1]) { // oni horns
      const base = onHead(S, 0.86, s * 0.42, pad * 0.5), h = Hh * 0.32, e = new THREE.ConeGeometry(Hh * 0.07, h, 10); e.translate(0, h / 2, 0); e.rotateX(-0.35); e.rotateZ(-s * 0.3); e.translate(base.x, base.y, base.z); out.push(paintSolid(e, C('#f2ecd8').lerp(c, 0.25)));
    } break;
    case 12: { // crown
      out.push(ring(rx * 0.86, rz * 0.86, yb + Hh * 0.16, Hh * 0.04, m));
      for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2, sp = new THREE.ConeGeometry(Hh * 0.05, Hh * 0.18, 4); sp.translate(Math.sin(a) * rx * 0.86, yb + Hh * 0.26, czh + Math.cos(a) * rz * 0.86); out.push(paintSolid(sp, m)); const gem = new THREE.OctahedronGeometry(Hh * 0.03); gem.translate(Math.sin(a) * rx * 0.9, yb + Hh * 0.17, czh + Math.cos(a) * rz * 0.9); out.push(paintSolid(gem, C(k % 2 ? '#e83a3a' : '#2a7de1'))); }
      break;
    }
    case 13: { const h = new THREE.TorusGeometry(rx * 0.75, Hh * 0.03, 6, 36); h.rotateX(Math.PI / 2 + 0.25); h.translate(0, S.y1 + Hh * 0.3, czh - Hh * 0.05); glow.push(paintSolid(h, C('#ffe27a'))); break; }
    default: break;
  }
  return { geos: out, glow };
}

/** glasses / visors in front of the eyes */
export function glassesGeos(S: HeadShape, id: number, color: string): HeadAcc {
  const Hh = S.y1 - S.y0, out: THREE.BufferGeometry[] = [], glow: THREE.BufferGeometry[] = [], frame = C('#1a1a22'), ey = S.y0 + 0.43 * Hh;
  const zf = (x: number) => S.cz + Math.sqrt(Math.max(0, headR(S, 0.43, Math.atan2(x, 1) * 0) ** 2 - x * x)) + Hh * 0.04;
  const ex = Hh * 0.17, z0 = zf(ex);
  if (id === 4) { // aviators: teardrop lenses, thin metal frame
    for (const s of [-1, 1]) { const l = new THREE.CircleGeometry(Hh * 0.1, 20); l.scale(1.1, 0.9, 1); l.translate(s * ex, ey - Hh * 0.02, z0); out.push(paintSolid(l, C('#3a3020'))); const r = new THREE.TorusGeometry(Hh * 0.1, Hh * 0.012, 4, 20); r.scale(1.1, 0.9, 1); r.translate(s * ex, ey - Hh * 0.02, z0); out.push(paintSolid(r, C('#c8a24a'))); const arm = new THREE.BoxGeometry(Hh * 0.015, Hh * 0.015, Hh * 0.55); arm.translate(s * (S.hx + Hh * 0.02), ey, z0 - Hh * 0.28); out.push(paintSolid(arm, C('#c8a24a'))); }
    const br = new THREE.BoxGeometry(Hh * 0.12, Hh * 0.015, Hh * 0.015); br.translate(0, ey + Hh * 0.06, z0); out.push(paintSolid(br, C('#c8a24a')));
  } else if (id === 5) { // cyber visor: one glowing band wrapped round the eyes
    const g = new THREE.CylinderGeometry(1, 1, Hh * 0.13, 28, 1, true, -1.2, 2.4); g.scale(S.hx + Hh * 0.07, 1, (z0 - S.cz) + Hh * 0.02); g.translate(0, ey, S.cz); glow.push(paintSolid(g, C(color)));
    const rim = new THREE.CylinderGeometry(1, 1, Hh * 0.17, 28, 1, true, -1.35, 2.7); rim.scale(S.hx + Hh * 0.06, 1, (z0 - S.cz) + Hh * 0.005); rim.translate(0, ey, S.cz); out.push(paintSolid(rim, frame));
  } else if (id === 6) { // monocle on the right eye with a chain
    const r = new THREE.TorusGeometry(Hh * 0.11, Hh * 0.014, 6, 22); r.translate(-ex, ey, z0); out.push(paintSolid(r, C('#c8a24a')));
    const pts = [new THREE.Vector3(-ex - Hh * 0.1, ey - Hh * 0.05, z0), new THREE.Vector3(-ex - Hh * 0.2, ey - Hh * 0.3, z0 - Hh * 0.05), new THREE.Vector3(-S.hx, ey - Hh * 0.5, z0 - Hh * 0.2)];
    out.push(paintSolid(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, Hh * 0.006, 4), C('#c8a24a')));
  }
  return { geos: out, glow };
}

/** earrings hanging from both lobes */
export function earringGeos(S: HeadShape, id: number, metal: string, gem: string): HeadAcc {
  const Hh = S.y1 - S.y0, out: THREE.BufferGeometry[] = [], glow: THREE.BufferGeometry[] = [], m = C(metal);
  for (const s of [-1, 1]) {
    const x = s * (S.ear.x + Hh * 0.01), y = S.ear.y, z = S.ear.z;
    if (id === 1) { const g = new THREE.OctahedronGeometry(Hh * 0.03); g.translate(x, y, z); out.push(paintSolid(g, C(gem))); }
    if (id === 2) { const g = new THREE.TorusGeometry(Hh * 0.07, Hh * 0.01, 5, 18); g.rotateY(Math.PI / 2); g.translate(x, y - Hh * 0.07, z); out.push(paintSolid(g, m)); }
    if (id === 3) { const ch = new THREE.CylinderGeometry(Hh * 0.006, Hh * 0.006, Hh * 0.12, 4); ch.translate(x, y - Hh * 0.06, z); out.push(paintSolid(ch, m)); const d = new THREE.OctahedronGeometry(Hh * 0.04); d.scale(0.7, 1.3, 0.7); d.translate(x, y - Hh * 0.15, z); out.push(paintSolid(d, C(gem))); }
    if (id === 4) { const g = new THREE.TorusGeometry(Hh * 0.05, Hh * 0.016, 4, 12, Math.PI * 1.4); g.rotateY(Math.PI / 2); g.translate(x + s * Hh * 0.01, y + Hh * 0.12, z - Hh * 0.02); out.push(paintSolid(g, C('#c8c8d8'))); const l = new THREE.SphereGeometry(Hh * 0.018, 6, 4); l.translate(x + s * Hh * 0.03, y + Hh * 0.12, z + Hh * 0.03); glow.push(paintSolid(l, C('#45ecff'))); }
    if (id === 5) { const k = new THREE.SphereGeometry(Hh * 0.025, 6, 4); k.translate(x, y - Hh * 0.02, z); out.push(paintSolid(k, m)); const t = new THREE.ConeGeometry(Hh * 0.035, Hh * 0.2, 8); t.rotateX(Math.PI); t.translate(x, y - Hh * 0.13, z); out.push(paintSolid(t, C(gem))); }
  }
  return { geos: out, glow };
}
