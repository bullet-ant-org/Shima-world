/**
 * Character creator: a GTA-style menu (banner, category tabs, one row per setting with arrows / sliders / swatches, a help
 * line at the bottom) over a live 3D preview. Works with touch, mouse and keys (up/down rows, left/right change, Q/E tabs).
 */
import { Preview } from './preview';
import { OUTFITS, OUTFIT_PALETTES } from '../entities/wardrobe';
import { BACKWEAR, BASE_HAIR, EARRINGS, FACE_PAINT, GLASSES_BASE, HATS_BASE, MASKS, NECKWEAR, WRISTWEAR } from '../entities/hairdo';
import { BASES, BEARDS, GLASSES, WEAPONS, BOOTS, BOTTOMS, EARS, EYE_SHAPES, HAIR_COLORS, HAIR_STYLES, HATS, IRIS_COLORS, LIP_COLORS, MOUTHS, OUTFIT_COLORS, SHADOW_COLORS, SKIN_TONES, TOPS, defaultSpec, normalize, presets, randomSpec, type CharacterSpec, type Gender } from '../entities/character';

type Tab = 'HERITAGE' | 'FEATURES' | 'HAIR' | 'APPAREL' | 'ACCESSORIES';
const TABS: { id: Tab; icon: string; zoom: number; help: string }[] = [
  { id: 'HERITAGE', icon: '◆', zoom: 0, help: 'Pick a ready-made look, then shape the body.' },
  { id: 'FEATURES', icon: '◉', zoom: 1, help: 'Sculpt the face: jaw, eyes, nose, mouth and facial hair.' },
  { id: 'HAIR', icon: '✂', zoom: 0.72, help: 'Choose a hairstyle, its length and colours.' },
  { id: 'APPAREL', icon: '▣', zoom: 0, help: 'Outfits, colours and weapons.' },
  { id: 'ACCESSORIES', icon: '✦', zoom: 0.55, help: 'Hats, glasses, jewellery, masks, face paint and bags.' },
];
type Show = 'base' | 'chibi' | 'female';
type Item = ({ tab: Tab; label: string; type: 'slider'; path: string; min: number; max: number; step: number }
  | { tab: Tab; label: string; type: 'choice'; path: string; options: string[] }
  | { tab: Tab; label: string; type: 'color'; path: string; presets: string[] }
  | { tab: Tab; label: string; type: 'toggle'; path: string }
  | { tab: Tab; label: string; type: 'custom'; options: () => string[]; get: (b: Builder) => number; set: (b: Builder, i: number) => void }) & { show?: Show[]; zoom?: number; help?: string };
const only = (it: Item, ...show: Show[]): Item => ({ ...it, show });
const S = (tab: Tab, label: string, path: string, min: number, max: number, step = 0.01): Item => ({ tab, label, type: 'slider', path, min, max, step });
const CH = (tab: Tab, label: string, path: string, options: string[], zoom?: number): Item => ({ tab, label, type: 'choice', path, options, zoom });
const CO = (tab: Tab, label: string, path: string, presets: string[]): Item => ({ tab, label, type: 'color', path, presets });
const TG = (tab: Tab, label: string, path: string): Item => ({ tab, label, type: 'toggle', path });
const B = 'base' as const, K = 'chibi' as const;
const METALS = ['#d9b45a', '#c8c8d8', '#b87a4a', '#2a2a36', '#f2ecd8', '#e83a3a'];
const GLOWS = ['#45ecff', '#ff6ad0', '#8aff6a', '#ffd84a', '#b08aff', '#ff4a4a'];

