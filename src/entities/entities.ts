/** Player, simulation-LOD NPC crowd, hierarchical traffic and remote players. All instanced, no per-frame allocation. */
import * as THREE from 'three/webgpu';
import { Assets } from '../rendering/assets';
import { Hero, type Mode } from './hero';
import type { Input } from '../core/input';
import { blockTop, blocked, heightAt, inCity, mulberry32 } from '../world/terrain';
import type { Network } from '../network/network';

const O = new THREE.Object3D();
const PALETTE = [0xc8283c, 0x2b3d8f, 0xe9dfc8, 0x25c8e6, 0x8f3dd1, 0xf0a030, 0x2a2f3d].map((h) => new THREE.Color(h));

/** Player controller: walking, jumping, flying (hover / fly / boost) and the brace-slide when landing at speed. */
export class Player {
  readonly hero: Hero;
  readonly group: THREE.Group;
  x = 0; z = 0; y = 0; vy = 0; vx = 0; vz = 0; yaw = 0;
  grounded = true;
  mode: Mode = 'ground';
  boost = false;
  landing = false;      // flight: descending to land
  landT = 0;
  yawRate = 0;
  /** one-shot / continuous FX requests read by the game */
  sliding = false; impact = 0;

  constructor(assets: Assets, spawn: { x: number; z: number }) {
    this.hero = new Hero(assets);
    this.group = this.hero.root;
    this.x = spawn.x; this.z = spawn.z;
    this.y = heightAt(this.x, this.z);
  }

  get flying(): boolean { return this.mode === 'fly'; }
  get speed3(): number { return Math.hypot(this.vx, this.vy, this.vz); }
  get hspeed(): number { return Math.hypot(this.vx, this.vz); }

  teleport(x: number, z: number): void {
    this.x = x; this.z = z; this.vx = this.vz = this.vy = 0;
    this.y = Math.max(heightAt(x, z), 0); this.grounded = true; this.mode = 'ground'; this.boost = false; this.landing = false;
  }

  private faceVelocity(dt: number, rate: number): void {
    if (this.hspeed < 0.8) { this.yawRate *= 0.8; return; }
    const target = Math.atan2(this.vx, this.vz);
    let d = target - this.yaw; d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
    const step = d * (1 - Math.exp(-dt * rate));
    this.yaw += step; this.yawRate = step / Math.max(dt, 1e-3);
  }

