/** Character builder data: everything about the player's look as a small JSON-serialisable spec. */

export type Gender = 'female' | 'male';

export interface CharacterSpec {
  v: 1;
  gender: Gender;
  /** 0 = rigged base model (realistic proportions), 1 = classic anime chibi */
  base: number;
  // body
  height: number;      // 0.9 .. 1.1
  shoulders: number;   // 0 narrow .. 1 broad
  bust: number;        // 0 .. 1 (female chest shape)
  build: number;       // 0 slim .. 1 sturdy
  head: number;        // 0.85 .. 1.2 head size
  skin: string;
  // face
  face: {
    width: number;     // -1 narrow .. 1 wide
    jaw: number;       // -1 soft/round .. 1 strong
    chin: number;      // -1 receding .. 1 jutting forward
    chinWidth: number; // -1 pointed .. 1 broad
    cheekWidth: number;// -1 slim .. 1 full
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
    shadow: string;    // eyeshadow colour
    shadowAmt: number; // 0 .. 1
    lips: string;      // lip colour
    lipAmt: number;    // 0 .. 1
    beard: number;     // 0 none, 1 stubble, 2 goatee, 3 full beard, 4 moustache
    scar: boolean;
    glasses: number;   // 0 none, 1 round, 2 square, 3 shades
  };
  // hair
  hair: { style: number; color: string; tip: string; sheen: string; bangs: number };
  // outfit
  outfit: {
    top: number;       // 0 jacket, 1 vest, 2 long coat, 3 military coat, 4 dress
    bottom: number;    // 0 skirt, 1 shorts, 2 pants, 3 hakama, 4 tights
    boots: number;     // 0 tall boots, 1 ankle boots, 2 sneakers, 3 chunky boots
    hat: number;       // 0 none, 1 peaked cap, 2 beret
    hatColor: string; gloveColor: string;
    gloves: boolean; earrings: boolean;
    primary: string; secondary: string; accent: string; trim: string; pants: string; bootColor: string; scarfColor: string; headbandColor: string; glow: string;
    scarf: boolean; katana: boolean; headband: boolean; wings: boolean;
    weapon: number;    // 0 none, 1 katana at the waist, 2 sword on the back, 3 twin swords crossed on the back
  };
}

export const HAIR_STYLES = ['Spiky', 'Ponytail', 'Bob', 'Long Straight', 'Twin Tails', 'Braid', 'Odango Buns', 'Short Messy', 'Side Swept', 'Topknot', 'Wavy Long', 'Slick Short', 'Big Volume', 'Wild Spikes', 'Hime Cut', 'Undercut', 'Mohawk', 'Man Bun', 'Afro', 'Buzz Cut', 'Wolf Cut', 'Long Ponytail'];
export const BEARDS = ['None', 'Stubble', 'Goatee', 'Full Beard', 'Moustache'];
export const GLASSES = ['None', 'Round', 'Square', 'Shades'];
export const BASES = ['Base Model', 'Anime Chibi'];
export const WEAPONS = ['None', 'Katana (waist)', 'Back Sword', 'Twin Back Swords'];
export const EYE_SHAPES = ['Round', 'Sharp', 'Sleepy', 'Cat'];
export const MOUTHS = ['Smile', 'Neutral', 'Grin', 'Smirk', 'Pout'];
export const EARS = ['Round', 'Elf', 'Cat'];
export const TOPS = ['Jacket', 'Vest', 'Long Coat', 'Military Coat', 'Dress', 'Knight Armor'];
export const BOTTOMS = ['Skirt', 'Shorts', 'Pants', 'Hakama', 'Tights'];
export const BOOTS = ['Tall Boots', 'Ankle Boots', 'Sneakers', 'Chunky Boots', 'Greaves'];
export const HATS = ['None', 'Peaked Cap', 'Beret'];
export const SHADOW_COLORS = ['#7a5ae0', '#3f6ad8', '#d83a9a', '#e8803a', '#6a3a2a', '#2fbf6a', '#1a1a30'];
export const LIP_COLORS = ['#d0626f', '#b03a4a', '#7a2e3c', '#e88a8a', '#5a2a3a', '#ff6a9a', '#a85a4a'];

