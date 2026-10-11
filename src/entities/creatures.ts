/**
 * Mythical creatures.
 *
 *  Sky:  long Eastern dragons (jade, crimson-gold, azure) undulating through the air; a blazing phoenix with sweeping
 *        wings and trailing tail plumes; vast sky whales drifting high above the clouds.
 *  Land: qilin roaming God Island (jade-scaled, antlered, with a golden flame mane) and snow spirit steeds with ice
 *        antlers on the Yukigami Peaks.
 *  Sea:  a colossal sea serpent whose coils break the surface, a great whale that surfaces and dives, leaping koi and
 *        glowing jellyfish near the shore.
 *
 * Every body is one lofted mesh built straight along -z (head at z = 0). Swimming / flying motion is a travelling wave
 * applied in the vertex shader as a function of local z, so a 60 m dragon costs one draw call and no CPU skinning;
 * wings flap the same way. Creatures stay around the player: flyers circle a centre that follows you, sea creatures
 * pick open water near you, land creatures roam their island.
 */
import * as THREE from 'three/webgpu';
import { abs, attribute, cos, float, max, min, positionLocal, sin, smoothstep, time, uniform, vec3 } from 'three/tsl';
import { loft, keys, ends, grad } from './sculpt';
import { heightAt, islandAt, GOD } from '../world/terrain';
import { Horse } from './horse';

