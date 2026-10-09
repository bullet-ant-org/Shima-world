/**
 * Curved path network: Catmull-Rom splines sampled into polylines, a spatial hash for lookups, and ribbon mesh generation.
 *  - 'stone'  : flagstone paths (valley, god island, snow, islets): mortar base + irregular slabs
 *  - 'avenue' / 'street' : city roads of gravel with raised concrete sidewalks, curbs and dashed centre lines
 * Pure data + arrays (no THREE); the world turns the arrays into one merged mesh per chunk.
 */
import { CHUNK, hash2, heightAt, noise2 } from './terrain';

export type PathKind = 'stone' | 'avenue' | 'street' | 'sky' | 'runway';
export interface Path {
  id: number; kind: PathKind; width: number; closed: boolean; island: string; mossy: boolean;
  n: number; x: Float32Array; z: Float32Array; tx: Float32Array; tz: Float32Array; len: Float32Array; total: number;
  /** deck elevation per sample (sky roads only) */
  ys?: Float32Array;
}
export interface Seg { path: Path; i: number }
export interface MeshOut { pos: number[]; nor: number[]; col: number[]; idx: number[]; lights?: MeshOut }

const SAMPLE = 5; // metres between samples

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export class PathNet {
  readonly paths: Path[] = [];
  private grid = new Map<string, Seg[]>();
  private chunkIdx = new Map<string, Seg[]>();
  private readonly CELL = 48;

  add(kind: PathKind, width: number, pts: number[][], island: string, closed = false, mossy = false): Path {
    const P = pts, n = P.length, xs: number[] = [], zs: number[] = [], ysA: number[] = [], elev = P[0].length > 2;
    const get = (i: number) => (closed ? P[((i % n) + n) % n] : P[Math.max(0, Math.min(n - 1, i))]);
    const segs = closed ? n : n - 1;
    for (let s = 0; s < segs; s++) {
      const a = get(s - 1), b = get(s), c = get(s + 1), d = get(s + 2);
      const steps = Math.max(2, Math.ceil(Math.hypot(c[0] - b[0], c[1] - b[1]) / SAMPLE));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        xs.push(catmull(a[0], b[0], c[0], d[0], t)); zs.push(catmull(a[1], b[1], c[1], d[1], t));
        if (elev) ysA.push(catmull(a[2], b[2], c[2], d[2], t));
      }
    }
    if (!closed) { xs.push(P[n - 1][0]); zs.push(P[n - 1][1]); if (elev) ysA.push(P[n - 1][2]); } else { xs.push(xs[0]); zs.push(zs[0]); if (elev) ysA.push(ysA[0]); }
    const m = xs.length;
    const path: Path = {
      id: this.paths.length, kind, width, closed, island, mossy, n: m,
      x: Float32Array.from(xs), z: Float32Array.from(zs), tx: new Float32Array(m), tz: new Float32Array(m), len: new Float32Array(m), total: 0,
    };
    if (elev) path.ys = Float32Array.from(ysA);
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1);
      let dx = path.x[b] - path.x[a], dz = path.z[b] - path.z[a];
      const l = Math.hypot(dx, dz) || 1; path.tx[i] = dx / l; path.tz[i] = dz / l;
      if (i > 0) path.len[i] = path.len[i - 1] + Math.hypot(path.x[i] - path.x[i - 1], path.z[i] - path.z[i - 1]);
    }
    path.total = path.len[m - 1];
    this.paths.push(path);
    for (let i = 0; i < m; i++) {
      const gk = this.gk(path.x[i], path.z[i]);
      (this.grid.get(gk) ?? this.grid.set(gk, []).get(gk)!).push({ path, i });
      if (i < m - 1) {
        const mx = (path.x[i] + path.x[i + 1]) / 2, mz = (path.z[i] + path.z[i + 1]) / 2;
        const ck = Math.floor(mx / CHUNK) + ',' + Math.floor(mz / CHUNK);
        (this.chunkIdx.get(ck) ?? this.chunkIdx.set(ck, []).get(ck)!).push({ path, i });
      }
    }
    return path;
  }

  private gk(x: number, z: number) { return Math.floor(x / this.CELL) + ',' + Math.floor(z / this.CELL); }

  /** Distance from (x,z) to the nearest path EDGE (negative = on the road). `extra` includes sidewalks for city roads. */
  edgeDist(x: number, z: number, maxR = 60): number {
    const cx = Math.floor(x / this.CELL), cz = Math.floor(z / this.CELL), r = Math.ceil(maxR / this.CELL);
    let best = maxR;
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const list = this.grid.get(cx + i + ',' + (cz + j));
      if (!list) continue;
      for (const s of list) {
        if (s.path.kind === 'sky') continue; // elevated roads don't occupy the ground
        const d = Math.hypot(s.path.x[s.i] - x, s.path.z[s.i] - z) - s.path.width / 2 - (s.path.kind === 'stone' ? 0 : s.path.kind === 'runway' ? 20 : 4);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /** nearest sample within `maxR` metres, or null */
  nearest(x: number, z: number, maxR: number, kinds?: string[]): Seg | null {
    const cx = Math.floor(x / this.CELL), cz = Math.floor(z / this.CELL), r = Math.ceil(maxR / this.CELL);
    let best: Seg | null = null, bd = maxR;
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const list = this.grid.get(cx + i + ',' + (cz + j));
      if (!list) continue;
      for (const s of list) {
        if (kinds && !kinds.includes(s.path.kind)) continue;
        const d = Math.hypot(s.path.x[s.i] - x, s.path.z[s.i] - z);
        if (d < bd) { bd = d; best = s; }
      }
    }
    return best;
  }

  /** point + tangent at a fraction (0..1) along a path */
  at(path: Path, f: number): { x: number; z: number; tx: number; tz: number } {
    const target = Math.max(0, Math.min(1, f)) * path.total;
    let i = 1;
    while (i < path.n - 1 && path.len[i] < target) i++;
    const l0 = path.len[i - 1], l1 = path.len[i], t = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
    return { x: path.x[i - 1] + (path.x[i] - path.x[i - 1]) * t, z: path.z[i - 1] + (path.z[i] - path.z[i - 1]) * t, tx: path.tx[i], tz: path.tz[i] };
  }

  /** crossings between two paths (centre-line intersections) */
  intersections(a: Path, b: Path): { x: number; z: number; tx: number; tz: number }[] {
    const out: { x: number; z: number; tx: number; tz: number }[] = [];
    for (let i = 0; i < a.n - 1; i++) for (let j = 0; j < b.n - 1; j++) {
      const x1 = a.x[i], z1 = a.z[i], x2 = a.x[i + 1], z2 = a.z[i + 1], x3 = b.x[j], z3 = b.z[j], x4 = b.x[j + 1], z4 = b.z[j + 1];
      const d = (x2 - x1) * (z4 - z3) - (z2 - z1) * (x4 - x3);
      if (Math.abs(d) < 1e-6) continue;
      const t = ((x3 - x1) * (z4 - z3) - (z3 - z1) * (x4 - x3)) / d, u = ((x3 - x1) * (z2 - z1) - (z3 - z1) * (x2 - x1)) / d;
      if (t >= 0 && t < 1 && u >= 0 && u < 1) out.push({ x: x1 + (x2 - x1) * t, z: z1 + (z2 - z1) * t, tx: a.tx[i], tz: a.tz[i] });
    }
    return out;
  }

  segsIn(cx: number, cz: number): Seg[] { return this.chunkIdx.get(cx + ',' + cz) ?? []; }

  // ------------------------------------------------------------------------------------------------------------------
  /** Merged ribbon mesh arrays for every path segment whose midpoint lies in chunk (cx,cz). */
  buildChunkMesh(cx: number, cz: number): MeshOut | null {
    const segs = this.segsIn(cx, cz);
    if (!segs.length) return null;
    const o: MeshOut = { pos: [], nor: [], col: [], idx: [] };
    for (const s of segs) {
      const p = s.path, i = s.i;
      if (p.kind === 'sky') { this.skySeg(o, p, i); continue; }
      if (heightAt((p.x[i] + p.x[i + 1]) / 2, (p.z[i] + p.z[i + 1]) / 2) < 0.8) continue; // no paving over water / river beds
      if (p.kind === 'stone') this.stoneSeg(o, p, i); else if (p.kind === 'runway') this.runwaySeg(o, p, i); else this.roadSeg(o, p, i);
    }
    return o.idx.length || o.lights?.idx.length ? o : null;
  }

  private stoneSeg(o: MeshOut, p: Path, i: number): void {
    const x0 = p.x[i], z0 = p.z[i], x1 = p.x[i + 1], z1 = p.z[i + 1];
    const n0x = -p.tz[i], n0z = p.tx[i], n1x = -p.tz[i + 1], n1z = p.tx[i + 1], hw = p.width / 2;
    const y = (x: number, z: number) => heightAt(x, z) + 0.16;
    // mortar bed
    const edge = (x: number, z: number, nx: number, nz: number, f: number): [number, number, number] => [x + nx * hw * f, 0, z + nz * hw * f];
    const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], rgb: number[], lift: number) => {
      const base = o.pos.length / 3;
      for (const v of [a, b, c, d]) { o.pos.push(v[0], y(v[0], v[2]) + lift, v[2]); o.nor.push(0, 1, 0); o.col.push(rgb[0], rgb[1], rgb[2]); }
      o.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    quad(edge(x0, z0, n0x, n0z, 1), edge(x0, z0, n0x, n0z, -1), edge(x1, z1, n1x, n1z, -1), edge(x1, z1, n1x, n1z, 1), [0.2, 0.2, 0.21], 0);
    // three irregular slabs across, inset so the mortar shows between them
    const moss = p.mossy ? noise2(x0 * 0.03, z0 * 0.03) : 0;
    const fr = [-1, -0.33, 0.33, 1], ins = 0.035, lin = 0.07;
    for (let k = 0; k < 3; k++) {
      const h = hash2(Math.floor(x0 * 3) + k * 17, Math.floor(z0 * 3) - k * 31);
      const g = 0.5 + h * 0.2;
      const rgb = [g * (0.98 - moss * 0.18), g * (1 + moss * 0.08), g * (1.02 - moss * 0.12)];
      const a = fr[k] + ins, b = fr[k + 1] - ins;
      const ax = x0 + (x1 - x0) * lin, az = z0 + (z1 - z0) * lin, bx = x1 - (x1 - x0) * lin, bz = z1 - (z1 - z0) * lin;
      quad(edge(ax, az, n0x, n0z, a), edge(ax, az, n0x, n0z, b), edge(bx, bz, n1x, n1z, b), edge(bx, bz, n1x, n1z, a), rgb, 0.05);
    }
  }

  /** Elevated sky-road deck: slab with side faces and underside, glowing edge strips and dashed centre line (in the `lights` mesh). */
  private skySeg(o: MeshOut, p: Path, i: number): void {
    const lt = (o.lights ??= { pos: [], nor: [], col: [], idx: [] });
    const x0 = p.x[i], z0 = p.z[i], x1 = p.x[i + 1], z1 = p.z[i + 1], y0 = p.ys![i], y1 = p.ys![i + 1];
    const n0x = -p.tz[i], n0z = p.tx[i], n1x = -p.tz[i + 1], n1z = p.tx[i + 1], hw = p.width / 2, th = 1.7;
    const V = (out: MeshOut, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number[]) => { out.pos.push(x, y, z); out.nor.push(nx, ny, nz); out.col.push(c[0], c[1], c[2]); };
    const strip = (out: MeshOut, a: number, b: number, lift: number, c: number[]) => {
      const base = out.pos.length / 3;
      V(out, x0 + n0x * a, y0 + lift, z0 + n0z * a, 0, 1, 0, c); V(out, x0 + n0x * b, y0 + lift, z0 + n0z * b, 0, 1, 0, c);
      V(out, x1 + n1x * b, y1 + lift, z1 + n1z * b, 0, 1, 0, c); V(out, x1 + n1x * a, y1 + lift, z1 + n1z * a, 0, 1, 0, c);
      out.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    strip(o, -hw, hw, 0, [0.5, 0.54, 0.64]);
    const side = (sgn: number, c: number[]) => {
      const base = o.pos.length / 3, nx = n0x * sgn, nz = n0z * sgn;
      V(o, x0 + n0x * hw * sgn, y0, z0 + n0z * hw * sgn, nx, 0, nz, c); V(o, x0 + n0x * hw * sgn, y0 - th, z0 + n0z * hw * sgn, nx, 0, nz, c);
      V(o, x1 + n1x * hw * sgn, y1 - th, z1 + n1z * hw * sgn, nx, 0, nz, c); V(o, x1 + n1x * hw * sgn, y1, z1 + n1z * hw * sgn, nx, 0, nz, c);
      o.idx.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 2, base + 1, base, base + 3, base + 2);
    };
    side(1, [0.34, 0.37, 0.46]); side(-1, [0.34, 0.37, 0.46]);
    { const base = o.pos.length / 3, c = [0.22, 0.24, 0.3];
      V(o, x0 - n0x * hw, y0 - th, z0 - n0z * hw, 0, -1, 0, c); V(o, x0 + n0x * hw, y0 - th, z0 + n0z * hw, 0, -1, 0, c); V(o, x1 + n1x * hw, y1 - th, z1 + n1z * hw, 0, -1, 0, c); V(o, x1 - n1x * hw, y1 - th, z1 - n1z * hw, 0, -1, 0, c);
      o.idx.push(base, base + 2, base + 1, base, base + 3, base + 2); }
    strip(lt, hw - 0.9, hw - 0.35, 0.08, [0.35, 1, 1]); strip(lt, -hw + 0.35, -hw + 0.9, 0.08, [0.35, 1, 1]);
    if ((i & 1) === 0) strip(lt, -0.18, 0.18, 0.08, [1, 1, 1]);
  }

  /** Runway / taxiway: dark asphalt with edge lines, centre dashes and threshold stripes. */
  private runwaySeg(o: MeshOut, p: Path, i: number): void {
    const x0 = p.x[i], z0 = p.z[i], x1 = p.x[i + 1], z1 = p.z[i + 1], n0x = -p.tz[i], n0z = p.tx[i], n1x = -p.tz[i + 1], n1z = p.tx[i + 1], hw = p.width / 2;
    const H = (x: number, z: number) => heightAt(x, z);
    const strip = (a: number, b: number, lift: number, c: number[]) => {
      const base = o.pos.length / 3;
      for (const [x, z, nx, nz, off] of [[x0, z0, n0x, n0z, a], [x0, z0, n0x, n0z, b], [x1, z1, n1x, n1z, b], [x1, z1, n1x, n1z, a]] as number[][]) {
        o.pos.push(x + nx * off, H(x + nx * off, z + nz * off) + lift, z + nz * off); o.nor.push(0, 1, 0); o.col.push(c[0], c[1], c[2]);
      }
      o.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    const g = 0.94 + hash2(Math.floor(x0 * 0.2), Math.floor(z0 * 0.2)) * 0.1;
    strip(-hw, hw, 0.14, [0.2 * g, 0.21 * g, 0.24 * g]);
    strip(-hw + 0.5, -hw + 1.1, 0.16, [0.9, 0.9, 0.92]); strip(hw - 1.1, hw - 0.5, 0.16, [0.9, 0.9, 0.92]);
    if (p.width > 30 && (i % 4) < 2) strip(-0.4, 0.4, 0.16, [0.95, 0.95, 0.95]);
    else if (p.width <= 30 && (i & 1) === 0) strip(-0.2, 0.2, 0.16, [1, 0.85, 0.2]);
    if (p.width > 30 && (i < 5 || i > p.n - 7)) for (let k = -4; k <= 4; k++) if (k) strip(k * 4.4 - 0.9, k * 4.4 + 0.9, 0.17, [0.95, 0.95, 0.95]);
  }

  private roadSeg(o: MeshOut, p: Path, i: number): void {
    const x0 = p.x[i], z0 = p.z[i], x1 = p.x[i + 1], z1 = p.z[i + 1];
    const n0x = -p.tz[i], n0z = p.tx[i], n1x = -p.tz[i + 1], n1z = p.tx[i + 1], hw = p.width / 2, sw = 4.2;
    const H = (x: number, z: number) => heightAt(x, z);
    const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, rgb: number[]) => {
      o.pos.push(x, y, z); o.nor.push(nx, ny, nz); o.col.push(rgb[0], rgb[1], rgb[2]);
    };
    const flat = (a: number, b: number, lift: number, rgb: number[]) => { // strip between lateral offsets a..b
      const base = o.pos.length / 3;
      push(x0 + n0x * a, H(x0 + n0x * a, z0 + n0z * a) + lift, z0 + n0z * a, 0, 1, 0, rgb);
      push(x0 + n0x * b, H(x0 + n0x * b, z0 + n0z * b) + lift, z0 + n0z * b, 0, 1, 0, rgb);
      push(x1 + n1x * b, H(x1 + n1x * b, z1 + n1z * b) + lift, z1 + n1z * b, 0, 1, 0, rgb);
      push(x1 + n1x * a, H(x1 + n1x * a, z1 + n1z * a) + lift, z1 + n1z * a, 0, 1, 0, rgb);
      o.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    const curb = (side: number, rgb: number[]) => { // vertical face between road level and sidewalk level
      const base = o.pos.length / 3, a = hw * side, nx0 = -n0x * side, nz0 = -n0z * side;
      for (const [x, z, nx, nz, lift] of [[x0, z0, n0x, n0z, 0.12], [x0, z0, n0x, n0z, 0.34], [x1, z1, n1x, n1z, 0.34], [x1, z1, n1x, n1z, 0.12]] as number[][]) {
        push(x + nx * a, H(x + nx * a, z + nz * a) + lift, z + nz * a, nx0, 0, nz0, rgb);
      }
      o.idx.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 2, base + 1, base, base + 3, base + 2);
    };
    const g = 0.92 + hash2(Math.floor(x0 * 0.4), Math.floor(z0 * 0.4)) * 0.16;
    const gravel = [0.5 * g, 0.46 * g, 0.4 * g], walk = [0.68 * g, 0.66 * g, 0.62 * g];
    flat(-hw, hw, 0.12, gravel);
    flat(hw, hw + sw, 0.34, walk); flat(-hw - sw, -hw, 0.34, walk);
    curb(1, [0.45, 0.44, 0.42]); curb(-1, [0.45, 0.44, 0.42]);
    // wheel-worn darker lanes in the gravel
    flat(-hw * 0.55, -hw * 0.35, 0.125, [0.42 * g, 0.39 * g, 0.34 * g]); flat(hw * 0.35, hw * 0.55, 0.125, [0.42 * g, 0.39 * g, 0.34 * g]);
    if (p.kind === 'avenue' && (i & 1) === 0) flat(-0.2, 0.2, 0.13, [0.9, 0.78, 0.3]); // dashed centre line
  }
}