const ITEMS: Item[] = [
  { tab: 'HERITAGE', label: 'Look', type: 'custom', options: () => ['Custom', ...presets().map((p) => p.name)], get: (b) => b.presetIdx, set: (b, i) => b.applyPreset(i), help: 'Ready-made characters to start from.' },
  { tab: 'HERITAGE', label: 'Sex', type: 'custom', options: () => ['Female', 'Male'], get: (b) => (b.spec.gender === 'female' ? 0 : 1), set: (b, i) => b.setGender(i === 0 ? 'female' : 'male') },
  CH('HERITAGE', 'Body type', 'base', BASES), S('HERITAGE', 'Height', 'height', 0.9, 1.1), S('HERITAGE', 'Build', 'build', 0, 1), S('HERITAGE', 'Shoulders', 'shoulders', 0, 1), only(S('HERITAGE', 'Bust', 'bust', 0, 1), 'female'), S('HERITAGE', 'Head size', 'head', 0.85, 1.2), CO('HERITAGE', 'Skin tone', 'skin', SKIN_TONES),
  only(S('FEATURES', 'Face width', 'face.width', -1, 1), K), S('FEATURES', 'Jaw', 'face.jaw', -1, 1), S('FEATURES', 'Chin forward', 'face.chin', -1, 1), S('FEATURES', 'Chin width', 'face.chinWidth', -1, 1), S('FEATURES', 'Cheek width', 'face.cheekWidth', -1, 1),
  only(CH('FEATURES', 'Eye shape', 'face.eyeShape', EYE_SHAPES), K), S('FEATURES', 'Eye size', 'face.eyeSize', 0.7, 1.3), S('FEATURES', 'Eye distance', 'face.eyeSpacing', -1, 1), S('FEATURES', 'Eye height', 'face.eyeHeight', -1, 1), only(S('FEATURES', 'Eye tilt', 'face.eyeTilt', -1, 1), K),
  CO('FEATURES', 'Eye colour', 'face.iris', IRIS_COLORS), only(S('FEATURES', 'Lashes', 'face.lash', 0, 1), K), only(CO('FEATURES', 'Eyeshadow', 'face.shadow', SHADOW_COLORS), K), only(S('FEATURES', 'Eyeshadow amount', 'face.shadowAmt', 0, 1), K),
  only(S('FEATURES', 'Brow thickness', 'face.brow', 0, 1), K), only(S('FEATURES', 'Brow angle', 'face.browAngle', -1, 1), K), only(S('FEATURES', 'Brow height', 'face.browHeight', -1, 1), K),
  only(S('FEATURES', 'Nose size', 'face.noseSize', 0.6, 1.5), K), only(S('FEATURES', 'Nose width', 'face.noseWidth', 0.6, 1.6), K), only(S('FEATURES', 'Nose height', 'face.noseHeight', -1, 1), K),
  only(CH('FEATURES', 'Mouth', 'face.mouth', MOUTHS), K), only(CO('FEATURES', 'Lip colour', 'face.lips', LIP_COLORS), K), only(S('FEATURES', 'Lip tint', 'face.lipAmt', 0, 1), K), only(S('FEATURES', 'Mouth width', 'face.mouthWidth', 0.6, 1.5), K), only(S('FEATURES', 'Mouth height', 'face.mouthHeight', -1, 1), K),
  only(S('FEATURES', 'Blush', 'face.blush', 0, 1), K), only(TG('FEATURES', 'Freckles', 'face.freckles'), K), CH('FEATURES', 'Facial hair', 'face.beard', BEARDS), only(TG('FEATURES', 'Scar', 'face.scar'), K), only(CH('FEATURES', 'Ears', 'face.ears', EARS), K), only(S('FEATURES', 'Ear size', 'face.earSize', 0.7, 1.5), K),
  only(CH('HAIR', 'Hairstyle', 'hair.base', BASE_HAIR), B), only(CH('HAIR', 'Hairstyle', 'hair.style', HAIR_STYLES), K), only(S('HAIR', 'Length', 'hair.len', 0.5, 1.6), B), S('HAIR', 'Bangs', 'hair.bangs', 0.6, 1.5),
  CO('HAIR', 'Hair colour', 'hair.color', HAIR_COLORS), CO('HAIR', 'Tip colour', 'hair.tip', HAIR_COLORS), only(CO('HAIR', 'Highlight', 'hair.sheen', HAIR_COLORS), K), CH('HAIR', 'Facial hair', 'face.beard', BEARDS),
  only(CH('APPAREL', 'Outfit', 'outfit.look', OUTFITS), B),
  only(CH('APPAREL', 'Top', 'outfit.top', TOPS), K), only(CH('APPAREL', 'Bottom', 'outfit.bottom', BOTTOMS), K), only(CH('APPAREL', 'Boots', 'outfit.boots', BOOTS), K), only(CH('APPAREL', 'Hat', 'outfit.hat', HATS), K), only(CO('APPAREL', 'Hat colour', 'outfit.hatColor', OUTFIT_COLORS), K),
  CO('APPAREL', 'Main colour', 'outfit.primary', OUTFIT_COLORS), CO('APPAREL', 'Second colour', 'outfit.secondary', OUTFIT_COLORS), CO('APPAREL', 'Accent', 'outfit.accent', OUTFIT_COLORS),
  CO('APPAREL', 'Trim', 'outfit.trim', ['#e6b23a', '#f2ecd8', '#c8c8d8', '#ff8a2a']), CO('APPAREL', 'Legwear', 'outfit.pants', OUTFIT_COLORS), CO('APPAREL', 'Shoes', 'outfit.bootColor', ['#181a26', '#2a1a14', '#f2ecd8', '#34439a', '#e83a3a']),
  TG('APPAREL', 'Gloves', 'outfit.gloves'), CO('APPAREL', 'Glove colour', 'outfit.gloveColor', ['#f7f8fd', '#181a26', '#e83a3a', '#e6b23a', '#2a7de1']),
  only(CO('APPAREL', 'Scarf colour', 'outfit.scarfColor', OUTFIT_COLORS), K), only(CO('APPAREL', 'Headband colour', 'outfit.headbandColor', OUTFIT_COLORS), K), only(CO('APPAREL', 'Glow', 'outfit.glow', GLOWS), K),
  only(TG('APPAREL', 'Scarf', 'outfit.scarf'), K), CH('APPAREL', 'Weapon', 'outfit.weapon', WEAPONS), only(TG('APPAREL', 'Headband', 'outfit.headband'), K), only(TG('APPAREL', 'Wings', 'outfit.wings'), K), only(TG('APPAREL', 'Earrings', 'outfit.earrings'), K),
  only(CH('ACCESSORIES', 'Hat', 'acc.hat', HATS_BASE, 0.85), B), only(CO('ACCESSORIES', 'Hat colour', 'outfit.hatColor', OUTFIT_COLORS), B),
  only(CH('ACCESSORIES', 'Glasses', 'face.glasses', GLASSES_BASE, 1), B), only(CH('ACCESSORIES', 'Glasses', 'face.glasses', GLASSES, 1), K),
  only(CH('ACCESSORIES', 'Earrings', 'acc.ear', EARRINGS, 1), B), only(CH('ACCESSORIES', 'Neckwear', 'acc.neck', NECKWEAR, 0.6), B), only(CH('ACCESSORIES', 'Wristwear', 'acc.wrist', WRISTWEAR, 0), B),
  only(CH('ACCESSORIES', 'Mask', 'acc.mask', MASKS, 1), B), only(CH('ACCESSORIES', 'Face paint', 'acc.paint', FACE_PAINT, 1), B), only(CH('ACCESSORIES', 'Back', 'acc.back', BACKWEAR, 0), B),
  only(CO('ACCESSORIES', 'Accessory colour', 'acc.color', OUTFIT_COLORS), B), only(CO('ACCESSORIES', 'Metal', 'acc.metal', METALS), B), only(CO('ACCESSORIES', 'Glow / gems', 'acc.glow', GLOWS), B),
];

