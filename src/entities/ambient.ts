/**
 * People out enjoying the world:
 *  - paragliders thermalling over the hills under bright ram-air canopies, pilot hanging in the harness;
 *  - kitesurfers carving back and forth off the beaches, pulled by kites on long lines, throwing spray;
 *  - light aircraft with spinning propellers flying circuits overhead;
 *  - beach life: volleyball games with the ball flying between players, sunbathers under umbrellas, swimmers.
 * Everything streams around the player (recycled when far away), so there is always something going on.
 */
import * as THREE from 'three/webgpu';
import { loft, ends } from './sculpt';
import { heightAt } from '../world/terrain';
import { NET, blocked, covered } from '../world/layout';
import { Act, type Townsfolk } from './npcs';

const TAU = Math.PI * 2;
const CANOPY = [[0xff3d6e, 0xffd84a], [0x2a6ad8, 0xf4f2ec], [0x2fbf6a, 0xffd84a], [0xff8a2a, 0x7a3ad8], [0x27b9c9, 0xff3d6e], [0xe83a3a, 0xf4f2ec]];

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
function prim(g: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));
  const c = new THREE.Color(color), n = g.getAttribute('position').count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** small person in a fixed pose: 'hang' (seated in a harness), 'surf' (leaning back, knees bent), 'pilot' (seated) */
function figure(top: number, bottom: number, hair: number, pose: 'hang' | 'surf'): THREE.BufferGeometry[] {
  const g: THREE.BufferGeometry[] = [], skin = 0xf2c8a8;
  const lean = pose === 'surf' ? -0.35 : 0.15;
  g.push(loft({ path: [[0, 0.95, 0], [0, 1.25, Math.sin(lean) * 0.3], [0, 1.45, Math.sin(lean) * 0.5]], steps: 6, seg: 10, r: (t) => [0.17 - 0.03 * t, 0.12], color: top }));
  const hx = Math.sin(lean) * 0.6;
  g.push(prim(new THREE.SphereGeometry(0.13, 10, 8), skin, 0, 1.62, hx), prim(new THREE.SphereGeometry(0.14, 10, 6, 0, TAU, 0, 1.4), hair, 0, 1.65, hx - 0.01));
  if (pose === 'surf') g.push(prim(new THREE.SphereGeometry(0.15, 10, 6, 0, TAU, 0, 1.2), 0x1a1a22, 0, 1.68, hx)); // helmet
  for (const s of [-1, 1]) {
    if (pose === 'hang') {
      g.push(loft({ path: [[s * 0.1, 0.95, 0], [s * 0.12, 0.92, 0.42], [s * 0.12, 0.5, 0.5]], steps: 6, seg: 8, r: () => 0.065, color: bottom }));
      g.push(loft({ path: [[s * 0.2, 1.4, 0.02], [s * 0.3, 1.6, 0.05], [s * 0.3, 1.95, 0.0]], steps: 6, seg: 6, r: () => 0.045, color: top }));        // hands up on the brakes
    } else {
      g.push(loft({ path: [[s * 0.1, 0.95, 0], [s * 0.14, 0.55, 0.18], [s * 0.16, 0.12, 0.02]], steps: 6, seg: 8, r: () => 0.07, color: bottom }));
      g.push(loft({ path: [[s * 0.2, 1.38, 0.06], [s * 0.18, 1.3, 0.36], [s * 0.06, 1.28, 0.6]], steps: 6, seg: 6, r: () => 0.045, color: top }));     // arms forward on the bar
    }
  }
  return g;
}

/** ram-air canopy: an arched wing of cells (span along x), chord along z */
function canopyGeo(span: number, chord: number, c1: number, c2: number): THREE.BufferGeometry {
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= 12; i++) { const a = -0.9 + (i / 12) * 1.8; pts.push([Math.sin(a) * span * 0.55, Math.cos(a) * span * 0.32, 0]); }
  return merge([loft({
    path: pts, steps: 30, seg: 10, up: [0, 0, 1],
    r: (t) => [chord * 0.1 * ends(t, 0.04, 0.04) + 0.01, chord * 0.5 * (0.75 + 0.25 * Math.sin(Math.PI * t))],
    color: (t, _a, _p, out) => { out.setHex(Math.floor(t * 9) % 2 ? c1 : c2); },
  })]);
}

