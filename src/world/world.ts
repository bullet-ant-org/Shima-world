/** World engine: chunk streaming with rings, per-ring detail, instancing, skyline + God Island pillar LOD. */
import * as THREE from 'three/webgpu';
import { Assets } from '../rendering/assets';
import { InstancePools, type PoolEntry } from '../rendering/instancing';
import {
  BLOCK, BRIDGES_Z, CHUNK, CITY, CLS_H, GOD, HILL, LAKE, RICE, SPIRE, VOLCANO, cityBlock, heightAt, islandAt, lavaAt, mulberry32, noise2,
  riverX, senbonTorii, sstep, type IslandId,
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
  commit(pools: InstancePools, geo: THREE.BufferGeometry, mat: THREE.Material, cast: boolean, out: PoolEntry[]): void {
    if (!this.n) return;
    const pool = pools.get(geo, mat, cast), handles: number[] = [];
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

interface ChunkRec { cx: number; cz: number; ring: number; group: THREE.Group; inst: PoolEntry[]; border?: THREE.LineLoop }

const NEON = [0xff3d9a, 0x25e6ff, 0xffb02e, 0x9a6bff].map((h) => new THREE.Color(h));
const WARM = new THREE.Color(0xffc477);
const TMP = new THREE.Color();

export class World {
  readonly group = new THREE.Group();
  private pools = new InstancePools(this.group);
  private resident: PoolEntry[] = []; // skyline + landmarks: permanent members of the same shared pools
  private chunks = new Map<string, ChunkRec>();
  private empty = new Set<string>();
  private readonly ringSegs = [24, 12, 6];
  debugBorders = false;
  private borderMats = [0x2cff8a, 0xffd23c, 0xff5a5a].map((c) => new THREE.LineBasicMaterial({ color: c }));
  private sea: THREE.Mesh;
  private pillars: THREE.LOD[] = [];
  private pillarGlowMeshes: THREE.Mesh[] = [];
  stats = { loaded: 0, ring: [0, 0, 0], builtThisFrame: 0, pools: 0, instances: 0 };

  constructor(private assets: Assets) {
    const seaGeo = new THREE.PlaneGeometry(60000, 60000); seaGeo.rotateX(-Math.PI / 2);
    this.sea = new THREE.Mesh(seaGeo, assets.sea);
    this.sea.frustumCulled = false;
    this.group.add(this.sea);
    this.buildSkyline();
    this.buildPillars();
    this.buildLandmarks();
  }

  // ---- extreme-distance representations (always resident, a handful of draw calls) ----
  private buildSkyline(): void {
    const batches = [new Batch(), new Batch(), new Batch()];
    for (let bi = CITY.bi0; bi <= CITY.bi1; bi++) for (let bj = CITY.bj0; bj <= CITY.bj1; bj++) {
      const b = cityBlock(bi, bj);
      if (!b || b.shrine) continue;
      // slightly smaller than the real building so streamed-in chunks hide it without z-fighting
      batches[b.cls].add(b.x, 3, b.z, 0, (b.w / 36) * 0.96, (b.h / CLS_H[b.cls]) * 0.985, (b.d / 36) * 0.96);
    }
    batches.forEach((bt, k) => bt.commit(this.pools, this.assets.bldg[k], this.assets.building, false, this.resident));
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
      const px = GOD.x + Math.cos(a) * 170, pz = GOD.z + Math.sin(a) * 170;
      const H = 520 + ((i * 97) % 5) * 55;
      const seed = i * 1.7;
      const lod = new THREE.LOD();
      // LOD0: eroded 7-sided shaft + glow bands. LOD1/2: fewer facets. LOD3: 3-facet silhouette (far impostor).
      const l0 = new THREE.Group();
      l0.add(new THREE.Mesh(this.pillarGeo(H, 22, 46, 7, 40, 7, seed), A.pillar));
      for (let k = 1; k <= 5; k++) {
        const bandY = (k / 6) * H;
        const rad = 46 - (46 - 22) * (bandY / H) + 0.6;
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, 3, 7, 1, true), A.pillarGlow);
        ring.position.y = bandY; ring.rotation.y = (bandY * 0.0016 + seed);
        l0.add(ring);
      }
      lod.addLevel(l0, 0);
      lod.addLevel(new THREE.Mesh(this.pillarGeo(H, 22, 46, 7, 8, 4, seed), A.pillar), 700);
      lod.addLevel(new THREE.Mesh(this.pillarGeo(H, 22, 46, 5, 2, 0, seed), A.pillar), 1800);
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(22, 46, H, 3, 1).translate(0, H / 2, 0), A.pillar);
      lod.addLevel(tip, 3600);
      lod.position.set(px, Math.max(0, heightAt(px, pz)) - 4, pz);
      // tilt toward the heavens / inward, each pillar slightly different
      lod.rotation.set(Math.sin(a) * -0.11, 0, Math.cos(a) * 0.11);
      lod.matrixAutoUpdate = true;
      this.group.add(lod);
      this.pillars.push(lod);
    }
  }

  // ---- resident landmarks: a handful of instanced draw calls, visible from anywhere on the map ----
  private buildLandmarks(): void {
    const A = this.assets;
    const keep = (m: THREE.Object3D | null) => { if (m) { m.frustumCulled = false; this.group.add(m); } };
    const rnd = mulberry32(2024);
    const glows = new Batch(), plates = new Batch(), tori = new Batch(), lanterns = new Batch(), orbs = new Batch();
    const lava = new Batch(), crystals = new Batch(), stone = new Batch(), glowStone = new Batch(), road = new Batch(), trees = new Batch();

    // CITY: neon spire — striped tapering shaft, observation deck, ring lights, beacon
    {
      const g = new THREE.CylinderGeometry(2.5, SPIRE.r, SPIRE.h, 14, 11, false);
      g.translate(0, SPIRE.h / 2, 0);
      const p = g.attributes.position as THREE.BufferAttribute;
      const col = new Float32Array(p.count * 3), c = new THREE.Color();
      for (let i = 0; i < p.count; i++) {
        c.set(Math.round(p.getY(i) / 40) % 2 ? 0xd8322f : 0xe9ecf5);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const shaft = new THREE.Mesh(g, A.props); shaft.position.set(SPIRE.x, 3, SPIRE.z); shaft.castShadow = true;
      keep(shaft);
      plates.add(SPIRE.x, 3 + 300, SPIRE.z, 0, 24, 7, 24, TMP.setRGB(0.85, 0.87, 0.95));
      plates.add(SPIRE.x, 3 + 340, SPIRE.z, 0, 14, 4, 14, TMP.setRGB(0.85, 0.2, 0.18));
      for (let k = 1; k <= 10; k++) {
        const h = (k / 11) * SPIRE.h, r = SPIRE.r + (2.5 - SPIRE.r) * (h / SPIRE.h) + 0.8;
        glows.add(SPIRE.x, 3 + h, SPIRE.z, 0, r, 1.4, r, NEON[k % NEON.length]);
      }
      orbs.add(SPIRE.x, 3 + SPIRE.h + 4, SPIRE.z, 0, 7, 7, 7, NEON[0]);
    }

    // GOD ISLAND: stepped altar, energy beam, steles, floating slabs, ancient road
    {
      const ay = heightAt(GOD.x, GOD.z);
      [[34, 2.5], [26, 5], [18, 7.5]].forEach(([r, h]) => plates.add(GOD.x, ay + h / 2 - 0.5, GOD.z, 0, r, h, r, TMP.setRGB(0.5, 0.52, 0.56)));
      const ring = new Batch(); ring.add(GOD.x, ay + 8.2, GOD.z, 0, 15, 0.4, 15);
      ring.commit(this.pools, A.disc, A.pillarGlow, false, this.resident);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 1500, 6), A.pillarGlow);
      beam.position.set(GOD.x, ay + 750, GOD.z);
      keep(beam);
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2, x = GOD.x + Math.cos(a) * 255, z = GOD.z + Math.sin(a) * 255;
        const h = 14 + rnd() * 16;
        stone.add(x, heightAt(x, z) + h / 2 - 1, z, a, 1.7, h, 1.7, TMP.setRGB(0.55, 0.57, 0.6));
      }
      for (let i = 0; i < 14; i++) {
        const a = rnd() * Math.PI * 2, r = 110 + rnd() * 330, x = GOD.x + Math.cos(a) * r, z = GOD.z + Math.sin(a) * r;
        if (heightAt(x, z) < 4) continue;
        const w = 10 + rnd() * 14, d = 10 + rnd() * 14, y = heightAt(x, z) + 50 + rnd() * 110, ry = rnd() * 6;
        stone.add(x, y, z, ry, w, 3.5, d, TMP.setRGB(0.5, 0.52, 0.56));
        glowStone.add(x, y - 2.2, z, ry, w * 0.6, 0.6, d * 0.6, NEON[1]);
      }
      for (let z = GOD.z + 545; z > GOD.z + 40; z -= 11) {
        if (heightAt(GOD.x, z) < 2) continue;
        road.add(GOD.x, heightAt(GOD.x, z) + 0.2, z, 0, 9, 1, 12, TMP.setRGB(0.42, 0.43, 0.47));
      }
    }

    // SAKURA VALLEY: senbon torii climbing the shrine hill, stone lanterns, great sacred sakura, river bridges
    {
      for (const g of senbonTorii()) {
        const y = heightAt(g.x, g.z);
        tori.add(g.x, y, g.z, g.ry, g.s, g.s, g.s);
        for (const side of [-1, 1]) {
          const lx = g.x + Math.cos(g.ry) * 8.5 * side * g.s, lz = g.z - Math.sin(g.ry) * 8.5 * side * g.s;
          const ly = heightAt(lx, lz);
          lanterns.add(lx, ly, lz, g.ry, 1, 1, 1);
          orbs.add(lx, ly + 2.6, lz, 0, 0.7, 0.7, 0.7, WARM);
        }
      }
      trees.add(HILL.x, heightAt(HILL.x, HILL.z) - 0.5, HILL.z, 0.4, 6, 6, 6);
      const bridges = new Batch();
      for (const bz of BRIDGES_Z) {
        const rx = riverX(bz);
        bridges.add(rx, Math.max(heightAt(rx - 38, bz), heightAt(rx + 38, bz)) + 0.4, bz, 0, 1, 1, 1);
      }
      bridges.commit(this.pools, A.bridge, A.props, true, this.resident);
    }

    // EMBER ISLE: lava lake in the crater and a procession of giant torii climbing to the volcano
    {
      const vy = heightAt(VOLCANO.x, VOLCANO.z);
      lava.add(VOLCANO.x, vy + 1.2, VOLCANO.z, 0, 30, 0.8, 30);
      for (let i = 0; i < 6; i++) {
        const t = i / 5, x = 560 + (VOLCANO.x - 560) * t * 0.7 + Math.sin(t * 3) * 14, z = 1440 + (1230 - 1440) * t;
        tori.add(x, heightAt(x, z) - 0.5, z, Math.atan2(VOLCANO.x - 560, VOLCANO.z - 1440) * 0.7, 3.6 - t * 0.9, 3.6 - t * 0.9, 3.6 - t * 0.9);
      }
    }

    // YUKIGAMI PEAKS: crystal spire in the frozen lake, giant ice-gate on the shore
    {
      const ly = heightAt(LAKE.x, LAKE.z);
      crystals.add(LAKE.x, ly - 0.5, LAKE.z, 0, 9, 22, 9, TMP.setRGB(0.75, 0.95, 1));
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * 6.283 + 0.4, r = 20 + rnd() * 14;
        const s = 2.5 + rnd() * 4;
        crystals.add(LAKE.x + Math.cos(a) * r, ly - 0.5, LAKE.z + Math.sin(a) * r, a, s, 7 + rnd() * 10, s, rnd() < 0.5 ? TMP.setRGB(0.7, 0.9, 1) : TMP.setRGB(0.85, 0.75, 1));
      }
      const gx = LAKE.x, gz = LAKE.z + LAKE.r + 60;
      tori.add(gx, heightAt(gx, gz) - 0.5, gz, 0, 6, 6, 6);
    }

    glows.commit(this.pools, A.disc, A.glow, false, this.resident);
    plates.commit(this.pools, A.disc, A.agents, true, this.resident);
    orbs.commit(this.pools, A.orb, A.glow, false, this.resident);
    tori.commit(this.pools, A.torii, A.props, true, this.resident);
    lanterns.commit(this.pools, A.lantern, A.props, false, this.resident);
    lava.commit(this.pools, A.disc, A.lava, false, this.resident);
    crystals.commit(this.pools, A.crystalGeo, A.crystal, false, this.resident);
    stone.commit(this.pools, A.rock, A.agents, true, this.resident);
    glowStone.commit(this.pools, A.rock, A.glow, false, this.resident);
    road.commit(this.pools, A.roadStrip, A.agents, false, this.resident);
    trees.commit(this.pools, A.tree, A.props, true, this.resident);
  }

  // ---- chunk streaming ----
  private key(cx: number, cz: number) { return cx + ',' + cz; }

  update(px: number, pz: number, vx: number, vz: number, rings: number, camera: THREE.Camera, budget = 1): void {
    this.sea.position.set(px, 0, pz);
    for (const l of this.pillars) l.update(camera);
    this.stats.builtThisFrame = 0;

    const ccx = Math.floor(px / CHUNK), ccz = Math.floor(pz / CHUNK);
    // look-ahead: preload where the player is heading (works the same for a fast vehicle later)
    const look = 2.5;
    const pcx = Math.floor((px + vx * look) / CHUNK), pcz = Math.floor((pz + vz * look) / CHUNK);

    const want: { cx: number; cz: number; ring: number; d: number }[] = [];
    const seen = new Set<string>();
    for (const [bx, bz] of [[ccx, ccz], [pcx, pcz]]) {
      for (let dx = -rings; dx <= rings; dx++) for (let dz = -rings; dz <= rings; dz++) {
        const cx = bx + dx, cz = bz + dz, k = this.key(cx, cz);
        if (seen.has(k) || this.empty.has(k)) continue;
        seen.add(k);
        const d = Math.min(Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz)), Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)));
        if (d > rings) continue;
        const ring = d <= 1 ? 0 : d <= 2 ? 1 : 2;
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

    // unload with hysteresis
    for (const [k, rec] of this.chunks) {
      const d = Math.min(Math.max(Math.abs(rec.cx - ccx), Math.abs(rec.cz - ccz)), Math.max(Math.abs(rec.cx - pcx), Math.abs(rec.cz - pcz)));
      if (d > rings + 1) { this.dispose(rec); this.chunks.delete(k); }
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
    const rec: ChunkRec = { cx, cz, ring, group: this.buildChunk(cx, cz, ring, inst), inst };
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
  private terrainColor(x: number, z: number, y: number, out: THREE.Color): void {
    const id: IslandId = islandAt(x, z)?.id ?? 'valley';
    const n = noise2(x * 0.05, z * 0.05);
    switch (id) {
      case 'god': // ancient stone with moss, snow-white on the heights
        out.setRGB(0.36 + n * 0.12, 0.4 + n * 0.1, 0.38 + n * 0.08);
        if (y > 45) out.lerp(TMP.setRGB(0.7, 0.72, 0.76), sstep(45, 70, y));
        return;
      case 'city':
        out.setRGB(0.09, 0.1, 0.14);
        if (y < 2.6) out.setRGB(0.34, 0.35, 0.4); // sea wall
        return;
      case 'valley': {
        out.setRGB(0.3 + n * 0.1, 0.55 + n * 0.1, 0.24);
        if (y < 60) out.lerp(TMP.setRGB(0.95, 0.7, 0.8), sstep(0.5, 0.68, noise2(x * 0.012 + 9, z * 0.012)) * 0.28); // fallen petals under the groves
        if (x > RICE.x0 && x < RICE.x1 && z > RICE.z0 && z < RICE.z1) { const st = Math.floor(z / 6) & 1; out.setRGB(st ? 0.5 : 0.35, st ? 0.72 : 0.62, st ? 0.28 : 0.3); }
        if (y < 2.2) out.setRGB(0.76, 0.7, 0.5);
        else if (y > 38) out.lerp(TMP.setRGB(0.55, 0.55, 0.58), sstep(38, 70, y));
        return;
      }
      case 'ember': { // black basalt, ash, scorched rim, glowing lava streams
        out.setRGB(0.11 + n * 0.07, 0.1 + n * 0.05, 0.11 + n * 0.05);
        out.lerp(TMP.setRGB(0.36, 0.35, 0.37), sstep(0.55, 0.75, noise2(x * 0.03 + 5, z * 0.03)) * 0.5);
        if (y > 90) out.lerp(TMP.setRGB(0.32, 0.1, 0.07), sstep(90, 150, y));
        if (y < 2.4) out.setRGB(0.16, 0.15, 0.16);
        const l = lavaAt(x, z);
        if (l > 0) out.lerp(TMP.setRGB(1.0, 0.38, 0.08), l);
        return;
      }
      case 'snow': {
        out.setRGB(0.9 + n * 0.08, 0.94 + n * 0.05, 1);
        if (y > 28) out.lerp(TMP.setRGB(0.38, 0.4, 0.47), sstep(0.55, 0.72, noise2(x * 0.03, z * 0.03)) * sstep(28, 60, y) * 0.8);
        const r = Math.hypot(x - LAKE.x, z - LAKE.z);
        if (r < LAKE.r + 22) out.lerp(TMP.setRGB(0.55, 0.8, 0.95), 1 - sstep(LAKE.r - 10, LAKE.r + 22, r)); // frozen lake
        if (y < 2.2) out.setRGB(0.78, 0.8, 0.84);
        return;
      }
    }
  }

  private buildTerrain(cx: number, cz: number, s: number): THREE.BufferGeometry {
    const n = s + 1, step = CHUNK / s, ox = cx * CHUNK, oz = cz * CHUNK;
    const gridV = n * n, V = gridV + 4 * n;
    const pos = new Float32Array(V * 3), nor = new Float32Array(V * 3), col = new Float32Array(V * 3);
    const c = new THREE.Color();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = ox + i * step, z = oz + j * step, y = heightAt(x, z), v = (j * n + i) * 3;
      pos[v] = x; pos[v + 1] = y; pos[v + 2] = z;
      let nx = heightAt(x - 1, z) - heightAt(x + 1, z), nz = heightAt(x, z - 1) - heightAt(x, z + 1);
      const l = Math.hypot(nx, 2, nz); nx /= l; nz /= l;
      nor[v] = nx; nor[v + 1] = 2 / l; nor[v + 2] = nz;
      this.terrainColor(x, z, y, c);
      col[v] = c.r; col[v + 1] = c.g; col[v + 2] = c.b;
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
        pos[dst] = pos[src]; pos[dst + 1] = pos[src + 1] - 8; pos[dst + 2] = pos[src + 2];
        nor[dst] = nor[src]; nor[dst + 1] = nor[src + 1]; nor[dst + 2] = nor[src + 2];
        col[dst] = col[src]; col[dst + 1] = col[src + 1]; col[dst + 2] = col[src + 2];
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
    g.setIndex(idx);
    return g;
  }

  private buildChunk(cx: number, cz: number, ring: number, inst: PoolEntry[]): THREE.Group {
    const put = (b: Batch, geo: THREE.BufferGeometry, mat: THREE.Material, c = false) => b.commit(this.pools, geo, mat, c, inst);
    const A = this.assets;
    const grp = new THREE.Group();
    const ox = cx * CHUNK, oz = cz * CHUNK;
    const rnd = mulberry32(Math.imul(cx, 92821) ^ Math.imul(cz, 689287) ^ 0x51ed);

    const terrain = new THREE.Mesh(this.buildTerrain(cx, cz, this.ringSegs[ring]), A.terrain);
    terrain.userData.ownGeo = true;
    terrain.receiveShadow = ring === 0;
    terrain.matrixAutoUpdate = false;
    grp.add(terrain);
    if (ring === 2) return grp; // far ring: terrain only; skyline + pillars carry the distant look

    const zone = islandAt(ox + 64, oz + 64)?.id ?? islandAt(ox, oz)?.id ?? islandAt(ox + CHUNK, oz + CHUNK)?.id
      ?? islandAt(ox + CHUNK, oz)?.id ?? islandAt(ox, oz + CHUNK)?.id ?? 'sea';
    const cast = ring === 0;

    // ---- City ----
    const bis = [Math.floor(ox / BLOCK), Math.floor(ox / BLOCK) + 1];
    const bjs = [Math.floor(oz / BLOCK), Math.floor(oz / BLOCK) + 1];
    let hasCity = false;
    const bb = [new Batch(), new Batch(), new Batch()];
    const roads = new Batch(), poles = new Batch(), glows = new Batch(), trees = new Batch(), tori = new Batch();
    for (const bi of bis) for (const bj of bjs) {
      const b = cityBlock(bi, bj);
      if (!b) continue;
      hasCity = true;
      if (b.shrine) {
        tori.add(b.x, 3, b.z, rnd() * 3, 1.3, 1.3, 1.3);
        for (let i = 0; i < 7; i++) trees.add(b.x + (rnd() - 0.5) * 40, 3, b.z + (rnd() - 0.5) * 40, rnd() * 6, 0.9, 0.9, 0.9);
        continue;
      }
      bb[b.cls].add(b.x, 3, b.z, 0, b.w / 36, b.h / CLS_H[b.cls], b.d / 36);
      if (ring === 0) {
        for (let s = 0; s < 3; s++) {
          const face = Math.floor(rnd() * 4);
          const ny = 8 + rnd() * Math.min(b.h - 10, 60);
          const o = rnd() * 0.6 - 0.3;
          const hw = b.w / 2 + 0.2, hd = b.d / 2 + 0.2;
          const px = face === 0 ? b.x + hw : face === 1 ? b.x - hw : b.x + o * b.w;
          const pz = face === 2 ? b.z + hd : face === 3 ? b.z - hd : b.z + o * b.d;
          glows.add(px, 3 + ny, pz, face < 2 ? Math.PI / 2 : 0, 1 + rnd(), 1, 1, NEON[Math.floor(rnd() * NEON.length)]);
        }
      }
    }
    if (hasCity) {
      // roads: 2 strips each way per chunk (every 64 m)
      for (let k = 0; k < 2; k++) {
        roads.add(ox + CHUNK / 2, 3.05, oz + k * BLOCK, 0, CHUNK, 1, 12);
        roads.add(ox + k * BLOCK, 3.05, oz + CHUNK / 2, 0, 12, 1, CHUNK);
        if (ring === 0) for (let l = 0; l < 2; l++) for (const [sx, sz] of [[7, 7], [-7, -7]]) {
          const x = ox + k * BLOCK + sx, z = oz + l * BLOCK + sz;
          poles.add(x, 3, z, 0, 1, 1, 1);
          glows.add(x, 10.2, z + 0.9, 0, 1, 1, 1, WARM);
        }
      }
      put(roads, A.roadStrip, A.road);
    }
    bb.forEach((bt, k) => { put(bt, A.bldg[k], A.building, cast); });

    const at = (x: number, z: number, id: IslandId) => islandAt(x, z)?.id === id;

    // ---- Sakura Valley: sakura groves on the lowlands, dark cedar forest on the mountains ----
    if (zone === 'valley') {
      const cedars = new Batch();
      const nTrees = ring === 0 ? 56 : 20;
      for (let i = 0; i < nTrees; i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z);
        const rr = rnd(), ry = rnd() * 6, s = 0.8 + rnd() * 0.9, tall = 1 + rnd() * 0.6;
        if (y < 2.4 || y > 80 || Math.abs(x - riverX(z)) < 24 || !at(x, z, 'valley')) continue;
        if (x > RICE.x0 - 8 && x < RICE.x1 + 8 && z > RICE.z0 - 8 && z < RICE.z1 + 8) continue;
        if (y > 40) { cedars.add(x, y - 0.3, z, ry, s, s * tall, s); continue; }
        if (noise2(x * 0.012 + 9, z * 0.012) < 0.4 && rr > 0.12) continue;
        trees.add(x, y - 0.2, z, ry, s, s, s);
      }
      put(cedars, A.cedar, A.props, cast);
    }

    // ---- God Island: weathered columns and boulders with glowing cores ----
    if (zone === 'god' && ring === 0) {
      const cols = new Batch(), rocks = new Batch();
      for (let i = 0; i < 16; i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z);
        if (y < 2) continue;
        const h = 6 + rnd() * 20;
        cols.add(x, y - 1, z, rnd() * 6, 1 + rnd() * 0.8, h, 1 + rnd() * 0.8);
      }
      for (let i = 0; i < 14; i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z);
        if (y < 2) continue;
        const s = 2 + rnd() * 6;
        rocks.add(x, y + s * 0.2, z, rnd() * 6, s, s * 0.7, s * (0.7 + rnd() * 0.5), TMP.setRGB(0.45, 0.47, 0.5));
        if (i < 4) glows.add(x, y + 4 + s, z, 0, 1.4, 1.4, 1.4, NEON[1]);
      }
      put(cols, A.column, A.props, true);
      put(rocks, A.rock, A.agents, true);
    }

    // ---- Ember Isle: basalt spires, dead ash trees, lava glow along the streams ----
    if (zone === 'ember') {
      const basalt = new Batch(), dead = new Batch(), lava = new Batch();
      for (let i = 0; i < (ring === 0 ? 22 : 8); i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z);
        const h = 3 + rnd() * 11, w = 0.8 + rnd() * 0.7, ry = rnd() * 6, dt = rnd();
        if (y < 2.2 || !at(x, z, 'ember') || lavaAt(x, z) > 0.1) continue;
        if (dt < 0.55) basalt.add(x, y - 1, z, ry, w, h, w, TMP.setRGB(0.3 + dt * 0.2, 0.28 + dt * 0.2, 0.32 + dt * 0.2));
        else dead.add(x, y - 0.3, z, ry, 0.8 + dt * 0.6, 0.8 + dt * 0.6, 0.8 + dt * 0.6);
      }
      for (let gx = 0; gx < CHUNK; gx += 12) for (let gz = 0; gz < CHUNK; gz += 12) {
        const x = ox + gx + rnd() * 6, z = oz + gz + rnd() * 6;
        if (lavaAt(x, z) < 0.6 || !at(x, z, 'ember')) continue;
        lava.add(x, heightAt(x, z) + 0.35, z, rnd() * 6, 7, 0.4, 7);
      }
      put(basalt, A.column, A.props, cast);
      put(dead, A.deadTree, A.props, cast);
      put(lava, A.disc, A.lava);
    }

    // ---- Yukigami Peaks: snow pines, ice boulders, glittering crystals ----
    if (zone === 'snow') {
      const pines = new Batch(), ice = new Batch(), cr = new Batch();
      for (let i = 0; i < (ring === 0 ? 46 : 16); i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z);
        const s = 0.8 + rnd() * 1.1, ry = rnd() * 6, k = rnd(), dens = noise2(x * 0.01 + 3, z * 0.01);
        if (y < 2.8 || y > 70 || !at(x, z, 'snow') || Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 12) continue;
        if (k < 0.1 && ring === 0) { cr.add(x, y - 0.2, z, ry, 0.6 + k * 8, 0.6 + k * 8, 0.6 + k * 8, NEON[1]); continue; }
        if (dens < 0.42) continue;
        pines.add(x, y - 0.3, z, ry, s, s * (1 + rnd() * 0.5), s);
      }
      if (ring === 0) for (let i = 0; i < 8; i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z), s = 1.5 + rnd() * 3;
        if (y < 2.8 || !at(x, z, 'snow') || Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r) continue;
        ice.add(x, y + s * 0.2, z, rnd() * 6, s, s * 0.7, s, TMP.setRGB(0.85, 0.93, 1));
      }
      put(pines, A.pine, A.props, cast);
      put(ice, A.rock, A.agents, true);
      put(cr, A.crystalGeo, A.crystal);
    }

    put(trees, A.tree, A.props, cast);
    put(tori, A.torii, A.props, cast);
    put(poles, A.pole, A.props);
    put(glows, A.sign, A.glow);
    return grp;
  }

  animatePillars(t: number): void {
    // pulse glow via shared material; cost is a single uniform change
    this.assets.pillarGlow.opacity = 1;
    void t;
  }
}
