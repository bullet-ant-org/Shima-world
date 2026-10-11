/**
 * Key art for the home and loading screens: one procedurally drawn SVG (sky, sun, Fuji, a floating island pouring a
 * waterfall, a dragon gliding past, pagoda and torii hills, a neon skyline, the bay) in parallax layers that the CSS pans
 * slowly. No image files, so it ships inside the offline bundle and costs nothing to download.
 */
const rnd = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

export type Mood = 'dusk' | 'night' | 'dawn';

export function sceneSVG(mood: Mood, seed = 7): string {
  const r = rnd(seed);
  const sky = mood === 'night' ? ['#070a1f', '#1b1550', '#5a1f6a', '#c2386a'] : mood === 'dawn' ? ['#16213f', '#3c4f8f', '#e58a7a', '#ffd2a0'] : ['#120c2c', '#3b1d5e', '#c23d6e', '#ff9a52'];
  const sun = mood === 'night' ? '#f2f0ff' : '#ffd6a0';
  // skyline towers
  let towers = '', windows = '', glow = '';
  for (let x = 560; x < 1640;) {
    const w = 26 + r() * 46, h = 120 + r() * r() * 360, y = 760 - h;
    towers += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${(h + 60).toFixed(0)}"/>`;
    if (r() < 0.35) towers += `<rect x="${(x + w / 2 - 1.5).toFixed(0)}" y="${(y - 30 - r() * 30).toFixed(0)}" width="3" height="40"/>`;
    if (r() < 0.3) glow += `<rect x="${x.toFixed(0)}" y="${(y + 6).toFixed(0)}" width="${w.toFixed(0)}" height="3" fill="${r() < 0.5 ? '#ff4fd8' : '#45ecff'}"/>`;
    for (let wy = y + 14; wy < 750; wy += 13) for (let wx = x + 5; wx < x + w - 6; wx += 9) if (r() < 0.22) windows += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="4" height="6" fill="${r() < 0.7 ? '#ffd98a' : r() < 0.5 ? '#7ff0ff' : '#ff8ad8'}"/>`;
    x += w + 2 + r() * 10;
  }
  let stars = '';
  if (mood !== 'dawn') for (let i = 0; i < 120; i++) stars += `<circle cx="${(r() * 1600).toFixed(0)}" cy="${(r() * 420).toFixed(0)}" r="${(0.5 + r() * 1.3).toFixed(1)}" opacity="${(0.3 + r() * 0.7).toFixed(2)}"/>`;
  let clouds = '';
  for (let i = 0; i < 7; i++) clouds += `<ellipse cx="${(r() * 1700 - 50).toFixed(0)}" cy="${(160 + r() * 260).toFixed(0)}" rx="${(120 + r() * 220).toFixed(0)}" ry="${(14 + r() * 22).toFixed(0)}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" class="scene ${mood}">
  <defs>
    <linearGradient id="sky${seed}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset=".45" stop-color="${sky[1]}"/><stop offset=".75" stop-color="${sky[2]}"/><stop offset="1" stop-color="${sky[3]}"/></linearGradient>
    <radialGradient id="sun${seed}"><stop offset="0" stop-color="${sun}"/><stop offset=".35" stop-color="${sun}" stop-opacity=".9"/><stop offset="1" stop-color="${sun}" stop-opacity="0"/></radialGradient>
    <linearGradient id="sea${seed}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[2]}" stop-opacity=".9"/><stop offset="1" stop-color="#05060d"/></linearGradient>
    <linearGradient id="fall${seed}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dff6ff"/><stop offset="1" stop-color="#dff6ff" stop-opacity=".15"/></linearGradient>
    <filter id="blur${seed}"><feGaussianBlur stdDeviation="14"/></filter>
  </defs>
  <rect width="1600" height="900" fill="url(#sky${seed})"/>
  <g fill="#fff" class="l-stars">${stars}</g>
  <circle cx="1060" cy="470" r="260" fill="url(#sun${seed})" opacity=".85"/>
  <circle cx="1060" cy="470" r="70" fill="${sun}"/>
  <g class="l-clouds" fill="#ffffff" opacity=".12" filter="url(#blur${seed})">${clouds}</g>
  <g class="l-far">
    <path d="M-40 760 L260 600 L420 470 L470 440 L520 470 L700 610 L980 700 L1640 720 L1640 900 L-40 900Z" fill="#2a1c4a" opacity=".85"/>
    <path d="M420 470 L470 440 L520 470 L500 488 L486 476 L470 492 L452 478 L438 490Z" fill="#f4eaff" opacity=".9"/>
  </g>
  <g class="l-island">
    <path d="M1240 170 Q1330 140 1440 172 Q1420 205 1390 230 L1350 330 L1325 250 L1300 300 L1280 220 Q1250 200 1240 170Z" fill="#1d1436"/>
    <path d="M1240 170 Q1330 140 1440 172 Q1338 186 1240 170Z" fill="#2f6a4a"/>
    <circle cx="1290" cy="150" r="18" fill="#24533c"/><circle cx="1320" cy="140" r="24" fill="#2a5e44"/><circle cx="1400" cy="152" r="16" fill="#24533c"/>
    <path d="M1352 160 h6 v-26 h-14 v-4 h22 v4 h-14 z" fill="#c8283c"/>
    <rect x="1414" y="176" width="9" height="560" fill="url(#fall${seed})" class="fall"/>
    <ellipse cx="1418" cy="740" rx="60" ry="14" fill="#fff" opacity=".35" filter="url(#blur${seed})"/>
  </g>
  <g class="l-dragon"><path d="M-300 260 C -200 200, -120 320, 0 250 S 160 190, 240 250 S 380 300, 450 230" fill="none" stroke="#0c0818" stroke-width="16" stroke-linecap="round"/>
    <path d="M450 230 l30 -12 l-6 14 l22 2 l-30 10z" fill="#0c0818"/><path d="M120 222 l-20 -40 l40 30z M300 262 l-10 -38 l36 32z" fill="#0c0818"/></g>
  <g class="l-mid">
    <path d="M-40 800 Q160 690 360 740 T760 760 L760 900 L-40 900Z" fill="#160f2c"/>
    <g fill="#120b24" transform="translate(150 610)">
      <rect x="-4" y="40" width="8" height="160"/>
      <path d="M-60 60 h120 l-24 -18 h-72z M-50 100 h100 l-20 -16 h-60z M-42 136 h84 l-18 -14 h-48z M-34 168 h68 l-14 -12 h-40z"/>
      <path d="M0 0 v40" stroke="#120b24" stroke-width="3"/>
    </g>
    <g transform="translate(420 700)" fill="#c8283c"><rect x="-38" y="0" width="8" height="70"/><rect x="30" y="0" width="8" height="70"/><path d="M-56 -6 h112 l-6 10 h-100z"/><rect x="-44" y="12" width="88" height="6"/></g>
  </g>
  <g class="l-city"><g fill="#0c0a1e">${towers}</g>${windows}${glow}</g>
  <rect y="760" width="1600" height="140" fill="url(#sea${seed})"/>
  <g class="l-sea" opacity=".35">${Array.from({ length: 14 }, (_, i) => `<rect x="${(980 + (i % 2 ? -1 : 1) * i * 6).toFixed(0)}" y="${770 + i * 9}" width="${(170 - i * 9).toFixed(0)}" height="2" fill="${sun}"/>`).join('')}</g>
</svg>`;
}
