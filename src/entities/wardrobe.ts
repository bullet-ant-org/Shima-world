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
import type { CharacterSpec } from './character';

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
export const BASE_HAIR = ['Long (original)', 'Short Crop', 'Buzz', 'Bob', 'Spiky', 'Ponytail', 'Man Bun', 'Bald'];

const enum R { Head, Neck, Torso, Arm, Hand, Hips, Leg, Foot }
const region = (n: string): R =>
  /^(finger|metacarpal|wrist)/.test(n) ? R.Hand : /^(upperarm|lowerarm)/.test(n) ? R.Arm : /^(shoulder|clavicle|spine|breast)/.test(n) ? R.Torso
    : /^pelvis/.test(n) ? R.Hips : /^(upperleg|lowerleg)/.test(n) ? R.Leg : /^(foot|toe)/.test(n) ? R.Foot : /^neck01/.test(n) ? R.Neck : R.Head;

/** per-vertex facts about one body mesh, in its bind space (model units, ~0.124 tall) */
interface Info { mesh: THREE.SkinnedMesh; n: number; reg: Uint8Array; armT: Float32Array; legT: Float32Array; pos: THREE.BufferAttribute; nor: THREE.BufferAttribute; /** welded id: UV-seam duplicates share one */ wid: Int32Array; /** normal averaged over welded duplicates */ wn: Float32Array }
interface Frame { neckY: number; waistY: number; hipY: number; chestY: number; head: { x: number; y0: number; y1: number; z0: number; z1: number } }

const C = (h: string) => new THREE.Color(h);
const mixC = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, t);

export class Dresser {
  private infos: Info[] = [];
  /** welded position ids shared by all body meshes (the briefs patch meets the body along a seam) */
  private weld = new Map<string, number>(); private weldN: number[] = []; private weldP: number[] = [];
  private F!: Frame;
  private mat: THREE.MeshToonMaterial;
  private bones = new Map<string, THREE.Vector3>();
  readonly made: THREE.Object3D[] = [];

  constructor(private model: THREE.Object3D, private bodies: THREE.SkinnedMesh[], ramp: THREE.Texture, private owned: { dispose(): void }[]) {
    this.mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp, side: THREE.DoubleSide });
    owned.push(this.mat);
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
  }

  /** head-normalised coordinates: yc 0 chin .. 1 crown, zf 0 back .. 1 nose, xs 0 centre .. 1 side */
  private hc(p: THREE.BufferAttribute, i: number) {
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
    const hcol = (I: Info, i: number, e: boolean) => { const h = this.hc(I.pos, i); const c = mixC(col, tip, Math.max(0, 0.6 - h.yc) * 0.6); return e ? c.multiplyScalar(0.8) : c.multiplyScalar(0.92 + 0.08 * Math.sin(I.pos.getX(i) * 3000)); };
    const scalp = (I: Info, i: number, fringe: number, nape: number) => {
      if (I.reg[i] !== R.Head) return false;
      const h = this.hc(I.pos, i);
      if (h.yc > 0.66) return true;
      if (h.zf < 0.4 && h.yc > nape) return true;                                         // back of the head
      if (h.xs > 0.82 && h.zf < 0.62 && h.yc > 0.52) return true;                          // above the ears
      if (fringe && h.zf > 0.6 && h.yc > 0.66 - fringe && h.xs < 0.75) return true;        // fringe over the forehead
      return false;
    };
    if (st === 1 || st === 4 || st === 5 || st === 6) this.wrap((I, i) => scalp(I, i, st === 1 ? 0.1 : 0.04, 0.22), (I, i) => 0.00055 + 0.0005 * Math.max(0, this.hc(I.pos, i).yc - 0.6), hcol);
    if (st === 2) this.wrap((I, i) => scalp(I, i, 0, 0.26), () => 0.00012, (I, i, e) => mixC(C(spec.skin), col, 0.75).multiplyScalar(e ? 0.95 : 1));
    if (st === 3) this.wrap((I, i) => {
      if (I.reg[i] !== R.Head && I.reg[i] !== R.Neck) return false;
      const h = this.hc(I.pos, i);
      return h.yc > 0.56 || (h.zf < 0.5 && h.yc > 0.02) || (h.xs > 0.78 && h.zf < 0.66 && h.yc > 0.1);
    }, (I, i) => 0.0007 + 0.0011 * Math.max(0, 0.7 - this.hc(I.pos, i).yc), hcol);
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
  glasses(kind: number): void {
    if (!kind) return;
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
