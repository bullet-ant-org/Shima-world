/**
 * Procedural architecture. Everything is built once into merged, vertex-coloured geometry (cached by key) and then instanced,
 * so detail costs triangles only inside the near ring and never costs draw calls per building.
 *
 * Each design yields up to 3 geometries:
 *   lit    : walls, protruding window surrounds + sills, balconies, awnings, rooftop clutter (lit vertex colours)
 *   lights : lit windows, neon, beacons, lantern flames (unlit, brightened at night)
 *   far    : simplified body with UVs for the shared window-atlas facade material (used beyond the near ring)
 */
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../world/terrain';

type V3 = [number, number, number];
export const hex = (h: number): V3 => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const mixc = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Mesh builder: flat-shaded quads/tris with outward-facing winding resolved from an interior hint point. */
export class MB {
  P: number[] = []; N: number[] = []; C: number[] = []; U: number[] = []; I: number[] = [];
  constructor(private withUV = false) {}

  quad(a: V3, b: V3, c: V3, d: V3, col: V3, hint?: V3, uv?: number[]): void {
    let q: V3[] = [a, b, c, d], u = uv;
    let n = cross(sub(b, a), sub(d, a));
    if (hint) {
      const m: V3 = [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4, (a[2] + b[2] + c[2] + d[2]) / 4];
      if (dot(n, sub(m, hint)) < 0) { q = [a, d, c, b]; if (u) u = [u[0], u[1], u[6], u[7], u[4], u[5], u[2], u[3]]; n = [-n[0], -n[1], -n[2]]; }
    }
    const l = Math.hypot(n[0], n[1], n[2]) || 1, base = this.P.length / 3;
    for (let i = 0; i < 4; i++) {
      this.P.push(q[i][0], q[i][1], q[i][2]); this.N.push(n[0] / l, n[1] / l, n[2] / l); this.C.push(col[0], col[1], col[2]);
      if (this.withUV) this.U.push(u ? u[i * 2] : 0, u ? u[i * 2 + 1] : 0);
    }
    this.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(a: V3, b: V3, c: V3, col: V3, hint?: V3): void {
    let q: V3[] = [a, b, c], n = cross(sub(b, a), sub(c, a));
    if (hint) { const m: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]; if (dot(n, sub(m, hint)) < 0) { q = [a, c, b]; n = [-n[0], -n[1], -n[2]]; } }
    const l = Math.hypot(n[0], n[1], n[2]) || 1, base = this.P.length / 3;
    for (const p of q) { this.P.push(p[0], p[1], p[2]); this.N.push(n[0] / l, n[1] / l, n[2] / l); this.C.push(col[0], col[1], col[2]); if (this.withUV) this.U.push(0, 0); }
    this.I.push(base, base + 1, base + 2);
  }
  /** oriented box; U = along (x,z unit), Nn = outward normal (x,z unit); mask: 1 front, 2 back, 4 +u, 8 -u, 16 top, 32 bottom */
  obox(cx: number, cy: number, cz: number, ux: number, uz: number, nx: number, nz: number, w: number, h: number, d: number, col: V3, mask = 63): void {
    const hw = w / 2, hh = h / 2, hd = d / 2, hint: V3 = [cx, cy, cz];
    const c = (a: number, b: number, e: number): V3 => [cx + ux * hw * a + nx * hd * e, cy + hh * b, cz + uz * hw * a + nz * hd * e];
    if (mask & 1) this.quad(c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1), col, hint);
    if (mask & 2) this.quad(c(-1, -1, -1), c(1, -1, -1), c(1, 1, -1), c(-1, 1, -1), shade(col, 0.8), hint);
    if (mask & 4) this.quad(c(1, -1, -1), c(1, -1, 1), c(1, 1, 1), c(1, 1, -1), shade(col, 0.88), hint);
    if (mask & 8) this.quad(c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1), shade(col, 0.88), hint);
    if (mask & 16) this.quad(c(-1, 1, -1), c(1, 1, -1), c(1, 1, 1), c(-1, 1, 1), shade(col, 1.08), hint);
    if (mask & 32) this.quad(c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1), shade(col, 0.6), hint);
  }
  /** axis-aligned box */
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number, col: V3, mask = 63): void { this.obox(cx, cy, cz, 1, 0, 0, 1, w, h, d, col, mask); }
  /** convex n-gon prism, base at y0, top at y1 (optional roof cap) */
  prism(poly: number[][], y0: number, y1: number, col: V3, roof: V3 | null, uvScale?: [number, number]): void {
    const n = poly.length;
    let cx = 0, cz = 0; for (const p of poly) { cx += p[0]; cz += p[1]; } cx /= n; cz /= n;
    const hint: V3 = [cx, (y0 + y1) / 2, cz];
    let run = 0;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const uv = uvScale ? [run / uvScale[0], y0 / uvScale[1], (run + L) / uvScale[0], y0 / uvScale[1], (run + L) / uvScale[0], y1 / uvScale[1], run / uvScale[0], y1 / uvScale[1]] : undefined;
      run += L;
      this.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], col, hint, uv);
    }
    if (roof) for (let i = 0; i < n; i++) this.tri([poly[i][0], y1, poly[i][1]], [poly[(i + 1) % n][0], y1, poly[(i + 1) % n][1]], [cx, y1, cz], roof, [cx, y1 - 1, cz]);
  }
  /** frustum between two rectangles (hip roof / pagoda eave), centred at (cx,cz) */
  frustum(cx: number, cz: number, w0: number, d0: number, w1: number, d1: number, y0: number, y1: number, col: V3, ry = 0): void {
    const c = Math.cos(ry), s = Math.sin(ry);
    const pt = (x: number, z: number, y: number): V3 => [cx + x * c - z * s, y, cz + x * s + z * c];
    const b = [pt(-w0 / 2, -d0 / 2, y0), pt(w0 / 2, -d0 / 2, y0), pt(w0 / 2, d0 / 2, y0), pt(-w0 / 2, d0 / 2, y0)];
    const t = [pt(-w1 / 2, -d1 / 2, y1), pt(w1 / 2, -d1 / 2, y1), pt(w1 / 2, d1 / 2, y1), pt(-w1 / 2, d1 / 2, y1)];
    const hint: V3 = [cx, (y0 + y1) / 2 - 0.4, cz];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; this.quad(b[i], b[j], t[j], t[i], shade(col, 0.82 + 0.1 * (i & 1)), hint); }
    this.quad(t[0], t[1], t[2], t[3], col, hint);
    this.quad(b[0], b[3], b[2], b[1], shade(col, 0.5), [cx, y0 + 1, cz]); // underside
  }
  /** n-gon cylinder / cone about a vertical axis */
  cyl(cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, n: number, col: V3, cap = true): void {
    const hint: V3 = [cx, (y0 + y1) / 2, cz];
    const pt = (i: number, r: number, y: number): V3 => [cx + Math.cos((i / n) * 6.2832) * r, y, cz + Math.sin((i / n) * 6.2832) * r];
    for (let i = 0; i < n; i++) this.quad(pt(i, r0, y0), pt(i + 1, r0, y0), pt(i + 1, r1, y1), pt(i, r1, y1), shade(col, 0.88 + 0.12 * Math.cos((i / n) * 6.2832)), hint);
    if (cap && r1 > 0.01) for (let i = 0; i < n; i++) this.tri(pt(i, r1, y1), pt(i + 1, r1, y1), [cx, y1, cz], shade(col, 1.1), [cx, y1 - 1, cz]);
    else if (cap) { /* cone apex: sides already meet */ }
  }
  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    if (this.withUV) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setIndex(this.I);
    g.computeBoundingSphere();
    return g;
  }
  get empty(): boolean { return this.I.length === 0; }
}

