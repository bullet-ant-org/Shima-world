/**
 * World layout (pure data, no rendering): road/path networks, city lots and buildings, and every placed prop.
 * Deterministic: the same seeds always produce the same world.
 */
import { PathNet, type Path } from './paths';
import {
  AIRPORT, BRIDGES_Z, CHUNK, CITY_C, GOD, HILL, LAKE, RICE, SPIRE, VOLCANO, hash2, heightAt, island, mulberry32, noise2, riverX, slopeAt,
} from './terrain';
import type { BuildingSpec, Tpl } from '../rendering/geo';

export const NET = new PathNet();
const TAU = Math.PI * 2;

export interface PropDef { x: number; z: number; ry: number; s: number; v?: number }
export const PROPS: Record<string, PropDef[]> = {};
const prop = (kind: string, x: number, z: number, ry = 0, s = 1, v = 0) => { (PROPS[kind] ??= []).push({ x, z, ry, s, v }); };
const land = (x: number, z: number, minH = 3) => heightAt(x, z) >= minH;
/** rotation so a model's local +z faces direction (dx,dz) */
const face = (dx: number, dz: number) => Math.atan2(dx, dz);

// ---------------------------------------------------------------------------------------------------------------------
// CITY: curved avenues, wobbling ring roads, cross streets; blocks follow the roads
// ---------------------------------------------------------------------------------------------------------------------
export interface Building { x: number; z: number; ry: number; spec: BuildingSpec; hw: number; hd: number; top: number; cx: number; cz: number }
export const BUILDINGS: Building[] = [];
const BCELL = 64;
const bIndex = new Map<string, Building[]>();
const bKey = (x: number, z: number) => Math.floor(x / BCELL) + ',' + Math.floor(z / BCELL);

const RINGS = [95, 250, 440, 650, 820];
const ringR = (r0: number, a: number) => r0 + (r0 > 100 ? 22 : 6) * Math.sin(a * 3 + r0 * 0.1) + (r0 > 100 ? 12 : 3) * Math.sin(a * 5 + r0 * 0.37);
const NRAD = 10;
const radA = (k: number, r: number) => (k / NRAD) * TAU + (hash2(k, 7) - 0.5) * 0.18 + Math.sin(r * 0.0055 + k * 1.7) * 0.14 + (noise2(r * 0.004, k * 3.1) - 0.5) * 0.12;
export const cityPaths: Path[] = [];

function buildCityRoads(): void {
  const C = CITY_C;
  // 1. radial avenues from the spire plaza to the waterfront
  for (let k = 0; k < NRAD; k++) {
    const pts: number[][] = [];
    for (let r = 95; r <= 835; r += 55) { const a = radA(k, r); pts.push([C.x + Math.cos(a) * ringR(r, a) * (r / ringR(r, a)), C.z + Math.sin(a) * r]); }
    cityPaths.push(NET.add('avenue', 22, pts, 'city'));
  }
  // 2. ring roads (closed, each wobbling differently)
  RINGS.forEach((r0, ri) => {
    const pts: number[][] = [], n = 40;
    for (let i = 0; i < n; i++) { const a = (i / n) * TAU, r = ringR(r0, a); pts.push([C.x + Math.cos(a) * r, C.z + Math.sin(a) * r]); }
    cityPaths.push(NET.add(ri === 1 || ri === 2 ? 'avenue' : 'street', ri === 1 || ri === 2 ? 20 : 14, pts, 'city', true));
  });
  // 3. curved cross streets inside every sector, linking ring to ring (breaks big blocks into walkable lots)
  for (let b = 0; b < RINGS.length - 1; b++) for (let k = 0; k < NRAD; k++) {
    const nStreets = b === 0 ? 0 : b === 1 ? 1 : 2;
    for (let q = 0; q < nStreets; q++) {
      const a0 = radA(k, RINGS[b]), a1 = radA((k + 1) % NRAD, RINGS[b]) + (k + 1 === NRAD ? TAU : 0);
      const t = (q + 1) / (nStreets + 1) + (hash2(k * 3 + b, q) - 0.5) * 0.12, bend = (hash2(b, k * 5 + q) - 0.5) * 0.12;
      const pts: number[][] = [];
      for (let s = 0; s <= 4; s++) {
        const f = s / 4, r = RINGS[b] + (RINGS[b + 1] - RINGS[b]) * f;
        const a = a0 + (a1 - a0) * t + Math.sin(f * Math.PI) * bend + (f - 0.5) * 0.04;
        pts.push([C.x + Math.cos(a) * ringR(r, a), C.z + Math.sin(a) * ringR(r, a)]);
      }
      cityPaths.push(NET.add('street', 12, pts, 'city'));
    }
  }
}

