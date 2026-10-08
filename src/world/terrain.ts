/** Procedural world definition shared by streaming, props, simulation and collision. */
export const CHUNK = 128;
export const SEA = -8;
export const GOD = { x: -100, z: -1500 };
export const VILLAGE = { x: -120, z: 60 };

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const sstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function hash2(x: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function noise2(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  return mix(mix(hash2(xi, zi), hash2(xi + 1, zi), u), mix(hash2(xi, zi + 1), hash2(xi + 1, zi + 1), u), v);
}
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const riverX = (z: number) => -230 + Math.sin(z * 0.008) * 60 + Math.sin(z * 0.021) * 15;

export function heightAt(x: number, z: number): number {
  // Main island: Sakura Valley (west) blending into the flat Cyber City (east)
  const dm = Math.hypot((x - 50) / 1050, z / 820);
  const m1 = 1 - sstep(0.78, 1.0, dm);
  const c = sstep(10, 70, x);
  const rolling = 10 + Math.sin(x * 0.011) * Math.cos(z * 0.013) * 9 + noise2(x * 0.02, z * 0.02) * 8 + Math.sin(x * 0.027 + z * 0.019) * 3;
  const dr = x - riverX(z);
  const river = -16 * Math.exp(-(dr * dr) / (2 * 20 * 20));
  const mount = sstep(-420, -800, x) * 110 * (0.5 + noise2(x * 0.006, z * 0.006));
  const main = mix(rolling + river + mount, 3, c);
  const hMain = SEA + (main - SEA) * m1;
  // God Island to the north
  const dg = Math.hypot(x - GOD.x, z - GOD.z) / 560;
  const m2 = 1 - sstep(0.65, 1.0, dg);
  const g = 22 + noise2(x * 0.01, z * 0.01) * 30 + Math.sin(x * 0.03) * Math.cos(z * 0.025) * 6 + (1 - sstep(0, 0.5, dg)) * 30;
  const hGod = SEA + (g - SEA) * m2;
  return Math.max(hMain, hGod);
}

export type Zone = 'valley' | 'city' | 'god' | 'sea';
export function zoneAt(x: number, z: number): Zone {
  if (heightAt(x, z) < 0) return 'sea';
  if (z < -900) return 'god';
  if (x > 40) return 'city';
  return 'valley';
}

// ---- City layout: 64 m blocks, roads on multiples of 64 ----
export const BLOCK = 64;
export const CITY = { bi0: 1, bi1: 14, bj0: -7, bj1: 6 };
export const CLS_H = [50, 110, 190];
export interface Bldg { x: number; z: number; w: number; d: number; h: number; cls: 0 | 1 | 2; shrine: boolean }

export function cityBlock(bi: number, bj: number): Bldg | null {
  if (bi < CITY.bi0 || bi > CITY.bi1 || bj < CITY.bj0 || bj > CITY.bj1) return null;
  const r = mulberry32(Math.imul(bi, 73856093) ^ Math.imul(bj, 19349663));
  const cx = bi * BLOCK + 32, cz = bj * BLOCK + 32;
  const shrine = r() < 0.1;
  const w = 26 + r() * 20, d = 26 + r() * 20;
  const dd = Math.min(1, Math.hypot(cx - 512, cz) / 520);
  let h = 22 + (1 - dd) * 170 * (0.35 + r() * 0.65);
  if (shrine) h = 0;
  const cls: 0 | 1 | 2 = h < 70 ? 0 : h < 130 ? 1 : 2;
  return { x: cx, z: cz, w, d, h, cls, shrine };
}

/** Collision against city towers (axis-aligned footprints). */
export function blocked(x: number, z: number): boolean {
  const bi = Math.floor(x / BLOCK), bj = Math.floor(z / BLOCK);
  const b = cityBlock(bi, bj);
  if (!b || b.shrine) return false;
  return Math.abs(x - b.x) < b.w / 2 + 0.4 && Math.abs(z - b.z) < b.d / 2 + 0.4;
}

export const inCity = (x: number, z: number) => x > 64 && x < 960 && z > -448 && z < 448;

// ---- Village layout ----
export interface HouseDef { x: number; z: number; ry: number; s: number }
export function buildVillage(): HouseDef[] {
  const out: HouseDef[] = [];
  const r = mulberry32(777);
  for (let gi = -4; gi <= 4; gi++) for (let gj = -4; gj <= 4; gj++) {
    const x = VILLAGE.x + gi * 22 + (r() - 0.5) * 8;
    const z = VILLAGE.z + gj * 22 + (r() - 0.5) * 8;
    if (Math.hypot(x - VILLAGE.x, z - VILLAGE.z) > 85) continue;
    if (Math.abs(x - riverX(z)) < 30) continue;
    if (heightAt(x, z) < 3) continue;
    out.push({ x, z, ry: Math.round(r() * 4) * (Math.PI / 2) + (r() - 0.5) * 0.15, s: 0.9 + r() * 0.4 });
  }
  return out;
}
export const TORII: HouseDef[] = [
  { x: -45, z: 25, ry: 0.35, s: 1.2 },
  { x: -175, z: 80, ry: 1.2, s: 1.0 },
  { x: -120, z: 150, ry: 0, s: 0.9 },
];
