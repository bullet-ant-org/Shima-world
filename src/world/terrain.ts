/** Procedural world definition shared by streaming, props, simulation and collision. */
export const CHUNK = 128;
export const SEA = -8;

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

export const riverX = (z: number) => -700 + Math.sin(z * 0.008) * 60 + Math.sin(z * 0.021) * 15;

// ---- Five islands, separated by open sea ----
export type IslandId = 'valley' | 'city' | 'god' | 'ember' | 'snow';
export type Zone = IslandId | 'sea';
export interface Island {
  id: IslandId; name: string; title: string;
  cx: number; cz: number; rx: number; rz: number;
  /** superellipse exponent: 2 = ellipse, large = rounded rectangle (the city grid needs square corners) */
  p: number;
  /** coastline ramp: land fades out between these normalised radii */
  ramp: [number, number];
  spawn: { x: number; z: number };
}
export const ISLANDS: Island[] = [
  { id: 'valley', name: 'SAKURA VALLEY', title: 'Sakura Valley', cx: -740, cz: 40, rx: 540, rz: 480, p: 2, ramp: [0.62, 1], spawn: { x: -520, z: 60 } },
  { id: 'city', name: 'CYBER CITY', title: 'The City', cx: 512, cz: 0, rx: 560, rz: 520, p: 12, ramp: [0.93, 1], spawn: { x: 512, z: 64 } },
  { id: 'god', name: 'GOD ISLAND', title: 'God Island', cx: -100, cz: -1500, rx: 560, rz: 560, p: 2, ramp: [0.65, 1], spawn: { x: -100, z: -1160 } },
  { id: 'ember', name: 'EMBER ISLE', title: 'Ember Isle (volcano)', cx: 560, cz: 1150, rx: 480, rz: 440, p: 2, ramp: [0.62, 1], spawn: { x: 560, z: 1500 } },
  { id: 'snow', name: 'YUKIGAMI PEAKS', title: 'Yukigami Peaks (snow)', cx: -740, cz: 1150, rx: 480, rz: 440, p: 2, ramp: [0.62, 1], spawn: { x: -740, z: 1450 } },
];
const BY_ID = Object.fromEntries(ISLANDS.map((i) => [i.id, i])) as Record<IslandId, Island>;
export const GOD = { x: BY_ID.god.cx, z: BY_ID.god.cz };

// landmark anchors shared by terrain, streaming, collision and the resident skyline
export const SPIRE = { x: 544, z: 32, r: 15, h: 440 };                       // city: neon spire (block 8,0 is its plaza)
export const VOLCANO = { x: 520, z: 1120 };                                  // ember isle
export const LAKE = { x: -700, z: 1170, r: 130 };                            // snow peaks: frozen lake
export const HILL = { x: -540, z: -140 };                                    // valley: shrine hill
export const RICE = { x0: -600, x1: -440, z0: 60, z1: 200 };
export const BRIDGES_Z = [-210, 120, 320];

function dist(isl: Island, x: number, z: number): number {
  const dx = Math.abs(x - isl.cx) / isl.rx, dz = Math.abs(z - isl.cz) / isl.rz;
  const d = isl.p === 2 ? Math.hypot(dx, dz) : Math.pow(Math.pow(dx, isl.p) + Math.pow(dz, isl.p), 1 / isl.p);
  // organic coastline everywhere except the city, whose grid needs straight edges
  return isl.id === 'city' ? d : d * (1 + (noise2(x * 0.004 + isl.cx, z * 0.004) - 0.5) * 0.22);
}
const maskOf = (isl: Island, d: number) => 1 - sstep(isl.ramp[0], isl.ramp[1], d);

function islandHeight(id: IslandId, x: number, z: number, d: number): number {
  switch (id) {
    case 'valley': {
      const rolling = 10 + Math.sin(x * 0.011) * Math.cos(z * 0.013) * 9 + noise2(x * 0.02, z * 0.02) * 8 + Math.sin(x * 0.027 + z * 0.019) * 3;
      const dr = x - riverX(z);
      const river = -16 * Math.exp(-(dr * dr) / (2 * 20 * 20));
      const ridge = Math.max(sstep(-930, -1090, x), sstep(-200, -330, z) * 0.85);
      const mount = ridge * 110 * (0.5 + noise2(x * 0.006, z * 0.006));
      const hx = x - HILL.x, hz = z - HILL.z;
      const hill = 52 * Math.exp(-(hx * hx + hz * hz) / (2 * 75 * 75));
      return rolling + river * (1 - ridge) + mount + hill;
    }
    case 'city':
      return 3;
    case 'god': {
      const dg = Math.hypot(x - GOD.x, z - GOD.z) / 560;
      return 22 + noise2(x * 0.01, z * 0.01) * 30 + Math.sin(x * 0.03) * Math.cos(z * 0.025) * 6 + (1 - sstep(0, 0.5, dg)) * 30;
    }
    case 'ember': {
      const r = Math.hypot(x - VOLCANO.x, z - VOLCANO.z);
      const a = Math.atan2(z - VOLCANO.z, x - VOLCANO.x);
      const cone = 200 * Math.pow(Math.max(0, 1 - Math.max(r, 70) / 320), 1.3); // flat-topped: rim ring at r~70, crater bowl inside
      const crater = (1 - sstep(25, 75, r)) * 95;
      const ribs = Math.sin(a * 9 + noise2(x * 0.01, z * 0.01) * 4) * 9 * (1 - sstep(120, 280, r)) * sstep(40, 90, r);
      return 8 + noise2(x * 0.015, z * 0.015) * 10 + cone - crater + ribs;
    }
    case 'snow': {
      const r = Math.hypot(x - LAKE.x, z - LAKE.z);
      const ridged = 1 - Math.abs(2 * noise2(x * 0.007, z * 0.007) - 1);
      const peaks = sstep(150, 330, r) * 125 * Math.pow(ridged, 2.2);
      const base = 12 + noise2(x * 0.02, z * 0.02) * 14 + peaks;
      return mix(base, 2.4, 1 - sstep(LAKE.r - 30, LAKE.r + 40, r));
    }
  }
}