const SHOW = (t: Tpl, w: number, d: number, fl: number, pal: number, roof: number, seed: number, shop: boolean): BuildingSpec => ({ tpl: t, w, d, fl, pal, roof, seed, shop });

type Theme = 'fin' | 'ent' | 'res' | 'old' | 'com';
const THEMES: Theme[] = ['fin', 'ent', 'res', 'old', 'com', 'fin', 'ent', 'res', 'old', 'com'];

/** Themed building catalogs: every district has its own kinds of architecture, not copies of one block. */
function catalog(): Record<Theme, BuildingSpec[]> & { low: BuildingSpec[] } {
  const r = mulberry32(2718), pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)], ri = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const S = (t: Tpl, w: number, d: number, fl: number, pal = ri(0, 7), roof = ri(0, 7), shop = false, seed = ri(1, 9999)): BuildingSpec => ({ tpl: t, w, d, fl, pal, roof, seed, shop });
  const fin: BuildingSpec[] = [], ent: BuildingSpec[] = [], res: BuildingSpec[] = [], old: BuildingSpec[] = [], com: BuildingSpec[] = [], low: BuildingSpec[] = [];
  for (let i = 0; i < 9; i++) fin.push(S('office', pick([24, 28, 32, 38]), pick([24, 28, 32, 38]), ri(24, 64)));
  for (let i = 0; i < 3; i++) fin.push(S('bank', pick([34, 38]), pick([28, 32]), 6));
  for (let i = 0; i < 4; i++) fin.push(S(pick<Tpl>(['step', 'twin', 'round', 'podium']), pick([30, 36, 42]), pick([30, 36, 42]), ri(34, 70), pick([3, 3, 2, 6, 0, 7])));
  fin.push(S('broadcast', 30, 30, ri(42, 62)));
  for (let i = 0; i < 6; i++) ent.push(S('club', pick([26, 30, 34]), pick([24, 28]), 4, ri(0, 3)));
  for (let i = 0; i < 2; i++) ent.push(S('market', 48, 34, 2));
  for (let i = 0; i < 5; i++) ent.push(S('office', pick([22, 26, 30]), pick([22, 26, 30]), ri(14, 30)));
  for (let i = 0; i < 4; i++) ent.push(S(pick<Tpl>(['round', 'wedge', 'step', 'L']), pick([24, 30, 34]), pick([24, 30, 34]), ri(14, 36)));
  for (let i = 0; i < 12; i++) res.push(S(pick<Tpl>(['box', 'box', 'L', 'wedge', 'podium']), pick([18, 22, 26, 30]), pick([18, 22, 26, 30]), ri(6, 16), ri(0, 7), ri(0, 7), r() < 0.5));
  for (let i = 0; i < 5; i++) res.push(S('machiya', pick([20, 26]), pick([12, 14]), ri(2, 3), ri(0, 2)));
  for (let i = 0; i < 4; i++) old.push(S('fortress', 52, 52, 2));
  for (let i = 0; i < 8; i++) old.push(S('machiya', pick([20, 26, 33]), pick([12, 14]), ri(2, 3), ri(0, 2)));
  for (let i = 0; i < 2; i++) old.push(S('market', 48, 34, 2));
  for (let i = 0; i < 5; i++) old.push(S(pick<Tpl>(['box', 'L']), pick([18, 22]), pick([18, 22]), ri(3, 6), ri(0, 7), ri(0, 7), true));
  for (let i = 0; i < 5; i++) com.push(S('dealer', pick([40, 46]), pick([30, 34]), 2));
  for (let i = 0; i < 6; i++) com.push(S('office', pick([24, 30, 34]), pick([24, 30, 34]), ri(10, 24)));
  for (let i = 0; i < 3; i++) com.push(S('club', pick([28, 32]), pick([24, 28]), 4, ri(0, 3)));
  for (let i = 0; i < 4; i++) com.push(S(pick<Tpl>(['box', 'L', 'podium']), pick([24, 30, 36]), pick([24, 30, 36]), ri(8, 18), ri(0, 7), ri(0, 7), true));
  for (let i = 0; i < 14; i++) low.push(S(pick<Tpl>(['box', 'box', 'L', 'wedge']), pick([14, 18, 22]), pick([14, 18, 22]), ri(3, 8), ri(0, 7), ri(0, 7), r() < 0.75));
  for (let i = 0; i < 4; i++) low.push(S('machiya', pick([18, 22]), 12, ri(2, 3), ri(0, 2)));
  return { fin, ent, res, old, com, low };
}