// ---------------------------------------------------------------------------------------------------------------------
// City buildings
// ---------------------------------------------------------------------------------------------------------------------
export type Tpl = 'box' | 'L' | 'step' | 'round' | 'twin' | 'podium' | 'wedge';
export interface BuildingSpec { tpl: Tpl; w: number; d: number; fl: number; pal: number; roof: number; seed: number; shop: boolean }
export interface BuildingGeo { lit: THREE.BufferGeometry; lights: THREE.BufferGeometry | null; far: THREE.BufferGeometry }

const FH = 3.6;
export const PALETTES = [
  { wall: 0xd8cfbf, trim: 0xf1ece2, awn: [0xc8283c, 0xe9dfc8] },  // warm concrete
  { wall: 0xb4573f, trim: 0xe3d3bd, awn: [0x2c5f7a, 0xe9dfc8] },  // brick
  { wall: 0xe6e3dc, trim: 0x8b94a3, awn: [0x2a8f7a, 0xf0d98a] },  // white stucco
  { wall: 0x7ea7b5, trim: 0xdfe9ee, awn: [0xd4793a, 0xf2e9d8] },  // blue-grey glass tower
  { wall: 0xc9a047, trim: 0xf2e6c4, awn: [0x7a2f5e, 0xf2e9d8] },  // mustard
  { wall: 0x9fc4b0, trim: 0xe9f2ed, awn: [0xc8283c, 0xf0e6d0] },  // mint
  { wall: 0x8e8aa8, trim: 0xe3e1ee, awn: [0x25c8e6, 0x2a2f45] },  // lavender slate
  { wall: 0xd9a9a0, trim: 0xf4e7e3, awn: [0x2c5f7a, 0xe9dfc8] },  // dusty rose
];
const NEON: V3[] = [hex(0xff3d9a), hex(0x25e6ff), hex(0xffb02e), hex(0x9a6bff), hex(0x4dff9a)];
const WARM_LIT: V3[] = [hex(0xffd9a0), hex(0xffe9c0), hex(0x9ff3ff), hex(0xffc4e0), hex(0xfff2d0)];
const GLASS = hex(0x2c4a63), GLASS_B = hex(0x3a6a8a);

interface Prism { poly: number[][]; y0: number; fl: number }
const rect = (cx: number, cz: number, w: number, d: number): number[][] => [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]];

function footprints(s: BuildingSpec): Prism[] {
  const { w, d, fl } = s;
  switch (s.tpl) {
    case 'L': return [{ poly: rect(0, -d * 0.2, w, d * 0.6), y0: 0, fl }, { poly: rect(w * 0.25, d * 0.2, w * 0.5, d * 0.6), y0: 0, fl: Math.max(2, Math.round(fl * 0.62)) }];
    case 'step': {
      const f1 = Math.max(2, Math.round(fl * 0.5)), f2 = Math.max(1, Math.round(fl * 0.28)), f3 = Math.max(1, fl - f1 - f2);
      return [{ poly: rect(0, 0, w, d), y0: 0, fl: f1 }, { poly: rect(0, 0, w * 0.78, d * 0.78), y0: f1 * FH, fl: f2 }, { poly: rect(0, 0, w * 0.56, d * 0.56), y0: (f1 + f2) * FH, fl: f3 }];
    }
    case 'round': { const r = Math.min(w, d) / 2, n = 12, poly: number[][] = []; for (let i = 0; i < n; i++) poly.push([Math.cos((i / n) * 6.2832) * r, Math.sin((i / n) * 6.2832) * r]); return [{ poly, y0: 0, fl }]; }
    case 'twin': return [{ poly: rect(-w * 0.3, 0, w * 0.4, d * 0.85), y0: 0, fl }, { poly: rect(w * 0.3, 0, w * 0.4, d * 0.85), y0: 0, fl: Math.max(3, Math.round(fl * 0.86)) }];
    case 'podium': { const f = Math.min(4, Math.max(2, fl >> 2)); return [{ poly: rect(0, 0, w, d), y0: 0, fl: f }, { poly: rect(0, 0, w * 0.56, d * 0.56), y0: f * FH, fl: fl - f }]; }
    case 'wedge': return [{ poly: [[-w / 2, -d / 2], [w / 2, -d / 2], [0, d / 2]], y0: 0, fl }];
    default: return [{ poly: rect(0, 0, w, d), y0: 0, fl }];
  }
}

