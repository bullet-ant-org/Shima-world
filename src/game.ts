/** Game: owns the loop, the scene and every system. Loop order: input -> network -> simulation -> visibility -> animation -> render. */
import * as THREE from 'three/webgpu';
import { GameRenderer } from './rendering/renderer';
import { Assets } from './rendering/assets';
import { World } from './world/world';
import { Particles, SpeedLines, HoverRing } from './entities/fx';
import { Sky } from './rendering/sky';
import { Player, RemotePlayers, TrafficSystem } from './entities/entities';
import { Townsfolk } from './entities/npcs';
import { Herd } from './entities/horse';
import { loadBaseModel } from './entities/humanoid';
import { Grass } from './rendering/grass';
import { PASTURES, blockTop } from './world/layout';
import { Input } from './core/input';
import { Network } from './network/network';
import { DynamicResolution, type DeviceProfile } from './core/device';
import { ISLANDS, heightAt, islandAt, sstep, zoneAt, type IslandId } from './world/terrain';
import { kvSet } from './core/store';
import type { CharacterSpec } from './entities/character';

export interface SaveData { x: number; z: number; time: number }

/** Per-island atmosphere: fog tint strength, fog distance multiplier, and whether it snows. */
const ATMOS: Record<IslandId, { tint: THREE.Color; amt: number; fog: number; snow: boolean; light: number }> = {
  valley: { tint: new THREE.Color(0xffc9dc), amt: 0.1, fog: 1, snow: false, light: 1 },
  city: { tint: new THREE.Color(0x6a4cff), amt: 0.06, fog: 1.1, snow: false, light: 1 },
  god: { tint: new THREE.Color(0x9fc4d6), amt: 0.55, fog: 0.5, snow: false, light: 0.62 }, // cold, dim, thick mist: an eerie sacred precinct
  ember: { tint: new THREE.Color(0x8a2410), amt: 0.5, fog: 0.8, snow: false, light: 0.9 },
  snow: { tint: new THREE.Color(0xe2f0ff), amt: 0.5, fog: 0.75, snow: true, light: 1 },
  islet: { tint: new THREE.Color(0xd8ecff), amt: 0.12, fog: 1, snow: false, light: 1 },
};
const TINT = new THREE.Color();
const SKY_DAY = new THREE.Color(0x8fcbff), SKY_DUSK = new THREE.Color(0xff9a6b), SKY_NIGHT = new THREE.Color(0x34405e); // moonlit blue-grey, not black
const NIGHT_FILL = new THREE.Color(0xc8d4f0), WHITE = new THREE.Color(0xffffff);
const SUN_DAY = new THREE.Color(0xfff2dd), SUN_DUSK = new THREE.Color(0xff9d5c), MOON = new THREE.Color(0xb4c4ec);

