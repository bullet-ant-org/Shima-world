/**
 * Floating islands: huge rocks hanging in the sky over the open sea, each with a grassy top, trees, a little shrine or
 * ruin, and a river that runs to the edge and pours off as a waterfall all the way down into the ocean, where it
 * churns up a ring of foam and a column of mist. They drift and bob very slowly.
 */
import * as THREE from 'three/webgpu';
import { float, fract, positionLocal, sin, time, uv, vec3, mix, smoothstep } from 'three/tsl';
import { heightAt, noise2, mulberry32 } from './terrain';

interface Floater { root: THREE.Group; x: number; z: number; y: number; ph: number }

/** irregular rock: a fat grassy disc on top, cliffs tapering to a jagged point far below */
function rockGeo(R: number, depth: number, seed: number): THREE.BufferGeometry {
  const seg = 48, rings = 14, pos: number[] = [], col: number[] = [], idx: number[] = [];
  const rr = (a: number, k: number) => R * (0.82 + 0.3 * noise2(Math.cos(a) * 2.2 + seed, Math.sin(a) * 2.2 + k * 0.3));
  // top surface (fan) with gentle undulation
  pos.push(0, 1.2, 0); col.push(0.3, 0.62, 0.26);
  for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2, r = rr(a, 0); pos.push(Math.cos(a) * r, 0.3 * noise2(i * 0.5, seed), Math.sin(a) * r); col.push(0.32, 0.6, 0.25); }
  for (let i = 0; i < seg; i++) idx.push(0, 1 + ((i + 1) % seg), 1 + i);
  // cliff rings going down, narrowing to a point; grass lip, dirt band, then rock strata
  const base = pos.length / 3;
  for (let k = 0; k <= rings; k++) {
    const t = k / rings, y = -depth * Math.pow(t, 1.2), shrink = Math.pow(1 - t, 0.75) * (1 - 0.15 * Math.sin(t * 9));
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2, r = rr(a, k) * shrink * (0.9 + 0.2 * noise2(i * 0.7 + k, seed + k));
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      const band = 0.5 + 0.5 * Math.sin(y * 0.25 + noise2(i, k) * 2);
      if (k === 0) col.push(0.28, 0.52, 0.22); else if (k === 1) col.push(0.42, 0.3, 0.2); else col.push(0.42 + band * 0.12, 0.38 + band * 0.1, 0.36 + band * 0.1);
    }
  }
  for (let k = 0; k < rings; k++) for (let i = 0; i < seg; i++) {
    const a = base + k * seg + i, b = base + k * seg + ((i + 1) % seg), c = a + seg, d = b + seg;
    idx.push(a, b, c, b, d, c);
  }
  // stitch the top disc rim to the first cliff ring
  for (let i = 0; i < seg; i++) { const a = 1 + i, b = 1 + ((i + 1) % seg), c = base + i, d = base + ((i + 1) % seg); idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function treeGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (geo: THREE.BufferGeometry, c: number, x: number, y: number, z: number) => {
    geo.translate(x, y, z); const cc = new THREE.Color(c), n = geo.getAttribute('position').count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = cc.r; a[i * 3 + 1] = cc.g; a[i * 3 + 2] = cc.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3)); parts.push(geo.index ? geo.toNonIndexed() : geo);
  };
  add(new THREE.CylinderGeometry(0.5, 0.8, 7, 7), 0x5a3a24, 0, 3.5, 0);
  for (const [x, y, z, r] of [[0, 9, 0, 4.2], [2.4, 7.6, 1, 3], [-2.2, 8, -1.2, 3.2], [0.5, 11.2, -0.6, 3]]) add(new THREE.IcosahedronGeometry(r, 1), 0x4a9a3e, x, y, z);
  const pos: number[] = [], col: number[] = [];
  for (const p of parts) { pos.push(...(p.getAttribute('position').array as Float32Array)); col.push(...(p.getAttribute('color').array as Float32Array)); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
  return g;
}

export class FloatingIslands {
  readonly group = new THREE.Group();
  private list: Floater[] = [];
  private waterMat: THREE.MeshBasicNodeMaterial;

