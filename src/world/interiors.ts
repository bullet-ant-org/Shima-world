/**
 * Enterable interiors.
 *
 * Every city shop (auto shop, elixirs, liquor bar, ramen counter, konbini), club and village house has a door. Walk up to
 * it and ENTER: the screen fades and you are standing inside a furnished room with people going about their business
 * (shopkeepers behind counters, diners on stools, a DJ and a dance crowd, a family at the kotatsu). Walk back to the door
 * (or press EXIT) and you step out where you came in.
 *
 * Rooms are built on demand, high above their own door (so the streamed world, NPCs and traffic around the door stay
 * loaded), axis-aligned, closed on all sides, with their own warm light.
 */
import * as THREE from 'three/webgpu';
import { MB, hex } from '../rendering/geo';

type V3 = [number, number, number];
import type { Assets } from '../rendering/assets';
import { BUILDINGS, PROPS } from './layout';
import { heightAt } from './terrain';
import { Act, type Townsfolk } from '../entities/npcs';
import type { Room } from '../entities/entities';

export type RoomKind = 'auto' | 'elixir' | 'liquor' | 'ramen' | 'konbini' | 'house' | 'club';
export const ROOM_NAMES: Record<RoomKind, string> = { auto: 'Auto Shop', elixir: 'Elixirs', liquor: 'Liquor Bar', ramen: 'Ramen', konbini: 'Konbini', house: 'House', club: 'Club' };
const SHOP_KINDS: RoomKind[] = ['auto', 'elixir', 'liquor', 'ramen', 'konbini'];
export interface Door { x: number; z: number; ry: number; kind: RoomKind; seed: number }

const ROOM_Y = 2600;      // rooms float this high above their door (far above the flight ceiling)
const GRID = 32;

const shade = (c: V3, k: number): V3 => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

/** furnished room contents in room-local metres (floor at y = 0, door in the +z wall at x = 0) */
interface Plan { w: number; d: number; h: number; lit: MB; glow: MB; solids: number[][]; people: [number, number, number, Act, number, number][]; light: number }

function shell(w: number, d: number, h: number, floor: V3, wall: V3, ceil: V3, lit: MB, glow: MB, door: V3): void {
  lit.box(0, -0.1, 0, w + 0.4, 0.2, d + 0.4, floor);
  lit.box(0, h + 0.1, 0, w + 0.4, 0.2, d + 0.4, ceil);
  lit.box(-w / 2 - 0.1, h / 2, 0, 0.2, h, d + 0.4, wall); lit.box(w / 2 + 0.1, h / 2, 0, 0.2, h, d + 0.4, wall);
  lit.box(0, h / 2, -d / 2 - 0.1, w + 0.4, h, 0.2, wall); lit.box(0, h / 2, d / 2 + 0.1, w + 0.4, h, 0.2, wall);
  lit.box(0, 0.06, 0, w, 0.02, d, shade(floor, 0.92), 4);                     // floor finish
  for (const sx of [-1, 1]) lit.box(sx * w / 2 - sx * 0.01, 0.06, 0, 0.02, 0.12, d, shade(wall, 0.7)); // skirting
  lit.box(0, 0.06, -d / 2 + 0.01, w, 0.12, 0.02, shade(wall, 0.7));
  // the door you came in through: frame, glass, push bar, a glowing EXIT plate above it
  lit.box(0, 1.1, d / 2 - 0.02, 1.7, 2.3, 0.06, shade(door, 0.6));
  glow.box(0, 1.1, d / 2 - 0.06, 1.4, 2.1, 0.02, hex(0xcfe6ff), 1);
  lit.box(0, 1.05, d / 2 - 0.1, 1.2, 0.06, 0.06, hex(0xc0c4cc));
  glow.box(0, 2.55, d / 2 - 0.06, 0.6, 0.2, 0.02, hex(0x3aff8a), 1);
  // ceiling light panels
  for (let x = -w / 2 + 2; x <= w / 2 - 2; x += 3.2) for (let z = -d / 2 + 2; z <= d / 2 - 2; z += 3.2) glow.box(x, h - 0.02, z, 1.2, 0.04, 0.5, hex(0xfff6e4), 2);
}

