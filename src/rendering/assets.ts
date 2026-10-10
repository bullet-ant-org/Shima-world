/** Shared geometry + material library. Material budget: 11 materials for the whole world + character (crystal and lava are the only emissive additions, both for island identity). */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { vec3 } from 'three/tsl';
import { detailNode, surfaceTexture, terrainTexture, waterNode, waterTexture } from './textures';

export function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.setAttribute('kind', new THREE.BufferAttribute(new Float32Array(n), 1)); // texture channel (0 plaster / grass by default)
  return g;
}
export function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return paint(g, hex);
}
export function cyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg); g.translate(x, y, z); return paint(g, hex);
}

/** Painted facade atlas for far buildings: 8x8 cells of plaster with framed, reflective, curtained windows; separate emissive map for lit panes. */
function windowTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const S = 1024, N = 8, cell = S / N;
  const a = document.createElement('canvas'); a.width = a.height = S;
  const b = document.createElement('canvas'); b.width = b.height = S;
  const ca = a.getContext('2d')!, cb = b.getContext('2d')!;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) | 0) >>> 0) / 4294967295;
  // plaster base: warm off-white with soft blotches, fine grain, floor-line bands and faint weathering streaks
  ca.fillStyle = '#e8e3d9'; ca.fillRect(0, 0, S, S);
  for (let i = 0; i < 700; i++) { ca.fillStyle = `rgba(${150 + rnd() * 90 | 0},${145 + rnd() * 85 | 0},${135 + rnd() * 80 | 0},${0.05 + rnd() * 0.07})`; ca.beginPath(); ca.ellipse(rnd() * S, rnd() * S, 6 + rnd() * 30, 4 + rnd() * 20, rnd() * 3, 0, 7); ca.fill(); }
  for (let i = 0; i < 5000; i++) { ca.fillStyle = `rgba(90,85,80,${rnd() * 0.08})`; ca.fillRect(rnd() * S, rnd() * S, 1, 1 + rnd() * 2); }
  cb.fillStyle = '#000'; cb.fillRect(0, 0, S, S);
  const lit = ['#ffe0a8', '#ffd69a', '#fff0c8', '#ffcf8a', '#bfe6ff'];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = i * cell + 11, y = j * cell + 11, w = cell - 22, h = cell - 24;
    ca.fillStyle = 'rgba(70,60,55,0.18)'; ca.fillRect(i * cell, j * cell + cell - 4, cell, 4);                 // floor band shadow
    ca.fillStyle = '#f7f4ec'; ca.fillRect(x - 5, y - 5, w + 10, h + 10);                                          // frame
    ca.fillStyle = 'rgba(60,50,45,0.35)'; ca.fillRect(x - 7, y + h + 4, w + 14, 4);                              // sill + shadow
    const isLit = rnd() < 0.5;
    const g = ca.createLinearGradient(x, y, x + w, y + h);                                                        // glass: sky reflection
    g.addColorStop(0, '#7fb2d6'); g.addColorStop(0.55, '#3b6a92'); g.addColorStop(1, '#1f3a5c');
    ca.fillStyle = isLit ? '#caa56a' : g; ca.fillRect(x, y, w, h);
    if (!isLit) { ca.fillStyle = 'rgba(255,255,255,0.28)'; ca.beginPath(); ca.moveTo(x + 6, y + h); ca.lineTo(x + w * 0.5, y); ca.lineTo(x + w * 0.7, y); ca.lineTo(x + 22, y + h); ca.fill(); }
    const kind = rnd();
    if (kind < 0.22) { ca.fillStyle = 'rgba(235,225,205,0.8)'; ca.fillRect(x, y, w, h * (0.25 + rnd() * 0.4)); }   // blinds / curtain
    ca.fillStyle = '#d8d2c6'; ca.fillRect(x + w / 2 - 1, y, 2, h); ca.fillRect(x, y + h * 0.45, w, 2);          // mullions
    if (kind > 0.88) { ca.fillStyle = '#8a9099'; ca.fillRect(x + 4, y + h + 7, 18, 11); ca.fillStyle = '#6a7079'; ca.fillRect(x + 4, y + h + 7, 18, 3); } // AC unit
    if (isLit) { const e = cb.createLinearGradient(x, y, x, y + h); e.addColorStop(0, lit[Math.floor(rnd() * lit.length)]); e.addColorStop(1, '#ff9a4a'); cb.fillStyle = e; cb.fillRect(x, y, w, h); cb.fillStyle = '#000'; cb.fillRect(x + w / 2 - 1, y, 2, h); cb.fillRect(x, y + h * 0.45, w, 2); }
  }
  const mk = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  return { map: mk(a), emissive: mk(b) };
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
  private surfaceTex = surfaceTexture();
  private terrainTex = terrainTexture();
  /** painted ground: vertex colour x painted grass/sand/rock/snow detail (channel per vertex `kind`) */
  readonly terrain = (() => { const m = new THREE.MeshToonNodeMaterial({ vertexColors: true, gradientMap: this.ramp }); m.colorNode = detailNode(this.terrainTex, 1 / 11, 1 / 1.7); return m; })();
  /** painted architecture/props: vertex colour x plaster / wood grain / roof tile / stone masonry detail (per-vertex `kind`) */
  readonly props = (() => { const m = new THREE.MeshToonNodeMaterial({ vertexColors: true, gradientMap: this.ramp }); m.colorNode = detailNode(this.surfaceTex, 1 / 3.4, 1 / 0.85); return m; })();
  /** moving things (hero, cars): toon vertex colours with no world-space texture, so nothing swims */
  readonly rig = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: this.ramp });
  readonly glow = new THREE.MeshBasicMaterial({ color: 0xffffff });
  /** far-LOD facade: shared window atlas tinted per building by vertex colour */
  readonly building: THREE.MeshToonMaterial;
  /** all paved ground (gravel roads, sidewalks, flagstone paths) */
  readonly ground = (() => { const m = new THREE.MeshToonNodeMaterial({ vertexColors: true, gradientMap: this.ramp, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); m.colorNode = detailNode(this.terrainTex, 1 / 5, 1 / 1.1); return m; })();
  /** unlit vertex-colour emissives: lit windows, neon, lantern flames, beacons */
  readonly lights = new THREE.MeshBasicMaterial({ vertexColors: true });
  readonly road = new THREE.MeshStandardMaterial({ color: 0x14161f, roughness: 0.7 });
  /** animated rippling sea: two drifting painted ripple layers + glints */
  readonly sea = (() => { const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.05, transparent: true, opacity: 0.9 }); m.colorNode = waterNode(waterTexture()).mul(vec3(0.07, 0.4, 0.58)); return m; })();
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
