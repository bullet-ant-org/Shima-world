import { applyPreset, PRESETS, profileDevice, type DeviceProfile } from './core/device';
import { kvGet, kvSet } from './core/store';
import { applyUpdate, checkForUpdate, isInstalledOffline, isStandalone, latestVersion, lockLandscape, promptInstall, registerSW, runningVersion, storageEstimate } from './pwa/pwa';
import { sceneSVG } from './ui/scenery';
import { Preview } from './ui/preview';
import { Game, type SaveData } from './game';
import { ISLANDS } from './world/terrain';
import { Builder } from './ui/builder';
import { defaultSpec, normalize, type CharacterSpec } from './entities/character';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const screens = ['gate', 'menu', 'loading', 'builder'];
function show(id: string | null): void { screens.forEach((s) => $(s).classList.toggle('show', s === id)); }

const dev = import.meta.env.DEV || location.search.includes('dev=1');
let profile: DeviceProfile;
let game: Game | null = null;
let updateReady = false;

// ---------------- updates: found, downloaded and applied right from the home screen ----------------
type UpdState = 'checking' | 'none' | 'downloading' | 'ready' | 'offline' | 'dev';
let updState: UpdState = 'checking';
function setUpd(st: UpdState, text?: string): void {
  if (updateReady && st !== 'ready') return;          // a downloaded update stays offered
  updState = st;
  const card = $('menu-upd'), tag = $('upd-tag');
  card.classList.toggle('ready', st === 'ready');
  if (st === 'ready' || st === 'downloading') { card.classList.add('show'); $('menu-settings').classList.remove('show'); }
  $('upd-bar').style.display = st === 'downloading' ? 'block' : 'none';
  tag.textContent = st === 'ready' ? 'READY ●' : st === 'downloading' ? 'DOWNLOADING' : st === 'checking' ? 'CHECKING' : 'UP TO DATE';
  tag.style.color = st === 'ready' ? '#ffd23f' : '';
  $('upd-status').textContent = text ?? {
    checking: 'Checking for updates…', none: 'You have the latest version.', downloading: 'Downloading the new version…',
    ready: 'A new version is downloaded. Press UPDATE NOW to install it — your progress is saved.', offline: 'Offline — connect to the internet to check for updates.', dev: 'Development build — updates are applied by reloading.',
  }[st];
}

function setUpdateReady(): void {
  updateReady = false; setUpd('ready'); updateReady = true;
  $('update-btn').style.display = 'block';
}

async function checkUpdates(): Promise<void> {
  if (dev) { setUpd('dev'); return; }
  if (!navigator.onLine) { setUpd('offline'); return; }
  setUpd('checking');
  const [state, latest, running] = await Promise.all([checkForUpdate(), latestVersion(), runningVersion()]);
  if (state === 'ready') setUpdateReady();
  else if (state === 'downloading') setUpd('downloading');
  else if (latest && running && latest !== running) setUpd('downloading', `New version ${latest} found — downloading…`);
  else setUpd('none', running ? `You have the latest version (${running}).` : undefined);
}

async function doUpdate(): Promise<void> {
  if (game) await kvSet('save', game.currentSave());
  $('upd-status').textContent = 'Installing update…';
  await applyUpdate();
}

// ---------------- home screen character ----------------
let menuHero: Preview | null = null;
async function startMenuHero(): Promise<void> {
  if (menuHero || game) return;
  const spec = normalize(await kvGet<CharacterSpec>('character').catch(() => null));
  menuHero = new Preview($('menu-hero') as HTMLCanvasElement, spec);
  if (!(await menuHero.start())) { menuHero?.dispose(); menuHero = null; } else menuHero.setZoom(0.22);
}
function stopMenuHero(): void { menuHero?.dispose(); menuHero = null; }

async function showMenu(): Promise<void> {
  show('menu');
  void refreshMenu();
  void startMenuHero();
  void runningVersion().then((v) => { $('menu-ver').innerHTML = v ? `VERSION <b>${v}</b>` : dev ? 'DEV BUILD' : ''; });
  const hasSave = !!(await kvGet<SaveData>('save').catch(() => null));
  $('play-btn').innerHTML = `${hasSave ? 'CONTINUE' : 'NEW GAME'} <small>OPEN WORLD</small>`;
}

