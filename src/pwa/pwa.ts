/** PWA install gate, offline shell registration, download progress and update manager. */

interface BIPEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

export const isStandalone = (): boolean =>
  window.matchMedia('(display-mode: fullscreen)').matches ||
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

let deferred: BIPEvent | null = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as BIPEvent;
});

export interface PwaHooks {
  onProgress(done: number, total: number): void;
  onUpdateReady(): void;
}

let reg: ServiceWorkerRegistration | null = null;

export async function registerSW(hooks: PwaHooks): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'progress') hooks.onProgress(e.data.done, e.data.total);
  });
  reg = await navigator.serviceWorker.register('/sw.js');
  const watch = (r: ServiceWorkerRegistration) => {
    const w = r.installing;
    if (!w) return;
    w.addEventListener('statechange', () => {
      // A new worker finished downloading in the background while an old one controls the page.
      if (w.state === 'installed' && navigator.serviceWorker.controller) hooks.onUpdateReady();
    });
  };
  reg.addEventListener('updatefound', () => watch(reg!));
  if (reg.waiting && navigator.serviceWorker.controller) hooks.onUpdateReady();
}

/** True once the service worker has fully precached the core bundle. */
export async function isInstalledOffline(): Promise<boolean> {
  if (!('caches' in window)) return false;
  const keys = await caches.keys();
  return keys.some((k) => k.startsWith('shima-core-'));
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  return outcome === 'accepted' ? 'accepted' : 'dismissed';
}

/** Ask the server for a new build. 'downloading' means a new version is being fetched in the background right now. */
export async function checkForUpdate(): Promise<'none' | 'downloading' | 'ready'> {
  if (!reg) return 'none';
  try { await reg.update(); } catch { return 'none'; }
  if (reg.waiting && navigator.serviceWorker.controller) return 'ready';
  if (reg.installing && navigator.serviceWorker.controller) return 'downloading';
  return 'none';
}

/** Activate the downloaded update and reload (waits for a download that is still running). */
export async function applyUpdate(): Promise<void> {
  if (!reg) { location.reload(); return; }
  const inst = reg.installing;
  if (!reg.waiting && inst) await new Promise<void>((res) => inst.addEventListener('statechange', () => { if (inst.state === 'installed' || inst.state === 'redundant') res(); }));
  const w = reg.waiting;
  if (!w) { location.reload(); return; }
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  w.postMessage('skipWaiting');
  setTimeout(() => location.reload(), 5000);   // safety net if controllerchange never arrives
}

/** build id of the version that is running now ('' in dev / before the service worker is in control) */
export function runningVersion(): Promise<string> {
  return new Promise((res) => {
    const c = navigator.serviceWorker?.controller; if (!c) { res(''); return; }
    const ch = new MessageChannel(); ch.port1.onmessage = (e) => res(e.data?.version ?? '');
    c.postMessage('version', [ch.port2]); setTimeout(() => res(''), 1500);
  });
}

/** build id published on the server right now ('' when offline) */
export async function latestVersion(): Promise<string> {
  try { const r = await fetch('./asset-manifest.json', { cache: 'no-store' }); return ((await r.json()) as { version?: string }).version ?? ''; } catch { return ''; }
}

export async function storageEstimate(): Promise<string> {
  try {
    const e = await navigator.storage.estimate();
    const mb = (n = 0) => (n / 1048576).toFixed(1) + ' MB';
    return `Storage used ${mb(e.usage)} / ${mb(e.quota)}`;
  } catch { return ''; }
}

export async function lockLandscape(): Promise<void> {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape');
  } catch { /* unsupported: CSS rotate overlay covers portrait */ }
}
