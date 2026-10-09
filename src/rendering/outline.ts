/**
 * Anime ink outlines via the inverted-hull technique: a back-faced, slightly inflated copy of the mesh in a flat dark colour.
 * Hull geometry is rebuilt with welded vertices and smooth normals (flat-shaded source geometry would tear apart when inflated).
 * The outline mesh of an instanced pool shares the pool's instance buffer, so it costs one extra draw per pool, no extra uploads.
 */
import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { float, normalLocal, positionLocal } from 'three/tsl';

const hulls = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
export function hullGeo(src: THREE.BufferGeometry): THREE.BufferGeometry {
  let h = hulls.get(src);
  if (h) return h;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.getAttribute('position').clone());
  if (src.index) g.setIndex(src.index.clone());
  h = mergeVertices(g, 1e-3);
  h.computeVertexNormals();
  hulls.set(src, h);
  return h;
}

const mats = new Map<number, THREE.Material>();
/** flat ink-coloured material that pushes vertices out along their normals by `width` (local units) */
export function outlineMat(width: number): THREE.Material {
  const k = Math.round(width * 1000);
  let m = mats.get(k);
  if (!m) {
    const n = new THREE.MeshBasicNodeMaterial({ color: 0x120f1e, side: THREE.BackSide });
    n.positionNode = positionLocal.add(normalLocal.mul(float(width)));
    m = n; mats.set(k, m);
  }
  return m;
}
export interface OutlineSpec { geo: THREE.BufferGeometry; width: number }
