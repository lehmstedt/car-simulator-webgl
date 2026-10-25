// Closed circuit built from a Catmull-Rom spline through control points.
// It drapes over the terrain; road surfaces sit a few cm above the ground.

import { terrainHeight, terrainNormal } from './terrain.js';

const CONTROL = [
  [0, 120], [80, 122], [140, 100], [160, 40], [128, -8], [150, -70],
  [110, -122], [30, -112], [-8, -60], [-60, -42], [-108, -92], [-160, -64],
  [-165, 40], [-112, 102], [-55, 122],
];

export const ROAD_HALF_WIDTH = 7;   // m
const CURB_WIDTH = 1.2;             // m
export const ROAD_LIFT = 0.05;      // m above the ground mesh
const SAMPLES = 400;

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
  const nor = tan.map(([tx, tz]) => [-tz, tx]);

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
    // Nearest centerline sample and distance to the centerline polyline.
    locate(x, z) {
      let best = Infinity, index = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const ex = b[0] - a[0], ez = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez)));
        const d = Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t);
        if (d < best) { best = d; index = i; }
      }
      return { distance: best, index, onTrack: best <= w + CURB_WIDTH };
    },
  };
}
