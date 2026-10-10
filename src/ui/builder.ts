/** Character builder screen: schema-driven controls + live 3D preview. */
import { Preview } from './preview';
import { BEARDS, GLASSES, WEAPONS, BOOTS, BOTTOMS, EARS, EYE_SHAPES, HAIR_COLORS, HAIR_STYLES, HATS, IRIS_COLORS, LIP_COLORS, MOUTHS, OUTFIT_COLORS, SHADOW_COLORS, SKIN_TONES, TOPS, defaultSpec, normalize, presets, randomSpec, type CharacterSpec, type Gender } from '../entities/character';

type Tab = 'BODY' | 'FACE' | 'HAIR' | 'OUTFIT';
type Item =
  | { tab: Tab; label: string; type: 'slider'; path: string; min: number; max: number; step: number }
  | { tab: Tab; label: string; type: 'choice'; path: string; options: string[] }
  | { tab: Tab; label: string; type: 'color'; path: string; presets: string[] }
  | { tab: Tab; label: string; type: 'toggle'; path: string };

const S = (tab: Tab, label: string, path: string, min: number, max: number, step = 0.01): Item => ({ tab, label, type: 'slider', path, min, max, step });
const CH = (tab: Tab, label: string, path: string, options: string[]): Item => ({ tab, label, type: 'choice', path, options });
const CO = (tab: Tab, label: string, path: string, presets: string[]): Item => ({ tab, label, type: 'color', path, presets });
const TG = (tab: Tab, label: string, path: string): Item => ({ tab, label, type: 'toggle', path });

const ITEMS: Item[] = [
  S('BODY', 'Height', 'height', 0.9, 1.1), S('BODY', 'Build', 'build', 0, 1), S('BODY', 'Shoulders', 'shoulders', 0, 1), S('BODY', 'Bust', 'bust', 0, 1), S('BODY', 'Head size', 'head', 0.85, 1.2), CO('BODY', 'Skin', 'skin', SKIN_TONES),
  S('FACE', 'Face width', 'face.width', -1, 1), S('FACE', 'Jaw', 'face.jaw', -1, 1), S('FACE', 'Chin forward', 'face.chin', -1, 1), S('FACE', 'Chin width', 'face.chinWidth', -1, 1), S('FACE', 'Cheek width', 'face.cheekWidth', -1, 1),
  CH('FACE', 'Eye shape', 'face.eyeShape', EYE_SHAPES), S('FACE', 'Eye size', 'face.eyeSize', 0.7, 1.3), S('FACE', 'Eye distance', 'face.eyeSpacing', -1, 1), S('FACE', 'Eye height', 'face.eyeHeight', -1, 1), S('FACE', 'Eye tilt', 'face.eyeTilt', -1, 1),
  CO('FACE', 'Eye colour', 'face.iris', IRIS_COLORS), S('FACE', 'Lashes', 'face.lash', 0, 1), CO('FACE', 'Eyeshadow', 'face.shadow', SHADOW_COLORS), S('FACE', 'Eyeshadow amount', 'face.shadowAmt', 0, 1),
  S('FACE', 'Brow thickness', 'face.brow', 0, 1), S('FACE', 'Brow angle', 'face.browAngle', -1, 1), S('FACE', 'Brow height', 'face.browHeight', -1, 1),
  S('FACE', 'Nose size', 'face.noseSize', 0.6, 1.5), S('FACE', 'Nose broadness', 'face.noseWidth', 0.6, 1.6), S('FACE', 'Nose height', 'face.noseHeight', -1, 1),
  CH('FACE', 'Mouth', 'face.mouth', MOUTHS), CO('FACE', 'Lip colour', 'face.lips', LIP_COLORS), S('FACE', 'Lip tint', 'face.lipAmt', 0, 1), S('FACE', 'Mouth width', 'face.mouthWidth', 0.6, 1.5), S('FACE', 'Mouth height', 'face.mouthHeight', -1, 1),
  S('FACE', 'Blush', 'face.blush', 0, 1), TG('FACE', 'Freckles', 'face.freckles'), CH('FACE', 'Facial hair', 'face.beard', BEARDS), TG('FACE', 'Scar', 'face.scar'), CH('FACE', 'Glasses', 'face.glasses', GLASSES), CH('FACE', 'Ears', 'face.ears', EARS), S('FACE', 'Ear size', 'face.earSize', 0.7, 1.5),
  CH('HAIR', 'Style', 'hair.style', HAIR_STYLES), CO('HAIR', 'Hair colour', 'hair.color', HAIR_COLORS), CO('HAIR', 'Tip colour', 'hair.tip', HAIR_COLORS), CO('HAIR', 'Highlight', 'hair.sheen', HAIR_COLORS), S('HAIR', 'Bangs', 'hair.bangs', 0.6, 1.5),
  CH('OUTFIT', 'Top', 'outfit.top', TOPS), CH('OUTFIT', 'Bottom', 'outfit.bottom', BOTTOMS), CH('OUTFIT', 'Boots', 'outfit.boots', BOOTS), CH('OUTFIT', 'Hat', 'outfit.hat', HATS), CO('OUTFIT', 'Hat colour', 'outfit.hatColor', OUTFIT_COLORS),
  TG('OUTFIT', 'Gloves', 'outfit.gloves'), CO('OUTFIT', 'Glove colour', 'outfit.gloveColor', ['#f7f8fd', '#181a26', '#e83a3a', '#e6b23a', '#2a7de1']), TG('OUTFIT', 'Earrings', 'outfit.earrings'),
  CO('OUTFIT', 'Main colour', 'outfit.primary', OUTFIT_COLORS), CO('OUTFIT', 'Second colour', 'outfit.secondary', OUTFIT_COLORS), CO('OUTFIT', 'Accent', 'outfit.accent', OUTFIT_COLORS),
  CO('OUTFIT', 'Trim', 'outfit.trim', ['#e6b23a', '#f2ecd8', '#c8c8d8', '#ff8a2a']), CO('OUTFIT', 'Legwear', 'outfit.pants', OUTFIT_COLORS), CO('OUTFIT', 'Boot colour', 'outfit.bootColor', ['#181a26', '#2a1a14', '#f2ecd8', '#34439a']),
  CO('OUTFIT', 'Scarf colour', 'outfit.scarfColor', OUTFIT_COLORS), CO('OUTFIT', 'Headband colour', 'outfit.headbandColor', OUTFIT_COLORS), CO('OUTFIT', 'Glow', 'outfit.glow', ['#45ecff', '#ff6ad0', '#8aff6a', '#ffd84a', '#b08aff']),
  TG('OUTFIT', 'Scarf', 'outfit.scarf'), CH('OUTFIT', 'Weapon', 'outfit.weapon', WEAPONS), TG('OUTFIT', 'Headband', 'outfit.headband'), TG('OUTFIT', 'Wings', 'outfit.wings'),
];