function addWindows(lit: MB, lights: MB, poly: number[][], y0: number, fl: number, pal: (typeof PALETTES)[number], r: () => number, residential: boolean, shop: boolean): void {
  const n = poly.length;
  let cx = 0, cz = 0; for (const p of poly) { cx += p[0]; cz += p[1]; } cx /= n; cz /= n;
  const trim = hex(pal.trim), full = fl <= 16;
  const litAmount = 0.28 + r() * 0.35;
  for (let e = 0; e < n; e++) {
    const a = poly[e], b = poly[(e + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 6) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let nx = uz, nz = -ux;
    if (nx * (a[0] - cx) + nz * (a[1] - cz) < 0) { nx = -nx; nz = -nz; }
    const cols = Math.max(1, Math.floor((L - 1.4) / 4.7)), sp = L / cols, ww = Math.min(2.8, sp * 0.6), wh = FH * 0.58;
    const awn = pal.awn;
    for (let f = 0; f < fl; f++) {
      const ground = f === 0 && shop;
      for (let c = 0; c < cols; c++) {
        const t = (c + 0.5) * sp;
        const px = a[0] + ux * t, pz = a[1] + uz * t;
        const yc = y0 + f * FH + FH * 0.55;
        if (ground) {
          // shop front: big glazed opening, dark frame, striped awning, blade sign
          const sw = sp * 0.82, sh = FH * 0.72, y = y0 + sh / 2 + 0.2;
          lit.obox(px + nx * 0.1, y, pz + nz * 0.1, ux, uz, nx, nz, sw, sh, 0.2, hex(0x2a2f3d), 1 | 4 | 8 | 16);
          lit.obox(px + nx * 0.21, y, pz + nz * 0.21, ux, uz, nx, nz, sw - 0.5, sh - 0.5, 0.02, GLASS_B, 1);
          if (r() < 0.8) lights.obox(px + nx * 0.23, y - 0.2, pz + nz * 0.23, ux, uz, nx, nz, sw - 0.9, sh - 1.1, 0.02, WARM_LIT[Math.floor(r() * 5)], 1);
          const ac = hex(awn[(c & 1)]);
          lit.quad([px - ux * sw / 2 - nx * 0.0 + nx * 0.2, y0 + sh + 0.3, pz - uz * sw / 2 + nz * 0.2], [px + ux * sw / 2 + nx * 0.2, y0 + sh + 0.3, pz + uz * sw / 2 + nz * 0.2],
            [px + ux * sw / 2 + nx * 1.5, y0 + sh - 0.35, pz + uz * sw / 2 + nz * 1.5], [px - ux * sw / 2 + nx * 1.5, y0 + sh - 0.35, pz - uz * sw / 2 + nz * 1.5], ac, [px, y0 + sh - 1, pz]);
          continue;
        }
        // protruding window: surround (depth .16) + sill (depth .38) + inset glass; lit windows glow
        const ox = px + nx * 0.08, oz = pz + nz * 0.08;
        lit.obox(ox, yc, oz, ux, uz, nx, nz, ww + 0.34, wh + 0.34, 0.16, trim, 1 | 4 | 8 | 16 | 32);
        if (full || f < 6) lit.obox(px + nx * 0.19, yc - wh / 2 - 0.2, pz + nz * 0.19, ux, uz, nx, nz, ww + 0.7, 0.14, 0.4, shade(trim, 0.85), 1 | 4 | 8 | 16);
        lit.obox(px + nx * 0.165, yc, pz + nz * 0.165, ux, uz, nx, nz, ww, wh, 0.02, (c + f) & 1 ? GLASS : GLASS_B, 1);
        if (r() < litAmount) lights.obox(px + nx * 0.18, yc, pz + nz * 0.18, ux, uz, nx, nz, ww * 0.88, wh * 0.88, 0.02, WARM_LIT[Math.floor(r() * 5)], 1);
        if (residential && full && f > 0 && (c + f) % 3 === 0 && f % 2 === 0) { // little balcony with railing
          lit.obox(px + nx * 0.6, yc - wh / 2 - 0.3, pz + nz * 0.6, ux, uz, nx, nz, ww + 0.9, 0.16, 1.2, shade(trim, 0.9), 1 | 4 | 8 | 16 | 32);
          lit.obox(px + nx * 1.15, yc - wh / 2 + 0.25, pz + nz * 1.15, ux, uz, nx, nz, ww + 0.9, 0.7, 0.06, hex(0x37404f), 1 | 16);
        }
      }
    }
  }
}

function addRoof(lit: MB, lights: MB, p: Prism, topY: number, pal: (typeof PALETTES)[number], r: () => number, kind: number, height: number): void {
  let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
  for (const q of p.poly) { minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]); minz = Math.min(minz, q[1]); maxz = Math.max(maxz, q[1]); }
  const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2, w = maxx - minx, d = maxz - minz, grey = hex(0x7d838f), dark = hex(0x3b404c);
  // parapet lip
  lit.box(cx, topY + 0.3, cz, w * 0.96, 0.6, d * 0.96, shade(hex(pal.trim), 0.9), 16 | 4 | 8 | 1 | 2);
  const place = (k: number) => [cx + (r() - 0.5) * w * 0.5, cz + (r() - 0.5) * d * 0.5] as const;
  for (let i = 0; i < 2 + (kind & 1); i++) { const [x, z] = place(i); lit.box(x, topY + 1.2, z, 2.2 + r() * 1.5, 1.1, 1.8 + r(), grey); lit.box(x, topY + 1.85, z, 1.6, 0.25, 1.4, dark); }
  if (kind === 1 || kind === 5) { // water tank on legs
    const [x, z] = place(9);
    for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) lit.box(x + lx * 1.1, topY + 1.7, z + lz * 1.1, 0.25, 3.4, 0.25, dark);
    lit.cyl(x, z, 1.7, 1.7, topY + 3.4, topY + 6, 10, hex(0x8a6a4a)); lit.cyl(x, z, 1.8, 0.3, topY + 6, topY + 7.2, 10, hex(0x5a4632));
  }
  if (kind === 2 || kind === 6) { // antenna mast with warning beacon
    const [x, z] = place(3), h = 12 + Math.min(40, height * 0.14);
    lit.box(x, topY + h / 2, z, 0.5, h, 0.5, dark);
    for (let k = 1; k < 4; k++) lit.box(x, topY + (h * k) / 4, z, 3.2 - k * 0.6, 0.18, 0.18, dark);
    lights.box(x, topY + h + 0.4, z, 0.8, 0.8, 0.8, hex(0xff3030));
  }
  if (kind === 3) { // helipad
    lit.cyl(cx, cz, Math.min(w, d) * 0.36, Math.min(w, d) * 0.36, topY + 0.6, topY + 0.9, 14, hex(0x4a4f5c));
    lights.box(cx, topY + 0.95, cz, 1.2, 0.05, 6, hex(0xffe27a)); lights.box(cx, topY + 0.95, cz, 4.4, 0.05, 1.2, hex(0xffe27a));
  }
  if (kind === 4 || kind === 7) { // neon billboard on a frame
    const c = NEON[Math.floor(r() * NEON.length)], bw = Math.min(w * 0.7, 18), x = cx, z = cz + d * 0.3;
    lit.box(x, topY + 3, z, bw + 0.6, 6.6, 0.4, dark, 63);
    lights.box(x, topY + 3.2, z + 0.25, bw, 5.4, 0.05, c, 1);
    lights.box(x, topY + 3.2, z - 0.25, bw, 5.4, 0.05, c, 2);
    lit.box(x - bw / 3, topY + 0.8, z, 0.4, 1.6, 0.4, dark); lit.box(x + bw / 3, topY + 0.8, z, 0.4, 1.6, 0.4, dark);
  }
  if (height > 90) { // crown ring light
    lights.box(cx, topY + 0.9, cz - d * 0.48, w * 0.98, 0.25, 0.25, NEON[(Math.floor(cx) & 3) + 1]);
    lights.box(cx, topY + 0.9, cz + d * 0.48, w * 0.98, 0.25, 0.25, NEON[(Math.floor(cx) & 3) + 1]);
  }
}

