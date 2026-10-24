// Closed circuit built from a Catmull-Rom spline through control points.

const CONTROL = [
  [0, 120], [80, 122], [140, 100], [160, 40], [128, -8], [150, -70],
  [110, -122], [30, -112], [-8, -60], [-60, -42], [-108, -92], [-160, -64],
  [-165, 40], [-112, 102], [-55, 122],
];

export const ROAD_HALF_WIDTH = 7;   // m
const CURB_WIDTH = 1.2;             // m
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

  // A flat strip between offsets [inner, outer] from the centerline, at height y.
  // `filter(i)` picks which segments to include (used for alternating curb colors).
  function strip(inner, outer, y, filter = () => true) {
    const positions = [], normals = [];
    const at = (i, o) => [pts[i][0] + nor[i][0] * o, y, pts[i][1] + nor[i][1] * o];
    for (let i = 0; i < pts.length; i++) {
      if (!filter(i)) continue;
      const k = (i + 1) % pts.length;
      const a = at(i, inner), b = at(i, outer), c = at(k, outer), d = at(k, inner);
      positions.push(...a, ...b, ...c, ...a, ...c, ...d);
      for (let v = 0; v < 6; v++) normals.push(0, 1, 0);
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

  // Start/finish line: a 2 m band across the road at sample 0.
  const [sx, sz] = pts[0], [tx, tz] = tan[0], [nx, nz] = nor[0];
  const line = [];
  for (const [o, f] of [[-w, -1], [w, -1], [w, 1], [-w, -1], [w, 1], [-w, 1]]) {
    line.push(sx + nx * o + tx * f, 0, sz + nz * o + tz * f);
  }

  return {
    points: pts,
    tangents: tan,
    meshes: {
      road: strip(-w, w, 0),
      curbRed: merge(strip(w, w + CURB_WIDTH, 0, red), strip(-w - CURB_WIDTH, -w, 0, red)),
      curbWhite: merge(strip(w, w + CURB_WIDTH, 0, white), strip(-w - CURB_WIDTH, -w, 0, white)),
      startLine: { positions: line, normals: Array(6).fill([0, 1, 0]).flat() },
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