export const SKIN_TONES = ['#ffe3d0', '#ffd6bd', '#f5c2a0', '#e8a982', '#d08e66', '#b3714c', '#8f5535', '#6e3f27', '#4e2d1d', '#3a2216', '#d9e8f2', '#c9e6c9'];
export const HAIR_COLORS = ['#14122a', '#2a1a14', '#4a2a1a', '#7a4a2a', '#b07a3a', '#e6c46a', '#f2ecd8', '#c8c8d8', '#d8335a', '#ff7aa8', '#7a3ad8', '#2a5ae0', '#27b9c9', '#2fbf6a', '#ff8a2a', '#e83a3a'];
export const IRIS_COLORS = ['#3f8cff', '#27c4d8', '#2fbf6a', '#9ad82a', '#e6b23a', '#ff8a2a', '#e83a3a', '#d83a9a', '#9a5ae0', '#6a6a7a', '#3a2a1a', '#1a1a30'];
export const OUTFIT_COLORS = ['#1b2352', '#34439a', '#2a7de1', '#27b9c9', '#2fbf6a', '#9ad82a', '#f2ecd8', '#e6b23a', '#ff8a2a', '#e83a3a', '#d83a9a', '#7a3ad8', '#2a2a36', '#6e4a2a'];

export function defaultSpec(gender: Gender = 'female'): CharacterSpec {
  const f = gender === 'female';
  return {
    v: 1, gender, base: 0, height: f ? 0.97 : 1.04, shoulders: f ? 0.3 : 0.7, bust: f ? 0.5 : 0, build: f ? 0.2 : 0.7, head: f ? 1.05 : 0.98, skin: '#ffd6bd',
    face: {
      width: f ? -0.2 : 0.3, jaw: f ? -0.4 : 0.6, chin: 0, chinWidth: 0, cheekWidth: 0, eyeShape: f ? 0 : 1, eyeSize: f ? 1.1 : 0.95, eyeSpacing: 0, eyeHeight: 0, eyeTilt: f ? 0.1 : 0.3,
      iris: f ? '#3f8cff' : '#27c4d8', lash: f ? 0.8 : 0.35, brow: f ? 0.35 : 0.7, browAngle: f ? 0 : 0.4, browHeight: 0, noseSize: 1, noseWidth: f ? 0.85 : 1.15, noseHeight: 0,
      mouth: f ? 0 : 3, mouthWidth: 1, mouthHeight: 0, blush: f ? 0.7 : 0.25, freckles: false, ears: 0, earSize: 1,
      shadow: '#7a5ae0', shadowAmt: f ? 0.35 : 0, lips: '#d0626f', lipAmt: f ? 0.4 : 0, beard: 0, scar: false, glasses: 0,
    },
    hair: f ? { style: 1, color: '#14122a', tip: '#5a6fe0', sheen: '#8aa0ff', bangs: 1 } : { style: 0, color: '#1b1b2e', tip: '#34439a', sheen: '#7a8ad8', bangs: 1 },
    outfit: {
      top: 0, bottom: f ? 0 : 2, boots: 0, primary: '#1b2352', secondary: '#34439a', accent: '#d02e48', trim: '#e6b23a', pants: f ? '#242a49' : '#2a2f46', bootColor: '#181a26',
      scarfColor: '#d02e48', headbandColor: '#d02e48', glow: '#45ecff', scarf: true, katana: true, headband: true, wings: f,
      hat: 0, hatColor: '#1b2352', gloveColor: '#f7f8fd', gloves: true, earrings: false, weapon: 1,
    },
  };
}

/** fills missing fields (older saves) with defaults */
export function normalize(s: Partial<CharacterSpec> | null | undefined): CharacterSpec {
  const d = defaultSpec((s?.gender as Gender) ?? 'female');
  if (!s) return d;
  const out: CharacterSpec = { ...d, ...s, face: { ...d.face, ...(s.face ?? {}) }, hair: { ...d.hair, ...(s.hair ?? {}) }, outfit: { ...d.outfit, ...(s.outfit ?? {}) }, v: 1 };
  if (s.outfit && (s.outfit as Partial<CharacterSpec['outfit']>).weapon === undefined) out.outfit.weapon = s.outfit.katana === false ? 0 : 1; // saves from before weapons
  out.outfit.katana = out.outfit.weapon === 1;
  return out;
}