export function islandAt(x: number, z: number): Island | null {
  let best: Island | null = null, bm = 0;
  for (const isl of ISLANDS) {
    if (Math.abs(x - isl.cx) > isl.rx * 1.3 || Math.abs(z - isl.cz) > isl.rz * 1.3) continue;
    const m = maskOf(isl, dist(isl, x, z));
    if (m > bm) { bm = m; best = isl; }
  }
  return best;
}

export function heightAt(x: number, z: number): number {
  let best = SEA;
  for (const isl of ISLANDS) {
    if (Math.abs(x - isl.cx) > isl.rx * 1.3 || Math.abs(z - isl.cz) > isl.rz * 1.3) continue;
    const d = dist(isl, x, z);
    if (d >= isl.ramp[1]) continue;
    const m = maskOf(isl, d);
    const h = SEA + (islandHeight(isl.id, x, z, d) - SEA) * m;
    if (h > best) best = h;
  }
  return best;
}

export function zoneAt(x: number, z: number): Zone {
  if (heightAt(x, z) < 0) return 'sea';
  return islandAt(x, z)?.id ?? 'sea';
}

/** 0..1 lava coverage on Ember Isle: radial streams down the volcano plus the crater lake. */
export function lavaAt(x: number, z: number): number {
  const r = Math.hypot(x - VOLCANO.x, z - VOLCANO.z);
  if (r < 42) return 1;
  if (r > 300) return 0;
  const a = Math.atan2(z - VOLCANO.z, x - VOLCANO.x);
  const w = Math.abs(Math.sin(a * 4.5 + r * 0.012 + noise2(x * 0.02, z * 0.02) * 3));
  return (1 - sstep(0.035, 0.09, w)) * (1 - sstep(190, 300, r));
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
  if (bi === 8 && bj === 0) return null; // the spire's plaza
  const shrine = r() < 0.1;
  const w = 26 + r() * 20, d = 26 + r() * 20;
  const dd = Math.min(1, Math.hypot(cx - 512, cz) / 520);
  let h = 22 + (1 - dd) * 170 * (0.35 + r() * 0.65);
  if (shrine) h = 0;
  const cls: 0 | 1 | 2 = h < 70 ? 0 : h < 130 ? 1 : 2;
  return { x: cx, z: cz, w, d, h, cls, shrine };
}

/** Top surface (world y) of whatever solid occupies this column, or -Infinity. Used so flyers can pass over towers. */
export function blockTop(x: number, z: number): number {
  if (Math.hypot(x - SPIRE.x, z - SPIRE.z) < SPIRE.r) return 3 + SPIRE.h;
  const b = cityBlock(Math.floor(x / BLOCK), Math.floor(z / BLOCK));
  if (!b || b.shrine) return -Infinity;
  return Math.abs(x - b.x) < b.w / 2 + 0.4 && Math.abs(z - b.z) < b.d / 2 + 0.4 ? 3 + b.h : -Infinity;
}
/** Collision against city towers (axis-aligned footprints) for walkers. */
export const blocked = (x: number, z: number): boolean => blockTop(x, z) > -Infinity;

export const inCity = (x: number, z: number) => x > 64 && x < 960 && z > -448 && z < 448;

// ---- Sakura Valley sacred path: a climb of torii gates up the shrine hill ----
export interface Gate { x: number; z: number; ry: number; s: number }
export function senbonTorii(): Gate[] {
  const out: Gate[] = [];
  const n = 16, x0 = -470, z0 = 10;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const bend = Math.sin(t * Math.PI * 1.5) * 26;
    const x = x0 + (HILL.x + 20 - x0) * t + bend, z = z0 + (HILL.z + 10 - z0) * t;
    const t2 = Math.min(1, t + 0.05);
    const dx = (x0 + (HILL.x + 20 - x0) * t2 + Math.sin(t2 * Math.PI * 1.5) * 26) - x, dz = (z0 + (HILL.z + 10 - z0) * t2) - z;
    out.push({ x, z, ry: Math.atan2(dx, dz), s: 1.1 - t * 0.2 });
  }
  return out;
}