function buildCityLots(): void {
  const cat = catalog(), C = CITY_C, rng = mulberry32(31337);
  const placed: Building[] = [], count: Record<string, number> = { broadcast: 0 };
  const near = (x: number, z: number, rad: number) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const b of bIndex.get(Math.floor(x / BCELL) + i + ',' + (Math.floor(z / BCELL) + j)) ?? []) if (Math.hypot(b.cx - x, b.cz - z) < rad + Math.max(b.hw, b.hd) * 1.05) return true;
    }
    return false;
  };
  for (let r = 118; r < 850; r += 24) {
    const dTheta = 28 / r, off = hash2(Math.floor(r), 3) * dTheta;
    for (let a = off; a < TAU; a += dTheta * (0.9 + rng() * 0.3)) {
      const rr = r + (rng() - 0.5) * 10, x = C.x + Math.cos(a) * rr, z = C.z + Math.sin(a) * rr;
      const dn = rr / 840, sector = Math.floor((((a % TAU) + TAU) % TAU) / TAU * NRAD) % NRAD;
      // districts: the downtown core is financial/entertainment; outward, each sector keeps its own character
      const theme: Theme = dn < 0.3 ? (rng() < 0.65 ? 'fin' : 'ent') : THEMES[sector];
      const list = dn > 0.78 && rng() < 0.55 ? cat.low : cat[theme];
      const room = NET.edgeDist(x, z, 60);
      if (room < 6) continue;
      // use the tier's designs when they fit the lot, otherwise step down to smaller ones so tight inner blocks still fill
      const fit = (l: BuildingSpec[]) => l.filter((s) => Math.max(s.w, s.d) / 2 + 1.5 <= room);
      let fits = fit(list);
      if (!fits.length) fits = fit(cat.res);
      if (!fits.length) fits = fit(cat.low);
      if (!fits.length) continue;
      // big signature buildings get first pick of every lot that can hold them (they'd otherwise lose to the many small designs)
      const BIG: Record<Theme, string[]> = { old: ['fortress', 'market'], ent: ['market', 'club'], com: ['dealer'], fin: ['bank'], res: [] };
      if (BIG[theme].length && rng() < (theme === 'old' ? 0.7 : 0.35)) { const big = fit(list.filter((q) => BIG[theme].includes(q.tpl))); if (big.length) fits = big; }
      if (count.broadcast >= 4) fits = fits.filter((q) => q.tpl !== 'broadcast').length ? fits.filter((q) => q.tpl !== 'broadcast') : fits;
      const lessMachiya = fits.filter((q) => q.tpl !== 'machiya' || rng() < 0.4);
      if (lessMachiya.length) fits = lessMachiya;
      const spec = fits[Math.floor(rng() * fits.length)];
      const hr = Math.max(spec.w, spec.d) / 2;
      if (Math.hypot(x - SPIRE.x, z - SPIRE.z) < 80 || near(x, z, hr * 1.05)) continue;
      const ry = Math.atan2(-Math.cos(a), -Math.sin(a)) + (rng() - 0.5) * 0.08;
      const b: Building = { x, z, cx: x, cz: z, ry, spec, hw: spec.w / 2, hd: spec.d / 2, top: 3 + (spec.tpl === 'bank' ? 30 : spec.tpl === 'market' || spec.tpl === 'dealer' ? 12 : spec.tpl === 'fortress' ? 30 : spec.fl * 3.6 + 8) };
      placed.push(b); BUILDINGS.push(b); count[spec.tpl] = (count[spec.tpl] ?? 0) + 1;
      const k = bKey(x, z); (bIndex.get(k) ?? bIndex.set(k, []).get(k)!).push(b);
    }
  }
}

export function buildingsNear(x: number, z: number): Building[] { return bIndex.get(bKey(x, z)) ?? []; }