/* eslint-disable @typescript-eslint/no-explicit-any */
const get = (o: any, p: string) => p.split('.').reduce((a, k) => a[k], o);
const set = (o: any, p: string, v: unknown) => { const k = p.split('.'); const last = k.pop()!; k.reduce((a, x) => a[x], o)[last] = v; };

export class Builder {
  private spec: CharacterSpec;
  private preview: Preview | null = null;
  private tab: Tab = 'FACE';
  private panel: HTMLElement;
  private sync: (() => void)[] = [];

  constructor(private root: HTMLElement, spec: CharacterSpec, private onDone: (s: CharacterSpec) => void) {
    this.spec = normalize(JSON.parse(JSON.stringify(spec)));
    this.panel = root.querySelector('#cb-panel') as HTMLElement;
  }

  async open(): Promise<void> {
    this.root.classList.add('show');
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
    q('#cb-tabs').innerHTML = '';
    (['BODY', 'FACE', 'HAIR', 'OUTFIT'] as Tab[]).forEach((t) => {
      const b = document.createElement('button'); b.textContent = t; b.className = 'alt'; b.dataset.tab = t;
      b.onclick = () => { this.tab = t; this.renderTab(); this.preview?.setZoom(t === 'FACE' ? 1 : 0); };
      q('#cb-tabs').appendChild(b);
    });
    q('#cb-gender').onclick = () => this.setGender(this.spec.gender === 'female' ? 'male' : 'female');
    q('#cb-random').onclick = () => this.replace(randomSpec(this.spec.gender));
    q('#cb-reset').onclick = () => this.replace(defaultSpec(this.spec.gender));
    q('#cb-done').onclick = () => this.close(true);
    ['idle', 'walk', 'run', 'fly'].forEach((d) => { q('#cb-demo-' + d).onclick = () => this.preview?.setDemo(d as 'idle'); });
    this.renderTab();
    this.preview = new Preview(q<HTMLCanvasElement>('#preview'), this.spec);
    const ok = await this.preview.start();
    if (!ok) { this.preview.dispose(); this.preview = null; q('#cb-note').textContent = 'Live preview is not available on this device, but you can still edit and save your character.'; }
    else this.preview.setZoom(this.tab === 'FACE' ? 1 : 0);
  }