const rand = (seed: number) => () => { seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return seed / 4294967296; };

function shelfRow(lit: MB, glow: MB, r: () => number, x: number, z: number, len: number, along: 'x' | 'z', h: number, colors: number[], glowing = false, back: V3 = hex(0x5a4030)): void {
  const w = along === 'x' ? len : 0.5, d = along === 'x' ? 0.5 : len;
  lit.box(x, h / 2, z, w, h, d, back);
  const n = Math.floor(len / 0.28);
  for (let row = 0; row < 4; row++) {
    const y = 0.35 + row * (h - 0.4) / 4;
    lit.box(x, y - 0.05, z, w + 0.04, 0.04, d + 0.04, shade(back, 1.3));
    for (let i = 0; i < n; i++) {
      const t = -len / 2 + 0.14 + i * 0.28, c = hex(colors[Math.floor(r() * colors.length)]), bh = 0.18 + r() * 0.16;
      const px = along === 'x' ? x + t : x, pz = along === 'x' ? z : z + t;
      for (const side of [-1, 1]) {
        const ox = along === 'x' ? 0 : side * 0.17, oz = along === 'x' ? side * 0.17 : 0;
        (glowing ? glow : lit).box(px + ox, y + bh / 2, pz + oz, 0.16, bh, 0.16, c);
      }
    }
  }
}