type V3 = [number, number, number];
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------------------------------------------------
function merge(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  for (const g of gs) {
    const base = pos.length / 3, P = g.getAttribute('position'), N = g.getAttribute('normal'), C = g.getAttribute('color'), I = g.getIndex();
    for (let i = 0; i < P.count; i++) { pos.push(P.getX(i), P.getY(i), P.getZ(i)); nor.push(N.getX(i), N.getY(i), N.getZ(i)); if (C) col.push(C.getX(i), C.getY(i), C.getZ(i)); else col.push(1, 1, 1); }
    if (I) for (let i = 0; i < I.count; i++) idx.push(base + I.getX(i)); else for (let i = 0; i < P.count; i++) idx.push(base + i);
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(idx); out.computeBoundingSphere();
  return out;
}
/** a single-colour primitive with a colour attribute, transformed */
function prim(g: THREE.BufferGeometry, color: number, m?: THREE.Matrix4): THREE.BufferGeometry {
  if (m) g.applyMatrix4(m);
  const c = new THREE.Color(color), n = g.getAttribute('position').count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}
const M4 = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

/**
 * Travelling-wave body material. Local -z runs head (0) to tail (len); amplitudes ramp up from the head.
 * ax / ay: sideways / vertical amplitude (m), wl: wavelength (m), sp: wave speed (cycles/s); flap: wing flap amplitude.
 */
function waveMaterial(ramp: THREE.Texture, o: { len: number; ax: number; ay: number; wl: number; sp: number; flap?: number; flapHz?: number; wingX?: number; basic?: boolean }) {
  const mat = o.basic ? new THREE.MeshBasicNodeMaterial({ vertexColors: true }) : new THREE.MeshToonNodeMaterial({ vertexColors: true, gradientMap: ramp });
  const phase = uniform(Math.random() * 10), speed = uniform(o.sp);
  const p = positionLocal;
  const u = min(max(p.z.negate().div(o.len), 0), 1);
  const env = smoothstep(0, 0.25, u).mul(0.35).add(u.mul(0.65));                       // the head stays steady, the tail swings most
  const k = u.mul(o.len / o.wl).sub(time.mul(speed)).add(phase).mul(TAU);
  let x = p.x.add(sin(k).mul(o.ax).mul(env));
  let y = p.y.add(cos(k.mul(0.7).add(1.3)).mul(o.ay).mul(env));
  if (o.flap) {
    // wings: vertices beyond the shoulder line rotate about it (both sides mirrored)
    const w = attribute('wing', 'float'), r0 = float(o.wingX ?? 0.5), side = p.x.sign();
    const dx = abs(p.x).sub(r0).max(0), th = sin(time.mul(o.flapHz ?? 1.4).mul(TAU).add(phase)).mul(o.flap).mul(w);
    x = x.add(side.mul(dx.mul(cos(th)).sub(dx)).mul(w));
    y = y.add(dx.mul(sin(th)).mul(w));
  }
  mat.positionNode = vec3(x, y, p.z);
  return { mat, phase, speed };
}

// ---------------------------------------------------------------------------------------------------------------------
// creature models (all face -z? no: head at the origin, body trailing toward -z, travelling toward +z)
// ---------------------------------------------------------------------------------------------------------------------
const DRAGONS = [
  { body: 0x2fbf8a, belly: 0xf2e6a8, fin: 0xff6a3a, mane: 0xf4f0e6, horn: 0xf2d27a },   // jade
  { body: 0xc8283c, belly: 0xffd84a, fin: 0xffb02e, mane: 0xffd84a, horn: 0xf4ead0 },   // crimson & gold
  { body: 0x2a6ad8, belly: 0xd8f2ff, fin: 0x8ae8ff, mane: 0xf4f8ff, horn: 0xe8e0c8 },   // azure
];

/** Eastern dragon, ~len m long, head at z=0 looking +z */
function dragonGeo(v: number, len: number): THREE.BufferGeometry {
  const C = DRAGONS[v], g: THREE.BufferGeometry[] = [];
  const R = len * 0.03, rp = keys([[0, 0.55], [0.04, 0.85], [0.12, 1], [0.5, 0.9], [0.85, 0.5], [1, 0.12]]);
  const path: V3[] = []; for (let i = 0; i <= 10; i++) path.push([0, 0, -i * len / 10]);
  const scale = grad(C.body, C.belly, (_t, a) => (Math.sin(a) < -0.35 ? 1 : 0));
  g.push(loft({
    path, steps: 220, seg: 18, r: (t) => [R * rp(t) * 1.05, R * rp(t)],
    shape: (t, a) => 1 + 0.06 * Math.max(0, Math.sin(a * 6 + t * 260)),                 // scale ridges
    color: (t, a, p, out) => { scale(t, a, p, out); if (Math.sin(a) > -0.35 && Math.sin(t * 380) > 0.6) out.multiplyScalar(0.82); },
  }));
  // dorsal fin: a row of flame-coloured spines
  for (let i = 0; i < 46; i++) {
    const t = 0.05 + i * 0.019; if (t > 0.97) break;
    const r = R * rp(t), h = R * (0.9 + 0.5 * Math.sin(i * 0.9)) * (1 - t * 0.6);
    g.push(prim(new THREE.ConeGeometry(r * 0.35, h, 4), i % 3 ? C.fin : C.horn, M4(0, r * 0.95 + h * 0.4, -t * len, -0.5, 0, 0)));
  }
  // the dragon's pearl, held in a front claw, wreathed in flame
  { const z = -0.2 * len, r = R * rp(0.2);
    g.push(prim(new THREE.SphereGeometry(r * 0.55, 14, 10), 0xf4fbff, M4(r * 1.5, -r * 2.5, z + r * 1.6)));
    for (let k = 0; k < 6; k++) g.push(prim(new THREE.ConeGeometry(r * 0.16, r * 0.9, 5), k % 2 ? C.fin : 0xffe066, M4(r * 1.5 + Math.cos(k) * r * 0.4, -r * 2.2, z + r * 1.6 + Math.sin(k) * r * 0.4, 0.3 * Math.cos(k), 0, 0.3 * Math.sin(k)))); }
  // a second row of fine hair along the spine behind the head
  for (let i = 0; i < 30; i++) { const t = 0.02 + i * 0.012, r = R * rp(t); g.push(prim(new THREE.ConeGeometry(r * 0.12, r * 1.3, 4), C.mane, M4(Math.sin(i * 1.7) * r * 0.35, r * 0.85, -t * len, -1.1, 0, Math.sin(i) * 0.4))); }
  // tail plume
  for (let k = 0; k < 7; k++) { const a = (k / 7) * TAU; g.push(prim(new THREE.ConeGeometry(R * 0.25, R * 3, 5), C.mane, M4(Math.cos(a) * R * 0.2, Math.sin(a) * R * 0.2, -len - R * 1.2, -Math.PI / 2 + Math.sin(a) * 0.3, 0, Math.cos(a) * 0.3))); }
  // four short legs with three-toed claws
  for (const [t, s] of [[0.2, 1], [0.2, -1], [0.55, 1], [0.55, -1]] as [number, number][]) {
    const z = -t * len, r = R * rp(t);
    g.push(loft({ path: [[s * r * 0.7, -r * 0.3, z], [s * r * 1.5, -r * 1.1, z + r * 0.4], [s * r * 1.4, -r * 2.0, z + r * 1.0]], steps: 6, seg: 8, r: (q) => r * (0.32 - 0.12 * q), color: C.body }));
    for (const dz of [-0.25, 0, 0.25]) g.push(prim(new THREE.ConeGeometry(r * 0.08, r * 0.5, 4), C.horn, M4(s * r * 1.4 + dz * r * s, -r * 2.15, z + r * 1.3, Math.PI / 2 + 0.4, 0, 0)));
  }
  // head: long snout, jaw, brow ridges, antler horns, eyes, whiskers, beard and mane
  const H = R * 1.15;
  g.push(loft({ path: [[0, 0, -H * 0.6], [0, H * 0.15, H * 0.5], [0, H * 0.05, H * 1.9]], steps: 12, seg: 14, up: [0, 1, 0], r: (t) => [H * (0.75 - 0.32 * t) * ends(t, 0, 0.25), H * (0.6 - 0.3 * t) * ends(t, 0, 0.25)], color: grad(C.body, C.belly, (_t, a) => (Math.sin(a) < -0.2 ? 1 : 0)) }));
  g.push(loft({ path: [[0, -H * 0.45, -H * 0.2], [0, -H * 0.5, H * 0.7], [0, -H * 0.35, H * 1.55]], steps: 8, seg: 10, up: [0, 1, 0], r: (t) => [H * (0.5 - 0.22 * t) * ends(t, 0, 0.3), H * 0.16 * ends(t, 0, 0.3)], color: C.belly }));
  for (const s of [-1, 1]) {
    g.push(prim(new THREE.SphereGeometry(H * 0.17, 10, 8), 0xfff2a0, M4(s * H * 0.48, H * 0.32, H * 0.55)));
    g.push(prim(new THREE.SphereGeometry(H * 0.09, 8, 6), 0x140c08, M4(s * H * 0.56, H * 0.33, H * 0.62)));
    g.push(loft({ path: [[s * H * 0.3, H * 0.45, H * 0.05], [s * H * 0.55, H * 1.2, -H * 0.5], [s * H * 0.75, H * 1.6, -H * 1.3]], steps: 8, seg: 8, r: (t) => H * (0.13 - 0.1 * t), color: C.horn }));
    g.push(loft({ path: [[s * H * 0.6, H * 1.25, -H * 0.65], [s * H * 1.0, H * 1.45, -H * 0.55]], steps: 4, seg: 6, r: (t) => H * (0.07 - 0.05 * t), color: C.horn }));
    g.push(loft({ path: [[s * H * 0.35, -H * 0.05, H * 1.6], [s * H * 1.4, -H * 0.3, H * 1.4], [s * H * 2.6, -H * 0.9, H * 0.6], [s * H * 3.6, -H * 1.8, -H * 0.4]], steps: 14, seg: 5, r: (t) => H * 0.045 * (1 - 0.8 * t), color: C.mane })); // whiskers
    g.push(loft({ path: [[s * H * 0.3, H * 0.6, H * 0.45], [s * H * 0.55, H * 0.72, H * 0.9]], steps: 4, seg: 6, r: () => [H * 0.1, H * 0.05], color: C.body })); // brow ridge
  }
  for (let k = 0; k < 16; k++) {                                                         // flowing mane
    const a = -0.4 + (k / 15) * (Math.PI + 0.8), r = H * 0.65;
    g.push(prim(new THREE.ConeGeometry(H * 0.18, H * 1.9, 5), C.mane, M4(Math.cos(a) * r, Math.sin(a) * r * 0.9 + H * 0.1, -H * 0.8 - (k % 3) * H * 0.25, -Math.PI / 2 - 0.35, 0, Math.cos(a) * 0.5)));
  }
  g.push(prim(new THREE.ConeGeometry(H * 0.22, H * 1.2, 6), C.mane, M4(0, -H * 0.75, H * 0.9, Math.PI + 0.3, 0, 0))); // beard
  return merge(g);
}

/** phoenix ~ wingspan 22 m; wings flagged with a 'wing' attribute for flapping */
function phoenixGeo(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [], wingFlags: number[] = [];
  const push = (geo: THREE.BufferGeometry, wing: number) => { g.push(geo); for (let i = 0; i < geo.getAttribute('position').count; i++) wingFlags.push(wing); };
  const fire = grad(0xffd84a, 0xe8391a, (t) => t);
  push(loft({ path: [[0, 0, 1.6], [0, 0.1, 0], [0, 0, -2.4]], steps: 16, seg: 14, r: (t) => { const k = ends(t, 0.25, 0.2); return [0.9 * k + 0.02, 1.0 * k + 0.02]; }, color: fire }), 0);
  push(loft({ path: [[0, 0.5, 1.4], [0, 1.1, 2.1], [0, 1.25, 2.7]], steps: 10, seg: 12, r: (t) => 0.5 * ends(t, 0.1, 0.35) + 0.02, color: 0xffd84a }), 0);           // neck & head
  push(prim(new THREE.ConeGeometry(0.16, 0.7, 6), 0xffb02e, M4(0, 1.18, 3.15, Math.PI / 2, 0, 0)), 0);                                                               // beak
  for (const s of [-1, 1]) push(prim(new THREE.SphereGeometry(0.09, 8, 6), 0x1a0c08, M4(s * 0.25, 1.38, 2.75)), 0);
  for (let k = 0; k < 5; k++) push(prim(new THREE.ConeGeometry(0.1, 0.9, 5), 0xffe066, M4((k - 2) * 0.12, 1.75, 2.4, -0.6 - Math.abs(k - 2) * 0.1, 0, (k - 2) * 0.25)), 0); // crest
  for (const s of [-1, 1]) for (let f = 0; f < 14; f++) {                                                                                                          // wing feathers
    const x = 0.6 + f * 0.75, len = 3.2 - f * 0.08 + (f > 9 ? 1.2 : 0), z = 0.6 - f * 0.12;
    const fe = new THREE.ConeGeometry(0.42, len, 4); fe.rotateX(-Math.PI / 2); fe.scale(1, 0.18, 1);
    push(prim(fe, f > 9 ? 0xe8391a : f > 5 ? 0xff8a2a : 0xffd84a, M4(s * x, 0.15 - f * 0.02, z - len * 0.45, 0, s * (0.1 + f * 0.03), 0)), 1);
  }
  for (let k = 0; k < 7; k++) {                                                                                                                                    // tail plumes
    const a = (k - 3) * 0.16, L = 11 + Math.abs(3 - k) * -1.2;
    push(loft({ path: [[0, 0, -2.2], [Math.sin(a) * L * 0.4, -0.4, -2.2 - L * 0.4], [Math.sin(a) * L, -0.2, -2.2 - L]], steps: 18, seg: 6, r: (t) => (0.18 + 0.32 * Math.sin(Math.PI * t)) * (t > 0.85 ? 1.6 : 1), color: (t, _a, _p, out) => { out.setHex(t > 0.85 ? 0x2ae8ff : t > 0.5 ? 0xff5a2a : 0xffc83a); } }), 0);
  }
  const m = merge(g); m.setAttribute('wing', new THREE.Float32BufferAttribute(wingFlags, 1));
  return m;
}

/** sky whale (~32 m): rounded body, white belly with glowing spots, pectoral fins, fluke */
function whaleGeo(sky: boolean): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [], L = 32, r = keys([[0, 0.35], [0.12, 0.85], [0.3, 1], [0.6, 0.8], [0.88, 0.3], [1, 0.12]]);
  const top = sky ? 0x5a7ad8 : 0x34465e, belly = sky ? 0xe8f2ff : 0xd8dce0;
  g.push(loft({ path: [[0, 0, 0], [0, 0.4, -L * 0.4], [0, 0.6, -L]], steps: 40, seg: 18, r: (t) => { const k = ends(t, 0.08, 0.02); return [4.2 * r(t) * k + 0.05, 3.6 * r(t) * k + 0.05]; },
    color: (t, a, _p, out) => { out.setHex(Math.sin(a) < -0.25 ? belly : top); if (Math.sin(a) < -0.25 && Math.cos(a * 9 + t * 40) > 0.94) out.setHex(sky ? 0x8ae8ff : 0xb8c0c8); } }));
  for (const s of [-1, 1]) {
    const fin = new THREE.SphereGeometry(1, 10, 6); fin.scale(5.5, 0.35, 1.8);
    g.push(prim(fin, top, M4(s * 6.5, -1.6, -6.5, 0, s * -0.5, s * -0.35)));
    const fl = new THREE.SphereGeometry(1, 10, 6); fl.scale(3.6, 0.3, 1.6);
    g.push(prim(fl, top, M4(s * 2.8, 0.6, -L - 1.2, 0, s * 0.35, 0)));
    g.push(prim(new THREE.SphereGeometry(0.35, 8, 6), 0x101418, M4(s * 3.4, 0.2, -3.4)));
  }
  if (sky) for (let k = 0; k < 9; k++) g.push(prim(new THREE.SphereGeometry(0.45, 8, 6), 0x8ae8ff, M4((k % 3 - 1) * 1.6, 3.5 - (k % 2) * 0.4, -6 - k * 2.4)));
  return merge(g);
}

