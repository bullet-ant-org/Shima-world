import { applyPreset, PRESETS, profileDevice, type DeviceProfile } from './core/device';
import { kvGet, kvSet } from './core/store';
import { applyUpdate, checkForUpdate, isInstalledOffline, isStandalone, lockLandscape, promptInstall, registerSW, storageEstimate } from './pwa/pwa';
import { Game, type SaveData } from './game';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const screens = ['gate', 'menu', 'loading'];
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
  step(60, 'Building world…');
  await game.init(save);
  step(100, 'Done');
  show(null);
  $('topbtns').style.display = 'flex';
  document.querySelectorAll<HTMLElement>('#stickL,#stickR,#acts,#zone').forEach((e) => (e.style.display = ''));
  setInterval(() => { void checkForUpdate().then((u) => u && setUpdateReady()); }, 10 * 60 * 1000);
}

async function boot(): Promise<void> {
  profile = await profileDevice();
  const savedPreset = await kvGet<string>('preset');
  if (savedPreset && (PRESETS as string[]).includes(savedPreset)) applyPreset(profile, savedPreset as never);
  $('gfx-btn').textContent = 'GRAPHICS: ' + profile.preset.toUpperCase();

  // hide in-game controls until the world is running
  $('topbtns').style.display = 'none';
  document.querySelectorAll<HTMLElement>('#stickL,#stickR,#acts,#zone').forEach((e) => (e.style.display = 'none'));

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
  $('update-btn').onclick = () => void doUpdate();
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
