/**
 * Procedural painted textures (generated once at startup, no downloads).
 *
 *  - SURFACE atlas  (RGBA = 4 tileable patterns):  R plaster/stucco, G wood planks + grain, B curved roof tiles, A stone masonry
 *  - TERRAIN atlas  (RGBA = 4 tileable patterns):  R painterly grass/soil, G sand / gravel / ash, B layered rock with cracks, A soft snow
 *  - WATER ripple map
 *
 * They are applied in world space (box-projected from the dominant normal axis, two scales blended to hide tiling), multiplied onto the
 * existing vertex colours, so a single material can paint plaster walls, timber, tiles and stone depending on a per-vertex `kind`.
 * Pattern channel weights are triangular in `kind`, so neighbouring kinds blend smoothly across terrain triangles.
 */
import * as THREE from 'three/webgpu';
import { abs, attribute, dot, float, max, mix, normalWorld, positionWorld, step, texture, time, vec2, vec3, vec4 } from 'three/tsl';

const S = 512; // texels per pattern tile

// ---- tileable value noise -------------------------------------------------------------------------------------------------------------
function rnd(i: number, j: number, s: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vn(x: number, y: number, px: number, py: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % px) + px) % px, x1 = (((xi + 1) % px) + px) % px, y0 = ((yi % py) + py) % py, y1 = (((yi + 1) % py) + py) % py;
  const a = rnd(x0, y0, s), b = rnd(x1, y0, s), c = rnd(x0, y1, s), d = rnd(x1, y1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(u: number, v: number, cells: number, oct: number, s: number): number {
  let a = 0, amp = 0.5, f = cells, tot = 0;
  for (let o = 0; o < oct; o++) { a += amp * vn(u * f, v * f, f, f, s + o * 7); tot += amp; amp *= 0.5; f *= 2; }
  return a / tot;
}
const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const sm = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

type Pat = (u: number, v: number, px: number) => number;

// ---- surface patterns -----------------------------------------------------------------------------------------------------------------
const stucco: Pat = (u, v, px) => {
  const blotch = (fbm(u, v, 5, 4, 11) - 0.5) * 0.24, drips = (vn(u * 28, v * 3, 28, 3, 13) - 0.5) * 0.1, grain = (rnd(px & 1023, (px >> 10) & 1023, 5) - 0.5) * 0.07;
  const fleck = rnd(px & 1023, (px >> 10) & 1023, 9) > 0.995 ? -0.18 : 0;
  return clamp(0.86 + blotch + drips + grain + fleck, 0.5, 1);
};
const wood: Pat = (u, v) => {
  const planks = 4, pu = u * planks, id = Math.floor(pu), lu = pu - id;
  const tone = 0.8 + rnd(id, 3, 21) * 0.16, warp = fbm(u, v, 3, 3, 23) * 5;
  const grain = 0.5 + 0.5 * Math.sin((lu * 34 + warp + vn(u * 30, v * 2, 30, 2, 25) * 3) * Math.PI);
  const fibre = (vn(u * 90, v * 3, 90, 3, 27) - 0.5) * 0.14;
  const knot = Math.exp(-(((u * 8 % 1) - 0.5) ** 2 + ((v * 3 % 1) - 0.5) ** 2) * 60) * (rnd(id, Math.floor(v * 3), 29) > 0.7 ? 0.28 : 0);
  const seam = lu < 0.018 || lu > 0.985 ? 0.5 : 1;
  return clamp((tone * (0.74 + 0.26 * grain) + fibre - knot) * seam, 0.35, 1);
};
const tiles: Pat = (u, v) => {
  const rows = 8, rv = v * rows, r = Math.floor(rv), lv = rv - r;
  const cu = u * rows + 0.5 * (r & 1), ci = Math.floor(cu), lu = cu - ci;
  const curve = Math.sin(lu * Math.PI), scallop = 0.88 - 0.16 * (1 - curve);
  if (lv > scallop) return clamp(0.4 + (lv - scallop) * 0.2, 0.35, 0.55); // seam between courses
  const tone = 0.82 + rnd(ci, r, 31) * 0.18;
  const lit = 0.66 + 0.34 * curve - lv * 0.18;
  const edge = lu < 0.05 || lu > 0.95 ? 0.7 : 1;
  return clamp(tone * lit * edge + (fbm(u, v, 24, 2, 33) - 0.5) * 0.1, 0.3, 1);
};
const ROW_H = [0.16, 0.12, 0.2, 0.14, 0.18, 0.2];
const stone: Pat = (u, v) => {
  let acc = 0, row = 0, lv = 0;
  for (let i = 0; i < ROW_H.length; i++) { if (v < acc + ROW_H[i]) { row = i; lv = (v - acc) / ROW_H[i]; break; } acc += ROW_H[i]; }
  const n = 3 + Math.floor(rnd(row, 1, 35) * 3), cuts: number[] = [];
  for (let k = 0; k < n; k++) cuts.push((k + 0.2 + rnd(row, k, 37) * 0.6) / n);
  let bi = n - 1, lo = cuts[n - 1] - 1, hi = cuts[0];
  for (let k = 0; k < n; k++) if (u < cuts[k]) { bi = (k + n - 1) % n; lo = k === 0 ? cuts[n - 1] - 1 : cuts[k - 1]; hi = cuts[k]; break; }
  if (u >= cuts[n - 1]) { bi = n - 1; lo = cuts[n - 1]; hi = cuts[0] + 1; }
  const lu = (u - lo) / Math.max(1e-3, hi - lo);
  const mortar = Math.min(lu, 1 - lu) * (hi - lo) < 0.008 || Math.min(lv, 1 - lv) * ROW_H[row] < 0.007;
  if (mortar) return 0.42;
  const tone = 0.7 + rnd(row, bi, 39) * 0.26, chip = (fbm(u, v, 12, 3, 41) - 0.5) * 0.18;
  const bevel = Math.min(Math.min(lu, 1 - lu) * (hi - lo), Math.min(lv, 1 - lv) * ROW_H[row]) < 0.02 ? 0.92 : 1;
  return clamp(tone * bevel + chip, 0.4, 1);
};

// ---- terrain patterns -----------------------------------------------------------------------------------------------------------------
const grass: Pat = (u, v, px) => {
  const macro = (fbm(u, v, 4, 4, 51) - 0.5) * 0.34, blades = (vn(u * 96, v * 52, 96, 52, 53) - 0.5) * 0.15 + (vn(u * 58, v * 66, 58, 66, 54) - 0.5) * 0.09, tufts = (vn(u * 44, v * 44, 44, 44, 55) > 0.78 ? 0.1 : 0);
  const speck = (rnd(px & 1023, (px >> 10) & 1023, 57) - 0.5) * 0.08;
  return clamp(0.84 + macro + blades + tufts + speck, 0.5, 1);
};
const sand: Pat = (u, v, px) => {
  const ripple = Math.sin((v * 16 + 1.8 * fbm(u, v, 3, 3, 61)) * Math.PI * 2) * 0.05;
  const pebble = vn(u * 56, v * 56, 56, 56, 63) > 0.8 ? -0.14 : 0, grain = (rnd(px & 1023, (px >> 10) & 1023, 65) - 0.5) * 0.14;
  return clamp(0.86 + ripple + pebble + grain + (fbm(u, v, 5, 3, 67) - 0.5) * 0.12, 0.5, 1);
};
const rock: Pat = (u, v, px) => {
  const strata = 0.5 + 0.5 * Math.sin((v * 4 + 3.2 * fbm(u, v, 3, 4, 71)) * Math.PI * 2);
  const crack = 1 - sm(0, 0.045, Math.abs(fbm(u, v, 7, 3, 73) - 0.5));
  const chip = (fbm(u, v, 16, 3, 75) - 0.5) * 0.2, speck = (rnd(px & 1023, (px >> 10) & 1023, 77) - 0.5) * 0.08;
  return clamp(0.7 + 0.14 * strata + chip + speck - crack * 0.36, 0.28, 1);
};
const snow: Pat = (u, v, px) => {
  const drift = (fbm(u, v, 3, 3, 81) - 0.5) * 0.14, wave = Math.sin((u * 5 + fbm(u, v, 2, 3, 83) * 2) * Math.PI * 2) * 0.025;
  const sparkle = rnd(px & 1023, (px >> 10) & 1023, 85) > 0.994 ? 0.12 : 0;
  return clamp(0.93 + drift + wave + sparkle, 0.7, 1);
};

function atlas(r: Pat, g: Pat, b: Pat, a: Pat): THREE.DataTexture {
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, px = x | (y << 10), o = (y * S + x) * 4;
    data[o] = r(u, v, px) * 255; data[o + 1] = g(u, v, px) * 255; data[o + 2] = b(u, v, px) * 255; data[o + 3] = a(u, v, px) * 255;
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 16;
  t.needsUpdate = true;
  return t;
}

/** surface atlas: 0 plaster, 1 wood, 2 roof tile, 3 stone */
export const surfaceTexture = (): THREE.DataTexture => atlas(stucco, wood, tiles, stone);
/** terrain atlas: 0 grass, 1 sand/gravel/ash, 2 rock, 3 snow */
export const terrainTexture = (): THREE.DataTexture => atlas(grass, sand, rock, snow);

/** tileable water ripples (interfering sine waves + soft glints) */
export function waterTexture(): THREE.DataTexture {
  const W = 256, data = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / W, o = (y * W + x) * 4;
    const w = 0.5 + 0.25 * Math.sin((u * 6 + v * 2 + fbm(u, v, 3, 3, 91) * 2) * Math.PI * 2) + 0.25 * Math.sin((v * 7 - u * 3 + fbm(u, v, 4, 3, 93) * 2) * Math.PI * 2);
    const glint = Math.pow(clamp(fbm(u, v, 9, 3, 95) * 1.6 - 0.55), 3) * 1.2;
    data[o] = clamp(w) * 255; data[o + 1] = clamp(glint) * 255; data[o + 2] = 255; data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, W, W, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

/**
 * TSL node: detail multiplier (float) sampled from an atlas, box-projected in world space from the dominant normal axis,
 * two scales multiplied so the repeat never reads. `kind` selects/blends the atlas channel.
 */
export function detailNode(tex: THREE.Texture, s1: number, s2: number) {
  const n = abs(normalWorld);
  const useY = step(max(n.x, n.z), n.y);
  const useX = float(1).sub(useY).mul(step(n.z, n.x));
  const p = mix(mix(positionWorld.xy, positionWorld.zy, useX), positionWorld.xz, useY);
  const t1 = texture(tex, p.mul(s1)), t2 = texture(tex, p.mul(s2).add(vec2(0.37, 0.71)));
  const k = attribute('kind', 'float');
  const w = vec4(max(float(0), float(1).sub(abs(k))), max(float(0), float(1).sub(abs(k.sub(1)))), max(float(0), float(1).sub(abs(k.sub(2)))), max(float(0), float(1).sub(abs(k.sub(3)))));
  // contrast curve around mid-grey keeps the painted detail crisp instead of washed out
  const raw = dot(t1, w).mul(dot(t2, w)).mul(1.38);
  const d = raw.sub(1).mul(1.35).add(1).clamp(0.25, 1.3);
  return vec3(d, d, d);
}

/** animated water colour multiplier: two ripple layers drifting in different directions plus glints */
export function waterNode(tex: THREE.Texture) {
  const p = positionWorld.xz;
  const a = texture(tex, p.mul(0.013).add(vec2(time.mul(0.012), time.mul(0.007)))), b = texture(tex, p.mul(0.031).sub(vec2(time.mul(0.01), time.mul(-0.014))));
  const wave = a.x.mul(0.55).add(b.x.mul(0.45)), glint = a.y.mul(b.y).mul(2.2);
  return vec3(wave.mul(0.5).add(0.62).add(glint), wave.mul(0.45).add(0.68).add(glint), wave.mul(0.35).add(0.78).add(glint.mul(0.9)));
}
