/**
 * Valley racecourse: an oval dirt track with white rails, a covered grandstand full of cheering spectators, a finish
 * post and a field of six horses with jockeys in racing silks. Races run continuously: a two-lap gallop with surges and
 * lane changes, a cool-down trot past the stands, then the next race.
 */
import * as THREE from 'three/webgpu';
import { MB, hex } from '../rendering/geo';
import type { Assets } from '../rendering/assets';
import { RACECOURSE, courseAt, type Course } from '../world/layout';
import { heightAt } from '../world/terrain';
import { Horse } from './horse';
import { loft, ends, keys } from './sculpt';
import { Act, type Townsfolk } from './npcs';

type V3 = [number, number, number];
const SILKS = [[0xe83a3a, 0xf4f2ec], [0x2a6ad8, 0xffd84a], [0x2fbf6a, 0x1a1a24], [0xff8a2a, 0x2a2a36], [0x9a5ae0, 0xf4f2ec], [0xffd84a, 0xd83a9a]];

/** crouched jockey in horse-local space (the horse model is 1 unit = 1 m before its own scale) */
function jockeyGeo(silk: number, cap: number): THREE.BufferGeometry[] {
  const g: THREE.BufferGeometry[] = [];
  const torso = keys([[0, 0.11], [0.5, 0.15], [1, 0.12]]);
  g.push(loft({ path: [[0, 1.66, -0.12], [0, 1.82, 0.08], [0, 1.9, 0.26]], steps: 8, seg: 12, r: (t) => [torso(t) * ends(t, 0.1, 0.15), torso(t) * 0.8 * ends(t, 0.1, 0.15)], color: silk }));
  g.push(loft({ path: [[0, 1.98, 0.32], [0, 2.1, 0.38]], steps: 6, seg: 12, r: (t) => 0.105 * Math.sin(Math.PI * Math.min(1, 0.15 + t)), color: 0xf2c8a8 }));                 // head
  g.push(loft({ path: [[0, 2.06, 0.3], [0, 2.15, 0.36], [0, 2.17, 0.42]], steps: 6, seg: 12, r: (t) => 0.12 * Math.sin(Math.PI * (0.25 + 0.75 * t)) + 0.01, color: cap }));    // helmet
  for (const s of [-1, 1]) {
    g.push(loft({ path: [[s * 0.15, 1.86, 0.2], [s * 0.17, 1.74, 0.36], [s * 0.1, 1.7, 0.52]], steps: 6, seg: 8, r: () => 0.045, color: silk }));                                   // arms to the reins
    g.push(loft({ path: [[s * 0.13, 1.68, -0.08], [s * 0.26, 1.72, 0.16], [s * 0.3, 1.42, 0.08], [s * 0.36, 1.12, 0.06]], steps: 8, seg: 8, r: (t) => 0.06 - 0.02 * t, color: 0xf4f2ec })); // short stirrup legs
    g.push(loft({ path: [[s * 0.36, 1.08, 0.0], [s * 0.37, 1.06, 0.14]], steps: 3, seg: 8, r: () => 0.045, color: 0x1a1a22 }));
  }
  return g;
}

export class Racecourse {
  readonly group = new THREE.Group();
  private horses: Horse[] = [];
  private s: number[] = []; private lane: number[] = []; private laneT: number[] = []; private v: number[] = []; private base: number[] = [];
  private phase: 'race' | 'cool' = 'race'; private t = 0; private lapEnd = 0;
  private crowd = false;
  private P = 0;

  constructor(assets: Assets, private folk: Townsfolk) {
    const c = RACECOURSE; if (!c) return;
    this.P = 2 * c.L + 2 * Math.PI * c.R;
    this.buildTrack(c, assets);
    for (let i = 0; i < 6; i++) {
      const h = new Horse(assets.rig, (i * 5 + 1) % 6, { x: c.x, z: c.z, r: 1 }, 3000 + i * 71);
      h.ridden = true;
      const [silk, cap] = SILKS[i];
      const mesh = new THREE.Mesh(mergeAll(jockeyGeo(silk, cap)), assets.rig); mesh.castShadow = true;
      (h.root.children[0] as THREE.Object3D).add(mesh);                      // rides on the bobbing body
      this.group.add(h.root); this.horses.push(h);
      this.s.push(-i * 1.5); this.lane.push(-5 + i * 2); this.laneT.push(-5 + i * 2); this.v.push(0); this.base.push(15.5 + Math.random() * 2.5);
    }
    this.lapEnd = 2 * this.P;
  }