/** Footprint test in building-local space that follows each design's real silhouette (so there are no invisible corners). */
function inside(b: Building, lx: number, lz: number): boolean {
  const m = 0.4;
  switch (b.spec.tpl) {
    case 'round': return Math.hypot(lx, lz) < Math.min(b.hw, b.hd) + m;
    case 'wedge': return lz > -b.hd - m && lz < b.hd + m && Math.abs(lx) < b.hw * (1 - (lz + b.hd) / (2 * b.hd)) + m;
    case 'broadcast': return Math.abs(lx) < 15 && Math.abs(lz) < 15;
    case 'dealer': return Math.abs(lx) < b.hw + m && lz > -b.hd - m && lz < b.hd * 0.4;
    case 'L': return Math.abs(lx) < b.hw + m && lz > -b.spec.d * 0.5 - m && lz < b.spec.d * 0.1 + m ? true : Math.abs(lx - b.spec.w * 0.25) < b.spec.w * 0.25 + m && lz > -b.spec.d * 0.1 && lz < b.hd + m;
    default: return Math.abs(lx) < b.hw + m && Math.abs(lz) < b.hd + m;
  }
}

/** Top (world y) of whatever solid stands at this column, else -Infinity. Walkers are blocked, flyers pass over. */
export function blockTop(x: number, z: number): number {
  if (Math.hypot(x - SPIRE.x, z - SPIRE.z) < SPIRE.r) return 3 + SPIRE.h;
  if (Math.abs(x - CITY_C.x) > 1000 || Math.abs(z - CITY_C.z) > 1000) return -Infinity;
  const cx = Math.floor(x / BCELL), cz = Math.floor(z / BCELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const b of bIndex.get(cx + i + ',' + (cz + j)) ?? []) {
      const dx = x - b.x, dz = z - b.z;
      if (Math.abs(dx) > 70 || Math.abs(dz) > 70) continue;
      const c = Math.cos(b.ry), s = Math.sin(b.ry);
      const lx = dx * c - dz * s, lz = dx * s + dz * c; // into building-local space (x = width)
      if (inside(b, lx, lz)) return b.top;
    }
  }
  return -Infinity;
}
export const blocked = (x: number, z: number): boolean => blockTop(x, z) > -Infinity;
export const inCity = (x: number, z: number) => Math.hypot(x - CITY_C.x, z - CITY_C.z) < 900;