const cache = new Map<string, BuildingGeo>();
const specKey = (s: BuildingSpec) => `${s.tpl}|${s.w}|${s.d}|${s.fl}|${s.pal}|${s.roof}|${s.seed}|${s.shop ? 1 : 0}`;

/** `detail` = near geometry (protruding windows etc); the far geometry is always built. Cached per spec. */
export function buildingGeo(spec: BuildingSpec, detail: boolean): { lit: THREE.BufferGeometry; lights: THREE.BufferGeometry | null } {
  const key = specKey(spec) + (detail ? 'N' : 'F');
  const hit = cache.get(key);
  if (hit) return { lit: hit.lit, lights: hit.lights };
  const pal = PALETTES[spec.pal % PALETTES.length], wall = hex(pal.wall), r = mulberry32(spec.seed);
  const prisms = footprints(spec);
  const lit = new MB(!detail), lights = new MB();
  const residential = spec.fl <= 14 && spec.pal !== 3;
  let topPrism = prisms[0], topY = 0;
  prisms.forEach((p) => {
    const h = p.fl * FH, y1 = p.y0 + h;
    const col = mixc(wall, hex(0xffffff), 0.04 * (p.y0 > 0 ? 1 : 0));
    // detailed buildings: darker plinth band; far buildings: texture handles windows (UV tile = 8 windows x 8 floors)
    lit.prism(p.poly, p.y0, y1, col, shade(wall, 0.7), detail ? undefined : [33, 28.8]);
    if (detail) addWindows(lit, lights, p.poly, p.y0, p.fl, pal, r, residential, spec.shop && p.y0 === 0);
    if (y1 > topY) { topY = y1; topPrism = p; }
  });
  if (detail) {
    if (spec.tpl === 'twin') { // sky bridge between the two towers
      const y = Math.round(spec.fl * 0.6) * FH;
      lit.box(0, y + 3, 0, spec.w * 0.3, 7, spec.d * 0.4, shade(wall, 0.85));
      lights.box(0, y + 4, spec.d * 0.201, spec.w * 0.26, 2.2, 0.05, WARM_LIT[1], 1);
    }
    addRoof(lit, lights, topPrism, topY, pal, r, spec.roof, topY);
    // street-level blade signs
    if (spec.shop) {
      const c = NEON[Math.floor(r() * NEON.length)], px = prisms[0].poly[0][0], pz = prisms[0].poly[0][1] + 0.01;
      lit.box(px + 1.2, 6.2, pz - 0.3, 0.14, 6, 0.14, hex(0x2a2f3d));
      lights.box(px + 1.2, 5.2, pz - 1.0, 0.18, 4.2, 1.3, c);
    }
  }
  const out = { lit: lit.toGeometry(), lights: lights.empty ? null : lights.toGeometry(), far: null as unknown as THREE.BufferGeometry };
  cache.set(key, out as BuildingGeo);
  return { lit: out.lit, lights: out.lights };
}

