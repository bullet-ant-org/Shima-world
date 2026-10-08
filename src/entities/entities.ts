/** Player, simulation-LOD NPC crowd, hierarchical traffic and remote players. All instanced, no per-frame allocation. */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Assets, box, paint } from '../rendering/assets';
import { blocked, heightAt, inCity, mulberry32 } from '../world/terrain';
import type { Network } from '../network/network';

const O = new THREE.Object3D();
const PALETTE = [0xc8283c, 0x2b3d8f, 0xe9dfc8, 0x25c8e6, 0x8f3dd1, 0xf0a030, 0x2a2f3d].map((h) => new THREE.Color(h));

/**
 * "Ronin" — the test character: a cyber-samurai in an indigo jacket, red sash and glowing cyan trim, katana on the back.
 * 11 meshes, 2 shared materials; limbs are pivoted groups driven by a tiny procedural walk/run/jump animator.
 */
export class Player {
  readonly group = new THREE.Group();
  x = 0; z = 0; y = 0; vy = 0; vx = 0; vz = 0; yaw = 0;
  grounded = true;
  private body = new THREE.Group();
  private head = new THREE.Group();
  private armL = new THREE.Group(); private armR = new THREE.Group();
  private legL = new THREE.Group(); private legR = new THREE.Group();
  private scarf = new THREE.Group(); private tail = new THREE.Group();
  private phase = 0; private clock = 0;

  constructor(assets: Assets, spawn: { x: number; z: number }) {
    const lit = assets.props, glow = assets.pillarGlow;
    const part = (geos: THREE.BufferGeometry[], mat: THREE.Material, parent: THREE.Object3D) => {
      const m = new THREE.Mesh(mergeGeometries(geos)!, mat); m.castShadow = true; parent.add(m); return m;
    };
    const JACKET = 0x1f2547, SASH = 0xc8283c, SKIN = 0xf2c7a5, HAIR = 0x14121c, PANTS = 0x232a4a, BOOT = 0x15161c;

    this.group.add(this.body);
    this.body.position.y = 0.95;
    // torso, collar, sash, hip guard, katana sheath
    part([
      box(0.5, 0.55, 0.28, 0, 0.32, 0, JACKET), box(0.54, 0.12, 0.32, 0, 0.04, 0, SASH), box(0.18, 0.3, 0.06, 0.2, -0.12, 0.17, SASH),
      box(0.56, 0.16, 0.34, 0, -0.08, 0, PANTS), box(0.46, 0.08, 0.3, 0, 0.62, 0, 0x2d3566),
      (() => { const g = new THREE.BoxGeometry(0.06, 0.07, 1.15); g.rotateX(0.0); g.rotateZ(0.7); g.translate(0.02, 0.4, -0.22); return paint(g, 0x0c0c12); })(),
      (() => { const g = new THREE.BoxGeometry(0.08, 0.16, 0.08); g.rotateZ(0.7); g.translate(-0.28, 0.72, -0.22); return paint(g, SASH); })(),
    ], lit, this.body);
    // glowing chest trim + katana edge
    part([box(0.04, 0.4, 0.02, -0.14, 0.34, 0.15, 0x40e8ff), box(0.04, 0.4, 0.02, 0.14, 0.34, 0.15, 0x40e8ff), box(0.5, 0.025, 0.02, 0, 0.55, 0.15, 0x40e8ff),
      (() => { const g = new THREE.BoxGeometry(0.02, 0.02, 1.0); g.rotateZ(0.7); g.translate(0.04, 0.42, -0.2); return paint(g, 0x40e8ff); })()], glow, this.body);

    // head: face, hair, headband glow, ponytail on its own pivot
    this.body.add(this.head); this.head.position.set(0, 0.8, 0);
    part([
      (() => { const g = new THREE.SphereGeometry(0.16, 10, 8); g.translate(0, 0.17, 0); return paint(g, SKIN); })(),
      (() => { const g = new THREE.SphereGeometry(0.175, 10, 8); g.scale(1, 0.75, 1.02); g.translate(0, 0.27, -0.02); return paint(g, HAIR); })(),
      box(0.34, 0.1, 0.1, 0, 0.3, 0.1, HAIR), box(0.08, 0.04, 0.02, 0.07, 0.19, 0.155, 0x0c0c12), box(0.08, 0.04, 0.02, -0.07, 0.19, 0.155, 0x0c0c12),
      box(0.1, 0.1, 0.1, 0, 0.0, 0, SKIN),
    ], lit, this.head);
    part([box(0.36, 0.035, 0.36, 0, 0.27, 0, 0x40e8ff), box(0.1, 0.03, 0.02, 0.07, 0.19, 0.162, 0x40e8ff), box(0.1, 0.03, 0.02, -0.07, 0.19, 0.162, 0x40e8ff)], glow, this.head);
    this.head.add(this.tail); this.tail.position.set(0, 0.32, -0.18);
    part([box(0.09, 0.5, 0.09, 0, -0.25, 0, HAIR), box(0.12, 0.06, 0.12, 0, -0.02, 0, SASH)], lit, this.tail);

    // scarf trailing from the neck
    this.body.add(this.scarf); this.scarf.position.set(0, 0.72, -0.14);
    part([box(0.3, 0.9, 0.04, 0, -0.45, 0, SASH), box(0.38, 0.1, 0.12, 0, 0.02, 0.1, SASH)], lit, this.scarf);

    // arms (pivot at shoulder) and legs (pivot at hip)
    for (const [arm, sx] of [[this.armL, -1], [this.armR, 1]] as const) {
      this.body.add(arm); arm.position.set(0.33 * sx, 0.58, 0);
      part([box(0.14, 0.5, 0.15, 0, -0.25, 0, JACKET), box(0.12, 0.12, 0.13, 0, -0.56, 0, SKIN), box(0.16, 0.1, 0.17, 0, -0.45, 0, 0x2d3566)], lit, arm);
    }
    for (const [leg, sx] of [[this.legL, -1], [this.legR, 1]] as const) {
      this.group.add(leg); leg.position.set(0.13 * sx, 0.92, 0);
      part([box(0.19, 0.82, 0.2, 0, -0.41, 0, PANTS), box(0.22, 0.14, 0.34, 0, -0.84, 0.05, BOOT), box(0.23, 0.04, 0.35, 0, -0.9, 0.05, SASH)], lit, leg);
    }
    this.x = spawn.x; this.z = spawn.z;
    this.y = heightAt(this.x, this.z);
  }

