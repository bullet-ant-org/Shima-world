/**
 * World-wide instance pools. Every repeated prop (towers, poles, trees, torii, lava discs…) lives in ONE InstancedMesh per
 * (geometry, material, shadow-casting) triple, no matter how many chunks are streamed in. Chunks add/remove ranges of instances;
 * removal is swap-with-last so the mesh stays densely packed and `count` is the exact number drawn.
 * Result: draw calls for all props = number of distinct (geometry, material) pairs (~25), independent of view distance.
 */
import * as THREE from 'three/webgpu';
import { hullGeo, outlineMat, type OutlineSpec } from './outline';

export class InstancePool {
  mesh!: THREE.InstancedMesh;
  outline: THREE.InstancedMesh | null = null;
  count = 0;
  private cap = 0;
  private slotHandle = new Int32Array(0);
  private handleSlot = new Int32Array(0);
  private free: number[] = [];
  private nextHandle = 0;

  constructor(private geo: THREE.BufferGeometry, private mat: THREE.Material, private cast: boolean, private parent: THREE.Object3D, cap = 1024, private ol: OutlineSpec | null = null) {
    this.alloc(cap);
  }

  private alloc(cap: number): void {
    const old = this.mesh, oldO = this.outline;
    const m = new THREE.InstancedMesh(this.geo, this.mat, cap);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    m.frustumCulled = false; // one mesh spans the loaded world; the chunk ring already bounds what exists
    m.castShadow = this.cast;
    m.matrixAutoUpdate = false;
    m.count = this.count;
    m.visible = this.count > 0;
    const sh = new Int32Array(cap), hs = new Int32Array(cap);
    if (old) {
      (m.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
      (m.instanceColor.array as Float32Array).set(old.instanceColor!.array as Float32Array);
      sh.set(this.slotHandle); hs.set(this.handleSlot);
      this.parent.remove(old); old.dispose();
      if (oldO) { this.parent.remove(oldO); oldO.dispose(); }
    }
    this.slotHandle = sh; this.handleSlot = hs; this.cap = cap;
    this.parent.add(m);
    this.mesh = m;
    if (this.ol) { // outline mesh shares the instance buffers: one extra draw call, zero extra uploads
      const o = new THREE.InstancedMesh(hullGeo(this.ol.geo), outlineMat(this.ol.width), cap);
      o.instanceMatrix = m.instanceMatrix;
      o.count = this.count; o.visible = m.visible; o.frustumCulled = false; o.matrixAutoUpdate = false;
      this.parent.add(o);
      this.outline = o;
    }
  }
  private syncOutline(): void { if (this.outline) { this.outline.count = this.count; this.outline.visible = this.mesh.visible; } }

  /** Adds one Y-rotated, scaled instance; returns a handle for remove(). */
  add(x: number, y: number, z: number, ry: number, sx: number, sy: number, sz: number, r = 1, g = 1, b = 1): number {
    if (this.count >= this.cap) this.alloc(this.cap * 2);
    const handle = this.free.length ? this.free.pop()! : this.nextHandle++;
    const slot = this.count++;
    const c = Math.cos(ry), s = Math.sin(ry), a = this.mesh.instanceMatrix.array as Float32Array, o = slot * 16;
    a[o] = c * sx; a[o + 1] = 0; a[o + 2] = -s * sx; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = s * sz; a[o + 9] = 0; a[o + 10] = c * sz; a[o + 11] = 0;
    a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
    const col = this.mesh.instanceColor!.array as Float32Array;
    col[slot * 3] = r; col[slot * 3 + 1] = g; col[slot * 3 + 2] = b;
    this.slotHandle[slot] = handle; this.handleSlot[handle] = slot;
    this.mesh.count = this.count;
    this.mesh.visible = true;
    this.syncOutline();
    return handle;
  }

  remove(handles: number[]): void {
    const a = this.mesh.instanceMatrix.array as Float32Array, col = this.mesh.instanceColor!.array as Float32Array;
    for (const h of handles) {
      const slot = this.handleSlot[h], last = --this.count;
      if (slot !== last) {
        a.copyWithin(slot * 16, last * 16, last * 16 + 16);
        col.copyWithin(slot * 3, last * 3, last * 3 + 3);
        const moved = this.slotHandle[last];
        this.slotHandle[slot] = moved; this.handleSlot[moved] = slot;
      }
      this.free.push(h);
    }
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0; // an empty pool costs nothing
    this.syncOutline();
    this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor!.needsUpdate = true;
  }

  private saved = new Map<number, Float32Array>();
  /** temporarily collapse one instance (e.g. a far building while its detailed model stands in its place) */
  hide(h: number): void {
    if (this.saved.has(h)) return;
    const a = this.mesh.instanceMatrix.array as Float32Array, o = this.handleSlot[h] * 16;
    this.saved.set(h, a.slice(o, o + 16));
    for (let i = 0; i < 12; i++) a[o + i] = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  show(h: number): void {
    const m = this.saved.get(h); if (!m) return;
    this.saved.delete(h);
    (this.mesh.instanceMatrix.array as Float32Array).set(m, this.handleSlot[h] * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  flush(): void { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor!.needsUpdate = true; }
}

export interface PoolEntry { pool: InstancePool; handles: number[] }

export class InstancePools {
  private map = new Map<string, InstancePool>();
  constructor(private parent: THREE.Object3D) {}
  get(geo: THREE.BufferGeometry, mat: THREE.Material, cast: boolean, ol: OutlineSpec | null = null): InstancePool {
    const k = geo.uuid + '|' + mat.uuid + '|' + (cast ? 1 : 0) + (ol ? '|o' + ol.geo.uuid + ol.width : '');
    let p = this.map.get(k);
    if (!p) { p = new InstancePool(geo, mat, cast, this.parent, 1024, ol); this.map.set(k, p); }
    return p;
  }
  get pools(): number { let n = 0; for (const p of this.map.values()) if (p.count) n++; return n; }
  get instances(): number { let n = 0; for (const p of this.map.values()) n += p.count; return n; }
}
