/** Procedural world definition shared by streaming, props, simulation and collision. Pure functions, no dependencies. */
export const CHUNK = 128;
export const SEA = -8;

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const sstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function hash2(x: number, z: number): number {
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
/** two octaves, 0..1 */
export const fbm = (x: number, z: number) => noise2(x, z) * 0.65 + noise2(x * 2.1 + 7.3, z * 2.1 - 3.1) * 0.35;
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Islands. The map spans roughly 7 km x 7 km. Five major islands plus five islets, all separated by open sea.
// ---------------------------------------------------------------------------------------------------------------------
export type IslandId = 'valley' | 'city' | 'god' | 'ember' | 'snow' | 'islet';
export type Zone = IslandId | 'sea';
export interface Island {
  key: string; id: IslandId; name: string; title: string;
  cx: number; cz: number; rx: number; rz: number;
  /** superellipse exponent: 2 = ellipse */
  p: number;
  /** coastline ramp: land fades out between these normalised radii */
  ramp: [number, number];
  spawn: { x: number; z: number };
}
export const ISLANDS: Island[] = [
  { key: 'valley', id: 'valley', name: 'SAKURA VALLEY', title: 'Sakura Valley', cx: -2100, cz: 100, rx: 900, rz: 820, p: 2, ramp: [0.62, 1], spawn: { x: -1640, z: 200 } },
  { key: 'city', id: 'city', name: 'CYBER CITY', title: 'The City', cx: 0, cz: 0, rx: 1050, rz: 950, p: 2.4, ramp: [0.9, 1], spawn: { x: 0, z: 68 } },
  { key: 'god', id: 'god', name: 'GOD ISLAND', title: 'God Island', cx: -300, cz: -2500, rx: 1050, rz: 1050, p: 2, ramp: [0.7, 1], spawn: { x: -300, z: -1870 } },
  { key: 'ember', id: 'ember', name: 'EMBER ISLE', title: 'Ember Isle (volcano)', cx: 1500, cz: 1900, rx: 800, rz: 720, p: 2, ramp: [0.62, 1], spawn: { x: 1500, z: 2420 } },
  { key: 'snow', id: 'snow', name: 'YUKIGAMI PEAKS', title: 'Yukigami Peaks (snow)', cx: -1900, cz: 1900, rx: 850, rz: 780, p: 2, ramp: [0.62, 1], spawn: { x: -1860, z: 2330 } },
  { key: 'airport', id: 'city', name: 'HANEDA AIRPORT', title: 'Haneda Airport', cx: 1700, cz: 1000, rx: 700, rz: 230, p: 5, ramp: [0.88, 1], spawn: { x: 1570, z: 930 } },
  { key: 'moon', id: 'islet', name: 'TSUKI ROCK', title: 'Tsuki Rock (islet)', cx: -1300, cz: -1450, rx: 260, rz: 240, p: 2, ramp: [0.55, 1], spawn: { x: -1300, z: -1320 } },
  { key: 'fox', id: 'islet', name: 'KITSUNE ISLE', title: 'Kitsune Isle (islet)', cx: 750, cz: 1150, rx: 280, rz: 250, p: 2, ramp: [0.55, 1], spawn: { x: 750, z: 1260 } },
  { key: 'reef', id: 'islet', name: 'CRYSTAL REEF', title: 'Crystal Reef (islet)', cx: -2050, cz: 1020, rx: 240, rz: 230, p: 2, ramp: [0.55, 1], spawn: { x: -2050, z: 1110 } },
  { key: 'arch', id: 'islet', name: 'ARCH ROCKS', title: 'Arch Rocks (islet)', cx: 1250, cz: -1500, rx: 250, rz: 240, p: 2, ramp: [0.55, 1], spawn: { x: 1250, z: -1390 } },
  { key: 'cairn', id: 'islet', name: 'CAIRN ISLE', title: 'Cairn Isle (islet)', cx: 1850, cz: -150, rx: 320, rz: 280, p: 2, ramp: [0.55, 1], spawn: { x: 1850, z: -30 } },
];
export const MAJOR = ISLANDS.slice(0, 5);
export const AIRPORT = ISLANDS.find((i) => i.key === 'airport')!;
const BY_KEY = Object.fromEntries(ISLANDS.map((i) => [i.key, i])) as Record<string, Island>;
export const island = (k: string) => BY_KEY[k];
export const GOD = { x: BY_KEY.god.cx, z: BY_KEY.god.cz };
export const CITY_C = { x: BY_KEY.city.cx, z: BY_KEY.city.cz };

// landmark anchors shared by terrain, streaming, collision and layout
export const SPIRE = { x: CITY_C.x, z: CITY_C.z, r: 16, h: 460 };
export const VOLCANO = { x: BY_KEY.ember.cx - 60, z: BY_KEY.ember.cz - 40 };
export const LAKE = { x: BY_KEY.snow.cx + 120, z: BY_KEY.snow.cz + 60, r: 200 };
export const HILL = { x: BY_KEY.valley.cx + 240, z: BY_KEY.valley.cz - 330 };
export const RICE = { x0: BY_KEY.valley.cx + 400, x1: BY_KEY.valley.cx + 680, z0: BY_KEY.valley.cz + 200, z1: BY_KEY.valley.cz + 420 };
export const BRIDGES_Z = [BY_KEY.valley.cz - 260, BY_KEY.valley.cz + 20, BY_KEY.valley.cz + 330];
export const riverX = (z: number) => BY_KEY.valley.cx + 200 + Math.sin(z * 0.004) * 130 + Math.sin(z * 0.011) * 32;

/** Broad massif: smooth, wide-based, and gentle enough that slopes stay under ~45 degrees (max grade ~0.8 * H/R). */
const massif = (x: number, z: number, px: number, pz: number, H: number, R: number): number => {
  const r = Math.hypot(x - px, z - pz) / R;
  return r > 2.4 ? 0 : H * Math.exp(-Math.pow(r, 1.8));
};

/** Smooth maximum of several massifs (a p-norm), so overlapping peaks merge into ridges instead of stacking to absurd heights. */
const range = (x: number, z: number, list: number[][]): number => {
  let s = 0;
  for (const p of list) { const h = massif(x, z, p[0], p[1], p[2], p[3]); s += h * h * h; }
  return Math.cbrt(s);
};

// Peaks sit well inside their island (normalised radius < ~0.5) so the coast mask never squashes them into cliffs.
const VALLEY_PEAKS: number[][] = [[-2400, -60, 360, 430], [-2350, 300, 300, 380], [-2300, -380, 320, 400], [-2520, 120, 440, 470], [-2250, 520, 250, 340]];
const SNOW_PEAKS: number[][] = [[-2280, 1700, 580, 540], [-1850, 1500, 400, 420], [-2250, 2090, 340, 390], [-2050, 2190, 260, 330], [-2000, 1420, 330, 380]];
const GOD_PEAKS: number[][] = [];
for (let i = 0; i < 6; i++) {
  const a = Math.PI * (1.2 + (i / 5) * 0.6); // a horseshoe of mountains around the north, leaving the south open for the pilgrim road
  GOD_PEAKS.push([GOD.x + Math.cos(a) * 650, GOD.z + Math.sin(a) * 650, 300 + ((i * 53) % 90), 260 + ((i * 37) % 50)]);
}

/** Terrain = base land (shaped by the coastline mask) + mountains (faded in separately so peaks never get squashed into cliffs). */
const PART = { b: 0, m: 0 };
function islandParts(isl: Island, x: number, z: number): typeof PART {
  PART.m = 0;
  switch (isl.key) {
    case 'valley': {
      const mount = range(x, z, VALLEY_PEAKS);
      const dr = x - riverX(z);
      const river = -20 * Math.exp(-(dr * dr) / (2 * 26 * 26));
      const hx = x - HILL.x, hz = z - HILL.z;
      PART.b = 12 + Math.sin(x * 0.0055) * Math.cos(z * 0.0065) * 10 + fbm(x * 0.01, z * 0.01) * 12 + Math.sin(x * 0.013 + z * 0.009) * 4
        + river * (1 - sstep(30, 140, mount)) + 85 * Math.exp(-(hx * hx + hz * hz) / (2 * 150 * 150));
      PART.m = mount; return PART;
    }
    case 'city': PART.b = 3; return PART;
    case 'airport': PART.b = 5.5; return PART;
    case 'god': {
      const dg = Math.hypot(x - GOD.x, z - GOD.z) / 1050;
      // sacred terraces: the land climbs from the shore to the altar plateau in broad, stone-edged steps
      const t = (1 - sstep(0.2, 0.86, dg)) * 5, f = t - Math.floor(t);
      PART.b = 6 + 15 * (Math.floor(t) + sstep(0.3, 0.7, f)) + fbm(x * 0.012, z * 0.012) * 8;
      // mountains only rise outside the sacred plateau, leaving a flat, terraced precinct for the temples
      PART.m = range(x, z, GOD_PEAKS) * sstep(430, 640, Math.hypot(x - GOD.x, z - GOD.z)); return PART;
    }
    case 'ember': {
      const r = Math.hypot(x - VOLCANO.x, z - VOLCANO.z);
      const a = Math.atan2(z - VOLCANO.z, x - VOLCANO.x);
      const cone = 400 * Math.pow(Math.max(0, 1 - Math.max(r, 140) / 560), 1.35); // flat rim at r<140, crater inside
      const crater = (1 - sstep(40, 130, r)) * 150;
      const ribs = Math.sin(a * 9 + fbm(x * 0.006, z * 0.006) * 5) * 14 * (1 - sstep(180, 460, r)) * sstep(70, 160, r);
      PART.b = 10 + fbm(x * 0.009, z * 0.009) * 14 + ribs;
      PART.m = cone - crater + massif(x, z, isl.cx + 440, isl.cz + 120, 170, 220); return PART;
    }
    case 'snow': {
      const r = Math.hypot(x - LAKE.x, z - LAKE.z);
      const b = 14 + fbm(x * 0.012, z * 0.012) * 18;
      PART.b = mix(b, 2.4, 1 - sstep(LAKE.r - 40, LAKE.r + 60, r));
      PART.m = range(x, z, SNOW_PEAKS) * sstep(LAKE.r, LAKE.r + 560, r); return PART; // the lake sits in a gentle bowl, peaks stand back
    }
    case 'moon': PART.b = 14 + fbm(x * 0.03, z * 0.03) * 6; PART.m = massif(x, z, isl.cx, isl.cz, 60, 140); return PART;
    case 'fox': PART.b = 10 + fbm(x * 0.03, z * 0.03) * 5; PART.m = massif(x, z, isl.cx - 30, isl.cz - 20, 50, 140); return PART;
    case 'reef': PART.b = 7 + fbm(x * 0.04, z * 0.04) * 6; return PART;
    case 'arch': PART.b = 12 + fbm(x * 0.03, z * 0.03) * 8; PART.m = massif(x, z, isl.cx, isl.cz, 70, 120); return PART;
    default: PART.b = 11 + fbm(x * 0.03, z * 0.03) * 6; PART.m = massif(x, z, isl.cx, isl.cz, 80, 150); return PART; // cairn
  }
}

function dist(isl: Island, x: number, z: number): number {
  const dx = Math.abs(x - isl.cx) / isl.rx, dz = Math.abs(z - isl.cz) / isl.rz;
  const d = isl.p === 2 ? Math.hypot(dx, dz) : Math.pow(Math.pow(dx, isl.p) + Math.pow(dz, isl.p), 1 / isl.p);
  // organic coastline; the city keeps a calmer one so its ring roads stay inside
  return d * (1 + (noise2(x * 0.0025 + isl.cx, z * 0.0025 + isl.cz) - 0.5) * (isl.id === 'city' ? 0.08 : 0.22));
}
const maskOf = (isl: Island, d: number) => 1 - sstep(isl.ramp[0], isl.ramp[1], d);

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
    const q = islandParts(isl, x, z);
    const h = SEA + (q.b - SEA) * maskOf(isl, d) + q.m * (1 - sstep(isl.id === 'islet' ? 0.4 : 0.38, isl.id === 'islet' ? 0.95 : 1.02, d));
    if (h > best) best = h;
  }
  return best;
}

export function zoneAt(x: number, z: number): Zone {
  if (heightAt(x, z) < 0) return 'sea';
  return islandAt(x, z)?.id ?? 'sea';
}

/** terrain gradient magnitude (rise over run) */
export function slopeAt(x: number, z: number): number {
  const e = 2;
  return Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
}

/** 0..1 lava coverage on Ember Isle: radial streams down the volcano plus the crater lake. */
export function lavaAt(x: number, z: number): number {
  const r = Math.hypot(x - VOLCANO.x, z - VOLCANO.z);
  if (r < 85) return 1;
  if (r > 520) return 0;
  const a = Math.atan2(z - VOLCANO.z, x - VOLCANO.x);
  const w = Math.abs(Math.sin(a * 5.5 + r * 0.006 + noise2(x * 0.012, z * 0.012) * 3));
  return (1 - sstep(0.03, 0.08, w)) * (1 - sstep(300, 520, r));
}
