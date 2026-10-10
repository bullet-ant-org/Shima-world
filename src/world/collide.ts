/**
 * Mesh-following colliders.
 *
 * A model's geometry (in its local space, y = 0 at its base) is rasterised into a top-down grid: a cell is solid when some
 * surface passes through body height there (walls, posts, counters, trunks...), and anything fully enclosed by such cells
 * (the inside of a closed building) is solid too. Overhangs above head height (awnings, eaves, canopies) stay walkable.
 * Each solid cell remembers the highest surface above it, so flyers can land on the real roof line.
 */
import type * as THREE from 'three/webgpu';

export interface Shape { res: number; x0: number; z0: number; nx: number; nz: number; top: Float32Array }

const BAND0 = 0.3, BAND1 = 2.1;

export function rasterize(geo: THREE.BufferGeometry, res = 0.5): Shape {
  const pa = geo.getAttribute('position') as THREE.BufferAttribute, P = pa.array as ArrayLike<number>, n = pa.count;
  const ix = geo.getIndex()?.array as ArrayLike<number> | undefined;
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity, maxy = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (z < minz) minz = z; if (z > maxz) maxz = z; if (y > maxy) maxy = y;
  }
  const x0 = minx - res * 2, z0 = minz - res * 2;
  const nx = Math.ceil((maxx - x0) / res) + 3, nz = Math.ceil((maxz - z0) / res) + 3, N = nx * nz;
  const band = new Uint8Array(N), top = new Float32Array(N).fill(-Infinity);
  const tris = ix ? ix.length / 3 : n / 3;
  for (let t = 0; t < tris; t++) {
    const a = ix ? ix[t * 3] : t * 3, b = ix ? ix[t * 3 + 1] : t * 3 + 1, c = ix ? ix[t * 3 + 2] : t * 3 + 2;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2], cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
    const ymin = Math.min(ay, by, cy), ymax = Math.max(ay, by, cy);
    // near-vertical faces (walls) occupy their footprint line if they cross body height at all
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nX = uy * vz - uz * vy, nY = uz * vx - ux * vz, nZ = ux * vy - uy * vx, nl = Math.hypot(nX, nY, nZ);
    if (nl < 1e-9) continue;
    const vertical = Math.abs(nY) / nl < 0.3, wallHit = vertical && ymax >= BAND0 && ymin <= BAND1;
    const L = Math.max(Math.hypot(ux, uz), Math.hypot(vx, vz), Math.hypot(cx - bx, cz - bz));
    const k = Math.min(600, Math.max(1, Math.ceil(L / (res * 0.5))));
    for (let i = 0; i <= k; i++) for (let j = 0; j <= k - i; j++) {
      const s = i / k, r = j / k;
      const px = ax + ux * s + vx * r, py = ay + uy * s + vy * r, pz = az + uz * s + vz * r;
      const ci = Math.floor((px - x0) / res), cj = Math.floor((pz - z0) / res);
      if (ci < 0 || cj < 0 || ci >= nx || cj >= nz) continue;
      const cell = ci + cj * nx;
      if (py > top[cell]) top[cell] = py;
      if (wallHit || (py >= BAND0 && py <= BAND1)) band[cell] = 1;
    }
  }
  // close sub-metre gaps (dilate), flood the outside, then give back the dilation where it touches the outside
  const dil = new Uint8Array(N);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    if (!band[i + j * nx]) continue;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < nx && b < nz) dil[a + b * nx] = 1;
    }
  }
  const out = new Uint8Array(N), stack: number[] = [];
  for (let i = 0; i < nx; i++) { stack.push(i, i + (nz - 1) * nx); }
  for (let j = 0; j < nz; j++) { stack.push(j * nx, nx - 1 + j * nx); }
  while (stack.length) {
    const c = stack.pop()!;
    if (out[c] || dil[c]) continue;
    out[c] = 1;
    const i = c % nx, j = (c - i) / nx;
    if (i > 0) stack.push(c - 1); if (i < nx - 1) stack.push(c + 1); if (j > 0) stack.push(c - nx); if (j < nz - 1) stack.push(c + nx);
  }
  const solid = new Uint8Array(N);
  for (let c = 0; c < N; c++) solid[c] = out[c] ? 0 : 1;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const c = i + j * nx;
    if (!solid[c] || band[c]) continue;
    if ((i > 0 && out[c - 1]) || (i < nx - 1 && out[c + 1]) || (j > 0 && out[c - nx]) || (j < nz - 1 && out[c + nx])) solid[c] = 0;
  }
  for (let c = 0; c < N; c++) top[c] = solid[c] ? (top[c] > -Infinity ? top[c] : maxy) : -Infinity;
  return { res, x0, z0, nx, nz, top };
}

/** local y of the solid at (lx, lz), or -Infinity when the column is free */
export function shapeTop(s: Shape, lx: number, lz: number): number {
  const i = Math.floor((lx - s.x0) / s.res), j = Math.floor((lz - s.z0) / s.res);
  if (i < 0 || j < 0 || i >= s.nx || j >= s.nz) return -Infinity;
  return s.top[i + j * s.nx];
}
