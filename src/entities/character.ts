/** Character builder data: everything about the player's look as a small JSON-serialisable spec. */

export type Gender = 'female' | 'male';

export interface CharacterSpec {
  v: 1;
  gender: Gender;
  // body
  height: number;      // 0.9 .. 1.1
  build: number;       // 0 slim .. 1 sturdy
  head: number;        // 0.85 .. 1.2 head size
  skin: string;
  // face
  face: {
    width: number;     // -1 narrow .. 1 wide
    jaw: number;       // -1 soft/round .. 1 strong
    eyeShape: number;  // 0 round, 1 sharp, 2 sleepy, 3 cat
    eyeSize: number;   // 0.7 .. 1.3
    eyeSpacing: number;// -1 close .. 1 far
    eyeHeight: number; // -1 low .. 1 high
    eyeTilt: number;   // -1 droopy .. 1 upturned
    iris: string;
    lash: number;      // 0 .. 1
    brow: number;      // thickness 0 .. 1
    browAngle: number; // -1 soft .. 1 stern
    browHeight: number;// -1 .. 1
    noseSize: number;  // 0.6 .. 1.5
    noseWidth: number; // 0.6 .. 1.6
    noseHeight: number;// -1 .. 1
    mouth: number;     // 0 smile, 1 neutral, 2 open grin, 3 smirk, 4 pout
    mouthWidth: number;// 0.6 .. 1.5
    mouthHeight: number;// -1 .. 1
    blush: number;     // 0 .. 1
    freckles: boolean;
    ears: number;      // 0 round, 1 elf, 2 cat
    earSize: number;   // 0.7 .. 1.5
  };
  // hair
  hair: { style: number; color: string; tip: string; sheen: string; bangs: number };
  // outfit
  outfit: {
    top: number;       // 0 jacket, 1 vest, 2 long coat
    bottom: number;    // 0 skirt, 1 shorts, 2 pants, 3 hakama
    boots: number;     // 0 tall boots, 1 ankle boots, 2 sneakers
    primary: string; secondary: string; accent: string; trim: string; pants: string; bootColor: string; scarfColor: string; headbandColor: string; glow: string;
    scarf: boolean; katana: boolean; headband: boolean; wings: boolean;
  };
}

export const HAIR_STYLES = ['Spiky', 'Ponytail', 'Bob', 'Long Straight', 'Twin Tails', 'Braid', 'Odango Buns', 'Short Messy', 'Side Swept', 'Topknot', 'Wavy Long', 'Slick Short'];
export const EYE_SHAPES = ['Round', 'Sharp', 'Sleepy', 'Cat'];
export const MOUTHS = ['Smile', 'Neutral', 'Grin', 'Smirk', 'Pout'];
export const EARS = ['Round', 'Elf', 'Cat'];
export const TOPS = ['Jacket', 'Vest', 'Long Coat'];
export const BOTTOMS = ['Skirt', 'Shorts', 'Pants', 'Hakama'];
export const BOOTS = ['Tall Boots', 'Ankle Boots', 'Sneakers'];

export const SKIN_TONES = ['#ffe3d0', '#ffd6bd', '#f5c2a0', '#e8a982', '#d08e66', '#b3714c', '#8f5535', '#6e3f27', '#4e2d1d', '#3a2216', '#d9e8f2', '#c9e6c9'];
export const HAIR_COLORS = ['#14122a', '#2a1a14', '#4a2a1a', '#7a4a2a', '#b07a3a', '#e6c46a', '#f2ecd8', '#c8c8d8', '#d8335a', '#ff7aa8', '#7a3ad8', '#2a5ae0', '#27b9c9', '#2fbf6a', '#ff8a2a', '#e83a3a'];
export const IRIS_COLORS = ['#3f8cff', '#27c4d8', '#2fbf6a', '#9ad82a', '#e6b23a', '#ff8a2a', '#e83a3a', '#d83a9a', '#9a5ae0', '#6a6a7a', '#3a2a1a', '#1a1a30'];
export const OUTFIT_COLORS = ['#1b2352', '#34439a', '#2a7de1', '#27b9c9', '#2fbf6a', '#9ad82a', '#f2ecd8', '#e6b23a', '#ff8a2a', '#e83a3a', '#d83a9a', '#7a3ad8', '#2a2a36', '#6e4a2a'];