/* eslint-disable @typescript-eslint/no-explicit-any */
const get = (o: any, p: string) => p.split('.').reduce((a, k) => a?.[k], o);
const set = (o: any, p: string, v: unknown) => { const k = p.split('.'); const last = k.pop()!; k.reduce((a, x) => (a[x] ??= {}), o)[last] = v; };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

export class Builder {
  spec: CharacterSpec;
  presetIdx = 0;
  private preview: Preview | null = null;
  private tab: Tab = 'HERITAGE';
  private panel: HTMLElement;
  private rows: { el: HTMLElement; item: Item; step: (d: number) => void }[] = [];
  private sel = 0;
  private keyFn = (e: KeyboardEvent) => this.onKey(e);

  constructor(private root: HTMLElement, spec: CharacterSpec, private onDone: (s: CharacterSpec) => void) {
    this.spec = normalize(JSON.parse(JSON.stringify(spec)));
    this.panel = root.querySelector('#cb-panel') as HTMLElement;
  }

  /** dev tooling: patch the spec from the console / tests */
  devSet(fn: (s: CharacterSpec) => void, zoom?: number, yaw?: number): void { fn(this.spec); this.changed(); this.renderTab(); if (zoom !== undefined) this.preview?.setZoom(zoom); if (yaw !== undefined) this.preview?.setYaw(yaw); }