/** sea serpent ~110 m, finned, spined */
function serpentGeo(len: number): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [], R = len * 0.022, rp = keys([[0, 0.7], [0.05, 1], [0.5, 0.95], [0.9, 0.5], [1, 0.1]]);
  const path: V3[] = []; for (let i = 0; i <= 10; i++) path.push([0, 0, -i * len / 10]);
  g.push(loft({ path, steps: 160, seg: 14, r: (t) => [R * rp(t), R * rp(t) * 1.1], color: (t, a, _p, out) => { out.setHex(Math.sin(a) < -0.3 ? 0xbfe8d8 : (Math.sin(t * 300) > 0.7 ? 0x1e6a6a : 0x2a8a8a)); } }));
  for (let i = 0; i < 60; i++) { const t = 0.03 + i * 0.016; if (t > 0.98) break; const r = R * rp(t); g.push(prim(new THREE.ConeGeometry(r * 0.4, r * 1.4, 4), i % 2 ? 0x7af2d8 : 0x1a4a5a, M4(0, r * 1.15, -t * len, -0.6, 0, 0))); }
  const H = R * 1.25;
  g.push(loft({ path: [[0, 0, -H], [0, H * 0.2, H * 0.6], [0, 0, H * 2.2]], steps: 12, seg: 14, up: [0, 1, 0], r: (t) => [H * (0.9 - 0.4 * t) * ends(t, 0, 0.25), H * (0.7 - 0.35 * t) * ends(t, 0, 0.25)], color: 0x2a8a8a }));
  for (const s of [-1, 1]) {
    g.push(prim(new THREE.SphereGeometry(H * 0.2, 10, 8), 0xffe24a, M4(s * H * 0.6, H * 0.35, H * 0.7)));
    g.push(prim(new THREE.SphereGeometry(H * 0.1, 8, 6), 0x100808, M4(s * H * 0.7, H * 0.36, H * 0.82)));
    const frill = new THREE.ConeGeometry(H * 0.9, H * 1.8, 5); frill.scale(0.2, 1, 1);
    g.push(prim(frill, 0x7af2d8, M4(s * H * 0.8, H * 0.4, -H * 0.4, -0.9, 0, s * -0.7)));
    for (let k = 0; k < 4; k++) g.push(prim(new THREE.ConeGeometry(H * 0.06, H * 0.35, 4), 0xf4f0e6, M4(s * H * (0.25 + k * 0.12), -H * 0.2, H * (1.9 - k * 0.3), Math.PI, 0, 0))); // fangs
  }
  return merge(g);
}

