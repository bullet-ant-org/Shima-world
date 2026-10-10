/**
 * Minimap (top left) and the three status bars beside it: health, energy, honour.
 *
 * The world map is painted once into an offscreen canvas (terrain by height and island, roads, the city's buildings),
 * a few rows per frame so startup never stalls. Each frame the visible window is drawn rotated with the camera, so
 * "up" on the map is always the direction you are looking; the player arrow, nearby doors and the compass ring sit on top.
 */
import { ISLANDS, heightAt, islandAt } from '../world/terrain';
import { BUILDINGS, NET } from '../world/layout';

const X0 = -3300, Z0 = -3700, SPAN = 6800, RES = 1024;  // world window covered by the painted map
const MPP = SPAN / RES;                                  // metres per map pixel

export interface Stats { hp: number; energy: number; honour: number }

export class Hud {
  private map = document.createElement('canvas');
  private over = document.createElement('canvas');
  private mctx: CanvasRenderingContext2D;
  private row = 0;
  private painted = false;
  private view: HTMLCanvasElement;
  private vctx: CanvasRenderingContext2D;
  private bars: { fill: HTMLElement; val: HTMLElement }[] = [];
  private zoom = 1;
  doors: { x: number; z: number; kind: string }[] = [];

  constructor() {
    this.map.width = this.map.height = RES;
    this.mctx = this.map.getContext('2d')!;
    const wrap = document.createElement('div');
    wrap.id = 'hud-top';
    wrap.innerHTML = `
      <canvas id="minimap" width="176" height="176"></canvas>
      <div id="bars">
        ${[['HEALTH', '#ff4a5e', '#7a1424'], ['ENERGY', '#3ad8ff', '#0f4a66'], ['HONOUR', '#ffcf4a', '#6a4a10']].map(([n, c, d]) => `
        <div class="sbar"><span class="lbl">${n}</span><div class="track" style="--c:${c};--d:${d}"><div class="fill"></div></div><span class="val">100</span></div>`).join('')}
      </div>`;
    document.body.appendChild(wrap);
    const st = document.createElement('style');
    st.textContent = `
      #hud-top { position: fixed; left: 10px; top: 10px; display: flex; gap: 10px; align-items: flex-start; z-index: 5; pointer-events: none; }
      #minimap { position: relative; inset: auto; display: block; flex: none; width: 176px; height: 176px; border-radius: 50%; box-shadow: 0 0 0 3px rgba(255,255,255,.85), 0 0 0 5px rgba(20,24,44,.6), 0 4px 18px rgba(0,0,0,.45); background: #2a5a8a; }
      #bars { display: flex; flex-direction: column; gap: 7px; margin-top: 8px; font: 700 10px/1 system-ui, sans-serif; letter-spacing: .14em; color: #fff; text-shadow: 0 1px 2px #000; }
      #bars .sbar { width: auto; height: auto; background: none; border-radius: 0; overflow: visible; display: grid; grid-template-columns: 62px 132px 28px; align-items: center; gap: 6px; }
      #bars .track { height: 11px; border-radius: 6px; background: rgba(10,12,24,.55); box-shadow: inset 0 0 0 1px rgba(255,255,255,.35); overflow: hidden; }
      #bars .fill { height: 100%; width: 100%; border-radius: 6px; background: linear-gradient(180deg, color-mix(in srgb, var(--c) 70%, #fff), var(--c) 55%, var(--d)); transition: width .25s; }
      #bars .val { font-size: 10px; opacity: .9; text-align: right; }
      @media (max-width: 700px) { #minimap { width: 128px !important; height: 128px !important; } #bars .sbar { grid-template-columns: 50px 90px 24px; } #bars { font-size: 8px; } }
      #hud { top: 200px !important; }`;
    document.head.appendChild(st);
    this.view = document.getElementById('minimap') as HTMLCanvasElement;
    this.vctx = this.view.getContext('2d')!;
    for (const b of Array.from(wrap.querySelectorAll(".sbar"))) this.bars.push({ fill: b.querySelector('.fill') as HTMLElement, val: b.querySelector('.val') as HTMLElement });
    this.mctx.fillStyle = '#2f6c9e'; this.mctx.fillRect(0, 0, RES, RES);
    this.paintOverlay();
  }

  setVisible(on: boolean): void { (document.getElementById('hud-top') as HTMLElement).style.display = on ? 'flex' : 'none'; }

  /** paint a few more rows of the world map (call every frame until done) */
  private order: number[] = [];
  /** paint map rows nearest the player first, within a small time budget per frame */
  private paint(pz: number, budgetMs: number): void {
    if (this.painted) return;
    if (!this.order.length && this.row === 0) {
      const pr = (pz - Z0) / MPP;
      this.order = Array.from({ length: RES / 8 }, (_, k) => k * 8).sort((a, b) => Math.abs(a - pr) - Math.abs(b - pr));
    }
    const t0 = performance.now();
    while (this.order.length && performance.now() - t0 < budgetMs) { this.paintRows(this.order.shift()!, 8); this.row += 8; }
    if (!this.order.length) this.painted = true;
  }

