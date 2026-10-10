/** World engine: chunk streaming with rings, per-ring detail, instanced props, curved path ribbons, city buildings with near/far LOD. */
import * as THREE from 'three/webgpu';
import { Assets } from '../rendering/assets';
import { InstancePools, type PoolEntry } from '../rendering/instancing';
import type { OutlineSpec } from '../rendering/outline';
import {
  benchGeo, barnGeo, fenceGeo, fieldGeo, haystackGeo, scarecrowGeo, stallGeo, buildingGeo, hasBuildingDetail, greatTreeGeo, hex, houseGeo, komainuGeo, lampGeo, pagodaGeo, sanmonGeo, shrineGeo, templeGeo, toriiGeo, toroGeo, trafficLightGeo,
  archGeo, terminalGeo, airTowerGeo, hangarGeo, planeGeo, type Pair,
} from '../rendering/geo';
import { BUILDINGS, NET, PROPS, buildLayout, buildingsNear, covered } from './layout';
import {
  CHUNK, GOD, HILL, ISLANDS, LAKE, RICE, SPIRE, VOLCANO, heightAt, island, islandAt, lavaAt, mulberry32, noise2, riverX, sstep, type IslandId,
} from './terrain';

/** Collects transforms (and optional colours) so one InstancedMesh can be created per batch. */
class Batch {
  t: number[] = [];
  c: number[] = [];
  n = 0;
  add(x: number, y: number, z: number, ry: number, sx: number, sy: number, sz: number, color?: THREE.Color): void {
    this.t.push(x, y, z, ry, sx, sy, sz);
    if (color) this.c.push(color.r, color.g, color.b);
    this.n++;
  }
  /** Streams this batch into the shared world pool instead of creating a mesh (and a draw call) per chunk. */
  commit(pools: InstancePools, geo: THREE.BufferGeometry, mat: THREE.Material, cast: boolean, out: PoolEntry[], ol: OutlineSpec | null = null): void {
    if (!this.n) return;
    const pool = pools.get(geo, mat, cast, ol), handles: number[] = [];
    const hasC = this.c.length > 0;
    for (let i = 0; i < this.n; i++) {
      const k = i * 7;
      handles.push(hasC
        ? pool.add(this.t[k], this.t[k + 1], this.t[k + 2], this.t[k + 3], this.t[k + 4], this.t[k + 5], this.t[k + 6], this.c[i * 3], this.c[i * 3 + 1], this.c[i * 3 + 2])
        : pool.add(this.t[k], this.t[k + 1], this.t[k + 2], this.t[k + 3], this.t[k + 4], this.t[k + 5], this.t[k + 6]));
    }
    pool.flush();
    out.push({ pool, handles });
  }

  build(geo: THREE.BufferGeometry, mat: THREE.Material, cast = false): THREE.InstancedMesh | null {
    if (!this.n) return null;
    const m = new THREE.InstancedMesh(geo, mat, this.n);
    const o = new THREE.Object3D();
    for (let i = 0; i < this.n; i++) {
      const k = i * 7;
      o.position.set(this.t[k], this.t[k + 1], this.t[k + 2]);
      o.rotation.set(0, this.t[k + 3], 0);
      o.scale.set(this.t[k + 4], this.t[k + 5], this.t[k + 6]);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    }
    if (this.c.length) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.c), 3);
    m.castShadow = cast;
    m.matrixAutoUpdate = false;
    return m;
  }
}

interface ChunkRec { cx: number; cz: number; ring: number; group: THREE.Group; inst: PoolEntry[]; border?: THREE.LineLoop; pending: boolean }

const NEON = [0xff3d9a, 0x25e6ff, 0xffb02e, 0x9a6bff].map((h) => new THREE.Color(h));
const TMP = new THREE.Color();
const VILLAGE_V = { x: island('valley').cx + 480, z: island('valley').cz + 50 };
const VILLAGE_S = { x: LAKE.x + 20, z: LAKE.z + 330 };

export class World {
  readonly group = new THREE.Group();
  private pools = new InstancePools(this.group);
  private resident: PoolEntry[] = []; // landmarks + placed props: permanent members of the shared pools
  private chunks = new Map<string, ChunkRec>();
  private empty = new Set<string>();
  private readonly ringSegs = [32, 16, 8];
  debugBorders = false;
  nearDetail = true; // set from the device profile
  private missed = 0;  // detailed building geometries skipped this chunk build (built in later frames to avoid hitches)
  outlines = true;
  private borderMats = [0x2cff8a, 0xffd23c, 0xff5a5a].map((c) => new THREE.LineBasicMaterial({ color: c }));
  private sea: THREE.Mesh;
  private pillars: THREE.LOD[] = [];
  stats = { loaded: 0, ring: [0, 0, 0], builtThisFrame: 0, pools: 0, instances: 0 };

  constructor(private assets: Assets, opts: { outlines: boolean; detail: boolean } = { outlines: false, detail: true }) {
    this.outlines = opts.outlines; this.nearDetail = opts.detail;
    const seaGeo = new THREE.PlaneGeometry(90000, 90000); seaGeo.rotateX(-Math.PI / 2);
    this.sea = new THREE.Mesh(seaGeo, assets.sea);
    this.sea.frustumCulled = false;
    this.group.add(this.sea);
    buildLayout();
    this.buildFarTerrain();
    this.buildSkyline();
    this.buildPillars();
    this.buildLandmarks();
    this.buildProps();
  }

