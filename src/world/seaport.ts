/**
 * The city seaport and the ships at sea.
 *
 * Port (on the levelled quay from layout.PORT): concrete apron with painted lines and bollards, three gantry container
 * cranes whose trolleys run out over the water, stacks of shipping containers, warehouses, a breakwater with a
 * lighthouse whose lamp turns on at night, wooden pontoons with fishing boats and yachts, and a container ship and a
 * cruise ship moored alongside.
 *
 * Ships at sea sail closed routes around the islands (container ships far out, ferries, sailing yachts, motorboats),
 * heading along their route, bobbing and rolling, each trailing a foam wake.
 */
import * as THREE from 'three/webgpu';
import { MB, hex } from '../rendering/geo';
import type { Assets } from '../rendering/assets';
import { PORT, portLocal, type Port } from './layout';
import { heightAt, ISLANDS } from './terrain';

type V3 = [number, number, number];
const CONTAINER = [0xc8283c, 0x2a6ad8, 0x2f9a5a, 0xe8902a, 0xd8d4cc, 0x6a3a8a, 0x1e6a6a, 0xd8b04a, 0x8a4a2a];

// ---------------------------------------------------------------------------------------------------------------------
// ship models (local: bow toward +z, waterline at y = 0)
// ---------------------------------------------------------------------------------------------------------------------
/** tapered hull: a prism whose plan narrows to a point at the bow and rounds at the stern */
function hull(m: MB, L: number, B: number, H: number, below: number, top: V3, bottom: V3, stripe: V3): void {
  const plan: number[][] = [];
  for (let i = 0; i <= 12; i++) { const t = i / 12, z = -L / 2 + t * L * 0.72; plan.push([B / 2 * (t < 0.08 ? 0.82 + t * 2.2 : 1), z]); }
  for (let i = 1; i <= 8; i++) { const t = i / 8, z = -L / 2 + L * 0.72 + t * L * 0.28; plan.push([B / 2 * Math.cos(t * Math.PI / 2) ** 0.8, z]); }
  const ring = [...plan, ...plan.slice().reverse().map(([x, z]) => [-x, z])];
  m.prism(ring, -below, H * 0.35, bottom, null);
  m.prism(ring.map(([x, z]) => [x * 1.01, z]), H * 0.35, H * 0.45, stripe, null);
  m.prism(ring.map(([x, z]) => [x * 1.02, z]), H * 0.45, H, top, hex(0x8a8e96));
}

function containerShipGeo(): THREE.BufferGeometry {
  const m = new MB(), L = 170, B = 26, H = 11;
  hull(m, L, B, H, 6, hex(0x2a3a5a), hex(0x8a2a2a), hex(0xf4f2ec));
  // container bays on deck
  let k = 0;
  for (let z = -L / 2 + 34; z < L / 2 - 20; z += 13.5) for (let x = -B / 2 + 2.6; x < B / 2 - 2; x += 2.6) {
    const n = 2 + ((k * 7) % 4); k++;
    for (let h = 0; h < n; h++) { const c = hex(CONTAINER[(k + h * 3) % CONTAINER.length]); m.box(x, H + 1.3 + h * 2.6, z, 2.45, 2.5, 12.2, c); m.box(x, H + 1.3 + h * 2.6, z + 6.11, 2.3, 2.2, 0.06, [c[0] * 0.75, c[1] * 0.75, c[2] * 0.75], 1); }
  }
  // superstructure at the stern: accommodation block, bridge wings, funnel
  m.box(0, H + 9, -L / 2 + 16, 20, 18, 12, hex(0xf4f2ec));
  for (let f = 0; f < 6; f++) m.box(0, H + 2.5 + f * 2.8, -L / 2 + 22.05, 17, 1.1, 0.1, hex(0x3a5a7a), 1);
  m.box(0, H + 18.6, -L / 2 + 18, B + 2, 1.6, 6, hex(0xf4f2ec)); m.box(0, H + 18.8, -L / 2 + 21.05, B, 1.0, 0.1, hex(0x2a3a5a), 1);
  m.box(0, H + 22, -L / 2 + 10, 5, 10, 6, hex(0xc8283c)); m.box(0, H + 26.5, -L / 2 + 10, 5.2, 1.2, 6.2, hex(0x1a1a22));
  m.cyl(0, -L / 2 + 16, 0.25, 0.25, H + 19, H + 27, 6, hex(0xf4f2ec));
  return m.toGeometry();
}