/** ready-made looks shown at the top of the builder */
export function presets(): { name: string; spec: CharacterSpec }[] {
  const captain = defaultSpec('female');
  captain.skin = '#8f5535'; captain.head = 1.1; captain.build = 0.25;
  Object.assign(captain.face, { eyeShape: 1, eyeSize: 1.15, eyeTilt: 0.35, iris: '#7a5ae0', lash: 1, brow: 0.45, browAngle: 0.25, mouth: 3, blush: 0.15, shadow: '#7a5ae0', shadowAmt: 0.6, lips: '#5a2a3a', lipAmt: 0.6, jaw: -0.5, width: -0.1 });
  captain.hair = { style: 12, color: '#141230', tip: '#262a5a', sheen: '#5a6fe0', bangs: 1.1 };
  Object.assign(captain.outfit, { top: 3, bottom: 4, boots: 3, primary: '#3fbf2f', secondary: '#2a9a24', accent: '#2a3fa0', trim: '#e6c43a', pants: '#2a2f3e', bootColor: '#2e3442', hat: 1, hatColor: '#3fbf2f', gloves: true, gloveColor: '#f7f8fd', earrings: true, wings: true, scarf: false, katana: false, weapon: 0, headband: false, glow: '#ffd84a' });
  const imp = defaultSpec('female');
  imp.skin = '#f2a6c6'; imp.head = 1.12; imp.height = 0.92; imp.build = 0.1;
  Object.assign(imp.face, { eyeShape: 3, eyeSize: 1.2, iris: '#9ad82a', lash: 0.9, mouth: 2, ears: 1, earSize: 1.2, blush: 0.6, shadow: '#d83a9a', shadowAmt: 0.4, lips: '#b03a4a', lipAmt: 0.3 });
  imp.hair = { style: 13, color: '#c8243a', tip: '#ff5a5a', sheen: '#ff8aa0', bangs: 1 };
  Object.assign(imp.outfit, { top: 4, bottom: 4, boots: 2, primary: '#f7f8fd', secondary: '#e8e4f0', accent: '#d8a02a', trim: '#e6b23a', pants: '#f2a6c6', bootColor: '#f7f8fd', hat: 0, gloves: true, gloveColor: '#f7f8fd', earrings: false, wings: false, scarf: false, katana: false, weapon: 0, headband: false, glow: '#ff6ad0' });
  const ronin = defaultSpec('male');
  ronin.skin = '#e8a982'; ronin.hair = { style: 13, color: '#1b1b2e', tip: '#34439a', sheen: '#7a8ad8', bangs: 1 };
  Object.assign(ronin.outfit, { top: 2, bottom: 3, boots: 1, primary: '#2a2a36', secondary: '#4a4a5a', accent: '#d02e48', gloves: false, weapon: 3 });
  Object.assign(ronin.face, { beard: 1, scar: true });
  const idol = defaultSpec('female');
  idol.skin = '#ffe3d0'; idol.hair = { style: 4, color: '#27b9c9', tip: '#9af2ff', sheen: '#d8ffff', bangs: 1 };
  Object.assign(idol.face, { iris: '#27c4d8', eyeSize: 1.25, mouth: 0 });
  Object.assign(idol.outfit, { top: 0, bottom: 0, boots: 0, primary: '#2a2a36', secondary: '#4a4a5a', accent: '#d83a9a', trim: '#27c4d8', pants: '#1a1a24', scarf: false, wings: false, gloves: false });
  const knight = defaultSpec('female');
  knight.skin = '#ffe3d0'; knight.height = 1.0; knight.build = 0.15; knight.bust = 0.6; knight.shoulders = 0.3;
  Object.assign(knight.face, { eyeShape: 0, eyeSize: 1.05, iris: '#6a5a8a', lash: 0.7, brow: 0.3, mouth: 1, blush: 0.35, shadowAmt: 0.15, lipAmt: 0.25, jaw: -0.3 });
  knight.hair = { style: 21, color: '#f2a6c6', tip: '#ffc8dc', sheen: '#fff0f6', bangs: 1.05 };
  Object.assign(knight.outfit, { top: 5, bottom: 4, boots: 4, primary: '#3a5a9a', secondary: '#4a6aaa', accent: '#5a3a22', trim: '#c8a24a', pants: '#2a2c36', bootColor: '#5a3a22', gloves: true, gloveColor: '#3a2a22', scarf: false, headband: false, wings: false, weapon: 1, hat: 0, earrings: false });
  return [
    { name: 'Knight', spec: knight },
    { name: 'Courier', spec: defaultSpec('female') }, { name: 'Captain', spec: captain }, { name: 'Imp', spec: imp },
    { name: 'Idol', spec: idol }, { name: 'Samurai', spec: defaultSpec('male') }, { name: 'Ronin', spec: ronin },
  ];
}

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const rr = (a: number, b: number) => a + Math.random() * (b - a);

