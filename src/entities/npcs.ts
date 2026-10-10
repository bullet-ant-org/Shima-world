/**
 * Townsfolk: articulated, instanced NPCs with roles and daily routines.
 *
 *  - Bodies: three low-poly character models (man, woman, farmer with a straw kasa). Every vertex knows which body part
 *    it belongs to; per-instance joint angles (hips, knees, shoulders, elbows, spine, head) are uploaded each frame and
 *    applied in the vertex stage, so the whole crowd animates with real limbs in three draw calls.
 *  - Clothes, skin and hair are tinted per instance, so no two people look alike.
 *  - Where people are comes from the map: vendors stand behind market stalls, farmers work the fields and rice paddies,
 *    people sit on benches, browse shop fronts, pray at shrines and temples, chat outside houses and office towers, and a
 *    crowd dances outside the clubs at night. Commuters walk the sidewalks (and cross at junctions); villagers walk the
 *    stone paths.
 *  - Everything follows the clock: the morning and evening rush, market hours, farmers heading home at dusk, nightlife.
 *    When a routine ends near the player the person gets up and walks away instead of vanishing.
 */
import * as THREE from 'three/webgpu';
import { abs, attribute, cos, float, positionLocal, sin, step, vec3 } from 'three/tsl';
import { loft, keys } from './sculpt';
import { heightAt, mulberry32, RICE } from '../world/terrain';
import { BUILDINGS, NET, PROPS, inCity } from '../world/layout';
import type { Path } from '../world/paths';

// ---------------------------------------------------------------------------------------------------------------------
// bodies
// ---------------------------------------------------------------------------------------------------------------------
// parts: 0 chest, 1 head, 2/3 left upper/fore arm, 4/5 right upper/fore arm, 6/7 left thigh/shin, 8/9 right thigh/shin, 10 hips
// regions: 0 fixed (vertex colour), 1 skin, 2 top, 3 bottom, 4 hair
const HIP_Y = 0.86, KNEE_Y = 0.47, SH_Y = 1.38, EL_Y = 1.11, WAIST_Y = 0.98;

