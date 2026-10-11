/**
 * Stylised (anime) cars: a lofted body from per-station cross-sections (hood, windshield, roof, rear window, trunk), glass bands,
 * wheels with hubs, mirrors, grille, head/tail lights. Body paint is white in the vertex colours so the per-instance colour
 * tints the paint only; glass, tyres and trim are dark enough to stay readable under any tint.
 * `lit` uses the shared toon material, `lights` the unlit emissive one. Forward is +z.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MB } from './geo';

export type CarModel = 'sedan' | 'hatch' | 'taxi' | 'van' | 'sport' | 'hover' | 'bus' | 'truck';
export const CAR_MODELS: CarModel[] = ['sedan', 'hatch', 'taxi', 'van', 'sport', 'sedan', 'hatch', 'bus', 'truck'];

interface Station { z: number; top: number; w: number; belt: number }
interface Spec { st: Station[]; wheelZ: number; wheelR: number; y0: number; hover?: boolean; roofSign?: boolean; boxy?: boolean }

const SPECS: Record<CarModel, Spec> = {
  sedan: {
    y0: 0.3, wheelZ: 1.4, wheelR: 0.36,
    st: [
      { z: -2.2, top: 0.8, w: 0.8, belt: 0.58 }, { z: -2.0, top: 1.0, w: 0.88, belt: 0.72 }, { z: -1.55, top: 1.06, w: 0.93, belt: 0.8 }, { z: -1.0, top: 1.38, w: 0.88, belt: 0.8 },
      { z: -0.3, top: 1.46, w: 0.86, belt: 0.8 }, { z: 0.4, top: 1.42, w: 0.86, belt: 0.8 }, { z: 0.9, top: 1.12, w: 0.92, belt: 0.8 }, { z: 1.5, top: 1.0, w: 0.93, belt: 0.74 },
      { z: 2.05, top: 0.86, w: 0.9, belt: 0.64 }, { z: 2.25, top: 0.64, w: 0.78, belt: 0.5 },
    ],
  },
  hatch: {
    y0: 0.3, wheelZ: 1.15, wheelR: 0.34,
    st: [
      { z: -1.85, top: 0.82, w: 0.78, belt: 0.6 }, { z: -1.7, top: 1.15, w: 0.86, belt: 0.78 }, { z: -1.3, top: 1.46, w: 0.88, belt: 0.8 }, { z: -0.4, top: 1.56, w: 0.88, belt: 0.8 },
      { z: 0.35, top: 1.5, w: 0.88, belt: 0.8 }, { z: 0.8, top: 1.14, w: 0.92, belt: 0.8 }, { z: 1.3, top: 0.99, w: 0.92, belt: 0.74 }, { z: 1.7, top: 0.84, w: 0.88, belt: 0.64 }, { z: 1.9, top: 0.62, w: 0.76, belt: 0.5 },
    ],
  },
  taxi: {
    y0: 0.3, wheelZ: 1.4, wheelR: 0.36, roofSign: true,
    st: [
      { z: -2.2, top: 0.8, w: 0.8, belt: 0.58 }, { z: -2.0, top: 1.0, w: 0.88, belt: 0.72 }, { z: -1.6, top: 1.1, w: 0.93, belt: 0.8 }, { z: -1.1, top: 1.5, w: 0.9, belt: 0.82 },
      { z: -0.2, top: 1.58, w: 0.88, belt: 0.82 }, { z: 0.45, top: 1.55, w: 0.88, belt: 0.82 }, { z: 0.95, top: 1.18, w: 0.92, belt: 0.82 }, { z: 1.5, top: 1.02, w: 0.93, belt: 0.76 },
      { z: 2.05, top: 0.86, w: 0.9, belt: 0.64 }, { z: 2.25, top: 0.64, w: 0.78, belt: 0.5 },
    ],
  },
  van: {
    y0: 0.34, wheelZ: 1.5, wheelR: 0.38, boxy: true,
    st: [
      { z: -2.4, top: 1.0, w: 0.92, belt: 0.8 }, { z: -2.3, top: 2.1, w: 0.98, belt: 0.95 }, { z: -0.6, top: 2.2, w: 1.0, belt: 0.95 }, { z: 0.9, top: 2.15, w: 1.0, belt: 0.95 },
      { z: 1.5, top: 1.55, w: 0.97, belt: 0.95 }, { z: 1.95, top: 1.1, w: 0.94, belt: 0.82 }, { z: 2.4, top: 0.8, w: 0.86, belt: 0.58 },
    ],
  },
  sport: {
    y0: 0.26, wheelZ: 1.35, wheelR: 0.35,
    st: [
      { z: -2.25, top: 0.74, w: 0.9, belt: 0.55 }, { z: -2.1, top: 0.92, w: 0.96, belt: 0.66 }, { z: -1.4, top: 1.0, w: 0.98, belt: 0.74 }, { z: -0.8, top: 1.14, w: 0.9, belt: 0.74 },
      { z: -0.1, top: 1.2, w: 0.88, belt: 0.74 }, { z: 0.6, top: 1.0, w: 0.94, belt: 0.74 }, { z: 1.4, top: 0.8, w: 0.98, belt: 0.68 }, { z: 2.1, top: 0.64, w: 0.96, belt: 0.56 }, { z: 2.4, top: 0.52, w: 0.86, belt: 0.44 },
    ],
  },
  bus: {
    y0: 0.38, wheelZ: 3.6, wheelR: 0.48, boxy: true,
    st: [
      { z: -5.6, top: 1.2, w: 1.18, belt: 1.1 }, { z: -5.5, top: 3.0, w: 1.22, belt: 1.2 }, { z: -2, top: 3.05, w: 1.24, belt: 1.2 }, { z: 2, top: 3.05, w: 1.24, belt: 1.2 },
      { z: 5.3, top: 3.0, w: 1.22, belt: 1.2 }, { z: 5.6, top: 1.3, w: 1.18, belt: 1.0 },
    ],
  },
  truck: {
    y0: 0.4, wheelZ: 2.4, wheelR: 0.46, boxy: true,
    st: [
      { z: -3.6, top: 1.2, w: 1.1, belt: 1.1 }, { z: -3.5, top: 3.1, w: 1.14, belt: 3.0 }, { z: 0.9, top: 3.1, w: 1.14, belt: 3.0 }, { z: 1.0, top: 2.4, w: 1.06, belt: 1.25 },
      { z: 2.6, top: 2.45, w: 1.06, belt: 1.25 }, { z: 3.2, top: 1.5, w: 1.04, belt: 1.1 }, { z: 3.4, top: 1.0, w: 0.98, belt: 0.8 },
    ],
  },
  hover: {
    y0: 0.18, wheelZ: 1.3, wheelR: 0.3, hover: true,
    st: [
      { z: -2.2, top: 0.7, w: 0.86, belt: 0.5 }, { z: -2.0, top: 0.9, w: 0.95, belt: 0.64 }, { z: -1.3, top: 1.0, w: 1.0, belt: 0.72 }, { z: -0.6, top: 1.22, w: 0.9, belt: 0.72 },
      { z: 0.2, top: 1.26, w: 0.88, belt: 0.72 }, { z: 0.9, top: 0.98, w: 0.96, belt: 0.72 }, { z: 1.6, top: 0.74, w: 1.0, belt: 0.64 }, { z: 2.3, top: 0.54, w: 0.9, belt: 0.5 }, { z: 2.55, top: 0.42, w: 0.74, belt: 0.38 },
    ],
  },
};

const PAINT: [number, number, number] = [1, 1, 1];
const GLASS: [number, number, number] = [0.1, 0.2, 0.3], TRIM: [number, number, number] = [0.12, 0.12, 0.15], BUMP: [number, number, number] = [0.5, 0.5, 0.55];

interface Raw { P: number[]; N: number[]; C: number[]; I: number[] }
const raw = (): Raw => ({ P: [], N: [], C: [], I: [] });

function pushQuad(r: Raw, p: number[][], n: number[][], c: number[]): void {
  const base = r.P.length / 3;
  for (let i = 0; i < 4; i++) { r.P.push(p[i][0], p[i][1], p[i][2]); r.N.push(n[i][0], n[i][1], n[i][2]); r.C.push(c[0], c[1], c[2]); }
  r.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
function pushBox(r: Raw, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, c: number[]): void {
  const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
  const f = (p: number[][], n: number[]) => pushQuad(r, p, [n, n, n, n], c);
  f([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]); f([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1]);
  f([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0]); f([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]);
  f([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0]); f([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
}
function pushWheel(r: Raw, x: number, y: number, z: number, rad: number, wid: number, metal: Raw = r): void {
  const n = 16, sgn = x > 0 ? 1 : -1;
  // spokes and centre cap on the rim face
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * 6.2832, c = Math.cos(a), sn = Math.sin(a);
    const xo = x + sgn * (wid / 2 + 0.035), r0 = rad * 0.12, r1 = rad * 0.58, w = rad * 0.09;
    const p = (rr: number, side: number) => [xo, y + c * rr - sn * side * w, z + sn * rr + c * side * w];
    const nn = [sgn, 0, 0];
    pushQuad(metal, sgn > 0 ? [p(r0, -1), p(r1, -1), p(r1, 1), p(r0, 1)] : [p(r0, 1), p(r1, 1), p(r1, -1), p(r0, -1)], [nn, nn, nn, nn], [0.62, 0.64, 0.68]);
  }
  pushBox(metal, x + sgn * (wid / 2 + 0.03), y, z, 0.03, rad * 0.24, rad * 0.24, [0.42, 0.43, 0.46]);
  for (const [rr, ww, col] of [[rad, wid, TRIM], [rad * 0.64, wid + 0.03, [0.32, 0.33, 0.37]]] as [number, number, number[]][]) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * 6.2832, a1 = ((i + 1) / n) * 6.2832;
      const y0 = y + Math.cos(a0) * rr, z0 = z + Math.sin(a0) * rr, y1 = y + Math.cos(a1) * rr, z1 = z + Math.sin(a1) * rr;
      const n0 = [0, Math.cos(a0), Math.sin(a0)], n1 = [0, Math.cos(a1), Math.sin(a1)];
      pushQuad(r, [[x - ww / 2, y0, z0], [x + ww / 2, y0, z0], [x + ww / 2, y1, z1], [x - ww / 2, y1, z1]], [n0, n0, n1, n1], col);
      // outer face disc segment
      const sgn = x > 0 ? 1 : -1, xo = x + sgn * ww / 2;
      const nn = [sgn, 0, 0];
      pushQuad(r, [[xo, y, z], [xo, y0, z0], [xo, y1, z1], [xo, y, z]], [nn, nn, nn, nn], col);
    }
  }
}

/** Builds the lit + lights raw geometry for a model at the origin. */
function buildRaw(model: CarModel): { lit: Raw; lights: Raw } {
  const s = SPECS[model], lit = raw(), lights = raw();
  const y0 = s.y0, st = s.st;
  // cross-section ring (10 pts, counter-clockwise looking +z): bottom, lower side, belt, window, roof edge, mirrored
  const ring = (t: Station): number[][] => {
    const w = t.w, b = t.belt, top = t.top, cab = Math.max(0, top - b - 0.04);
    const wy = b + cab * 0.55, rw = s.boxy ? w * 0.96 : w * 0.7, ww = s.boxy ? w * 0.99 : w * 0.88;
    return [[-w * 0.9, y0], [w * 0.9, y0], [w, y0 + (b - y0) * 0.5], [w, b], [ww, wy], [rw, top], [-rw, top], [-ww, wy], [-w, b], [-w, y0 + (b - y0) * 0.5]];
  };
  const rings = st.map(ring);
  const nrm = (t: Station, p: number[], zSlope: number): number[] => {
    const yc = (t.top + y0) / 2, hx = p[0] / Math.max(0.2, t.w), hy = (p[1] - yc) / Math.max(0.2, (t.top - y0) / 2);
    const l = Math.hypot(hx, hy, zSlope) || 1;
    return [hx / l, hy / l, zSlope / l];
  };
  for (let i = 0; i < st.length - 1; i++) {
    const A = st[i], B = st[i + 1], ra = rings[i], rb = rings[i + 1];
    const dTop = (B.top - A.top) / Math.max(0.05, B.z - A.z), slope = -dTop * 0.5;
    const cabin = A.top - A.belt > 0.2 || B.top - B.belt > 0.2;
    for (let e = 0; e < 10; e++) {
      const e2 = (e + 1) % 10;
      let col = PAINT;
      if (e === 0) col = TRIM;
      else if (e === 4 || e === 7) col = cabin && Math.min(A.top - A.belt, B.top - B.belt) > 0.1 ? GLASS : PAINT;
      else if (e === 3 || e === 6) col = cabin && Math.min(A.top - A.belt, B.top - B.belt) > 0.1 ? GLASS : PAINT;
      else if (e === 5) col = cabin && Math.abs(dTop) > 0.32 && A.top > A.belt + 0.2 ? GLASS : PAINT; // windshield / rear window
      else if (e === 1 || e === 9) col = [0.78, 0.78, 0.8];
      if (i === 0 || i === st.length - 2) col = e === 0 ? TRIM : col === PAINT ? BUMP : col; // bumper ends
      pushQuad(lit, [[ra[e][0], ra[e][1], A.z], [ra[e2][0], ra[e2][1], A.z], [rb[e2][0], rb[e2][1], B.z], [rb[e][0], rb[e][1], B.z]],
        [nrm(A, ra[e], slope), nrm(A, ra[e2], slope), nrm(B, rb[e2], slope), nrm(B, rb[e], slope)], col);
    }
  }
  // end caps
  for (const [t, r, dz, col] of [[st[0], rings[0], -1, BUMP], [st[st.length - 1], rings[rings.length - 1], 1, BUMP]] as [Station, number[][], number, number[]][]) {
    const cx = 0, cy = (t.top + y0) / 2;
    for (let e = 0; e < 10; e++) {
      const e2 = (e + 1) % 10, n = [0, 0, dz];
      pushQuad(lit, [[cx, cy, t.z], [r[e][0], r[e][1], t.z], [r[e2][0], r[e2][1], t.z], [cx, cy, t.z]], [n, n, n, n], col);
    }
  }
  const front = st[st.length - 1], rear = st[0], mid = st[Math.floor(st.length / 2)];
  const wx = mid.w * 0.93;
  if (!s.hover) for (const z of [-s.wheelZ, s.wheelZ]) for (const x of [-wx, wx]) pushWheel(lit, x, s.wheelR, z, s.wheelR, 0.24, lights);
  else for (const z of [-s.wheelZ, s.wheelZ]) for (const x of [-wx * 0.9, wx * 0.9]) pushBox(lights, x, 0.12, z, 0.34, 0.06, 0.9, [0.3, 0.95, 1]); // hover pads
  // grille, mirrors, plates
  pushBox(lit, 0, front.top * 0.55, front.z - 0.02, front.w * 1.1, front.top * 0.4, 0.06, TRIM);
  for (const x of [-1, 1]) { pushBox(lit, x * (mid.w + 0.12), mid.belt + 0.35, mid.z + 0.55, 0.12, 0.14, 0.2, PAINT); pushBox(lit, x * (mid.w + 0.05), mid.belt + 0.3, mid.z + 0.55, 0.1, 0.03, 0.04, TRIM); }
  if (!s.hover) {
    const big = model === 'bus' || model === 'truck';
    for (const x of [-1, 1]) {
      // wheel arches, side skirt, door seams, handles, B-pillar
      for (const z of [-s.wheelZ, s.wheelZ]) pushBox(lit, x * (wx + 0.02), s.wheelR * 2 + 0.03, z, 0.12, 0.08, s.wheelR * 2.3, TRIM);
      pushBox(lit, x * (mid.w * 0.95), y0 + 0.08, 0, 0.06, 0.1, (front.z - rear.z) * 0.62, [0.18, 0.18, 0.22]);
      if (!big) {
        for (const z of [-0.45, 0.65]) pushBox(lit, x * (mid.w + 0.005), (mid.belt + y0) / 2 + 0.12, z, 0.02, mid.belt - y0 - 0.08, 0.02, [0.55, 0.55, 0.6]);
        for (const z of [-0.2, 0.9]) pushBox(lit, x * (mid.w + 0.02), mid.belt - 0.08, z, 0.03, 0.04, 0.16, [0.75, 0.76, 0.8]);
        if (mid.top - mid.belt > 0.2) pushBox(lit, x * (mid.w * 0.86), (mid.top + mid.belt) / 2 + 0.04, 0.12, 0.03, mid.top - mid.belt - 0.08, 0.12, TRIM);
      }
      pushBox(lights, x * front.w * 0.86, front.top * 0.55, front.z + 0.01, 0.12, 0.08, 0.05, [1, 0.62, 0.12]);   // indicators
      pushBox(lights, x * rear.w * 0.86, rear.top * 0.62, rear.z - 0.01, 0.12, 0.08, 0.05, [1, 0.62, 0.12]);
    }
    pushBox(lights, 0, front.top * 0.38, front.z + 0.02, 0.46, 0.12, 0.03, [0.86, 0.86, 0.82]);                     // number plates
    pushBox(lights, 0, rear.top * 0.5, rear.z - 0.02, 0.46, 0.12, 0.03, [0.86, 0.86, 0.82]);
    pushBox(lit, rear.w * 0.5, y0 + 0.04, rear.z - 0.05, 0.08, 0.08, 0.22, [0.6, 0.6, 0.62]);                      // exhaust
    // cyber styling: neon underglow, full-width LED light bars front and rear, glowing side accent lines
    const glowC = ([[0.25, 0.95, 1], [1, 0.3, 0.85], [0.55, 1, 0.45], [1, 0.75, 0.2]] as number[][])[(model.length * 7 + model.charCodeAt(0)) % 4];
    for (const x of [-1, 1]) pushBox(lights, x * (mid.w * 0.82), y0 - 0.06, 0, 0.06, 0.03, (front.z - rear.z) * 0.6, glowC);
    pushBox(lights, 0, front.top * 0.78, front.z + 0.035, front.w * 1.5, 0.04, 0.03, [0.85, 0.95, 1]);
    pushBox(lights, 0, rear.top * 0.88, rear.z - 0.035, rear.w * 1.6, 0.05, 0.03, [1, 0.1, 0.18]);
    if (!big) for (const x of [-1, 1]) pushBox(lights, x * (mid.w + 0.01), mid.belt - 0.18, (front.z + rear.z) / 2, 0.02, 0.025, (front.z - rear.z) * 0.7, glowC);
    if (model === 'sport') { pushBox(lit, 0, rear.top + 0.28, rear.z + 0.18, rear.w * 1.8, 0.04, 0.3, PAINT); for (const x of [-0.6, 0.6]) pushBox(lit, x * rear.w, rear.top + 0.14, rear.z + 0.2, 0.05, 0.28, 0.08, TRIM); }
    if (model === 'van' || model === 'bus') for (const x of [-0.6, 0.6]) pushBox(lit, x * mid.w, mid.top + 0.06, 0, 0.05, 0.06, (front.z - rear.z) * 0.6, [0.7, 0.7, 0.74]); // roof rails
    if (model === 'bus') {
      for (const x of [-1, 1]) for (let z = -4.6; z < 4.4; z += 1.5) pushBox(lit, x * (mid.w + 0.01), 2.15, z, 0.02, 1.0, 1.3, GLASS);
      pushBox(lit, 0, 2.2, front.z + 0.02, mid.w * 1.8, 1.2, 0.03, GLASS); pushBox(lights, 0, 2.85, front.z + 0.04, mid.w * 1.2, 0.18, 0.03, [1, 0.7, 0.2]);
      pushBox(lit, mid.w + 0.01, 1.4, 4.0, 0.03, 2.2, 1.1, [0.2, 0.25, 0.3]);                                     // door
    }
    if (model === 'truck') { pushBox(lit, 0, 1.75, -1.3, mid.w * 2.02, 2.7, 0.02, [0.8, 0.8, 0.82]); for (let z = -3.2; z < 0.8; z += 0.5) for (const x of [-1, 1]) pushBox(lit, x * (1.145), 2.0, z, 0.02, 1.9, 0.05, [0.82, 0.82, 0.86]); }
  }
  // lights
  for (const x of [-1, 1]) {
    pushBox(lights, x * front.w * 0.62, front.top * 0.72, front.z + 0.01, 0.34, 0.12, 0.06, [1, 0.96, 0.75]);
    pushBox(lights, x * rear.w * 0.7, rear.top * 0.8, rear.z - 0.01, 0.4, 0.11, 0.06, [1, 0.12, 0.1]);
  }
  if (s.hover) { pushBox(lights, 0, 0.5, rear.z - 0.05, rear.w * 1.1, 0.07, 0.1, [0.3, 0.95, 1]); pushBox(lights, 0, 0.22, 0, mid.w * 2.05, 0.05, 3.6, [0.35, 0.8, 1]); }
  if (s.roofSign) { pushBox(lit, 0, 1.69, -0.2, 0.7, 0.17, 0.32, [0.9, 0.9, 0.9]); pushBox(lights, 0, 1.69, -0.2, 0.62, 0.1, 0.34, [1, 0.95, 0.6]); }
  return { lit, lights };
}

