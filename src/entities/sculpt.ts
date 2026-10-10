/**
 * Sculpting toolkit for stylised characters.
 *
 * Everything is built from *lofts*: a cross-section (an ellipse, optionally reshaped per angle) swept along a smooth
 * Catmull-Rom path, with the radius driven by a profile function. Rings have no duplicated seam vertices, so normals are
 * smooth all the way round and toon shading gets clean, continuous bands — no faceted primitive blobs.
 *
 * Cross-section frame at each sample: T = path tangent, B = normalize(T x up), N = B x T.
 * The ring point at angle a is  p + B*cos(a)*rx*shape + N*sin(a)*ry*shape.
 * For a vertical path (T = +y) with the default up (+z): B = +x, N = +z, so a = PI/2 faces the front.
 */
import * as THREE from 'three/webgpu';

export type V3 = [number, number, number];
export type Radius = number | [number, number];
export type ColorFn = (t: number, a: number, p: THREE.Vector3, out: THREE.Color) => void;

export interface LoftOpts {
  path: V3[];
  steps?: number;
  seg?: number;
  r: (t: number, p: THREE.Vector3) => Radius;
  up?: V3 | ((p: THREE.Vector3, t: number) => THREE.Vector3);
  shape?: (t: number, a: number, p: THREE.Vector3) => number;
  color: number | ColorFn;
  /** reversed winding: an inner shell for open, thin garments (skirts, cuffs) */
  flip?: boolean;
  capStart?: boolean;
  capEnd?: boolean;
}

const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _u = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Vector3();
const _pb = new THREE.Vector3(1, 0, 0);
const _c = new THREE.Color();
const ZUP = new THREE.Vector3(0, 0, 1);

let DETAIL = 1;
/** global tessellation multiplier for lofts built from now on (e.g. 0.65 on low-end devices); returns the previous value */
export function setLoftDetail(d: number): number { const p = DETAIL; DETAIL = d; return p; }

export function loft(o: LoftOpts): THREE.BufferGeometry {
  const pts = o.path.map((v) => new THREE.Vector3(v[0], v[1], v[2]));
  if (pts.length === 1) pts.push(pts[0].clone().add(new THREE.Vector3(0, -1e-3, 0)));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const steps = Math.max(2, Math.round((o.steps ?? 16) * DETAIL)), seg = Math.max(5, Math.round((o.seg ?? 12) * DETAIL));
  const cs = o.capStart ? 1 : 0, ce = o.capEnd ? 1 : 0;
  const nv = (steps + 1) * seg + cs + ce;
  const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  const idx: number[] = [];
  const fixedUp = Array.isArray(o.up) ? new THREE.Vector3(o.up[0], o.up[1], o.up[2]).normalize() : ZUP;
  const colorFn = typeof o.color === 'number' ? null : o.color;
  if (!colorFn) _c.setHex(o.color as number);
  const centers: THREE.Vector3[] = [];
  _pb.set(1, 0, 0);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    curve.getPointAt(t, _p); curve.getTangentAt(t, _t).normalize();
    if (i === 0 || i === steps) centers.push(_p.clone());
    _u.copy(typeof o.up === 'function' ? o.up(_p, t) : fixedUp);
    _b.crossVectors(_t, _u);
    if (_b.lengthSq() < 1e-10) _b.copy(_pb); else _b.normalize();
    _pb.copy(_b);
    _n.crossVectors(_b, _t).normalize();
    const rr = o.r(t, _p), rx = typeof rr === 'number' ? rr : rr[0], ry = typeof rr === 'number' ? rr : rr[1];
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2, m = o.shape ? o.shape(t, a, _p) : 1;
      _q.copy(_p).addScaledVector(_b, Math.cos(a) * rx * m).addScaledVector(_n, Math.sin(a) * ry * m);
      const k = (i * seg + j) * 3;
      pos[k] = _q.x; pos[k + 1] = _q.y; pos[k + 2] = _q.z;
      if (colorFn) colorFn(t, a, _q, _c);
      col[k] = _c.r; col[k + 1] = _c.g; col[k + 2] = _c.b;
    }
  }
  const quad = (a: number, b: number, c: number, d: number) => { if (o.flip) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d); };
  for (let i = 0; i < steps; i++) for (let j = 0; j < seg; j++) {
    const j2 = (j + 1) % seg;
    quad(i * seg + j, i * seg + j2, (i + 1) * seg + j, (i + 1) * seg + j2);
  }
  const cap = (center: THREE.Vector3, ring: number, vi: number, end: boolean) => {
    pos[vi * 3] = center.x; pos[vi * 3 + 1] = center.y; pos[vi * 3 + 2] = center.z;
    const k0 = ring * seg * 3; col[vi * 3] = col[k0]; col[vi * 3 + 1] = col[k0 + 1]; col[vi * 3 + 2] = col[k0 + 2];
    for (let j = 0; j < seg; j++) {
      const a = ring * seg + j, b = ring * seg + (j + 1) % seg;
      if (end !== !!o.flip) idx.push(vi, b, a); else idx.push(vi, a, b);
    }
  };
  if (cs) cap(centers[0], 0, (steps + 1) * seg, false);
  if (ce) cap(centers[1], steps, (steps + 1) * seg + cs, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.setAttribute('kind', new THREE.BufferAttribute(new Float32Array(nv), 1));
  return g;
}

/** smooth cubic (Catmull-Rom / Hermite) interpolation through [x, y] keys, clamped at the ends */
export function keys(k: [number, number][]): (x: number) => number {
  const n = k.length;
  const slope = (j: number) => {
    if (j <= 0) return (k[1][1] - k[0][1]) / (k[1][0] - k[0][0]);
    if (j >= n - 1) return (k[n - 1][1] - k[n - 2][1]) / (k[n - 1][0] - k[n - 2][0]);
    return (k[j + 1][1] - k[j - 1][1]) / (k[j + 1][0] - k[j - 1][0]);
  };
  return (x: number) => {
    if (x <= k[0][0]) return k[0][1];
    if (x >= k[n - 1][0]) return k[n - 1][1];
    let i = 0; while (x > k[i + 1][0]) i++;
    const [x0, y0] = k[i], [x1, y1] = k[i + 1], h = x1 - x0, s = (x - x0) / h, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s) * h * slope(i) + (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * h * slope(i + 1);
  };
}

/** elliptical end rounding: multiplier that closes a loft into a dome over the first `a` and last `b` of its length */
export function ends(t: number, a: number, b: number): number {
  let m = 1;
  if (a > 0 && t < a) { const u = 1 - t / a; m *= Math.sqrt(Math.max(0, 1 - u * u)); }
  if (b > 0 && t > 1 - b) { const u = (t - (1 - b)) / b; m *= Math.sqrt(Math.max(0, 1 - u * u)); }
  return m;
}

const _ca = new THREE.Color(), _cb = new THREE.Color();
/** colour fn: blend a -> b by f(t, a, p) */
export function grad(a: number, b: number, f: (t: number, an: number, p: THREE.Vector3) => number): ColorFn {
  _ca.setHex(a); const ca = _ca.clone(), cb = _cb.setHex(b).clone();
  return (t, an, p, out) => { out.copy(ca).lerp(cb, Math.max(0, Math.min(1, f(t, an, p)))); };
}
