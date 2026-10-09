/** Device profiling + independently scalable quality settings + dynamic resolution. */

export type Preset = 'adaptive' | 'low' | 'medium' | 'high';
export const PRESETS: Preset[] = ['adaptive', 'low', 'medium', 'high'];

/** Every field scales on its own; there is no single master quality switch. */
export interface Quality {
  resScale: number;     // max render resolution multiplier
  viewRings: number;    // streaming radius in chunks (view distance)
  shadows: boolean;
  shadowMap: number;
  npc: number;
  traffic: number;
  rain: number;         // max rain particles
  fogFar: number;
  outlines: 'hero' | 'all' | 'off'; // ink outlines: character only (default, cheap), everything, or none
  detailWindows: boolean; // protruding window geometry on nearby buildings (off: textured facades only)
}

export interface DeviceProfile {
  gpuTier: 'low' | 'mid' | 'high';
  cpuTier: 'low' | 'mid' | 'high';
  ramTier: 'low' | 'mid' | 'high';
  webgpu: boolean;
  dpr: number;
  maxTex: number;
  screen: string;
  preset: Preset;
  q: Quality;
}

const tier = (v: number, lo: number, hi: number): 'low' | 'mid' | 'high' => (v >= hi ? 'high' : v >= lo ? 'mid' : 'low');

export function qualityFor(gpu: DeviceProfile['gpuTier'], cpu: DeviceProfile['cpuTier'], preset: Preset): Quality {
  // GPU-bound knobs follow the GPU tier, CPU-bound knobs (NPC/traffic) follow the CPU tier.
  const g = preset === 'adaptive' ? gpu : preset === 'low' ? 'low' : preset === 'medium' ? 'mid' : 'high';
  const c = preset === 'adaptive' ? cpu : g;
  return {
    resScale: g === 'high' ? 1 : g === 'mid' ? 0.85 : 0.7,
    viewRings: g === 'high' ? 4 : g === 'mid' ? 3 : 2, // far terrain + resident skyline cover the distance, so streamed chunks can stay close
    shadows: g !== 'low',
    shadowMap: g === 'high' ? 2048 : 1024,
    outlines: 'hero',
    npc: c === 'high' ? 150 : c === 'mid' ? 70 : 36,
    traffic: c === 'high' ? 40 : c === 'mid' ? 22 : 10,
    rain: g === 'high' ? 2400 : g === 'mid' ? 1400 : 600,
    fogFar: g === 'high' ? 1300 : g === 'mid' ? 1000 : 750,
    detailWindows: g === 'high',
  };
}

export async function profileDevice(): Promise<DeviceProfile> {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  let webgpu = false;
  let maxTex = 4096;
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ limits: { maxTextureDimension2D: number } } | null> } }).gpu;
  if (gpu) {
    try {
      const a = await gpu.requestAdapter();
      if (a) { webgpu = true; maxTex = a.limits.maxTextureDimension2D; }
    } catch { /* ignore */ }
  }
  if (!webgpu) {
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (gl) maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    } catch { /* ignore */ }
  }
  const cpuTier = tier(cores, 4, 8);
  const ramTier = tier(mem, 3, 6);
  let gpuTier: DeviceProfile['gpuTier'] = maxTex >= 16384 ? 'high' : maxTex >= 8192 ? 'mid' : 'low';
  if (gpuTier === 'high' && (cpuTier === 'low' || ramTier === 'low')) gpuTier = 'mid';
  const preset: Preset = 'adaptive';
  return {
    gpuTier, cpuTier, ramTier, webgpu,
    dpr: window.devicePixelRatio || 1,
    maxTex,
    screen: `${screen.width}x${screen.height}`,
    preset,
    q: qualityFor(gpuTier, cpuTier, preset),
  };
}

export function applyPreset(p: DeviceProfile, preset: Preset): void {
  p.preset = preset;
  p.q = qualityFor(p.gpuTier, p.cpuTier, preset);
}

/** Smooth stepwise resolution scaling: 1.0 .. 0.7. Never jumps more than one step per second. */
export class DynamicResolution {
  static STEPS = [1, 0.95, 0.9, 0.85, 0.8, 0.7];
  private idx = 0;
  private ewma = 16.7;
  private acc = 0;
  private goodFor = 0;
  constructor(public cap = 1) { this.idx = DynamicResolution.STEPS.findIndex((s) => s <= cap); if (this.idx < 0) this.idx = 0; }

  get scale(): number { return Math.min(DynamicResolution.STEPS[this.idx], this.cap); }
  get avgMs(): number { return this.ewma; }

  setCap(cap: number): void {
    this.cap = cap;
    const i = DynamicResolution.STEPS.findIndex((s) => s <= cap);
    if (i > this.idx) this.idx = i;
  }

  /** returns true when the scale changed */
  update(frameMs: number, targetMs = 16.7): boolean {
    this.ewma += (frameMs - this.ewma) * 0.08;
    this.acc += frameMs;
    if (this.acc < 1000) return false;
    this.acc = 0;
    const floor = DynamicResolution.STEPS.findIndex((s) => s <= this.cap);
    if (this.ewma > targetMs * 1.15 && this.idx < DynamicResolution.STEPS.length - 1) {
      this.idx++; this.goodFor = 0; return true;
    }
    if (this.ewma < targetMs * 0.85) {
      this.goodFor++;
      if (this.goodFor >= 3 && this.idx > floor) { this.idx--; this.goodFor = 0; return true; }
    } else this.goodFor = 0;
    return false;
  }
}
