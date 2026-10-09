/** Touch sticks (landscape layout) + keyboard fallback. Polled once per frame, no allocations. */
export class Input {
  moveX = 0; moveY = 0;     // left stick / WASD
  lookX = 0; lookY = 0;     // keyboard look (rad/s scale)
  lookDX = 0; lookDY = 0;   // drag-to-look delta in pixels since last poll (touch/mouse on the right of the screen)
  private dragAcc = { x: 0, y: 0 }; private dragId = -1; private dragLast = { x: 0, y: 0 };
  run = false; jump = false;
  private runBtn = false; private jumpBtn = false;
  private keys = new Set<string>();
  private tapped = new Set<string>(); // key-down edges, so a quick tap between frames isn't lost
  private sticks: { el: HTMLElement; knob: HTMLElement; id: number; x: number; y: number }[] = [];

  constructor() {
    this.sticks.push(this.bind('stickL'));
    const hold = (id: string, on: (v: boolean) => void) => {
      const b = document.getElementById(id)!;
      b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); on(true); });
      b.addEventListener('pointerup', () => on(false));
      b.addEventListener('pointercancel', () => on(false));
    };
    hold('jump-btn', (v) => (this.jumpBtn = v));
    hold('run-btn', (v) => (this.runBtn = v));
    for (const [id, code] of [['fly-btn', 'BtnFly'], ['boost-btn', 'BtnBoost']]) {
      document.getElementById(id)!.addEventListener('pointerdown', () => this.tapped.add(code));
    }
    // look around by dragging anywhere on the right ~60% of the screen (no stick, no limits)
    const cv = document.getElementById('c')!;
    cv.addEventListener('pointerdown', (e) => {
      if (this.dragId !== -1 || (e.pointerType === 'touch' && e.clientX < window.innerWidth * 0.4)) return;
      this.dragId = e.pointerId; cv.setPointerCapture(e.pointerId); this.dragLast.x = e.clientX; this.dragLast.y = e.clientY;
    });
    cv.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dragId) return;
      this.dragAcc.x += e.clientX - this.dragLast.x; this.dragAcc.y += e.clientY - this.dragLast.y;
      this.dragLast.x = e.clientX; this.dragLast.y = e.clientY;
    });
    const endDrag = (e: PointerEvent) => { if (e.pointerId === this.dragId) this.dragId = -1; };
    cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
    window.addEventListener('keydown', (e) => { this.keys.add(e.code); this.tapped.add(e.code); });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  private bind(id: string) {
    const el = document.getElementById(id)!;
    const knob = el.querySelector('.knob') as HTMLElement;
    const s = { el, knob, id: -1, x: 0, y: 0 };
    const set = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const l = Math.hypot(dx, dy);
      if (l > 1) { dx /= l; dy /= l; }
      s.x = dx; s.y = dy;
      knob.style.transform = `translate(${dx * r.width * 0.3}px, ${dy * r.height * 0.3}px)`;
    };
    el.addEventListener('pointerdown', (e) => { s.id = e.pointerId; el.setPointerCapture(e.pointerId); set(e); });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === s.id) set(e); });
    const end = (e: PointerEvent) => { if (e.pointerId !== s.id) return; s.id = -1; s.x = s.y = 0; knob.style.transform = ''; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    return s;
  }

  poll(): void {
    const k = this.keys;
    let mx = this.sticks[0].x, my = this.sticks[0].y;
    if (k.has('KeyA')) mx -= 1; if (k.has('KeyD')) mx += 1;
    if (k.has('KeyW')) my -= 1; if (k.has('KeyS')) my += 1;
    this.moveX = Math.max(-1, Math.min(1, mx));
    this.moveY = Math.max(-1, Math.min(1, my));
    let lx = 0, ly = 0;
    if (k.has('ArrowLeft') || k.has('KeyQ')) lx -= 1; if (k.has('ArrowRight') || k.has('KeyE')) lx += 1;
    if (k.has('ArrowUp')) ly -= 1; if (k.has('ArrowDown')) ly += 1;
    this.lookX = lx; this.lookY = ly;
    this.lookDX = this.dragAcc.x; this.lookDY = this.dragAcc.y; this.dragAcc.x = this.dragAcc.y = 0;
    this.run = this.runBtn || k.has('ShiftLeft');
    this.jump = this.jumpBtn || k.has('Space');
  }
  wasPressed(code: string): boolean { return this.tapped.delete(code); }
}
