/** Shared geometry + material library. Material budget: 11 materials for the whole world + character (crystal and lava are the only emissive additions, both for island identity). */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
export function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return paint(g, hex);
}
export function cyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg); g.translate(x, y, z); return paint(g, hex);
}

function windowTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const S = 256, N = 8, cell = S / N;
  const a = document.createElement('canvas'); a.width = a.height = S;
  const b = document.createElement('canvas'); b.width = b.height = S;
  const ca = a.getContext('2d')!, cb = b.getContext('2d')!;
  ca.fillStyle = '#e9e4da'; ca.fillRect(0, 0, S, S);
  cb.fillStyle = '#000'; cb.fillRect(0, 0, S, S);
  const lit = ['#ffd9a0', '#ffe6b8', '#ffd9a0', '#9fdfff'];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) | 0) >>> 0) / 4294967295;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = i * cell + 6, y = j * cell + 7, w = cell - 12, h = cell - 14;
    if (rnd() < 0.55) {
      const col = lit[Math.floor(rnd() * lit.length)];
      ca.fillStyle = col; ca.fillRect(x, y, w, h);
      cb.fillStyle = col; cb.fillRect(x, y, w, h);
    } else { ca.fillStyle = '#34506a'; ca.fillRect(x, y, w, h); }
  }
  const mk = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: mk(a, true), emissive: mk(b, true) };
}

