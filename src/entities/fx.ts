/** Cheap flight FX: pooled particles (one draw call each), streaming speed lines, ground hover ring. No per-frame allocation. */
import * as THREE from 'three/webgpu';

/** Ring-buffer particle pool rendered as additive points. Colour fades to black with age, so no alpha channel is needed. */
export class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array; private col: Float32Array; private vel: Float32Array; private life: Float32Array; private max: Float32Array; private base: Float32Array;
  private head = 0; private alive = 0;
  constructor(private n: number, size: number, private gravity = 0, private drag = 1) {
    this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 3); this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n); this.max = new Float32Array(n).fill(1); this.base = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = -9999;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({
      size, vertexColors: true, sizeAttenuation: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    this.points.frustumCulled = false;
  }
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, r: number, g: number, b: number): void {
    const i = this.head; this.head = (i + 1) % this.n;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.alive = Math.max(this.alive, life); this.life[i] = life; this.max[i] = life; this.base[i * 3] = r; this.base[i * 3 + 1] = g; this.base[i * 3 + 2] = b;
  }
  update(dt: number): void {
    if (this.alive <= 0) return; // nothing alive: skip the whole loop and the buffer uploads
    this.alive -= dt;
    const d = Math.pow(this.drag, dt * 60);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { if (this.col[i * 3] !== 0) { this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 0; } continue; }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.max[i]), j = i * 3;
      this.vel[j + 1] -= this.gravity * dt;
      this.vel[j] *= d; this.vel[j + 1] *= d; this.vel[j + 2] *= d;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      this.col[j] = this.base[j] * k; this.col[j + 1] = this.base[j + 1] * k; this.col[j + 2] = this.base[j + 2] * k;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Streaks that rush past the camera opposite to the flight direction; visible only at speed. */
export class SpeedLines {
  readonly lines: THREE.LineSegments;
  private pos: Float32Array; private p: Float32Array;
  private mat = new THREE.LineBasicMaterial({ color: 0xdff6ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  constructor(private n = 70) {
    this.pos = new Float32Array(n * 6); this.p = new Float32Array(n * 3);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.lines = new THREE.LineSegments(g, this.mat);
    this.lines.frustumCulled = false; this.lines.visible = false;
    for (let i = 0; i < n; i++) this.respawn(i, 0, 0, 0, 0, 0, 1, true);
  }
  private respawn(i: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, anywhere: boolean): void {
    // random point in a ring around the view axis, ahead of the camera
    const a = Math.random() * 6.283, r = 3 + Math.random() * 14, ahead = anywhere ? Math.random() * 60 : 40 + Math.random() * 40;
    // build a basis perpendicular to the flight direction
    let ux = -dz, uz = dx; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
    const vx = dy * uz, vy = dz * ux - dx * uz, vz = -dy * ux;
    const cs = Math.cos(a) * r, sn = Math.sin(a) * r;
    this.p[i * 3] = cx + dx * ahead + ux * cs + vx * sn;
    this.p[i * 3 + 1] = cy + dy * ahead + vy * sn;
    this.p[i * 3 + 2] = cz + dz * ahead + uz * cs + vz * sn;
  }
  /** (vx,vy,vz) = flight velocity; camera position drives recycling */
  update(dt: number, speed: number, vx: number, vy: number, vz: number, cx: number, cy: number, cz: number): void {
    const on = speed > 24;
    this.lines.visible = on;
    if (!on) return;
    this.mat.opacity = Math.min(0.7, (speed - 24) / 60);
    const inv = 1 / speed, dx = vx * inv, dy = vy * inv, dz = vz * inv, len = Math.min(14, speed * 0.1);
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      this.p[k] -= vx * dt * 1.2; this.p[k + 1] -= vy * dt * 1.2; this.p[k + 2] -= vz * dt * 1.2;
      const rx = this.p[k] - cx, ry = this.p[k + 1] - cy, rz = this.p[k + 2] - cz;
      if (rx * dx + ry * dy + rz * dz < -12 || rx * rx + ry * ry + rz * rz > 9000) this.respawn(i, cx, cy, cz, dx, dy, dz, false);
      const j = i * 6;
      this.pos[j] = this.p[k]; this.pos[j + 1] = this.p[k + 1]; this.pos[j + 2] = this.p[k + 2];
      this.pos[j + 3] = this.p[k] + dx * len; this.pos[j + 4] = this.p[k + 1] + dy * len; this.pos[j + 5] = this.p[k + 2] + dz * len;
    }
    (this.lines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Glowing ring projected on the ground under a hovering/flying character. */
export class HoverRing {
  readonly mesh: THREE.Mesh;
  private mat = new THREE.MeshBasicMaterial({ color: 0x40e8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  constructor() {
    const g = new THREE.RingGeometry(0.85, 1.0, 28); g.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.visible = false; this.mesh.frustumCulled = false;
  }
  update(on: boolean, x: number, groundY: number, z: number, height: number, t: number): void {
    this.mesh.visible = on && height < 40;
    if (!this.mesh.visible) return;
    const s = 1.2 + height * 0.12 + Math.sin(t * 5) * 0.1;
    this.mesh.position.set(x, groundY + 0.15, z); this.mesh.scale.setScalar(s);
    this.mat.opacity = 0.75 * (1 - height / 40);
  }
}