// ---------------------------------------------------------------------------------------------------------------------
// Traditional architecture: houses, temples, shrines, pagodas, gates, statues, lanterns
// ---------------------------------------------------------------------------------------------------------------------
const WOOD = hex(0x6b4630), WOOD_D = hex(0x4a3020), PLASTER = hex(0xece4d2), TILE = hex(0x3a4258), TILE_L = hex(0x4c566f), RED = hex(0xc8283c), GOLD = hex(0xd9a441);
const STONE = hex(0x8d9096), STONE_D = hex(0x6d7078);

/** Hip roof with swept eaves: two stacked frusta (flat eave, steeper crown), ridge cap, and upturned corner tips. */
function hipRoof(m: MB, cx: number, cz: number, w: number, d: number, y: number, rise: number, over: number, col: V3, ry = 0): void {
  const w0 = w + over * 2, d0 = d + over * 2;
  m.frustum(cx, cz, w0, d0, w0 * 0.62, d0 * 0.62, y, y + rise * 0.3, col, ry);
  m.frustum(cx, cz, w0 * 0.62, d0 * 0.62, Math.max(0.6, w0 * 0.12), Math.max(0.6, d0 * 0.12), y + rise * 0.3, y + rise, shade(col, 1.05), ry);
  const c = Math.cos(ry), s = Math.sin(ry);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { // upturned eave tips
    const x = (sx * w0) / 2, z = (sz * d0) / 2;
    m.cyl(cx + x * c - z * s, cz + x * s + z * c, 0.28, 0.05, y - 0.05, y + 0.65, 4, GOLD);
  }
}

export interface Pair { lit: THREE.BufferGeometry; lights: THREE.BufferGeometry | null }
const done = (lit: MB, lights: MB): Pair => ({ lit: lit.toGeometry(), lights: lights.empty ? null : lights.toGeometry() });

/** Japanese house. variant 0: tea house/shop, 1: farmhouse, 2: two-storey townhouse. snow: pale snow-laden roof. */
export function houseGeo(variant: number, snow = false): Pair {
  const m = new MB(), l = new MB();
  const w = [9, 11, 8][variant], d = [7, 8.5, 7][variant], fl = variant === 2 ? 2 : 1, h = fl * 3.2;
  const roofC = snow ? hex(0xe8f0f8) : variant === 1 ? hex(0x5a6b48) : TILE;
  m.box(0, 0.3, 0, w + 1.2, 0.6, d + 1.2, STONE_D, 63 & ~32);                                    // stone plinth
  m.box(0, -1.5, 0, w + 1.2, 3, d + 1.2, STONE_D, 63 & ~32);                                       // foundation skirt so slopes never show a gap
  m.box(0, 0.6 + h / 2, 0, w, h, d, PLASTER);                                                       // plaster walls
  // timber frame: corner posts, rails, and cross beams
  for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) m.box((x * w) / 2, 0.6 + h / 2, (z * d) / 2, 0.3, h + 0.1, 0.3, WOOD);
  for (let f = 0; f <= fl; f++) { m.box(0, 0.6 + f * 3.2, d / 2 + 0.02, w + 0.2, 0.28, 0.2, WOOD); m.box(0, 0.6 + f * 3.2, -d / 2 - 0.02, w + 0.2, 0.28, 0.2, WOOD); }
  // front: sliding door + shoji windows with lattice that stands proud of the wall
  m.box(-w * 0.18, 0.6 + 1.2, d / 2 + 0.08, 1.7, 2.3, 0.14, WOOD_D, 1 | 4 | 8 | 16);
  m.box(-w * 0.18, 0.6 + 1.2, d / 2 + 0.17, 1.5, 2.1, 0.02, hex(0xf3ead2), 1); l.box(-w * 0.18, 0.6 + 1.2, d / 2 + 0.19, 1.3, 1.9, 0.02, hex(0xffcf8a), 1);
  for (let f = 0; f < fl; f++) for (const x of [w * 0.2, w * 0.38]) {
    const y = 0.6 + f * 3.2 + 1.7;
    m.box(x, y, d / 2 + 0.1, 1.35, 1.35, 0.18, WOOD_D, 1 | 4 | 8 | 16 | 32);
    m.box(x, y, d / 2 + 0.2, 1.1, 1.1, 0.02, hex(0xf3ead2), 1);
    for (const k of [-0.28, 0, 0.28]) { m.box(x + k, y, d / 2 + 0.23, 0.05, 1.1, 0.03, WOOD_D, 1); m.box(x, y + k, d / 2 + 0.23, 1.1, 0.05, 0.03, WOOD_D, 1); }
    l.box(x, y, d / 2 + 0.215, 0.95, 0.95, 0.02, hex(0xffd69a), 1);
  }
  // side windows
  for (const sx of [-1, 1]) for (let f = 0; f < fl; f++) { m.box(sx * (w / 2 + 0.08), 0.6 + f * 3.2 + 1.7, 0, 0.18, 1.2, 1.5, WOOD_D, 63 & ~(sx > 0 ? 8 : 4)); }
  // engawa: raised veranda with posts and eave brackets
  m.box(0, 0.5, d / 2 + 1.3, w + 0.6, 0.22, 1.9, hex(0x8a6a4a), 63 & ~32);
  for (const x of [-w / 2, 0, w / 2]) m.box(x, 0.6 + 1.6, d / 2 + 2.15, 0.22, 3.2, 0.22, WOOD);
  if (variant === 2) { m.box(0, 0.6 + 3.2, d / 2 + 1.3, w + 0.6, 0.18, 1.9, WOOD); m.box(0, 0.6 + 3.7, d / 2 + 2.2, w + 0.5, 0.9, 0.08, WOOD, 1 | 16); }
  hipRoof(m, 0, 0, w, d, 0.6 + h, variant === 1 ? 4.6 : 3.4, 1.9, roofC);
  // chimney + hanging lantern
  m.box(w * 0.28, 0.6 + h + 3.3, -d * 0.2, 0.9, 2.4, 0.9, snow ? hex(0xcfd6e0) : hex(0x5a5048));
  m.cyl(-w * 0.18, d / 2 + 2.15, 0.01, 0.01, 0.6 + 3.3, 0.6 + 3.31, 3, WOOD, false);
  m.box(-w * 0.18, 0.6 + 2.7, d / 2 + 2.15, 0.45, 0.6, 0.45, RED); l.box(-w * 0.18, 0.6 + 2.7, d / 2 + 2.15, 0.34, 0.5, 0.34, hex(0xffb25a));
  return done(m, l);
}