  // ---- extreme distance: one coarse terrain mesh per island (sits 5 m under the streamed chunks) + the tall towers as silhouettes ----
  private buildFarTerrain(): void {
    const c = new THREE.Color();
    for (const isl of ISLANDS) {
      const n = isl.id === 'islet' ? 40 : 120, x0 = isl.cx - isl.rx * 1.08, z0 = isl.cz - isl.rz * 1.08, sx = (isl.rx * 2.16) / n, sz = (isl.rz * 2.16) / n;
      const pos = new Float32Array((n + 1) * (n + 1) * 3), col = new Float32Array((n + 1) * (n + 1) * 3), nor = new Float32Array((n + 1) * (n + 1) * 3), knd = new Float32Array((n + 1) * (n + 1));
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const x = x0 + i * sx, z = z0 + j * sz, y = heightAt(x, z), v = (j * (n + 1) + i) * 3;
        const gx = heightAt(x - sx, z) - heightAt(x + sx, z), gz = heightAt(x, z - sz) - heightAt(x, z + sz);
        const l = Math.hypot(gx, 2 * sx, gz);
        pos[v] = x; pos[v + 1] = y - 5; pos[v + 2] = z; nor[v] = gx / l; nor[v + 1] = (2 * sx) / l; nor[v + 2] = gz / l;
        this.terrainColor(x, z, y, Math.hypot(gx, gz) / (2 * sx), c);
        col[v] = c.r; col[v + 1] = c.g; col[v + 2] = c.b; knd[j * (n + 1) + i] = this.terrainKind(x, z, y, Math.hypot(gx, gz) / (2 * sx));
      }
      const idx: number[] = [];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, d = a + n + 1, e = d + 1;
        if (pos[a * 3 + 1] < -12 && pos[e * 3 + 1] < -12 && pos[b * 3 + 1] < -12 && pos[d * 3 + 1] < -12) continue; // open sea
        idx.push(a, d, b, b, d, e);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('kind', new THREE.BufferAttribute(knd, 1));
      g.setIndex(idx); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.assets.terrain); m.matrixAutoUpdate = false;
      this.group.add(m);
    }
  }

  private buildSkyline(): void {
    // EVERY building always has a mesh (cheap far version) so nothing is ever invisible-but-solid.
    // Slightly smaller than the detailed buildings so those hide these without z-fighting
    for (const b of BUILDINGS) {
      const one = new Batch(); one.add(b.x, 3, b.z, b.ry, 0.965, 0.99, 0.965);
      one.commit(this.pools, buildingGeo(b.spec, false).lit, this.assets.building, false, this.resident);
    }
  }

  // ---- placed props (houses, temples, shrines, lamps, lanterns, torii...) : resident, instanced, a few draw calls in total ----
  private buildProps(): void {
    const A = this.assets;
    const make: Record<string, { f: () => Pair; cast: boolean }> = {
      lamp: { f: lampGeo, cast: false }, bench: { f: benchGeo, cast: false }, tlGreen: { f: () => trafficLightGeo(2), cast: false }, tlRed: { f: () => trafficLightGeo(0), cast: false },
      house0: { f: () => houseGeo(0), cast: true }, house1: { f: () => houseGeo(1), cast: true }, house2: { f: () => houseGeo(2), cast: true },
      cabin0: { f: () => houseGeo(0, true), cast: true }, cabin1: { f: () => houseGeo(1, true), cast: true }, cabin2: { f: () => houseGeo(2, true), cast: true },
      temple: { f: () => templeGeo(1), cast: true }, shrine: { f: shrineGeo, cast: true }, pagoda: { f: () => pagodaGeo(5), cast: true },
      pagodaIce: { f: () => pagodaGeo(5, hex(0xdfeaf5), hex(0x6fa8c8)), cast: true }, sanmon: { f: sanmonGeo, cast: true },
      toro: { f: () => toroGeo(false), cast: false }, toroBig: { f: () => toroGeo(true), cast: true }, komainu: { f: komainuGeo, cast: true },
      terminal: { f: terminalGeo, cast: true }, airTower: { f: airTowerGeo, cast: true }, hangar: { f: hangarGeo, cast: true },
      plane0: { f: () => planeGeo(0), cast: true }, plane1: { f: () => planeGeo(1), cast: true }, plane2: { f: () => planeGeo(2), cast: true },
      greatTree: { f: greatTreeGeo, cast: true },
      stall0: { f: () => stallGeo(0), cast: true }, stall1: { f: () => stallGeo(1), cast: true }, stall2: { f: () => stallGeo(2), cast: true }, stall3: { f: () => stallGeo(3), cast: true },
      field0: { f: () => fieldGeo(0), cast: false }, field1: { f: () => fieldGeo(1), cast: false }, field2: { f: () => fieldGeo(2), cast: false }, field3: { f: () => fieldGeo(3), cast: false },
      fence: { f: fenceGeo, cast: false }, barn: { f: barnGeo, cast: true }, haystack: { f: haystackGeo, cast: true }, scarecrow: { f: scarecrowGeo, cast: false }, torii: { f: toriiGeo, cast: true }, toriiIce: { f: toriiGeo, cast: true }, arch: { f: archGeo, cast: true },
    };
    for (const [kind, defs] of Object.entries(PROPS)) {
      if (kind === 'pylon') {
        const b = new Batch();
        for (const d of defs) { const g = Math.max(heightAt(d.x, d.z), -8) - 1; b.add(d.x, g, d.z, 0, 1.6, (d.v ?? 20) + 1, 1.6); }
        b.commit(this.pools, A.column, A.props, false, this.resident);
        continue;
      }
      if (kind === 'bridge') {
        const b = new Batch();
        for (const d of defs) b.add(d.x, Math.max(heightAt(d.x - 38, d.z), heightAt(d.x + 38, d.z)) + 0.4, d.z, 0, 1, 1, 1);
        b.commit(this.pools, A.bridge, A.props, true, this.resident);
        continue;
      }
      const m = make[kind]; if (!m) continue;
      const pair = m.f(), bl = new Batch(), bg = new Batch();
      for (const d of defs) {
        const y = heightAt(d.x, d.z);
        bl.add(d.x, y, d.z, d.ry, d.s, d.s, d.s);
        if (pair.lights) bg.add(d.x, y, d.z, d.ry, d.s, d.s, d.s);
      }
      const inked = this.outlines && ['house0', 'house1', 'house2', 'cabin0', 'cabin1', 'cabin2', 'temple', 'shrine', 'pagoda', 'pagodaIce', 'sanmon', 'torii', 'toriiIce', 'toroBig', 'terminal', 'airTower', 'hangar', 'plane0', 'plane1', 'plane2', 'greatTree'].includes(kind);
      bl.commit(this.pools, pair.lit, A.props, m.cast, this.resident, inked ? { geo: pair.lit, width: kind === 'greatTree' ? 0.12 : 0.05 } : null);
      if (pair.lights) bg.commit(this.pools, pair.lights, A.lights, false, this.resident);
    }
  }

  private pillarGeo(h: number, rTop: number, rBot: number, radial: number, rows: number, erode: number, seed: number): THREE.BufferGeometry {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, radial, rows, false);
    g.translate(0, h / 2, 0);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      let x = p.getX(i), z = p.getZ(i);
      const a = Math.atan2(z, x);
      const n = (noise2(a * 3 + seed, y * 0.03 + seed) - 0.5) * erode;
      const l = Math.hypot(x, z) || 1;
      x += (x / l) * n; z += (z / l) * n;
      // slow twist = "unusual geometric form"
      const tw = y * 0.0016 + seed;
      const cx = Math.cos(tw), sx = Math.sin(tw);
      p.setXYZ(i, x * cx - z * sx, y, x * sx + z * cx);
    }
    g.computeVertexNormals();
    return g;
  }

  private buildPillars(): void {
    const A = this.assets;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const px = GOD.x + Math.cos(a) * 120, pz = GOD.z + Math.sin(a) * 120;
      const H = 800 + ((i * 97) % 5) * 70;
      const seed = i * 1.7;
      const lod = new THREE.LOD();
      // LOD0: eroded 7-sided shaft + glow bands. LOD1/2: fewer facets. LOD3: 3-facet silhouette (far impostor).
      const l0 = new THREE.Group();
      l0.add(new THREE.Mesh(this.pillarGeo(H, 30, 56, 7, 48, 9, seed), A.pillar));
      for (let k = 1; k <= 7; k++) {
        const bandY = (k / 8) * H;
        const rad = 56 - (56 - 30) * (bandY / H) + 0.8;
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, 3.5, 7, 1, true), A.pillarGlow);
        ring.position.y = bandY; ring.rotation.y = (bandY * 0.0016 + seed);
        l0.add(ring);
      }
      lod.addLevel(l0, 0);
      lod.addLevel(new THREE.Mesh(this.pillarGeo(H, 30, 56, 7, 8, 5, seed), A.pillar), 800);
      lod.addLevel(new THREE.Mesh(this.pillarGeo(H, 30, 56, 5, 2, 0, seed), A.pillar), 2200);
      lod.addLevel(new THREE.Mesh(new THREE.CylinderGeometry(30, 56, H, 3, 1).translate(0, H / 2, 0), A.pillar), 4500);
      lod.position.set(px, Math.max(0, heightAt(px, pz)) - 6, pz);
      lod.rotation.set(Math.sin(a) * -0.1, 0, Math.cos(a) * 0.1); // lean toward the heavens
      this.group.add(lod);
      this.pillars.push(lod);
    }
  }

  // ---- resident landmarks: a handful of instanced draw calls, visible from anywhere on the map ----
  private buildLandmarks(): void {
    const A = this.assets;
    const rnd = mulberry32(2024);
    const glows = new Batch(), plates = new Batch(), orbs = new Batch(), lava = new Batch(), crystals = new Batch(), stone = new Batch(), glowStone = new Batch();
    const keep = (m: THREE.Object3D | null) => { if (m) { m.frustumCulled = false; this.group.add(m); } };

    // CITY: neon spire at the heart of the plaza: striped tapering shaft, observation deck, ring lights, beacon
    {
      const g = new THREE.CylinderGeometry(2.5, SPIRE.r, SPIRE.h, 14, 11, false);
      g.translate(0, SPIRE.h / 2, 0);
      const p = g.attributes.position as THREE.BufferAttribute;
      const col = new Float32Array(p.count * 3), c = new THREE.Color();
      for (let i = 0; i < p.count; i++) { c.set(Math.round(p.getY(i) / 40) % 2 ? 0xd8322f : 0xe9ecf5); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const shaft = new THREE.Mesh(g, A.props); shaft.position.set(SPIRE.x, 3, SPIRE.z); shaft.castShadow = true;
      keep(shaft);
      plates.add(SPIRE.x, 3 + 310, SPIRE.z, 0, 26, 7, 26, TMP.setRGB(0.85, 0.87, 0.95));
      plates.add(SPIRE.x, 3 + 350, SPIRE.z, 0, 15, 4, 15, TMP.setRGB(0.85, 0.2, 0.18));
      for (let k = 1; k <= 10; k++) {
        const h = (k / 11) * SPIRE.h, r = SPIRE.r + (2.5 - SPIRE.r) * (h / SPIRE.h) + 0.8;
        glows.add(SPIRE.x, 3 + h, SPIRE.z, 0, r, 1.4, r, NEON[k % NEON.length]);
      }
      orbs.add(SPIRE.x, 3 + SPIRE.h + 4, SPIRE.z, 0, 7, 7, 7, NEON[0]);
      // plaza fountain ring around the base
      plates.add(SPIRE.x, 3.4, SPIRE.z, 0, 44, 1.6, 44, TMP.setRGB(0.62, 0.62, 0.6));
      glows.add(SPIRE.x, 4.3, SPIRE.z, 0, 41, 0.3, 41, NEON[1]);
    }

    // GOD ISLAND: stepped altar, energy beam, steles, floating slabs
    {
      const ay = heightAt(GOD.x, GOD.z);
      [[36, 2.5], [28, 5], [20, 7.5]].forEach(([r, h]) => plates.add(GOD.x, ay + h / 2 - 0.5, GOD.z, 0, r, h, r, TMP.setRGB(0.5, 0.52, 0.56)));
      const ring = new Batch(); ring.add(GOD.x, ay + 8.2, GOD.z, 0, 16, 0.4, 16);
      ring.commit(this.pools, A.disc, A.pillarGlow, false, this.resident);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 2200, 6), A.pillarGlow);
      beam.position.set(GOD.x, ay + 1100, GOD.z);
      keep(beam);
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2, x = GOD.x + Math.cos(a) * 262, z = GOD.z + Math.sin(a) * 262;
        const h = 16 + rnd() * 18;
        stone.add(x, heightAt(x, z) + h / 2 - 1, z, a, 1.9, h, 1.9, TMP.setRGB(0.55, 0.57, 0.6));
        glowStone.add(x, heightAt(x, z) + h + 0.4, z, a, 0.9, 0.5, 0.9, NEON[1]);
      }
      for (let i = 0; i < 18; i++) {
        const a = rnd() * Math.PI * 2, r = 90 + rnd() * 520, x = GOD.x + Math.cos(a) * r, z = GOD.z + Math.sin(a) * r;
        if (heightAt(x, z) < 4) continue;
        const w = 12 + rnd() * 16, d = 12 + rnd() * 16, y = heightAt(x, z) + 60 + rnd() * 140, ry = rnd() * 6;
        stone.add(x, y, z, ry, w, 3.5, d, TMP.setRGB(0.5, 0.52, 0.56));
        glowStone.add(x, y - 2.2, z, ry, w * 0.6, 0.6, d * 0.6, NEON[1]);
      }
    }

    // EMBER ISLE: lava lake in the crater
    {
      const vy = heightAt(VOLCANO.x, VOLCANO.z);
      lava.add(VOLCANO.x, vy + 1.5, VOLCANO.z, 0, 62, 1, 62);
    }

    // SNOW: crystal spire in the frozen lake;  REEF: crystal field
    {
      const ly = heightAt(LAKE.x, LAKE.z);
      crystals.add(LAKE.x, ly - 0.5, LAKE.z, 0, 11, 28, 11, TMP.setRGB(0.75, 0.95, 1));
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * 6.283 + 0.4, r = 26 + rnd() * 20, s = 3 + rnd() * 5;
        crystals.add(LAKE.x + Math.cos(a) * r, ly - 0.5, LAKE.z + Math.sin(a) * r, a, s, 8 + rnd() * 14, s, rnd() < 0.5 ? TMP.setRGB(0.7, 0.9, 1) : TMP.setRGB(0.85, 0.75, 1));
      }
      const rf = island('reef');
      for (let i = 0; i < 26; i++) {
        const a = rnd() * 6.283, r = rnd() * 150, x = rf.cx + Math.cos(a) * r, z = rf.cz + Math.sin(a) * r;
        if (heightAt(x, z) < 2) continue;
        const s = 2 + rnd() * 7;
        crystals.add(x, heightAt(x, z) - 0.5, z, a, s, 5 + rnd() * 26, s, rnd() < 0.5 ? TMP.setRGB(0.6, 0.9, 1) : TMP.setRGB(1, 0.7, 0.95));
      }
    }

    const R = this.resident;
    glows.commit(this.pools, A.disc, A.glow, false, R);
    plates.commit(this.pools, A.disc, A.agents, true, R);
    orbs.commit(this.pools, A.orb, A.glow, false, R);
    lava.commit(this.pools, A.disc, A.lava, false, R);
    crystals.commit(this.pools, A.crystalGeo, A.crystal, false, R);
    stone.commit(this.pools, A.rock, A.agents, true, R);
    glowStone.commit(this.pools, A.rock, A.glow, false, R);
  }

  // ---- chunk streaming ----
  private key(cx: number, cz: number) { return cx + ',' + cz; }

  update(px: number, pz: number, vx: number, vz: number, rings: number, camera: THREE.Camera, budget = 1): void {
    this.sea.position.set(px, 0, pz);
    for (const l of this.pillars) l.update(camera);
    this.stats.builtThisFrame = 0;

    const ccx = Math.floor(px / CHUNK), ccz = Math.floor(pz / CHUNK);
    // look-ahead: preload where the player is heading (works the same for a fast flyer)
    const look = 2.5, ax = px + vx * look, az = pz + vz * look;
    const dist = (cx: number, cz: number) => Math.min(Math.hypot(cx + 0.5 - px / CHUNK, cz + 0.5 - pz / CHUNK), Math.hypot(cx + 0.5 - ax / CHUNK, cz + 0.5 - az / CHUNK));

    const want: { cx: number; cz: number; ring: number; d: number }[] = [];
    const seen = new Set<string>();
    const pcx = Math.floor(ax / CHUNK), pcz = Math.floor(az / CHUNK);
    for (const [bx, bz] of [[ccx, ccz], [pcx, pcz]]) {
      for (let dx = -rings - 1; dx <= rings + 1; dx++) for (let dz = -rings - 1; dz <= rings + 1; dz++) {
        const cx = bx + dx, cz = bz + dz, k = this.key(cx, cz);
        if (seen.has(k) || this.empty.has(k)) continue;
        seen.add(k);
        const d = dist(cx, cz);
        if (d > rings + 0.4) continue;
        // round LOD rings measured in real distance: ~1.3 chunks fully detailed, ~2.4 medium, the rest terrain + roads only
        const ring = d <= 1.3 ? 0 : d <= 2.4 ? 1 : 2;
        const rec = this.chunks.get(k);
        if (!rec || rec.ring !== ring) want.push({ cx, cz, ring, d });
      }
    }
    want.sort((a, b) => a.d - b.d);
    for (let i = 0; i < want.length && i < budget; i++) {
      const w = want[i];
      this.load(w.cx, w.cz, w.ring);
      this.stats.builtThisFrame++;
    }
    // idle frame: finish detailed buildings that were deferred (one design per frame, no hitch)
    if (!this.stats.builtThisFrame) for (const rec of this.chunks.values()) if (rec.pending && rec.ring === 0) { this.load(rec.cx, rec.cz, 0); this.stats.builtThisFrame++; break; }

    // unload with hysteresis
    for (const [k, rec] of this.chunks) {
      if (dist(rec.cx, rec.cz) > rings + 1.4) { this.dispose(rec); this.chunks.delete(k); }
    }
    this.stats.loaded = this.chunks.size;
    this.stats.pools = this.pools.pools; this.stats.instances = this.pools.instances;
    this.stats.ring[0] = this.stats.ring[1] = this.stats.ring[2] = 0;
    for (const r of this.chunks.values()) this.stats.ring[r.ring]++;
  }

  private load(cx: number, cz: number, ring: number): void {
    const k = this.key(cx, cz);
    const old = this.chunks.get(k);
    if (old) { this.dispose(old); this.chunks.delete(k); }
    const ox = cx * CHUNK, oz = cz * CHUNK;
    let maxH = -99;
    for (let i = 0; i <= 2; i++) for (let j = 0; j <= 2; j++) maxH = Math.max(maxH, heightAt(ox + i * 64, oz + j * 64));
    if (maxH < -3) { this.empty.add(k); return; }
    const inst: PoolEntry[] = [];
    this.missed = 0;
    const rec: ChunkRec = { cx, cz, ring, group: this.buildChunk(cx, cz, ring, inst), inst, pending: false };
    rec.pending = this.missed > 0;
    if (this.debugBorders) this.addBorder(rec);
    this.group.add(rec.group);
    this.chunks.set(k, rec);
  }

  private dispose(rec: ChunkRec): void {
    this.group.remove(rec.group);
    for (const e of rec.inst) e.pool.remove(e.handles);
    rec.group.traverse((o) => {
      if (o.userData.ownGeo) (o as THREE.Mesh).geometry.dispose();
    });
  }

  private addBorder(rec: ChunkRec): void {
    const ox = rec.cx * CHUNK, oz = rec.cz * CHUNK;
    const y = heightAt(ox + 64, oz + 64) + 1;
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(ox, y, oz), new THREE.Vector3(ox + CHUNK, y, oz),
      new THREE.Vector3(ox + CHUNK, y, oz + CHUNK), new THREE.Vector3(ox, y, oz + CHUNK),
    ]);
    const l = new THREE.LineLoop(g, this.borderMats[rec.ring]);
    l.userData.ownGeo = true;
    rec.border = l;
    rec.group.add(l);
  }

  setDebugBorders(on: boolean): void {
    this.debugBorders = on;
    for (const rec of this.chunks.values()) {
      if (on && !rec.border) this.addBorder(rec);
      if (!on && rec.border) { rec.group.remove(rec.border); rec.border.geometry.dispose(); rec.border = undefined; }
    }
  }

  // ---- chunk contents ----
  /** painted-texture channel for the ground: 0 grass, 1 sand/gravel/ash, 2 rock, 3 snow (adjacent channels blend naturally) */
  private terrainKind(x: number, z: number, y: number, grad: number): number {
    const id: IslandId = islandAt(x, z)?.id ?? 'valley';
    const cliff = sstep(0.7, 1.25, grad);
    let k = 0;
    switch (id) {
      case 'valley': k = y < 2.6 && this.coastal(x, z) ? 1 : y > 90 ? 2 * sstep(90, 220, y) : 0; break;
      case 'city': k = 1; break;
      case 'god': k = 2 - 2 * sstep(0.55, 0.85, noise2(x * 0.012 + 3, z * 0.012)) * 0.85; break; // ancient stone, mossy patches
      case 'ember': k = 1; break;
      case 'snow': k = y < 2.2 ? 1 : 3 - sstep(0.55, 0.72, noise2(x * 0.03, z * 0.03)) * sstep(60, 160, y) * 0.9; break;
      default: k = y < 2.4 ? 1 : 0;
    }
    return k + (2 - k) * cliff;
  }

  /** grass colour at a ground point, or false where none grows (paths, roads, rock, snow, sand, water, city, buildings, fields) */
  grassAt(x: number, z: number, out: THREE.Color): boolean {
    const isl = islandAt(x, z);
    if (!isl || (isl.id !== 'valley' && isl.id !== 'islet' && isl.id !== 'god')) return false;
    const y = heightAt(x, z); if (y < 2.4) return false;
    const gx = heightAt(x - 1, z) - heightAt(x + 1, z), gz = heightAt(x, z - 1) - heightAt(x, z + 1), grad = Math.hypot(gx, gz) / 2;
    const k = this.terrainKind(x, z, y, grad);
    if (k > (isl.id === 'god' ? 1.2 : 0.35) || grad > 0.75) return false;
    if (NET.edgeDist(x, z, 6) < 0.8 || covered(x, z)) return false;
    this.terrainColor(x, z, y, grad, out);
    out.multiplyScalar(1.05);
    return true;
  }

  /** near open water (a beach), as opposed to a low inland meadow */
  private coastal(x: number, z: number): boolean {
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; if (heightAt(x + Math.cos(a) * 45, z + Math.sin(a) * 45) < -0.5) return true; }
    return false;
  }

  private terrainColor(x: number, z: number, y: number, grad: number, out: THREE.Color): void {
    const id: IslandId = islandAt(x, z)?.id ?? 'valley';
    const n = noise2(x * 0.05, z * 0.05), cliff = sstep(0.75, 1.3, grad);
    switch (id) {
      case 'god': { // ancient moss-streaked stone, cold and dim
        out.setRGB(0.3 + n * 0.1, 0.36 + n * 0.1, 0.34 + n * 0.08);
        out.lerp(TMP.setRGB(0.18, 0.28, 0.22), sstep(0.5, 0.8, noise2(x * 0.02 + 4, z * 0.02)) * 0.5);
        if (y > 120) out.lerp(TMP.setRGB(0.62, 0.64, 0.7), sstep(120, 220, y));
        out.lerp(TMP.setRGB(0.32, 0.31, 0.33), cliff * 0.8);
        return;
      }
      case 'city':
        out.setRGB(0.5 + n * 0.04, 0.49 + n * 0.04, 0.46 + n * 0.04); // paved ground between the roads
        if (y < 2.6) out.setRGB(0.36, 0.37, 0.4);
        return;
      case 'valley': {
        out.setRGB(0.3 + n * 0.1, 0.55 + n * 0.1, 0.24);
        if (y < 60) out.lerp(TMP.setRGB(0.95, 0.7, 0.8), sstep(0.5, 0.68, noise2(x * 0.012 + 9, z * 0.012)) * 0.28); // fallen petals under the groves
        if (x > RICE.x0 && x < RICE.x1 && z > RICE.z0 && z < RICE.z1) { const st = Math.floor(z / 6) & 1; out.setRGB(st ? 0.5 : 0.35, st ? 0.72 : 0.62, st ? 0.28 : 0.3); }
        if (y < 2.2 && this.coastal(x, z)) out.setRGB(0.76, 0.7, 0.5);
        else if (y > 90) out.lerp(TMP.setRGB(0.58, 0.58, 0.6), sstep(90, 220, y));
        out.lerp(TMP.setRGB(0.5, 0.48, 0.46), cliff * 0.85);
        return;
      }
      case 'ember': { // black basalt, ash, scorched rim, glowing lava streams
        out.setRGB(0.11 + n * 0.07, 0.1 + n * 0.05, 0.11 + n * 0.05);
        out.lerp(TMP.setRGB(0.36, 0.35, 0.37), sstep(0.55, 0.75, noise2(x * 0.03 + 5, z * 0.03)) * 0.5);
        if (y > 150) out.lerp(TMP.setRGB(0.32, 0.1, 0.07), sstep(150, 280, y));
        if (y < 2.4) out.setRGB(0.16, 0.15, 0.16);
        const l = lavaAt(x, z);
        if (l > 0) out.lerp(TMP.setRGB(1.0, 0.38, 0.08), l);
        return;
      }
      case 'snow': {
        out.setRGB(0.9 + n * 0.08, 0.94 + n * 0.05, 1);
        out.lerp(TMP.setRGB(0.4, 0.42, 0.5), Math.max(cliff * 0.9, sstep(0.55, 0.72, noise2(x * 0.03, z * 0.03)) * sstep(60, 160, y) * 0.7));
        const r = Math.hypot(x - LAKE.x, z - LAKE.z);
        if (r < LAKE.r + 22) out.lerp(TMP.setRGB(0.55, 0.8, 0.95), 1 - sstep(LAKE.r - 10, LAKE.r + 22, r)); // frozen lake
        if (y < 2.2) out.setRGB(0.78, 0.8, 0.84);
        return;
      }
      default: // islets: rocky grass
        out.setRGB(0.36 + n * 0.1, 0.5 + n * 0.08, 0.3);
        out.lerp(TMP.setRGB(0.5, 0.5, 0.52), cliff);
        if (y < 2.4) out.setRGB(0.74, 0.7, 0.55);
    }
  }

  private buildTerrain(cx: number, cz: number, s: number): THREE.BufferGeometry {
    const n = s + 1, step = CHUNK / s, ox = cx * CHUNK, oz = cz * CHUNK;
    const gridV = n * n, V = gridV + 4 * n;
    const pos = new Float32Array(V * 3), nor = new Float32Array(V * 3), col = new Float32Array(V * 3), knd = new Float32Array(V);
    const c = new THREE.Color();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = ox + i * step, z = oz + j * step, y = heightAt(x, z), v = (j * n + i) * 3;
      pos[v] = x; pos[v + 1] = y; pos[v + 2] = z;
      let nx = heightAt(x - 1, z) - heightAt(x + 1, z), nz = heightAt(x, z - 1) - heightAt(x, z + 1);
      const grad = Math.hypot(nx, nz) / 2;
      const l = Math.hypot(nx, 2, nz); nx /= l; nz /= l;
      nor[v] = nx; nor[v + 1] = 2 / l; nor[v + 2] = nz;
      this.terrainColor(x, z, y, grad, c);
      col[v] = c.r; col[v + 1] = c.g; col[v + 2] = c.b; knd[j * n + i] = this.terrainKind(x, z, y, grad);
    }
    const idx: number[] = [];
    for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
      const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    // skirts hide LOD cracks between neighbouring chunks of different detail
    const edges: number[][] = [[], [], [], []];
    for (let i = 0; i < n; i++) { edges[0].push(i); edges[1].push(s * n + i); edges[2].push(i * n); edges[3].push(i * n + s); }
    edges.forEach((e, ei) => {
      const base = gridV + ei * n;
      for (let k = 0; k < n; k++) {
        const src = e[k] * 3, dst = (base + k) * 3;
        pos[dst] = pos[src]; pos[dst + 1] = pos[src + 1] - 24; pos[dst + 2] = pos[src + 2];
        nor[dst] = nor[src]; nor[dst + 1] = nor[src + 1]; nor[dst + 2] = nor[src + 2];
        col[dst] = col[src]; col[dst + 1] = col[src + 1]; col[dst + 2] = col[src + 2]; knd[base + k] = knd[e[k]];
      }
      for (let k = 0; k < n - 1; k++) {
        const a = e[k], b = e[k + 1], c2 = base + k, d = base + k + 1;
        idx.push(a, b, c2, b, d, c2, a, c2, b, b, c2, d);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('kind', new THREE.BufferAttribute(knd, 1));
    g.setIndex(idx);
    return g;
  }

  private buildChunk(cx: number, cz: number, ring: number, inst: PoolEntry[]): THREE.Group {
    const A = this.assets;
    const put = (b: Batch, geo: THREE.BufferGeometry, mat: THREE.Material, c = false, ol = 0) => b.commit(this.pools, geo, mat, c, inst, ol ? { geo, width: ol } : null);
    const grp = new THREE.Group();
    const ox = cx * CHUNK, oz = cz * CHUNK;
    const rnd = mulberry32(Math.imul(cx, 92821) ^ Math.imul(cz, 689287) ^ 0x51ed);

    const terrain = new THREE.Mesh(this.buildTerrain(cx, cz, this.ringSegs[ring]), A.terrain);
    terrain.userData.ownGeo = true;
    terrain.receiveShadow = ring === 0;
    terrain.matrixAutoUpdate = false;
    grp.add(terrain);

    // curved paths: one merged ribbon mesh per chunk (gravel roads + sidewalks in the city, flagstone elsewhere)
    const pm = NET.buildChunkMesh(cx, cz);
    if (pm) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pm.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(pm.nor, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(pm.col, 3));
      g.setAttribute('kind', new THREE.Float32BufferAttribute(pm.kind!, 1));
      g.setIndex(pm.idx);
      const m = new THREE.Mesh(g, A.ground); m.userData.ownGeo = true; m.receiveShadow = ring === 0; m.matrixAutoUpdate = false;
      grp.add(m);
    }
    if (pm?.lights?.idx.length) { // glowing deck edges of sky roads
      const g = new THREE.BufferGeometry(), L = pm.lights;
      g.setAttribute('position', new THREE.Float32BufferAttribute(L.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(L.nor, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(L.col, 3));
      g.setIndex(L.idx);
      const m = new THREE.Mesh(g, A.lights); m.userData.ownGeo = true; m.matrixAutoUpdate = false; m.frustumCulled = true;
      grp.add(m);
    }

    // detailed buildings only in the nearest ring (the always-resident far versions cover everything else). Detailed geometry is expensive to
    // generate, so at most one new design is built per chunk build; chunks with leftovers are upgraded a frame at a time.
    if (ring === 0 && this.nearDetail) {
      let built = 0;
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
        for (const b of buildingsNear(ox + i * 64 + 1, oz + j * 64 + 1)) {
          if (!hasBuildingDetail(b.spec)) { if (built >= 1) { this.missed++; continue; } built++; }
          const g = buildingGeo(b.spec, true), one = new Batch(); one.add(b.x, 3, b.z, b.ry, 1, 1, 1);
          one.commit(this.pools, g.lit, A.props, true, inst, this.outlines ? { geo: buildingGeo(b.spec, false).lit, width: 0.12 } : null);
          if (g.lights) { const l = new Batch(); l.add(b.x, 3, b.z, b.ry, 1, 1, 1); put(l, g.lights, A.lights); }
        }
      }
    }
    if (ring === 2) return grp; // far ring: terrain, roads and city silhouettes only

    const zone = islandAt(ox + 64, oz + 64)?.id ?? islandAt(ox, oz)?.id ?? islandAt(ox + CHUNK, oz + CHUNK)?.id
      ?? islandAt(ox + CHUNK, oz)?.id ?? islandAt(ox, oz + CHUNK)?.id ?? 'sea';
    const cast = ring === 0;
    const trees = new Batch(), glows = new Batch();
    const at = (x: number, z: number, id: IslandId) => islandAt(x, z)?.id === id;
    const clear = (x: number, z: number, r = 6) => NET.edgeDist(x, z, r + 2) > r; // keep paths and roads free of vegetation

    // ---- Sakura Valley: sakura groves on the lowlands, dark cedar forest on the mountains ----
    if (zone === 'valley') {
      const cedars = new Batch();
      const nTrees = ring === 0 ? 60 : 22;
      for (let i = 0; i < nTrees; i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z);
        const rr = rnd(), ry = rnd() * 6, s = 0.8 + rnd() * 0.9, tall = 1 + rnd() * 0.6;
        if (y < 2.4 || y > 200 || Math.abs(x - riverX(z)) < 34 || !at(x, z, 'valley')) continue;
        if (x > RICE.x0 - 10 && x < RICE.x1 + 10 && z > RICE.z0 - 10 && z < RICE.z1 + 10) continue;
        if (Math.hypot(x - VILLAGE_V.x, z - VILLAGE_V.z) < 175 || Math.hypot(x - HILL.x, z - HILL.z) < 40 || !clear(x, z)) continue;
        if (y > 70) { cedars.add(x, y - 0.3, z, ry, s * 1.4, s * tall * 1.5, s * 1.4); continue; }
        if (noise2(x * 0.012 + 9, z * 0.012) < 0.4 && rr > 0.12) continue;
        trees.add(x, y - 0.2, z, ry, s, s, s);
      }
      put(cedars, A.cedar, A.props, false);
    }

    // ---- God Island: weathered ruins, bare pale trees and glowing spirit stones; kept sparse so the temples read as the focus ----
    if (zone === 'god' && ring === 0) {
      const cols = new Batch(), rocks = new Batch(), dead = new Batch();
      for (let i = 0; i < 9; i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z), h = 5 + rnd() * 14, k = rnd() * 6;
        if (y < 2 || !clear(x, z, 9) || Math.hypot(x - GOD.x, z - GOD.z) < 300) continue;
        cols.add(x, y - 1, z, k, 1 + rnd() * 0.8, h, 1 + rnd() * 0.8);
      }
      for (let i = 0; i < 12; i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z), k = rnd();
        if (y < 3 || !at(x, z, 'god') || !clear(x, z, 8) || Math.hypot(x - GOD.x, z - GOD.z) < 70) continue;
        dead.add(x, y - 0.3, z, rnd() * 6, 1.4 + k, 1.4 + k, 1.4 + k, TMP.setRGB(2.4, 2.3, 2.6)); // bleached, bone-pale
      }
      for (let i = 0; i < 12; i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z), s = 2 + rnd() * 6;
        if (y < 2 || !clear(x, z, 9)) continue;
        rocks.add(x, y + s * 0.2, z, rnd() * 6, s, s * 0.7, s * (0.7 + rnd() * 0.5), TMP.setRGB(0.45, 0.47, 0.5));
        if (i < 3) glows.add(x, y + 3 + s, z, 0, 2.6, 2.6, 2.6, NEON[1]);
      }
      put(cols, A.column, A.props, true); put(rocks, A.rock, A.agents, true); put(dead, A.deadTree, A.props, true);
    }

    // ---- Ember Isle: basalt spires, dead ash trees, lava glow along the streams ----
    if (zone === 'ember') {
      const basalt = new Batch(), dead = new Batch(), lava = new Batch();
      for (let i = 0; i < (ring === 0 ? 24 : 8); i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z);
        const h = 3 + rnd() * 12, w = 0.8 + rnd() * 0.8, ry = rnd() * 6, dt = rnd();
        if (y < 2.2 || !at(x, z, 'ember') || lavaAt(x, z) > 0.1) continue;
        if (dt < 0.55) basalt.add(x, y - 1, z, ry, w, h, w, TMP.setRGB(0.3 + dt * 0.2, 0.28 + dt * 0.2, 0.32 + dt * 0.2));
        else dead.add(x, y - 0.3, z, ry, 0.8 + dt * 0.6, 0.8 + dt * 0.6, 0.8 + dt * 0.6);
      }
      for (let gx = 0; gx < CHUNK; gx += 12) for (let gz = 0; gz < CHUNK; gz += 12) {
        const x = ox + gx + rnd() * 6, z = oz + gz + rnd() * 6;
        if (lavaAt(x, z) < 0.6 || !at(x, z, 'ember')) continue;
        lava.add(x, heightAt(x, z) + 0.35, z, rnd() * 6, 7, 0.4, 7);
      }
      put(basalt, A.column, A.props, cast); put(dead, A.deadTree, A.props, cast); put(lava, A.disc, A.lava);
    }

    // ---- Yukigami Peaks: snow pines, ice boulders, glittering crystals ----
    if (zone === 'snow') {
      const pines = new Batch(), ice = new Batch(), cr = new Batch();
      for (let i = 0; i < (ring === 0 ? 48 : 16); i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z);
        const s = 0.9 + rnd() * 1.2, ry = rnd() * 6, k = rnd(), dens = noise2(x * 0.01 + 3, z * 0.01);
        if (y < 2.8 || y > 150 || !at(x, z, 'snow') || Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 14 || Math.hypot(x - VILLAGE_S.x, z - VILLAGE_S.z) < 120 || !clear(x, z, 5)) continue;
        if (k < 0.08 && ring === 0) { cr.add(x, y - 0.2, z, ry, 0.6 + k * 8, 0.6 + k * 8, 0.6 + k * 8, NEON[1]); continue; }
        if (dens < 0.42) continue;
        pines.add(x, y - 0.3, z, ry, s, s * (1 + rnd() * 0.5), s);
      }
      if (ring === 0) for (let i = 0; i < 8; i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z), s = 1.5 + rnd() * 3;
        if (y < 2.8 || !at(x, z, 'snow') || Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r || !clear(x, z, 6)) continue;
        ice.add(x, y + s * 0.2, z, rnd() * 6, s, s * 0.7, s, TMP.setRGB(0.85, 0.93, 1));
      }
      put(pines, A.pine, A.props, false); put(ice, A.rock, A.agents, true); put(cr, A.crystalGeo, A.crystal);
    }

    // ---- islets: a few trees each, flavoured per island ----
    if (zone === 'islet') {
      const key = islandAt(ox + 64, oz + 64)?.key ?? '';
      const pine = new Batch(), cedar = new Batch();
      for (let i = 0; i < 16; i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z), s = 0.9 + rnd() * 0.9;
        if (y < 3 || !at(x, z, 'islet') || !clear(x, z, 5)) continue;
        if (key === 'fox') trees.add(x, y - 0.2, z, rnd() * 6, s, s, s);
        else if (key === 'moon' || key === 'cairn') pine.add(x, y - 0.3, z, rnd() * 6, s, s, s);
        else if (key === 'arch') cedar.add(x, y - 0.3, z, rnd() * 6, s, s * 1.3, s);
      }
      put(pine, A.pine, A.props, cast); put(cedar, A.cedar, A.props, cast);
    }

    put(trees, A.tree, A.props, false);
    put(glows, A.orb, A.glow);
    return grp;
  }

  animatePillars(t: number): void { void t; }
}