async function refreshMenu(): Promise<void> {
  const offline = !navigator.onLine;
  const est = await storageEstimate();
  $('menu-info').textContent = [offline ? 'OFFLINE MODE' : '', est, `${profile.webgpu ? 'WebGPU' : 'WebGL2'} · GPU ${profile.gpuTier} · CPU ${profile.cpuTier}`].filter(Boolean).join('  ·  ');
}

async function startGame(): Promise<void> {
  stopMenuHero();
  show('loading');
  const fill = $('load-fill'), txt = $('load-text');
  const step = (p: number, t: string) => { fill.style.width = p + '%'; txt.textContent = Math.round(p) + '%  ·  ' + t; };
  const tips = ['Drag the right side of the screen to look around; the camera sits right over your shoulder.', 'Change your hairstyle, hats, jewellery and bags in the Character Creator.', 'Updates download in the background — install them from the home screen.', 'Walk up to a shop, temple or tower door and press ENTER to go inside.', 'Take a tower elevator to the roof for the best view of the city.', 'Running and flying use energy; rest or walk to recover it.', 'Visit shrines and temples to earn honour.', 'Look up: dragons, a phoenix and sky whales roam the skies.', 'The racecourse in Sakura Valley runs races all day.', 'Find the floating islands and their waterfalls far out at sea.'];
  let tipI = Math.floor(Math.random() * tips.length);
  const tipEl = $('load-tip'); tipEl.textContent = tips[tipI];
  const tipTimer = setInterval(() => { tipI = (tipI + 1) % tips.length; tipEl.textContent = tips[tipI]; }, 3500);
  step(10, 'Locking landscape…');
  await lockLandscape();
  step(30, 'Preparing renderer…');
  const canvas = $('c') as HTMLCanvasElement;
  const save = await kvGet<SaveData>('save');
  game = new Game(canvas, profile);
  if (dev) { (window as unknown as { __game: Game }).__game = game; void import('./world/layout').then((L) => { (window as unknown as { __layout: unknown }).__layout = L; }); }
  step(60, 'Building world…');
  const spec = normalize(await kvGet<CharacterSpec>('character').catch(() => null));
  await game.init(save, spec, step);
  step(100, 'Done'); clearInterval(tipTimer);
  show(null);
  $('topbtns').style.display = 'flex';
  document.querySelectorAll<HTMLElement>('#stickL,#acts,#zone').forEach((e) => (e.style.display = ''));
  setInterval(() => { void checkForUpdate().then((u) => u === 'ready' && setUpdateReady()); }, 10 * 60 * 1000);
}