function koiGeo(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [];
  g.push(loft({ path: [[0, 0, 0.4], [0, 0, 0], [0, 0, -0.5]], steps: 10, seg: 10, r: (t) => { const k = ends(t, 0.3, 0.1); return [0.11 * k + 0.01, 0.15 * k + 0.01]; }, color: (_t, a, p, out) => { out.setHex(Math.sin(p.z * 18 + a) > 0.3 ? 0xff5a2a : 0xf4f0e6); } }));
  const tail = new THREE.ConeGeometry(0.18, 0.35, 4); tail.scale(0.15, 1, 1); g.push(prim(tail, 0xff8a4a, M4(0, 0, -0.62, Math.PI / 2, 0, 0)));
  return merge(g);
}
function jellyGeo(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [];
  const bell = new THREE.SphereGeometry(0.9, 14, 8, 0, TAU, 0, Math.PI * 0.55); g.push(prim(bell, 0xb88aff));
  for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU; g.push(loft({ path: [[Math.cos(a) * 0.6, 0, Math.sin(a) * 0.6], [Math.cos(a) * 0.7, -1.2, Math.sin(a) * 0.7], [Math.cos(a) * 0.5, -2.6, Math.sin(a) * 0.5]], steps: 8, seg: 4, r: () => 0.04, color: 0xe8c8ff })); }
  return merge(g);
}