function toGeo(r: Raw): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(r.P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(r.N, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(r.C, 3));
  g.setIndex(r.I); g.computeBoundingSphere();
  return g;
}

const cache = new Map<CarModel, { lit: THREE.BufferGeometry; lights: THREE.BufferGeometry }>();
export function carGeo(model: CarModel): { lit: THREE.BufferGeometry; lights: THREE.BufferGeometry } {
  let c = cache.get(model);
  if (!c) { const r = buildRaw(model); c = { lit: toGeo(r.lit), lights: toGeo(r.lights) }; cache.set(model, c); }
  return c;
}

/** Bakes a parked car into a MeshBuilder (used by dealership forecourts). `paint` replaces the white paint. */
export function bakeCar(lit: MB, lights: MB, model: CarModel, x: number, z: number, ry: number, paint: [number, number, number]): void {
  const r = buildRaw(model), co = Math.cos(ry), si = Math.sin(ry);
  const add = (mb: MB, src: Raw, tint: boolean) => {
    const base = mb.P.length / 3;
    for (let i = 0; i < src.P.length; i += 3) {
      const px = src.P[i], py = src.P[i + 1], pz = src.P[i + 2];
      mb.P.push(x + px * co + pz * si, py, z - px * si + pz * co);
      const nx = src.N[i], nz = src.N[i + 2];
      mb.N.push(nx * co + nz * si, src.N[i + 1], -nx * si + nz * co);
      const white = tint && src.C[i] > 0.97 && src.C[i + 1] > 0.97;
      mb.C.push(white ? paint[0] : src.C[i], white ? paint[1] : src.C[i + 1], white ? paint[2] : src.C[i + 2]); mb.K.push(0);
    }
    for (const k of src.I) mb.I.push(base + k);
  };
  add(lit, r.lit, true); add(lights, r.lights, false);
}

export function mergeCarParts(): void { void mergeGeometries; }
