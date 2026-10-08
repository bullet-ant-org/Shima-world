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

/** Ask the browser to check for a new build; resolves true if one is waiting. */
export async function checkForUpdate(): Promise<boolean> {
  if (!reg) return false;
  await reg.update();
  return !!(reg.waiting || reg.installing);
}

/** Activate the downloaded update and reload. */
export function applyUpdate(): void {
  if (!reg?.waiting) { location.reload(); return; }
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  reg.waiting.postMessage('skipWaiting');
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