  private buildTrack(c: Course, assets: Assets): void {
    const shade = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];
    const m = new MB(), dirt = hex(0xa87a4e), dirt2 = hex(0x9a6e44), white = hex(0xf4f2ec), wood = hex(0x6b4630), roof = hex(0x2a6ad8), seat = hex(0xd8d4cc);
    const y = (x: number, z: number) => heightAt(x, z);
    const step = 2.5, n = Math.ceil(this.P / step);
    for (let i = 0; i < n; i++) {
      const s0 = i * step, s1 = s0 + step;
      for (let k = 0; k < 4; k++) {
        const o0 = -c.W / 2 + (k * c.W) / 4, o1 = o0 + c.W / 4;
        const a = courseAt(c, s0, o0), b = courseAt(c, s0, o1), d = courseAt(c, s1, o0), e = courseAt(c, s1, o1);
        const P = (p: { x: number; z: number }): V3 => [p.x, y(p.x, p.z) + 0.12, p.z];
        m.quad(P(a), P(b), P(e), P(d), k === 0 || k === 3 ? dirt2 : dirt, [a.x, y(a.x, a.z) - 10, a.z]);
      }
      // rails: posts every other sample, a continuous top rail, inside and outside
      for (const off of [-c.W / 2 - 0.4, c.W / 2 + 0.4]) {
        const a = courseAt(c, s0, off), b = courseAt(c, s1, off), ya = y(a.x, a.z), yb = y(b.x, b.z);
        if (i % 2 === 0) m.box(a.x, ya + 0.55, a.z, 0.1, 1.1, 0.1, white);
        const top = (p: { x: number; z: number }, h: number, dy: number): V3 => [p.x, h + dy, p.z];
        m.quad(top(a, ya, 1.05), top(b, yb, 1.05), top(b, yb, 1.17), top(a, ya, 1.17), white);
        m.quad(top(a, ya, 1.17), top(b, yb, 1.17), top(b, yb, 1.05), top(a, ya, 1.05), white);
      }
    }
    // grandstands all the way round the outside of the oval: tiers rise away from the rail, every seat faces the track,
    // a roof on posts over the stands; gaps at the two ends of the home straight let people in
    const grp = new MB(), O = c.W / 2 + 3.2, TIERS = 6, TD = 1.1, TH = 0.55, P = this.P, st = 4;
    const gap = (s0: number) => { const u = ((s0 % P) + P) % P; return Math.abs(u - (c.L + Math.PI * c.R)) < 8 || Math.abs(u - (2 * c.L + Math.PI * c.R)) < 8; };
    this.seats = [];
    for (let s0 = 0; s0 < P; s0 += st) {
      if (gap(s0) || gap(s0 + st)) continue;
      for (let t = 0; t < TIERS; t++) {
        const o0 = O + t * TD, o1 = o0 + TD, h = (t + 1) * TH;
        const a0 = courseAt(c, s0, o0), b0 = courseAt(c, s0 + st, o0), a1 = courseAt(c, s0, o1), b1 = courseAt(c, s0 + st, o1);
        const ya = y(a0.x, a0.z), yb = y(b0.x, b0.z);
        const col = t % 2 ? seat : hex(0xc8c4bc);
        grp.quad([a0.x, ya + h, a0.z], [b0.x, yb + h, b0.z], [b1.x, yb + h, b1.z], [a1.x, ya + h, a1.z], col, [a0.x, ya - 10, a0.z]);                         // seat deck
        grp.quad([a0.x, ya + h - TH, a0.z], [b0.x, yb + h - TH, b0.z], [b0.x, yb + h, b0.z], [a0.x, ya + h, a0.z], shade(col, 0.8), [a1.x, ya + h - TH / 2, a1.z]); // riser facing the track
        if (s0 % 8 === 0) this.seats.push({ s: s0 + st / 2, off: o0 + TD * 0.55, h: ya + h });
      }
      // back wall, roof posts and the canopy
      const ow = O + TIERS * TD, a2 = courseAt(c, s0, ow), b2 = courseAt(c, s0 + st, ow), ya = y(a2.x, a2.z), yb = y(b2.x, b2.z);
      grp.quad([a2.x, ya, a2.z], [b2.x, yb, b2.z], [b2.x, yb + TIERS * TH + 1.2, b2.z], [a2.x, ya + TIERS * TH + 1.2, a2.z], wood, [a2.x * 2 - courseAt(c, s0, ow - 1).x, ya + 2, a2.z * 2 - courseAt(c, s0, ow - 1).z]);
      const r0 = courseAt(c, s0, O - 0.6), r1 = courseAt(c, s0 + st, O - 0.6), q0 = courseAt(c, s0, ow + 0.4), q1 = courseAt(c, s0 + st, ow + 0.4), ry = Math.max(ya, yb) + TIERS * TH + 3.4;
      grp.quad([r0.x, ry - 0.6, r0.z], [r1.x, ry - 0.6, r1.z], [q1.x, ry, q1.z], [q0.x, ry, q0.z], roof, [r0.x, ry - 5, r0.z]);
      grp.quad([r0.x, ry - 0.6, r0.z], [q0.x, ry, q0.z], [q1.x, ry, q1.z], [r1.x, ry - 0.6, r1.z], shade(roof, 0.7), [r0.x, ry + 5, r0.z]);
      if (s0 % 12 === 0) for (const p of [r0, q0]) { const py = y(p.x, p.z); grp.cyl(p.x, p.z, 0.14, 0.14, py, ry - (p === r0 ? 0.6 : 0), 6, white); }
    }
    const sg = grp.toGeometry(); sg.computeBoundingSphere();
    const gs = new THREE.Mesh(sg, assets.rig); gs.castShadow = true;
    this.stand = { x: c.x, y: 0, z: c.z, yaw: 0 };
    const f0 = courseAt(c, c.L + Math.PI * c.R + c.L * 0.5, -c.W / 2 - 2.5), fy = y(f0.x, f0.z);
    m.cyl(f0.x, f0.z, 0.12, 0.12, fy, fy + 4, 8, white); m.box(f0.x, fy + 4.2, f0.z, 1.2, 1.2, 0.2, hex(0xe83a3a)); m.cyl(f0.x, f0.z, 0.5, 0.5, fy + 4.8, fy + 4.9, 12, white);
    const track = new THREE.Mesh(m.toGeometry(), assets.rig); track.receiveShadow = true;
    this.group.add(track, gs);
  }
  private stand: { x: number; y: number; z: number; yaw: number } | null = null;
  private seats: { s: number; off: number; h: number }[] = [];

  update(dt: number, px: number, pz: number, timeSec: number): void {
    const c = RACECOURSE; if (!c) return;
    const d = Math.hypot(px - c.x, pz - c.z);
    this.group.visible = d < 900;
    this.setCrowd(d < 260);
    if (d > 900) return;
    this.t += dt;
    const lead = Math.max(...this.s);
    if (this.phase === 'race' && lead > this.lapEnd) { this.phase = 'cool'; this.t = 0; }
    if (this.phase === 'cool' && this.t > 18) { this.phase = 'race'; this.lapEnd = lead + 2 * this.P; this.base = this.base.map(() => 15.5 + Math.random() * 2.5); }
    this.horses.forEach((h, i) => {
      const surge = 1.2 * Math.sin(timeSec * 0.31 + i * 1.7) + 0.6 * Math.sin(timeSec * 0.83 + i);
      const target = this.phase === 'race' ? this.base[i] + surge : 3.5 + 0.4 * i;
      this.v[i] += (target - this.v[i]) * Math.min(1, dt * 0.6);
      this.s[i] += this.v[i] * dt;
      if (Math.random() < dt * 0.15) this.laneT[i] = -5.5 + Math.random() * 11;
      this.lane[i] += (this.laneT[i] - this.lane[i]) * Math.min(1, dt * 0.5);
      const p = courseAt(c, this.s[i], this.lane[i]);
      h.x = p.x; h.z = p.z; h.yaw = p.yaw; h.y = heightAt(p.x, p.z) + 0.12; h.speed = this.v[i];
      h.animate(dt);
    });
  }

  /** spectators in the stands while the player is near enough to see them */
  private setCrowd(on: boolean): void {
    if (on === this.crowd || !this.stand) return;
    this.crowd = on;
    if (!on) { this.folk.unpinAll('race'); return; }
    const c = RACECOURSE!;
    const keep = Math.min(1, 80 / Math.max(1, this.seats.length));
    for (const seat of this.seats) {
      if (Math.random() > keep) continue;
      const p = courseAt(c, seat.s + (Math.random() - 0.5) * 2, seat.off), q = courseAt(c, seat.s, seat.off - 4);
      this.folk.pin(p.x, seat.h, p.z, Math.atan2(q.x - p.x, q.z - p.z), Math.random() < 0.5 ? Act.Dance : Math.random() < 0.5 ? Act.Talk : Act.Stand, -1, 0, 'race');
    }
  }
}

function mergeAll(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  for (const g of gs) {
    const base = pos.length / 3, P = g.getAttribute('position'), N = g.getAttribute('normal'), C = g.getAttribute('color'), I = g.getIndex()!;
    for (let i = 0; i < P.count; i++) { pos.push(P.getX(i), P.getY(i), P.getZ(i)); nor.push(N.getX(i), N.getY(i), N.getZ(i)); col.push(C.getX(i), C.getY(i), C.getZ(i)); }
    for (let i = 0; i < I.count; i++) idx.push(base + I.getX(i));
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(idx);
  return out;
}