function cruiseShipGeo(): THREE.BufferGeometry {
  const m = new MB(), L = 150, B = 24, H = 9;
  hull(m, L, B, H, 6, hex(0xf4f6f8), hex(0x1e2a4a), hex(0x2a6ad8));
  for (let d = 0; d < 6; d++) {                                                           // stacked decks with window bands and balconies
    const w = B - 2 - d * 1.4, l = L * (0.78 - d * 0.06), y = H + d * 3;
    m.box(0, y + 1.5, -L * 0.06, w, 3, l, hex(0xf8f8fa));
    for (const s of [-1, 1]) { m.box(s * (w / 2 + 0.02), y + 1.7, -L * 0.06, 0.06, 1.2, l * 0.96, hex(0x2a4a6a), 1); m.box(s * (w / 2 + 0.3), y + 0.4, -L * 0.06, 0.6, 0.12, l * 0.96, hex(0xd8dce0)); }
  }
  m.box(0, H + 19.5, L * 0.18, B - 6, 2.4, 10, hex(0xf4f6f8)); m.box(0, H + 19.6, L * 0.18 + 5.05, B - 7, 1.2, 0.1, hex(0x1a2a3a), 1); // bridge
  for (const z of [-L * 0.2, -L * 0.32]) { m.box(0, H + 22, z, 5, 8, 8, hex(0x2a6ad8)); m.box(0, H + 26.4, z, 5.2, 0.8, 8.2, hex(0xf4f6f8)); }
  m.box(0, H + 18.3, -L * 0.05, 9, 0.2, 14, hex(0x45c8e6));                                 // pool on the top deck
  for (let k = 0; k < 8; k++) m.box((k % 2 ? -1 : 1) * (B / 2 - 3), H + 3.5, -L * 0.4 + k * 9, 2.2, 1.6, 6, hex(0xff8a2a)); // lifeboats
  return m.toGeometry();
}

function ferryGeo(): THREE.BufferGeometry {
  const m = new MB(), L = 60, B = 14, H = 5;
  hull(m, L, B, H, 3, hex(0xf4f2ec), hex(0x2a6ad8), hex(0xe8392f));
  m.box(0, H + 2, -2, B - 2, 4, L * 0.6, hex(0xf8f8fa)); for (const s of [-1, 1]) m.box(s * (B / 2 - 0.98), H + 2.3, -2, 0.06, 1.4, L * 0.56, hex(0x2a4a6a), 1);
  m.box(0, H + 5.2, 6, B - 5, 2.4, 6, hex(0xf8f8fa)); m.box(0, H + 5.4, 9.05, B - 6, 1, 0.1, hex(0x1a2a3a), 1);
  m.box(0, H + 7, -8, 2.4, 4, 3, hex(0xe8392f));
  return m.toGeometry();
}

function fishingBoatGeo(c: number): THREE.BufferGeometry {
  const m = new MB(), L = 16, B = 5, H = 2;
  hull(m, L, B, H, 1.3, hex(c), hex(0x2a2a30), hex(0xf4f2ec));
  m.box(0, H + 1.4, -1, 3, 2.8, 3.4, hex(0xf4f2ec)); m.box(0, H + 1.8, 0.75, 2.6, 1, 0.08, hex(0x2a4a6a), 1);
  m.cyl(0, -4, 0.12, 0.1, H, H + 7, 6, hex(0xd8d4cc)); m.box(0, H + 5, -5.6, 0.1, 0.1, 3.2, hex(0xd8d4cc));
  m.box(0, H + 0.4, -6, 3.4, 0.8, 2, hex(0xe8902a));
  return m.toGeometry();
}