  teleport(x: number, z: number): void {
    this.x = x; this.z = z; this.vx = this.vz = this.vy = 0;
    this.y = Math.max(heightAt(x, z), 0); this.grounded = true;
  }

  /** Drives the pose from velocity. No allocations. */
  private animate(dt: number): void {
    this.clock += dt;
    const sp = Math.hypot(this.vx, this.vz);
    const run = sp > 6.5;
    this.phase += dt * (2.0 + sp * 0.95);
    const amp = this.grounded ? Math.min(1, sp / 4) * (run ? 1.05 : 0.7) : 0;
    const s = Math.sin(this.phase);
    const air = !this.grounded;
    this.legL.rotation.x = air ? 0.7 : s * amp * 0.95;
    this.legR.rotation.x = air ? -0.35 : -s * amp * 0.95;
    this.armL.rotation.x = air ? -1.1 : -s * amp * 0.85;
    this.armR.rotation.x = air ? -1.3 : s * amp * 0.85;
    this.armL.rotation.z = air ? -0.5 : 0.04; this.armR.rotation.z = air ? 0.5 : -0.04;
    const bob = this.grounded ? (sp > 0.5 ? Math.abs(Math.cos(this.phase)) * 0.06 * amp : Math.sin(this.clock * 2) * 0.012) : 0;
    this.body.position.y = 0.95 + bob;
    this.body.rotation.x += ((air ? 0.05 : run ? 0.22 : sp > 0.5 ? 0.07 : 0) - this.body.rotation.x) * Math.min(1, dt * 10);
    this.head.rotation.x = -this.body.rotation.x * 0.6;
    this.scarf.rotation.x = 0.15 + sp * 0.07 + Math.sin(this.clock * 6 + this.phase) * 0.05 * (0.4 + amp) + (air ? 0.3 : 0);
    this.tail.rotation.x = 0.1 + sp * 0.05 + Math.sin(this.clock * 5) * 0.06;
  }

  sync(dt: number): void {
    this.animate(dt);
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.y = this.yaw;
  }
}