/** qilin / spirit steed extras on a horse rig: antlers, scales and a flame mane */
function steedExtras(snow: boolean): { head: THREE.BufferGeometry; body: THREE.BufferGeometry } {
  const horn = snow ? 0xb8f2ff : 0xf2d27a, flame = snow ? 0x8ae8ff : 0xffb02e, h: THREE.BufferGeometry[] = [], b: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    h.push(loft({ path: [[s * 0.1, 0.12, -0.05], [s * 0.22, 0.45, -0.18], [s * 0.3, 0.75, -0.12]], steps: 8, seg: 6, r: (t) => 0.035 - 0.025 * t, color: horn }));
    h.push(loft({ path: [[s * 0.2, 0.4, -0.16], [s * 0.38, 0.52, -0.08]], steps: 4, seg: 5, r: (t) => 0.022 - 0.015 * t, color: horn }));
    h.push(loft({ path: [[s * 0.26, 0.62, -0.13], [s * 0.42, 0.7, -0.22]], steps: 4, seg: 5, r: (t) => 0.018 - 0.013 * t, color: horn }));
    h.push(loft({ path: [[s * 0.1, -0.08, 0.3], [s * 0.35, -0.15, 0.25], [s * 0.6, -0.3, 0.1]], steps: 8, seg: 4, r: (t) => 0.012 * (1 - 0.7 * t), color: flame })); // whiskers
  }
  for (let k = 0; k < 12; k++) b.push(prim(new THREE.ConeGeometry(0.07, 0.42, 5), flame, M4(0, 1.5 + k * 0.02, 0.9 - k * 0.05, -0.9, 0, 0)));      // flame mane along the neck base
  for (let k = 0; k < 20; k++) { const z = 0.6 - k * 0.07; b.push(prim(new THREE.SphereGeometry(0.07, 6, 4), snow ? 0xd8eefc : 0x2a8a5a, M4(((k % 2) - 0.5) * 0.24, 1.47, z, 0, 0, 0, 1, 0.4, 1.2))); } // dorsal scales
  for (let k = 0; k < 6; k++) b.push(prim(new THREE.ConeGeometry(0.06, 0.5, 5), flame, M4(0, 1.36, -0.84 - k * 0.06, -1.9 - k * 0.1, 0, 0)));      // flame tail
  return { head: merge(h), body: merge(b) };
}

