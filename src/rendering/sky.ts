/**
 * Anime sky: a vertex-gradient dome (horizon -> zenith), a sun disc with halo, a moon, and a field of puffy toon clouds
 * that drift on the wind and wrap around the camera so the sky is always full. 3 + 2 draw calls in total.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../world/terrain';

const R = 8000, CLOUDS = 46, FIELD = 14000;

export class Sky {
  readonly group = new THREE.Group();
  private dome: THREE.Mesh; private domeCol: Float32Array; private domeY: Float32Array;
  private clouds: THREE.InstancedMesh; private cx: Float32Array; private cz: Float32Array; private cy: Float32Array; private cs: Float32Array; private cr: Float32Array;
  private sun: THREE.Mesh; private halo: THREE.Mesh; private moon: THREE.Mesh;
  private cloudMat: THREE.MeshToonMaterial;
  private wind = 0;
  private tmp = new THREE.Object3D();
  private zen = new THREE.Color(); private hor = new THREE.Color();

  constructor(ramp: THREE.Texture) {
    const g = new THREE.SphereGeometry(R, 28, 16);
    const n = g.attributes.position.count;
    this.domeCol = new Float32Array(n * 3); this.domeY = new Float32Array(n);
    for (let i = 0; i < n; i++) this.domeY[i] = g.attributes.position.getY(i) / R;
    g.setAttribute('color', new THREE.BufferAttribute(this.domeCol, 3));
    this.dome = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.dome.renderOrder = -10; this.dome.frustumCulled = false;
    this.group.add(this.dome);

    // puffy cloud = flat-bottomed cluster of squashed spheres
    const blobs: THREE.BufferGeometry[] = [];
    const rr = mulberry32(5);
    const add = (x: number, y: number, z: number, r: number) => {
      const s = new THREE.SphereGeometry(r, 9, 6); s.scale(1, 0.72, 1); s.translate(x, y, z);
      s.deleteAttribute('uv'); blobs.push(s.toNonIndexed());
    };
    add(0, 0.5, 0, 1); add(1.1, 0.35, 0.1, 0.8); add(-1.1, 0.3, -0.1, 0.78); add(0.4, 0.95, 0.1, 0.72); add(-0.5, 0.85, 0, 0.6); add(1.9, 0.2, 0, 0.55); add(-1.8, 0.2, 0.05, 0.5);
    void rr;
    const cg = mergeGeometries(blobs)!;
    // flatten the underside so clouds sit like painted cut-outs
    const p = cg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setY(i, p.getY(i) * 0.25);
    cg.computeVertexNormals();
    this.cloudMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: ramp, fog: false });
    this.clouds = new THREE.InstancedMesh(cg, this.cloudMat, CLOUDS);
    this.clouds.frustumCulled = false; this.clouds.renderOrder = -5;
    this.cx = new Float32Array(CLOUDS); this.cz = new Float32Array(CLOUDS); this.cy = new Float32Array(CLOUDS); this.cs = new Float32Array(CLOUDS); this.cr = new Float32Array(CLOUDS);
    const r = mulberry32(77);
    for (let i = 0; i < CLOUDS; i++) {
      this.cx[i] = r() * FIELD; this.cz[i] = r() * FIELD; this.cy[i] = 700 + r() * 900; this.cs[i] = 160 + r() * 260; this.cr[i] = r() * 6.28;
    }
    this.group.add(this.clouds);

    const disc = (radius: number, color: number, opacity: number, additive: boolean) => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 32), new THREE.MeshBasicMaterial({
        color, fog: false, depthWrite: false, transparent: opacity < 1, opacity, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      }));
      m.frustumCulled = false; m.renderOrder = -8; this.group.add(m); return m;
    };
    this.sun = disc(330, 0xfff3c4, 1, false); this.halo = disc(1100, 0xffc880, 0.28, true); this.moon = disc(240, 0xdfe8ff, 1, false);
  }

  /** horizon = fog/sky colour, sunDir points from the world toward the sun (y = true elevation) */
  update(dt: number, cam: THREE.Vector3, horizon: THREE.Color, night: number, sunDir: THREE.Vector3, rain: number): void {
    this.group.position.copy(cam);
    this.hor.copy(horizon);
    if ((this.tick++ & 3) === 0) this.paintDome(night);
    this.placeSky(dt, cam, night, sunDir, rain);
  }

  private tick = 0;
  private paintDome(night: number): void {
    // zenith: deeper and more saturated than the horizon in daytime, near-black at night
    this.zen.copy(this.hor).multiplyScalar(0.62); this.zen.r *= 0.82; this.zen.g *= 0.95; this.zen.b = Math.min(1, this.zen.b * 1.18 + 0.05 * (1 - night));
    const c = this.domeCol, y = this.domeY;
    for (let i = 0; i < y.length; i++) {
      const t = Math.pow(Math.max(0, y[i]), 0.6), j = i * 3;
      c[j] = this.hor.r + (this.zen.r - this.hor.r) * t; c[j + 1] = this.hor.g + (this.zen.g - this.hor.g) * t; c[j + 2] = this.hor.b + (this.zen.b - this.hor.b) * t;
    }
    (this.dome.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    void night;
  }

  private placeSky(dt: number, cam: THREE.Vector3, night: number, sunDir: THREE.Vector3, rain: number): void {

    // sun + moon discs on the sky sphere, always facing the camera
    const place = (m: THREE.Mesh, dir: THREE.Vector3, visible: boolean) => {
      m.visible = visible;
      if (!visible) return;
      m.position.copy(dir).multiplyScalar(R * 0.92); m.lookAt(0, 0, 0);
    };
    const sd = sunDir, md = this.tmpV.copy(sunDir).negate();
    place(this.sun, sd, sd.y > -0.08 && rain < 0.7); place(this.halo, sd, sd.y > -0.08 && rain < 0.7); place(this.moon, md, md.y > -0.08 && rain < 0.7);
    (this.sun.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.95 - 0.2 * (1 - Math.min(1, sd.y * 3)), 0.78 - 0.35 * (1 - Math.min(1, sd.y * 3)));

    // clouds: drift with the wind, wrap around the camera
    this.wind += dt * 18;
    const o = this.tmp, half = FIELD / 2;
    for (let i = 0; i < CLOUDS; i++) {
      const x = ((((this.cx[i] + this.wind - cam.x) % FIELD) + FIELD) % FIELD) - half, z = ((((this.cz[i] + this.wind * 0.35 - cam.z) % FIELD) + FIELD) % FIELD) - half;
      o.position.set(x, this.cy[i] - cam.y * 0, z); o.rotation.set(0, this.cr[i], 0); o.scale.set(this.cs[i], this.cs[i] * 0.6, this.cs[i] * 0.8); o.updateMatrix();
      this.clouds.setMatrixAt(i, o.matrix);
    }
    this.clouds.instanceMatrix.needsUpdate = true;
    const day = 1 - night;
    this.cloudMat.color.setRGB(0.32 + 0.68 * day, 0.36 + 0.64 * day, 0.55 + 0.45 * day).multiplyScalar(1 - rain * 0.35);
  }
  private tmpV = new THREE.Vector3();
}