  private paintRows(row0: number, rows: number): void {
    const c = this.mctx, img = c.createImageData(RES, rows);
    for (let j = 0; j < rows && row0 + j < RES; j++) for (let i = 0; i < RES; i++) {
      const x = X0 + (i + 0.5) * MPP, z = Z0 + (row0 + j + 0.5) * MPP, h = heightAt(x, z), k = (j * RES + i) * 4;
      let r: number, g: number, b: number;
      if (h < 0) { const d = Math.min(1, -h / 40); r = 70 - 40 * d; g = 150 - 60 * d; b = 205 - 50 * d; }
      else {
        const id = islandAt(x, z)?.id, t = Math.min(1, h / 220);
        if (h < 2.2) { r = 236; g = 222; b = 176; }
        else if (id === 'snow') { r = 232 - 30 * (1 - t); g = 240 - 25 * (1 - t); b = 250; }
        else if (id === 'ember') { r = 120 + 60 * t; g = 70 + 20 * t; b = 60; }
        else if (id === 'city') { r = 196; g = 200; b = 204; }
        else if (id === 'god') { r = 120 + 70 * t; g = 150 + 50 * t; b = 130 + 60 * t; }
        else { r = 128 + 80 * t; g = 178 + 40 * t; b = 104 + 70 * t; }
        const sh = 0.86 + 0.14 * Math.min(1, Math.max(0, (heightAt(x - MPP, z - MPP) - h) * -0.08 + 0.5));
        r *= sh; g *= sh; b *= sh;
      }
      img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
    }
    c.putImageData(img, 0, row0);
  }

  private paintOverlay(): void {
    this.over.width = this.over.height = RES;
    const c = this.over.getContext('2d')!, P = (x: number, z: number): [number, number] => [(x - X0) / MPP, (z - Z0) / MPP];
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const p of NET.paths) {
      if (p.kind === 'runway') { c.strokeStyle = '#5a5e66'; c.lineWidth = p.width / MPP; }
      else if (p.kind === 'sky') { c.strokeStyle = 'rgba(120,220,255,.7)'; c.lineWidth = 1.2; }
      else if (p.kind === 'stone') { c.strokeStyle = '#c9b48a'; c.lineWidth = Math.max(1, p.width / MPP); }
      else { c.strokeStyle = '#f4f4f0'; c.lineWidth = Math.max(1.2, p.width / MPP); }
      c.beginPath();
      for (let i = 0; i < p.n; i++) { const [a, b] = P(p.x[i], p.z[i]); if (i) c.lineTo(a, b); else c.moveTo(a, b); }
      c.stroke();
    }
    c.fillStyle = '#7d8696';
    for (const b of BUILDINGS) {
      const [x, y] = P(b.x, b.z);
      c.save(); c.translate(x, y); c.rotate(-b.ry); c.fillRect(-b.hw / MPP, -b.hd / MPP, (2 * b.hw) / MPP, (2 * b.hd) / MPP); c.restore();
    }
    c.font = '600 13px system-ui, sans-serif'; c.textAlign = 'center'; c.fillStyle = 'rgba(255,255,255,.9)'; c.strokeStyle = 'rgba(0,0,0,.5)'; c.lineWidth = 3;
    for (const isl of ISLANDS) { const [x, y] = P(isl.cx, isl.cz); c.strokeText(isl.title.split(' (')[0], x, y); c.fillText(isl.title.split(' (')[0], x, y); }
  }

  update(px: number, pz: number, heading: number, camYaw: number, s: Stats, inside: boolean): void {
    this.paint(pz, this.row === 0 ? 40 : 5);
    const v = this.vctx, W = this.view.width, R = W / 2, metres = 420 * this.zoom, scale = R / (metres / MPP);
    v.clearRect(0, 0, W, W);
    v.save();
    v.beginPath(); v.arc(R, R, R, 0, Math.PI * 2); v.clip();
    v.fillStyle = '#2f6c9e'; v.fillRect(0, 0, W, W);
    v.translate(R, R); v.rotate(camYaw); v.scale(scale, scale);
    const mx = (px - X0) / MPP, mz = (pz - Z0) / MPP;
    v.drawImage(this.map, -mx, -mz); v.drawImage(this.over, -mx, -mz);
    // doors nearby (shops, clubs, homes)
    for (const d of this.doors) {
      const dx = (d.x - px) / MPP, dz = (d.z - pz) / MPP;
      if (d.kind === 'house' || Math.abs(dx) > metres / MPP || Math.abs(dz) > metres / MPP) continue;
      v.fillStyle = d.kind === 'house' ? '#ffd28a' : d.kind === 'club' ? '#d86bff' : d.kind === 'tower' ? '#9fd8ff' : d.kind === 'temple' ? '#ff6a5a' : '#6affc0';
      v.beginPath(); v.arc(dx, dz, 1.8 / scale, 0, Math.PI * 2); v.fill();
    }
    v.restore();
    // player arrow (map is rotated so the camera looks "up"); the arrow shows where the character faces
    v.save(); v.translate(R, R); v.rotate(camYaw - heading + Math.PI);
    v.fillStyle = inside ? '#ffcf4a' : '#ffffff'; v.strokeStyle = '#1a2040'; v.lineWidth = 2;
    v.beginPath(); v.moveTo(0, -9); v.lineTo(6.5, 7); v.lineTo(0, 3.5); v.lineTo(-6.5, 7); v.closePath(); v.stroke(); v.fill();
    v.restore();
    // compass: N marker on the rim
    const n = -camYaw + Math.PI;    // world -z is north
    v.font = '700 11px system-ui, sans-serif'; v.textAlign = 'center'; v.textBaseline = 'middle';
    const nx = R + Math.sin(n) * (R - 10), ny = R + Math.cos(n) * (R - 10);
    v.fillStyle = 'rgba(20,24,44,.75)'; v.beginPath(); v.arc(nx, ny, 8, 0, Math.PI * 2); v.fill();
    v.fillStyle = '#ff5a6a'; v.fillText('N', nx, ny + 0.5);
    const vals = [s.hp, s.energy, s.honour];
    this.bars.forEach((b, i) => { const p = Math.max(0, Math.min(100, vals[i])); b.fill.style.width = p + '%'; b.val.textContent = String(Math.round(p)); });
  }
}