function yachtGeo(sail: number): THREE.BufferGeometry {
  const m = new MB(), L = 13, B = 4, H = 1.4;
  hull(m, L, B, H, 1, hex(0xf8f8fa), hex(0x1e2a4a), hex(0x2a6ad8));
  m.box(0, H + 0.5, -1, 2.4, 1, 3.5, hex(0xf4f2ec));
  m.cyl(0, 1, 0.1, 0.08, H, H + 15, 6, hex(0xd8d4cc));
  m.quad([0, H + 1.2, 1], [0, H + 14.5, 1.1], [0, H + 1.4, -4.2], [0, H + 1.2, 1], hex(sail));       // mainsail
  m.quad([0, H + 1.2, 1], [0, H + 1.4, -4.2], [0, H + 14.5, 1.1], [0, H + 1.2, 1], hex(sail));
  m.quad([0, H + 0.8, 1.6], [0, H + 13, 1.2], [0, H + 0.6, 5.6], [0, H + 0.8, 1.6], hex(0xf8f8fa));   // jib
  m.quad([0, H + 0.8, 1.6], [0, H + 0.6, 5.6], [0, H + 13, 1.2], [0, H + 0.8, 1.6], hex(0xf8f8fa));
  return m.toGeometry();
}

function motorboatGeo(c: number): THREE.BufferGeometry {
  const m = new MB(), L = 8, B = 2.8, H = 1;
  hull(m, L, B, H, 0.6, hex(0xf8f8fa), hex(c), hex(c));
  m.box(0, H + 0.5, 0.4, 2, 0.9, 1.6, hex(0x2a4a6a)); m.box(0, H + 0.2, -2.2, 0.5, 0.6, 0.5, hex(0x1a1a22));
  return m.toGeometry();
}

function wakeGeo(L: number, B: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry(), w = B * 0.6;
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.15, -L * 0.45, -w, 0.15, -L * 0.45 - L * 1.4, w, 0.15, -L * 0.45 - L * 1.4, -B * 0.55, 0.12, L * 0.42, -B * 1.4, 0.12, -L * 0.2, B * 0.55, 0.12, L * 0.42, B * 1.4, 0.12, -L * 0.2], 3));
  g.setIndex([0, 2, 1, 3, 4, 0, 5, 0, 6]); g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------------------------------------------
interface Ship { obj: THREE.Group; route: number[][]; s: number; speed: number; total: number; seg: number[]; roll: number }

export class Seaport {
  readonly group = new THREE.Group();
  private mat: THREE.MeshToonNodeMaterial;
  private glow = new THREE.MeshBasicMaterial({ vertexColors: true });
  private lamp: THREE.Mesh | null = null;
  private trolleys: { m: THREE.Mesh; base: THREE.Vector3; dir: THREE.Vector3; ph: number }[] = [];
  private ships: Ship[] = [];
  private bobbers: { obj: THREE.Object3D; ph: number; y: number }[] = [];

  constructor(assets: Assets) {
    this.mat = new THREE.MeshToonNodeMaterial({ vertexColors: true, gradientMap: assets.ramp });
    if (PORT) this.buildPort(PORT);
    this.buildFleet();
  }

