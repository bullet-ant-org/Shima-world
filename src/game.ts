/** Game: owns the loop, the scene and every system. Loop order: input -> network -> simulation -> visibility -> animation -> render. */
import * as THREE from 'three/webgpu';
import { GameRenderer } from './rendering/renderer';
import { Assets } from './rendering/assets';
import { World } from './world/world';
import { NpcSystem, Player, RemotePlayers, TrafficSystem } from './entities/entities';
import { Input } from './core/input';
import { Network } from './network/network';
import { DynamicResolution, type DeviceProfile } from './core/device';
import { ISLANDS, blocked, heightAt, islandAt, sstep, zoneAt, type IslandId } from './world/terrain';
import { kvSet } from './core/store';

export interface SaveData { x: number; z: number; time: number }

/** Per-island atmosphere: fog tint strength, fog distance multiplier, and whether it snows. */
const ATMOS: Record<IslandId, { tint: THREE.Color; amt: number; fog: number; snow: boolean }> = {
  valley: { tint: new THREE.Color(0xffc9dc), amt: 0.1, fog: 1, snow: false },
  city: { tint: new THREE.Color(0x6a4cff), amt: 0.08, fog: 1, snow: false },
  god: { tint: new THREE.Color(0xf0e2c0), amt: 0.35, fog: 0.8, snow: false },
  ember: { tint: new THREE.Color(0x8a2410), amt: 0.5, fog: 0.8, snow: false },
  snow: { tint: new THREE.Color(0xe2f0ff), amt: 0.5, fog: 0.6, snow: true },
};
const TINT = new THREE.Color();
const SKY_DAY = new THREE.Color(0x8fcbff), SKY_DUSK = new THREE.Color(0xff9a6b), SKY_NIGHT = new THREE.Color(0x050818);
const SUN_DAY = new THREE.Color(0xfff2dd), SUN_DUSK = new THREE.Color(0xff9d5c), MOON = new THREE.Color(0x7d9cff);