function planeGeo(c: number): { body: THREE.BufferGeometry; prop: THREE.BufferGeometry } {
  const g: THREE.BufferGeometry[] = [], w = 0xf4f6f8;
  g.push(loft({ path: [[0, 1.0, 2.6], [0, 1.1, 1.0], [0, 1.15, -1.5], [0, 1.35, -4.6]], steps: 16, seg: 12, r: (t) => { const k = ends(t, 0.12, 0); return [(0.62 - 0.45 * t) * k + 0.05, (0.7 - 0.45 * t) * k + 0.05]; }, color: (t, a, _p, out) => { out.setHex(Math.abs(Math.sin(a) + 0.1) < 0.12 ? c : w); } }));
  g.push(prim(new THREE.BoxGeometry(10.4, 0.14, 1.5), w, 0, 1.85, 0.6), prim(new THREE.BoxGeometry(10.4, 0.15, 0.25), c, 0, 1.86, -0.05));             // high wing with coloured trailing strip
  g.push(prim(new THREE.BoxGeometry(1.0, 0.5, 0.9), 0x2a4a6a, 0, 1.6, 1.0));                                                                       // cabin glass
  g.push(prim(new THREE.BoxGeometry(3.4, 0.1, 0.8), w, 0, 1.4, -4.3), prim(new THREE.BoxGeometry(0.1, 1.2, 1.0), c, 0, 1.95, -4.35));               // tailplane + fin
  for (const s of [-1, 1]) g.push(prim(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 5), 0x8a8e96, s * 0.6, 1.3, 0.8, 0, 0, s * 0.5), prim(new THREE.CylinderGeometry(0.28, 0.28, 0.14, 10), 0x1a1a1e, s * 0.95, 0.5, 0.9, 0, 0, Math.PI / 2));
  g.push(prim(new THREE.ConeGeometry(0.24, 0.4, 10), c, 0, 1.0, 2.8, Math.PI / 2));
  const prop = merge([prim(new THREE.BoxGeometry(2.0, 0.16, 0.05), 0x2a2a30), prim(new THREE.BoxGeometry(0.16, 2.0, 0.05), 0x2a2a30)]);
  return { body: merge(g), prop };
}

interface Glider { obj: THREE.Group; cx: number; cz: number; r: number; ang: number; w: number; alt: number }
interface Surfer { obj: THREE.Group; x0: number; z0: number; dx: number; dz: number; len: number; u: number; dir: number; kite: THREE.Object3D }
interface Plane { obj: THREE.Group; prop: THREE.Mesh; cx: number; cz: number; r: number; ang: number; w: number; alt: number }
interface Kite { obj: THREE.Mesh; line: THREE.Line; hand: THREE.Vector3; yaw: number; ph: number; h: number }
interface Beach { x: number; z: number; yaw: number; ball: THREE.Mesh; set: THREE.Group; pa: THREE.Vector3; pb: THREE.Vector3; t: number }

export class Ambient {
  readonly group = new THREE.Group();
  private mat: THREE.MeshToonMaterial;
  private kites: Kite[] = []; private park: { x: number; z: number; set: THREE.Group } | null = null;
  private gliders: Glider[] = []; private surfers: Surfer[] = []; private planes: Plane[] = []; private beaches: Beach[] = [];
  private scanT = 0; private lastX = 1e9; private lastZ = 1e9;
  private lineMat = new THREE.LineBasicMaterial({ color: 0x404048, transparent: true, opacity: 0.6 });

