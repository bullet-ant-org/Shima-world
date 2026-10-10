/**
 * Grass: one instanced draw call of small blade tufts in a ring of cells around the player.
 *
 *  - Cells (CELL m) are addressed toroidally, so walking one cell regenerates just one row/column of cells (budgeted per
 *    frame) and nothing is allocated at runtime.
 *  - Slots are interleaved (slot = k * NC + cell): lowering `mesh.count` thins the field evenly everywhere, which is how the
 *    game trades density for frame time.
 *  - Tufts take the ground colour (instance colour) so they melt into the terrain, sway with wind in the vertex stage, and
 *    shrink toward the outer cells so the edge of the field is never a hard line.
 */
import * as THREE from 'three/webgpu';
import { attribute, cos, positionLocal, sin, time, vec3 } from 'three/tsl';

const CELL = 8;

function tuftGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], nor: number[] = [], idx: number[] = [];
  const blades = 5;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + b * 0.7, r = 0.05 + (b % 3) * 0.06;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r, h = 0.32 + ((b * 37) % 7) * 0.05, w = 0.035 + (b % 2) * 0.012;
    const lean = 0.12 + (b % 3) * 0.05, lx = Math.cos(a) * lean, lz = Math.sin(a) * lean;
    const px = -Math.sin(a) * w, pz = Math.cos(a) * w; // blade width runs across the lean direction
    const base = pos.length / 3;
    // two segments: base pair, mid pair, tip
    pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, bx + lx * 0.45 - px * 0.7, h * 0.55, bz + lz * 0.45 - pz * 0.7, bx + lx * 0.45 + px * 0.7, h * 0.55, bz + lz * 0.45 + pz * 0.7, bx + lx, h, bz + lz);
    for (const c of [0.55, 0.55, 0.85, 0.85, 1.2]) col.push(c, c, c);
    for (let k = 0; k < 5; k++) nor.push(0, 1, 0);
    idx.push(base, base + 1, base + 3, base, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

export class Grass {
  readonly mesh: THREE.InstancedMesh;
  private readonly R: number;          // cells from the centre to the edge
  private readonly N: number;          // cells per side
  private readonly NC: number;         // total cells
  private readonly K: number;          // tufts per cell
  private keys: Int32Array;            // which world cell each toroidal slot currently holds (packed), or a sentinel
  private queue: number[] = [];
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private v = new THREE.Vector3(); private s = new THREE.Vector3(); private c = new THREE.Color();
  private density = 1;

  constructor(total: number, radius: number, ramp: THREE.Texture, private grassAt: (x: number, z: number, out: THREE.Color) => boolean) {
    this.R = Math.max(2, Math.round(radius / CELL));
    this.N = this.R * 2 + 1; this.NC = this.N * this.N;
    this.K = Math.max(1, Math.round(total / this.NC));
    const count = this.K * this.NC;
    const mat = new THREE.MeshToonNodeMaterial({ vertexColors: true, gradientMap: ramp, side: THREE.DoubleSide });
    const ph = attribute('gphase', 'float'), hgt = positionLocal.y;
    const t = time.mul(1.7).add(ph);
    mat.positionNode = positionLocal.add(vec3(sin(t).mul(0.16).add(sin(t.mul(2.3)).mul(0.05)), 0, cos(t.mul(0.8)).mul(0.08)).mul(hgt));
    const geo = tuftGeometry();
    const phase = new Float32Array(count); for (let i = 0; i < count; i++) phase[i] = Math.random() * 6.283;
    geo.setAttribute('gphase', new THREE.InstancedBufferAttribute(phase, 1));
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false; this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < count; i++) { this.mesh.setMatrixAt(i, this.m); this.mesh.setColorAt(i, this.c.setRGB(1, 1, 1)); }
    this.keys = new Int32Array(this.NC).fill(0x7fffffff);
  }

  /** fraction of tufts drawn (0.25 .. 1): thins the field evenly */
  setDensity(d: number): void { this.density = Math.max(0.25, Math.min(1, d)); this.mesh.count = Math.max(this.NC, Math.round(this.K * this.density) * this.NC); }
  get count(): number { return this.mesh.count; }

  update(px: number, pz: number, budget = 6): void {
    const pcx = Math.floor(px / CELL), pcz = Math.floor(pz / CELL), N = this.N;
    if (!this.queue.length) {
      for (let dz = -this.R; dz <= this.R; dz++) for (let dx = -this.R; dx <= this.R; dx++) {
        const cx = pcx + dx, cz = pcz + dz, slot = (((cx % N) + N) % N) + (((cz % N) + N) % N) * N, key = (cx & 0xffff) | ((cz & 0x7fff) << 16);
        if (this.keys[slot] !== key) this.queue.push(slot, cx, cz, key);
      }
      // nearest cells first
      if (this.queue.length > 4) {
        const items: number[][] = []; for (let i = 0; i < this.queue.length; i += 4) items.push(this.queue.slice(i, i + 4));
        items.sort((a, b) => Math.hypot(a[1] - pcx, a[2] - pcz) - Math.hypot(b[1] - pcx, b[2] - pcz));
        this.queue = items.flat();
      }
    }
    let done = 0;
    while (this.queue.length && done < budget) {
      const slot = this.queue.shift()!, cx = this.queue.shift()!, cz = this.queue.shift()!, key = this.queue.shift()!;
      // skip stale work (the player moved on and this cell is no longer in range)
      if (Math.abs(cx - pcx) > this.R || Math.abs(cz - pcz) > this.R) continue;
      this.fillCell(slot, cx, cz, Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)));
      this.keys[slot] = key; done++;
    }
    if (done) { this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true; }
  }

  private fillCell(slot: number, cx: number, cz: number, ring: number): void {
    let h = (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) >>> 0;
    const rnd = () => { h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return h / 4294967296; };
    const edge = ring >= this.R ? 0.45 : ring >= this.R - 1 ? 0.75 : 1;   // smaller tufts toward the edge of the field
    for (let k = 0; k < this.K; k++) {
      const i = k * this.NC + slot;
      const x = (cx + rnd()) * CELL, z = (cz + rnd()) * CELL;
      if (!this.grassAt(x, z, this.c)) { this.m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, this.m); continue; }
      const y = this.yAt(x, z), sc = (0.8 + rnd() * 0.7) * edge;
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), rnd() * 6.283);
      this.m.compose(this.v.set(x, y - 0.03, z), this.q, this.s.set(sc * (1.2 + rnd() * 0.6), sc * (0.8 + rnd() * 0.9), sc * (1.2 + rnd() * 0.6)));
      this.mesh.setMatrixAt(i, this.m);
      const f = rnd();
      if (f < 0.05) this.c.setHex([0xff9ec8, 0xfff4f0, 0xffe066, 0xc8a0ff][Math.floor(f * 80) % 4]); // scattered wildflowers
      else this.c.multiplyScalar(0.9 + rnd() * 0.3);
      this.mesh.setColorAt(i, this.c);
    }
  }
  yAt = (_x: number, _z: number) => 0;
}
