// Minimap for the open map: the streets around the car, heading up. The whole
// map is drawn once into an offscreen canvas; each frame copies the part
// around the car, turned so the car points up.

const SCALE = 2.5;   // m per pixel of the offscreen map
const VIEW = 2.2;    // m per CSS pixel on screen

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.map = null;
  }

  // Draws the city's map (null hides the minimap).
  set(city) {
    if (!this.canvas) return;
    this.canvas.hidden = !city;
    this.map = null;
    if (!city) return;
    const xs = city.area.map((p) => p[0]), zs = city.area.map((p) => p[1]);
    const x0 = Math.min(...xs) - 200, z0 = Math.min(...zs) - 200;
    const w = Math.ceil((Math.max(...xs) + 200 - x0) / SCALE), h = Math.ceil((Math.max(...zs) + 200 - z0) / SCALE);
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const g = off.getContext('2d');
    const P = ([x, z]) => [(x - x0) / SCALE, (z - z0) / SCALE];
    g.fillStyle = '#26323d';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#2b5a7a';
    const t = city.water;
    for (let i = 0; i < t.length; i += 6) {
      g.beginPath();
      g.moveTo(...P([t[i], t[i + 1]])); g.lineTo(...P([t[i + 2], t[i + 3]])); g.lineTo(...P([t[i + 4], t[i + 5]]));
      g.fill();
    }
    g.fillStyle = '#3c5a3a';
    g.beginPath();
    city.area.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](...P(p)));
    g.fill();
    g.fillStyle = '#6e5f55';
    for (const b of city.buildings) {
      g.beginPath();
      b.ring.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](...P(p)));
      g.fill();
    }
    g.lineCap = g.lineJoin = 'round';
    for (const big of [false, true]) {
      for (const r of city.roads) {
        if ((r.w >= 5.5) !== big) continue;
        g.strokeStyle = big ? '#f2d38a' : r.cls === 'service' ? '#8a8f96' : '#d9dde2';
        g.lineWidth = Math.max(1.4, (2 * r.w) / SCALE);
        g.beginPath();
        r.pts.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](...P(p)));
        g.stroke();
      }
    }
    this.map = { off, x0, z0 };
  }

  draw(car) {
    if (!this.map) return;
    const c = this.canvas, dpr = Math.min(devicePixelRatio, 2);
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext('2d');
    const { off, x0, z0 } = this.map;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#26323d';
    g.fillRect(0, 0, W, H);
    // Car slightly below center, so more of the road ahead shows.
    const cx = W / 2, cy = H * 0.62, k = (SCALE / VIEW) * dpr;
    g.translate(cx, cy);
    g.rotate(car.heading);
    g.scale(k, k);
    g.imageSmoothingEnabled = true;
    g.drawImage(off, -(car.x - x0) / SCALE, -(car.z - z0) / SCALE);
    g.setTransform(1, 0, 0, 1, 0, 0);
    // The car: an arrow pointing up.
    const s = 7 * dpr;
    g.fillStyle = '#ffc43d';
    g.strokeStyle = 'rgba(0,0,0,.6)';
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    g.moveTo(cx, cy - s); g.lineTo(cx + s * 0.7, cy + s * 0.7); g.lineTo(cx, cy + s * 0.3); g.lineTo(cx - s * 0.7, cy + s * 0.7);
    g.closePath();
    g.fill(); g.stroke();
  }
}
