/** Character-builder preview: its own small renderer, alive only while the builder is open. */
import * as THREE from 'three/webgpu';
import { Hero, type HeroAssets, type Mode } from '../entities/hero';
import type { CharacterSpec } from '../entities/character';

export type Demo = 'idle' | 'walk' | 'run' | 'fly';

export class Preview {
  private r!: THREE.WebGPURenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  private assets: HeroAssets;
  private hero: Hero | null = null;
  private spec: CharacterSpec;
  private yaw = 0.5; private tYaw = 0.5; private zoom = 0; private tZoom = 0;
  private demo: Demo = 'idle';
  private userTurned = false;
  private raf = 0; private last = 0; private dead = false; private timer = 0;
  private ro?: ResizeObserver;
  private cleanup: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement, spec: CharacterSpec) {
    this.spec = spec;
    const ramp = new THREE.DataTexture(new Uint8Array([105, 178, 255]), 3, 1, THREE.RedFormat);
    ramp.minFilter = ramp.magFilter = THREE.NearestFilter; ramp.generateMipmaps = false; ramp.needsUpdate = true;
    this.assets = { ramp, rig: new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp }), pillarGlow: new THREE.MeshBasicMaterial({ color: 0x40e8ff }) };
    this.scene.background = new THREE.Color(0x2a2f58);
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x6a5a8a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(2, 4, 3); this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x8aa0ff, 1.0); rim.position.set(-3, 2, -3); this.scene.add(rim);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.1, 40), new THREE.MeshBasicMaterial({ color: 0x3a4075 }));
    floor.rotation.x = -Math.PI / 2; this.scene.add(floor);
    this.cleanup.push(() => { floor.geometry.dispose(); (floor.material as THREE.Material).dispose(); });
  }

  async start(): Promise<boolean> {
    try {
      this.r = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, forceWebGL: true });
      await this.r.init();
    } catch { return false; }
    if (this.dead) { this.r.dispose(); return false; }
    this.r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.resize();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.canvas);
    this.bindDrag();
    this.rebuild();
    this.last = performance.now();
    const loop = (t: number) => {
      if (this.dead) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - this.last) / 1000); this.last = t;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
    return true;
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 300, h = this.canvas.clientHeight || 300;
    this.r.setSize(w, h, false); this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
  }

  private bindDrag(): void {
    let down = false, x0 = 0;
    const d = (e: PointerEvent) => { down = true; this.userTurned = true; x0 = e.clientX; this.canvas.setPointerCapture(e.pointerId); };
    const m = (e: PointerEvent) => { if (!down) return; this.tYaw += (e.clientX - x0) * 0.012; x0 = e.clientX; };
    const u = () => { down = false; };
    this.canvas.addEventListener('pointerdown', d); this.canvas.addEventListener('pointermove', m);
    this.canvas.addEventListener('pointerup', u); this.canvas.addEventListener('pointercancel', u);
    this.cleanup.push(() => { this.canvas.removeEventListener('pointerdown', d); this.canvas.removeEventListener('pointermove', m); this.canvas.removeEventListener('pointerup', u); this.canvas.removeEventListener('pointercancel', u); });
  }

  /** debounced: sliders can fire many times a second */
  setSpec(spec: CharacterSpec): void {
    this.spec = spec;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.rebuild(), 60);
  }
  setDemo(d: Demo): void { this.demo = d; }
  /** 0 = full body, 1 = face close-up */
  setZoom(z: number): void { this.tZoom = z; this.tYaw = z > 0.5 ? Math.round(this.tYaw / (2 * Math.PI)) * 2 * Math.PI : this.tYaw; }

  private rebuild(): void {
    if (this.dead) return;
    this.hero?.dispose();
    try {
      this.hero = new Hero(this.assets, this.spec, true);
      this.scene.add(this.hero.root);
    } catch (e) { console.error('hero build failed', e); this.hero = null; }
  }

  private frame(dt: number): void {
    this.yaw += (this.tYaw - this.yaw) * Math.min(1, dt * 10);
    this.zoom += (this.tZoom - this.zoom) * Math.min(1, dt * 6);
    if (this.demo === 'idle' && !this.userTurned && Math.abs(this.tYaw - this.yaw) < 0.01) this.tYaw += dt * 0.15;
    const z = this.zoom, d = 4.6 - z * 3.65, ty = 0.9 + z * 0.68;
    this.cam.position.set(Math.sin(this.yaw) * d, ty + 0.15, Math.cos(this.yaw) * d);
    this.cam.lookAt(0, ty, 0);
    if (this.hero) {
      const mode: Mode = this.demo === 'fly' ? 'fly' : 'ground';
      const walk = this.demo === 'walk' || this.demo === 'run', v = this.demo === 'run' ? 7.8 : 3.6;
      this.hero.pose({ dt, mode, hs: walk ? v : 0, speed: this.demo === 'fly' ? 22 : walk ? v : 0, vy: 0, grounded: this.demo !== 'fly', boost: false, bank: 0 });
      this.hero.root.position.y = this.demo === 'fly' ? 0.4 : 0;
      this.hero.root.rotation.y = 0;
    }
    this.r.render(this.scene, this.cam);
  }

  dispose(): void {
    this.dead = true;
    cancelAnimationFrame(this.raf); clearTimeout(this.timer);
    this.ro?.disconnect();
    this.cleanup.forEach((f) => f());
    this.hero?.dispose();
    this.assets.ramp.dispose(); this.assets.rig.dispose(); this.assets.pillarGlow.dispose();
    try { this.r?.dispose(); } catch { /* already gone */ }
  }
}