/** Street furniture along the city roads: lamps, benches, traffic lights at crossings. */
function cityFurniture(): void {
  const rng = mulberry32(99);
  const avenues = cityPaths.filter((p) => p.kind !== 'street' || p.width > 13);
  // crossing points of the major roads (avenues x rings); traffic lights go here
  const X: { x: number; z: number; a: Path; b: Path; tx: number; tz: number }[] = [];
  const majors = cityPaths.filter((p) => p.kind === 'avenue');
  for (let i = 0; i < majors.length; i++) for (let j = i + 1; j < majors.length; j++) {
    for (const c of NET.intersections(majors[i], majors[j])) X.push({ x: c.x, z: c.z, a: majors[i], b: majors[j], tx: c.tx, tz: c.tz });
  }
  const nearX = (x: number, z: number) => X.some((c) => Math.hypot(c.x - x, c.z - z) < 30);
  for (const p of cityPaths) {
    const spacing = p.kind === 'avenue' ? 38 : 52;
    let side = 1;
    for (let s = 20; s < p.total - 20; s += spacing) {
      const f = NET.at(p, s / p.total);
      if (nearX(f.x, f.z) || !land(f.x, f.z, 1)) continue;
      const nx = -f.tz, nz = f.tx, off = p.width / 2 + 2.4;
      const x = f.x + nx * off * side, z = f.z + nz * off * side;
      prop('lamp', x, z, face(-nx * side, -nz * side));
      if (rng() < 0.22) prop('bench', f.x + nx * (off + 1.2) * side, f.z + nz * (off + 1.2) * side, face(-nx * side, -nz * side));
      side = -side;
    }
  }
  for (const c of X) {
    // one signal head per approach; the two roads get opposite phases
    for (const [path, ang, green] of [[c.a, 0, true], [c.b, Math.PI / 2, false]] as [Path, number, boolean][]) {
      const nn = NET.nearest(c.x, c.z, 12); void nn; void ang;
      const t = path === c.a ? { x: c.tx, z: c.tz } : { x: -c.tz, z: c.tx };
      const other = path === c.a ? c.b : c.a;
      for (const s of [-1, 1]) {
        const ox = (other.width / 2 + 5) * s, nx = -t.z, nz = t.x, off = path.width / 2 + 2.2;
        prop(green ? 'tlGreen' : 'tlRed', c.x + t.x * ox + nx * off * s, c.z + t.z * ox + nz * off * s, face(-nx * s, -nz * s));
      }
    }
  }
  void avenues;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pathways + props for the other islands (stone paths)
// ---------------------------------------------------------------------------------------------------------------------
const along = (p: Path, every: number, off: number, start = 0, end = 1, fn: (x: number, z: number, nx: number, nz: number, side: number, f: number) => void): void => {
  let side = 1;
  for (let s = start * p.total; s < end * p.total; s += every) {
    const f = NET.at(p, s / p.total);
    const nx = -f.tz, nz = f.tx;
    fn(f.x + nx * off * side, f.z + nz * off * side, nx * side, nz * side, side, s / p.total);
    side = -side;
  }
};
const stoneAt = (pts: number[][], w: number, isl: string, closed = false, mossy = false) => NET.add('stone', w, pts, isl, closed, mossy);

function godIsland(): void {
  const gx = GOD.x, gz = GOD.z;
  const proc = stoneAt([[gx + 30, gz + 650], [gx + 130, gz + 560], [gx + 50, gz + 450], [gx - 90, gz + 360], [gx - 20, gz + 270], [gx + 10, gz + 200], [gx, gz + 110], [gx, gz + 48]], 8, 'god', false, true);
  const ringPts: number[][] = [];
  for (let i = 0; i < 14; i++) { const a = (i / 14) * TAU, r = 235 + Math.sin(a * 3) * 12; ringPts.push([gx + Math.cos(a) * r, gz + Math.sin(a) * r]); }
  const ring = stoneAt(ringPts, 6, 'god', true, true);
  const north = stoneAt([[gx, gz - 235], [gx + 60, gz - 270], [gx - 40, gz - 305], [gx + 15, gz - 335], [gx, gz - 360]], 7, 'god', false, true);
  // pagoda spurs east / west
  const east = stoneAt([[gx + 232, gz - 40], [gx + 290, gz - 80], [gx + 340, gz - 70], [gx + 380, gz - 100]], 5, 'god', false, true);
  const west = stoneAt([[gx - 232, gz + 20], [gx - 290, gz + 60], [gx - 350, gz + 40], [gx - 400, gz + 70]], 5, 'god', false, true);
  prop('pagoda', gx + 395, gz - 110, face(-1, 0.3), 1.15); prop('pagoda', gx - 415, gz + 85, face(1, -0.2), 1.15);
  // main temple + courtyard behind the north spur; guardians flank the stairs
  prop('temple', gx, gz - 395, face(0, 1), 1.25);
  prop('komainu', gx - 24, gz - 345, face(0, 1), 1.2); prop('komainu', gx + 24, gz - 345, face(0, 1), 1.2);
  prop('toroBig', gx - 12, gz - 340, 0, 1); prop('toroBig', gx + 12, gz - 340, 0, 1);
  // pilgrim gate and torii procession
  const g0 = NET.at(proc, 0.08); prop('sanmon', g0.x, g0.z, face(g0.tx, g0.tz) , 1.1);
  for (const f of [0.2, 0.34, 0.5, 0.64]) { const q = NET.at(proc, f); prop('torii', q.x, q.z, face(q.tx, q.tz), 1.35); }
  for (const f of [0.08, 0.5, 0.9]) { const q = NET.at(proc, f), nx = -q.tz, nz = q.tx; prop('komainu', q.x + nx * 7, q.z + nz * 7, face(-nx, -nz), 1); prop('komainu', q.x - nx * 7, q.z - nz * 7, face(nx, nz), 1); }
  // lanterns glowing cyan along every path
  along(proc, 24, 6, 0.04, 0.98, (x, z) => prop('toro', x, z, 0, 1));
  along(ring, 30, 5, 0, 1, (x, z) => prop('toro', x, z, 0, 0.9));
  along(north, 26, 5, 0, 1, (x, z) => prop('toro', x, z, 0, 1));
  // six small shrines on the plateau, each on its own curved spur off the ring
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.5, r0 = 235, r1 = 330 + (i % 2) * 40;
    const mid = a + 0.1 * (i % 2 ? 1 : -1);
    const pts = [[gx + Math.cos(a) * (r0 + 4), gz + Math.sin(a) * (r0 + 4)], [gx + Math.cos(mid) * ((r0 + r1) / 2), gz + Math.sin(mid) * ((r0 + r1) / 2)], [gx + Math.cos(a + 0.02) * r1, gz + Math.sin(a + 0.02) * r1]];
    if (!land(pts[2][0], pts[2][1], 8)) continue;
    stoneAt(pts, 4, 'god', false, true);
    prop('shrine', pts[2][0] + Math.cos(a) * 10, pts[2][1] + Math.sin(a) * 10, face(-Math.cos(a), -Math.sin(a)), 1);
  }
  void east; void west;
}