/** 3-band cel ramp: shade / mid / light. Nearest filtering gives hard anime bands instead of smooth gradients. */
function toonRamp(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([105, 178, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}

export class Assets {
  readonly ramp = toonRamp();
  // materials
  readonly terrain = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: this.ramp });
  readonly props = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: this.ramp });
  readonly glow = new THREE.MeshBasicMaterial({ color: 0xffffff });
  /** far-LOD facade: shared window atlas tinted per building by vertex colour */
  readonly building: THREE.MeshToonMaterial;
  /** all paved ground (gravel roads, sidewalks, flagstone paths) */
  readonly ground = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: this.ramp, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  /** unlit vertex-colour emissives: lit windows, neon, lantern flames, beacons */
  readonly lights = new THREE.MeshBasicMaterial({ vertexColors: true });
  readonly road = new THREE.MeshStandardMaterial({ color: 0x14161f, roughness: 0.7 });
  readonly sea = new THREE.MeshStandardMaterial({ color: 0x0b3a5a, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.88 });
  readonly agents = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: this.ramp });
  /** people: toon vertex colours where white = tintable clothing */
  readonly folk = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: this.ramp });
  readonly pillar = new THREE.MeshToonMaterial({ color: 0x8a94a4, gradientMap: this.ramp });
  readonly pillarGlow = new THREE.MeshBasicMaterial({ color: 0x40e8ff });
  readonly crystal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.2, flatShading: true, emissive: new THREE.Color(0x2ad0ff), emissiveIntensity: 0.3 });
  readonly lava = new THREE.MeshBasicMaterial({ color: 0xff5a1a });

  // geometries (shared by every chunk)
  readonly tree: THREE.BufferGeometry;
  readonly house: THREE.BufferGeometry;
  readonly torii: THREE.BufferGeometry;
  readonly pole: THREE.BufferGeometry;
  readonly column: THREE.BufferGeometry;
  readonly pine: THREE.BufferGeometry;
  readonly cedar: THREE.BufferGeometry;
  readonly deadTree: THREE.BufferGeometry;
  readonly crystalGeo: THREE.BufferGeometry;
  readonly lantern: THREE.BufferGeometry;
  readonly bridge: THREE.BufferGeometry;
  readonly disc = new THREE.CylinderGeometry(1, 1, 1, 12);
  readonly rock = new THREE.BoxGeometry(1, 1, 1);
  readonly orb = new THREE.SphereGeometry(0.4, 6, 4);
  readonly sign = new THREE.BoxGeometry(4, 1.4, 0.25);
  readonly roadStrip = new THREE.BoxGeometry(1, 0.3, 1);
  readonly person: THREE.BufferGeometry;
  readonly car: THREE.BufferGeometry;

  private tex = windowTextures();

  constructor() {
    this.building = new THREE.MeshToonMaterial({
      map: this.tex.map, emissiveMap: this.tex.emissive, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.05, vertexColors: true, gradientMap: this.ramp,
    });

    this.tree = mergeGeometries([
      cyl(0.35, 0.6, 5, 6, 0, 2.5, 0, 0x5a3b28),
      (() => { const g = new THREE.SphereGeometry(4, 8, 6); g.scale(1, 0.8, 1); g.translate(0, 7.2, 0); return paint(g, 0xffb2cf); })(),
    ])!;

    const roof = new THREE.ConeGeometry(6.4, 3.4, 4); roof.rotateY(Math.PI / 4); roof.translate(0, 5.7, 0);
    this.house = mergeGeometries([
      box(8, 4, 6, 0, 2, 0, 0xe9dfc8),
      paint(roof, 0x2a3350),
      box(8.2, 0.25, 0.3, 0, 3.4, 3.05, 0x28e0ff), // hidden cyber conduit trim
      box(1.2, 2.2, 0.2, 2, 1.1, 3.05, 0x6b4a33),
    ])!;

    this.torii = mergeGeometries([
      cyl(0.5, 0.55, 10, 8, -4, 5, 0, 0xd8322f),
      cyl(0.5, 0.55, 10, 8, 4, 5, 0, 0xd8322f),
      box(13, 0.9, 1.1, 0, 10.2, 0, 0x151515),
      box(10, 0.55, 0.8, 0, 8, 0, 0xd8322f),
    ])!;

    this.pole = mergeGeometries([box(0.25, 7, 0.25, 0, 3.5, 0, 0x30333f), box(0.2, 0.2, 1.6, 0, 7, 0.8, 0x30333f)])!;
    this.column = cyl(1.1, 1.5, 1, 7, 0, 0.5, 0, 0x8d9096);

    const cone = (r: number, h: number, y: number, hex: number, seg = 7) => { const g = new THREE.ConeGeometry(r, h, seg); g.translate(0, y, 0); return paint(g, hex); };
    this.pine = mergeGeometries([cyl(0.3, 0.45, 2.5, 5, 0, 1.25, 0, 0x4a3426), cone(4, 4, 4.2, 0x1f4a3a), cone(3.1, 3.6, 6.4, 0x2a5e48), cone(2.1, 3.4, 8.5, 0xe8f2ff)])!;
    this.cedar = mergeGeometries([cyl(0.35, 0.5, 3, 5, 0, 1.5, 0, 0x4b3524), cone(3, 14, 9, 0x1c4a2c)])!;
    this.deadTree = mergeGeometries([
      cyl(0.25, 0.5, 6, 5, 0, 3, 0, 0x2b2326),
      (() => { const g = new THREE.BoxGeometry(0.2, 3, 0.2); g.rotateZ(0.9); g.translate(1, 5.5, 0); return paint(g, 0x2b2326); })(),
      (() => { const g = new THREE.BoxGeometry(0.2, 2.6, 0.2); g.rotateZ(-0.8); g.translate(-0.9, 4.6, 0); return paint(g, 0x2b2326); })(),
    ])!;
    { const g = new THREE.OctahedronGeometry(1, 0); g.scale(1, 3, 1); g.translate(0, 3, 0); this.crystalGeo = paint(g, 0xa6ecff); }
    this.lantern = mergeGeometries([
      cyl(0.7, 0.9, 0.4, 6, 0, 0.2, 0, 0x8d9096), cyl(0.25, 0.3, 1.8, 6, 0, 1.3, 0, 0x9a9da4),
      box(1.1, 0.9, 1.1, 0, 2.6, 0, 0xffd9a0), cone(1.1, 0.8, 3.45, 0x6c6f78, 4),
    ])!;
    this.bridge = mergeGeometries([
      box(76, 0.5, 5.5, 0, 0, 0, 0x6b4a33), box(76, 0.35, 0.35, 0, 1.2, 2.6, 0xd8322f), box(76, 0.35, 0.35, 0, 1.2, -2.6, 0xd8322f),
      ...[-36, -18, 0, 18, 36].flatMap((x) => [box(0.4, 1.3, 0.4, x, 0.65, 2.6, 0xd8322f), box(0.4, 1.3, 0.4, x, 0.65, -2.6, 0xd8322f)]),
    ])!;

    // pedestrian: small anime figure. Clothing is white in the vertex colours so the per-instance colour tints jacket + trousers accents.
    {
      const part = (g: THREE.BufferGeometry, hexc: number) => { g.deleteAttribute('uv'); return paint(g, hexc); };
      const ell = (rx: number, ry: number, rz: number, x: number, y: number, z: number, hexc: number) => { const g = new THREE.SphereGeometry(1, 9, 7); g.scale(rx, ry, rz); g.translate(x, y, z); return part(g, hexc); };
      const tub = (rt: number, rb: number, h: number, x: number, y: number, z: number, hexc: number) => { const g = new THREE.CylinderGeometry(rt, rb, h, 8); g.translate(x, y, z); return part(g, hexc); };
      this.person = mergeGeometries([
        tub(0.075, 0.06, 0.78, -0.09, 0.47, 0, 0x2b3045), tub(0.075, 0.06, 0.78, 0.09, 0.47, 0, 0x2b3045), ell(0.07, 0.04, 0.12, -0.09, 0.05, 0.03, 0x15161c), ell(0.07, 0.04, 0.12, 0.09, 0.05, 0.03, 0x15161c),
        ell(0.2, 0.3, 0.12, 0, 1.2, 0, 0xffffff), ell(0.17, 0.12, 0.11, 0, 0.92, 0, 0x2b3045),
        tub(0.05, 0.04, 0.55, -0.27, 1.16, 0, 0xffffff), tub(0.05, 0.04, 0.55, 0.27, 1.16, 0, 0xffffff), ell(0.045, 0.05, 0.045, -0.27, 0.85, 0, 0xffd6bd), ell(0.045, 0.05, 0.045, 0.27, 0.85, 0, 0xffd6bd),
        tub(0.045, 0.05, 0.1, 0, 1.52, 0, 0xffd6bd), ell(0.125, 0.14, 0.13, 0, 1.68, 0, 0xffd6bd), ell(0.135, 0.12, 0.14, 0, 1.74, -0.015, 0x2a2438), ell(0.14, 0.05, 0.1, 0, 1.78, 0.05, 0x2a2438),
        ell(0.022, 0.03, 0.01, -0.05, 1.67, 0.122, 0x1a2a4a), ell(0.022, 0.03, 0.01, 0.05, 1.67, 0.122, 0x1a2a4a),
      ])!;
    }
    this.car = mergeGeometries([
      new THREE.BoxGeometry(4.2, 1.0, 1.9).translate(0, 0.7, 0),
      new THREE.BoxGeometry(2.2, 0.8, 1.6).translate(-0.2, 1.5, 0),
    ])!;
  }

  setWireframe(on: boolean): void {
    for (const m of [this.terrain, this.props, this.building, this.road, this.agents, this.pillar, this.crystal, this.ground, this.lights]) m.wireframe = on;
  }

  /** night in 0..1 drives emissive + glow materials */
  setNight(night: number): void {
    this.building.emissiveIntensity = 0.03 + 2.2 * night;
    this.lights.color.setScalar(0.1 + 1.15 * night);
    this.glow.color.setScalar(0.35 + 0.9 * night);
    this.pillarGlow.color.setRGB(0.25 + 0.5 * night, 0.9, 1);
    this.crystal.emissiveIntensity = 0.25 + 1.4 * night;
    this.lava.color.setRGB(0.85 + 0.15 * night, 0.3 + 0.12 * night, 0.08);
  }
}