  private close(save: boolean): void {
    this.preview?.dispose(); this.preview = null;
    this.root.classList.remove('show');
    if (save) this.onDone(this.spec);
  }

  private setGender(g: Gender): void {
    if (g === this.spec.gender) return;
    const keepSkin = this.spec.skin;
    const n = defaultSpec(g); n.skin = keepSkin;
    this.replace(n);
  }

  private replace(s: CharacterSpec): void {
    this.spec = s; this.preview?.setSpec(s); this.renderTab();
  }

  private changed(): void { this.preview?.setSpec(JSON.parse(JSON.stringify(this.spec))); }

  private renderTab(): void {
    this.root.querySelectorAll<HTMLElement>('#cb-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    (this.root.querySelector('#cb-gender') as HTMLElement).textContent = this.spec.gender === 'female' ? 'FEMALE' : 'MALE';
    this.panel.innerHTML = '';
    this.sync = [];
    {
      const row = document.createElement('div'); row.className = 'cb-row';
      const lab = document.createElement('label'); lab.textContent = 'Looks'; row.appendChild(lab);
      const wrap = document.createElement('div'); wrap.className = 'cb-opts';
      for (const p of presets()) { const b = document.createElement('button'); b.className = 'alt'; b.textContent = p.name; b.onclick = () => this.replace(normalize(p.spec)); wrap.appendChild(b); }
      row.appendChild(wrap); this.panel.appendChild(row);
    }
    for (const it of ITEMS.filter((i) => i.tab === this.tab)) {
      const row = document.createElement('div'); row.className = 'cb-row';
      const lab = document.createElement('label'); lab.textContent = it.label; row.appendChild(lab);
      if (it.type === 'slider') {
        const inp = document.createElement('input'); inp.type = 'range'; inp.min = String(it.min); inp.max = String(it.max); inp.step = String(it.step);
        inp.value = String(get(this.spec, it.path));
        inp.oninput = () => { set(this.spec, it.path, parseFloat(inp.value)); this.changed(); };
        row.appendChild(inp);
      } else if (it.type === 'choice') {
        const wrap = document.createElement('div'); wrap.className = 'cb-opts';
        it.options.forEach((o, i) => {
          const b = document.createElement('button'); b.textContent = o; b.className = 'alt';
          b.classList.toggle('on', get(this.spec, it.path) === i);
          b.onclick = () => { set(this.spec, it.path, i); wrap.querySelectorAll('button').forEach((x, j) => x.classList.toggle('on', j === i)); this.changed(); };
          wrap.appendChild(b);
        });
        row.appendChild(wrap);
      } else if (it.type === 'color') {
        const wrap = document.createElement('div'); wrap.className = 'cb-sw';
        const mark = () => wrap.querySelectorAll<HTMLElement>('i').forEach((x) => x.classList.toggle('on', x.dataset.c === get(this.spec, it.path)));
        it.presets.forEach((c) => {
          const i = document.createElement('i'); i.style.background = c; i.dataset.c = c;
          i.onclick = () => { set(this.spec, it.path, c); mark(); this.changed(); };
          wrap.appendChild(i);
        });
        const pick = document.createElement('input'); pick.type = 'color'; pick.value = get(this.spec, it.path);
        pick.oninput = () => { set(this.spec, it.path, pick.value); mark(); this.changed(); };
        wrap.appendChild(pick); mark(); row.appendChild(wrap);
      } else {
        const b = document.createElement('button'); b.className = 'alt';
        const upd = () => { const v = !!get(this.spec, it.path); b.textContent = v ? 'ON' : 'OFF'; b.classList.toggle('on', v); };
        b.onclick = () => { set(this.spec, it.path, !get(this.spec, it.path)); upd(); this.changed(); };
        upd(); row.appendChild(b);
      }
      this.panel.appendChild(row);
    }
  }
}