export function defaultSpec(gender: Gender = 'female'): CharacterSpec {
  const f = gender === 'female';
  return {
    v: 1, gender, height: f ? 0.97 : 1.04, build: f ? 0.2 : 0.7, head: f ? 1.05 : 0.98, skin: '#ffd6bd',
    face: {
      width: f ? -0.2 : 0.3, jaw: f ? -0.4 : 0.6, eyeShape: f ? 0 : 1, eyeSize: f ? 1.1 : 0.95, eyeSpacing: 0, eyeHeight: 0, eyeTilt: f ? 0.1 : 0.3,
      iris: f ? '#3f8cff' : '#27c4d8', lash: f ? 0.8 : 0.35, brow: f ? 0.35 : 0.7, browAngle: f ? 0 : 0.4, browHeight: 0, noseSize: 1, noseWidth: f ? 0.85 : 1.15, noseHeight: 0,
      mouth: f ? 0 : 3, mouthWidth: 1, mouthHeight: 0, blush: f ? 0.7 : 0.25, freckles: false, ears: 0, earSize: 1,
    },
    hair: f ? { style: 1, color: '#14122a', tip: '#5a6fe0', sheen: '#8aa0ff', bangs: 1 } : { style: 0, color: '#1b1b2e', tip: '#34439a', sheen: '#7a8ad8', bangs: 1 },
    outfit: {
      top: 0, bottom: f ? 0 : 2, boots: 0, primary: '#1b2352', secondary: '#34439a', accent: '#d02e48', trim: '#e6b23a', pants: f ? '#242a49' : '#2a2f46', bootColor: '#181a26',
      scarfColor: '#d02e48', headbandColor: '#d02e48', glow: '#45ecff', scarf: true, katana: true, headband: true, wings: f,
    },
  };
}

/** fills missing fields (older saves) with defaults */
export function normalize(s: Partial<CharacterSpec> | null | undefined): CharacterSpec {
  const d = defaultSpec((s?.gender as Gender) ?? 'female');
  if (!s) return d;
  return { ...d, ...s, face: { ...d.face, ...(s.face ?? {}) }, hair: { ...d.hair, ...(s.hair ?? {}) }, outfit: { ...d.outfit, ...(s.outfit ?? {}) }, v: 1 };
}

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const rr = (a: number, b: number) => a + Math.random() * (b - a);

export function randomSpec(gender?: Gender): CharacterSpec {
  const g: Gender = gender ?? (Math.random() < 0.5 ? 'female' : 'male');
  const s = defaultSpec(g);
  s.height = rr(0.92, 1.08); s.build = rr(0, 1); s.head = rr(0.92, 1.12); s.skin = pick(SKIN_TONES.slice(0, 10));
  Object.assign(s.face, {
    width: rr(-0.7, 0.7), jaw: rr(-0.8, 0.8), eyeShape: Math.floor(Math.random() * 4), eyeSize: rr(0.85, 1.25), eyeSpacing: rr(-0.6, 0.6), eyeHeight: rr(-0.5, 0.5), eyeTilt: rr(-0.6, 0.8),
    iris: pick(IRIS_COLORS), lash: rr(0.2, 1), brow: rr(0.1, 0.9), browAngle: rr(-0.5, 0.8), browHeight: rr(-0.5, 0.5), noseSize: rr(0.8, 1.2), noseWidth: rr(0.8, 1.3), noseHeight: rr(-0.5, 0.5),
    mouth: Math.floor(Math.random() * 5), mouthWidth: rr(0.8, 1.2), mouthHeight: rr(-0.5, 0.5), blush: rr(0, 0.9), freckles: Math.random() < 0.2, ears: Math.random() < 0.8 ? 0 : 1 + Math.floor(Math.random() * 2), earSize: rr(0.8, 1.3),
  });
  s.hair = { style: Math.floor(Math.random() * HAIR_STYLES.length), color: pick(HAIR_COLORS), tip: pick(HAIR_COLORS), sheen: pick(HAIR_COLORS), bangs: rr(0.7, 1.4) };
  Object.assign(s.outfit, {
    top: Math.floor(Math.random() * 3), bottom: Math.floor(Math.random() * 4), boots: Math.floor(Math.random() * 3), primary: pick(OUTFIT_COLORS), secondary: pick(OUTFIT_COLORS), accent: pick(OUTFIT_COLORS),
    trim: pick(['#e6b23a', '#f2ecd8', '#c8c8d8', '#ff8a2a']), pants: pick(OUTFIT_COLORS), bootColor: pick(['#181a26', '#2a1a14', '#f2ecd8', '#34439a']), scarfColor: pick(OUTFIT_COLORS), headbandColor: pick(OUTFIT_COLORS),
    glow: pick(['#45ecff', '#ff6ad0', '#8aff6a', '#ffd84a', '#b08aff']), scarf: Math.random() < 0.7, katana: Math.random() < 0.6, headband: Math.random() < 0.6, wings: Math.random() < 0.4,
  });
  return s;
}