  private mesh(g: THREE.BufferGeometry, glow = false): THREE.Mesh { const m = new THREE.Mesh(g, glow ? this.glow : this.mat); m.castShadow = !glow; m.receiveShadow = true; return m; }
  /** place local-port geometry into world space (baked) */
  private bake(g: THREE.BufferGeometry, p: Port): THREE.BufferGeometry {
    const [x, z] = portLocal(p, 0, 0);
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(p.ry).setPosition(x, 0, z)); g.computeBoundingSphere(); return g;
  }

  private buildPort(p: Port): void {
    const m = new MB(), L = new MB(), d = p.deck, conc = hex(0xb8bcc2), conc2 = hex(0xa8acb2), yel = hex(0xf2c83a), dark = hex(0x2a2c34);
    // apron surface slabs + quay wall down into the water, painted lines, bollards and tyre fenders along the edge
    for (let i = -6; i < 6; i++) for (let j = -2; j < 2; j++) m.box(i * 25 + 12.5, d + 0.05, j * 22 + 11 - 10, 24.6, 0.2, 21.6, (i + j) % 2 ? conc : conc2);
    m.box(0, d / 2 - 4, p.hd, p.hw * 2, d + 8, 1.5, hex(0x8d9096));
    for (const s of [-1, 1]) m.box(s * p.hw, d / 2 - 4, 0, 1.5, d + 8, p.hd * 2, hex(0x8d9096));
    for (let x = -p.hw + 6; x < p.hw; x += 12) { m.cyl(x, p.hd - 1.2, 0.35, 0.28, d, d + 0.8, 8, dark); m.box(x + 6, d - 0.8, p.hd + 0.85, 1.4, 1.2, 0.5, hex(0x1a1a1e)); }
    m.box(0, d + 0.16, p.hd - 3, p.hw * 2 - 4, 0.02, 0.3, yel, 4); m.box(0, d + 0.16, p.hd - 26, p.hw * 2 - 4, 0.02, 0.3, yel, 4);
    // gantry cranes on rails
    for (const cx of [-80, -20, 40]) {
      const g = new MB(), blue = hex(0x2a6ad8), red = hex(0xc8283c);
      for (const lx of [-9, 9]) for (const lz of [p.hd - 24, p.hd - 4]) g.box(cx + lx, d + 17, lz, 1.6, 34, 1.6, blue);
      for (const lz of [p.hd - 24, p.hd - 4]) g.box(cx, d + 33, lz, 20, 2, 1.6, blue);
      for (const lx of [-9, 9]) g.box(cx + lx, d + 1, p.hd - 14, 2.4, 2, 24, red);
      g.box(cx, d + 36, p.hd + 12, 4, 2.4, 92, blue);                                          // boom reaching out over the water
      g.box(cx, d + 40, p.hd - 10, 5, 6, 8, hex(0xf4f2ec)); g.box(cx, d + 40.5, p.hd - 5.95, 4, 2, 0.1, hex(0x2a4a6a), 1);
      for (const s of [-1, 1]) g.quad([cx + s * 2, d + 37, p.hd - 30], [cx + s * 2, d + 46, p.hd - 14], [cx + s * 2, d + 37.2, p.hd + 50], [cx + s * 2, d + 37, p.hd - 30], blue);
      const geo = g.toGeometry(); this.group.add(this.mesh(this.bake(geo, p)));
      const tm = new MB(); tm.box(0, 0, 0, 4.6, 2.2, 5, hex(0xf2c83a)); tm.box(0, -6, 0, 0.2, 10, 0.2, dark); tm.box(0, -11.2, 0, 2.6, 0.8, 12.4, hex(0xf2c83a));
      tm.box(0, -12.9, 0, 2.45, 2.5, 12.2, hex(CONTAINER[(cx + 200) % CONTAINER.length]));
      const trolley = this.mesh(tm.toGeometry());
      const [bx, bz] = portLocal(p, cx, p.hd - 18), [ex, ez] = portLocal(p, cx, p.hd + 45);
      trolley.position.set(bx, d + 34.5, bz); trolley.rotation.y = p.ry;
      this.trolleys.push({ m: trolley, base: new THREE.Vector3(bx, d + 34.5, bz), dir: new THREE.Vector3(ex - bx, 0, ez - bz), ph: cx * 0.07 });
      this.group.add(trolley);
    }
    // container yard: blocks of stacked boxes with corrugation lines and door ends
    let k = 0;
    for (let bx = -130; bx <= 110; bx += 30) for (let row = 0; row < 3; row++) {
      if (bx > -50 && bx < 60 && row === 0) continue;
      for (let c = 0; c < 4; c++) {
        const n = 1 + ((k * 5 + c) % 4), x = bx + c * 2.7, z = -30 + row * 14; k++;
        for (let h = 0; h < n; h++) {
          const col = hex(CONTAINER[(k + h * 2) % CONTAINER.length]), y = d + 1.3 + h * 2.6;
          m.box(x, y, z, 2.45, 2.5, 12.2, col);
          for (let r = -5; r <= 5; r += 1) m.box(x + 1.235, y, z + r, 0.02, 2.3, 0.18, [col[0] * 0.82, col[1] * 0.82, col[2] * 0.82], 2);
          m.box(x, y, z + 6.11, 2.3, 2.3, 0.06, [col[0] * 0.7, col[1] * 0.7, col[2] * 0.7], 1);
        }
      }
    }
    // warehouses at the back of the apron
    for (const wx of [-95, 15, 105]) {
      m.box(wx, d + 6, -p.hd + 8, 50, 12, 16, hex(0xd8d4cc));
      m.frustum(wx, -p.hd + 8, 51, 17, 51, 4, d + 12, d + 15, hex(0x5a6a7a));
      for (let i = -2; i <= 2; i++) m.box(wx + i * 9, d + 3, -p.hd + 16.05, 6, 6, 0.1, hex(0x8a8e96), 1);
      m.box(wx, d + 10, -p.hd + 16.1, 30, 1.6, 0.1, hex(0x2a6ad8), 1);
    }
    // breakwater out to a lighthouse
    for (let i = 0; i < 14; i++) m.box(p.hw + 8 + i * 9, d - 1, p.hd + 30 + i * 4, 10, d + 6, 8, hex(0x8d9096));
    const lhx = p.hw + 8 + 13 * 9 + 4, lhz = p.hd + 30 + 13 * 4 + 2;
    m.cyl(lhx, lhz, 3.2, 2.4, d, d + 22, 14, hex(0xf4f2ec));
    for (const y of [5, 12, 19]) m.cyl(lhx, lhz, 3.05 - y * 0.035, 2.95 - y * 0.035, d + y, d + y + 2.4, 14, hex(0xc8283c));
    m.cyl(lhx, lhz, 2.8, 2.8, d + 22, d + 22.5, 14, dark); m.cyl(lhx, lhz, 1.4, 1.4, d + 25.4, d + 26.4, 10, hex(0xc8283c));
    L.cyl(lhx, lhz, 1.6, 1.6, d + 22.5, d + 25.4, 12, hex(0xfff2b0));
    // pontoons with small boats
    for (let i = 0; i < 3; i++) {
      const px = -p.hw - 20 - i * 26;
      m.box(px, 0.5, p.hd - 10, 3, 0.6, 70, hex(0x8a6a4a));
      for (let k2 = 0; k2 < 6; k2++) m.cyl(px + 1.6, p.hd - 40 + k2 * 12, 0.2, 0.2, -2, 1.6, 6, hex(0x5a4030));
    }
    m.box(-p.hw - 46, 0.5, p.hd - 46, 60, 0.6, 3, hex(0x8a6a4a));
    this.group.add(this.mesh(this.bake(m.toGeometry(), p)));
    this.lamp = this.mesh(this.bake(L.toGeometry(), p), true); this.group.add(this.lamp);
    // moored ships and boats
    const moor = (g: THREE.BufferGeometry, lx: number, lz: number, yaw: number) => {
      const o = new THREE.Group(), [x, z] = portLocal(p, lx, lz); o.add(this.mesh(g)); o.position.set(x, 0, z); o.rotation.y = p.ry + yaw;
      this.group.add(o); this.bobbers.push({ obj: o, ph: Math.random() * 6, y: 0 });
    };
    moor(containerShipGeo(), -20, p.hd + 17, Math.PI / 2);
    moor(cruiseShipGeo(), 100, p.hd + 72, Math.PI / 2);
    for (let i = 0; i < 3; i++) for (let k2 = 0; k2 < 3; k2++) {
      const g = (i + k2) % 2 ? fishingBoatGeo([0x2a6ad8, 0xc8283c, 0x2f9a5a][k2]) : yachtGeo([0xf8f8fa, 0xf2c83a, 0x2a6ad8][k2]);
      moor(g, -p.hw - 20 - i * 26 + (k2 % 2 ? 5 : -5), p.hd - 30 + k2 * 18, 0);
    }
  }

  /** closed sailing routes around the islands, kept in deep water */
  private buildFleet(): void {
    const route = (cx: number, cz: number, r0: number, n = 28): number[][] => {
      const pts: number[][] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2; let r = r0;
        while (r < r0 * 2.2 && heightAt(cx + Math.cos(a) * r, cz + Math.sin(a) * r) > -8) r += 20;
        pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
      }
      return pts;
    };
    const city = ISLANDS[1], valley = ISLANDS[0];
    const add = (g: THREE.BufferGeometry, L: number, B: number, pts: number[][], speed: number, s0: number) => {
      const obj = new THREE.Group(); obj.add(this.mesh(g));
      const wk = new THREE.Mesh(wakeGeo(L, B), new THREE.MeshBasicMaterial({ color: 0xf4fbff, transparent: true, opacity: 0.55, depthWrite: false })); obj.add(wk);
      const seg: number[] = [0]; let tot = 0;
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; tot += Math.hypot(b[0] - a[0], b[1] - a[1]); seg.push(tot); }
      this.ships.push({ obj, route: pts, s: s0 * tot, speed, total: tot, seg, roll: Math.random() * 6 });
      this.group.add(obj);
    };
    const big = route(city.cx, city.cz, 1450, 36), mid = route(city.cx, city.cz, 1150, 32), west = route(valley.cx, valley.cz, 1000, 32);
    add(containerShipGeo(), 170, 26, big, 7, 0); add(containerShipGeo(), 170, 26, big, 7, 0.5);
    add(cruiseShipGeo(), 150, 24, mid, 6, 0.25);
    add(ferryGeo(), 60, 14, mid, 11, 0.7); add(ferryGeo(), 60, 14, west, 10, 0.1);
    for (let i = 0; i < 5; i++) add(yachtGeo([0xf8f8fa, 0xff6a5a, 0x2a6ad8, 0xf2c83a, 0x2fbf6a][i]), 13, 4, i < 3 ? mid : west, 5 + i * 0.6, i * 0.19 + 0.05);
    for (let i = 0; i < 4; i++) add(motorboatGeo([0xc8283c, 0x2a6ad8, 0x1a1a22, 0xe8902a][i]), 8, 2.8, i % 2 ? mid : west, 15 + i * 2, i * 0.27 + 0.12);
  }

  update(dt: number, px: number, pz: number, timeSec: number, night: number): void {
    if (this.lamp) this.lamp.visible = night > 0.3;
    for (const t of this.trolleys) {
      const u = 0.5 - 0.5 * Math.cos(timeSec * 0.12 + t.ph);
      t.m.position.copy(t.base).addScaledVector(t.dir, u);
    }
    for (const b of this.bobbers) { b.obj.position.y = Math.sin(timeSec * 0.6 + b.ph) * 0.25; b.obj.rotation.z = Math.sin(timeSec * 0.45 + b.ph) * 0.015; }
    for (const s of this.ships) {
      s.s = (s.s + s.speed * dt) % s.total;
      let i = 0; while (i < s.route.length - 1 && s.seg[i + 1] < s.s) i++;
      const a = s.route[i], b = s.route[(i + 1) % s.route.length], t = (s.s - s.seg[i]) / Math.max(1e-6, s.seg[i + 1] - s.seg[i]);
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const far = Math.hypot(x - px, z - pz) > 3500;
      s.obj.visible = !far; if (far) continue;
      const yaw = Math.atan2(b[0] - a[0], b[1] - a[1]);
      let dy = yaw - s.obj.rotation.y; dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
      s.obj.position.set(x, Math.sin(timeSec * 0.8 + s.roll) * 0.3, z);
      s.obj.rotation.set(Math.sin(timeSec * 0.5 + s.roll) * 0.02, s.obj.rotation.y + dy * Math.min(1, dt * 0.6), Math.sin(timeSec * 0.7 + s.roll) * 0.03, 'YXZ');
    }
  }
}
