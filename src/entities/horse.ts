/**
 * Horses: sculpted (lofted) model, procedural gaits (walk 4-beat, trot diagonal, gallop rotary) blended by speed,
 * grazing/wandering behaviour inside a pasture, and a saddle seat the player can mount.
 *
 * Model faces +z, hooves on y = 0. Joints: body (bob/pitch), neck -> head, tail, 4 x (upper leg -> lower leg).
 * Leg rotation convention matches the hero: +x swings a hanging limb back, -x forward.
 * Geometry is cached per coat, so a herd shares buffers.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ends, grad, keys, loft, setLoftDetail, type V3 } from './sculpt';
import { hullGeo, outlineMat } from '../rendering/outline';
import { heightAt, mulberry32 } from '../world/terrain';
import { blocked } from '../world/layout';

const PI = Math.PI;
const COATS: { body: number; dark: number; mane: number; sock: boolean }[] = [
  { body: 0x8a4a26, dark: 0x5a2e16, mane: 0x1e140e, sock: true },   // bay
  { body: 0xb0602a, dark: 0x7a3e1a, mane: 0x8a3a18, sock: false },  // chestnut
  { body: 0x24201e, dark: 0x141210, mane: 0x0e0c0c, sock: false },  // black
  { body: 0xe8e2d8, dark: 0xbab2a6, mane: 0xf4f0ea, sock: false },  // white
  { body: 0x8e8a86, dark: 0x5e5a58, mane: 0x2e2c2c, sock: true },   // grey
  { body: 0xd8a85a, dark: 0xa87a3a, mane: 0xf4ead0, sock: true },   // palomino
];
const SADDLES = [[0x5a3018, 0xc8283c], [0x2a1a10, 0x2a6ad8], [0x6a4020, 0x2f9a5a]];

type Part = 'body' | 'neck' | 'head' | 'tail' | 'fu' | 'fl' | 'hu' | 'hl';
const cache = new Map<number, Record<Part, { g: THREE.BufferGeometry; hull: THREE.BufferGeometry }>>();

const FRONT = { y: 1.08, z: 0.5 }, HIND = { y: 1.12, z: -0.58 }, LEG_X = 0.15, UPPER = 0.5;
export const SEAT_Y = 1.58;

function buildParts(coat: number): Record<Part, { g: THREE.BufferGeometry; hull: THREE.BufferGeometry }> {
  const hit = cache.get(coat); if (hit) return hit;
  const prevDetail = setLoftDetail(0.7);
  const C = COATS[coat % COATS.length], [leather, cloth] = SADDLES[coat % SADDLES.length];
  const out = {} as Record<Part, { g: THREE.BufferGeometry; hull: THREE.BufferGeometry }>;
  const put = (k: Part, geos: THREE.BufferGeometry[]) => { const g = mergeGeometries(geos)!; geos.forEach((x) => x.dispose()); out[k] = { g, hull: hullGeo(g) }; };
  const bodyCol = grad(C.body, C.dark, (_t, a) => 0.5 - 0.5 * Math.sin(a)); // darker belly

  // ---- body: barrel from rump to chest, with withers, belly and haunches ----
  const bw = keys([[0, 0.17], [0.1, 0.26], [0.3, 0.28], [0.55, 0.25], [0.8, 0.27], [1, 0.2]]);
  const bh = keys([[0, 0.2], [0.1, 0.31], [0.3, 0.33], [0.55, 0.33], [0.8, 0.35], [1, 0.27]]);
  const body: THREE.BufferGeometry[] = [loft({
    path: [[0, 1.2, -0.84], [0, 1.18, -0.55], [0, 1.14, 0], [0, 1.2, 0.45], [0, 1.25, 0.74]], steps: 26, seg: 22, up: [0, 1, 0],
    r: (t) => { const k = ends(t, 0.12, 0.12); return [bw(t) * k + 0.004, bh(t) * k + 0.004]; },
    shape: (t, a) => 1 + 0.06 * Math.max(0, -Math.sin(a)) * Math.sin(PI * t) + 0.07 * Math.max(0, Math.sin(a)) * Math.exp(-(((t - 0.8) / 0.12) ** 2)),
    color: bodyCol,
  })];
  // saddle blanket, saddle with cantle + horn, girth, stirrups
  body.push(loft({ path: [[0, 1.49, -0.3], [0, 1.53, 0.0], [0, 1.5, 0.3]], steps: 8, seg: 16, up: [0, 1, 0], r: (t) => [0.34 * ends(t, 0.08, 0.08) + 0.004, 0.05], shape: (_t, a) => (Math.sin(a) < 0 ? 1.6 : 1), color: cloth }));
  body.push(loft({ path: [[0, 1.55, -0.22], [0, 1.56, 0.0], [0, 1.57, 0.2]], steps: 10, seg: 14, up: [0, 1, 0], r: (t) => [0.2 * ends(t, 0.15, 0.15) + 0.003, 0.05 * ends(t, 0.15, 0.15) + 0.003], color: leather }));
  body.push(loft({ path: [[0, 1.56, -0.24], [0, 1.66, -0.26]], steps: 3, seg: 10, r: () => [0.14, 0.04], color: leather }));
  body.push(loft({ path: [[0, 1.57, 0.2], [0, 1.68, 0.24]], steps: 3, seg: 8, r: (t) => 0.03 * (1 - 0.3 * t), color: leather }));
  for (const s of [-1, 1]) {
    body.push(loft({ path: [[s * 0.2, 1.52, 0.02], [s * 0.3, 1.3, 0.02], [s * 0.3, 1.06, 0.02]], steps: 6, seg: 6, r: () => [0.012, 0.02], color: leather }));
    body.push(loft({ path: [[s * 0.3, 1.06, -0.05], [s * 0.3, 1.0, 0.0], [s * 0.3, 1.06, 0.05]], steps: 6, seg: 6, r: () => 0.012, color: 0xc8c8d0 }));
  }
  body.push(loft({ path: [[0.28, 1.25, 0.12], [0, 0.82, 0.14], [-0.28, 1.25, 0.12]], steps: 10, seg: 6, up: [0, 0, 1], r: () => [0.04, 0.012], color: leather }));
  put('body', body);

  // ---- neck (crest + mane) ----
  const neck: THREE.BufferGeometry[] = [loft({
    path: [[0, -0.15, -0.08], [0, 0.15, 0.1], [0, 0.42, 0.3]], steps: 12, seg: 16, up: [1, 0, 0],
    r: (t) => [0.21 - 0.08 * t, 0.15 - 0.05 * t], color: bodyCol,
  })];
  neck.push(loft({ path: [[0, -0.02, -0.2], [0, 0.22, -0.02], [0, 0.48, 0.2]], steps: 12, seg: 8, up: [1, 0, 0], r: (t) => [0.06 * (1 - 0.3 * t), 0.035], shape: (_t, a) => 1 + 0.25 * Math.abs(Math.sin(a * 5)), color: C.mane }));
  put('neck', neck);

  // ---- head: skull to muzzle, jaw cheek, ears, eyes, forelock, bridle ----
  const head: THREE.BufferGeometry[] = [loft({
    path: [[0, 0.07, -0.06], [0, -0.1, 0.12], [0, -0.3, 0.34]], steps: 14, seg: 16, up: [1, 0, 0],
    r: (t) => { const k = ends(t, 0.2, 0.18); return [(0.13 - 0.04 * t) * k + 0.003, (0.1 - 0.035 * t) * k + 0.003]; },
    shape: (t, a) => 1 + 0.15 * Math.max(0, -Math.cos(a)) * Math.exp(-(((t - 0.25) / 0.15) ** 2)),
    color: grad(C.body, C.dark, (t) => smoothT(0.6, 1, t)),
  })];
  for (const s of [-1, 1]) {
    head.push(loft({ path: [[s * 0.05, 0.1, -0.03], [s * 0.07, 0.2, -0.05], [s * 0.075, 0.27, -0.04]], steps: 6, seg: 8, r: (t) => [0.03 * (1 - t) + 0.002, 0.018 * (1 - t) + 0.002], color: C.dark }));
    head.push(loft({ path: [[s * 0.095, -0.03, 0.08], [s * 0.1, -0.035, 0.1]], steps: 2, seg: 8, r: () => 0.02, color: 0x120e0c }));
    head.push(loft({ path: [[s * 0.06, -0.3, 0.33], [s * 0.07, -0.29, 0.345]], steps: 2, seg: 6, r: () => 0.012, color: 0x1a1210 }));
  }
  head.push(loft({ path: [[0, 0.1, 0.0], [0, 0.04, 0.1], [0, -0.04, 0.16]], steps: 6, seg: 8, up: [1, 0, 0], r: (t) => [0.03 * (1 - t) + 0.002, 0.05 * (1 - t) + 0.003], color: C.mane }));
  head.push(loft({ path: [[0.11, -0.2, 0.2], [0, -0.17, 0.28], [-0.11, -0.2, 0.2]], steps: 8, seg: 6, r: () => 0.012, color: leather }));
  head.push(loft({ path: [[0.1, 0.0, 0.0], [0, 0.08, -0.02], [-0.1, 0.0, 0.0]], steps: 8, seg: 6, r: () => 0.012, color: leather }));
  if (coat % 2 === 0) head.push(loft({ path: [[0, 0.02, 0.1], [0, -0.12, 0.25], [0, -0.22, 0.32]], steps: 8, seg: 8, up: [1, 0, 0], r: (t) => [0.008, 0.025 * (1 - 0.5 * t)], color: 0xf4f0ea })); // blaze
  put('head', head);

  // ---- tail ----
  put('tail', [loft({
    path: [[0, 0.04, 0.02], [0, -0.12, -0.14], [0, -0.45, -0.22], [0, -0.8, -0.16]], steps: 14, seg: 10, up: [1, 0, 0],
    r: (t) => [0.05 + 0.03 * Math.sin(PI * t), 0.07 + 0.06 * Math.sin(PI * Math.min(1, t * 1.2)) * (1 - t * 0.6)],
    shape: (_t, a) => 1 + 0.15 * Math.abs(Math.sin(a * 4)), color: C.mane,
  })]);

  // ---- legs: upper (forearm / gaskin) and lower (cannon, fetlock, pastern, hoof) ----
  const upper = (hind: boolean) => {
    const r = hind ? keys([[0, 0.16], [0.35, 0.11], [1, 0.062]]) : keys([[0, 0.13], [0.3, 0.1], [1, 0.06]]);
    return [loft({ path: [[0, 0.14, hind ? -0.03 : 0.02], [0, -0.2, hind ? -0.04 : 0.01], [0, -UPPER, 0]], steps: 10, seg: 12, r: (t) => [r(t) * 0.78 * ends(t, 0.12, 0), r(t) * ends(t, 0.12, 0)], color: hind ? grad(C.body, C.dark, (t) => t) : grad(C.dark, C.body, (t) => 1 - t) })];
  };
  const lower = () => {
    const r = keys([[0, 0.055], [0.15, 0.045], [0.7, 0.042], [0.82, 0.056], [0.92, 0.046], [1, 0.05]]);
    const lowC = C.sock ? grad(C.dark, 0xf4f0ea, (t) => (t > 0.6 ? 1 : 0)) : C.dark;
    return [
      loft({ path: [[0, 0.04, 0], [0, -0.2, 0], [0, -0.5, 0.012]], steps: 12, seg: 10, r: (t) => [r(t) * 0.8, r(t)], color: lowC }),
      loft({ path: [[0, -0.49, 0.015], [0, -0.58, 0.03]], steps: 3, seg: 12, r: (t) => [0.058 + 0.012 * t, 0.065 + 0.016 * t], color: 0x2a2220, capEnd: true }),
    ];
  };
  put('fu', upper(false)); put('hu', upper(true)); put('fl', lower()); put('hl', lower());
  cache.set(coat, out);
  setLoftDetail(prevDetail);
  return out;
}
const smoothT = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Horse {
  readonly root = new THREE.Group();
  private bodyG = new THREE.Group(); private neck: THREE.Group; private head: THREE.Group; private tail: THREE.Group;
  private legs: { up: THREE.Group; lo: THREE.Group; hind: boolean; side: number }[] = [];
  private inks: THREE.Mesh[] = [];
  x: number; z: number; y: number; yaw: number; speed = 0; vy = 0; grounded = true;
  ridden = false;
  bob = 0;          // vertical body motion, the rider follows it
  pitch = 0;
  phase = 0;
  private graze = 0; private wait = 0; private tx: number; private tz: number; private clock = Math.random() * 10;
  private rng: () => number;

  constructor(material: THREE.Material, coat: number, readonly home: { x: number; z: number; r: number }, seed: number) {
    const P = buildParts(coat);
    this.rng = mulberry32(seed);
    const add = (k: Part, parent: THREE.Object3D) => {
      const m = new THREE.Mesh(P[k].g, material); m.castShadow = true; parent.add(m);
      const o = new THREE.Mesh(P[k].hull, outlineMat(0.012)); parent.add(o); this.inks.push(o);
    };
    this.root.add(this.bodyG);
    add('body', this.bodyG);
    this.neck = new THREE.Group(); this.neck.position.set(0, 1.38, 0.62); this.bodyG.add(this.neck); add('neck', this.neck);
    this.head = new THREE.Group(); this.head.position.set(0, 0.45, 0.33); this.neck.add(this.head); add('head', this.head);
    this.tail = new THREE.Group(); this.tail.position.set(0, 1.32, -0.82); this.bodyG.add(this.tail); add('tail', this.tail);
    for (const hind of [false, true]) for (const side of [-1, 1]) {
      const base = hind ? HIND : FRONT;
      const up = new THREE.Group(); up.position.set(side * LEG_X, base.y, base.z); this.bodyG.add(up); add(hind ? 'hu' : 'fu', up);
      const lo = new THREE.Group(); lo.position.set(0, -UPPER, 0); up.add(lo); add(hind ? 'hl' : 'fl', lo);
      this.legs.push({ up, lo, hind, side });
    }
    const a = this.rng() * PI * 2, r = this.rng() * home.r;
    this.x = home.x + Math.cos(a) * r; this.z = home.z + Math.sin(a) * r; this.y = Math.max(heightAt(this.x, this.z), 0);
    this.yaw = this.rng() * PI * 2; this.tx = this.x; this.tz = this.z;
  }

  set inkVisible(v: boolean) { for (const o of this.inks) o.visible = v; }

  /** free-roaming behaviour: graze, then amble to a new spot inside the pasture */
  wander(dt: number): void {
    this.wait -= dt;
    const dx = this.tx - this.x, dz = this.tz - this.z, d = Math.hypot(dx, dz);
    let target = 0;
    if (this.wait > 0) target = 0;
    else if (d < 0.8) { this.wait = 4 + this.rng() * 10; const a = this.rng() * PI * 2, r = this.rng() * this.home.r; this.tx = this.home.x + Math.cos(a) * r; this.tz = this.home.z + Math.sin(a) * r; }
    else {
      target = 1.3;
      let dy = Math.atan2(dx, dz) - this.yaw; dy -= Math.round(dy / (PI * 2)) * PI * 2;
      this.yaw += dy * Math.min(1, dt * 1.5);
    }
    this.speed += (target - this.speed) * Math.min(1, dt * 2);
    this.move(dt);
  }

  /** advance along the heading; returns false if a slope / obstacle / water stopped the horse */
  move(dt: number): boolean {
    const nx = this.x + Math.sin(this.yaw) * this.speed * dt, nz = this.z + Math.cos(this.yaw) * this.speed * dt;
    const h0 = heightAt(this.x, this.z), h1 = heightAt(nx, nz), run = Math.hypot(nx - this.x, nz - this.z) || 1e-3;
    let ok = true;
    if (blocked(nx, nz) || h1 < -0.2 || (this.grounded && (h1 - h0) / run > 0.9)) { ok = false; this.speed *= 0.3; }
    else { this.x = nx; this.z = nz; }
    const ground = Math.max(heightAt(this.x, this.z), 0);
    this.vy -= 22 * dt; this.y += this.vy * dt;
    if (this.y <= ground) { this.y = ground; this.vy = 0; this.grounded = true; }
    return ok;
  }

  /** procedural gait + pose; call every frame the horse is visible */
  animate(dt: number): void {
    this.clock += dt;
    const sp = this.speed, c = this.clock;
    const stride = 1.7 + sp * 0.16;
    this.phase += dt * (sp / stride) * PI * 2;
    const walk = 1 - smoothT(2.4, 4.2, sp), gallop = smoothT(8, 11, sp), trot = Math.max(0, 1 - walk - gallop);
    const move = smoothT(0.15, 0.9, sp);
    // leg phase offsets per gait: [LF, RF, LH, RH]
    const OFF = { walk: [0.25, 0.75, 0.0, 0.5], trot: [0.0, 0.5, 0.5, 0.0], gallop: [0.5, 0.6, 0.0, 0.1] };
    const amp = 0.35 + 0.25 * trot + 0.5 * gallop;
    this.legs.forEach((L, i) => {
      let up = 0, lo = 0;
      for (const [w, off] of [[walk, OFF.walk[i]], [trot, OFF.trot[i]], [gallop, OFF.gallop[i]]] as [number, number][]) {
        if (w <= 0) continue;
        const ph = this.phase + off * PI * 2, s = Math.sin(ph), co = Math.cos(ph);
        up += w * -amp * s;                                                      // swing forward when sin > 0
        const lift = Math.max(0, co) * (0.9 + 0.7 * gallop);                    // fold the lower leg while it swings forward
        lo += w * (L.hind ? -0.5 * lift + 0.15 : lift * 1.1);
      }
      L.up.rotation.x = up * move + (L.hind ? 0.08 : -0.03) * (1 - move);
      L.lo.rotation.x = lo * move + (L.hind ? 0.12 : 0.02) * (1 - move);
    });
    // body: bob (2 per cycle at walk/trot), rocking pitch at gallop, rider follows
    const ph2 = this.phase * 2;
    this.bob = move * ((0.025 * walk + 0.06 * trot) * Math.cos(ph2) + 0.09 * gallop * Math.cos(this.phase + 0.6));
    this.pitch = move * (0.02 * walk * Math.sin(ph2) + 0.09 * gallop * Math.sin(this.phase));
    this.bodyG.position.y = this.bob; this.bodyG.rotation.x = this.pitch;
    // head and neck: nod with the gait, drop to graze when standing free
    const grazeT = !this.ridden && sp < 0.2 && this.wait > 1.5 ? 1 : 0;
    this.graze += (grazeT - this.graze) * Math.min(1, dt * 1.5);
    this.neck.rotation.x = -0.15 + this.graze * 1.15 + move * (0.06 * walk * Math.sin(ph2 + 1) + 0.12 * gallop * Math.sin(this.phase + 2)) - 0.12 * gallop;
    this.head.rotation.x = 0.35 + this.graze * 0.3 + 0.03 * Math.sin(c * 0.8);
    this.head.rotation.y = (1 - move) * 0.15 * Math.sin(c * 0.4);
    this.tail.rotation.x = -0.2 - 0.6 * gallop * move + 0.05 * Math.sin(c * 1.3);
    this.tail.rotation.z = 0.18 * Math.sin(c * 1.1 + Math.sin(c * 0.37) * 2) * (1 - 0.5 * move);
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.y = this.yaw;
  }
}

/** All horses in the world: grouped by pasture, only simulated / drawn near the player. */
export class Herd {
  readonly group = new THREE.Group();
  readonly horses: Horse[] = [];
  constructor(material: THREE.Material, pastures: { x: number; z: number; r: number }[], max = 18) {
    let seed = 7;
    for (const p of pastures) for (let k = 0; k < 3 && this.horses.length < max; k++) {
      const h = new Horse(material, (seed * 5 + k) % COATS.length, p, seed++ * 977);
      this.horses.push(h); this.group.add(h.root);
    }
  }
  nearestFree(x: number, z: number, maxD: number): Horse | null {
    let best: Horse | null = null, bd = maxD;
    for (const h of this.horses) { if (h.ridden) continue; const d = Math.hypot(h.x - x, h.z - z); if (d < bd) { bd = d; best = h; } }
    return best;
  }
  update(dt: number, px: number, pz: number): void {
    for (const h of this.horses) {
      const d = Math.hypot(h.x - px, h.z - pz);
      const vis = h.ridden || d < 170;
      h.root.visible = vis;
      if (!vis) continue;
      if (!h.ridden) h.wander(dt);
      h.inkVisible = d < 70;
      h.animate(dt);
    }
  }
}
export type { V3 };