  constructor(ramp: THREE.Texture, private folk: Townsfolk) {
    this.mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp });
    for (let i = 0; i < 6; i++) {
      const [c1, c2] = CANOPY[i], obj = new THREE.Group();
      const can = new THREE.Mesh(canopyGeo(10, 2.6, c1, c2), this.mat); can.position.y = 7.2; obj.add(can);
      const pil = new THREE.Mesh(merge(figure([0xe83a3a, 0x2a6ad8, 0x1a1a22][i % 3], 0x2a2a36, 0x2a1a14, 'hang')), this.mat); pil.position.y = -1.0; obj.add(pil);
      const lines: number[] = [];
      for (let k = 0; k <= 8; k++) { const a = -0.9 + (k / 8) * 1.8; lines.push(0, 0.95, 0, Math.sin(a) * 5.5, 7.2 + Math.cos(a) * 3.2 - 0.1, 0); }
      obj.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)), this.lineMat));
      this.group.add(obj); this.gliders.push({ obj, cx: 1e9, cz: 1e9, r: 70, ang: 0, w: 0.1, alt: 120 });
    }
    for (let i = 0; i < 4; i++) {
      const [c1, c2] = CANOPY[(i + 2) % CANOPY.length], obj = new THREE.Group();
      obj.add(new THREE.Mesh(merge([prim(new THREE.BoxGeometry(0.45, 0.06, 1.5), 0xf4f2ec, 0, 0.03, 0), ...figure([0x27b9c9, 0xff8a2a, 0x2a2a36, 0xe83a3a][i], 0x1a1a22, 0x14122a, 'surf'),
        prim(new THREE.ConeGeometry(0.6, 2.2, 8, 1, true), 0xf4fbff, 0, 0.3, -1.4, -Math.PI / 2 - 0.25)]), this.mat));
      const kite = new THREE.Mesh(canopyGeo(7, 1.8, c1, c2), this.mat); kite.position.set(0, 16, 9); kite.rotation.x = -0.5; obj.add(kite);
      const ln = [0, 1.3, 0.6, -2.2, 16, 9, 0, 1.3, 0.6, 2.2, 16, 9];
      obj.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(ln, 3)), this.lineMat));
      this.group.add(obj); this.surfers.push({ obj, x0: 1e9, z0: 1e9, dx: 1, dz: 0, len: 150, u: Math.random(), dir: 1, kite });
    }
    for (let i = 0; i < 4; i++) {
      const { body, prop } = planeGeo([0xc8283c, 0x2a6ad8, 0xf2c83a, 0x2f9a5a][i]), obj = new THREE.Group();
      obj.add(new THREE.Mesh(body, this.mat)); const pm = new THREE.Mesh(prop, this.mat); pm.position.set(0, 1.0, 3.05); obj.add(pm);
      obj.scale.setScalar(1.3);
      this.group.add(obj); this.planes.push({ obj, prop: pm, cx: 1e9, cz: 1e9, r: 500 + i * 160, ang: i * 1.7, w: (i % 2 ? -1 : 1) * 45 / (500 + i * 160), alt: 220 + i * 50 });
    }
    this.group.traverse((o) => { o.frustumCulled = false; });
  }

  update(dt: number, px: number, py: number, pz: number, timeSec: number, hour: number): void {
    void py;
    const day = hour > 7 && hour < 19;
    this.scanT -= dt;
    if (this.scanT <= 0 || Math.hypot(px - this.lastX, pz - this.lastZ) > 600) { this.scanT = 4; this.respawn(px, pz, day); this.lastX = px; this.lastZ = pz; }
    for (const g of this.gliders) {
      if (g.cx > 1e8) { g.obj.visible = false; continue; }
      g.obj.visible = day; g.ang += g.w * dt;
      const x = g.cx + Math.cos(g.ang) * g.r, z = g.cz + Math.sin(g.ang) * g.r, ground = Math.max(0, heightAt(x, z));
      const y = Math.max(ground + 40, g.alt + 20 * Math.sin(timeSec * 0.05 + g.r));
      g.obj.position.set(x, y, z);
      g.obj.rotation.set(0, Math.atan2(-Math.sin(g.ang) * Math.sign(g.w), Math.cos(g.ang) * Math.sign(g.w)), -Math.sign(g.w) * 0.22, 'YXZ');
    }
    for (const s of this.surfers) {
      if (s.x0 > 1e8) { s.obj.visible = false; continue; }
      s.obj.visible = day;
      s.u += s.dir * dt * 9 / s.len; if (s.u > 1 || s.u < 0) { s.dir = -s.dir; s.u = Math.max(0, Math.min(1, s.u)); }
      const x = s.x0 + s.dx * (s.u - 0.5) * s.len, z = s.z0 + s.dz * (s.u - 0.5) * s.len;
      s.obj.position.set(x, 0.05 + 0.08 * Math.sin(timeSec * 3 + s.len), z);
      const yaw = Math.atan2(s.dx * s.dir, s.dz * s.dir);
      s.obj.rotation.set(0, yaw, s.dir * 0.25, 'YXZ');
      s.kite.position.x = -s.dir * 6 + 2 * Math.sin(timeSec * 0.7); s.kite.rotation.z = 0.25 * Math.sin(timeSec * 0.7);
    }
    for (const p of this.planes) {
      if (p.cx > 1e8 || Math.hypot(p.cx - px, p.cz - pz) > 900) { p.cx = px; p.cz = pz; }
      p.ang += p.w * dt; p.prop.rotation.z += dt * 40;
      const x = p.cx + Math.cos(p.ang) * p.r, z = p.cz + Math.sin(p.ang) * p.r;
      p.obj.position.set(x, Math.max(heightAt(x, z) + 120, p.alt), z);
      p.obj.rotation.set(0, Math.atan2(-Math.sin(p.ang) * Math.sign(p.w), Math.cos(p.ang) * Math.sign(p.w)), -Math.sign(p.w) * 0.35, 'YXZ');
    }
    for (const k of this.kites) {
      // kites hang downwind, swooping and swaying on the breeze; the line runs from the child's hand
      const sw = Math.sin(timeSec * 0.9 + k.ph), sw2 = Math.sin(timeSec * 1.7 + k.ph * 2);
      const kx = k.hand.x + Math.sin(k.yaw) * 20 + Math.cos(k.yaw) * sw * 5, kz = k.hand.z + Math.cos(k.yaw) * 20 - Math.sin(k.yaw) * sw * 5, ky = k.hand.y + k.h + sw2 * 2.5;
      k.obj.position.set(kx, ky, kz); k.obj.rotation.set(-0.5 + sw2 * 0.15, k.yaw, sw * 0.5, 'YXZ');
      const lp = k.line.geometry.getAttribute('position') as THREE.BufferAttribute; lp.setXYZ(1, kx, ky - 0.6, kz); lp.needsUpdate = true;
    }
    for (const b of this.beaches) {
      // the volleyball arcs back and forth over the net between the two teams
      b.t += dt; const u = (b.t % 2.2) / 2.2, leg = Math.floor(b.t / 2.2) % 2;
      const a = leg ? b.pb : b.pa, c = leg ? b.pa : b.pb;
      b.ball.position.lerpVectors(a, c, u); b.ball.position.y += Math.sin(u * Math.PI) * 5;
    }
  }

  /** (re)place activities around the player: hills for gliders, coast for kites and beach life */
  private respawn(px: number, pz: number, day: number | boolean): void {
    const rnd = Math.random;
    this.placePark(px, pz, !!day);
    for (const g of this.gliders) {
      if (g.cx < 1e8 && Math.hypot(g.cx - px, g.cz - pz) < 900) continue;
      g.cx = 1e9;
      for (let k = 0; k < 30; k++) {
        const a = rnd() * TAU, r = 200 + rnd() * 500, x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r, h = heightAt(x, z);
        if (h < 25) continue;
        g.cx = x; g.cz = z; g.r = 50 + rnd() * 90; g.w = (rnd() < 0.5 ? -1 : 1) * (9 / g.r); g.alt = h + 90 + rnd() * 120; break;
      }
    }
    const shore: [number, number, number][] = [];
    for (let k = 0; k < 120 && shore.length < 12; k++) {
      const a = rnd() * TAU, r = 80 + rnd() * 700, x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r, h = heightAt(x, z);
      if (h < -3 || h > -0.5) continue;
      // direction to the nearest land = toward the beach; surf parallel to it
      let best = -1, bx = 0, bz = 0;
      for (let j = 0; j < 12; j++) { const b = (j / 12) * TAU, q = heightAt(x + Math.cos(b) * 40, z + Math.sin(b) * 40); if (q > best) { best = q; bx = Math.cos(b); bz = Math.sin(b); } }
      if (best > 0.3) shore.push([x, z, Math.atan2(bx, bz)]);
    }
    this.surfers.forEach((s, i) => {
      if (s.x0 < 1e8 && Math.hypot(s.x0 - px, s.z0 - pz) < 1000) return;
      const sp = shore[i]; if (!sp) { s.x0 = 1e9; return; }
      const [x, z, toLand] = sp, along = toLand + Math.PI / 2;
      s.x0 = x - Math.sin(toLand) * 50; s.z0 = z - Math.cos(toLand) * 50; s.dx = Math.sin(along); s.dz = Math.cos(along); s.len = 120 + rnd() * 80;
    });
    // beach scenes (only one at a time near the player, rebuilt when the player moves on)
    if (this.beaches.length && Math.hypot(this.beaches[0].x - px, this.beaches[0].z - pz) < 700) return;
    for (const b of this.beaches) this.group.remove(b.set);
    this.beaches = []; this.folk.unpinAll('beach');
    if (!day) return;
    for (let k = 0; k < 160; k++) {
      const a = rnd() * TAU, r = 60 + rnd() * 450, x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r, h = heightAt(x, z);
      if (h < 0.3 || h > 2.2) continue;
      let wx = 0, wz = 0, n = 0;
      for (let j = 0; j < 12; j++) { const b = (j / 12) * TAU; if (heightAt(x + Math.cos(b) * 30, z + Math.sin(b) * 30) < -0.5) { wx += Math.cos(b); wz += Math.sin(b); n++; } }
      if (!n || n > 6) continue;
      this.makeBeach(x, z, Math.atan2(wx, wz));
      break;
    }
  }

  /** kids flying kites and families picnicking on an open meadow or park near the player (daytime) */
  private placePark(px: number, pz: number, day: boolean): void {
    if (this.park && Math.hypot(this.park.x - px, this.park.z - pz) < 600 && day) return;
    if (this.park) { this.group.remove(this.park.set); this.park = null; }
    this.kites = []; this.folk.unpinAll('park');
    if (!day) return;
    const rnd = Math.random;
    for (let k = 0; k < 200; k++) {
      const a = rnd() * TAU, r = 40 + rnd() * 320, x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r, h = heightAt(x, z);
      if (h < 3 || h > 90) continue;
      let ok = true;
      for (let j = 0; j < 8 && ok; j++) { const b = (j / 8) * TAU, q = heightAt(x + Math.cos(b) * 25, z + Math.sin(b) * 25); if (Math.abs(q - h) > 4 || q < 2) ok = false; }
      if (!ok || blocked(x, z) || NET.edgeDist(x, z, 14) < 8 || covered(x, z)) continue;
      const set = new THREE.Group(), wind = rnd() * TAU, geos: THREE.BufferGeometry[] = [];
      const lineMat = new THREE.LineBasicMaterial({ color: 0xf4f2ec, transparent: true, opacity: 0.7 });
      for (let i = 0; i < 4; i++) {
        const kx = x + (rnd() - 0.5) * 30, kz = z + (rnd() - 0.5) * 30, ky = heightAt(kx, kz);
        this.folk.pin(kx, ky, kz, wind, Act.Kite, rnd() < 0.5 ? 0 : 1, 0, 'park', 0.66 + rnd() * 0.08);
        const [c1, c2] = CANOPY[(i + 1) % CANOPY.length];
        const kg = new THREE.BufferGeometry();
        kg.setAttribute('position', new THREE.Float32BufferAttribute([0, 1.1, 0, -0.75, 0, 0, 0, -1.3, 0, 0.75, 0, 0], 3));
        const cA = new THREE.Color(c1), cB = new THREE.Color(c2);
        kg.setAttribute('color', new THREE.Float32BufferAttribute([cA.r, cA.g, cA.b, cB.r, cB.g, cB.b, cA.r, cA.g, cA.b, cB.r, cB.g, cB.b], 3));
        kg.setIndex([0, 1, 2, 0, 2, 3]); kg.computeVertexNormals();
        const kite = new THREE.Mesh(kg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
        // tail of little bows
        for (let t = 1; t <= 6; t++) { const bow = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 0.18), new THREE.MeshBasicMaterial({ color: t % 2 ? c1 : c2, side: THREE.DoubleSide })); bow.position.set(Math.sin(t) * 0.3, -1.3 - t * 0.55, 0); kite.add(bow); }
        const hand = new THREE.Vector3(kx, ky + 1.6, kz);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([hand, hand]), lineMat);
        set.add(kite, line);
        this.kites.push({ obj: kite, line, hand, yaw: wind, ph: rnd() * 6, h: 18 + rnd() * 10 });
      }
      // a picnic or two: blanket, basket, a family sitting on the grass
      for (let i = 0; i < 2; i++) {
        const bx = x + (rnd() - 0.5) * 36, bz = z + (rnd() - 0.5) * 36, by = heightAt(bx, bz), c = [0xd8283c, 0x2a6ad8][i];
        const bl = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.04, 2.0), new THREE.MeshToonMaterial({ color: c })); bl.position.set(bx, by + 0.03, bz); set.add(bl);
        const bk = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.35), new THREE.MeshToonMaterial({ color: 0x9a6a3a })); bk.position.set(bx + 0.4, by + 0.2, bz + 0.2); set.add(bk);
        for (let j = 0; j < 3; j++) { const aa = (j / 3) * TAU; this.folk.pin(bx + Math.cos(aa) * 0.9, by, bz + Math.sin(aa) * 0.75, Math.atan2(-Math.cos(aa), -Math.sin(aa)), j === 2 ? Act.Lie : Act.Sit, -1, j === 2 ? 0.05 : -0.38, 'park', j === 1 ? 0.7 : 0); }
      }
      set.traverse((o) => { o.frustumCulled = false; });
      this.group.add(set); this.park = { x, z, set };
      break;
    }
  }

  private makeBeach(x: number, z: number, seaYaw: number): void {
    const set = new THREE.Group(), c = Math.cos(seaYaw), s = Math.sin(seaYaw);
    const W = (lx: number, lz: number) => new THREE.Vector3(x + lx * c + lz * s, 0, z - lx * s + lz * c);
    const at = (lx: number, lz: number) => { const p = W(lx, lz); p.y = heightAt(p.x, p.z); return p; };
    const geos: THREE.BufferGeometry[] = [];
    // volleyball court: net between two posts, perpendicular to the shore
    const n0 = at(-4.5, 0), n1 = at(4.5, 0), y0 = (n0.y + n1.y) / 2;
    const L = (v: THREE.Vector3) => [v.x - x, v.y - y0, v.z - z] as [number, number, number];
    for (const p of [n0, n1]) geos.push(prim(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6), 0xd8d4cc, ...L(p).map((q, i) => (i === 1 ? q + 1.3 : q)) as [number, number, number]));
    const net = new THREE.PlaneGeometry(9, 1, 1, 1); geos.push(prim(net, 0xf4f2ec, (n0.x + n1.x) / 2 - x, 2.0, (n0.z + n1.z) / 2 - z, 0, seaYaw + Math.PI / 2, 0));
    // umbrellas and towels further up the sand
    for (let k = 0; k < 4; k++) {
      const p = at(-12 + k * 6, -9);
      geos.push(prim(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 5), 0xd8d4cc, p.x - x, p.y - y0 + 1.2, p.z - z));
      geos.push(prim(new THREE.ConeGeometry(1.6, 0.7, 10, 1, true), [0xff3d6e, 0x2a6ad8, 0xffd84a, 0x2fbf6a][k], p.x - x, p.y - y0 + 2.5, p.z - z));
      const t = at(-12 + k * 6, -11); geos.push(prim(new THREE.BoxGeometry(0.9, 0.02, 1.9), [0xf4f2ec, 0xff8a2a, 0x27b9c9, 0xd83a9a][k], t.x - x, t.y - y0 + 0.03, t.z - z, 0, seaYaw, 0));
      this.folk.pin(t.x, t.y, t.z, seaYaw + Math.PI, Act.Lie, -1, 0.05, 'beach');
    }
    const mesh = new THREE.Mesh(merge(geos), new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.position.set(x, y0, z); set.add(mesh);
    // players on both sides of the net, swimmers in the shallows
    for (const [lx, lz] of [[-2, -4], [2, -3.5], [-2, 4], [2, 3.5]]) { const p = at(lx, lz); this.folk.pin(p.x, p.y, p.z, Math.atan2(-(p.x - (n0.x + n1.x) / 2), -(p.z - (n0.z + n1.z) / 2)), Act.Play, -1, 0, 'beach'); }
    for (let k = 0; k < 4; k++) { const p = W(-8 + k * 5, 22 + (k % 2) * 6); this.folk.pin(p.x, 0, p.z, seaYaw + Math.PI + (k - 1.5) * 0.4, Act.Swim, -1, 0, 'beach'); }
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshToonMaterial({ color: 0xffd84a })); set.add(ball);
    const pa = at(0, -3.8), pb = at(0, 3.8); pa.y += 2.2; pb.y += 2.2;
    this.group.add(set);
    this.beaches.push({ x, z, yaw: seaYaw, ball, set, pa, pb, t: 0 });
  }
}