  /** One simulation step. camYaw/camPitch are the free-look camera angles (movement is camera-relative). */
  step(dt: number, I: Input, camYaw: number, camPitch: number): void {
    const flyA = I.wasPressed('KeyF'), flyB = I.wasPressed('BtnFly'), bstA = I.wasPressed('KeyB'), bstB = I.wasPressed('BtnBoost');
    const flyTap = flyA || flyB, boostTap = bstA || bstB;
    this.sliding = false;
    const sy = Math.sin(camYaw), cy = Math.cos(camYaw);
    const mx = I.moveX, my = -I.moveY, mag = Math.min(1, Math.hypot(mx, my));

    if (this.mode === 'ground') {
      if (flyTap) { this.mode = 'fly'; this.grounded = false; this.vy = 6; this.boost = false; this.landing = false; return; }
      const speed = I.run ? 9 : 5;
      const tvx = (-sy * my + cy * mx) * speed, tvz = (-cy * my - sy * mx) * speed;
      const k = 1 - Math.exp(-10 * dt);
      this.vx += (tvx - this.vx) * k; this.vz += (tvz - this.vz) * k;
      let nx = this.x + this.vx * dt, nz = this.z + this.vz * dt;
      if (blocked(nx, this.z) || heightAt(nx, this.z) < -0.3) { nx = this.x; this.vx = 0; }
      if (blocked(this.x, nz) || heightAt(this.x, nz) < -0.3) { nz = this.z; this.vz = 0; }
      this.x = nx; this.z = nz;
      if (this.hspeed > 0.5) { this.yaw = Math.atan2(this.vx, this.vz); }
      const ground = Math.max(heightAt(this.x, this.z), 0);
      if (I.jump && this.grounded) { this.vy = 7.5; this.grounded = false; }
      this.vy -= 22 * dt; this.y += this.vy * dt;
      if (this.y <= ground) { this.y = ground; this.vy = 0; this.grounded = true; }
      return;
    }

    if (this.mode === 'brace') {
      // sliding to a stop: friction grows with speed, input is locked until the slide ends
      const sp = this.hspeed, dirx = this.vx / (sp || 1), dirz = this.vz / (sp || 1);
      const ns = sp - (14 + sp * 0.3) * dt;
      this.sliding = true;
      if (ns <= 0.8) { this.vx = this.vz = 0; this.mode = 'land'; this.landT = 0.45; this.sliding = false; }
      else {
        this.vx = dirx * ns; this.vz = dirz * ns;
        let nx = this.x + this.vx * dt, nz = this.z + this.vz * dt;
        if (blocked(nx, this.z) || heightAt(nx, this.z) < -0.3) { nx = this.x; this.vx = 0; }
        if (blocked(this.x, nz) || heightAt(this.x, nz) < -0.3) { nz = this.z; this.vz = 0; }
        this.x = nx; this.z = nz;
        this.faceVelocity(dt, 8);
      }
      this.y = Math.max(heightAt(this.x, this.z), 0);
      return;
    }

    if (this.mode === 'land') {
      this.landT -= dt; this.vx = this.vz = 0; this.y = Math.max(heightAt(this.x, this.z), 0);
      if (this.landT <= 0) { this.mode = 'ground'; this.grounded = true; }
      return;
    }

    // ---------------- flight ----------------
    const ground = heightAt(this.x, this.z), overLand = ground >= 0.5;
    const roof = blockTop(this.x, this.z);
    if (flyTap && overLand && roof === -Infinity) { this.landing = !this.landing; if (this.landing) this.boost = false; }
    if (boostTap && !this.landing) this.boost = !this.boost;

    const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
    // camera-forward in 3D: look up and push forward to climb; look down to dive
    const fx = -sy * cp, fy = -sp, fz = -cy * cp, rx = cy, rz = -sy;
    const vert = (I.jump ? 1 : 0) - (I.run ? 1 : 0);
    let dx: number, dy: number, dz: number;
    if (this.boost && mag < 0.05) { dx = fx; dy = fy; dz = fz; }          // boost with a free stick = cruise where you look
    else { dx = fx * my + rx * mx; dy = fy * my; dz = fz * my + rz * mx; }
    const l = Math.hypot(dx, dy, dz); if (l > 1) { dx /= l; dy /= l; dz /= l; }
    const top = this.boost ? 85 : 22;
    let tvx = dx * top, tvy = dy * top + vert * 12, tvz = dz * top;
    if (this.landing) { tvx *= 0.5; tvz *= 0.5; tvy = -7; }
    const k = 1 - Math.exp(-dt * (this.boost ? 1.3 : 2.4));
    this.vx += (tvx - this.vx) * k; this.vy += (tvy - this.vy) * k; this.vz += (tvz - this.vz) * k;

    let nx = this.x + this.vx * dt, nz = this.z + this.vz * dt, ny = this.y + this.vy * dt;
    const topAt = blockTop(nx, this.z), topAtZ = blockTop(this.x, nz);
    if (topAt > ny - 1) { nx = this.x; this.vx *= 0.2; }
    if (topAtZ > ny - 1) { nz = this.z; this.vz *= 0.2; }
    this.x = nx; this.z = nz;
    const g2 = heightAt(this.x, this.z), r2 = blockTop(this.x, this.z);
    const canLand = g2 >= 0.5 && r2 === -Infinity;
    const wantsLand = this.landing || (vert < 0 && ny <= g2 + 1.4);
    let floor = g2 < 0 ? 2 : g2 + 1.2;                                    // hover just above terrain / water
    if (r2 > -Infinity) floor = Math.max(floor, r2 + 1.2);
    if (canLand && wantsLand) floor = g2;
    if (ny > 1500) { ny = 1500; this.vy = Math.min(this.vy, 0); }
    if (ny <= floor) {
      ny = floor; if (this.vy < 0) this.vy = 0;
      if (canLand && wantsLand && ny <= g2 + 0.02) {
        // touchdown: a diagonal / fast landing brakes with the legs, a gentle one just crouches
        this.y = g2; this.grounded = true; this.boost = false; this.landing = false;
        if (this.hspeed > 4) { this.mode = 'brace'; this.impact = 1; } else { this.mode = 'land'; this.landT = 0.4; this.vx = this.vz = 0; }
        return;
      }
    }
    this.y = ny;
    this.faceVelocity(dt, 6);
  }

  sync(dt: number): void {
    const bank = this.mode === 'fly' ? Math.max(-0.7, Math.min(0.7, -this.yawRate * 0.18)) : 0;
    this.hero.pose({ dt, mode: this.mode, hs: this.hspeed, speed: this.speed3, vy: this.vy, grounded: this.grounded, boost: this.boost, bank });
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