  constructor(ramp: THREE.Texture) {
    const rockMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp });
    const treeMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp });
    // falling water: bright streaks scrolling down a translucent sheet, whiter at the edges and near the bottom
    this.waterMat = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const v = uv(), streak = fract(v.y.mul(14).add(time.mul(1.6)).add(sin(v.x.mul(40)).mul(0.12)));
    const foam = smoothstep(0.55, 1.0, streak).mul(0.7);
    this.waterMat.colorNode = mix(vec3(0.55, 0.8, 0.95), vec3(1, 1, 1), foam.add(v.y.oneMinus().mul(0.35)).clamp(0, 1));
    this.waterMat.opacityNode = float(0.78).sub(v.x.sub(0.5).abs().mul(0.9));
    const mistMat = new THREE.MeshBasicMaterial({ color: 0xf4fbff, transparent: true, opacity: 0.45, depthWrite: false });
    const riverMat = new THREE.MeshBasicMaterial({ color: 0x6ec8f0 });
    const tree = treeGeo();
    void positionLocal;

    const rnd = mulberry32(4242);
    const spots: [number, number][] = [[-900, -900], [900, -2200], [-1500, 900], [2600, 400], [600, 2900], [-3200, 600], [-800, 2600], [2300, -900]];
    for (const [sx, sz] of spots) {
      // only over open water, so the falls land in the sea
      if (heightAt(sx, sz) > -4) continue;
      const R = 70 + rnd() * 70, depth = R * (1.4 + rnd() * 0.8), y = 230 + rnd() * 220, root = new THREE.Group();
      const rock = new THREE.Mesh(rockGeo(R, depth, rnd() * 50), rockMat); rock.castShadow = true; root.add(rock);
      // trees on top
      const trees = new THREE.InstancedMesh(tree, treeMat, 26), m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      for (let i = 0; i < 26; i++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * R * 0.72, s = 0.8 + rnd() * 0.9;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6); m.compose(new THREE.Vector3(Math.cos(a) * r, 0.2, Math.sin(a) * r), q, sc.set(s, s, s)); trees.setMatrixAt(i, m);
      }
      trees.castShadow = true; root.add(trees);
      // a small torii / ruin on top
      const gate = new THREE.Group(), red = new THREE.MeshToonMaterial({ color: 0xc8283c, gradientMap: ramp });
      for (const gx of [-3, 3]) { const pl = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, 7, 8), red); pl.position.set(gx, 3.5, 0); gate.add(pl); }
      const top = new THREE.Mesh(new THREE.BoxGeometry(9, 0.7, 1), red); top.position.y = 7.2; gate.add(top);
      const top2 = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.4, 0.7), red); top2.position.y = 6.2; gate.add(top2);
      gate.position.set(R * 0.2, 0, -R * 0.15); gate.rotation.y = rnd() * 3; root.add(gate);
      // river across the top to the edge, then the waterfall straight down into the sea
      const fa = rnd() * Math.PI * 2, edge = R * 0.86, ex = Math.cos(fa) * edge, ez = Math.sin(fa) * edge;
      const rg = new THREE.PlaneGeometry(16, edge); rg.rotateX(-Math.PI / 2);
      const river = new THREE.Mesh(rg, riverMat); river.rotation.y = Math.PI / 2 - fa; river.position.set(ex / 2, 0.5, ez / 2); root.add(river);
      const fallH = y + 6, fall = new THREE.Mesh(new THREE.PlaneGeometry(26, fallH, 1, 24), this.waterMat);
      // bow the sheet outward a little as it falls
      const fp = fall.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < fp.count; i++) { const t = Math.max(0, (fallH / 2 - fp.getY(i)) / fallH); fp.setZ(i, 18 * Math.sqrt(t) + 6 * t); }
      fall.geometry.computeVertexNormals();
      fall.position.set(Math.cos(fa) * (edge + 2), 0.5 - fallH / 2, Math.sin(fa) * (edge + 2)); fall.rotation.y = Math.PI / 2 - fa;
      root.add(fall);
      // foam ring and mist where the water hits the sea
      const hit = new THREE.Vector3(Math.cos(fa) * (edge + 26), -y + 0.6, Math.sin(fa) * (edge + 26));
      const foamRing = new THREE.Mesh(new THREE.CircleGeometry(16, 24), mistMat); foamRing.rotation.x = -Math.PI / 2; foamRing.position.copy(hit); root.add(foamRing);
      for (let k = 0; k < 5; k++) { const puff = new THREE.Mesh(new THREE.SphereGeometry(8 + k * 3, 12, 8), mistMat); puff.position.copy(hit).add(new THREE.Vector3((rnd() - 0.5) * 12, 4 + k * 6, (rnd() - 0.5) * 12)); puff.scale.y = 0.6; root.add(puff); }
      root.position.set(sx, y, sz);
      root.traverse((o) => { o.frustumCulled = false; });
      this.group.add(root);
      this.list.push({ root, x: sx, z: sz, y, ph: rnd() * 6 });
    }
  }

  update(dt: number, timeSec: number): void {
    void dt;
    for (const f of this.list) { f.root.position.y = f.y + Math.sin(timeSec * 0.08 + f.ph) * 3; f.root.rotation.y = Math.sin(timeSec * 0.01 + f.ph) * 0.05; }
  }
}