/** Grand temple hall: stone base with stairs, red columns, double roof. */
export function templeGeo(scale = 1): Pair {
  const m = new MB(), l = new MB(), w = 26 * scale, d = 18 * scale;
  m.box(0, -5, 0, w + 8, 10, d + 8, STONE_D, 63 & ~32);
  for (let i = 0; i < 3; i++) m.box(0, 0.6 + i * 1.2, 0, w + 8 - i * 2.5, 1.2, d + 8 - i * 2.5, shade(STONE, 0.9 + i * 0.06), 63 & ~32);
  const y0 = 3.6, hh = 7;
  m.box(0, y0 + hh / 2, 0, w - 1, hh, d - 1, hex(0xf2ead8));
  for (let i = 0; i < 8; i++) { const x = -w / 2 + (i * w) / 7; for (const z of [-d / 2, d / 2]) m.cyl(x, z, 0.62, 0.55, y0, y0 + hh + 0.6, 8, RED); }
  for (const z of [-d / 2, d / 2]) m.box(0, y0 + hh + 0.6, z, w + 0.8, 0.8, 0.8, hex(0x1d1a22));
  for (let i = 0; i < 3; i++) { const x = (i - 1) * w * 0.28; m.box(x, y0 + 2.3, d / 2 + 0.1, w * 0.18, 4.3, 0.18, WOOD_D, 1 | 4 | 8 | 16); l.box(x, y0 + 2.3, d / 2 + 0.22, w * 0.15, 3.9, 0.02, hex(0xffbf70), 1); }
  hipRoof(m, 0, 0, w, d, y0 + hh + 1.3, 5.5, 3.6 * scale, TILE);
  hipRoof(m, 0, 0, w * 0.55, d * 0.55, y0 + hh + 6.5, 4.8, 2.4 * scale, TILE_L);
  m.cyl(0, 0, 0.2, 0.2, y0 + hh + 11.3, y0 + hh + 14.5, 5, GOLD);
  for (let i = 0; i < 9; i++) m.box(0, 0.35 + i * 0.4, d / 2 + 4.2 + (9 - i) * 0.55, w * 0.3, 0.4, 0.7, shade(STONE, 0.95 + (i & 1) * 0.06), 63 & ~32); // front stairs
  for (const x of [-1, 1]) { m.box(x * w * 0.2, 4.4, d / 2 + 5.6, 0.7, 1.7, 0.7, STONE_D); l.box(x * w * 0.2, 5.6, d / 2 + 5.6, 0.5, 0.6, 0.5, hex(0x7be8ff)); }
  return done(m, l);
}

/** Small shrine: raised hall, rope, offering box, gable roof. */
export function shrineGeo(): Pair {
  const m = new MB(), l = new MB();
  m.box(0, -3, 0, 9, 6, 7, STONE_D, 63 & ~32); m.box(0, 0.5, 0, 9, 1, 7, STONE, 63 & ~32); m.box(0, 3.1, 0, 6.4, 4.2, 5, hex(0xe9e0cc));
  for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) m.cyl(x * 3.2, z * 2.5, 0.3, 0.3, 1, 5.5, 6, RED);
  m.box(0, 2.6, 2.55, 2, 3, 0.15, WOOD_D, 1 | 4 | 8); l.box(0, 2.7, 2.65, 1.6, 2.6, 0.02, hex(0x9ff3ff), 1);
  hipRoof(m, 0, 0, 6.4, 5, 5.3, 3.4, 2.2, TILE);
  m.box(0, 1.5, 4.4, 1.6, 0.7, 0.9, WOOD); // offering box
  for (let i = 0; i < 4; i++) m.box(0, 0.2 + i * 0.25, 5.4 + (4 - i) * 0.5, 4, 0.25, 0.6, shade(STONE, 0.9 + (i & 1) * 0.08), 63 & ~32);
  return done(m, l);
}