export function randomSpec(gender?: Gender): CharacterSpec {
  const g: Gender = gender ?? (Math.random() < 0.5 ? 'female' : 'male');
  const s = defaultSpec(g);
  s.height = rr(0.92, 1.08); s.build = rr(0, 1); s.shoulders = rr(0, 1); s.bust = g === 'female' ? rr(0.2, 0.9) : 0; s.head = rr(0.92, 1.12); s.skin = pick(SKIN_TONES.slice(0, 10));
  Object.assign(s.face, {
    width: rr(-0.7, 0.7), jaw: rr(-0.8, 0.8), eyeShape: Math.floor(Math.random() * 4), eyeSize: rr(0.85, 1.25), eyeSpacing: rr(-0.6, 0.6), eyeHeight: rr(-0.5, 0.5), eyeTilt: rr(-0.6, 0.8),
    iris: pick(IRIS_COLORS), lash: rr(0.2, 1), brow: rr(0.1, 0.9), browAngle: rr(-0.5, 0.8), browHeight: rr(-0.5, 0.5), noseSize: rr(0.8, 1.2), noseWidth: rr(0.8, 1.3), noseHeight: rr(-0.5, 0.5),
    shadow: pick(SHADOW_COLORS), shadowAmt: g === 'female' ? rr(0, 0.7) : 0, lips: pick(LIP_COLORS), lipAmt: g === 'female' ? rr(0, 0.6) : 0,
    beard: g === 'male' && Math.random() < 0.4 ? 1 + Math.floor(Math.random() * 4) : 0, scar: Math.random() < 0.12, glasses: Math.random() < 0.15 ? 1 + Math.floor(Math.random() * 3) : 0,
    mouth: Math.floor(Math.random() * 5), mouthWidth: rr(0.8, 1.2), mouthHeight: rr(-0.5, 0.5), blush: rr(0, 0.9), freckles: Math.random() < 0.2, ears: Math.random() < 0.8 ? 0 : 1 + Math.floor(Math.random() * 2), earSize: rr(0.8, 1.3),
  });
  s.hair = { style: Math.floor(Math.random() * HAIR_STYLES.length), color: pick(HAIR_COLORS), tip: pick(HAIR_COLORS), sheen: pick(HAIR_COLORS), bangs: rr(0.7, 1.4) };
  Object.assign(s.outfit, {
    top: Math.floor(Math.random() * 5), bottom: Math.floor(Math.random() * 5), boots: Math.floor(Math.random() * 4), hat: Math.random() < 0.7 ? 0 : 1 + Math.floor(Math.random() * 2), hatColor: pick(OUTFIT_COLORS), gloves: Math.random() < 0.6, gloveColor: pick(['#f7f8fd', '#181a26', '#e83a3a']), earrings: Math.random() < 0.4, primary: pick(OUTFIT_COLORS), secondary: pick(OUTFIT_COLORS), accent: pick(OUTFIT_COLORS),
    trim: pick(['#e6b23a', '#f2ecd8', '#c8c8d8', '#ff8a2a']), pants: pick(OUTFIT_COLORS), bootColor: pick(['#181a26', '#2a1a14', '#f2ecd8', '#34439a']), scarfColor: pick(OUTFIT_COLORS), headbandColor: pick(OUTFIT_COLORS),
    glow: pick(['#45ecff', '#ff6ad0', '#8aff6a', '#ffd84a', '#b08aff']), scarf: Math.random() < 0.7, weapon: Math.floor(Math.random() * 4), headband: Math.random() < 0.6, wings: Math.random() < 0.4,
  });
  return s;
}
