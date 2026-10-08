/** Player, simulation-LOD NPC crowd, hierarchical traffic and remote players. All instanced, no per-frame allocation. */
import * as THREE from 'three/webgpu';
import { Assets } from '../rendering/assets';
import { blocked, heightAt, inCity, mulberry32 } from '../world/terrain';
import type { Network } from '../network/network';

const O = new THREE.Object3D();
const PALETTE = [0xc8283c, 0x2b3d8f, 0xe9dfc8, 0x25c8e6, 0x8f3dd1, 0xf0a030, 0x2a2f3d].map((h) => new THREE.Color(h));

export class Player {
  readonly group = new THREE.Group();
  x = -60; z = 40; y = 0; vy = 0; vx = 0; vz = 0; yaw = 0;
  grounded = true;
  constructor(assets: Assets) {
    const body = new THREE.Mesh(assets.person.clone().scale(1.15, 1.15, 1.15), new THREE.MeshStandardMaterial({ color: 0xff3d6e, roughness: 0.6 }));
    body.castShadow = true;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.2), assets.glow);
    visor.position.set(0, 1.55, 0.22);
    this.group.add(body, visor);
    this.y = heightAt(this.x, this.z);
  }
  sync(): void { this.group.position.set(this.x, this.y, this.z); this.group.rotation.y = this.yaw; }
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
