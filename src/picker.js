// Start picker for the open map (Montreal): the whole island on a map you can
// drag and zoom; tap a street, then "Start here", and the car is put down on
// it, in the right lane, facing the way it's driven.
//
// The island seen from far (land, water, the bigger streets) is drawn once
// into a picture; zoomed in, every street in view is drawn over it.

const PICK_OVERVIEW = 2048;   // px: the far picture's longer side
const PICK_DETAIL = 7;        // m per CSS px: closer than this, all the streets are drawn
const PICK_MIN_SCALE = 0.6;   // m per CSS px: closest
const PICK_LAND = '#3c5a3a', PICK_OUTSIDE = '#26323d', PICK_WATER = '#2b5a7a';
const PICK_BIG = '#f2d38a', PICK_SMALL = '#d9dde2', PICK_SERVICE = '#8a8f96';
const PICK_BIG_CLASSES = new Set(['primary', 'secondary', 'tertiary']);

export class StartPicker {
  // root: the dialog's element (see index.html, #picker). onPick({ x, z, heading } | null)
  // is called with the chosen start, or null for the map's own.
  constructor(root, onPick) {
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.nameEl = root.querySelector('#picker-name');
    this.goBtn = root.querySelector('#picker-go');
    this.onPick = onPick;
    this.city = null;
    this.view = null;      // { x, z, scale }: the map point at the canvas's middle, m per CSS px
    this.choice = null;    // { x, z, heading, name }
    this.here = null;      // the car, for the "you are here" mark
    this.pointers = new Map();
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    for (const t of ['pointerup', 'pointercancel']) c.addEventListener(t, (e) => this.up(e));
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(Math.exp(e.deltaY * 0.0015), e.offsetX, e.offsetY); }, { passive: false });
    root.querySelector('#picker-close').addEventListener('click', () => this.close());
    root.querySelector('#picker-in').addEventListener('click', () => this.zoom(0.5));
    root.querySelector('#picker-out').addEventListener('click', () => this.zoom(2));
    root.querySelector('#picker-default').addEventListener('click', () => { this.close(); this.onPick(null); });
    this.goBtn.addEventListener('click', () => { const c = this.choice; this.close(); if (c) this.onPick({ x: c.x, z: c.z, heading: c.heading }); });
    addEventListener('resize', () => { if (this.isOpen) this.draw(); });
    addEventListener('keydown', (e) => { if (this.isOpen && e.code === 'Escape') this.close(); });
  }

  get isOpen() { return !this.root.hidden; }

  // city: the open map (openmap.js); car: where the player is now.
  open(city, car) {
    if (city !== this.city) { this.city = city; this.overview = null; this.view = null; }
    this.here = { x: car.x, z: car.z, heading: car.heading };
    this.choice = null;
    this.root.hidden = false;
    // The first time: the whole island. After that: where it was left, or around the car.
    if (!this.view) { this.makeOverview(); this.fit(); }
    this.showChoice();
    this.draw();
  }

  close() {
    this.root.hidden = true;
    this.pointers.clear();
  }

  // --- the far picture -------------------------------------------------------
  makeOverview() {
    const city = this.city, ring = city.area[0];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const pad = 600;
    x0 -= pad; x1 += pad; z0 -= pad; z1 += pad;
    const m = Math.max(x1 - x0, z1 - z0) / PICK_OVERVIEW; // m per px
    const cv = document.createElement('canvas');
    cv.width = Math.ceil((x1 - x0) / m); cv.height = Math.ceil((z1 - z0) / m);
    const g = cv.getContext('2d');
    g.fillStyle = PICK_OUTSIDE;
    g.fillRect(0, 0, cv.width, cv.height);
    g.setTransform(1 / m, 0, 0, 1 / m, -x0 / m, -z0 / m);
    g.fillStyle = PICK_LAND;
    g.beginPath();
    for (const r of city.area) { r.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](p[0], p[1])); g.closePath(); }
    g.fill('evenodd');
    g.fillStyle = PICK_WATER;
    g.beginPath();
    const w = city.water;
    for (let i = 0; i < w.length; i += 6) { g.moveTo(w[i], w[i + 1]); g.lineTo(w[i + 2], w[i + 3]); g.lineTo(w[i + 4], w[i + 5]); g.closePath(); }
    g.fill();
    g.lineCap = g.lineJoin = 'round';
    for (const [cls, color, width] of [['tertiary', PICK_SMALL, 1.1], ['secondary', PICK_BIG, 1.5], ['primary', PICK_BIG, 2.2]]) {
      g.strokeStyle = color; g.lineWidth = width * m;
      g.beginPath();
      for (const r of city.roads) {
        if (r.cls !== cls) continue;
        r.pts.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](p[0], p[1]));
      }
      g.stroke();
    }
    this.overview = { cv, x0, z0, m, box: [x0, x1, z0, z1] };
  }

  // The whole island in view.
  fit() {
    const [x0, x1, z0, z1] = this.overview.box, W = this.canvas.clientWidth || 800, H = this.canvas.clientHeight || 600;
    this.view = { x: (x0 + x1) / 2, z: (z0 + z1) / 2, scale: Math.max((x1 - x0) / W, (z1 - z0) / H) };
    this.maxScale = this.view.scale * 1.2;
  }

  // --- drawing ---------------------------------------------------------------
  draw() {
    const c = this.canvas, dpr = Math.min(devicePixelRatio || 1, 2), W = c.clientWidth, H = c.clientHeight;
    if (!W || !H || !this.view) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d'), v = this.view, o = this.overview, k = dpr / v.scale;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = PICK_OUTSIDE;
    g.fillRect(0, 0, c.width, c.height);
    // Map meters to canvas pixels.
    g.setTransform(k, 0, 0, k, c.width / 2 - v.x * k, c.height / 2 - v.z * k);
    g.imageSmoothingEnabled = true;
    g.drawImage(o.cv, o.x0, o.z0, o.cv.width * o.m, o.cv.height * o.m);
    if (v.scale < PICK_DETAIL) {
      const hx = (W / 2) * v.scale, hz = (H / 2) * v.scale;
      const roads = this.city.roadsIn(v.x - hx, v.x + hx, v.z - hz, v.z + hz);
      g.lineCap = g.lineJoin = 'round';
      for (const big of [false, true]) {
        for (const r of roads) {
          if (PICK_BIG_CLASSES.has(r.cls) !== big) continue;
          g.strokeStyle = big ? PICK_BIG : r.cars ? PICK_SMALL : PICK_SERVICE;
          g.globalAlpha = r.cars ? 1 : 0.6;
          g.lineWidth = Math.max(1.3 * v.scale, 2 * r.w);
          g.beginPath();
          r.pts.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](p[0], p[1]));
          g.stroke();
        }
      }
      g.globalAlpha = 1;
    }
    // Marks, in screen pixels.
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = (p) => [W / 2 + (p.x - v.x) / v.scale, H / 2 + (p.z - v.z) / v.scale];
    const arrow = (p, color, size) => {
      const [x, y] = S(p);
      g.save();
      g.translate(x, y);
      g.rotate(-p.heading);
      g.fillStyle = color; g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(0, -size); g.lineTo(size * 0.7, size * 0.7); g.lineTo(0, size * 0.3); g.lineTo(-size * 0.7, size * 0.7);
      g.closePath(); g.fill(); g.stroke();
      g.restore();
    };
    if (this.here) arrow(this.here, '#ffc43d', 8);
    if (this.choice) {
      const [x, y] = S(this.choice);
      g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 15, 0, 2 * Math.PI); g.stroke();
      arrow(this.choice, '#4fd17a', 9);
    }
  }

  // --- the pointer -----------------------------------------------------------
  toMap(px, py) {
    const v = this.view, W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    return [v.x + (px - W / 2) * v.scale, v.z + (py - H / 2) * v.scale];
  }

  // Zoom by `factor` (< 1: closer) keeping the map point under (px, py) in place.
  zoom(factor, px = this.canvas.clientWidth / 2, py = this.canvas.clientHeight / 2) {
    const v = this.view, [mx, mz] = this.toMap(px, py);
    v.scale = Math.max(PICK_MIN_SCALE, Math.min(this.maxScale, v.scale * factor));
    const [nx, nz] = this.toMap(px, py);
    v.x += mx - nx; v.z += mz - nz;
    this.draw();
  }

  down(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY, x0: e.offsetX, y0: e.offsetY, moved: false });
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const before = [...this.pointers.values()].map((q) => ({ x: q.x, y: q.y }));
    const dx = e.offsetX - p.x, dy = e.offsetY - p.y;
    p.x = e.offsetX; p.y = e.offsetY;
    if (Math.hypot(p.x - p.x0, p.y - p.y0) > 6) p.moved = true;
    const P = [...this.pointers.values()], v = this.view;
    if (P.length === 1) {
      if (!p.moved) return;
      v.x -= dx * v.scale; v.z -= dy * v.scale;
      this.draw();
    } else if (P.length === 2) {
      // Two fingers: the spread zooms, about the point between them.
      const d0 = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y), d1 = Math.hypot(P[0].x - P[1].x, P[0].y - P[1].y);
      for (const q of P) q.moved = true;
      v.x -= (dx / 2) * v.scale; v.z -= (dy / 2) * v.scale;
      if (d0 > 1 && d1 > 1) this.zoom(d0 / d1, (P[0].x + P[1].x) / 2, (P[0].y + P[1].y) / 2);
      else this.draw();
    }
  }

  up(e) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (p && !p.moved && e.type === 'pointerup') this.pick(...this.toMap(p.x, p.y));
  }

  // The street at (x, z), or the nearest one within a thumb's width.
  pick(x, z) {
    const reach = Math.max(30, 28 * this.view.scale);
    let best = null;
    for (const r of this.city.roadsIn(x - reach, x + reach, z - reach, z + reach)) {
      if (!r.cars || r.cls === 'service') continue;
      for (let i = 1; i < r.pts.length; i++) {
        const [ax, az] = r.pts[i - 1], [bx, bz] = r.pts[i], ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
        const px = ax + ex * t, pz = az + ez * t, d = Math.hypot(px - x, pz - z);
        if (d < reach && (!best || d < best.d)) best = { d, r, px, pz, ex, ez, l: Math.sqrt(l2) };
      }
    }
    if (!best) { this.choice = null; this.showChoice('No street there: tap closer to one'); this.draw(); return; }
    // In the right lane (the middle of a one-way street), facing the way the points run.
    const { r, px, pz } = best, dx = best.ex / best.l, dz = best.ez / best.l, off = r.oneWay ? 0 : Math.min(r.w / 2, 2);
    this.choice = { x: px - dz * off, z: pz + dx * off, heading: Math.atan2(-dx, -dz), name: r.name || 'Unnamed street' };
    this.showChoice();
    // Far out, a tap also brings the map closer, to see where exactly.
    if (this.view.scale > 12) { this.view.x = px; this.view.z = pz; this.view.scale = 4; }
    this.draw();
  }

  showChoice(note = 'Tap a street · drag to move · scroll or pinch to zoom') {
    this.nameEl.textContent = this.choice ? this.choice.name : note;
    this.goBtn.hidden = !this.choice;
  }
}