  async open(): Promise<void> {
    this.root.classList.add('show');
    if (location.search.includes('dev=1')) (window as unknown as { __builder: Builder }).__builder = this;
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
    const tabs = q('#cb-tabs'); tabs.innerHTML = '';
    TABS.forEach((t) => {
      const b = el('button', 'cb-tab'); b.dataset.tab = t.id; b.innerHTML = `<i>${t.icon}</i><span>${t.id}</span>`;
      b.onclick = () => this.setTab(t.id);
      tabs.appendChild(b);
    });
    q('#cb-random').onclick = () => { this.presetIdx = 0; this.replace(randomSpec(this.spec.gender)); };
    q('#cb-reset').onclick = () => { this.presetIdx = 0; this.replace(defaultSpec(this.spec.gender)); };
    q('#cb-done').onclick = () => this.close(true);
    ['idle', 'walk', 'run', 'fly'].forEach((d) => { q('#cb-demo-' + d).onclick = () => { this.preview?.setDemo(d as 'idle'); this.root.querySelectorAll('#cb-demo button').forEach((x) => x.classList.toggle('on', x.id === 'cb-demo-' + d)); }; });
    window.addEventListener('keydown', this.keyFn);
    this.renderTab();
    this.preview = new Preview(q<HTMLCanvasElement>('#preview'), this.spec);
    const ok = await this.preview.start();
    if (!ok) { this.preview.dispose(); this.preview = null; q('#cb-note').textContent = 'Live preview is not available on this device, but you can still edit and save your character.'; }
    else this.preview.setZoom(this.tabInfo().zoom);
  }

  private tabInfo() { return TABS.find((t) => t.id === this.tab)!; }
  private setTab(t: Tab): void { this.tab = t; this.sel = 0; this.renderTab(); this.preview?.setZoom(this.tabInfo().zoom); }

  private close(save: boolean): void {
    window.removeEventListener('keydown', this.keyFn);
    this.preview?.dispose(); this.preview = null;
    this.root.classList.remove('show');
    if (save) this.onDone(this.spec);
  }

  setGender(g: Gender): void {
    if (g === this.spec.gender) return;
    const n = defaultSpec(g); n.skin = this.spec.skin; this.presetIdx = 0;
    this.replace(n);
  }
  applyPreset(i: number): void {
    this.presetIdx = i;
    if (i > 0) { const p = presets()[i - 1]; this.spec = normalize(JSON.parse(JSON.stringify(p.spec))); this.preview?.setSpec(this.spec); }
    this.renderTab();
  }

  private replace(s: CharacterSpec): void { this.spec = normalize(s); this.preview?.setSpec(this.spec); this.renderTab(); }
  private changed(): void { this.preview?.setSpec(JSON.parse(JSON.stringify(this.spec))); }

  private onKey(e: KeyboardEvent): void {
    if (!this.root.classList.contains('show')) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') { this.select(this.sel + (k === 'ArrowDown' ? 1 : -1)); e.preventDefault(); }
    else if (k === 'ArrowLeft' || k === 'ArrowRight') { this.rows[this.sel]?.step(k === 'ArrowRight' ? 1 : -1); e.preventDefault(); }
    else if (k === 'q' || k === 'e' || k === 'Q' || k === 'E') { const i = TABS.findIndex((t) => t.id === this.tab), n = TABS.length; this.setTab(TABS[(i + (k.toLowerCase() === 'e' ? 1 : n - 1)) % n].id); }
    else if (k === 'Enter') this.close(true);
  }

  private select(i: number, scroll = true): void {
    if (!this.rows.length) return;
    this.sel = (i + this.rows.length) % this.rows.length;
    this.rows.forEach((r, j) => r.el.classList.toggle('sel', j === this.sel));
    const r = this.rows[this.sel];
    if (scroll) r.el.scrollIntoView({ block: 'nearest' });
    (this.root.querySelector('#cb-help') as HTMLElement).textContent = r.item.help ?? this.tabInfo().help;
    (this.root.querySelector('#cb-count') as HTMLElement).textContent = `${this.sel + 1}/${this.rows.length}`;
    if (r.item.zoom !== undefined) this.preview?.setZoom(r.item.zoom);
  }