function plan(kind: RoomKind, seed: number): Plan {
  const r = rand(seed * 7919 + 13), lit = new MB(), glow = new MB(), solids: number[][] = [], people: Plan['people'] = [];
  const solid = (x: number, z: number, w: number, d: number) => solids.push([x - w / 2, z - d / 2, x + w / 2, z + d / 2]);
  const person = (x: number, z: number, yaw: number, act: Act, v = -1, lift = 0) => people.push([x, z, yaw, act, v, lift]);
  let w = 12, d = 10, h = 4, light = 0xffe2b8;
  switch (kind) {
    case 'konbini': {
      w = 14; d = 11; light = 0xf4f8ff;
      shell(w, d, h, hex(0xe8ecef), hex(0xf6f7f8), hex(0xffffff), lit, glow, hex(0x3a8a5a));
      lit.box(0, 3.4, -d / 2 + 0.05, w, 0.5, 0.08, hex(0x2fae6a)); lit.box(0, 3.05, -d / 2 + 0.05, w, 0.2, 0.08, hex(0x2a6ad8));   // brand stripes
      for (let x = -w / 2 + 1.2; x < w / 2 - 1; x += 1.25) {                                                      // drinks fridges
        lit.box(x, 1.1, -d / 2 + 0.45, 1.15, 2.2, 0.8, hex(0xd8dde4));
        glow.box(x, 1.15, -d / 2 + 0.86, 1.0, 1.9, 0.02, hex(0xeaf6ff), 1);
        for (let row = 0; row < 5; row++) for (let k = 0; k < 4; k++) lit.box(x - 0.36 + k * 0.24, 0.45 + row * 0.36, -d / 2 + 0.8, 0.12, 0.22, 0.08, hex([0xe83a3a, 0x2a6ad8, 0xf4d23a, 0x3aaa5a, 0xffffff][(row + k) % 5]));
      }
      solid(0, -d / 2 + 0.45, w, 0.9);
      for (const z of [-1.4, 1.0]) for (const x of [-3.2, 1.4]) { shelfRow(lit, glow, r, x, z, 3.4, 'x', 1.6, [0xffffff, 0xf4d23a, 0x2a6ad8, 0xe83a3a, 0xf28a2a, 0x8a4ad8]); solid(x, z, 3.4, 0.6); }
      lit.box(w / 2 - 1.6, 0.55, 3.2, 2.6, 1.1, 0.8, hex(0xe8e4dc)); lit.box(w / 2 - 1.6, 1.12, 3.2, 2.7, 0.06, 0.9, hex(0x3a3a44));   // counter
      lit.box(w / 2 - 1.2, 1.35, 3.2, 0.4, 0.4, 0.35, hex(0x2a2c34)); glow.box(w / 2 - 1.2, 1.4, 3.02, 0.32, 0.22, 0.02, hex(0x45ecff), 1); // register
      glow.box(w / 2 - 2.4, 1.3, 3.2, 0.5, 0.3, 0.5, hex(0xffb25a), 1);                                          // hot snacks case
      solid(w / 2 - 1.6, 3.2, 2.7, 0.9);
      person(w / 2 - 1.6, 2.3, 0, Act.Vend);
      person(-1, -0.2, Math.PI / 2, Act.Browse); person(2.6, 2.3, Math.PI, Act.Browse);
      break;
    }
    case 'ramen': {
      w = 12; d = 9; light = 0xffc890;
      shell(w, d, h, hex(0x8a6a4a), hex(0xd8c8a8), hex(0x5a4030), lit, glow, hex(0x6b4630));
      for (let x = -w / 2 + 0.6; x < w / 2; x += 1.2) lit.box(x, h / 2, -d / 2 + 0.05, 0.12, h, 0.1, hex(0x5a3a22));       // wood battens
      lit.box(0, 1.0, -0.6, 8.4, 0.08, 1.0, hex(0xb08a5a)); lit.box(0, 0.5, -0.15, 8.2, 1.0, 0.1, hex(0x5a3a22));          // counter
      solid(0, -0.6, 8.4, 1.1);
      for (let i = 0; i < 6; i++) {                                                                                // stools
        const x = -3.5 + i * 1.4; lit.cyl(x, 0.6, 0.22, 0.2, 0.55, 0.65, 10, hex(0xc8283c)); lit.cyl(x, 0.6, 0.05, 0.05, 0, 0.55, 6, hex(0x3a3a44));
        if (i % 2 === 0 || r() < 0.3) { person(x, 0.58, Math.PI, Act.Sit, -1, 0.05); lit.cyl(x, -0.45, 0.17, 0.12, 1.04, 1.16, 10, hex(0xf2e6d8)); glow.cyl(x, -0.45, 0.14, 0.14, 1.16, 1.17, 10, hex(0xf0b060)); }
      }
      for (let i = 0; i < 3; i++) { lit.cyl(-2.4 + i * 2.2, -3.3, 0.38, 0.36, 0.95, 1.6, 12, hex(0x9aa0aa)); glow.cyl(-2.4 + i * 2.2, -3.3, 0.33, 0.33, 1.6, 1.61, 12, hex(0xf0c890)); }
      lit.box(0, 0.47, -3.3, w - 1, 0.95, 1.1, hex(0x8a8e96)); solid(0, -3.3, w - 1, 1.2);                       // stove line
      for (let i = 0; i < 6; i++) glow.box(-w / 2 + 1.2 + i * 1.9, 3.2, -d / 2 + 0.3, 0.5, 0.7, 0.5, hex(0xff8a4a), 1);        // lanterns
      for (let k = 0; k < 6; k++) lit.box(-w * 0.22 + k * 0.6, 3.3, -1.2, 0.5, 1.0, 0.03, k % 2 ? hex(0x2a2a40) : hex(0x3a3a58), 1); // noren
      person(-1.2, -2.0, 0, Act.Vend, 0); person(2.4, -2.1, 0.3, Act.Vend);
      break;
    }
    case 'elixir': {
      w = 11; d = 9; light = 0xd0a0ff;
      shell(w, d, h, hex(0x3a2a4a), hex(0x5a3a6a), hex(0x2a1e3a), lit, glow, hex(0x5a3a6a));
      for (const x of [-w / 2 + 0.3, w / 2 - 0.3]) { shelfRow(lit, glow, r, x, -0.5, d - 2.5, 'z', 3.2, [0x8aff6a, 0xff6ad0, 0x45ecff, 0xffd84a, 0xb08aff], true, hex(0x3a2418)); solid(x, -0.5, 0.6, d - 2.5); }
      shelfRow(lit, glow, r, 0, -d / 2 + 0.3, w - 2, 'x', 3.2, [0x8aff6a, 0xff6ad0, 0x45ecff, 0xffd84a, 0xb08aff], true, hex(0x3a2418)); solid(0, -d / 2 + 0.3, w - 2, 0.6);
      lit.cyl(0, 0.3, 0.75, 0.9, 0, 0.95, 14, hex(0x2a2a30)); glow.cyl(0, 0.3, 0.68, 0.68, 0.95, 0.97, 14, hex(0x8aff6a)); solid(0, 0.3, 1.8, 1.8);
      for (let i = 0; i < 5; i++) glow.box(-0.3 + r() * 0.6, 1.2 + i * 0.25, 0.3 + r() * 0.4 - 0.2, 0.08, 0.08, 0.08, hex(0xb8ffa0));      // rising bubbles
      lit.box(0, 0.5, -2.4, 4, 1.0, 0.8, hex(0x4a2e1e)); lit.box(0, 1.03, -2.4, 4.1, 0.06, 0.9, hex(0x6a4a2e)); solid(0, -2.4, 4.1, 0.9);
      person(0, -3.2, 0, Act.Vend, 1); person(2.4, 1.6, -2.3, Act.Browse);
      break;
    }
    case 'liquor': {
      w = 12; d = 9; light = 0xffa070;
      shell(w, d, h, hex(0x3a2a24), hex(0x4a3028), hex(0x1e1614), lit, glow, hex(0x3a2a24));
      for (let row = 0; row < 3; row++) {                                                                          // backlit bottle wall
        glow.box(0, 1.4 + row * 0.7, -d / 2 + 0.05, w - 2, 0.04, 0.3, hex(0xffb070), 2);
        for (let i = 0; i < 26; i++) lit.box(-w / 2 + 1.3 + i * 0.37, 1.6 + row * 0.7, -d / 2 + 0.2, 0.12, 0.34, 0.12, hex([0x8a4a1a, 0x2a6a2a, 0xd8b04a, 0x6a1a2a, 0xe8e0c0, 0x3a5aa8][Math.floor(r() * 6)]));
      }
      lit.box(0, 0.55, -2.3, 9, 1.1, 0.8, hex(0x2a1a14)); lit.box(0, 1.13, -2.3, 9.2, 0.08, 1.0, hex(0x8a5a2a)); solid(0, -2.3, 9.2, 1.0);
      glow.box(0, 0.2, -1.88, 9, 0.04, 0.02, hex(0xff3d6e), 1);
      for (let i = 0; i < 6; i++) {
        const x = -3.6 + i * 1.45; lit.cyl(x, -1.3, 0.22, 0.2, 0.72, 0.8, 10, hex(0x8a2a2a)); lit.cyl(x, -1.3, 0.05, 0.05, 0, 0.72, 6, hex(0xc0a060));
        if (r() < 0.55) person(x, -1.32, Math.PI, Act.Sit, -1, 0.2);
      }
      for (const [x, z] of [[-3.5, 2.3], [3.5, 2.3]]) { lit.cyl(x, z, 0.6, 0.6, 0.95, 1.0, 12, hex(0x6a3a22)); lit.cyl(x, z, 0.08, 0.08, 0, 0.95, 6, hex(0x2a2a30)); solid(x, z, 1.3, 1.3); }
      person(-3.5, 1.4, 0, Act.Talk); person(-3.5, 3.2, Math.PI, Act.Talk);
      person(0.6, -3.2, 0, Act.Vend);
      break;
    }
    case 'auto': {
      w = 16; d = 12; h = 5; light = 0xfff2d0;
      shell(w, d, h, hex(0x8a8e94), hex(0xb8bcc4), hex(0x6a6e76), lit, glow, hex(0x3a3e48));
      for (let x = -w / 2 + 1; x < w / 2; x += 2) lit.box(x, 0.065, 0, 0.06, 0.01, d - 1, hex(0xe8c040), 4);    // bay lines
      // lift with a car on it
      lit.box(-2.5, 0.9, -1, 0.3, 1.8, 0.3, hex(0xd8b04a)); lit.box(-2.5, 1.85, -1, 4.6, 0.15, 2.2, hex(0xd8b04a));
      lit.box(-2.5, 2.45, -1, 4.4, 0.9, 1.9, hex(0x2a6ad8)); lit.box(-2.7, 3.15, -1, 2.4, 0.6, 1.7, hex(0x2c4a63));
      for (const [x, z] of [[-1.1, -0.1], [-3.9, -0.1], [-1.1, -1.9], [-3.9, -1.9]]) lit.cyl(x, z, 0.38, 0.38, 1.8, 2.2, 10, hex(0x1c1c20));
      solid(-2.5, -1, 4.8, 2.4);
      // tool wall, workbench, tyre stacks, oil drums
      lit.box(0, 2.2, -d / 2 + 0.06, w - 2, 1.8, 0.06, hex(0x3a3e48));
      for (let i = 0; i < 18; i++) lit.box(-w / 2 + 2 + i * 0.7, 1.8 + (i % 3) * 0.45, -d / 2 + 0.12, 0.08, 0.35, 0.05, hex([0xc8283c, 0xd8b04a, 0xb8bcc4][i % 3]));
      lit.box(3, 0.5, -d / 2 + 0.6, 5, 1.0, 1.0, hex(0x5a4030)); solid(3, -d / 2 + 0.6, 5, 1.0);
      for (let k = 0; k < 6; k++) lit.cyl(w / 2 - 1.2, -2 + (k % 2) * 1.1, 0.42, 0.42, Math.floor(k / 2) * 0.32, Math.floor(k / 2) * 0.32 + 0.3, 12, hex(0x1c1c20));
      solid(w / 2 - 1.2, -1.45, 1.0, 2.2);
      for (let k = 0; k < 3; k++) lit.cyl(-w / 2 + 1, 2 + k * 0.8, 0.32, 0.32, 0, 0.9, 10, [hex(0x2a6ad8), hex(0xc8283c), hex(0x2f9a5a)][k]);
      solid(-w / 2 + 1, 2.8, 0.8, 2.4);
      person(-2.5, 0.6, Math.PI, Act.Hoe, 0); person(3, -d / 2 + 1.5, 0, Act.Vend, 0); person(2.5, 2.5, -2.4, Act.Stand);
      break;
    }
    case 'club': {
      w = 18; d = 14; h = 5; light = 0xb060ff;
      shell(w, d, h, hex(0x1a1822), hex(0x22202c), hex(0x121018), lit, glow, hex(0x2a2838));
      const neon = [0xff3d6e, 0x45ecff, 0xb46bff, 0x25e6a0];
      for (let x = -3; x <= 3; x++) for (let z = -3; z <= 2; z++) glow.box(x * 1.2, 0.09, z * 1.2 - 0.5, 1.1, 0.02, 1.1, shade(hex(neon[(x + z + 8) % 4]), 0.55), 2); // dance floor
      for (let i = 0; i < 4; i++) { glow.box(-w / 2 + 0.05, 1 + i * 1, 0, 0.02, 0.08, d - 1, hex(neon[i]), 1); glow.box(w / 2 - 0.05, 1 + i * 1, 0, 0.02, 0.08, d - 1, hex(neon[3 - i]), 1); }
      lit.box(0, 0.6, -d / 2 + 1.2, 4, 1.2, 1.2, hex(0x2a2838)); glow.box(0, 1.0, -d / 2 + 1.82, 3.6, 0.3, 0.02, hex(0x45ecff), 1); solid(0, -d / 2 + 1.2, 4, 1.2); // DJ booth
      lit.box(0, 0.3, -d / 2 + 0.6, 6, 0.6, 1.2, hex(0x2a2838));
      for (const sx of [-1, 1]) { lit.box(sx * 3.2, 1.2, -d / 2 + 0.7, 1.0, 2.4, 0.9, hex(0x101014)); lit.cyl(sx * 3.2, -d / 2 + 1.16, 0.32, 0.32, 1.4, 1.42, 12, hex(0x3a3a44)); solid(sx * 3.2, -d / 2 + 0.7, 1.0, 0.9); }
      lit.box(w / 2 - 1.2, 0.55, 2, 1.2, 1.1, 6, hex(0x2a1a2a)); glow.box(w / 2 - 1.85, 0.9, 2, 0.02, 0.06, 6, hex(0xff3d6e), 1); solid(w / 2 - 1.2, 2, 1.2, 6); // bar
      person(0, -d / 2 + 0.4, 0, Act.Vend, 0);
      for (let i = 0; i < 9; i++) person(-3 + r() * 6, -3 + r() * 5, r() * 6.28, Act.Dance);
      person(w / 2 - 0.5, 1, -Math.PI / 2, Act.Vend); person(w / 2 - 2.4, 3, Math.PI / 2, Act.Talk);
      break;
    }
    case 'house': {
      w = 10; d = 8; h = 3.2; light = 0xffd8a0;
      shell(w, d, h, hex(0xc8c08a), hex(0xf4efe2), hex(0x8a6a4a), lit, glow, hex(0x6b4630));
      for (let x = -w / 2 + 1; x < w / 2; x += 2) lit.box(x, 0.065, 0, 0.04, 0.01, d, hex(0x6a5a3a), 4);          // tatami seams
      for (let z = -d / 2 + 2; z < d / 2; z += 2) lit.box(0, 0.065, z, w, 0.01, 0.04, hex(0x6a5a3a), 4);
      for (const sx of [-1, 1]) for (let z = -d / 2 + 0.5; z < d / 2; z += 1) lit.box(sx * (w / 2 - 0.03), h / 2, z, 0.04, h, 0.06, hex(0x6b4630)); // shoji frames
      for (let x = -w / 2 + 0.5; x < w / 2; x += 1) lit.box(x, h / 2, -d / 2 + 0.03, 0.06, h, 0.04, hex(0x6b4630));
      lit.box(0, 2.2, 0, w, 0.06, 0.06, hex(0x6b4630));
      // kotatsu with a quilt, floor cushions, tokonoma alcove with a scroll and ikebana
      lit.box(0, 0.25, -0.3, 1.9, 0.12, 1.9, hex(0xd85a4a)); lit.box(0, 0.4, -0.3, 1.3, 0.06, 1.3, hex(0x8a5a3a));
      lit.cyl(0, -0.3, 0.12, 0.1, 0.43, 0.5, 8, hex(0xf2a02a)); solid(0, -0.3, 1.9, 1.9);
      lit.box(-w / 2 + 1.2, 0.15, -d / 2 + 0.6, 2.2, 0.3, 1.0, hex(0x6b4630)); lit.box(-w / 2 + 1.2, 1.6, -d / 2 + 0.08, 0.7, 1.5, 0.02, hex(0xf4efe2)); lit.box(-w / 2 + 1.2, 1.6, -d / 2 + 0.1, 0.5, 1.2, 0.02, hex(0x3a3a58));
      lit.cyl(-w / 2 + 1.5, -d / 2 + 0.6, 0.1, 0.12, 0.3, 0.6, 8, hex(0x2a4a8a)); lit.cyl(-w / 2 + 1.5, -d / 2 + 0.6, 0.18, 0.04, 0.6, 0.95, 6, hex(0xff9ec8)); solid(-w / 2 + 1.2, -d / 2 + 0.6, 2.2, 1.0);
      lit.box(w / 2 - 1, 0.6, -d / 2 + 0.5, 1.6, 1.2, 0.7, hex(0x8a5a3a)); solid(w / 2 - 1, -d / 2 + 0.5, 1.6, 0.7);   // tansu chest
      glow.cyl(w / 2 - 1, d / 2 - 1.2, 0.25, 0.2, 0.2, 0.9, 8, hex(0xffe0a0)); lit.cyl(w / 2 - 1, d / 2 - 1.2, 0.05, 0.05, 0, 0.2, 6, hex(0x3a2a1a)); // andon lamp
      person(0, -1.45, 0, Act.Sit, -1, -0.38); person(1.15, -0.3, -Math.PI / 2, Act.Sit, -1, -0.38);
      if (r() < 0.6) person(-2.6, 1.6, 2.2, Act.Stand);
      break;
    }
  }
  return { w, d, h, lit, glow, solids, people, light };
}

