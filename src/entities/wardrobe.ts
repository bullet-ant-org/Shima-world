/**
 * Wardrobe for the rigged base model: clothes, hair, beards and glasses generated from the body itself.
 *
 * Garments are "shrink-wrapped": the body's own triangles for a region (chosen by which bone each vertex follows most, plus
 * how far along the arm / leg / head it sits) are copied, pushed out along their normals by the cloth thickness, coloured
 * (trims on every hem, patterns, shading) and bound to the same skeleton with the same skin weights. So every garment
 * deforms exactly like the body under it, for any pose, any body shape and either gender — no extra assets needed.
 * Short hair, buzz cuts, bobs, beards and stubble are made the same way from the scalp / jaw; ponytails, buns, spikes and
 * glasses are rigid pieces carried by the head bone.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CharacterSpec } from './character';
import { BUZZ_SIDES, earringGeos, glassesGeos, hairGeos, hatGeos, type HeadAcc, type HeadShape } from './hairdo';
export { BASE_HAIR } from './hairdo';

export const OUTFITS = ['Original', 'Street', 'Hoodie', 'Business', 'Athletic', 'Samurai Gi', 'Kimono Dress'];
/** default colours for each outfit (applied when it is picked in the builder; every colour stays editable) */
export const OUTFIT_PALETTES: Record<number, { primary: string; secondary: string; accent: string; trim: string; pants: string; bootColor: string }> = {
  1: { primary: '#f4f2ec', secondary: '#3a5a8a', accent: '#e83a3a', trim: '#c8c8d8', pants: '#3a5a8a', bootColor: '#f2ecd8' },
  2: { primary: '#ff8a2a', secondary: '#2a2a36', accent: '#e83a3a', trim: '#f2ecd8', pants: '#2a2a36', bootColor: '#f2ecd8' },
  3: { primary: '#2a2f46', secondary: '#2a2f46', accent: '#c8283c', trim: '#c8c8d8', pants: '#2a2f46', bootColor: '#181a26' },
  4: { primary: '#27b9c9', secondary: '#1b2352', accent: '#ff8a2a', trim: '#f2ecd8', pants: '#1b2352', bootColor: '#f2ecd8' },
  5: { primary: '#1b2352', secondary: '#2a2a36', accent: '#d02e48', trim: '#e6b23a', pants: '#2a2a36', bootColor: '#f2ecd8' },
  6: { primary: '#d83a9a', secondary: '#7a3ad8', accent: '#2a2a36', trim: '#e6b23a', pants: '#d83a9a', bootColor: '#e83a3a' },
};

const enum R { Head, Neck, Torso, Arm, Hand, Hips, Leg, Foot }
const region = (n: string): R =>
  /^(finger|metacarpal|wrist)/.test(n) ? R.Hand : /^(upperarm|lowerarm)/.test(n) ? R.Arm : /^(shoulder|clavicle|spine|breast)/.test(n) ? R.Torso
    : /^pelvis/.test(n) ? R.Hips : /^(upperleg|lowerleg)/.test(n) ? R.Leg : /^(foot|toe)/.test(n) ? R.Foot : /^neck01/.test(n) ? R.Neck : R.Head;

/** per-vertex facts about one body mesh, in its bind space (model units, ~0.124 tall) */
interface Info { mesh: THREE.SkinnedMesh; n: number; reg: Uint8Array; armT: Float32Array; legT: Float32Array; pos: THREE.BufferAttribute; nor: THREE.BufferAttribute; /** welded id: UV-seam duplicates share one */ wid: Int32Array; /** normal averaged over welded duplicates */ wn: Float32Array }
interface Frame { neckY: number; waistY: number; hipY: number; chestY: number; head: { x: number; y0: number; y1: number; z0: number; z1: number } }

const C = (h: string) => new THREE.Color(h);
const paint = (g: THREE.BufferGeometry, c: THREE.Color) => { const n = g.getAttribute('position').count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
type HC = { hc(p: THREE.BufferAttribute, i: number): { yc: number; zf: number; xs: number } };
const hcolFn = (d: HC, col: THREE.Color, tip: THREE.Color) => (I: Info, i: number, e: boolean) => { const h = d.hc(I.pos, i); const c = mixC(col, tip, Math.max(0, 0.6 - h.yc) * 0.6); return e ? c.multiplyScalar(0.8) : c.multiplyScalar(0.92 + 0.08 * Math.sin(I.pos.getX(i) * 3000)); };
const scalpFn = (d: HC) => (I: Info, i: number, fringe: number, nape: number) => {
  if (I.reg[i] !== R.Head) return false;
  const h = d.hc(I.pos, i);
  if (h.yc > 0.66) return true;
  if (h.zf < 0.4 && h.yc > nape) return true;                                         // back of the head
  if (h.xs > 0.82 && h.zf < 0.62 && h.yc > 0.52) return true;                          // above the ears
  if (fringe && h.zf > 0.6 && h.yc > 0.66 - fringe && h.xs < 0.75) return true;        // fringe over the forehead
  return false;
};
const mixC = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, t);

export class Dresser {
  private infos: Info[] = [];
  /** welded position ids shared by all body meshes (the briefs patch meets the body along a seam) */
  private weld = new Map<string, number>(); private weldN: number[] = []; private weldP: number[] = [];
  private F!: Frame;
  private mat: THREE.MeshToonMaterial;
  private glowMat: THREE.MeshBasicMaterial;
  private S!: HeadShape;
  /** torso / neck / hip vertices (bind space) for fitting accessories to the body */
  private tp: number[] = [];
  private bones = new Map<string, THREE.Vector3>();
  readonly made: THREE.Object3D[] = [];

