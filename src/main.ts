import { applyPreset, PRESETS, profileDevice, type DeviceProfile } from './core/device';
import { kvGet, kvSet } from './core/store';
import { applyUpdate, checkForUpdate, isInstalledOffline, isStandalone, lockLandscape, promptInstall, registerSW, storageEstimate } from './pwa/pwa';
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

function setUpdateReady(): void {
  updateReady = true;
  $('update-btn').style.display = 'block';
  $('menu-info').textContent = 'Update downloaded. Press UPDATE to apply it.';
}

async function doUpdate(): Promise<void> {
  if (game) await kvSet('save', game.currentSave());
  applyUpdate();
}

async function refreshMenu(): Promise<void> {
  const offline = !navigator.onLine;
  const est = await storageEstimate();
  $('menu-info').textContent = [offline ? 'OFFLINE MODE' : '', est, `${profile.webgpu ? 'WebGPU' : 'WebGL2'} · GPU ${profile.gpuTier} · CPU ${profile.cpuTier}`].filter(Boolean).join('  ·  ');
}

async function startGame(): Promise<void> {
  show('loading');
  const fill = $('load-fill'), txt = $('load-text');
  const step = (p: number, t: string) => { fill.style.width = p + '%'; txt.textContent = t; };
  step(10, 'Locking landscape…');
  await lockLandscape();
  step(30, 'Preparing renderer…');
  const canvas = $('c') as HTMLCanvasElement;
  const save = await kvGet<SaveData>('save');
  game = new Game(canvas, profile);
  if (dev) (window as unknown as { __game: Game }).__game = game;
  step(60, 'Building world…');
  const spec = normalize(await kvGet<CharacterSpec>('character').catch(() => null));
  await game.init(save, spec);
  step(100, 'Done');
  show(null);
  $('topbtns').style.display = 'flex';
  document.querySelectorAll<HTMLElement>('#stickL,#acts,#zone').forEach((e) => (e.style.display = ''));
  setInterval(() => { void checkForUpdate().then((u) => u && setUpdateReady()); }, 10 * 60 * 1000);
}

async function boot(): Promise<void> {
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
        $('dl-bar').style.display = 'block';
        $('dl-fill').style.width = (done / total) * 100 + '%';
        $('dl-text').textContent = `Downloading game files ${done}/${total}`;
        if (done === total) {
          $('dl-text').textContent = 'Download complete.';
          if (isStandalone()) show('menu');
        }
      },
      onUpdateReady: setUpdateReady,
    });
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
  $('upd-menu-btn').onclick = async () => {
    $('menu-info').textContent = 'Checking for update…';
    const has = await checkForUpdate();
    if (has) setUpdateReady(); else $('menu-info').textContent = 'You have the latest version.';
  };
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
    show('builder');
    const b = new Builder($('builder'), cur ?? defaultSpec(), (s) => { void kvSet('character', s); show('menu'); });
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
    if (dev || (await isInstalledOffline())) { show('menu'); void refreshMenu(); }
    else show('gate');
  } else {
    // Plain browser tab: playing is blocked until the PWA is downloaded/installed.
    show('gate');
  }
  if (updateReady) setUpdateReady();
}

void boot();