function sakuraValley(): void {
  const v = island('valley'), VC = { x: v.cx + 480, z: v.cz + 50 };
  const loop: number[][] = [];
  for (let i = 0; i < 9; i++) { const a = (i / 9) * TAU, r = 125 + Math.sin(a * 2 + 1) * 26; loop.push([VC.x + Math.cos(a) * r, VC.z + Math.sin(a) * r * 0.85]); }
  const vloop = stoneAt(loop, 7, 'valley', true);
  // pilgrim route up the shrine hill (switch-backing), ending at the hilltop temple
  const toHill = stoneAt([[VC.x - 40, VC.z - 108], [VC.x - 130, VC.z - 190], [HILL.x + 120, HILL.z + 120], [HILL.x + 20, HILL.z + 90], [HILL.x + 90, HILL.z + 40], [HILL.x - 20, HILL.z + 6], [HILL.x, HILL.z - 14]], 6, 'valley');
  prop('temple', HILL.x, HILL.z - 36, face(0, 1), 1.1);
  prop('komainu', HILL.x - 15, HILL.z + 2, face(0, 1), 1); prop('komainu', HILL.x + 15, HILL.z + 2, face(0, 1), 1);
  prop('greatTree', HILL.x + 58, HILL.z - 30, 0.4, 1.2);
  for (let i = 0; i < 16; i++) { const q = NET.at(toHill, 0.2 + (i / 15) * 0.7); prop('torii', q.x, q.z, face(q.tx, q.tz), 0.95 - i * 0.012); }
  along(toHill, 22, 5, 0.04, 0.98, (x, z) => prop('toro', x, z, 0, 0.9));
  // three bridges; paths cross the river and run toward the western mountains
  BRIDGES_Z.forEach((bz, i) => {
    const bx = riverX(bz), bridge = i === 1 ? 1 : 0;
    const tie = i === 0 ? [VC.x - 125, VC.z - 40] : i === 1 ? [VC.x - 120, VC.z + 20] : [VC.x - 70, VC.z + 100];
    const pts = [tie, [bx + 160, bz + (tie[1] - bz) * 0.4], [bx + 55, bz + 4], [bx - 55, bz - 4], [bx - 160, bz - 16], [bx - 330, bz - 60 + i * 50], [bx - 520, bz - 20 + i * 40]];
    const p = stoneAt(pts, bridge ? 7 : 5, 'valley');
    along(p, 40, 4.5, 0.1, 0.95, (x, z) => { if (heightAt(x, z) > 2) prop('toro', x, z, 0, 0.85); });
    prop('bridge', bx, bz, 0, 1);
  });
  // rice-field lane and a shrine at its end
  const rice = stoneAt([[VC.x + 20, VC.z + 108], [VC.x + 40, VC.z + 200], [(RICE.x0 + RICE.x1) / 2 - 80, RICE.z0 - 20], [RICE.x1 - 20, RICE.z0 + 40]], 5, 'valley');
  prop('shrine', RICE.x1 + 6, RICE.z0 + 50, face(-1, 0), 1);
  // the village: houses fronting the loop path, tea houses at the plaza
  const rng = mulberry32(555);
  along(vloop, 26, 13, 0.0, 1, (x, z, nx, nz, side) => {
    if (!land(x, z, 3) || slopeAt(x, z) > 0.3 || Math.abs(x - riverX(z)) < 70) return;
    prop('house' + Math.floor(rng() * 3), x, z, face(-nx, -nz), 0.95 + rng() * 0.2);
    if (side > 0 && rng() < 0.45) { // second row behind
      const bx = x + nx * 22, bz = z + nz * 22;
      if (land(bx, bz, 3) && slopeAt(bx, bz) < 0.3) prop('house' + Math.floor(rng() * 3), bx, bz, face(-nx, -nz), 0.9 + rng() * 0.2);
    }
  });
  prop('shrine', VC.x, VC.z, face(0, 1), 0.9); prop('greatTree', VC.x + 28, VC.z + 22, 0, 0.7);
  along(vloop, 34, 5.5, 0, 1, (x, z) => prop('toro', x, z, 0, 0.85));
  prop('torii', VC.x - 148, VC.z + 6, face(1, 0), 1.2);
}