  constructor(private model: THREE.Object3D, private bodies: THREE.SkinnedMesh[], ramp: THREE.Texture, private owned: { dispose(): void }[]) {
    this.mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp, side: THREE.DoubleSide });
    this.glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    owned.push(this.mat, this.glowMat);
    const sk = bodies[0].skeleton;
    sk.bones.forEach((b, i) => { const m = new THREE.Matrix4().copy(sk.boneInverses[i]).invert(); this.bones.set(b.name, new THREE.Vector3().setFromMatrixPosition(m)); });
    const B = (n: string) => this.bones.get(n) ?? new THREE.Vector3();
    const shL = B('upperarm01_L'), wrL = B('wrist_L'), shR = B('upperarm01_R'), wrR = B('wrist_R'), hip = B('upperleg01_L'), ank = B('foot_L');
    let hx = 0, hy0 = 1, hy1 = -1, hz0 = 1, hz1 = -1;
    for (const mesh of bodies) {
      const g = mesh.geometry, pos = g.getAttribute('position') as THREE.BufferAttribute, nor = g.getAttribute('normal') as THREE.BufferAttribute;
      const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight'), n = pos.count;
      const reg = new Uint8Array(n), armT = new Float32Array(n), legT = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let best = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
        const r = region(mesh.skeleton.bones[best]?.name ?? 'head'); reg[i] = r;
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const sh = x >= 0 ? shL : shR, wr = x >= 0 ? wrL : wrR;
        armT[i] = (Math.abs(x) - Math.abs(sh.x)) / Math.max(1e-6, Math.abs(wr.x) - Math.abs(sh.x));
        legT[i] = (hip.y - y) / Math.max(1e-6, hip.y - ank.y);
        if (r === R.Head) { hx = Math.max(hx, Math.abs(x)); hy0 = Math.min(hy0, y); hy1 = Math.max(hy1, y); hz0 = Math.min(hz0, z); hz1 = Math.max(hz1, z); }
      }
      // weld UV-seam duplicates so seams are neither hems nor cracks
      const wid = new Int32Array(n), key = this.weld, acc = this.weldN;
      for (let i = 0; i < n; i++) {
        const k = Math.round(pos.getX(i) * 1.2e4) + ',' + Math.round(pos.getY(i) * 1.2e4) + ',' + Math.round(pos.getZ(i) * 1.2e4);   // ~1 mm: also joins the briefs patch to the body
        let w = key.get(k); if (w === undefined) { w = key.size; key.set(k, w); acc.push(0, 0, 0); this.weldP.push(0, 0, 0, 0); }
        wid[i] = w; acc[w * 3] += nor.getX(i); acc[w * 3 + 1] += nor.getY(i); acc[w * 3 + 2] += nor.getZ(i);
        const P4 = this.weldP; P4[w * 4] += pos.getX(i); P4[w * 4 + 1] += pos.getY(i); P4[w * 4 + 2] += pos.getZ(i); P4[w * 4 + 3]++;
      }
      const wn = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const w = wid[i], l = Math.hypot(acc[w * 3], acc[w * 3 + 1], acc[w * 3 + 2]) || 1; wn[i * 3] = acc[w * 3] / l; wn[i * 3 + 1] = acc[w * 3 + 1] / l; wn[i * 3 + 2] = acc[w * 3 + 2] / l; }
      this.infos.push({ mesh, n, reg, armT, legT, pos, nor, wid, wn });
    }
    this.F = { neckY: B('neck01').y, waistY: B('spine04').y, hipY: hip.y, chestY: B('breast_L').y, head: { x: hx, y0: hy0, y1: hy1, z0: hz0, z1: hz1 } };
    this.measure();
  }

  /** sample the head into a radius table and the back into a depth profile (see hairdo.ts) */
  private measure(): void {
    const H = this.F.head, Hh = H.y1 - H.y0, NY = 24, NA = 48;
    let zs0 = 1, zs1 = -1;
    for (const I of this.infos) for (let i = 0; i < I.n; i++) {
      const r = I.reg[i], x = I.pos.getX(i), y = I.pos.getY(i), z = I.pos.getZ(i);
      if (r === R.Head) { const yc = (y - H.y0) / Hh; if (yc > 0.7 && yc < 0.9) { zs0 = Math.min(zs0, z); zs1 = Math.max(zs1, z); } }
      if ((r === R.Torso || r === R.Neck || r === R.Hips) && I.mesh === this.infos[0].mesh) this.tp.push(x, y, z);
    }
    const cz = (zs0 + zs1) / 2, prof = new Float32Array(NY * NA);
    let ear = new THREE.Vector3(H.x, H.y0 + 0.35 * Hh, cz), earX = 0;
    for (const I of this.infos) for (let i = 0; i < I.n; i++) {
      if (I.reg[i] !== R.Head) continue;
      const x = I.pos.getX(i), y = I.pos.getY(i), z = I.pos.getZ(i), yc = (y - H.y0) / Hh;
      const phi = Math.atan2(x, z - cz), r = Math.hypot(x, z - cz);
      const yi = Math.min(NY - 1, Math.max(0, Math.round(yc * (NY - 1)))), ai = Math.floor(((phi + Math.PI) / (Math.PI * 2)) * NA) % NA;
      if (r > prof[yi * NA + ai]) prof[yi * NA + ai] = r;
      if (x > earX && yc > 0.28 && yc < 0.6) { earX = x; }
    }
    // ear lobe: the lowest point of the ear's outer rim
    let lobeY = 1;
    for (const I of this.infos) for (let i = 0; i < I.n; i++) {
      if (I.reg[i] !== R.Head) continue;
      const x = I.pos.getX(i), y = I.pos.getY(i), yc = (y - H.y0) / Hh;
      if (x > earX * 0.9 && yc > 0.15 && yc < 0.6 && y < lobeY) { lobeY = y; ear = new THREE.Vector3(x, y, I.pos.getZ(i)); }
    }
    // fill gaps around each row, then rows with nothing in them from the row below
    for (let y = 0; y < NY; y++) {
      for (let pass = 0; pass < NA; pass++) {
        let miss = false;
        for (let a = 0; a < NA; a++) if (!prof[y * NA + a]) { const l = prof[y * NA + (a + NA - 1) % NA], r = prof[y * NA + (a + 1) % NA]; if (l || r) prof[y * NA + a] = Math.max(l, r) * 0.999; else miss = true; }
        if (!miss) break;
      }
      if (!prof[y * NA] && y > 0) for (let a = 0; a < NA; a++) prof[y * NA + a] = prof[(y - 1) * NA + a] * 0.9;
    }
    const tp = this.tp, NB = 48, yLo = this.F.hipY, yHi = H.y1, back = new Float32Array(NB).fill(cz - H.x * 0.4);
    const seen = new Uint8Array(NB);
    for (let i = 0; i < tp.length; i += 3) {
      if (Math.abs(tp[i]) > H.x * 1.6) continue;
      const b = Math.round(((tp[i + 1] - yLo) / (yHi - yLo)) * (NB - 1)); if (b < 0 || b >= NB) continue;
      if (!seen[b] || tp[i + 2] < back[b]) { back[b] = tp[i + 2]; seen[b] = 1; }
    }
    for (let b = 1; b < NB; b++) if (!seen[b] && seen[b - 1]) { back[b] = back[b - 1]; seen[b] = 1; }
    const backZ = (y: number) => { const f = Math.min(NB - 1.001, Math.max(0, ((y - yLo) / (yHi - yLo)) * (NB - 1))), b = Math.floor(f), t = f - b; return Math.min(back[b] * (1 - t) + back[b + 1] * t, cz); };
    this.S = { y0: H.y0, y1: H.y1, cz, hx: H.x, prof, NY, NA, backZ, ear };
  }

  /** furthest body point toward +z (front) or -z (back) near (x, y) */
  private probeZ(x: number, y: number, front: boolean, wx = 0.0012, wy = 0.0012): number {
    const tp = this.tp; let best = front ? -1 : 1;
    for (let i = 0; i < tp.length; i += 3) if (Math.abs(tp[i] - x) < wx && Math.abs(tp[i + 1] - y) < wy) best = front ? Math.max(best, tp[i + 2]) : Math.min(best, tp[i + 2]);
    return Math.abs(best) === 1 ? 0 : best;
  }
  /** highest body point near (x, z) */
  private probeTop(x: number, wx = 0.001): number {
    const tp = this.tp; let best = -1;
    for (let i = 0; i < tp.length; i += 3) if (Math.abs(tp[i] - x) < wx && tp[i + 1] < this.F.neckY + 0.002) best = Math.max(best, tp[i + 1]);
    return best;
  }
  /** horizontal half-extents and centre of the body slice at height y */
  private slice(y: number, wy = 0.0008) {
    const tp = this.tp; let x1 = 0, z0 = 1, z1 = -1;
    for (let i = 0; i < tp.length; i += 3) if (Math.abs(tp[i + 1] - y) < wy) { x1 = Math.max(x1, Math.abs(tp[i])); z0 = Math.min(z0, tp[i + 2]); z1 = Math.max(z1, tp[i + 2]); }
    return { rx: x1, rz: (z1 - z0) / 2, cz: (z0 + z1) / 2 };
  }

  /** head-normalised coordinates: yc 0 chin .. 1 crown, zf 0 back .. 1 nose, xs 0 centre .. 1 side */
  hc(p: THREE.BufferAttribute, i: number) {
    const H = this.F.head;
    return { yc: (p.getY(i) - H.y0) / (H.y1 - H.y0), zf: (p.getZ(i) - H.z0) / (H.z1 - H.z0), xs: Math.abs(p.getX(i)) / H.x };
  }

  /** copy the kept body triangles, offset along normals, colour, bind to the skeleton */
  private wrap(keep: (I: Info, i: number) => boolean, off: (I: Info, i: number) => number, color: (I: Info, i: number, edge: boolean) => THREE.Color): void {
    // pass 1: kept triangles of every mesh, hem edges counted across all of them
    const ek = (a: number, b: number) => (a < b ? a * 65536 + b : b * 65536 + a);
    const edges = new Map<number, number>(), kept: number[][] = [];
    for (const I of this.infos) {
      const idx = I.mesh.geometry.getIndex()!, ok = new Uint8Array(I.n), tris: number[] = [];
      for (let i = 0; i < I.n; i++) ok[i] = keep(I, i) ? 1 : 0;
      for (let t = 0; t < idx.count; t += 3) {
        const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
        if (!ok[a] || !ok[b] || !ok[c]) continue;
        tris.push(a, b, c);
        const A = I.wid[a], Bw = I.wid[b], Cw = I.wid[c];
        for (const k of [ek(A, Bw), ek(Bw, Cw), ek(Cw, A)]) edges.set(k, (edges.get(k) ?? 0) + 1);
      }
      kept.push(tris);
    }
    const wedge = new Set<number>();
    for (const [k, cnt] of edges) if (cnt === 1) { wedge.add(Math.floor(k / 65536)); wedge.add(k % 65536); }
    // pass 2: build each mesh's garment piece
    this.infos.forEach((I, ii) => {
      const tris = kept[ii]; if (!tris.length) return;
      const g = I.mesh.geometry, si = g.getAttribute('skinIndex') as THREE.BufferAttribute, sw = g.getAttribute('skinWeight') as THREE.BufferAttribute;
      const edge = new Uint8Array(I.n); for (let i = 0; i < I.n; i++) if (wedge.has(I.wid[i])) edge[i] = 1;
      const remap = new Map<number, number>(), P: number[] = [], N: number[] = [], Cc: number[] = [], SI: number[] = [], SW: number[] = [], IX: number[] = [];
      for (const v of tris) {
        let j = remap.get(v);
        if (j === undefined) {
          j = remap.size; remap.set(v, j);
          const o = off(I, v), nx = I.wn[v * 3], ny = I.wn[v * 3 + 1], nz = I.wn[v * 3 + 2];
          const w4 = I.wid[v] * 4, Wp = this.weldP, cnt = Wp[w4 + 3];   // snapped to the welded position: seams close up
          P.push(Wp[w4] / cnt + nx * o, Wp[w4 + 1] / cnt + ny * o, Wp[w4 + 2] / cnt + nz * o); N.push(nx, ny, nz);
          const col = color(I, v, !!edge[v]); Cc.push(col.r, col.g, col.b);
          for (let k = 0; k < 4; k++) { SI.push(si.getComponent(v, k)); SW.push(sw.getComponent(v, k)); }
        }
        IX.push(j);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(SI, 4)); geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(SW, 4));
      geo.setIndex(IX); geo.computeVertexNormals();
      const m = new THREE.SkinnedMesh(geo, this.mat);
      m.bind(I.mesh.skeleton, I.mesh.bindMatrix);
      m.castShadow = true; m.frustumCulled = false;
      I.mesh.parent!.add(m); this.made.push(m); this.owned.push(geo);
    });
  }

  // ---- shading helpers: soft fabric shading so flat toon colours read as cloth ----
  private shade(c: THREE.Color, I: Info, i: number, edge: boolean, trim: THREE.Color | null): THREE.Color {
    if (edge && trim) return trim;
    const y = I.pos.getY(i), k = 0.93 + 0.07 * Math.sin(y * 900 + I.pos.getX(i) * 400) * 0.5 + (edge ? -0.12 : 0);
    return c.clone().multiplyScalar(k);
  }

  /** top: sleeve 0 (sleeveless) .. 1 (wrist); hem: how far below the waist; flare: extra thickness toward the cuff */
  private top(o: { sleeve: number; hem: number; color: THREE.Color; trim?: THREE.Color | null; off?: number; flare?: number; vneck?: number; open?: number; pattern?: (I: Info, i: number, c: THREE.Color) => THREE.Color; collar?: boolean }): void {
    const F = this.F, waist = F.waistY, hemY = waist - o.hem * (waist - F.hipY), base = (o.off ?? 0.00055);
    const neckOut = (I: Info, i: number) => {
      const y = I.pos.getY(i), x = I.pos.getX(i), z = I.pos.getZ(i);
      if (!o.vneck) return false;
      const depth = o.vneck * (F.neckY - F.chestY);
      return z > 0 && y > F.neckY - depth * (1 - Math.min(1, Math.abs(x) / 0.004));
    };
    const openFront = (I: Info, i: number) => !!o.open && I.pos.getZ(i) > 0.002 && Math.abs(I.pos.getX(i)) < o.open && I.reg[i] === R.Torso;
    this.wrap(
      (I, i) => {
        const r = I.reg[i];
        if (r === R.Torso) return I.pos.getY(i) > hemY && !neckOut(I, i) && !openFront(I, i);
        if (r === R.Neck) return !!o.collar && I.pos.getY(i) < F.neckY + 0.0012;
        if (r === R.Hips) return I.pos.getY(i) > hemY;
        if (r === R.Arm) return I.armT[i] <= o.sleeve;
        return false;
      },
      (I, i) => base + (I.reg[i] === R.Arm ? (o.flare ?? 0) * Math.max(0, I.armT[i]) : 0) + (I.reg[i] === R.Neck ? 0.0004 : 0),
      (I, i, e) => { let c = o.color; if (o.pattern) c = o.pattern(I, i, c); return this.shade(c, I, i, e, o.trim ?? null); },
    );
  }

  /** legwear: len 0 (briefs) .. 1 (ankle); flare = extra width toward the hem (hakama / wide trousers) */
  private pants(o: { len: number; color: THREE.Color; trim?: THREE.Color | null; flare?: number; off?: number; rise?: number }): void {
    const F = this.F, waistTop = F.waistY + (o.rise ?? 0.15) * (F.waistY - F.hipY);
    this.wrap(
      (I, i) => {
        const r = I.reg[i];
        if (r === R.Hips) return true;
        if (r === R.Torso) return I.pos.getY(i) < waistTop;
        if (r === R.Leg) return I.legT[i] <= o.len;
        return false;
      },
      (I, i) => (o.off ?? 0.00045) + (I.reg[i] === R.Leg ? (o.flare ?? 0) * Math.max(0, I.legT[i]) ** 1.3 : 0),
      (I, i, e) => this.shade(o.color, I, i, e, o.trim ?? null),
    );
  }

  private shoes(color: THREE.Color, sole: THREE.Color, high = 0.9): void {
    this.wrap((I, i) => I.reg[i] === R.Foot || (I.reg[i] === R.Leg && I.legT[i] > high), (I, i) => 0.0004 + (I.legT[i] > 0.985 ? 0.00025 : 0),
      (I, i, e) => (I.pos.getY(i) < 0.0016 ? sole : this.shade(color, I, i, e, null)));
  }

  private gloves(color: THREE.Color): void {
    this.wrap((I, i) => I.reg[i] === R.Hand || (I.reg[i] === R.Arm && I.armT[i] > 0.9), () => 0.00018, (I, i, e) => this.shade(color, I, i, e, null));
  }

  // ---------------------------------------------------------------------------------------------------------------------
  dress(spec: CharacterSpec): void {
    const O = spec.outfit, look = O.look ?? 0, male = spec.gender === 'male';
    const p = C(O.primary), s = C(O.secondary), a = C(O.accent), t = C(O.trim), legs = C(O.pants), boot = C(O.bootColor);
    const white = C('#f4f2ec'), dark = C('#1c1e28');
    switch (look) {
      case 1: // street: graphic tee, jeans, sneakers
        this.top({ sleeve: 0.42, hem: 0.55, color: p, trim: mixC(p, white, 0.35), collar: true, pattern: (I, i, c) => (I.pos.getZ(i) > 0.003 && Math.abs(I.pos.getX(i)) < 0.0035 && Math.abs(I.pos.getY(i) - this.F.chestY) < 0.0028 ? a : c) });
        this.pants({ len: 0.97, color: C('#3a5a8a').lerp(legs, 0.35), trim: C('#2a3e62'), off: 0.0004 });
        this.shoes(white, C('#d8d4cc'));
        break;
      case 2: // hoodie, joggers, sneakers
        this.top({ sleeve: 0.97, hem: 0.95, color: p, trim: mixC(p, dark, 0.3), off: 0.0009, flare: 0.0003, collar: true, pattern: (I, i, c) => (I.pos.getZ(i) > 0.0035 && Math.abs(I.pos.getY(i) - this.F.waistY) < 0.0022 && Math.abs(I.pos.getX(i)) < 0.0048 ? mixC(c, dark, 0.25) : c) });
        this.wrap((I, i) => { const h = this.hc(I.pos, i); return I.reg[i] === R.Head && h.zf < 0.32 && h.yc < 0.42; }, () => 0.0016, (I, i, e) => this.shade(p, I, i, e, mixC(p, dark, 0.3))); // hood resting on the back
        this.pants({ len: 0.96, color: s, trim: mixC(s, dark, 0.4), flare: 0.0003 });
        this.shoes(a, white);
        break;
      case 3: // business: shirt + tie under a suit jacket, trousers, leather shoes
        this.top({ sleeve: 0.95, hem: 0.5, color: white, collar: true, off: 0.0004, pattern: (I, i, c) => (I.pos.getZ(i) > 0.002 && Math.abs(I.pos.getX(i)) < 0.0007 + 0.0006 * Math.max(0, (this.F.neckY - I.pos.getY(i)) / 0.012) && I.pos.getY(i) > this.F.waistY ? a : c) });
        this.top({ sleeve: 0.93, hem: 1.25, color: male ? C('#2a2f3e').lerp(p, 0.4) : p, trim: mixC(p, dark, 0.35), off: 0.0008, open: 0.0016 + 0.0026 * 1, vneck: 0.9 });
        this.pants({ len: 0.98, color: male ? C('#2a2f3e').lerp(p, 0.4) : s, trim: null, off: 0.0005 });
        this.shoes(C('#1a1210'), C('#0e0a08'));
        break;
      case 4: // athletic: tank top, shorts, trainers
        this.top({ sleeve: -0.2, hem: 0.45, color: p, trim: white, off: 0.0004, vneck: male ? 0 : 0.25 });
        this.pants({ len: 0.36, color: s, trim: white, off: 0.0005, flare: 0.0005 });
        this.shoes(white, a);
        break;
      case 5: // samurai: gi with wide sleeves and a crossed collar, hakama, tabi
        this.top({ sleeve: 0.9, hem: 1.4, color: male ? p : white, trim: male ? mixC(p, dark, 0.3) : a, off: 0.0009, flare: 0.0024, vneck: 0.75 });
        this.wrap((I, i) => I.reg[i] === R.Torso && Math.abs(I.pos.getY(i) - this.F.waistY + 0.0012) < 0.0016, () => 0.0015, () => a); // obi belt
        this.pants({ len: 0.99, color: male ? C('#22263a').lerp(s, 0.3) : s, trim: mixC(s, dark, 0.3), flare: 0.0058, off: 0.0011, rise: 0.4 });
        this.shoes(white, C('#5a4030'), 0.93);
        break;
      case 6: // kimono dress: wrapped top, wide sleeves, long full skirt-wrap, obi; zori sandals
        this.top({ sleeve: 0.86, hem: 1.5, color: p, trim: t, off: 0.0009, flare: 0.0034, vneck: 0.7, pattern: (I, i, c) => (Math.sin(I.pos.getX(i) * 2400) * Math.sin(I.pos.getY(i) * 2400) > 0.82 ? mixC(c, white, 0.55) : c) });
        this.wrap((I, i) => I.reg[i] === R.Torso && Math.abs(I.pos.getY(i) - this.F.waistY) < 0.0024, () => 0.0016, (_I, _i, e) => (e ? t : a)); // obi
        this.pants({ len: 0.95, color: p, trim: t, flare: 0.0045, off: 0.001, rise: 0.4 });
        this.shoes(C('#c8283c'), C('#e8dcc0'), 0.97);
        break;
      default: break; // 'Original': the model's own v-neck top, pleated skirt and heeled sandals
    }
    if (O.gloves && look !== 0) this.gloves(C(O.gloveColor));
    this.hair(spec);
    this.beard(spec);
  }

  private hair(spec: CharacterSpec): void {
    const st = spec.hair.base ?? 0, col = C(spec.hair.color), tip = C(spec.hair.tip);
    if (st === 0 || st === 7) return;
    if (st >= 8 || st === 3) { this.hair2(spec, st, scalpFn(this), hcolFn(this, col, tip)); return; }
    const hcol = hcolFn(this, col, tip), scalp = scalpFn(this);
    if (st === 1 || st === 4 || st === 5 || st === 6) this.wrap((I, i) => scalp(I, i, st === 1 ? 0.1 : 0.04, 0.22), (I, i) => 0.00055 + 0.0005 * Math.max(0, this.hc(I.pos, i).yc - 0.6), hcol);
    if (st === 2) this.wrap((I, i) => scalp(I, i, 0, 0.26), () => 0.00012, (I, i, e) => mixC(C(spec.skin), col, 0.75).multiplyScalar(e ? 0.95 : 1));
    // rigid pieces on the head bone
    const H = this.F.head, cx = 0, top = H.y1, back = H.z0, midY = (H.y0 + H.y1) / 2, sx = H.x;
    const g: THREE.BufferGeometry[] = [];
    if (st === 4) for (let k = 0; k < 11; k++) {                                            // spikes
      const a = (k / 11) * Math.PI * 2, r = 0.45 + 0.25 * (k % 2);
      const cone = new THREE.ConeGeometry(0.0017, 0.0055, 6); cone.translate(0, 0.0025, 0);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.9 * Math.cos(a) * r - 0.4, 0, 0.9 * Math.sin(a) * r));
      cone.applyQuaternion(q); cone.translate(cx + Math.sin(a) * sx * 0.45, top - 0.0015, (H.z0 + H.z1) / 2 - 0.001 + Math.cos(a) * 0.003 - 0.002);
      g.push(cone);
    }
    if (st === 5) { // ponytail: tie at the crown-back, tail falling down the back
      const pts = [new THREE.Vector3(0, top - 0.0028, back + 0.0012), new THREE.Vector3(0, top - 0.0035, back - 0.0035), new THREE.Vector3(0, midY - 0.004, back - 0.0042), new THREE.Vector3(0, H.y0 - 0.006, back - 0.002)];
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.0019, 10);
      const p = tube.getAttribute('position') as THREE.BufferAttribute; // taper toward the tip
      for (let i = 0; i < p.count; i++) { const tt = Math.floor(i / 11) / 16, k = 1 - 0.75 * tt * tt; const c = pts[0].clone().lerp(pts[3], tt); p.setXYZ(i, c.x + (p.getX(i) - c.x) * k, p.getY(i), c.z + (p.getZ(i) - c.z) * k); }
      tube.computeVertexNormals(); g.push(tube);
      const tie = new THREE.TorusGeometry(0.0017, 0.0005, 6, 12); tie.rotateX(1.2); tie.translate(0, top - 0.003, back - 0.0006); g.push(tie);
    }
    if (st === 6) { const bun = new THREE.SphereGeometry(0.0028, 14, 10); bun.scale(1, 0.85, 1); bun.translate(0, top - 0.0004, back + 0.0035); g.push(bun); }
    if (g.length) this.rigid(g, col);
  }

  /** the newer styles: a scalp under-layer (or a buzz on the sides), then the rigid hair from hairdo.ts */
  private hair2(spec: CharacterSpec, st: number, scalp: (I: Info, i: number, fringe: number, nape: number) => boolean, hcol: (I: Info, i: number, e: boolean) => THREE.Color): void {
    const col = C(spec.hair.color);
    if (BUZZ_SIDES.has(st)) this.wrap((I, i) => scalp(I, i, 0, 0.26), () => 0.00012, (_I, _i, e) => mixC(C(spec.skin), col, st === 26 ? 0.7 : 0.4).multiplyScalar(e ? 0.95 : 1));
    else this.wrap((I, i) => scalp(I, i, 0.04, 0.2), () => 0.00035, hcol);
    const geos = hairGeos(this.S, st, spec.hair.color, spec.hair.tip, spec.hair.len ?? 1, spec.hair.bangs ?? 1);
    this.rigidOn('head', geos, this.mat);
  }

  /** how much a hairstyle puffs out the head (so hats sit on top of it) */
  private hairVol(st: number): number {
    return st === 19 ? 0.34 : st === 20 || st === 12 || st === 27 ? 0.13 : st === 0 ? 0.13 : st === 2 || st === 7 || st === 26 ? 0 : st === 23 ? 0.1 : 0.07;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  /** jewellery, hats, masks, face paint and bags */
  accessories(spec: CharacterSpec): void {
    const A = spec.acc; if (!A) return;
    const S = this.S, Hh = S.y1 - S.y0, put = (h: HeadAcc) => { if (h.geos.length) this.rigidOn('head', h.geos, this.mat); if (h.glow.length) this.rigidOn('head', h.glow, this.glowMat); };
    if (A.hat) put(hatGeos(S, A.hat, spec.outfit.hatColor ?? A.color, A.metal, this.hairVol(spec.hair.base ?? 0) * Hh / Hh));
    if (A.ear) put(earringGeos(S, A.ear, A.metal, A.glow));
    this.mask(spec);
    this.paint(spec);
    this.neckwear(spec);
    this.wristwear(spec);
    this.backwear(spec);
  }

  private mask(spec: CharacterSpec): void {
    const k = spec.acc.mask, S = this.S, Hh = S.y1 - S.y0; if (!k) return;
    const c = C(spec.acc.color), lower = (I: Info, i: number, top: number) => { if (I.reg[i] !== R.Head && !(k === 3 && I.reg[i] === R.Neck && I.pos.getZ(i) > 0.001)) return false; const h = this.hc(I.pos, i); return I.reg[i] === R.Neck || (h.yc < top && h.yc > 0.04 && h.zf > (k === 3 ? 0.5 : 0.66) && h.xs < (k === 3 ? 0.95 : 0.8)); };
    if (k === 1) this.wrap((I, i) => lower(I, i, 0.37), () => 0.00035, (I, i, e) => (e ? c.clone().multiplyScalar(0.85) : this.shade(c, I, i, false, null)));
    if (k === 2) this.wrap((I, i) => lower(I, i, 0.37), () => 0.0005, (I, i, e) => { const h = this.hc(I.pos, i); if (e) return C('#1a1a22'); if (h.yc > 0.13 && h.yc < 0.2 && h.xs < 0.45) return Math.sin(I.pos.getX(i) * 9000) > 0 ? C('#f2ecd8') : C('#2a1a1a'); return C('#c8283c').multiplyScalar(0.9 + 0.1 * Math.sin(h.xs * 20)); });
    if (k === 3) this.wrap((I, i) => lower(I, i, 0.36), () => 0.0005, (I, i, e) => (e ? c.clone().multiplyScalar(0.7) : (Math.sin(I.pos.getX(i) * 6000) * Math.sin(I.pos.getY(i) * 6000) > 0.7 ? C('#f2ecd8') : c.clone())));
    if (k === 4) { // fox mask worn on the side of the head
      const g: THREE.BufferGeometry[] = [], at = new THREE.Vector3(Math.sin(1.35) * (this.S.hx + Hh * 0.14), S.y0 + 0.66 * Hh, S.cz + Math.cos(1.35) * Hh * 0.2);
      const face = new THREE.SphereGeometry(Hh * 0.26, 16, 12); face.scale(0.45, 1, 0.75); g.push(face);
      const snout = new THREE.ConeGeometry(Hh * 0.1, Hh * 0.24, 8); snout.rotateZ(-Math.PI / 2); snout.translate(Hh * 0.16, -Hh * 0.08, 0); g.push(snout);
      for (const s of [-1, 1]) { const e = new THREE.ConeGeometry(Hh * 0.08, Hh * 0.22, 4); e.translate(0, Hh * 0.3, s * Hh * 0.13); g.push(e); }
      const white = g.map((x) => { x.rotateY(-0.2); x.translate(at.x, at.y, at.z); return paint(x, C('#f7f4ee')); });
      const marks: THREE.BufferGeometry[] = [];
      for (const s of [-1, 1]) { const m = new THREE.BoxGeometry(Hh * 0.02, Hh * 0.03, Hh * 0.12); m.translate(Hh * 0.115, Hh * 0.06, s * Hh * 0.08); m.rotateY(-0.2); m.translate(at.x, at.y, at.z); marks.push(paint(m, C('#c8283c'))); }
      this.rigidOn('head', [...white, ...marks], this.mat);
    }
    if (k === 5) { // cyber respirator over mouth and nose
      const mz = S.cz + this.headR0(0.22, 0) + Hh * 0.05, my = S.y0 + 0.22 * Hh, g: THREE.BufferGeometry[] = [], gl: THREE.BufferGeometry[] = [];
      const body = new THREE.SphereGeometry(Hh * 0.2, 16, 10, 0, Math.PI * 2, 0, Math.PI); body.scale(1.15, 0.85, 0.6); body.translate(0, my, mz - Hh * 0.06); g.push(paint(body, C('#2a2c36')));
      for (const s of [-1, 1]) { const f = new THREE.CylinderGeometry(Hh * 0.08, Hh * 0.08, Hh * 0.1, 14); f.rotateZ(Math.PI / 2); f.rotateY(-s * 0.6); f.translate(s * Hh * 0.2, my - Hh * 0.05, mz - Hh * 0.04); g.push(paint(f, C('#4a4e5e'))); const l = new THREE.TorusGeometry(Hh * 0.06, Hh * 0.012, 4, 14); l.rotateY(Math.PI / 2 - s * 0.6); l.translate(s * Hh * 0.255, my - Hh * 0.05, mz - Hh * 0.01); gl.push(paint(l, C(spec.acc.glow))); }
      const strap = new THREE.TorusGeometry(1, Hh * 0.02, 4, 28); strap.rotateX(Math.PI / 2); strap.scale(this.S.hx + Hh * 0.03, 1, this.headR0(0.25, Math.PI) * 0.55 + this.headR0(0.25, 0) * 0.55); strap.translate(0, my + Hh * 0.04, S.cz); g.push(paint(strap, C('#1a1a22')));
      this.rigidOn('head', g, this.mat); this.rigidOn('head', gl, this.glowMat);
    }
  }
  private headR0(yc: number, phi: number): number { const S = this.S, fy = Math.round(Math.min(1, Math.max(0, yc)) * (S.NY - 1)), a = Math.floor(((phi + Math.PI) / (Math.PI * 2)) * S.NA) % S.NA; return S.prof[fy * S.NA + a]; }

  /** face paint / marks drawn straight onto the face as a thin skin-tight layer */
  private paint(spec: CharacterSpec): void {
    const k = spec.acc.paint; if (!k) return;
    const col = k === 1 ? C('#c8283c') : k === 2 ? C('#14141c') : k === 3 ? C(spec.acc.glow) : k === 4 ? C('#ff6a9a') : C('#d0283c');
    const inside = (h: { yc: number; zf: number; xs: number }) => {
      if (h.zf < 0.55) return false;
      if (k === 1) return h.xs > 0.3 && h.xs < 0.85 && ((h.yc > 0.27 && h.yc < 0.31) || (h.yc > 0.34 && h.yc < 0.38));
      if (k === 2) return h.xs > 0.28 && h.xs < 0.44 && h.yc > 0.14 && h.yc < 0.4;
      if (k === 3) return (h.xs > 0.62 && h.xs < 0.7 && h.yc > 0.3 && h.yc < 0.62) || (h.xs > 0.4 && h.xs < 0.7 && h.yc > 0.28 && h.yc < 0.31);
      if (k === 4) return Math.hypot(h.xs - 0.55, (h.yc - 0.3) * 1.3) < 0.1;
      return h.xs > 0.35 && h.xs < 0.8 && [0.24, 0.29, 0.34].some((y) => Math.abs(h.yc - y - (h.xs - 0.35) * 0.08) < 0.014);
    };
    this.wrap((I, i) => I.reg[i] === R.Head && inside(this.hc(I.pos, i)), () => 0.00004, () => col);
  }

  private neckwear(spec: CharacterSpec): void {
    const k = spec.acc.neck; if (!k) return;
    const F = this.F, Hh = F.head.y1 - F.head.y0, m = C(spec.acc.metal), g: THREE.BufferGeometry[] = [];
    const yN = F.neckY - 0.1 * Hh, sl = this.slice(yN, 0.05 * Hh);
    if (k === 3) { const yc = F.neckY + 0.22 * Hh, s2 = this.slice(yc, 0.04 * Hh), t = new THREE.TorusGeometry(1, Hh * 0.04, 6, 32); t.rotateX(Math.PI / 2); t.scale(s2.rx * 1.08, 1, s2.rz * 1.08); t.translate(0, yc, s2.cz); g.push(paint(t, C(spec.acc.color))); const gem = new THREE.OctahedronGeometry(Hh * 0.04); gem.translate(0, yc - Hh * 0.04, s2.cz + s2.rz * 1.1); g.push(paint(gem, m)); this.rigidOn('neck01', g, this.mat); return; }
    if (k === 6) { // scarf: thick wrap and a tail hanging in front
      const t = new THREE.TorusGeometry(1, Hh * 0.13, 8, 28); t.rotateX(Math.PI / 2); t.scale(sl.rx * 1.25, 1, sl.rz * 1.3); t.translate(0, yN + 0.05 * Hh, sl.cz); g.push(paint(t, C(spec.acc.color)));
      const x = sl.rx * 0.4, pts: THREE.Vector3[] = [];
      for (let j = 0; j <= 5; j++) { const y = yN - j * 0.32 * Hh; pts.push(new THREE.Vector3(x + j * 0.01 * Hh, y, this.probeZ(x, y, true, 0.002, 0.0015) + Hh * 0.07)); }
      const tail = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, Hh * 0.09, 6); tail.scale(1, 1, 1); g.push(paint(tail, C(spec.acc.color).multiplyScalar(0.9)));
      this.rigidOn('spine01', g, this.mat); return;
    }
    // chains drape around the neck base and dip down the chest
    const dip = k === 4 ? 0.9 : k === 2 || k === 5 ? 1.0 : 0.6, pts: THREE.Vector3[] = [];
    for (let j = 0; j < 40; j++) {
      const a = (j / 40) * Math.PI * 2, cf = Math.max(0, Math.cos(a)), y = yN - dip * Hh * cf ** 2;
      let z = sl.cz + Math.cos(a) * sl.rz * 1.12; const x = Math.sin(a) * sl.rx * (1.12 - 0.25 * cf ** 2);
      if (Math.cos(a) > 0.2) z = Math.max(z, this.probeZ(x, y, true, 0.0015, 0.0012) + Hh * 0.025);
      else if (Math.cos(a) < -0.2) z = Math.min(z, this.probeZ(x, y, false, 0.0015, 0.0012) - Hh * 0.02);
      pts.push(new THREE.Vector3(x, y, z));
    }
    if (k === 4) pts.forEach((p, j) => { const b = new THREE.SphereGeometry(Hh * 0.038, 6, 5); b.translate(p.x, p.y, p.z); g.push(paint(b, j % 4 ? C('#6e4a2a') : C('#c8283c'))); });
    else g.push(paint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 80, Hh * (k === 1 ? 0.016 : 0.01), 5, true), m));
    const front = pts[0];
    if (k === 2) { const p = new THREE.OctahedronGeometry(Hh * 0.08); p.scale(0.8, 1.2, 0.4); p.translate(front.x, front.y - Hh * 0.09, front.z + Hh * 0.02); g.push(paint(p, C(spec.acc.glow))); }
    if (k === 5) for (const s of [-1, 1]) { const t = new THREE.BoxGeometry(Hh * 0.11, Hh * 0.17, Hh * 0.012); t.rotateZ(s * 0.15); t.translate(front.x + s * Hh * 0.04, front.y - Hh * 0.1, front.z + Hh * 0.02 + s * 0.0001); g.push(paint(t, C('#c8c8d8'))); }
    this.rigidOn('spine01', g, this.mat);
  }

  private wristwear(spec: CharacterSpec): void {
    const k = spec.acc.wrist; if (!k) return;
    const F = this.F, Hh = F.head.y1 - F.head.y0;
    for (const side of k === 1 ? ['L'] : ['L', 'R']) {
      const w = this.bones.get('wrist_' + side), e = this.bones.get('lowerarm01_' + side); if (!w || !e) continue;
      const ax = w.clone().sub(e).normalize(), c = w.clone().addScaledVector(ax, -Hh * 0.22);
      let r = 0; for (const I of this.infos) for (let i = 0; i < I.n; i++) { if (I.reg[i] !== R.Arm && I.reg[i] !== R.Hand) continue; const p = new THREE.Vector3(I.pos.getX(i), I.pos.getY(i), I.pos.getZ(i)).sub(c); const along = p.dot(ax); if (Math.abs(along) > Hh * 0.06) continue; r = Math.max(r, p.addScaledVector(ax, -along).length()); }
      r = r || Hh * 0.13;
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), ax), g: THREE.BufferGeometry[] = [], gl: THREE.BufferGeometry[] = [];
      const ring = (rad: number, th: number, off: number, col: THREE.Color, glow = false) => { const t = new THREE.TorusGeometry(rad, th, 5, 20); t.translate(0, 0, off); t.applyQuaternion(q); t.translate(c.x, c.y, c.z); (glow ? gl : g).push(paint(t, col)); };
      if (k === 1) { ring(r * 1.08, Hh * 0.03, 0, C('#1a1a22')); const face = new THREE.CylinderGeometry(Hh * 0.07, Hh * 0.07, Hh * 0.035, 14); face.translate(0, r * 1.1, 0); face.applyQuaternion(q); face.translate(c.x, c.y, c.z); g.push(paint(face, C(spec.acc.metal))); }
      if (k === 2) for (let j = 0; j < 3; j++) ring(r * 1.12, Hh * 0.012, (j - 1) * Hh * 0.04, j === 1 ? C(spec.acc.metal) : C(spec.acc.color));
      if (k === 3) { const cy = new THREE.CylinderGeometry(r * 1.1, r * 1.12, Hh * 0.14, 18, 1, true); cy.rotateX(Math.PI / 2); cy.applyQuaternion(q); cy.translate(c.x, c.y, c.z); g.push(paint(cy, C('#2a2c36'))); ring(r * 1.13, Hh * 0.01, Hh * 0.05, C(spec.acc.glow), true); ring(r * 1.13, Hh * 0.01, -Hh * 0.05, C(spec.acc.glow), true); }
      if (k === 4) for (let j = 0; j < 14; j++) { const a = (j / 14) * Math.PI * 2, b = new THREE.SphereGeometry(Hh * 0.028, 6, 5); b.translate(Math.cos(a) * r * 1.12, Math.sin(a) * r * 1.12, 0); b.applyQuaternion(q); b.translate(c.x, c.y, c.z); g.push(paint(b, j === 0 ? C('#c8283c') : C('#6e4a2a'))); }
      if (g.length) this.rigidOn('lowerarm01_' + side, g, this.mat);
      if (gl.length) this.rigidOn('lowerarm01_' + side, gl, this.glowMat);
    }
  }

  private backwear(spec: CharacterSpec): void {
    const k = spec.acc.back; if (!k) return;
    const F = this.F, Hh = F.head.y1 - F.head.y0, col = C(spec.acc.color), dk = col.clone().multiplyScalar(0.6), g: THREE.BufferGeometry[] = [], gl: THREE.BufferGeometry[] = [];
    const yC = F.chestY, bz = this.probeZ(0, yC, false, 0.003, 0.002), shY = this.probeTop(F.head.x * 0.9), sx = F.head.x * 0.85;
    const strap = (x: number, yTop: number, yBot: number) => {
      const pts = [new THREE.Vector3(x, yTop, bz - Hh * 0.05), new THREE.Vector3(x, shY + Hh * 0.05, (bz + this.probeZ(x, shY - Hh * 0.2, true, 0.0015, 0.002)) / 2)];
      for (let j = 1; j <= 3; j++) { const y = shY - j * (shY - yBot) / 3; pts.push(new THREE.Vector3(x * (1 - 0.1 * j), y, this.probeZ(x * (1 - 0.1 * j), y, true, 0.0015, 0.0012) + Hh * 0.03)); }
      g.push(paint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, Hh * 0.035, 4), dk));
    };
    if (k === 1) {
      const w = F.head.x * 2.1, h = Hh * 1.55, d = Hh * 0.55, box = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
      const p = box.getAttribute('position') as THREE.BufferAttribute; for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); const s = 1 - 0.12 * (Math.abs(x) / (w / 2)) * (Math.abs(y) / (h / 2)); p.setXYZ(i, x * s, y, z * (1 - 0.2 * Math.abs(y) / (h / 2))); }
      box.computeVertexNormals(); box.translate(0, yC - Hh * 0.2, bz - d / 2 - Hh * 0.02); g.push(paint(box, col));
      const pocket = new THREE.BoxGeometry(w * 0.7, h * 0.4, d * 0.35); pocket.translate(0, yC - Hh * 0.55, bz - d - Hh * 0.08); g.push(paint(pocket, dk));
      for (const s of [-1, 1]) strap(s * sx, yC + h * 0.35 - Hh * 0.2, yC - Hh * 0.6);
    }
    if (k === 2) { // sling bag: diagonal strap from the left shoulder to a bag on the right hip
      const pts: THREE.Vector3[] = [], y0 = shY + Hh * 0.04, y1 = F.waistY - Hh * 0.2;
      for (let j = 0; j <= 6; j++) { const t = j / 6, x = sx - t * sx * 2.1, y = y0 - t * (y0 - y1); pts.push(new THREE.Vector3(x, y, this.probeZ(x, y, true, 0.0018, 0.0015) + Hh * 0.04)); }
      g.push(paint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, Hh * 0.03, 4), dk));
      const end = pts[pts.length - 1], bag = new THREE.BoxGeometry(Hh * 0.6, Hh * 0.45, Hh * 0.22); bag.translate(end.x - Hh * 0.1, end.y - Hh * 0.2, end.z - Hh * 0.05); g.push(paint(bag, col));
      this.rigidOn('spine01', g, this.mat); return;
    }
    if (k === 3) { const y = F.waistY - Hh * 0.35, x = -F.head.x * 1.3, z = this.probeZ(x, y, true, 0.003, 0.002), b = new THREE.BoxGeometry(Hh * 0.5, Hh * 0.38, Hh * 0.22); b.rotateY(-0.5); b.translate(x, y, z - Hh * 0.15); g.push(paint(b, col)); const belt = this.slice(y, 0.0008), t = new THREE.TorusGeometry(1, Hh * 0.03, 4, 32); t.rotateX(Math.PI / 2); t.scale(belt.rx * 1.06, 1, belt.rz * 1.1); t.translate(0, y + Hh * 0.05, belt.cz); g.push(paint(t, dk)); this.rigidOn('spine05', g, this.mat); return; }
    if (k === 4) { // jetpack
      for (const s of [-1, 1]) { const c = new THREE.CylinderGeometry(Hh * 0.22, Hh * 0.22, Hh * 1.3, 14); c.translate(s * Hh * 0.27, yC - Hh * 0.2, bz - Hh * 0.3); g.push(paint(c, C('#c8c8d8'))); const n = new THREE.CylinderGeometry(Hh * 0.13, Hh * 0.2, Hh * 0.22, 12); n.translate(s * Hh * 0.27, yC - Hh * 0.96, bz - Hh * 0.3); g.push(paint(n, C('#2a2c36'))); const f = new THREE.CircleGeometry(Hh * 0.12, 12); f.rotateX(Math.PI / 2); f.translate(s * Hh * 0.27, yC - Hh * 1.08, bz - Hh * 0.3); gl.push(paint(f, C(spec.acc.glow))); }
      const plate = new THREE.BoxGeometry(Hh * 0.4, Hh * 1.0, Hh * 0.1); plate.translate(0, yC - Hh * 0.2, bz - Hh * 0.08); g.push(paint(plate, col));
      for (const s of [-1, 1]) strap(s * sx, yC + Hh * 0.4, yC - Hh * 0.5);
    }
    if (k === 5) { // cape hanging from the shoulders
      const top = shY + Hh * 0.02, bot = F.hipY - Hh * 2.6, NX = 14, NYc = 12, pos: number[] = [], idx: number[] = [];
      for (let j = 0; j <= NYc; j++) for (let i = 0; i <= NX; i++) {
        const u = i / NX - 0.5, t = j / NYc, y = top - t * (top - bot), wid = F.head.x * (2.5 + 1.5 * t), x = u * wid;
        const zb = y > F.hipY ? this.probeZ(x * 0.7, y, false, 0.003, 0.002) : this.probeZ(0, F.hipY + 0.001, false, 0.004, 0.002);
        pos.push(x, y, (zb || bz) - Hh * (0.06 + 0.5 * t * t) + Hh * 0.04 * Math.sin(u * 12) * t);
      }
      for (let j = 0; j < NYc; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b = a + NX + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
      const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); cg.setIndex(idx); cg.computeVertexNormals(); g.push(paint(cg, col));
      const clasp = new THREE.TorusGeometry(Hh * 0.06, Hh * 0.02, 5, 12); clasp.translate(0, top - Hh * 0.25, this.probeZ(0, top - Hh * 0.25, true, 0.002, 0.0015) + Hh * 0.03); g.push(paint(clasp, C(spec.acc.metal)));
    }
    if (g.length) this.rigidOn('spine01', g, this.mat);
    if (gl.length) this.rigidOn('spine01', gl, this.glowMat);
  }

  private beard(spec: CharacterSpec): void {
    const b = spec.face.beard ?? 0; if (!b) return;
    const col = C(spec.hair.color), stub = mixC(C(spec.skin), col, 0.55);
    const lips = (h: { yc: number; zf: number; xs: number }) => h.xs < 0.24 && h.yc > 0.12 && h.yc < 0.2 && h.zf > 0.8;
    this.wrap((I, i) => {
      if (I.reg[i] !== R.Head && I.reg[i] !== R.Neck) return false;
      const h = this.hc(I.pos, i);
      if (I.reg[i] === R.Neck) return b === 3 && I.pos.getZ(i) > 0.0015 && I.pos.getY(i) > this.F.neckY + 0.0008;
      if (lips(h)) return false;
      if (b === 1 || b === 3) return h.yc < 0.33 && h.zf > 0.38 && !(h.yc > 0.26 && h.xs < 0.3);
      if (b === 2) return h.yc < 0.2 && h.xs < 0.32 && h.zf > 0.6;
      return h.yc > 0.19 && h.yc < 0.27 && h.xs < 0.34 && h.zf > 0.78;                    // moustache
    }, () => (b === 1 ? 0.00006 : 0.00032), (_I, _i, e) => (b === 1 ? stub : col.clone().multiplyScalar(e ? 0.85 : 1)));
  }

  /** glasses on the head bone */
  glasses(kind: number, glow = '#45ecff'): void {
    if (!kind) return;
    if (kind >= 4) { const h = glassesGeos(this.S, kind, glow); if (h.geos.length) this.rigidOn('head', h.geos, this.mat); if (h.glow.length) this.rigidOn('head', h.glow, this.glowMat); return; }
    const H = this.F.head, ey = H.y0 + (H.y1 - H.y0) * 0.42, z = H.z1 - 0.0004, ex = 0.0024, g: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      const ring = kind === 2 ? new THREE.TorusGeometry(0.0019, 0.00022, 4, 4) : new THREE.TorusGeometry(0.0018, 0.0002, 6, 18);
      if (kind === 2) ring.rotateZ(Math.PI / 4);
      ring.translate(s * ex, ey, z); g.push(ring);
      const arm = new THREE.BoxGeometry(0.0002, 0.0002, 0.0075); arm.translate(s * (H.x - 0.0002), ey + 0.0004, z - 0.0038); g.push(arm);
    }
    const bridge = new THREE.BoxGeometry(0.0012, 0.00022, 0.0002); bridge.translate(0, ey + 0.0006, z); g.push(bridge);
    this.rigid(g, C('#1a1a22'));
    if (kind === 3) { const lens: THREE.BufferGeometry[] = []; for (const s of [-1, 1]) { const c = new THREE.CircleGeometry(0.0018, 18); c.translate(s * ex, ey, z + 0.0001); lens.push(c); } this.rigid(lens, C('#101018'), true); }
  }

  /** rigid pieces (vertex coloured, bind space) carried by a bone */
  private rigidOn(boneName: string, geos: THREE.BufferGeometry[], mat: THREE.Material): void {
    const bone = this.model.getObjectByName(boneName); if (!bone || !geos.length) return;
    this.model.updateMatrixWorld(true);
    const toBone = new THREE.Matrix4().copy(bone.matrixWorld).invert().multiply(this.bodies[0].matrixWorld);
    // one draw call per call: everything merged into a single geometry
    const parts = geos.map((g) => { if (g.getAttribute('uv')) g.deleteAttribute('uv'); const n = g.index ? g.toNonIndexed() : g; if (!n.getAttribute('normal')) n.computeVertexNormals(); if (n !== g) g.dispose(); return n; });
    const merged = mergeGeometries(parts, false); parts.forEach((g) => g.dispose());
    for (const g of merged ? [merged] : []) {
      const m = new THREE.Mesh(g, mat); m.castShadow = mat !== this.glowMat; m.frustumCulled = false;
      toBone.decompose(m.position, m.quaternion, m.scale);
      bone.add(m); this.made.push(m); this.owned.push(g);
    }
  }

  private rigid(geos: THREE.BufferGeometry[], color: THREE.Color, glossy = false): void {
    const head = this.model.getObjectByName('head'); if (!head) return;
    const mat = glossy ? new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }) : new THREE.MeshToonMaterial({ color, side: THREE.DoubleSide });
    this.owned.push(mat);
    this.model.updateMatrixWorld(true);
    const toHead = new THREE.Matrix4().copy(head.matrixWorld).invert().multiply(this.bodies[0].matrixWorld);
    for (const g of geos) {
      const m = new THREE.Mesh(g, mat); m.castShadow = true;
      toHead.decompose(m.position, m.quaternion, m.scale);
      head.add(m); this.made.push(m); this.owned.push(g);
    }
  }
}
