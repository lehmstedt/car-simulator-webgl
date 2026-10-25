// Records the car's path during each lap (or stage run) and replays the best
// one (per drivetrain) as a see-through ghost car. Best runs are saved in
// localStorage, under a key per layout.

const INTERVAL = 50;  // ms between recorded samples
const STRIDE = 4;     // t, x, z, heading
// New key when a layout changes: old laps aren't comparable.
const KEYS = { circuit: 'ghost-hairpins', stage: 'ghost-stage-2' };

export class Ghost {
  constructor(layout = 'circuit') {
    this.key = KEYS[layout];
    this.laps = {};   // variant -> { time, samples: [t, x, z, heading, ...] }
    this.rec = null;  // samples of the lap in progress
    this.next = 0;
    try { this.laps = JSON.parse(localStorage.getItem(this.key)) ?? {}; } catch { this.laps = {}; }
  }

  best(variant) { return this.laps[variant]?.time ?? null; }

  start() { this.rec = []; this.next = 0; }
  stop() { this.rec = null; }

  record(t, car, force = false) {
    if (!this.rec || (!force && t < this.next)) return;
    const r = (v) => Math.round(v * 100) / 100;
    this.rec.push(Math.round(t), r(car.x), r(car.z), Math.round(car.heading * 1000) / 1000);
    this.next = t + INTERVAL;
  }

  // Keep the lap just finished as this drivetrain's ghost.
  save(variant, time, car) {
    if (!this.rec) return;
    this.record(time, car, true);
    this.laps[variant] = { time, samples: this.rec };
    try { localStorage.setItem(this.key, JSON.stringify(this.laps)); } catch {}
  }

  // Interpolated pose t ms into the lap, or null once the ghost has finished.
  // `laps` defaults to this layout's own; pass BOT_LAPS[layout] for Claude's ghost.
  pose(variant, t, laps = this.laps) {
    const s = laps?.[variant]?.samples;
    if (!s || t < 0 || t > s[s.length - STRIDE]) return null;
    let lo = 0, hi = s.length / STRIDE - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid * STRIDE] <= t) lo = mid; else hi = mid;
    }
    const a = lo * STRIDE, b = hi * STRIDE;
    const k = s[b] > s[a] ? (t - s[a]) / (s[b] - s[a]) : 0;
    const lerp = (i) => s[a + i] + (s[b + i] - s[a + i]) * k;
    return { x: lerp(1), z: lerp(2), heading: lerp(3), steer: 0 };
  }
}