async function boot(): Promise<void> {
  $('menu-art').innerHTML = sceneSVG('dusk', 7);
  $('load-art').innerHTML = sceneSVG('night', 19);
  $('gate-art').innerHTML = sceneSVG('dawn', 3);
  profile = await profileDevice();
  const savedPreset = await kvGet<string>('preset');
  if (savedPreset && (PRESETS as string[]).includes(savedPreset)) applyPreset(profile, savedPreset as never);
  $('gfx-btn').textContent = 'GRAPHICS: ' + profile.preset.toUpperCase();

  // hide in-game controls until the world is running
  $('topbtns').style.display = 'none';
  document.querySelectorAll<HTMLElement>('#stickL,#acts,#zone').forEach((e) => (e.style.display = 'none'));

  if (!dev) {
    await registerSW({
      onProgress: (done, total) => {
        if (navigator.serviceWorker.controller) {     // an update downloading in the background, not the first install
          setUpd('downloading', `Downloading update… ${done}/${total} files`);
          $('upd-fill').style.width = (done / total) * 100 + '%';
          return;
        }
        $('dl-bar').style.display = 'block';
        $('dl-fill').style.width = (done / total) * 100 + '%';
        $('dl-text').textContent = `Downloading game files ${done}/${total}`;
        if (done === total) {
          $('dl-text').textContent = 'Download complete.';
          if (isStandalone()) void showMenu();
        }
      },
      onUpdateReady: setUpdateReady,
    });
    navigator.serviceWorker?.addEventListener('controllerchange', () => void runningVersion().then((v) => { if (v) $('menu-ver').innerHTML = `VERSION <b>${v}</b>`; }));
  }

  $('install-btn').onclick = async () => {
    const r = await promptInstall();
    if (r === 'unavailable') {
      $('ios-hint').style.display = 'block';
      $('ios-hint').textContent = 'Open your browser menu and choose “Install app” / “Add to Home Screen”, then launch Shima World from your home screen. (On iPhone: Share → Add to Home Screen.)';
    }
  };
  window.addEventListener('appinstalled', () => {
    $('gate-msg').textContent = 'Installed! Open Shima World from your home screen or app list to play.';
    $('install-btn').style.display = 'none';
  });

  $('play-btn').onclick = () => void startGame();
  $('upd-menu-btn').onclick = () => { $('menu-settings').classList.remove('show'); const c = $('menu-upd'); c.classList.toggle('show'); if (c.classList.contains('show') && updState !== 'ready' && updState !== 'downloading') void checkUpdates(); };
  $('upd-check').onclick = () => void checkUpdates();
  $('menu-update').onclick = () => void doUpdate();
  $('set-btn').onclick = () => { $('menu-upd').classList.remove('show'); $('menu-settings').classList.toggle('show'); };
  window.addEventListener('online', () => void checkUpdates());
  setInterval(() => { if ($('menu').classList.contains('show') && updState !== 'ready') void checkUpdates(); }, 5 * 60 * 1000);
  const INK = ['hero', 'all', 'off'] as const;
  const savedInk = await kvGet<string>('outlines');
  if (savedInk && (INK as readonly string[]).includes(savedInk)) profile.q.outlines = savedInk as typeof INK[number];
  const inkLabel = () => { $('ink-btn').textContent = 'OUTLINES: ' + profile.q.outlines.toUpperCase(); };
  inkLabel();
  $('ink-btn').onclick = () => {
    profile.q.outlines = INK[(INK.indexOf(profile.q.outlines) + 1) % INK.length];
    void kvSet('outlines', profile.q.outlines); inkLabel();
    $('menu-info').textContent = 'Outline change applies next time the world loads.';
  };
  $('char-btn').onclick = async () => {
    const cur = normalize(await kvGet<CharacterSpec>('character').catch(() => null));
    stopMenuHero();
    show('builder');
    const b = new Builder($('builder'), cur ?? defaultSpec(), (s) => { void kvSet('character', s).then(() => showMenu()); });
    await b.open();
  };
  $('update-btn').onclick = () => void doUpdate();
  const travel = $('travel');
  ISLANDS.forEach((isl, i) => {
    const b = document.createElement('button');
    b.textContent = `${i + 1} · ${isl.title}`;
    b.onclick = () => { game?.teleportTo(i); travel.classList.remove('show'); };
    travel.appendChild(b);
  });
  $('travel-btn').onclick = () => travel.classList.toggle('show');
  $('dbg-btn').onclick = () => game?.setDebug(((game?.debugMode ?? 0) + 1) % 4);
  $('gfx-btn').onclick = () => {
    const next = PRESETS[(PRESETS.indexOf(profile.preset) + 1) % PRESETS.length];
    applyPreset(profile, next);
    void kvSet('preset', next);
    $('gfx-btn').textContent = 'GRAPHICS: ' + next.toUpperCase();
    $('menu-info').textContent = 'Graphics change applies next time the world loads (reload to apply).';
  };

  if (dev || isStandalone()) {
    // Installed (or dev): the game must already be cached; otherwise keep the download screen up.
    if (dev || (await isInstalledOffline())) { void showMenu(); void checkUpdates(); }
    else show('gate');
  } else {
    // Plain browser tab: playing is blocked until the PWA is downloaded/installed.
    show('gate');
  }
  if (updateReady) setUpdateReady();
}

void boot();