  private renderTab(): void {
    this.root.querySelectorAll<HTMLElement>('#cb-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    (this.root.querySelector('#cb-sub') as HTMLElement).textContent = this.tab;
    this.panel.innerHTML = '';
    this.rows = [];
    const base = (this.spec.base ?? 0) === 0;
    const visible = (i: Item) => !i.show || i.show.every((k) => (k === 'base' ? base : k === 'chibi' ? !base : this.spec.gender === 'female'));
    for (const it of ITEMS.filter((i) => i.tab === this.tab && visible(i))) {
      const row = el('div', 'cb-row'), idx = this.rows.length;
      row.appendChild(el('label', '', it.label));
      let step: (d: number) => void = () => {};
      if (it.type === 'slider') {
        const inp = el('input'); inp.type = 'range'; inp.min = String(it.min); inp.max = String(it.max); inp.step = String(it.step);
        inp.value = String(get(this.spec, it.path) ?? (it.min + it.max) / 2);
        inp.oninput = () => { set(this.spec, it.path, parseFloat(inp.value)); this.changed(); };
        step = (d) => { inp.value = String(Math.min(it.max, Math.max(it.min, parseFloat(inp.value) + d * (it.max - it.min) / 20))); inp.oninput!(new Event('input')); };
        row.appendChild(inp);
      } else if (it.type === 'choice' || it.type === 'custom') {
        const opts = it.type === 'choice' ? it.options : it.options();
        const cur = () => (it.type === 'choice' ? (get(this.spec, it.path) as number) ?? 0 : it.get(this));
        const val = el('span', 'cb-val'), l = el('button', 'cb-arrow', '‹'), r = el('button', 'cb-arrow', '›'), txt = el('b'), cnt = el('small');
        const paint = () => { const i = cur(); txt.textContent = opts[i] ?? '—'; cnt.textContent = `${i + 1}/${opts.length}`; };
        step = (d) => {
          const i = (cur() + d + opts.length) % opts.length;
          if (it.type === 'custom') { it.set(this, i); return; }
          set(this.spec, it.path, i);
          if (it.path === 'outfit.look' && OUTFIT_PALETTES[i]) { Object.assign(this.spec.outfit, OUTFIT_PALETTES[i], { gloves: false }); }
          this.presetIdx = 0; this.changed();
          if (it.path === 'base') { this.renderTab(); return; }
          paint();
        };
        l.onclick = (e) => { e.stopPropagation(); this.select(idx, false); step(-1); };
        r.onclick = (e) => { e.stopPropagation(); this.select(idx, false); step(1); };
        txt.onclick = (e) => { e.stopPropagation(); this.select(idx, false); step(1); };
        val.append(l, txt, cnt, r); row.appendChild(val); paint();
      } else if (it.type === 'color') {
        row.classList.add('cb-colrow');
        const wrap = el('div', 'cb-sw');
        const mark = () => wrap.querySelectorAll<HTMLElement>('i').forEach((x) => x.classList.toggle('on', x.dataset.c === get(this.spec, it.path)));
        it.presets.forEach((c) => {
          const i = el('i'); i.style.background = c; i.dataset.c = c;
          i.onclick = () => { set(this.spec, it.path, c); mark(); this.presetIdx = 0; this.changed(); };
          wrap.appendChild(i);
        });
        const pick = el('input'); pick.type = 'color'; pick.value = get(this.spec, it.path) ?? '#ffffff';
        pick.oninput = () => { set(this.spec, it.path, pick.value); mark(); this.changed(); };
        wrap.appendChild(pick); mark(); row.appendChild(wrap);
        step = (d) => { const i = Math.max(0, it.presets.indexOf(get(this.spec, it.path))); const c = it.presets[(i + d + it.presets.length) % it.presets.length]; set(this.spec, it.path, c); mark(); this.changed(); };
      } else {
        const b = el('button', 'cb-tog');
        const upd = () => { const v = !!get(this.spec, it.path); b.textContent = v ? 'ON' : 'OFF'; b.classList.toggle('on', v); };
        step = () => { set(this.spec, it.path, !get(this.spec, it.path)); upd(); this.changed(); };
        b.onclick = (e) => { e.stopPropagation(); this.select(idx, false); step(1); };
        upd(); row.appendChild(b);
      }
      row.onclick = () => this.select(idx, false);
      this.panel.appendChild(row);
      this.rows.push({ el: row, item: it, step });
    }
    this.select(Math.min(this.sel, this.rows.length - 1), false);
  }
}