/** Near = full AI each frame. Mid = updated every 4th frame. Far = recycled into a fresh near entity (statistical -> entity). */
export class NpcSystem {
  readonly mesh: THREE.InstancedMesh;
  readonly n: number;
  private px: Float32Array; private pz: Float32Array; private dx: Float32Array; private dz: Float32Array;
  private sp: Float32Array; private turn: Float32Array; private acc: Float32Array;
  private rnd = mulberry32(4242);
  private frame = 0;
  counts = { full: 0, reduced: 0, recycled: 0 };

  constructor(n: number, assets: Assets) {
    this.n = n;
    this.mesh = new THREE.InstancedMesh(assets.person, assets.agents, n);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.px = new Float32Array(n); this.pz = new Float32Array(n); this.dx = new Float32Array(n); this.dz = new Float32Array(n);
    this.sp = new Float32Array(n); this.turn = new Float32Array(n); this.acc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.mesh.setColorAt(i, PALETTE[i % PALETTE.length]);
      this.px[i] = 1e6;
    }
  }

  private spawn(i: number, cx: number, cz: number): void {
    for (let t = 0; t < 6; t++) {
      const a = this.rnd() * Math.PI * 2, d = 25 + this.rnd() * 140;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (heightAt(x, z) < 1.5 || blocked(x, z)) continue;
      this.px[i] = x; this.pz[i] = z;
      const h = this.rnd() * 6.28; this.dx[i] = Math.cos(h); this.dz[i] = Math.sin(h);
      this.sp[i] = 1.1 + this.rnd() * 1.2; this.turn[i] = 1 + this.rnd() * 5;
      return;
    }
    this.px[i] = 1e6; // no valid spot this frame; try again next recycle
  }

  update(dt: number, cx: number, cz: number): void {
    this.frame++;
    let full = 0, red = 0, rec = 0;
    for (let i = 0; i < this.n; i++) {
      const ddx = this.px[i] - cx, ddz = this.pz[i] - cz, d2 = ddx * ddx + ddz * ddz;
      if (d2 > 200 * 200) { this.spawn(i, cx, cz); rec++; }
      let step = 0;
      if (d2 < 45 * 45) { step = dt; full++; }
      else { this.acc[i] += dt; red++; if ((this.frame + i) % 4 === 0) { step = this.acc[i]; this.acc[i] = 0; } }
      if (step > 0 && this.px[i] < 1e5) {
        this.turn[i] -= step;
        if (this.turn[i] <= 0) { const h = this.rnd() * 6.28; this.dx[i] = Math.cos(h); this.dz[i] = Math.sin(h); this.turn[i] = 2 + this.rnd() * 6; }
        const nx = this.px[i] + this.dx[i] * this.sp[i] * step, nz = this.pz[i] + this.dz[i] * this.sp[i] * step;
        if (heightAt(nx, nz) < 1.2 || blocked(nx, nz)) { this.dx[i] = -this.dx[i]; this.dz[i] = -this.dz[i]; }
        else { this.px[i] = nx; this.pz[i] = nz; }
      }
      if (this.px[i] > 1e5) { O.position.set(0, -999, 0); O.scale.setScalar(0.0001); }
      else {
        O.position.set(this.px[i], heightAt(this.px[i], this.pz[i]), this.pz[i]);
        O.rotation.set(0, Math.atan2(this.dx[i], this.dz[i]), 0);
        O.scale.setScalar(1);
      }
      O.updateMatrix();
      this.mesh.setMatrixAt(i, O.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.counts.full = full; this.counts.reduced = red; this.counts.recycled = rec;
  }
}

/** Cars on the 64 m road grid. Near: signals + queuing. Mid: path following. Outside the city: nothing is simulated. */
export class TrafficSystem {
  readonly mesh: THREE.InstancedMesh;
  readonly n: number;
  private axis: Uint8Array; private lane: Float32Array; private pos: Float32Array; private dir: Float32Array; private spd: Float32Array; private cur: Float32Array;
  private active = new Uint8Array(0);
  private rnd = mulberry32(99);
  private frame = 0;
  counts = { near: 0, mid: 0 };

  constructor(n: number, assets: Assets) {
    this.n = n;
    this.mesh = new THREE.InstancedMesh(assets.car, assets.agents, n);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.mesh.frustumCulled = false;
    this.axis = new Uint8Array(n); this.lane = new Float32Array(n); this.pos = new Float32Array(n);
    this.dir = new Float32Array(n); this.spd = new Float32Array(n); this.cur = new Float32Array(n);
    this.active = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.mesh.setColorAt(i, PALETTE[(i * 3) % PALETTE.length]);
  }

  private spawn(i: number, cx: number, cz: number): void {
    this.axis[i] = this.rnd() < 0.5 ? 0 : 1;
    this.dir[i] = this.rnd() < 0.5 ? 1 : -1;
    const along = this.axis[i] === 0 ? cx : cz, across = this.axis[i] === 0 ? cz : cx;
    const line = Math.round((across + (this.rnd() - 0.5) * 300) / 64);
    const lineC = this.axis[i] === 0 ? Math.max(-7, Math.min(7, line)) : Math.max(1, Math.min(15, line));
    this.lane[i] = lineC * 64 + this.dir[i] * 3.2;
    this.pos[i] = along + (this.rnd() - 0.5) * 360;
    this.spd[i] = 9 + this.rnd() * 7; this.cur[i] = this.spd[i];
    this.active[i] = 1;
  }

  update(dt: number, cx: number, cz: number, time: number): void {
    this.frame++;
    const inside = inCity(cx, cz);
    let near = 0, mid = 0;
    const phase = Math.floor(time / 8) & 1; // signal: axis 0 green on phase 0
    for (let i = 0; i < this.n; i++) {
      if (!inside) { this.active[i] = 0; }
      else if (!this.active[i]) this.spawn(i, cx, cz);
      if (!this.active[i]) { O.position.set(0, -999, 0); O.scale.setScalar(0.0001); O.updateMatrix(); this.mesh.setMatrixAt(i, O.matrix); continue; }

      const x = this.axis[i] === 0 ? this.pos[i] : this.lane[i];
      const z = this.axis[i] === 0 ? this.lane[i] : this.pos[i];
      const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (d2 > 260 * 260) { this.active[i] = 0; this.spawn(i, cx, cz); continue; }
      const isNear = d2 < 90 * 90;
      if (isNear) near++; else mid++;
      if (isNear || (this.frame + i) % 2 === 0) {
        const step = isNear ? dt : dt * 2;
        let target = this.spd[i];
        if (isNear) { // approach the next intersection ahead: stop on red
          const p = this.pos[i], next = this.dir[i] > 0 ? Math.ceil((p + 8) / 64) * 64 : Math.floor((p - 8) / 64) * 64;
          const dist = Math.abs(next - p);
          const green = (this.axis[i] === 0) === (phase === 0);
          if (!green && dist < 16) target = dist < 9 ? 0 : 3;
        }
        this.cur[i] += (target - this.cur[i]) * Math.min(1, step * 2.5);
        this.pos[i] += this.dir[i] * this.cur[i] * step;
        const lo = this.axis[i] === 0 ? 64 : -448, hi = this.axis[i] === 0 ? 960 : 448;
        if (this.pos[i] < lo || this.pos[i] > hi) this.dir[i] = -this.dir[i];
      }
      O.position.set(x, 3.15, z);
      O.rotation.set(0, this.axis[i] === 0 ? (this.dir[i] > 0 ? 0 : Math.PI) : (this.dir[i] > 0 ? Math.PI / 2 : -Math.PI / 2), 0);
      O.scale.setScalar(1);
      O.updateMatrix();
      this.mesh.setMatrixAt(i, O.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.counts.near = near; this.counts.mid = mid;
  }
}

/** Other players inside the network interest radius. */
export class RemotePlayers {
  readonly mesh: THREE.InstancedMesh;
  count = 0;
  constructor(assets: Assets, max = 16) {
    this.mesh = new THREE.InstancedMesh(assets.person, new THREE.MeshStandardMaterial({ color: 0x25e6ff, emissive: 0x0a4a55 }), max);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }
  update(net: Network, px: number, pz: number): void {
    let i = 0;
    for (const p of net.peers.values()) {
      if (i >= this.mesh.instanceMatrix.count) break;
      if (Math.hypot(p.x - px, p.z - pz) > 400) continue; // interest management
      O.position.set(p.x, p.y, p.z); O.rotation.set(0, p.yaw, 0); O.scale.setScalar(1.15); O.updateMatrix();
      this.mesh.setMatrixAt(i++, O.matrix);
    }
    this.mesh.count = i; this.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