/** Five-storey pagoda. */
export function pagodaGeo(tiers = 5, roofCol = TILE, wallCol = RED): Pair {
  const m = new MB(), l = new MB();
  m.box(0, -3, 0, 16, 6, 16, STONE_D, 63 & ~32); m.box(0, 0.8, 0, 16, 1.6, 16, STONE, 63 & ~32); m.box(0, 2.0, 0, 14, 0.8, 14, shade(STONE, 1.08), 63 & ~32);
  let y = 2.4, w = 9.4;
  for (let i = 0; i < tiers; i++) {
    const h = 4.2 - i * 0.2;
    m.box(0, y + h / 2, 0, w * 0.82, h, w * 0.82, i % 2 ? hex(0xf0e6d0) : wallCol);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) m.box(sx * w * 0.41, y + h / 2, sz * w * 0.41, 0.36, h, 0.36, WOOD_D);
    l.box(0, y + h * 0.55, w * 0.415, w * 0.2, h * 0.5, 0.03, hex(0xffbf70), 1); l.box(0, y + h * 0.55, -w * 0.415, w * 0.2, h * 0.5, 0.03, hex(0xffbf70), 2);
    hipRoof(m, 0, 0, w * 0.82, w * 0.82, y + h, 1.8, 1.9, roofCol);
    y += h + 1.0; w *= 0.88;
  }
  m.cyl(0, 0, 0.18, 0.18, y, y + 6.5, 6, GOLD);
  for (let i = 1; i <= 5; i++) m.cyl(0, 0, 0.9 - i * 0.12, 0.9 - i * 0.12, y + i * 0.9, y + i * 0.9 + 0.22, 8, GOLD, true);
  return done(m, l);
}

/** Two-storey temple gate (sanmon). */
export function sanmonGeo(): Pair {
  const m = new MB(), l = new MB();
  m.box(0, -4, 0, 24, 8, 11, STONE_D, 63 & ~32); m.box(0, 0.7, 0, 24, 1.4, 11, STONE, 63 & ~32);
  for (const x of [-9, -3, 3, 9]) for (const z of [-3.6, 3.6]) m.cyl(x, z, 0.75, 0.7, 1.4, 10, 8, RED);
  m.box(0, 10.2, 0, 22, 1, 9.4, WOOD_D); m.box(0, 11.3, 0, 21, 3.2, 8, hex(0xf0e6d0));
  for (const x of [-9, -3, 3, 9]) for (const z of [-3.6, 3.6]) m.cyl(x, z, 0.5, 0.5, 11.3, 14.2, 8, RED);
  m.box(0, 5.6, 0, 22, 0.9, 1, hex(0x1d1a22));
  hipRoof(m, 0, 0, 20, 8, 7.4, 2.4, 3, TILE); hipRoof(m, 0, 0, 22, 9, 14.2, 4.6, 3.6, TILE_L);
  for (const x of [-1, 1]) { l.box(x * 6, 4.4, 4.2, 1.3, 2.4, 0.2, hex(0x7be8ff), 1); }
  return done(m, l);
}

/** Stone lantern (toro) with a glowing fire box. */
export function toroGeo(big = false): Pair {
  const m = new MB(), l = new MB(), s = big ? 1.7 : 1;
  m.cyl(0, 0, 0.6 * s, 0.7 * s, -1.2, 0.35 * s, 6, STONE_D); m.cyl(0, 0, 0.2 * s, 0.26 * s, 0.35 * s, 1.6 * s, 6, STONE);
  m.cyl(0, 0, 0.55 * s, 0.4 * s, 1.6 * s, 1.85 * s, 6, shade(STONE, 1.1)); m.box(0, 2.25 * s, 0, 0.8 * s, 0.75 * s, 0.8 * s, STONE_D);
  m.frustum(0, 0, 1.5 * s, 1.5 * s, 0.35 * s, 0.35 * s, 2.62 * s, 3.2 * s, STONE); m.cyl(0, 0, 0.15 * s, 0.01, 3.2 * s, 3.5 * s, 6, STONE_D);
  l.box(0, 2.25 * s, 0.38 * s, 0.4 * s, 0.4 * s, 0.05, hex(0x9ff3ff), 1); l.box(0, 2.25 * s, -0.38 * s, 0.4 * s, 0.4 * s, 0.05, hex(0x9ff3ff), 2);
  l.box(0.38 * s, 2.25 * s, 0, 0.05, 0.4 * s, 0.4 * s, hex(0x9ff3ff), 4); l.box(-0.38 * s, 2.25 * s, 0, 0.05, 0.4 * s, 0.4 * s, hex(0x9ff3ff), 8);
  return done(m, l);
}

