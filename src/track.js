// Closed circuit built from a Catmull-Rom spline through control points.
// It drapes over the terrain; road surfaces sit a few cm above the ground.

import { terrainHeight, terrainNormal } from './terrain.js';

// Two hairpins (~10 m radius) and a few tight corners among faster bends.
const CONTROL = [
  [0, 120], [80, 122], [145, 120], [174, 106], [172, 80], [142, 74],
  [112, 58], [112, 20], [150, -10], [162, -60], [140, -110], [100, -125],
  [40, -115], [8, -70], [-10, -16], [-36, -12], [-52, -56], [-90, -110],
  [-140, -112], [-166, -70], [-165, 40], [-140, 90], [-95, 98], [-60, 120],
];

export const ROAD_HALF_WIDTH = 7;   // m
const CURB_WIDTH = 1.2;             // m
export const ROAD_LIFT = 0.05;      // m above the ground mesh
const SAMPLES = 400;

// Corner warning boards: a corner is where the radius drops below TIGHT_RADIUS;
// boards stand this many meters before its entry, on the outside.
const TIGHT_RADIUS = 30;            // m
export const SIGN_DISTANCES = [150, 100, 50];
const SIGN_OFFSET = ROAD_HALF_WIDTH + 1.2 + 2.5; // m from the centerline

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

export function buildTrack() {
  const n = CONTROL.length;
  const per = SAMPLES / n;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p0 = CONTROL[(i - 1 + n) % n], p1 = CONTROL[i], p2 = CONTROL[(i + 1) % n], p3 = CONTROL[(i + 2) % n];
    for (let j = 0; j < per; j++) pts.push(catmullRom(p0, p1, p2, p3, j / per));
  }

  // Unit tangent and left normal at each sample.
  const tan = pts.map((_, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    return [dx / l, dz / l];
  });
  const nor = tan.map(([tx, tz]) => [-tz, tx]); // points to the driver's right
  const N = pts.length;

  // Distance along the centerline at each sample.
  const along = [0];
  for (let i = 1; i <= N; i++) {
    const a = pts[i - 1], b = pts[i % N];
    along.push(along[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = along[N];
  const ahead = (i, j) => (along[j] - along[i] + length) % length; // meters from i forward to j

  // Signed curvature (1/m, > 0 turning right) over a ~12 m window.
  const curv = pts.map((_, i) => {
    let a = i, b = i;
    while (ahead(a, i) < 6) a = (a - 1 + N) % N;
    while (ahead(i, b) < 6) b = (b + 1) % N;
    const [ax, az] = tan[a], [bx, bz] = tan[b];
    return Math.atan2(ax * bz - az * bx, ax * bx + az * bz) / (ahead(a, i) + ahead(i, b));
  });

  // Corners: runs of tight samples, merged when less than 40 m apart.
  const tight = curv.map((c) => Math.abs(c) > 1 / TIGHT_RADIUS);
  const corners = [];
  const first = tight.findIndex((t, i) => !t && tight[(i + 1) % N]);
  if (first >= 0) {
    for (let k = 1; k <= N; k++) {
      const i = (first + k) % N;
      if (!tight[i]) continue;
      const prev = corners[corners.length - 1];
      if (prev && ahead(prev.exit, i) < 40) { prev.exit = i; prev.peak = Math.max(prev.peak, Math.abs(curv[i])); }
      else corners.push({ entry: i, exit: i, peak: Math.abs(curv[i]), right: curv[i] > 0 });
    }
    if (corners.length > 1 && ahead(corners[corners.length - 1].exit, corners[0].entry) < 40) {
      corners[0].entry = corners.pop().entry;
    }
  }

  // Count-down boards before each corner, skipped where they'd sit in the
  // previous corner. They go on the outside unless another part of the circuit is there.
  const signs = [];
  corners.forEach((c, ci) => {
    const prevExit = corners[(ci - 1 + corners.length) % corners.length].exit;
    const room = corners.length > 1 ? ahead(prevExit, c.entry) - 10 : length / 2;
    for (const dist of SIGN_DISTANCES) {
      if (dist > room) continue;
      let i = c.entry;
      while (ahead(i, c.entry) < dist) i = (i - 1 + N) % N;
      for (const side of [c.right ? -1 : 1, c.right ? 1 : -1]) {
        const x = pts[i][0] + nor[i][0] * SIGN_OFFSET * side, z = pts[i][1] + nor[i][1] * SIGN_OFFSET * side;
        if (nearest(x, z).distance < SIGN_OFFSET - 1) continue;
        signs.push({ x, z, y: terrainHeight(x, z), facing: [-tan[i][0], -tan[i][1]], dist, right: c.right });
        break;
      }
    }
  });

  // A strip between offsets [inner, outer] from the centerline, draped over the
  // terrain and lifted by `lift`. It's split into `lanes` across so it follows
  // the ground's curvature. `filter(i)` picks segments (alternating curb colors).
  function strip(inner, outer, lift, filter = () => true, lanes = 1) {
    const positions = [], normals = [];
    const at = (i, o) => {
      const x = pts[i][0] + nor[i][0] * o, z = pts[i][1] + nor[i][1] * o;
      positions.push(x, terrainHeight(x, z) + lift, z);
      normals.push(...terrainNormal(x, z));
    };
    for (let i = 0; i < pts.length; i++) {
      if (!filter(i)) continue;
      const k = (i + 1) % pts.length;
      for (let l = 0; l < lanes; l++) {
        const o0 = inner + ((outer - inner) * l) / lanes, o1 = inner + ((outer - inner) * (l + 1)) / lanes;
        for (const [s, o] of [[i, o0], [i, o1], [k, o1], [i, o0], [k, o1], [k, o0]]) at(s, o);
      }
    }
    return { positions, normals };
  }

  const w = ROAD_HALF_WIDTH;
  const merge = (...ms) => ({
    positions: ms.flatMap((m) => m.positions),
    normals: ms.flatMap((m) => m.normals),
  });
  const red = (i) => Math.floor(i / 2) % 2 === 0;
  const white = (i) => !red(i);

  return {
    points: pts,
    tangents: tan,
    meshes: {
      road: strip(-w, w, ROAD_LIFT, undefined, 4),
      curbRed: merge(strip(w, w + CURB_WIDTH, ROAD_LIFT, red), strip(-w - CURB_WIDTH, -w, ROAD_LIFT, red)),
      curbWhite: merge(strip(w, w + CURB_WIDTH, ROAD_LIFT, white), strip(-w - CURB_WIDTH, -w, ROAD_LIFT, white)),
      // Start/finish line: the first road segment, painted.
      startLine: strip(-w, w, ROAD_LIFT + 0.02, (i) => i === 0, 4),
    },
    corners,
    signs,
    length,
    locate(x, z) {
      const r = nearest(x, z);
      return { ...r, onTrack: r.distance <= w + CURB_WIDTH };
    },
  };

  // Nearest centerline sample and distance to the centerline polyline.
  function nearest(x, z) {
    let best = Infinity, index = 0;
    for (let i = 0; i < N; i++) {
      const a = pts[i], b = pts[(i + 1) % N];
      const ex = b[0] - a[0], ez = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez)));
      const d = Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t);
      if (d < best) { best = d; index = i; }
    }
    return { distance: best, index };
  }
}
