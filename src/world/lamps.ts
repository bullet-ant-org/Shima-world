/**
 * Working street lights. At dusk every street lamp and stone lantern near the player throws a warm pool of light on the
 * ground (one instanced additive decal per lamp), and the closest few hold real point lights that light up the
 * pavement, walls, cars and people. The light count is fixed (lights are dimmed to zero by day rather than removed),
 * so switching day/night never forces shaders to recompile.
 */
import * as THREE from 'three/webgpu';
import { PROPS } from './layout';
import { heightAt } from './terrain';

interface Lamp { x: number; y: number; z: number; r: number; warm: number }

export class StreetLights {
  readonly group = new THREE.Group();
  private lamps: Lamp[] = [];
  private pools: THREE.InstancedMesh;
  private lights: THREE.PointLight[] = [];
  private lastX = 1e9; private lastZ = 1e9; private near: Lamp[] = [];
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)); private v = new THREE.Vector3(); private s = new THREE.Vector3();

  constructor(maxLights: number) {
    const head = (d: { x: number; z: number; ry: number }, up: number, out: number) => ({ x: d.x + Math.sin(d.ry) * out, z: d.z + Math.cos(d.ry) * out, up });
    for (const d of PROPS.lamp ?? []) { const h = head(d, 8.1, 2.1); this.lamps.push({ x: h.x, z: h.z, y: heightAt(h.x, h.z) + h.up, r: 7.5, warm: 0 }); }
    for (const d of PROPS.toro ?? []) this.lamps.push({ x: d.x, z: d.z, y: heightAt(d.x, d.z) + 1.4 * d.s, r: 3.2, warm: 1 });
    for (const d of PROPS.toroBig ?? []) this.lamps.push({ x: d.x, z: d.z, y: heightAt(d.x, d.z) + 2.6 * d.s, r: 5, warm: 1 });
    const tex = (() => {                                                   // soft radial falloff
      const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d')!;
      const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0xffc070, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), mat, 400);
    this.pools.count = 0; this.pools.frustumCulled = false; this.pools.renderOrder = 2;
    this.group.add(this.pools);
    for (let i = 0; i < maxLights; i++) { const l = new THREE.PointLight(0xffc27a, 0, 26, 1.6); l.castShadow = false; this.lights.push(l); this.group.add(l); }
  }

  update(px: number, pz: number, night: number): void {
    const mat = this.pools.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.42 * night;
    this.pools.visible = night > 0.02;
    if (Math.hypot(px - this.lastX, pz - this.lastZ) > 30) {
      this.lastX = px; this.lastZ = pz;
      this.near = this.lamps.filter((l) => Math.abs(l.x - px) < 260 && Math.abs(l.z - pz) < 260)
        .sort((a, b) => (a.x - px) ** 2 + (a.z - pz) ** 2 - ((b.x - px) ** 2 + (b.z - pz) ** 2)).slice(0, 400);
      this.near.forEach((l, i) => {
        const gy = heightAt(l.x, l.z) + (l.warm ? 0.06 : 0.36);
        this.m.compose(this.v.set(l.x, gy, l.z), this.q, this.s.set(l.r, l.r, 1)); this.pools.setMatrixAt(i, this.m);
      });
      this.pools.count = this.near.length; this.pools.instanceMatrix.needsUpdate = true;
    }
    this.lights.forEach((L, i) => {
      const l = this.near[i];
      if (!l || night < 0.02) { L.intensity = 0; return; }
      L.position.set(l.x, l.y - 0.4, l.z); L.intensity = (l.warm ? 14 : 40) * night; L.distance = l.warm ? 12 : 26;
      L.color.setHex(l.warm ? 0xffa050 : 0xffd29a);
    });
  }
}