/** Komainu (guardian lion-dog) seated on a plinth. */
export function komainuGeo(): Pair {
  const m = new MB(), l = new MB();
  m.box(0, -0.5, 0, 2.2, 3, 2.8, STONE_D); m.box(0, 1.5, -0.3, 1.5, 1.3, 1.9, STONE); m.box(0, 2.9, 0.3, 1.2, 1.5, 1.0, STONE);
  m.box(0, 3.5, 0.9, 1.1, 1, 1.2, shade(STONE, 1.1)); m.box(0, 3.15, 1.5, 0.8, 0.45, 0.4, shade(STONE, 0.9));
  m.box(-0.4, 4.2, 0.6, 0.3, 0.45, 0.3, STONE); m.box(0.4, 4.2, 0.6, 0.3, 0.45, 0.3, STONE); m.box(0, 3.0, 2.0, 0.9, 1.6, 0.5, STONE);
  m.box(0, 2.0, -1.4, 0.5, 1.8, 0.8, STONE); // tail
  l.box(-0.28, 3.75, 1.5, 0.14, 0.14, 0.04, hex(0x7be8ff), 1); l.box(0.28, 3.75, 1.5, 0.14, 0.14, 0.04, hex(0x7be8ff), 1);
  return done(m, l);
}

/** Street lamp: pole, curved arm, lamp head; lights = bulb. */
export function lampGeo(): Pair {
  const m = new MB(), l = new MB(), c = hex(0x2f3340);
  m.cyl(0, 0, 0.32, 0.22, 0, 0.5, 8, c); m.cyl(0, 0, 0.14, 0.11, 0.5, 8.4, 8, c);
  m.box(0, 8.55, 1.05, 0.2, 0.2, 2.3, c); m.box(0, 8.3, 2.1, 0.9, 0.3, 1.0, shade(c, 1.3)); l.box(0, 8.12, 2.1, 0.65, 0.06, 0.7, hex(0xffe0a0));
  return done(m, l);
}

/** Traffic light: pole with arm and a 3-lamp head; `state` = which lamp is lit (0 red, 1 amber, 2 green). */
export function trafficLightGeo(state: number): Pair {
  const m = new MB(), l = new MB(), c = hex(0x2a2e38);
  m.cyl(0, 0, 0.14, 0.14, 0, 5.4, 8, c); m.box(0, 5.4, 1.6, 0.18, 0.18, 3.2, c);
  for (const z of [0.2, 3.1]) {
    m.box(0, 5.2, z, 0.6, 1.6, 0.5, hex(0x1b1d24));
    const cols = [hex(0xff2a2a), hex(0xffb020), hex(0x35ff7a)];
    for (let k = 0; k < 3; k++) {
      const y = 5.65 - k * 0.5, g = (z > 1) === (state === 3) ? 0 : 0;
      void g;
      (k === state ? l : m).box(0, y, z + 0.27, 0.34, 0.34, 0.04, k === state ? cols[k] : shade(cols[k], 0.18), 1);
    }
  }
  m.box(0, 3.2, 0.2, 0.5, 1.2, 0.2, c);
  return done(m, l);
}

/** Wooden bench + planter for sidewalks and plazas. */
export function benchGeo(): Pair {
  const m = new MB(), c = hex(0x8a6a4a);
  m.box(0, 0.55, 0, 2.2, 0.12, 0.7, c); m.box(0, 1.0, -0.3, 2.2, 0.7, 0.1, c);
  for (const x of [-0.9, 0.9]) m.box(x, 0.28, 0, 0.12, 0.56, 0.6, hex(0x2f3340));
  return done(m, new MB());
}

/** Cherry-blossom sacred tree: thick trunk, layered crown. */
export function greatTreeGeo(): Pair {
  const m = new MB();
  m.cyl(0, 0, 1.6, 2.6, 0, 9, 8, hex(0x5a3b28)); m.cyl(0, 0, 1.0, 1.4, 9, 15, 7, hex(0x5a3b28));
  const pink = [hex(0xffb2cf), hex(0xffc4da), hex(0xf79bbd), hex(0xffd6e6)];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * 6.2832, r = 5 + (i % 3) * 3, y = 13 + (i % 4) * 2.4;
    m.cyl(Math.cos(a) * r, Math.sin(a) * r, 4.2 - (i % 3) * 0.6, 1.2, y, y + 4.4, 8, pink[i & 3]);
  }
  m.cyl(0, 0, 8, 2, 17, 22, 10, pink[1]);
  return done(m, new MB());
}

/** Curved torii variant with proper kasagi (curved lintel) and nuki beam: a large one, scaled by instances. */
export function toriiGeo(): Pair {
  const m = new MB(), red = RED, blk = hex(0x151515);
  for (const x of [-4.2, 4.2]) { m.cyl(x, 0, 0.62, 0.52, 0, 10.4, 8, red); m.box(x, 0.35, 0, 1.5, 0.7, 1.5, blk, 63 & ~32); }
  m.box(0, 10.7, 0, 13.4, 0.6, 1.2, blk); m.box(-6.4, 11.0, 0, 1.8, 0.5, 1.2, blk); m.box(6.4, 11.0, 0, 1.8, 0.5, 1.2, blk);
  m.obox(-7.4, 11.4, 0, 1, 0, 0, 1, 1.6, 0.4, 1.2, blk); m.obox(7.4, 11.4, 0, 1, 0, 0, 1, 1.6, 0.4, 1.2, blk);
  m.box(0, 8.4, 0, 10.4, 0.6, 0.9, red); m.box(0, 9.4, 0, 0.9, 1.4, 0.4, hex(0x2a2f3d));
  return done(m, new MB());
}

/** Rock arch for the arch islet. */
export function archGeo(): Pair {
  const m = new MB(), c = hex(0x7d8088);
  for (const x of [-9, 9]) m.cyl(x, 0, 5.5, 7, 0, 36, 7, shade(c, 0.95 + (x > 0 ? 0.05 : 0)));
  m.box(0, 38, 0, 28, 8, 12, shade(c, 1.05)); m.box(0, 43, 0, 22, 4, 9, c);
  return done(m, new MB());
}

export function disposeCache(): void { cache.clear(); }
