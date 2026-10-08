/** Rendering abstraction: gameplay code only talks to GameRenderer, never to a specific graphics API. */
import * as THREE from 'three/webgpu';

export class GameRenderer {
  readonly renderer: THREE.WebGPURenderer;
  backend = 'WebGL2';
  private scale = 1;
  private basePR: number;

  private constructor(renderer: THREE.WebGPURenderer, dpr: number) {
    this.renderer = renderer;
    this.basePR = Math.min(dpr, 2);
  }

  static async create(canvas: HTMLCanvasElement, webgpuSupported: boolean, dpr: number): Promise<GameRenderer> {
    const r = new THREE.WebGPURenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      forceWebGL: !webgpuSupported,
    });
    await r.init();
    const gr = new GameRenderer(r, dpr);
    const be = (r as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
    gr.backend = be?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    gr.resize();
    window.addEventListener('resize', () => gr.resize());
    return gr;
  }

  setScale(s: number): void { this.scale = s; this.resize(); }

  resize(): void {
    this.renderer.setPixelRatio(this.basePR * this.scale);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  get aspect(): number { return window.innerWidth / Math.max(1, window.innerHeight); }

  render(scene: THREE.Scene, camera: THREE.Camera): void { this.renderer.render(scene, camera); }

  setAnimationLoop(fn: (t: number) => void): void { this.renderer.setAnimationLoop(fn); }

  get info(): { calls: number; triangles: number; geometries: number; textures: number } {
    const i = this.renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures };
  }
}