function yukigami(): void {
  const s = island('snow'), SV = { x: LAKE.x + 20, z: LAKE.z + 330 };
  const loop: number[][] = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU, r = 85 + Math.sin(a * 3) * 14; loop.push([SV.x + Math.cos(a) * r, SV.z + Math.sin(a) * r]); }
  const vloop = stoneAt(loop, 6, 'snow', true);
  const rng = mulberry32(808);
  along(vloop, 30, 14, 0, 1, (x, z, nx, nz) => { if (land(x, z, 3) && slopeAt(x, z) < 0.3) prop('cabin' + Math.floor(rng() * 3), x, z, face(-nx, -nz), 1); });
  prop('pagodaIce', SV.x + 8, SV.z - 8, 0.3, 1.1);
  // switch-backing pilgrim trail up the great peak, ending at a summit shrine
  const P = { x: SNOW_PEAK0[0], z: SNOW_PEAK0[1] };
  const trail: number[][] = [[SV.x - 90, SV.z - 20], [LAKE.x - 230, LAKE.z + 220]];
  const bx = LAKE.x - 230, bz = LAKE.z + 220, dx = P.x - bx, dz = P.z - bz, L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
  const legs = 9, reach = L - 190;
  for (let i = 1; i <= legs; i++) {
    const t = i / legs, sway = (i % 2 ? 1 : -1) * (150 - t * 50);
    trail.push([bx + ux * reach * t - uz * sway, bz + uz * reach * t + ux * sway]);
  }
  const climb = stoneAt(trail, 5, 'snow');
  along(climb, 40, 4, 0.05, 0.98, (x, z) => prop('toro', x, z, 0, 0.9));
  const end = NET.at(climb, 1);
  prop('shrine', end.x + end.tx * 12, end.z + end.tz * 12, face(-end.tx, -end.tz), 1.2);
  prop('torii', end.x, end.z, face(end.tx, end.tz), 1.2);
  const g = { x: LAKE.x, z: LAKE.z + LAKE.r + 70 }; prop('toriiIce', g.x, g.z, 0, 1.7);
  void s;
}
const SNOW_PEAK0 = [-2260, 1700];

function islets(): void {
  const m = island('moon'), f = island('fox'), c = island('cairn'), a = island('arch'), r = island('reef');
  // Tsuki Rock: a lone hermit shrine on a curved stair from the south shore
  const mp = stoneAt([[m.cx + 10, m.cz + 140], [m.cx - 50, m.cz + 80], [m.cx + 40, m.cz + 30], [m.cx, m.cz - 5]], 4, 'moon', false, true);
  prop('shrine', m.cx, m.cz - 22, face(0, 1), 1); prop('torii', m.cx + 10, m.cz + 120, 0, 1.1);
  along(mp, 24, 4, 0.1, 1, (x, z) => prop('toro', x, z, 0, 0.8));
  // Kitsune Isle: a tunnel of small torii leading to the fox shrine
  const fp = stoneAt([[f.cx - 10, f.cz + 160], [f.cx + 55, f.cz + 100], [f.cx - 40, f.cz + 40], [f.cx + 10, f.cz - 20]], 4, 'fox');
  for (let i = 0; i < 14; i++) { const q = NET.at(fp, 0.06 + (i / 13) * 0.85); prop('torii', q.x, q.z, face(q.tx, q.tz), 0.5); }
  prop('shrine', f.cx + 10, f.cz - 45, face(0, 1), 1); prop('komainu', f.cx - 8, f.cz - 12, face(0, 1), 0.9); prop('komainu', f.cx + 28, f.cz - 12, face(0, 1), 0.9);
  // Cairn Isle: pagoda on the hill
  const cp = stoneAt([[c.cx - 20, c.cz + 170], [c.cx + 60, c.cz + 100], [c.cx - 30, c.cz + 40], [c.cx, c.cz]], 5, 'cairn', false, true);
  prop('pagoda', c.cx, c.cz - 20, 0.5, 1);
  along(cp, 28, 5, 0.1, 1, (x, z) => prop('toro', x, z, 0, 0.9));
  // Arch Rocks: three natural arches; Crystal Reef: crystals handled by the world
  prop('arch', a.cx - 50, a.cz, 0.3, 1.2); prop('arch', a.cx + 55, a.cz + 25, 1.7, 1.0); prop('arch', a.cx + 5, a.cz - 60, 2.6, 0.9);
  void r;
}


