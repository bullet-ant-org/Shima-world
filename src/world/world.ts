/** World engine: chunk streaming with rings, per-ring detail, instancing, skyline + God Island pillar LOD. */
import * as THREE from 'three/webgpu';
import { Assets } from '../rendering/assets';
import {
  BLOCK, CHUNK, CITY, CLS_H, GOD, SEA, TORII, VILLAGE, buildVillage, cityBlock, heightAt, mulberry32, noise2, riverX, sstep, zoneAt,
  type HouseDef,
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

interface ChunkRec { cx: number; cz: number; ring: number; group: THREE.Group; border?: THREE.LineLoop }

const NEON = [0xff3d9a, 0x25e6ff, 0xffb02e, 0x9a6bff].map((h) => new THREE.Color(h));
const WARM = new THREE.Color(0xffc477);
const TMP = new THREE.Color();

export class World {
  readonly group = new THREE.Group();
  private chunks = new Map<string, ChunkRec>();
  private empty = new Set<string>();
  private village: HouseDef[] = buildVillage();
  private readonly ringSegs = [24, 12, 6];
  debugBorders = false;
  private borderMats = [0x2cff8a, 0xffd23c, 0xff5a5a].map((c) => new THREE.LineBasicMaterial({ color: c }));
  private sea: THREE.Mesh;
  private pillars: THREE.LOD[] = [];
  private pillarGlowMeshes: THREE.Mesh[] = [];
  stats = { loaded: 0, ring: [0, 0, 0], builtThisFrame: 0 };

  constructor(private assets: Assets) {
    const seaGeo = new THREE.PlaneGeometry(60000, 60000); seaGeo.rotateX(-Math.PI / 2);
    this.sea = new THREE.Mesh(seaGeo, assets.sea);
    this.sea.frustumCulled = false;
    this.group.add(this.sea);
    this.buildSkyline();
    this.buildPillars();
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
    batches.forEach((bt, k) => { const m = bt.build(this.assets.bldg[k], this.assets.building); if (m) { m.frustumCulled = false; this.group.add(m); } });
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
    const rec: ChunkRec = { cx, cz, ring, group: this.buildChunk(cx, cz, ring) };
    if (this.debugBorders) this.addBorder(rec);
    this.group.add(rec.group);
    this.chunks.set(k, rec);
  }

  private dispose(rec: ChunkRec): void {
    this.group.remove(rec.group);
    rec.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
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
    const c = sstep(10, 70, x);
    const n = noise2(x * 0.05, z * 0.05);
    if (z < -900) { // God Island: ancient stone with moss
      out.setRGB(0.36 + n * 0.12, 0.4 + n * 0.1, 0.38 + n * 0.08);
      if (y > 45) out.lerp(TMP.setRGB(0.7, 0.72, 0.76), sstep(45, 70, y));
      return;
    }
    // valley
    out.setRGB(0.3 + n * 0.1, 0.55 + n * 0.1, 0.24);
    const inRice = x > -200 && x < -30 && z > 100 && z < 260;
    if (inRice) { const s = Math.floor(z / 6) & 1; out.setRGB(s ? 0.5 : 0.35, s ? 0.72 : 0.62, s ? 0.28 : 0.3); }
    if (y < 2.2) out.setRGB(0.76, 0.7, 0.5);
    else if (y > 38) out.lerp(TMP.setRGB(0.55, 0.55, 0.58), sstep(38, 70, y));
    // city asphalt
    if (c > 0) out.lerp(TMP.setRGB(0.09, 0.1, 0.14), c);
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

  private buildChunk(cx: number, cz: number, ring: number): THREE.Group {
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

    const zone = zoneAt(ox + 64, oz + 64);
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
      const m = roads.build(A.roadStrip, A.road); if (m) grp.add(m);
    }
    bb.forEach((bt, k) => { const m = bt.build(A.bldg[k], A.building, cast); if (m) grp.add(m); });

    // ---- Sakura Valley ----
    if (zone === 'valley' && !hasCity) {
      const houses = new Batch(), lanterns = new Batch();
      for (const h of this.village) {
        if (h.x < ox || h.x >= ox + CHUNK || h.z < oz || h.z >= oz + CHUNK) continue;
        houses.add(h.x, heightAt(h.x, h.z), h.z, h.ry, h.s, h.s, h.s);
        lanterns.add(h.x + Math.sin(h.ry) * 3.4 * h.s + Math.cos(h.ry) * 3.2, heightAt(h.x, h.z) + 2.8, h.z + Math.cos(h.ry) * 3.4 * h.s - Math.sin(h.ry) * 3.2, 0, 1, 1, 1, WARM);
      }
      for (const t of TORII) if (t.x >= ox && t.x < ox + CHUNK && t.z >= oz && t.z < oz + CHUNK) tori.add(t.x, heightAt(t.x, t.z), t.z, t.ry, t.s, t.s, t.s);
      const nTrees = ring === 0 ? 30 : 12;
      for (let i = 0; i < nTrees; i++) {
        const x = ox + rnd() * CHUNK, z = oz + rnd() * CHUNK, y = heightAt(x, z);
        const rr = rnd(), ry = rnd() * 6;
        if (y < 2.4 || y > 60 || Math.abs(x - riverX(z)) < 22) continue;
        if (Math.hypot(x - VILLAGE.x, z - VILLAGE.z) < 55 && rr < 0.6) continue;
        const s = 0.8 + rnd() * 0.9;
        trees.add(x, y - 0.2, z, ry, s, s, s);
      }
      let m = houses.build(A.house, A.props, cast); if (m) grp.add(m);
      m = lanterns.build(A.orb, A.glow); if (m) grp.add(m);
    }

    // ---- God Island ----
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
        rocks.add(x, y + s * 0.2, z, rnd() * 6, s, s * 0.7, s * (0.7 + rnd() * 0.5), TMP.setRGB(0.45, 0.47, 0.5).clone());
        if (i < 4) glows.add(x, y + 4 + s, z, 0, 1.4, 1.4, 1.4, NEON[1]);
      }
      let m = cols.build(A.column, A.props, true); if (m) grp.add(m);
      m = rocks.build(A.rock, A.agents, true); if (m) grp.add(m);
    } else if (zone === 'god') {
      /* ring 1: terrain only on God Island; pillars carry the landmark */
    }

    let m = trees.build(A.tree, A.props, cast); if (m) grp.add(m);
    m = tori.build(A.torii, A.props, cast); if (m) grp.add(m);
    m = poles.build(A.pole, A.props); if (m) grp.add(m);
    m = glows.build(A.sign, A.glow); if (m) grp.add(m);
    return grp;
  }

  animatePillars(t: number): void {
    // pulse glow via shared material; cost is a single uniform change
    this.assets.pillarGlow.opacity = 1;
    void t;
  }
}