export class Game {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.3, 9000);
  private gr!: GameRenderer;
  private assets = new Assets();
  private world!: World;
  private player!: Player;
  private npc!: NpcSystem;
  private traffic!: TrafficSystem;
  private remotes!: RemotePlayers;
  private net = new Network();
  private input!: Input;
  private dyn: DynamicResolution;
  private sun = new THREE.DirectionalLight(0xffffff, 2);
  private hemi = new THREE.HemisphereLight(0xbfdfff, 0x40503a, 0.8);
  private fog = new THREE.Fog(0x8fcbff, 80, 900);
  private stars!: THREE.Points;
  private rain!: THREE.LineSegments;
  private rainPos!: Float32Array;
  private rainVel!: Float32Array;
  private rainN = 0;
  private rainNow = 0; private rainTarget = 0; private rainTimer = 40;

  gameTime = 17.2;            // hours, 0..24
  private camYaw = 0; private camPitch = 0.28;
  camDist = 7.5; // third-person distance (raised by dev tooling for overview shots)
  setCam(yaw: number, pitch: number): void { this.camYaw = yaw; this.camPitch = pitch; }
  private last = 0; private hudAcc = 0; private saveAcc = 0;
  private shadowsOn: boolean;
  private shadowGood = 0;
  debugMode = 0; // 0 off, 1 hud, 2 hud+wireframe, 3 hud+chunk borders
  zoneName = '';
  private t: Record<string, number> = { input: 0, net: 0, sim: 0, vis: 0, anim: 0, render: 0 };
  private hud = document.getElementById('hud')!;
  private zoneEl = document.getElementById('zone')!;
  private lastZone = '';
  private zoneId: IslandId = 'valley';
  private atm = { amt: 0.1, fog: 1, color: new THREE.Color(0xffc9dc) };
  private snowing = false;

  constructor(private canvas: HTMLCanvasElement, private profile: DeviceProfile) {
    this.dyn = new DynamicResolution(profile.q.resScale);
    this.shadowsOn = profile.q.shadows;
  }

  async init(save?: SaveData): Promise<void> {
    this.gr = await GameRenderer.create(this.canvas, this.profile.webgpu, this.profile.dpr);
    this.gr.setScale(this.dyn.scale);
    const q = this.profile.q;

    this.world = new World(this.assets);
    this.scene.add(this.world.group);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(0x8fcbff);

    // first launch (or a save from before the islands existed / one that ended up at sea) starts in Sakura Valley
    const onLand = !!save && zoneAt(save.x, save.z) !== 'sea';
    this.player = new Player(this.assets, onLand ? { x: save!.x, z: save!.z } : ISLANDS[0].spawn);
    if (save) this.gameTime = save.time;
    this.scene.add(this.player.group);

    this.npc = new NpcSystem(q.npc, this.assets);
    this.traffic = new TrafficSystem(q.traffic, this.assets);
    this.remotes = new RemotePlayers(this.assets);
    this.scene.add(this.npc.mesh, this.traffic.mesh, this.remotes.mesh);

    // lighting: one directional (sun/moon) + hemisphere probe-style fill. No other dynamic lights.
    this.scene.add(this.sun, this.sun.target, this.hemi);
    this.sun.castShadow = this.shadowsOn;
    this.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 600;
    this.sun.shadow.bias = -0.0004;

    // stars (visible at night)
    const sp = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * 6.283, r = Math.sqrt(1 - u * u);
      sp[i * 3] = Math.cos(a) * r * 6000; sp[i * 3 + 1] = Math.abs(u) * 6000 + 200; sp[i * 3 + 2] = Math.sin(a) * r * 6000;
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false }));
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // rain (pooled line segments around the camera; zero allocation per frame)
    this.rainN = q.rain;
    this.rainPos = new Float32Array(this.rainN * 6);
    this.rainVel = new Float32Array(this.rainN * 3);
    for (let i = 0; i < this.rainN; i++) {
      this.rainVel[i * 3] = (Math.random() - 0.5) * 70; this.rainVel[i * 3 + 1] = Math.random() * 40; this.rainVel[i * 3 + 2] = (Math.random() - 0.5) * 70;
    }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaecbff, transparent: true, opacity: 0.45 }));
    this.rain.frustumCulled = false; this.rain.visible = false;
    this.scene.add(this.rain);

    this.input = new Input();
    this.applyTime();
    // prime the first ring of chunks before showing the world
    for (let i = 0; i < 40; i++) this.world.update(this.player.x, this.player.z, 0, 0, q.viewRings, this.camera, 6);
    this.gr.setAnimationLoop((t) => this.frame(t));
  }

  /** Fast travel (test tool): jump to an island's spawn point and stream its terrain before the next frame. */
  teleportTo(index: number): void {
    const isl = ISLANDS[index];
    if (!isl) return;
    this.player.teleport(isl.spawn.x, isl.spawn.z);
    this.camYaw = 0; this.camPitch = 0.28;
    this.camera.position.set(this.player.x, this.player.y + 6, this.player.z + 8);
    for (let i = 0; i < 40; i++) this.world.update(this.player.x, this.player.z, 0, 0, this.profile.q.viewRings, this.camera, 6);
  }

  currentSave(): SaveData { return { x: this.player.x, z: this.player.z, time: this.gameTime }; }

  setDebug(mode: number): void {
    this.debugMode = mode;
    this.assets.setWireframe(mode === 2);
    this.world.setDebugBorders(mode === 3);
    if (mode === 0) this.hud.textContent = '';
  }

  // ---------------- main loop ----------------
  private frame(now: number): void {
    const frameMs = this.last ? now - this.last : 16.7;
    const dt = Math.min(0.05, frameMs / 1000);
    this.last = now;
    let p = performance.now(), q = p;
    const lap = (k: string) => { q = performance.now(); this.t[k] = q - p; p = q; };

    // 1. input
    this.input.poll();
    for (let i = 0; i < ISLANDS.length; i++) if (this.input.wasPressed('Digit' + (i + 1))) this.teleportTo(i);
    if (this.input.wasPressed('F3')) this.setDebug((this.debugMode + 1) % 4);
    lap('input');

    // 2. network
    this.net.update(dt, this.player.x, this.player.y, this.player.z, this.player.yaw);
    this.remotes.update(this.net, this.player.x, this.player.z);
    lap('net');

    // 3. simulation
    this.updatePlayer(dt);
    this.gameTime = (this.gameTime + dt * (24 / 600)) % 24; // 10-minute day
    this.applyTime();
    this.updateWeather(dt);
    this.npc.update(dt, this.player.x, this.player.z);
    this.traffic.update(dt, this.player.x, this.player.z, now / 1000);
    lap('sim');

    // 4. visibility / streaming
    this.world.update(this.player.x, this.player.z, this.player.vx, this.player.vz, this.profile.q.viewRings, this.camera, 1);
    lap('vis');

    // 5. animation / camera
    this.player.sync(dt);
    this.updateCamera(dt);
    lap('anim');

    // 6. render
    this.gr.render(this.scene, this.camera);
    lap('render');

    this.adapt(frameMs);
    this.hudAcc += frameMs; this.saveAcc += frameMs;
    if (this.hudAcc > 250) { this.hudAcc = 0; this.updateHud(frameMs); }
    if (this.saveAcc > 10000) { this.saveAcc = 0; void kvSet('save', this.currentSave()); }
  }

  private updatePlayer(dt: number): void {
    const P = this.player, I = this.input;
    this.camYaw -= I.lookX * 2.4 * dt;
    this.camPitch = Math.max(-0.2, Math.min(1.2, this.camPitch + I.lookY * 1.6 * dt));
    const speed = I.run ? 9 : 5;
    const fx = -Math.sin(this.camYaw), fz = -Math.cos(this.camYaw);   // forward
    const rx = Math.cos(this.camYaw), rz = -Math.sin(this.camYaw);    // right
    const mx = I.moveX, my = -I.moveY;
    let tvx = (fx * my + rx * mx) * speed, tvz = (fz * my + rz * mx) * speed;
    const k = 1 - Math.exp(-10 * dt);
    P.vx += (tvx - P.vx) * k; P.vz += (tvz - P.vz) * k;
    let nx = P.x + P.vx * dt, nz = P.z + P.vz * dt;
    // collision: simple boxes for towers, sea blocks movement
    if (blocked(nx, P.z) || heightAt(nx, P.z) < -0.3) { nx = P.x; P.vx = 0; }
    if (blocked(P.x, nz) || heightAt(P.x, nz) < -0.3) { nz = P.z; P.vz = 0; }
    P.x = nx; P.z = nz;
    if (Math.abs(P.vx) + Math.abs(P.vz) > 0.5) P.yaw = Math.atan2(P.vx, P.vz);
    const ground = Math.max(heightAt(P.x, P.z), 0);
    if (I.jump && P.grounded) { P.vy = 7.5; P.grounded = false; }
    P.vy -= 22 * dt; P.y += P.vy * dt;
    if (P.y <= ground) { P.y = ground; P.vy = 0; P.grounded = true; }
    // zone banner + atmosphere target
    const isl = zoneAt(P.x, P.z) === 'sea' ? null : islandAt(P.x, P.z);
    const name = isl ? isl.name : '';
    if (name !== this.lastZone) { this.lastZone = name; this.zoneEl.textContent = name; }
    if (isl) this.zoneId = isl.id;
  }

  private updateCamera(dt: number): void {
    const P = this.player, d = this.camDist;
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    const tx = P.x + Math.sin(this.camYaw) * cp * d, tz = P.z + Math.cos(this.camYaw) * cp * d, ty = P.y + 2.2 + sp * d;
    const k = 1 - Math.exp(-14 * dt);
    const c = this.camera.position;
    c.x += (tx - c.x) * k; c.z += (tz - c.z) * k; c.y += (Math.max(ty, heightAt(c.x, c.z) + 1.2) - c.y) * k;
    this.camera.aspect = this.gr.aspect; this.camera.updateProjectionMatrix();
    this.camera.lookAt(P.x, P.y + 1.4, P.z);
  }

  // ---------------- day/night + weather ----------------
  private applyTime(): void {
    const a = ((this.gameTime - 6) / 24) * Math.PI * 2;
    const elev = Math.sin(a);
    const day = sstep(-0.12, 0.28, elev);
    const dusk = 1 - Math.min(1, Math.abs(elev) / 0.3);
    const night = 1 - day;
    const sky = SKY_NIGHT.clone().lerp(SKY_DAY, day).lerp(SKY_DUSK, dusk * 0.7 * (1 - Math.abs(night - 0.5) * 0.4));
    const wet = 1 - this.rainNow * 0.45;
    const A = ATMOS[this.zoneId], k = 0.02;
    this.atm.amt += (A.amt - this.atm.amt) * k; this.atm.fog += (A.fog - this.atm.fog) * k; this.atm.color.lerp(A.tint, k);
    sky.lerp(TINT.copy(this.atm.color).multiplyScalar(0.2 + 0.8 * day), this.atm.amt);
    sky.multiplyScalar(wet);
    (this.scene.background as THREE.Color).copy(sky);
    this.fog.color.copy(sky);
    this.fog.near = 60;
    this.fog.far = this.profile.q.fogFar * this.atm.fog * (1 - this.rainNow * 0.55);

    const P = this.player;
    const dir = new THREE.Vector3(Math.cos(a) * 0.8, Math.max(0.12, Math.abs(elev)) , 0.45).normalize();
    this.sun.position.set(P.x + dir.x * 220, P.y + dir.y * 220, P.z + dir.z * 220);
    this.sun.target.position.set(P.x, P.y, P.z);
    this.sun.color.copy(MOON).lerp(SUN_DAY, day).lerp(SUN_DUSK, dusk * 0.8);
    this.sun.intensity = (0.35 + 2.1 * day) * (1 - this.rainNow * 0.5);
    this.hemi.intensity = 0.25 + 0.75 * day;
    this.hemi.color.copy(sky).lerp(new THREE.Color(0xffffff), 0.35);
    this.assets.setNight(night * (0.7 + 0.3 * this.rainNow));
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, night - 0.35) * (1 - this.rainNow);
    this.stars.position.copy(this.camera.position);
  }

  private updateWeather(dt: number): void {
    this.rainTimer -= dt;
    if (this.rainTimer <= 0) { this.rainTarget = Math.random() < 0.4 ? 0.5 + Math.random() * 0.5 : 0; this.rainTimer = 45 + Math.random() * 90; }
    const snow = ATMOS[this.zoneId].snow;
    const target = snow ? 0.65 : this.rainTarget; // Yukigami Peaks always snows
    if (snow !== this.snowing) {
      this.snowing = snow;
      (this.rain.material as THREE.LineBasicMaterial).color.set(snow ? 0xffffff : 0xaecbff);
    }
    this.rainNow += (target - this.rainNow) * Math.min(1, dt * 0.25);
    const on = this.rainNow > 0.05;
    this.rain.visible = on;
    if (!on) return;
    (this.rain.material as THREE.LineBasicMaterial).opacity = snow ? 0.9 : 0.15 + 0.4 * this.rainNow;
    const n = Math.floor(this.rainN * this.rainNow); // distance/intensity-scaled particle count
    const cx = this.camera.position.x, cy = this.camera.position.y, cz = this.camera.position.z;
    const pos = this.rainPos, vel = this.rainVel;
    for (let i = 0; i < n; i++) {
      const j = i * 6, v = i * 3;
      vel[v + 1] += 0; // vy is a fall-speed offset
      let y = pos[j + 1] - (snow ? 4 + vel[v + 1] * 0.12 : 55 + vel[v + 1]) * dt;
      let x = pos[j], z = pos[j + 2];
      if (y < cy - 25 || Math.abs(x - cx) > 45 || Math.abs(z - cz) > 45 || y > cy + 30) {
        x = cx + vel[v] * 0.64; z = cz + vel[v + 2] * 0.64; y = cy + 15 + (Math.random() * 25);
      }
      pos[j] = x; pos[j + 1] = y; pos[j + 2] = z;
      pos[j + 3] = x - (snow ? 0.02 : 0.15); pos[j + 4] = y + (snow ? 0.12 : 1.4); pos[j + 5] = z;
    }
    (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.rain.geometry.setDrawRange(0, n * 2);
  }

  // ---------------- adaptive quality ----------------
  private adapt(frameMs: number): void {
    if (this.dyn.update(frameMs)) {
      this.gr.setScale(this.dyn.scale);
    }
    // shadows drop first when we're struggling; return only after sustained headroom
    if (this.profile.q.shadows) {
      if (this.dyn.scale <= 0.8 && this.shadowsOn) { this.shadowsOn = false; this.sun.castShadow = false; this.shadowGood = 0; }
      else if (!this.shadowsOn && this.dyn.scale >= 0.95 && this.dyn.avgMs < 15) {
        if (++this.shadowGood > 400) { this.shadowsOn = true; this.sun.castShadow = true; this.shadowGood = 0; }
      }
    }
  }

  private updateHud(frameMs: number): void {
    if (this.debugMode === 0) return;
    const i = this.gr.info, t = this.t, w = this.world.stats;
    const cpu = t.input + t.net + t.sim + t.vis + t.anim + t.render;
    const f = (n: number) => n.toFixed(1).padStart(4);
    this.hud.textContent =
      `FPS ${(1000 / this.dyn.avgMs).toFixed(0)}  frame ${frameMs.toFixed(1)}ms  cpu ${cpu.toFixed(1)}ms  gpu~ ${Math.max(0, this.dyn.avgMs - cpu).toFixed(1)}ms\n` +
      `${this.gr.backend}  res ${(this.dyn.scale * 100).toFixed(0)}%  shadows ${this.shadowsOn ? 'on' : 'off'}  preset ${this.profile.preset}\n` +
      `input ${f(t.input)} net ${f(t.net)} sim ${f(t.sim)} vis ${f(t.vis)} anim ${f(t.anim)} render ${f(t.render)}\n` +
      `draws ${i.calls}  tris ${(i.triangles / 1000).toFixed(0)}k  geo ${i.geometries}  tex ${i.textures}\n` +
      `chunks ${w.loaded} (r0 ${w.ring[0]} r1 ${w.ring[1]} r2 ${w.ring[2]})  built/frame ${w.builtThisFrame}  prop pools ${w.pools} (${w.instances} instances)\n` +
      `npc ${this.npc.counts.full} near/${this.npc.counts.reduced} reduced/${this.npc.counts.recycled} recycled  cars ${this.traffic.counts.near}/${this.traffic.counts.mid}\n` +
      `players ${this.remotes.count}  pkts/s ${this.net.packetsPerSec}  rain ${(this.rainNow * 100).toFixed(0)}%  t ${this.gameTime.toFixed(1)}h\n` +
      `[DEBUG ${this.debugMode}] 1 hud · 2 wireframe · 3 chunk borders (green r0, yellow r1, red r2)`;
  }
}