// ---------------------------------------------------------------------------------------------------------------------
// Sky roads (elevated, for flying traffic): a loop around downtown, ramps that descend to street level, a cross-town
// flyover, and a long bridge to the airport. Pylons hold the decks up.
// ---------------------------------------------------------------------------------------------------------------------
export const skyPaths: Path[] = [];
function skyRoads(): void {
  const C = CITY_C;
  const ringPts: number[][] = [];
  for (let i = 0; i < 28; i++) { const a = (i / 28) * TAU, r = 560 + 12 * Math.sin(a * 3); ringPts.push([C.x + Math.cos(a) * r, C.z + Math.sin(a) * r, 95 + 10 * Math.sin(a * 2)]); }
  skyPaths.push(NET.add('sky', 18, ringPts, 'city', true));
  // three ramps: from the loop, out over the suburbs, and down onto the end of an avenue
  for (const k of [1, 4, 7]) {
    const pts: number[][] = [];
    for (const [r, y] of [[560, 95], [640, 87], [715, 66], [785, 36], [838, 4.6]]) { const a = radA(k, r); pts.push([C.x + Math.cos(a) * r, C.z + Math.sin(a) * r, y]); }
    skyPaths.push(NET.add('sky', 18, pts, 'city'));
  }
  // cross-town flyover passing beside the spire
  skyPaths.push(NET.add('sky', 18, [[C.x - 560, C.z - 60, 95], [C.x - 300, C.z - 170, 118], [C.x, C.z - 200, 130], [C.x + 300, C.z - 170, 118], [C.x + 560, C.z - 60, 95]], 'city'));
  // airport bridge: from the loop, across the sea, down onto the taxiway
  const ax = AIRPORT.cx, az = AIRPORT.cz;
  skyPaths.push(NET.add('sky', 18, [[C.x + 459, C.z + 321, 95], [C.x + 680, C.z + 420, 90], [C.x + 900, C.z + 560, 80], [C.x + 1050, C.z + 690, 66], [C.x + 1130, C.z + 800, 46], [C.x + 1170, C.z + 890, 22], [ax - 505, az - 56, 6.5], [ax - 500, az - 50, 5.7]], 'city'));
  for (const p of skyPaths) {
    for (let i = 4; i < p.n - 3; i += 11) {
      const y = p.ys![i];
      if (y < 12) continue;
      const g = Math.max(heightAt(p.x[i], p.z[i]), -8);
      prop('pylon', p.x[i], p.z[i], 0, 1, y - 1.7 - g);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Haneda Airport island: runway, taxiways, terminal, control tower, hangars, parked airliners
// ---------------------------------------------------------------------------------------------------------------------
function airport(): void {
  const cx = AIRPORT.cx, cz = AIRPORT.cz;
  NET.add('runway', 46, [[cx - 560, cz + 45], [cx, cz + 45], [cx + 560, cz + 45]], 'airport');
  NET.add('runway', 18, [[cx - 520, cz - 50], [cx - 150, cz - 50], [cx + 250, cz - 50], [cx + 520, cz - 50]], 'airport');
  for (const x of [-400, -90, 230]) NET.add('runway', 18, [[cx + x, cz - 50], [cx + x + 24, cz - 2], [cx + x + 10, cz + 36]], 'airport');
  prop('terminal', cx - 110, cz - 168, 0, 1);
  prop('airTower', cx + 160, cz - 150, 0, 1);
  for (let i = 0; i < 3; i++) prop('hangar', cx - 440 + i * 86, cz - 160, 0, 1);
  prop('plane0', cx - 160, cz - 84, Math.PI, 1); prop('plane1', cx - 70, cz - 84, Math.PI, 1); prop('plane2', cx + 25, cz - 84, Math.PI, 1); prop('plane0', cx + 110, cz - 84, Math.PI, 1);
  prop('plane1', cx - 420, cz + 45, Math.PI / 2, 1);
}

let built = false;
export function buildLayout(): void {
  if (built) return; built = true;
  buildCityRoads();
  skyRoads();
  airport();
  buildCityLots();
  cityFurniture();
  godIsland(); sakuraValley(); yukigami(); islets();
  // volcano: torii processional climbing the south face toward the crater, and a forge shrine at its foot
  for (let i = 0; i < 8; i++) {
    const t = i / 7, x = VOLCANO.x + Math.sin(t * 3) * 30 + 40 * (1 - t), z = VOLCANO.z + 560 - t * 330;
    prop('torii', x, z, face(0.05, -1), 2.3 - t * 0.9);
  }
  prop('shrine', VOLCANO.x + 80, VOLCANO.z + 600, face(0, -1), 1.4);
  void CHUNK;
}
