/**
 * Presence layer with spatial interest management.
 * Milestone transport: BroadcastChannel (other tabs/windows on the same device appear as other players).
 * The Transport interface is what an authoritative WebSocket/WebTransport server replaces later.
 */
export interface PeerState { id: string; x: number; y: number; z: number; yaw: number; tx: number; ty: number; tz: number; seen: number }

export class Network {
  readonly id = Math.random().toString(36).slice(2, 8);
  readonly peers = new Map<string, PeerState>();
  packetsPerSec = 0;
  private ch: BroadcastChannel | null = null;
  private sendAcc = 0;
  private pkts = 0;
  private pktAcc = 0;
  static INTEREST = 400; // metres: peers outside this are not rendered

  constructor() {
    if (typeof BroadcastChannel === 'undefined') return;
    this.ch = new BroadcastChannel('shima-presence');
    this.ch.onmessage = (e) => {
      const m = e.data as { id: string; x: number; y: number; z: number; yaw: number };
      if (!m || m.id === this.id) return;
      this.pkts++;
      let p = this.peers.get(m.id);
      if (!p) { p = { id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, tx: m.x, ty: m.y, tz: m.z, seen: 0 }; this.peers.set(m.id, p); }
      p.tx = m.x; p.ty = m.y; p.tz = m.z; p.yaw = m.yaw; p.seen = performance.now();
    };
  }

  update(dt: number, x: number, y: number, z: number, yaw: number): void {
    this.sendAcc += dt;
    if (this.sendAcc >= 0.1) { // 10 Hz state updates
      this.sendAcc = 0;
      this.ch?.postMessage({ id: this.id, x, y, z, yaw });
    }
    this.pktAcc += dt;
    if (this.pktAcc >= 1) { this.packetsPerSec = this.pkts; this.pkts = 0; this.pktAcc = 0; }
    const now = performance.now();
    const k = 1 - Math.exp(-12 * dt); // interpolation toward the latest authoritative-ish state
    for (const [id, p] of this.peers) {
      if (now - p.seen > 3000) { this.peers.delete(id); continue; }
      p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k; p.z += (p.tz - p.z) * k;
    }
  }
}