export class Game {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.3, 9000);
  private gr!: GameRenderer;
  private assets = new Assets();
  private world!: World;
  private player!: Player;
  private herd!: Herd;
  private grass: Grass | null = null;
  private grassGood = 0;
  private npc!: Townsfolk;
  private traffic!: TrafficSystem;
  private skyTraffic!: TrafficSystem;
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
  camDist = 3.4; // third-person distance (raised by dev tooling for overview shots)
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
  private uiKey = -1; private glowQ = -1; private camD = 3.4;
  private trail = new Particles(260, 0.55); private spirits = new Particles(160, 1.3); private dust = new Particles(160, 1.1, -1.2, 0.97);
  private speedLines = new SpeedLines(); private hoverRing = new HoverRing();
  private speedEl = document.getElementById('speedfx')!;
  private sky!: Sky;
  private sunDir = new THREE.Vector3(); private frameDt = 0.016;
  private zoneId: IslandId = 'valley';
  private atm = { amt: 0.1, fog: 1, light: 1, color: new THREE.Color(0xffc9dc) };
  private snowing = false;

  constructor(private canvas: HTMLCanvasElement, private profile: DeviceProfile) {
    this.dyn = new DynamicResolution(profile.q.resScale);
    this.shadowsOn = profile.q.shadows;
  }

  async init(save?: SaveData, spec?: CharacterSpec): Promise<void> {
    this.gr = await GameRenderer.create(this.canvas, this.profile.webgpu, this.profile.dpr);
    this.gr.setScale(this.dyn.scale);
    const q = this.profile.q;

    this.world = new World(this.assets, { outlines: q.outlines === 'all', detail: q.detailWindows });
    this.scene.add(this.world.group);
    this.sky = new Sky(this.assets.ramp);
    this.scene.add(this.sky.group);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(0x8fcbff);

    if ((spec?.base ?? 0) === 0) await loadBaseModel().catch((e) => console.error('base model failed to load', e));
    // first launch (or a save from before the islands existed / one that ended up at sea) starts in Sakura Valley
    const onLand = !!save && zoneAt(save.x, save.z) !== 'sea';
    this.player = new Player(this.assets, onLand ? { x: save!.x, z: save!.z } : ISLANDS[0].spawn, spec, q.outlines !== 'off', q.heroDetail);
    if (save) this.gameTime = save.time;
    this.scene.add(this.player.group);

    if (q.grass > 0) {
      this.grass = new Grass(q.grass, q.grassR, this.assets.ramp, (x, z, c) => this.world.grassAt(x, z, c));
      this.grass.yAt = (x, z) => heightAt(x, z);
      this.scene.add(this.grass.mesh);
      for (let i = 0; i < 40; i++) this.grass.update(this.player.x, this.player.z, 200);
    }
    this.herd = new Herd(this.assets.rig, PASTURES, q.npc > 60 ? 18 : 10);
    this.scene.add(this.herd.group);
    this.player.herd = this.herd;
    this.npc = new Townsfolk(Math.max(40, Math.round(q.npc * 1.2)), this.assets.ramp);
    this.traffic = new TrafficSystem(q.traffic, this.assets, ['avenue', 'street'], 3.2, q.outlines === 'all');
    this.skyTraffic = new TrafficSystem(Math.max(10, Math.round(q.traffic * 0.6)), this.assets, ['sky'], 3.2, q.outlines === 'all');
    this.remotes = new RemotePlayers(this.assets);
    this.scene.add(this.npc.group, this.traffic.group, this.skyTraffic.group, this.remotes.mesh, this.trail.points, this.spirits.points, this.dust.points, this.speedLines.lines, this.hoverRing.mesh);

    // lighting: one directional (sun/moon) + hemisphere probe-style fill. No other dynamic lights.
    this.scene.add(this.sun, this.sun.target, this.hemi);
    this.sun.castShadow = this.shadowsOn;
    this.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    const sc = this.sun.shadow.camera;
    sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110; sc.near = 1; sc.far = 700;
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
    this.frameDt = dt;
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
    this.herd.update(dt, this.player.x, this.player.z);
    if (this.grass) { this.grass.mesh.visible = this.player.y - heightAt(this.player.x, this.player.z) < 60; if (this.grass.mesh.visible) this.grass.update(this.player.x, this.player.z, this.player.flying ? 3 : 6); }
    this.gameTime = (this.gameTime + dt * (24 / 600)) % 24; // 10-minute day
    this.applyTime();
    this.updateWeather(dt);
    this.npc.update(dt, this.player.x, this.player.z, this.gameTime);
    this.traffic.update(dt, this.player.x, this.player.z, now / 1000);
    this.skyTraffic.update(dt, this.player.x, this.player.z, now / 1000);
    lap('sim');

    // 4. visibility / streaming
    this.world.update(this.player.x, this.player.z, this.player.vx, this.player.vz, this.profile.q.viewRings, this.camera, 1);
    lap('vis');

    // 5. animation / camera
    this.player.sync(dt);
    this.updateCamera(dt);
    this.updateFx(dt, now);
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
    // free look: drag on the right of the screen (unlimited yaw, pitch limited to straight up/down) + keyboard Q/E/arrows
    this.camYaw -= I.lookX * 2.4 * dt + I.lookDX * 0.0055;
    this.camPitch = Math.max(-1.35, Math.min(1.45, this.camPitch + I.lookY * 1.6 * dt + I.lookDY * 0.0042));
    P.step(dt, I, this.camYaw, this.camPitch);
    // zone banner + atmosphere target
    const isl = zoneAt(P.x, P.z) === 'sea' ? null : islandAt(P.x, P.z);
    const name = isl ? isl.name : '';
    if (name !== this.lastZone) { this.lastZone = name; this.zoneEl.textContent = name; }
    if (isl) this.zoneId = isl.id;
    this.updateFlightUi();
  }

  /** Buttons reflect the flight state: FLY<->LAND, BOOST appears while flying, JUMP/RUN become UP/DOWN. */
  private updateFlightUi(): void {
    const P = this.player, key = (P.flying ? 1 : 0) | (P.boost ? 2 : 0) | (P.landing ? 4 : 0) | (P.mount ? 8 : 0) | (P.nearHorse ? 16 : 0);
    if (key === this.uiKey) return;
    this.uiKey = key;
    const $ = (id: string) => document.getElementById(id)!;
    $('fly-btn').textContent = P.flying ? (P.landing ? 'CANCEL' : 'LAND') : 'FLY';
    $('fly-btn').classList.toggle('on', P.flying);
    $('boost-btn').classList.toggle('show', P.flying && !P.landing);
    $('boost-btn').classList.toggle('on', P.boost);
    $('jump-btn').textContent = P.flying ? 'UP' : 'JUMP';
    $('run-btn').textContent = P.flying ? 'DOWN' : P.mount ? 'GALLOP' : 'RUN';
    $('ride-btn').classList.toggle('show', !!(P.mount || P.nearHorse));
    $('ride-btn').textContent = P.mount ? 'DISMOUNT' : 'RIDE';
  }

  /** Trail, hover sparkles, landing dust, speed lines, ground ring and the screen-edge speed glow. */
  private updateFx(dt: number, now: number): void {
    const P = this.player, sp = P.speed3, fly = P.flying;
    const hx = Math.sin(P.yaw), hz = Math.cos(P.yaw); // heading
    if (fly) {
      const by = P.y + 1.0;
      if (sp > 4) { // jet plume from the back: more and brighter with speed / boost
        const n = P.boost ? 4 : sp > 12 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const j = (Math.random() - 0.5) * 0.5;
          this.trail.emit(P.x - hx * 0.5 + j, by + (Math.random() - 0.5) * 0.4, P.z - hz * 0.5 + j, -P.vx * 0.15 + j, -P.vy * 0.15 + j, -P.vz * 0.15 + j,
            P.boost ? 0.7 : 0.45, P.boost ? 1 : 0.3, P.boost ? 0.55 : 0.85, 1);
        }
      } else if (Math.random() < dt * 40) { // hover: slow energy motes drifting down from the feet
        this.trail.emit(P.x + (Math.random() - 0.5) * 0.6, P.y + 0.1, P.z + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.4, -1.4 - Math.random(), (Math.random() - 0.5) * 0.4, 0.8, 0.25, 0.8, 1);
      }
    }
    if (P.sliding) { // dust kicked up by the braking foot
      const s = P.hspeed;
      for (let i = 0; i < 2; i++) {
        this.dust.emit(P.x + hx * 0.3, P.y + 0.1, P.z + hz * 0.3, -hx * s * 0.2 + (Math.random() - 0.5) * 2, 0.8 + Math.random() * 1.6, -hz * s * 0.2 + (Math.random() - 0.5) * 2, 0.7, 0.62, 0.55, 0.45);
      }
    }
    if (P.impact > 0) { // landing impact burst
      P.impact = 0;
      for (let i = 0; i < 36; i++) {
        const a = Math.random() * 6.283, v = 2 + Math.random() * 5;
        this.dust.emit(P.x, P.y + 0.15, P.z, Math.cos(a) * v, 0.5 + Math.random() * 2.5, Math.sin(a) * v, 0.9, 0.7, 0.62, 0.5);
      }
    }
    if (this.zoneId === 'god' && Math.random() < dt * 16) { // drifting spirit lights: the sacred island feels haunted
      const a = Math.random() * 6.283, r = 6 + Math.random() * 40;
      this.spirits.emit(P.x + Math.cos(a) * r, Math.max(heightAt(P.x, P.z), 0) + 0.5 + Math.random() * 5, P.z + Math.sin(a) * r, (Math.random() - 0.5) * 0.6, 0.5 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6, 5 + Math.random() * 3, 0.45, 0.9, 1);
    }
    this.trail.update(dt); this.dust.update(dt); this.spirits.update(dt);
    const c = this.camera.position;
    this.speedLines.update(dt, sp, P.vx, P.vy, P.vz, c.x, c.y, c.z);
    this.hoverRing.update(fly, P.x, Math.max(heightAt(P.x, P.z), 0), P.z, P.y - Math.max(heightAt(P.x, P.z), 0), now / 1000);
    const glow = fly ? Math.min(0.9, Math.max(0, (sp - 20) / 60)) : 0;
    const q = Math.round(glow * 20) / 20;
    if (q !== this.glowQ) { this.glowQ = q; this.speedEl.style.opacity = String(q); }
  }

  private updateCamera(dt: number): void {
    const P = this.player;
    // GTA-style chase camera: close over the right shoulder on foot, pulled back for running / riding / flying
    const ride = P.mount ? 1 : 0, run = !P.flying && !ride ? Math.min(1, P.hspeed / 7.8) : 0;
    let d = this.camDist + run * 0.9 + (P.flying ? (P.boost ? 6 : 3) : 0) + ride * (2.4 + Math.min(3, P.hspeed * 0.15));
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    const sh = (P.flying ? 0.35 : 0.62) * (1 - ride * 0.5);                       // shoulder offset to the right
    const rx = Math.cos(this.camYaw), rz = -Math.sin(this.camYaw);
    const lookH = P.flying ? 1.1 : 1.55 + ride * 0.95;
    const fx = P.x + rx * sh, fz = P.z + rz * sh, fy = P.y + lookH;
    // pull in so walls / buildings never get between the camera and the character
    for (let i = 1; i <= 6; i++) {
      const t = (i / 6) * d, cx = fx + Math.sin(this.camYaw) * cp * t, cz = fz + Math.cos(this.camYaw) * cp * t, cy = fy + sp * t;
      if (blockTop(cx, cz) > cy - 0.5) { d = Math.max(1.2, t - 0.6); break; }
    }
    this.camD += (d - this.camD) * (1 - Math.exp(-dt * (d < this.camD ? 12 : 4)));
    const tx = fx + Math.sin(this.camYaw) * cp * this.camD, tz = fz + Math.cos(this.camYaw) * cp * this.camD, ty = fy + 0.25 + sp * this.camD;
    const k = 1 - Math.exp(-dt * (P.flying ? 9 : 14));
    const c = this.camera.position;
    c.x += (tx - c.x) * k; c.z += (tz - c.z) * k; c.y += (Math.max(ty, heightAt(c.x, c.z) + 1.2) - c.y) * k;
    // speed sells the motion: widen the field of view while flying, a lot while boosting
    const fovT = P.flying ? Math.min(100, 70 + P.speed3 * 0.4) : 62 + run * 8 + ride * Math.min(12, P.hspeed * 0.6);
    this.camera.fov += (fovT - this.camera.fov) * (1 - Math.exp(-dt * 3));
    this.camera.aspect = this.gr.aspect; this.camera.updateProjectionMatrix();
    this.camera.lookAt(fx, fy, fz);
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
    this.atm.amt += (A.amt - this.atm.amt) * k; this.atm.fog += (A.fog - this.atm.fog) * k; this.atm.light += (A.light - this.atm.light) * k; this.atm.color.lerp(A.tint, k);
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
    // nights stay readable: cool moonlight + a blue-grey ambient fill (daytime values unchanged)
    this.sun.intensity = (1.15 + 1.45 * day) * (1 - this.rainNow * 0.5) * this.atm.light;
    this.hemi.intensity = (0.95 + 0.15 * day) * (0.55 + 0.45 * this.atm.light);
    this.hemi.color.copy(sky).lerp(night > 0.5 ? NIGHT_FILL : WHITE, 0.35 + 0.25 * night);
    this.assets.setNight(night * (0.7 + 0.3 * this.rainNow));
    this.sunDir.set(Math.cos(a) * 0.8, elev, 0.45).normalize();
    this.sky.update(this.frameDt, this.camera.position, sky, night, this.sunDir, this.rainNow);
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
    // grass is the first thing to give way (density 1 -> 0.25), then resolution, then shadows; it comes back last
    if (this.grass) {
      const avg = this.dyn.avgMs, cur = this.grass.count / this.grass.mesh.instanceMatrix.count;
      if (avg > 19 && cur > 0.26) { this.grass.setDensity(cur - 0.004); this.grassGood = 0; }
      else if (avg < 14.5 && this.dyn.scale >= 0.99 && cur < 1 && ++this.grassGood > 120) { this.grass.setDensity(cur + 0.1); this.grassGood = 0; }
    }
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