// ---------------------------------------------------------------------------------------------------------------------
interface Flyer { obj: THREE.Mesh; cx: number; cz: number; r: number; ang: number; w: number; alt: number; altA: number; kind: 'dragon' | 'phoenix' | 'whale' }
interface Swimmer { obj: THREE.Mesh; cx: number; cz: number; r: number; ang: number; w: number; depth: number; dive: number; kind: 'serpent' | 'whale' }

export class Creatures {
  readonly group = new THREE.Group();
  private flyers: Flyer[] = [];
  private swim: Swimmer[] = [];
  private steeds: { h: Horse; home: { x: number; z: number; r: number } }[] = [];
  private koi: THREE.InstancedMesh; private koiState: { x: number; z: number; t: number; dur: number; yaw: number; h: number }[] = [];
  private jelly: THREE.InstancedMesh; private jellyPos: { x: number; z: number; ph: number }[] = [];
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private e = new THREE.Euler(); private v = new THREE.Vector3(); private s = new THREE.Vector3(1, 1, 1);
  private seaT = 0; private seaX = 1e9; private seaZ = 1e9;

  constructor(private ramp: THREE.Texture, horseMat: THREE.Material) {
    const glow = new THREE.MeshBasicMaterial({ vertexColors: true });
    for (let i = 0; i < 3; i++) {
      const len = 46 + i * 12, { mat } = waveMaterial(ramp, { len, ax: len * 0.05, ay: len * 0.035, wl: len * 0.42, sp: 0.55 });
      const obj = new THREE.Mesh(dragonGeo(i, len), mat); obj.frustumCulled = false; obj.castShadow = true;
      this.add({ obj, cx: 0, cz: 0, r: 260 + i * 110, ang: i * 2.1, w: (i % 2 ? -1 : 1) * (14 + i * 2) / (260 + i * 110), alt: 130 + i * 45, altA: 25, kind: 'dragon' });
    }
    { const { mat } = waveMaterial(ramp, { len: 14, ax: 0.25, ay: 0.4, wl: 12, sp: 0.6, flap: 0.7, flapHz: 0.9, wingX: 0.55, basic: true });
      const obj = new THREE.Mesh(phoenixGeo(), mat); obj.frustumCulled = false;
      this.add({ obj, cx: 0, cz: 0, r: 330, ang: 1, w: 22 / 330, alt: 160, altA: 40, kind: 'phoenix' }); }
    for (let i = 0; i < 2; i++) {
      const { mat } = waveMaterial(ramp, { len: 32, ax: 0.4, ay: 1.4, wl: 40, sp: 0.12 });
      const obj = new THREE.Mesh(whaleGeo(true), mat); obj.frustumCulled = false; obj.scale.setScalar(1.6 + i * 0.5);
      this.add({ obj, cx: 0, cz: 0, r: 520 + i * 260, ang: i * 3, w: 9 / (520 + i * 260), alt: 330 + i * 90, altA: 20, kind: 'whale' });
    }
    { const { mat } = waveMaterial(ramp, { len: 110, ax: 5, ay: 9, wl: 45, sp: 0.32 });
      const obj = new THREE.Mesh(serpentGeo(110), mat); obj.frustumCulled = false; obj.visible = false; this.group.add(obj);
      this.swim.push({ obj, cx: 0, cz: 0, r: 160, ang: 0, w: 9 / 160, depth: -6, dive: 0, kind: 'serpent' }); }
    { const { mat } = waveMaterial(ramp, { len: 32, ax: 0.3, ay: 1.2, wl: 40, sp: 0.18 });
      const obj = new THREE.Mesh(whaleGeo(false), mat); obj.frustumCulled = false; obj.visible = false; this.group.add(obj);
      this.swim.push({ obj, cx: 0, cz: 0, r: 120, ang: 2, w: 6 / 120, depth: -3, dive: 0, kind: 'whale' }); }
    // leaping koi and glowing jellyfish near the player's shore
    this.koi = new THREE.InstancedMesh(koiGeo(), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp }), 30); this.koi.frustumCulled = false; this.koi.count = 0;
    this.jelly = new THREE.InstancedMesh(jellyGeo(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 }), 24); this.jelly.frustumCulled = false; this.jelly.count = 0;
    this.group.add(this.koi, this.jelly);
    void glow;
    // land: qilin on God Island, spirit steeds on the peaks
    const homes: [number, number, number, boolean][] = [[GOD.x + 180, GOD.z + 260, 160, false], [GOD.x - 260, GOD.z + 120, 140, false], [-1900 - 200, 1900 - 150, 160, true], [-1900 + 260, 1900 + 220, 160, true]];
    homes.forEach(([x, z, r, snow], i) => {
      for (let k = 0; k < 2; k++) {
        const h = new Horse(horseMat, snow ? 7 : 6, { x, z, r }, 9000 + i * 31 + k * 7);
        const ex = steedExtras(snow), mt = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp });
        h.head.add(new THREE.Mesh(ex.head, mt)); h.bodyG.add(new THREE.Mesh(ex.body, mt));
        h.root.scale.multiplyScalar(1.15);
        this.group.add(h.root); this.steeds.push({ h, home: { x, z, r } });
      }
    });
  }
  private add(f: Flyer): void { this.group.add(f.obj); this.flyers.push(f); }

  update(dt: number, px: number, py: number, pz: number, timeSec: number): void {
    void timeSec; void py;
    // flyers circle a centre that drifts after the player
    for (const f of this.flyers) {
      const d = Math.hypot(f.cx - px, f.cz - pz);
      if (d > 700) { f.cx = px + (f.cx - px) * 0.2; f.cz = pz + (f.cz - pz) * 0.2; }
      f.cx += (px - f.cx) * Math.min(1, dt * 0.01); f.cz += (pz - f.cz) * Math.min(1, dt * 0.01);
      f.ang += f.w * dt;
      const wob = Math.sin(f.ang * 2.3) * 0.25, r = f.r * (1 + 0.15 * Math.sin(f.ang * 1.7));
      const x = f.cx + Math.cos(f.ang) * r, z = f.cz + Math.sin(f.ang) * r;
      const ground = Math.max(0, heightAt(x, z));
      const y = Math.max(ground + 50, f.alt + f.altA * Math.sin(f.ang * 3.1));
      // heading = path tangent (+ a weave), pitch from the climb rate
      const tx = -Math.sin(f.ang) * Math.sign(f.w), tz = Math.cos(f.ang) * Math.sign(f.w);
      const yaw = Math.atan2(tx, tz) + wob * 0.3, climb = f.altA * 3.1 * Math.cos(f.ang * 3.1) * f.w / Math.max(1e-3, Math.abs(f.w * r));
      f.obj.position.set(x, y, z);
      f.obj.rotation.set(-Math.atan(climb) * 0.6, yaw, -Math.sign(f.w) * (f.kind === 'whale' ? 0.08 : 0.3), 'YXZ');
    }
    // sea creatures: find open water near the player now and then
    this.seaT -= dt;
    if (this.seaT <= 0) {
      this.seaT = 3;
      if (Math.hypot(this.seaX - px, this.seaZ - pz) > 700) {
        let found = false;
        for (let k = 0; k < 36 && !found; k++) {
          const a = (k / 36) * TAU, r = 260 + (k % 4) * 90, x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
          let ok = true; for (let j = 0; j < 8; j++) { const b = (j / 8) * TAU; if (heightAt(x + Math.cos(b) * 170, z + Math.sin(b) * 170) > -6) { ok = false; break; } }
          if (ok) { this.seaX = x; this.seaZ = z; found = true; }
        }
        if (!found) { this.seaX = 1e9; this.seaZ = 1e9; }
        this.swim[0].cx = this.seaX; this.swim[0].cz = this.seaZ; this.swim[1].cx = this.seaX + 60; this.swim[1].cz = this.seaZ - 40;
        this.placeShore(px, pz);
      }
    }
    for (const s of this.swim) {
      const on = this.seaX < 1e8 && Math.hypot(s.cx - px, s.cz - pz) < 1400;
      s.obj.visible = on; if (!on) continue;
      s.ang += s.w * dt;
      const x = s.cx + Math.cos(s.ang) * s.r, z = s.cz + Math.sin(s.ang) * s.r;
      // surface for a while, then dive (the whale also breaches gently)
      s.dive += dt;
      const cyc = (s.dive % 40) / 40, under = s.kind === 'serpent' ? -2.5 - 7 * Math.max(0, Math.sin(cyc * TAU)) : -1.5 - 8 * Math.max(0, Math.sin(cyc * TAU - 1));
      const yaw = Math.atan2(-Math.sin(s.ang), Math.cos(s.ang));
      s.obj.position.set(x, under, z); s.obj.rotation.set(0, yaw, 0);
    }
    // koi leap in arcs out of the water; jellyfish pulse near the surface
    let n = 0;
    for (const k of this.koiState) {
      k.t += dt; if (k.t > k.dur + 2 + (k.h % 1) * 4) { k.t = 0; k.yaw = Math.random() * TAU; }
      const u = k.t / k.dur; if (u > 1) continue;
      const fx = k.x + Math.sin(k.yaw) * u * 2.4, fz = k.z + Math.cos(k.yaw) * u * 2.4, fy = Math.sin(u * Math.PI) * 1.6 - 0.2;
      this.q.setFromEuler(this.e.set(-Math.cos(u * Math.PI) * 1.1, k.yaw, 0, 'YXZ'));
      this.m.compose(this.v.set(fx, fy, fz), this.q, this.s.set(1.3, 1.3, 1.3)); this.koi.setMatrixAt(n++, this.m);
    }
    this.koi.count = n; this.koi.instanceMatrix.needsUpdate = true;
    n = 0;
    for (const j of this.jellyPos) {
      j.ph += dt; const pulse = 1 + 0.12 * Math.sin(j.ph * 2.2);
      this.q.setFromEuler(this.e.set(0, j.ph * 0.1, 0));
      this.m.compose(this.v.set(j.x + Math.sin(j.ph * 0.2) * 2, -0.8 + 0.3 * Math.sin(j.ph * 1.1), j.z), this.q, this.s.set(pulse, 1 / pulse, pulse)); this.jelly.setMatrixAt(n++, this.m);
    }
    this.jelly.count = n; this.jelly.instanceMatrix.needsUpdate = true;
    // land steeds roam their islands (only simulated when someone could see them)
    for (const { h } of this.steeds) {
      const d = Math.hypot(h.x - px, h.z - pz), vis = d < 300;
      h.root.visible = vis; if (!vis) continue;
      h.wander(dt); h.animate(dt);
    }
  }

  /** koi and jellyfish in the shallows nearest the player */
  private placeShore(px: number, pz: number): void {
    this.koiState = []; this.jellyPos = [];
    for (let k = 0; k < 140 && (this.koiState.length < 30 || this.jellyPos.length < 24); k++) {
      const a = Math.random() * TAU, r = 30 + Math.random() * 260, x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r, h = heightAt(x, z);
      if (h > -2 || h < -30 || islandAt(x, z)?.id === 'city' && h > -4) continue;
      if (this.koiState.length < 30) this.koiState.push({ x, z, t: Math.random() * 3, dur: 0.9 + Math.random() * 0.5, yaw: Math.random() * TAU, h: Math.random() * 10 });
      else this.jellyPos.push({ x, z, ph: Math.random() * 10 });
    }
  }
}