class Builder {
  pos: number[] = []; nor: number[] = []; col: number[] = []; part: number[] = []; reg: number[] = []; idx: number[] = [];
  private c = new THREE.Color();
  add(g: THREE.BufferGeometry, part: number, reg: number, color = 0xffffff, m?: THREE.Matrix4): void {
    if (m) g.applyMatrix4(m);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const P = g.getAttribute('position'), N = g.getAttribute('normal'), base = this.pos.length / 3;
    this.c.setHex(color);
    for (let i = 0; i < P.count; i++) {
      this.pos.push(P.getX(i), P.getY(i), P.getZ(i)); this.nor.push(N.getX(i), N.getY(i), N.getZ(i));
      this.col.push(this.c.r, this.c.g, this.c.b); this.part.push(part); this.reg.push(reg);
    }
    const I = g.getIndex();
    if (I) for (let i = 0; i < I.count; i++) this.idx.push(base + I.getX(i));
    else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
    g.dispose();
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('part', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('reg', new THREE.Float32BufferAttribute(this.reg, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const M = new THREE.Matrix4();
const at = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => M.makeScale(sx, sy, sz).setPosition(x, y, z);
const ball = (seg = 10, rows = 8) => new THREE.SphereGeometry(1, seg, rows);
/** tapered limb between two heights (vertical, centred on x/z) */
const limb = (x: number, y0: number, y1: number, r0: number, r1: number, z = 0, seg = 8) => { const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, seg, 2, true); g.translate(x, (y0 + y1) / 2, z); return g; };

/** variant 0: man, 1: woman, 2: farmer (man in a straw kasa) */
function bodyGeo(v: number): { geo: THREE.BufferGeometry; sx: number } {
  const B = new Builder(), fem = v === 1, SX = fem ? 0.175 : 0.2, LX = fem ? 0.08 : 0.088;
  // hips / pelvis (static) and chest (bends at the waist)
  const pr = keys([[0, 0.12], [0.35, fem ? 0.158 : 0.15], [1, fem ? 0.125 : 0.135]]);
  B.add(loft({ path: [[0, 0.78, 0], [0, 0.9, 0], [0, 1.0, 0]], steps: 6, seg: 12, r: (t) => [pr(t), pr(t) * 0.72], color: 0xffffff, capStart: true }), 10, 3);
  const cr = keys(fem ? [[0, 0.122], [0.25, 0.118], [0.6, 0.145], [0.86, 0.16], [1, 0.07]] : [[0, 0.135], [0.3, 0.14], [0.65, 0.165], [0.88, 0.185], [1, 0.07]]);
  B.add(loft({
    path: [[0, 0.96, 0], [0, 1.2, 0.004], [0, 1.44, 0]], steps: 10, seg: 14, color: 0xffffff,
    r: (t) => [cr(t), cr(t) * (fem ? 0.68 : 0.62)],
    shape: fem ? (t, a) => 1 + 0.22 * Math.exp(-(((t - 0.58) / 0.12) ** 2)) * Math.pow(Math.max(0, Math.sin(a)), 3) * Math.abs(Math.cos(a * 2 - Math.PI)) : undefined,
  }), 0, 2);
  // neck and head
  B.add(limb(0, 1.38, 1.53, 0.045, 0.04), 0, 1);
  B.add(ball(14, 12), 1, 1, 0xffffff, at(0, 1.635, 0.005, 0.122, 0.14, 0.13));
  B.add(ball(8, 6), 1, 1, 0xffffff, at(0, 1.565, 0.06, 0.07, 0.05, 0.07));                 // jaw / chin
  for (const s of [-1, 1]) {
    B.add(ball(8, 6), 1, 0, 0x2a1d2c, at(s * 0.045, 1.622, 0.118, 0.022, 0.03, 0.012));     // eyes
    B.add(ball(6, 4), 1, 0, 0xffffff, at(s * 0.045 + 0.007, 1.632, 0.128, 0.007, 0.009, 0.004));
    B.add(ball(6, 5), 1, 1, 0xffffff, at(s * 0.124, 1.62, 0.0, 0.02, 0.03, 0.02));          // ears
    B.add(ball(6, 4), 1, 4, 0xffffff, at(s * 0.045, 1.67, 0.116, 0.03, 0.006, 0.008));       // brows
  }
  B.add(ball(6, 4), 1, 0, 0xc0606a, at(0, 1.565, 0.12, 0.016, 0.005, 0.006));                // mouth
  // hair: top cap + back; the woman's falls to the shoulders, the farmer's is cropped under the hat
  B.add(new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, 1.25), 1, 4, 0xffffff, at(0, 1.645, -0.004, 0.134, 0.152, 0.142));
  B.add(new THREE.SphereGeometry(1, 12, 8, Math.PI, Math.PI, 0, 2.3), 1, 4, 0xffffff, at(0, 1.64, -0.01, 0.136, 0.15, 0.142));
  if (fem) {
    B.add(loft({ path: [[0, 1.66, -0.06], [0, 1.45, -0.09], [0, 1.27, -0.08]], steps: 8, seg: 10, up: [0, 0, 1], r: (t) => [0.13 - 0.03 * t, 0.06 - 0.02 * t], color: 0xffffff, capEnd: true }), 1, 4);
    for (const s of [-1, 1]) B.add(loft({ path: [[s * 0.11, 1.66, 0.06], [s * 0.125, 1.52, 0.05], [s * 0.115, 1.42, 0.03]], steps: 6, seg: 8, r: (t) => 0.03 - 0.012 * t, color: 0xffffff, capEnd: true }), 1, 4);
  } else B.add(ball(10, 6), 1, 4, 0xffffff, at(0, 1.72, 0.07, 0.11, 0.05, 0.07));             // fringe
  if (v === 2) {
    const hat = new THREE.ConeGeometry(0.34, 0.17, 16, 1, true); hat.translate(0, 1.84, 0); B.add(hat, 1, 0, 0xd9b870);
    const brim = new THREE.ConeGeometry(0.34, 0.17, 16, 1, true); brim.rotateX(Math.PI); brim.scale(1, 0.05, 1); brim.translate(0, 1.76, 0); B.add(brim, 1, 0, 0xb89850);
  }
  // arms (left = +x): shoulder ball + sleeve in the top colour, forearm and hand in skin
  for (const [s, up, fore] of [[1, 2, 3], [-1, 4, 5]] as [number, number, number][]) {
    const x = s * SX;
    B.add(ball(8, 6), up, 2, 0xffffff, at(x, SH_Y, 0, 0.058, 0.06, 0.058));
    B.add(limb(x, EL_Y + 0.12, SH_Y, 0.045, 0.05), up, 2);
    B.add(limb(x, EL_Y - 0.02, EL_Y + 0.14, 0.039, 0.043), up, 1);
    B.add(limb(x, 0.86, EL_Y + 0.01, 0.031, 0.039), fore, 1);
    B.add(ball(8, 6), fore, 1, 0xffffff, at(x, 0.83, 0.008, 0.035, 0.045, 0.03));
  }
  // legs: trousers (man / farmer) or bare legs with socks (woman), shoes
  for (const [s, th, sh] of [[1, 6, 7], [-1, 8, 9]] as [number, number, number][]) {
    const x = s * LX;
    B.add(limb(x, KNEE_Y, HIP_Y + 0.02, fem ? 0.05 : 0.06, fem ? 0.068 : 0.075), th, fem ? 1 : 3);
    B.add(ball(8, 6), sh, fem ? 1 : 3, 0xffffff, at(x, KNEE_Y, 0, fem ? 0.05 : 0.058, 0.05, 0.055));
    B.add(limb(x, 0.08, KNEE_Y, fem ? 0.034 : 0.045, fem ? 0.048 : 0.055), sh, fem ? 1 : 3);
    if (fem) B.add(limb(x, 0.07, 0.3, 0.037, 0.042), sh, 0, 0xf2f0ea);                     // knee socks
    B.add(ball(8, 6), sh, 0, v === 2 ? 0x4a3826 : fem ? 0x3a2a2a : 0x2a2a33, at(x, 0.045, 0.035, 0.05, 0.045, 0.11));
  }
  if (fem) { // pleated skirt flaring from the waist
    const sk = new THREE.CylinderGeometry(0.135, 0.22, 0.34, 16, 2, true); sk.translate(0, 0.84, 0); B.add(sk, 10, 3);
    const ski = new THREE.CylinderGeometry(0.133, 0.218, 0.34, 16, 2, true); ski.translate(0, 0.84, 0); ski.index && ski.setIndex(Array.from(ski.index.array).reverse()); B.add(ski, 10, 3);
  }
  return { geo: B.geometry(), sx: SX };
}

function bodyMaterial(ramp: THREE.Texture, SX: number): THREE.MeshToonNodeMaterial {
  const mat = new THREE.MeshToonNodeMaterial({ gradientMap: ramp });
  const part = attribute('part', 'float'), reg = attribute('reg', 'float');
  const jA = attribute('jA', 'vec4'), jB = attribute('jB', 'vec4'), jC = attribute('jC', 'vec4');
  const is = (k: number) => float(1).sub(step(0.5, abs(part.sub(k))));
  const rg = (k: number) => float(1).sub(step(0.5, abs(reg.sub(k))));
  type V = ReturnType<typeof vec3>;
  type F = ReturnType<typeof float>;
  const rotX = (p: V, py: number, a: F): V => { const c = cos(a), s = sin(a), y = p.y.sub(py), z = p.z; return vec3(p.x, y.mul(c).sub(z.mul(s)).add(py), y.mul(s).add(z.mul(c))); };
  const rotZ = (p: V, px: number, py: number, a: F): V => { const c = cos(a), s = sin(a), x = p.x.sub(px), y = p.y.sub(py); return vec3(x.mul(c).sub(y.mul(s)).add(px), x.mul(s).add(y.mul(c)).add(py), p.z); };
  const rotY = (p: V, a: F): V => { const c = cos(a), s = sin(a); return vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.x.mul(s).negate().add(p.z.mul(c))); };
  const armL = is(2).add(is(3)), armR = is(4).add(is(5));
  let p = vec3(positionLocal) as unknown as V;
  p = rotX(p, EL_Y, is(3).mul(jB.y).add(is(5).mul(jB.w)));
  p = rotX(p, SH_Y, armL.mul(jB.x).add(armR.mul(jB.z)));
  p = rotZ(p, SX, SH_Y, armL.mul(jC.x));
  p = rotZ(p, -SX, SH_Y, armR.mul(jC.y).negate());
  p = rotY(p, is(1).mul(jC.w));
  p = rotX(p, WAIST_Y, is(0).add(is(1)).add(armL).add(armR).mul(jC.z));
  p = rotX(p, KNEE_Y, is(7).mul(jA.y).add(is(9).mul(jA.w)));
  p = rotX(p, HIP_Y, is(6).add(is(7)).mul(jA.x).add(is(8).add(is(9)).mul(jA.z)));
  mat.positionNode = p;
  const tint = vec3(1, 1, 1).mul(rg(0)).add(attribute('cSkin', 'vec3').mul(rg(1))).add(attribute('cTop', 'vec3').mul(rg(2)))
    .add(attribute('cBot', 'vec3').mul(rg(3))).add(attribute('cHair', 'vec3').mul(rg(4)));
  mat.colorNode = attribute('color', 'vec3').mul(tint);
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------------
// routines
// ---------------------------------------------------------------------------------------------------------------------
const enum Act { Walk, Stand, Sit, Hoe, Plant, Pray, Dance, Talk, Vend, Browse }
interface Slot { x: number; z: number; ry: number; y0: number; act: Act; h0: number; h1: number; p: number; v: number; agent: number; seed: number }

const SKIN = [0xffe0c8, 0xf7d0b0, 0xe8b890, 0xc89070, 0x9a6a4a, 0xffd8c0].map((h) => new THREE.Color(h));
const HAIR = [0x1a1414, 0x2a1e18, 0x4a2e1e, 0x7a4a26, 0xc89a5a, 0xe8d8b8, 0x6a6a72, 0x3a2a4a, 0xd85a6a, 0x4a6ad8].map((h) => new THREE.Color(h));
const TOPS = [0xf4f0e6, 0x2b3d8f, 0xc8283c, 0x3a8a5a, 0xe8902a, 0x8f3dd1, 0x2a2f3d, 0x25a8c6, 0xf0c8d8, 0x8a6a4a, 0xd8d0b0, 0x5a6a8a].map((h) => new THREE.Color(h));
const BOTS = [0x2a2f3d, 0x3a4a6a, 0x5a4a3a, 0x1a1a22, 0x8a8070, 0x2b3d8f, 0x6a2a3a, 0x4a5a4a].map((h) => new THREE.Color(h));
const FARM_TOPS = [0x3a5a8a, 0x6a7a5a, 0xd8d0b0, 0x8a6a4a].map((h) => new THREE.Color(h));

const active = (h: number, h0: number, h1: number) => (h0 <= h1 ? h >= h0 && h < h1 : h >= h0 || h < h1);
const hsh = (a: number, b: number) => { let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return (h & 0xffff) / 0x10000; };

function buildSlots(): Slot[] {
  const S: Slot[] = [], rng = mulberry32(777);
  const put = (x: number, z: number, ry: number, act: Act, h0: number, h1: number, p = 1, v = -1, y0 = 0) => S.push({ x, z, ry, y0, act, h0, h1, p, v, agent: -1, seed: S.length });
  const local = (d: { x: number; z: number; ry: number; s?: number }, lx: number, lz: number) => { const c = Math.cos(d.ry), s = Math.sin(d.ry), k = d.s ?? 1; return [d.x + (lx * c + lz * s) * k, d.z + (-lx * s + lz * c) * k]; };
  for (const d of PROPS.bench ?? []) { const [x, z] = local(d, rng() < 0.5 ? -0.5 : 0.5, 0.12); put(x, z, d.ry, Act.Sit, 7, 22, 0.55); }
  for (let k = 0; k < 4; k++) for (const d of PROPS['stall' + k] ?? []) {
    let [x, z] = local(d, 0, -0.1); put(x, z, d.ry, Act.Vend, 6, 21, 0.95);
    [x, z] = local(d, -0.9, 2.1); put(x, z, d.ry + Math.PI, Act.Browse, 8, 20, 0.6);
    [x, z] = local(d, 1.0, 2.3); put(x, z, d.ry + Math.PI + 0.3, Act.Browse, 9, 19, 0.35);
  }
  for (let k = 0; k < 4; k++) for (const d of PROPS['field' + k] ?? []) for (let i = 0; i < 2; i++) {
    const [x, z] = local(d, (rng() - 0.5) * 11, (rng() - 0.5) * 16); put(x, z, rng() * 6.28, Act.Hoe, 6, 18, 0.85, 2, 0.32);
  }
  for (let x = RICE.x0 + 15; x < RICE.x1 - 10; x += 34) for (let z = RICE.z0 + 15; z < RICE.z1 - 10; z += 34) if (rng() < 0.6) put(x + (rng() - 0.5) * 14, z + (rng() - 0.5) * 14, rng() * 6.28, Act.Plant, 6, 17, 0.9, 2, 0.05);
  for (const d of PROPS.temple ?? []) for (let i = 0; i < 4; i++) { const [x, z] = local(d, -3 + i * 2 + (rng() - 0.5), 17 + rng() * 2); put(x, z, d.ry + Math.PI, Act.Pray, 6, 19, 0.7); }
  for (const d of PROPS.shrine ?? []) for (let i = 0; i < 2; i++) { const [x, z] = local(d, i ? 0.8 : -0.7, 4.2); put(x, z, d.ry + Math.PI, Act.Pray, 5, 20, i ? 0.4 : 0.75); }
  for (const k of ['house0', 'house1', 'house2', 'cabin0', 'cabin1', 'cabin2']) for (const d of PROPS[k] ?? []) {
    if (rng() < 0.45) { const [x, z] = local(d, -1.2, 6.5), [x2, z2] = local(d, -0.2, 6.6); put(x, z, d.ry + Math.PI / 2, Act.Talk, 8, 19, 0.6); put(x2, z2, d.ry - Math.PI / 2, Act.Talk, 8, 19, 0.6); }
    else if (rng() < 0.5) { const [x, z] = local(d, 1.5, 6); put(x, z, d.ry + rng() * 2, Act.Stand, 7, 20, 0.5); }
  }
  for (const b of BUILDINGS) {
    const d = { x: b.x, z: b.z, ry: b.ry }, t = b.spec.tpl;
    if (t === 'shop') { const [x, z] = local(d, (rng() - 0.5) * 4, b.hd + 1.6); put(x, z, b.ry + Math.PI, Act.Browse, 8, 22, 0.55); }
    else if (t === 'club') for (let i = 0; i < 7; i++) { const [x, z] = local(d, (rng() - 0.5) * 9, b.hd + 2.5 + rng() * 4); put(x, z, rng() * 6.28, Act.Dance, 20, 4, 0.85); }
    else if (t === 'market') for (let i = 0; i < 4; i++) { const [x, z] = local(d, (rng() - 0.5) * 10, b.hd + 2 + rng() * 2); put(x, z, b.ry + Math.PI + (rng() - 0.5), Act.Browse, 9, 21, 0.7); }
    else if (t === 'hq' || t === 'bank' || (t === 'office' && rng() < 0.25)) {
      const [x, z] = local(d, 2, b.hd + 3), [x2, z2] = local(d, 2.9, b.hd + 3.1);
      put(x, z, b.ry + Math.PI / 2, Act.Talk, 8, 19, 0.65); put(x2, z2, b.ry - Math.PI / 2, Act.Talk, 8, 19, 0.65);
    }
  }
  return S;
}

// ---------------------------------------------------------------------------------------------------------------------
interface Agent {
  on: boolean; v: number; k: number;            // variant mesh and instance index inside it
  slot: number; act: Act;
  x: number; z: number; y: number; yaw: number; sc: number;
  path: Path | null; i: number; s: number; dir: number; side: number; off: number; speed: number; lift: number; cool: number;
  ph: number; look: number; phone: boolean; acc: number; gx: number; gz: number; leaving: number;
}

const WALK_KINDS = ['avenue', 'street', 'stone'];

export class Townsfolk {
  readonly group = new THREE.Group();
  counts = { full: 0, reduced: 0, recycled: 0 };
  private meshes: THREE.InstancedMesh[] = [];
  private jA: THREE.InstancedBufferAttribute[] = []; private jB: THREE.InstancedBufferAttribute[] = []; private jC: THREE.InstancedBufferAttribute[] = [];
  private cols: { skin: THREE.InstancedBufferAttribute; top: THREE.InstancedBufferAttribute; bot: THREE.InstancedBufferAttribute; hair: THREE.InstancedBufferAttribute }[] = [];
  private ag: Agent[] = [];
  private free: number[][] = [[], [], []];
  private slots: Slot[];
  private grid = new Map<string, number[]>();
  private rnd = mulberry32(9001);
  private frame = 0; private scanT = 0; private hour = 12; private lastX = 1e9; private lastZ = 1e9;
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private e = new THREE.Euler(); private pv = new THREE.Vector3(); private sv = new THREE.Vector3();

  constructor(total: number, ramp: THREE.Texture) {
    const per = [Math.ceil(total * 0.42), Math.ceil(total * 0.42), Math.max(8, Math.ceil(total * 0.22))];
    for (let v = 0; v < 3; v++) {
      const { geo, sx } = bodyGeo(v), n = per[v];
      const mk = (w: number) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(n * w), w); a.setUsage(THREE.DynamicDrawUsage); return a; };
      const jA = mk(4), jB = mk(4), jC = mk(4), skin = mk(3), top = mk(3), bot = mk(3), hair = mk(3);
      geo.setAttribute('jA', jA); geo.setAttribute('jB', jB); geo.setAttribute('jC', jC);
      geo.setAttribute('cSkin', skin); geo.setAttribute('cTop', top); geo.setAttribute('cBot', bot); geo.setAttribute('cHair', hair);
      const mesh = new THREE.InstancedMesh(geo, bodyMaterial(ramp, sx), n);
      mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.m.makeScale(0, 0, 0);
      for (let k = 0; k < n; k++) {
        mesh.setMatrixAt(k, this.m);
        this.free[v].push(this.ag.length);
        this.ag.push({ on: false, v, k, slot: -1, act: Act.Walk, x: 0, z: 0, y: 0, yaw: 0, sc: 1, path: null, i: 0, s: 0, dir: 1, side: 1, off: 2, speed: 1.3, lift: 0, cool: 0, ph: 0, look: 0, phone: false, acc: 0, gx: 0, gz: 0, leaving: 0 });
      }
      this.meshes.push(mesh); this.jA.push(jA); this.jB.push(jB); this.jC.push(jC); this.cols.push({ skin, top, bot, hair });
      this.group.add(mesh);
    }
    this.slots = buildSlots();
    this.slots.forEach((s, i) => { const k = Math.floor(s.x / 64) + ',' + Math.floor(s.z / 64); (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(i); });
  }

  private dress(a: Agent): void {
    const r = this.rnd, c = this.cols[a.v], k = a.k;
    const pick = <T>(l: T[]) => l[Math.floor(r() * l.length)];
    const sk = pick(SKIN), hr = r() < 0.12 ? pick(HAIR.slice(6)) : pick(HAIR.slice(0, 6)), tp = a.v === 2 ? pick(FARM_TOPS) : pick(TOPS), bt = pick(BOTS);
    c.skin.setXYZ(k, sk.r, sk.g, sk.b); c.hair.setXYZ(k, hr.r, hr.g, hr.b); c.top.setXYZ(k, tp.r, tp.g, tp.b); c.bot.setXYZ(k, bt.r, bt.g, bt.b);
    for (const at of [c.skin, c.hair, c.top, c.bot]) at.needsUpdate = true;
    a.sc = (r() < 0.08 ? 0.72 : 0.93 + r() * 0.12) * (a.v === 1 ? 0.96 : 1);
    a.ph = r() * 100; a.phone = a.v !== 2 && r() < 0.18; a.look = 0;
  }

  private take(v: number): Agent | null {
    const id = this.free[v].pop(); if (id === undefined) return null;
    const a = this.ag[id]; a.on = true; a.slot = -1; a.leaving = 0; this.dress(a); return a;
  }
  private release(a: Agent): void {
    if (a.slot >= 0) this.slots[a.slot].agent = -1;
    a.on = false; a.slot = -1; a.path = null;
    this.m.makeScale(0, 0, 0); this.meshes[a.v].setMatrixAt(a.k, this.m);
    this.free[a.v].push(this.ag.indexOf(a));
  }

  /** put a walker on the nearest walkable path around (x, z) */
  private toPath(a: Agent, x: number, z: number, r = 40): boolean {
    const sg = NET.nearest(x, z, r, WALK_KINDS);
    if (!sg) return false;
    const p = sg.path;
    a.path = p; a.i = Math.min(sg.i, p.n - 2); a.s = p.len[a.i]; a.dir = this.rnd() < 0.5 ? 1 : -1;
    a.side = this.rnd() < 0.5 ? 1 : -1;
    a.off = p.kind === 'stone' ? (this.rnd() - 0.5) * p.width * 0.5 : p.width / 2 + 1.0 + this.rnd() * 2.2;
    a.speed = (p.kind === 'stone' ? 1.05 : 1.25) + this.rnd() * 0.45;
    a.act = Act.Walk; a.cool = 2;
    this.placeOnPath(a);
    return true;
  }

  private placeOnPath(a: Agent): void {
    const p = a.path!, i = a.i, l0 = p.len[i], l1 = p.len[i + 1], t = l1 > l0 ? (a.s - l0) / (l1 - l0) : 0;
    const cx = p.x[i] + (p.x[i + 1] - p.x[i]) * t, cz = p.z[i] + (p.z[i + 1] - p.z[i]) * t, tx = p.tx[i], tz = p.tz[i];
    a.x = cx - tz * a.side * a.off; a.z = cz + tx * a.side * a.off;
    a.yaw = Math.atan2(tx * a.dir, tz * a.dir);
    // raised sidewalks in the city, the carriageway at junction crossings
    a.lift = p.kind === 'stone' ? 0.04 : p.junc?.[i] ? 0.13 : 0.33;
  }

  private walk(a: Agent, dt: number, px: number, pz: number): void {
    const p = a.path!;
    a.s += a.dir * a.speed * dt; a.cool -= dt;
    while (a.i < p.n - 2 && a.s > p.len[a.i + 1]) a.i++;
    while (a.i > 0 && a.s < p.len[a.i]) a.i--;
    if (a.s < 0 || a.s > p.total) {
      if (p.closed) { a.s = (a.s + p.total) % p.total; a.i = a.s < 1 ? 0 : p.n - 2; }
      else if (!this.switchPath(a, true)) { a.dir = -a.dir; a.s = Math.max(0, Math.min(p.total, a.s)); }
    } else if (a.cool <= 0 && p.junc?.[a.i] && this.rnd() < 0.02) this.switchPath(a, false);
    this.placeOnPath(a);
    // step aside for the player
    const dx = a.x - px, dz = a.z - pz, d = Math.hypot(dx, dz);
    if (d < 1.4 && d > 1e-3) { a.x += (dx / d) * (1.4 - d); a.z += (dz / d) * (1.4 - d); }
  }

  /** continue onto another road / path that meets this one */
  private switchPath(a: Agent, atEnd: boolean): boolean {
    const p = a.path!, x = p.x[a.i], z = p.z[a.i];
    let best: { path: Path; i: number } | null = null, bd = atEnd ? 18 : p.width;
    for (const k of WALK_KINDS) {
      const sg = NET.nearest(x + (this.rnd() - 0.5) * 6, z + (this.rnd() - 0.5) * 6, bd, [k]);
      if (sg && sg.path !== p) { const dd = Math.hypot(sg.path.x[sg.i] - x, sg.path.z[sg.i] - z); if (dd < bd) { bd = dd; best = sg; } }
    }
    if (!best) return false;
    const np = best.path;
    a.path = np; a.i = Math.min(best.i, np.n - 2); a.s = np.len[a.i]; a.dir = this.rnd() < 0.5 ? 1 : -1; a.cool = 6;
    a.off = np.kind === 'stone' ? (this.rnd() - 0.5) * np.width * 0.5 : np.width / 2 + 1.0 + this.rnd() * 2.2;
    return true;
  }

  /** how busy the streets are at this hour (rush hours, quiet small hours, lively evenings in the city) */
  private crowd(h: number): number {
    if (h < 5) return 0.18;
    if (h < 7) return 0.35 + (h - 5) * 0.25;
    if (h < 9.5) return 1;
    if (h < 16.5) return 0.7;
    if (h < 20) return 1;
    return 0.6 - (h - 20) * 0.08;
  }

  private scan(px: number, pz: number, first: boolean): void {
    const h = this.hour, R = 150, cx = Math.floor(px / 64), cz = Math.floor(pz / 64), day = Math.floor(h / 2);
    // routines: fill active slots in range (nearest first), free the ones that ended or fell out of range
    const near: [number, number][] = [];
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) for (const si of this.grid.get(cx + i + ',' + (cz + j)) ?? []) {
      const s = this.slots[si], d = Math.hypot(s.x - px, s.z - pz);
      if (d < R) near.push([si, d]);
    }
    near.sort((a, b) => a[1] - b[1]);
    for (const a of this.ag) {
      if (!a.on || a.slot < 0) continue;
      const s = this.slots[a.slot], d = Math.hypot(s.x - px, s.z - pz);
      const on = active(h, s.h0, s.h1) && hsh(s.seed, day) < s.p;
      if (d > R + 40) { this.release(a); this.counts.recycled++; }
      else if (!on) { // routine over: get up and walk off when someone could see it, otherwise just go
        s.agent = -1; a.slot = -1;
        if (d < 70 && this.toPath(a, a.x, a.z, 40)) { a.leaving = 1; } else this.release(a);
      }
    }
    for (const [si, d] of near) {
      const s = this.slots[si];
      if (s.agent >= 0 || !active(h, s.h0, s.h1) || hsh(s.seed, day) >= s.p) continue;
      if (!first && d < 45) continue;                          // don't pop in right next to the player
      const v = s.v >= 0 ? s.v : this.rnd() < 0.5 ? 0 : 1;
      const a = this.take(v) ?? (s.v < 0 ? this.take(1 - v) : null);
      if (!a) break;
      a.slot = si; s.agent = this.ag.indexOf(a); a.act = s.act; a.path = null;
      a.x = s.x; a.z = s.z; a.yaw = s.ry; a.lift = s.y0;
      if (s.act === Act.Sit) a.sc = Math.max(a.sc, 0.93);
      if (inCity(s.x, s.z) && s.act === Act.Browse) a.lift = 0.33;
    }
    // walkers: keep the streets as busy as the hour says
    const want = Math.round((this.free[0].length + this.free[1].length + this.countWalkers()) * 0.85 * this.crowd(h));
    let walkers = this.countWalkers();
    for (const a of this.ag) if (a.on && a.slot < 0 && Math.hypot(a.x - px, a.z - pz) > R + 40) { this.release(a); walkers--; this.counts.recycled++; }
    for (let t = 0; t < 24 && walkers < want; t++) {
      const ang = this.rnd() * 6.283, d = (first ? 12 : 60) + this.rnd() * (R - (first ? 12 : 60));
      const x = px + Math.cos(ang) * d, z = pz + Math.sin(ang) * d;
      if (heightAt(x, z) < 1) continue;
      const a = this.take(this.rnd() < 0.5 ? 0 : 1); if (!a) break;
      if (!this.toPath(a, x, z, 30)) { this.release(a); continue; }
      walkers++;
    }
  }
  private countWalkers(): number { let n = 0; for (const a of this.ag) if (a.on && a.slot < 0) n++; return n; }

  update(dt: number, px: number, pz: number, hour: number): void {
    this.frame++; this.hour = hour;
    this.scanT -= dt;
    const jumped = Math.hypot(px - this.lastX, pz - this.lastZ) > 80;    // teleported / travelled: fill the new place at once
    if (this.scanT <= 0 || jumped) { this.scan(px, pz, this.frame < 3 || jumped); this.scanT = 0.7; this.lastX = px; this.lastZ = pz; }
    let full = 0, red = 0;
    const dirty = [false, false, false];
    for (const a of this.ag) {
      if (!a.on) continue;
      const d = Math.hypot(a.x - px, a.z - pz);
      let step = dt;
      if (d > 60) { a.acc += dt; red++; if ((this.frame + a.k) % 3) continue; step = a.acc; a.acc = 0; } else { full++; a.acc = 0; }
      if (a.slot < 0 && a.path) this.walk(a, step, px, pz);
      a.ph += step;
      // glance at the player when they come close
      const tgt = d < 7 ? Math.atan2(px - a.x, pz - a.z) - a.yaw : 0;
      const wrapped = Math.atan2(Math.sin(tgt), Math.cos(tgt));
      a.look += (Math.max(-1.1, Math.min(1.1, wrapped)) - a.look) * Math.min(1, step * 3);
      const bob = this.animate(a);
      this.pv.set(a.x, heightAt(a.x, a.z) + a.lift + bob * a.sc, a.z);
      this.q.setFromEuler(this.e.set(0, a.yaw, 0));
      this.sv.setScalar(a.sc);
      this.m.compose(this.pv, this.q, this.sv);
      this.meshes[a.v].setMatrixAt(a.k, this.m);
      dirty[a.v] = true;
    }
    for (let v = 0; v < 3; v++) if (dirty[v]) {
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.jA[v].needsUpdate = true; this.jB[v].needsUpdate = true; this.jC[v].needsUpdate = true;
    }
    this.counts.full = full; this.counts.reduced = red;
  }

  /** writes the joint angles for this frame; returns the vertical body offset */
  private animate(a: Agent): number {
    const A = this.jA[a.v], B = this.jB[a.v], C = this.jC[a.v], k = a.k, t = a.ph;
    let hipL = 0, knL = 0.04, hipR = 0, knR = 0.04, shL = 0.05, elL = -0.12, shR = 0.05, elR = -0.12, rL = 0.06, rR = 0.06, sp = 0.02, hd = a.look, bob = 0;
    const br = Math.sin(t * 1.7);
    switch (a.slot < 0 ? Act.Walk : a.act) {
      case Act.Walk: {
        const f = a.speed / 1.55, u = t * 2 * Math.PI * f * 0.95, s = Math.sin(u), c = Math.cos(u);
        hipL = -0.42 * s; hipR = 0.42 * s;
        knL = 0.08 + Math.max(0, c) * 0.75; knR = 0.08 + Math.max(0, -c) * 0.75;
        shL = 0.38 * s; shR = -0.38 * s; elL = -0.22 - 0.25 * Math.max(0, -s); elR = -0.22 - 0.25 * Math.max(0, s);
        bob = 0.022 * Math.abs(Math.cos(u)) - 0.02; sp = 0.05;
        if (a.phone) { shR = -0.75; elR = -1.55; rR = 0.25; hd = a.look * 0.5; sp = 0.12; }
        break;
      }
      case Act.Stand: shL = 0.06 + 0.02 * br; shR = 0.06 - 0.02 * br; hd += 0.3 * Math.sin(t * 0.3); break;
      case Act.Sit:
        hipL = hipR = -1.45; knL = knR = 1.4; shL = shR = -0.45; elL = elR = -0.55; rL = rR = 0.12; sp = -0.05 + 0.02 * br;
        bob = -(HIP_Y - 0.6); hd += 0.4 * Math.sin(t * 0.21);
        break;
      case Act.Hoe: {
        const u = t * 2.2, sw = Math.sin(u);
        sp = 0.45 + 0.2 * sw; hipL = -0.15; hipR = 0.25; knL = 0.35; knR = 0.15;
        shL = shR = -1.1 + 0.7 * sw; elL = elR = -0.35; rL = rR = -0.15; bob = -0.04;
        break;
      }
      case Act.Plant: {
        const u = t * 1.4;
        sp = 1.05 + 0.08 * Math.sin(u); hipL = hipR = -0.35; knL = knR = 0.55;
        shL = -0.7 + 0.35 * Math.sin(u); shR = -0.7 + 0.35 * Math.sin(u + 2); elL = elR = -0.2; bob = -0.08;
        break;
      }
      case Act.Pray: {
        const bow = Math.max(0, Math.sin(t * 0.5)) ** 6;
        shL = shR = -0.75; elL = elR = -1.35; rL = rR = -0.42; sp = 0.12 + 0.6 * bow;
        break;
      }
      case Act.Dance: {
        const u = t * 5.2, s = Math.sin(u);
        knL = 0.25 + 0.25 * Math.max(0, s); knR = 0.25 + 0.25 * Math.max(0, -s); hipL = -0.15 - 0.2 * Math.max(0, s); hipR = -0.15 - 0.2 * Math.max(0, -s);
        rL = 1.6 + 0.7 * Math.sin(u * 0.5); rR = 1.6 + 0.7 * Math.sin(u * 0.5 + 1.5); shL = shR = -0.3; elL = -0.9 + 0.5 * s; elR = -0.9 - 0.5 * s;
        sp = 0.08 * s; bob = -0.05 * Math.abs(s); hd = 0.3 * Math.sin(u * 0.5);
        a.yaw += 0.004 * Math.sin(t * 0.7);
        break;
      }
      case Act.Talk: {
        const g = Math.sin(t * 1.9) * 0.5 + 0.5;
        shR = -0.55 - 0.3 * g; elR = -1.0 - 0.3 * Math.sin(t * 3.1); rR = 0.2;
        shL = 0.05; elL = -0.2 - 0.6 * (Math.sin(t * 0.37) > 0.6 ? 1 : 0); hd += 0.12 * Math.sin(t * 0.8);
        break;
      }
      case Act.Vend: {
        const s = Math.sin(t * 2.6);
        shL = -0.7 + 0.15 * s; shR = -0.7 - 0.15 * s; elL = -0.6 - 0.3 * s; elR = -0.6 + 0.3 * s; sp = 0.12; hd += 0.5 * Math.sin(t * 0.4);
        break;
      }
      case Act.Browse: shL = shR = 0.12; elL = elR = -0.35; rL = rR = 0.05; sp = 0.06; hd += 0.35 * Math.sin(t * 0.25); break;
    }
    A.setXYZW(k, hipL, knL, hipR, knR); B.setXYZW(k, shL, elL, shR, elR); C.setXYZW(k, rL, rR, sp, hd);
    return bob;
  }
}