export class Interiors {
  doors: Door[] = [];
  private grid = new Map<string, number[]>();
  inside: { door: Door; group: THREE.Group; light: THREE.PointLight; room: Room } | null = null;

  // own materials: no distance fog (the room floats far above the fogged world) and no surface texture
  private mat: THREE.MeshToonNodeMaterial;
  private glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });

  constructor(private scene: THREE.Scene, assets: Assets) {
    this.mat = new THREE.MeshToonNodeMaterial({ vertexColors: true, gradientMap: assets.ramp, fog: false });
    const add = (d: Door) => { const k = Math.floor(d.x / GRID) + ',' + Math.floor(d.z / GRID); (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(this.doors.length); this.doors.push(d); };
    BUILDINGS.forEach((b, i) => {
      const t = b.spec.tpl;
      if (t !== 'shop' && t !== 'club') return;
      const off = t === 'shop' ? b.spec.d / 2 + 1.0 : b.hd + 1.2;
      add({ x: b.x + Math.sin(b.ry) * off, z: b.z + Math.cos(b.ry) * off, ry: b.ry, kind: t === 'club' ? 'club' : SHOP_KINDS[b.spec.pal % 5], seed: i + 1 });
    });
    let n = 0;
    for (const k of ['house0', 'house1', 'house2', 'cabin0', 'cabin1', 'cabin2']) for (const d of PROPS[k] ?? []) {
      const off = 4.1 * d.s + 0.9;
      add({ x: d.x + Math.sin(d.ry) * off, z: d.z + Math.cos(d.ry) * off, ry: d.ry, kind: 'house', seed: 5000 + n++ });
    }
  }

  /** the door within reach of (x, z), if any */
  near(x: number, z: number, r = 2.4): Door | null {
    const cx = Math.floor(x / GRID), cz = Math.floor(z / GRID);
    let best: Door | null = null, bd = r;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const di of this.grid.get(cx + i + ',' + (cz + j)) ?? []) {
      const d = this.doors[di], dd = Math.hypot(d.x - x, d.z - z);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  }

  /** build the room for this door and return where the player should stand */
  enter(door: Door, folk: Townsfolk): { room: Room; x: number; y: number; z: number; yaw: number } {
    this.leave(folk);
    const P = plan(door.kind, door.seed), y0 = heightAt(door.x, door.z) + ROOM_Y;
    const g = new THREE.Group();
    g.position.set(door.x, y0, door.z);
    const lit = new THREE.Mesh(P.lit.toGeometry(), this.mat); lit.receiveShadow = true; lit.castShadow = true;   // the ceiling keeps the sun out
    g.add(lit);
    if (!P.glow.empty) g.add(new THREE.Mesh(P.glow.toGeometry(), this.glowMat));
    const light = new THREE.PointLight(P.light, 14, Math.max(P.w, P.d) * 1.8, 1);
    light.position.set(door.x, y0 + P.h - 0.6, door.z);
    this.scene.add(g, light);
    g.updateMatrixWorld(true); light.updateMatrixWorld(true);       // the scene doesn't auto-update world matrices
    for (const [x, z, yaw, act, v, lift] of P.people) folk.pin(door.x + x, y0, door.z + z, yaw, act, v, lift);
    const room: Room = { cx: door.x, cz: door.z, y: y0, hw: P.w / 2, hd: P.d / 2, h: P.h, solids: P.solids };
    this.inside = { door, group: g, light, room };
    return { room, x: door.x, y: y0, z: door.z + P.d / 2 - 1.3, yaw: Math.PI };
  }

  leave(folk: Townsfolk): Door | null {
    const s = this.inside; if (!s) return null;
    this.scene.remove(s.group, s.light);
    s.group.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
    s.light.dispose();
    folk.unpinAll();
    this.inside = null;
    return s.door;
  }

  /** standing by the inside of the door you came in through */
  atExit(x: number, z: number): boolean {
    const s = this.inside; if (!s) return false;
    return Math.abs(x - s.room.cx) < 1.1 && z - s.room.cz > s.room.hd - 0.9;
  }
}
