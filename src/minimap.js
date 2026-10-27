// Minimap for the open map: the streets around the car, heading up. The map
// is drawn in square tiles, each made the first time it's needed and kept in
// a small cache; each frame copies the tiles around the car, turned so the
// car points up.

const SCALE = 1.25;  // m per pixel of a tile
const TILE = 320;    // m per tile side
const VIEW = 2.2;    // m per CSS pixel on screen
const KEEP = 24;     // tiles kept in the cache
const LAND = '#3c5a3a', OUTSIDE = '#26323d', WATER = '#2b5a7a', BUILDING = '#6e5f55';

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.city = null;
  }

  // Shows the city's map (null hides the minimap). Features are listed by
  // tile so a tile only draws what touches it.
  set(city) {
    if (!this.canvas) return;
    this.canvas.hidden = !city;
    this.city = null;
    this.tiles = new Map();
    if (!city) return;
    const index = new Map();
    const add = (item, x0, x1, z0, z1) => {
      for (let i = Math.floor(x0 / TILE); i <= Math.floor(x1 / TILE); i++) {
        for (let j = Math.floor(z0 / TILE); j <= Math.floor(z1 / TILE); j++) {
          const k = `${i},${j}`;
          if (!index.has(k)) index.set(k, { water: [], buildings: [], roads: [] });
          index.get(k)[item.kind].push(item.v);
        }
      }
    };
    const bounds = (pts) => {
      const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
      return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    };
    const t = city.water;
    for (let i = 0; i < t.length; i += 6) {
      const tri = [[t[i], t[i + 1]], [t[i + 2], t[i + 3]], [t[i + 4], t[i + 5]]];
      add({ kind: 'water', v: tri }, ...bounds(tri));
    }
    for (const b of city.buildings) add({ kind: 'buildings', v: b.ring }, b.box[0], b.box[1], b.box[2], b.box[3]);
    for (const r of city.roads) add({ kind: 'roads', v: r }, ...bounds(r.pts).map((v, i) => v + (i % 2 ? r.w : -r.w)));
    this.index = index;
    this.city = city;
  }

  // A tile's canvas; a missing one is drawn only if `make` (null otherwise).
  tile(i, j, make) {
    const k = `${i},${j}`;
    let c = this.tiles.get(k);
    if (c) { this.tiles.delete(k); this.tiles.set(k, c); return c; } // most recently used last
    if (!make) return null;
    const n = Math.round(TILE / SCALE);
    c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d');
    const x0 = i * TILE, z0 = j * TILE;
    const P = ([x, z]) => [(x - x0) / SCALE, (z - z0) / SCALE];
    const path = (pts, close) => {
      g.beginPath();
      pts.forEach((p, q) => g[q ? 'lineTo' : 'moveTo'](...P(p)));
      if (close) g.closePath();
    };
    g.fillStyle = OUTSIDE;
    g.fillRect(0, 0, n, n);
    g.fillStyle = LAND;
    path(this.city.area, true);
    g.fill();
    const f = this.index.get(k) ?? { water: [], buildings: [], roads: [] };
    g.fillStyle = WATER;
    for (const tri of f.water) { path(tri, true); g.fill(); }
    g.fillStyle = BUILDING;
    for (const ring of f.buildings) { path(ring, true); g.fill(); }
    g.lineCap = g.lineJoin = 'round';
    for (const big of [false, true]) {
      for (const r of f.roads) {
        if ((r.w >= 5.5) !== big) continue;
        g.strokeStyle = big ? '#f2d38a' : r.cls === 'service' ? '#8a8f96' : '#d9dde2';
        g.lineWidth = Math.max(1.5, (2 * r.w) / SCALE);
        path(r.pts, false);
        g.stroke();
      }
    }
    this.tiles.set(k, c);
    while (this.tiles.size > KEEP) this.tiles.delete(this.tiles.keys().next().value);
    return c;
  }

  // others: the traffic, as dots.
  draw(car, others = []) {
    if (!this.city) return;
    const c = this.canvas, dpr = Math.min(devicePixelRatio, 2);
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = OUTSIDE;
    g.fillRect(0, 0, W, H);
    // Car slightly below center, so more of the road ahead shows.
    const cx = W / 2, cy = H * 0.62, k = (SCALE / VIEW) * dpr;
    g.translate(cx, cy);
    g.rotate(car.heading);
    g.scale(k, k);
    g.imageSmoothingEnabled = true;
    // Every tile the turned view can touch: a circle around the car.
    // At most one new tile per frame, so the minimap never stalls a frame.
    const reach = (Math.hypot(W, H) / dpr) * VIEW, n = TILE / SCALE;
    let budget = 1;
    for (let i = Math.floor((car.x - reach) / TILE); i <= Math.floor((car.x + reach) / TILE); i++) {
      for (let j = Math.floor((car.z - reach) / TILE); j <= Math.floor((car.z + reach) / TILE); j++) {
        const had = this.tiles.has(`${i},${j}`), t = this.tile(i, j, budget > 0);
        if (!t) continue;
        if (!had) budget--;
        // A pixel of overlap hides the seams between tiles.
        g.drawImage(t, (i * TILE - car.x) / SCALE - 0.5, (j * TILE - car.z) / SCALE - 0.5, n + 1, n + 1);
      }
    }
    g.fillStyle = '#e8ecf0';
    for (const o of others) {
      g.beginPath();
      g.arc((o.x - car.x) / SCALE, (o.z - car.z) / SCALE, 2.6, 0, 2 * Math.PI);
      g.fill();
    }
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
