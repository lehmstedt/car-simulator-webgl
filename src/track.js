// Roads built from a Catmull-Rom spline through control points, from real
// map data. They drape over the terrain; road surfaces sit a few cm above the ground.

import { terrainHeight, terrainNormal, terrainSlope, groundHeight, setRoadBumps, RING_VERGE } from './terrain.js';
import { NORDSCHLEIFE } from './nordschleife.js';

export const LAYOUTS = {
  // The Nürburgring Nordschleife: 20.7 km through the Eifel forest with ~290 m
  // of climb, its path and heights from real map and elevation data
  // (nordschleife.js). A 9 m asphalt road with white edge lines, tall red and
  // white kerbs through the bends, Armco guardrails a couple of meters off the
  // road all the way round, and grass verges into the woods. Laps start and
  // end at T13.
  ring: {
    closed: true,
    control: NORDSCHLEIFE.road.map(([x, z]) => [x, z]),
    step: 3, // m between road samples
    halfWidth: 4.5, edge: 0.3, sand: false, sausages: false, surface: 'road', edgeSurface: 'road',
    verge: true, kerbs: true, rails: true, sections: NORDSCHLEIFE.sections,
    colors: { road: [0.3, 0.31, 0.33] },
  },
};

export const ROAD_LIFT = 0.05;      // m above the ground mesh
const SAMPLES = 400;                // circuit samples
const STAGE_STEP = 1.5;                  // m between stage samples (fine enough for the bumps)

// Stage bumps: the height (m, >= 0) they add `s` meters along the road and `o`
// meters right of the centerline. Three waves along the road (the shorter ones
// skewed across it, so the car rocks side to side too) whose size swells and
// fades over ~230 m: rough sections between smoother ones. Full height across
// the road, easing to nothing over the verge, so the road meets the ground.
const BUMP_MIN = 0.16, BUMP_MAX = 0.36; // m: roughness of the smoothest / roughest sections
function bumpHeight(s, o, w, verge) {
  const a = Math.abs(o);
  if (a >= w + verge) return 0;
  const t = Math.max(0, (a - w) / verge), fade = 1 - t * t * (3 - 2 * t);
  const size = BUMP_MIN + (BUMP_MAX - BUMP_MIN) * (0.5 + 0.5 * Math.sin((2 * Math.PI * s) / 230 + 0.9));
  const u = 0.5 + 0.5 * (
    0.45 * Math.sin((2 * Math.PI * s) / 29 + 0.7) +
    0.35 * Math.sin((2 * Math.PI * s) / 13 + 2.1 + 0.4 * o) +
    0.2 * Math.sin((2 * Math.PI * s) / 7.5 + 0.3 - 0.7 * o));
  return size * u * u * fade;
}

// Corner warning boards: a corner is where the radius drops below TIGHT_RADIUS;
// boards stand this many meters before its entry, on the outside.
const TIGHT_RADIUS = 30;            // m
export const SIGN_DISTANCES = [150, 100, 50];

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

// Sand traps sit on the outside of bends, from just before the turn-in to well
// past the exit, where a car that runs wide ends up. Deeper for tighter bends.
const SAND_FROM = 80;               // m: bends tighter than this radius get a trap
const SAND_BEFORE = 10, SAND_AFTER = 45; // m of trap before / after each tight sample

// Sausage kerbs: raised yellow humps just past the flat kerb on the inside of
// tight corners, so cutting the apex costs grip and time.
const SAUSAGE_RADIUS = 0.3, SAUSAGE_HEIGHT = 0.14; // m: half width across, height
const SAUSAGE_GAP = 0.08;           // m between the flat kerb and the sausage
const SAUSAGE_BEFORE = 5, SAUSAGE_AFTER = 8; // m of sausages before / after the apex
const PIECE = 2, PIECE_GAP = 0.35;  // m: length of each piece, gap between them
const PIECE_ROUND = 0.35;           // m over which each end rounds down

// Nordschleife kerbs: red/white blocks on both sides of every bend tighter
// than KERB_RADIUS, from a little before to a little after. They are tall and
// ramped (KERB_TOP at their outer edge), so a car that rides them is thrown
// about and loses grip (they count as sausages for the physics).
const KERB_RADIUS = 160;            // m
const KERB_W = 1.1;                 // m wide
const KERB_TOP = 0.09;              // m high at the outer edge
const KERB_BEFORE = 15, KERB_AFTER = 15; // m of kerb before / after each bend sample
// Armco: a double steel guardrail on posts, RAIL_GAP past the kerb or edge.
const RAIL_GAP = 1.6;               // m from the kerb's outer edge to the rail
const RAIL_LOW = 0.38, RAIL_HIGH = 1.05; // m: bottom of the lower beam, top of the upper one
const RAIL_POST = 3;                // m between posts (one per road sample)

// `avoid(x, z)` marks ground that must stay clear of sand.
export function buildTrack(layout, avoid = () => false) {
  const { control: CONTROL, closed, halfWidth: w, edge: CURB_WIDTH } = layout;
  const SAUSAGE_CENTER = w + CURB_WIDTH + SAUSAGE_GAP + SAUSAGE_RADIUS; // m from the centerline
  const SIGN_OFFSET = w + CURB_WIDTH + 2.5; // m from the centerline
  const n = CONTROL.length;
  const pts = [];
  if (closed) {
    for (let i = 0; i < n; i++) {
      const p0 = CONTROL[(i - 1 + n) % n], p1 = CONTROL[i], p2 = CONTROL[(i + 1) % n], p3 = CONTROL[(i + 2) % n];
      const per = layout.step ? Math.max(1, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / layout.step)) : SAMPLES / n;
      for (let j = 0; j < per; j++) pts.push(catmullRom(p0, p1, p2, p3, j / per));
    }
  } else {
    // Open ends: the end points repeat, so the road starts and ends on them.
    const C = (i) => CONTROL[Math.max(0, Math.min(n - 1, i))];
    for (let i = 0; i < n - 1; i++) {
      const per = Math.max(2, Math.round(Math.hypot(C(i + 1)[0] - C(i)[0], C(i + 1)[1] - C(i)[1]) / STAGE_STEP));
      for (let j = 0; j < per; j++) pts.push(catmullRom(C(i - 1), C(i), C(i + 1), C(i + 2), j / per));
    }
    pts.push(C(n - 1));
  }
  const N = pts.length;
  // Neighbouring samples; an open road stops at its ends.
  const next = (i) => (closed ? (i + 1) % N : Math.min(N - 1, i + 1));
  const prev = (i) => (closed ? (i - 1 + N) % N : Math.max(0, i - 1));
  const segs = closed ? N : N - 1; // segment i joins samples i and i + 1
  // Segments by grid cell, for nearest() on long roads.
  const NEAR_CELL = 25, NEAR_LOOK = 6;
  const near = segs > 3000 ? new Map() : null;
  for (let i = 0; near && i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % N];
    for (let cx = Math.floor(Math.min(a[0], b[0]) / NEAR_CELL); cx <= Math.floor(Math.max(a[0], b[0]) / NEAR_CELL); cx++) {
      for (let cz = Math.floor(Math.min(a[1], b[1]) / NEAR_CELL); cz <= Math.floor(Math.max(a[1], b[1]) / NEAR_CELL); cz++) {
        const k = cx * 100003 + cz;
        if (!near.has(k)) near.set(k, []);
        near.get(k).push(i);
      }
    }
  }

  // Unit tangent and left normal at each sample.
  const tan = pts.map((_, i) => {
    const a = pts[prev(i)], b = pts[next(i)];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    return [dx / l, dz / l];
  });
  const nor = tan.map(([tx, tz]) => [-tz, tx]); // points to the driver's right

  // Distance along the centerline at each sample.
  const along = [0];
  for (let i = 1; i <= N; i++) {
    const a = pts[i - 1], b = pts[i % N];
    along.push(along[i - 1] + (i < N || closed ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0));
  }
  const length = along[N];
  // Meters from i forward to j (negative behind i on an open road).
  const ahead = closed ? (i, j) => (along[j] - along[i] + length) % length : (i, j) => along[j] - along[i];

  // Road bumps (stage only), by distance along and offset from the centerline.
  const reach = w + CURB_WIDTH;
  const bump = layout.bumps ? (s, o) => bumpHeight(s, o, w, CURB_WIDTH) : () => 0;
  setRoadBumps(layout.bumps ? bumpsAt() : null);

  // Signed curvature (1/m, > 0 turning right) over a ~12 m window.
  const curv = pts.map((_, i) => {
    let a = i, b = i;
    while (ahead(a, i) < 6 && prev(a) !== a) a = prev(a);
    while (ahead(i, b) < 6 && next(b) !== b) b = next(b);
    const [ax, az] = tan[a], [bx, bz] = tan[b];
    return Math.atan2(ax * bz - az * bx, ax * bx + az * bz) / (ahead(a, i) + ahead(i, b));
  });

  // Corners: runs of tight samples, merged when less than 40 m apart.
  const tight = curv.map((c) => Math.abs(c) > 1 / TIGHT_RADIUS);
  const corners = [];
  const first = closed ? tight.findIndex((t, i) => !t && tight[(i + 1) % N]) : -1;
  if (first >= 0 || !closed) {
    for (let k = 1; k <= N; k++) {
      const i = closed ? (first + k) % N : k - 1;
      if (!tight[i]) continue;
      const prev = corners[corners.length - 1];
      if (prev && ahead(prev.exit, i) < 40) { prev.exit = i; prev.peak = Math.max(prev.peak, Math.abs(curv[i])); }
      else corners.push({ entry: i, exit: i, peak: Math.abs(curv[i]), right: curv[i] > 0 });
    }
    if (closed && corners.length > 1 && ahead(corners[corners.length - 1].exit, corners[0].entry) < 40) {
      corners[0].entry = corners.pop().entry;
    }
  }

  // Count-down boards before each corner, skipped where they'd sit in the
  // previous corner. They go on the outside unless another part of the circuit is there.
  const signs = [];
  corners.forEach((c, ci) => {
    const prevExit = closed ? corners[(ci - 1 + corners.length) % corners.length].exit : ci > 0 ? corners[ci - 1].exit : 0;
    const room = closed && corners.length === 1 ? length / 2 : ahead(prevExit, c.entry) - 10;
    for (const dist of SIGN_DISTANCES) {
      if (dist > room) continue;
      let i = c.entry;
      while (ahead(i, c.entry) < dist) i = prev(i);
      for (const side of [c.right ? -1 : 1, c.right ? 1 : -1]) {
        const x = pts[i][0] + nor[i][0] * SIGN_OFFSET * side, z = pts[i][1] + nor[i][1] * SIGN_OFFSET * side;
        if (nearest(x, z).distance < SIGN_OFFSET - 1) continue;
        signs.push({ x, z, y: terrainHeight(x, z), facing: [-tan[i][0], -tan[i][1]], dist, right: c.right });
        break;
      }
    }
  });

  // Sand depth beyond the curb, per sample, for each side (0: right, 1: left).
  const sandIn = w + CURB_WIDTH;
  const want = [new Float64Array(N), new Float64Array(N)];
  for (let j = 0; j < N && layout.sand; j++) {
    const c = Math.abs(curv[j]);
    if (c < 1 / SAND_FROM) continue;
    const depth = c > 1 / TIGHT_RADIUS ? 16 : c > 1 / 50 ? 12 : 8;
    const s = curv[j] > 0 ? 1 : 0; // the outside
    for (let i = j; ahead(i, j) < SAND_BEFORE; i = (i - 1 + N) % N) want[s][i] = Math.max(want[s][i], depth);
    for (let i = j; ahead(j, i) < SAND_AFTER; i = (i + 1) % N) want[s][i] = Math.max(want[s][i], depth);
  }
  // Taper the ends, then stop short of other parts of the road.
  const sandOut = want.map((d, s) => {
    const side = s === 0 ? 1 : -1;
    return Array.from(d, (_, i) => {
      let sum = 0;
      for (let k = -5; k <= 5; k++) sum += d[(i + k + N) % N];
      const depth = sum / 11;
      let o = 0;
      for (; o < depth; o += 0.5) {
        const off = sandIn + o, x = pts[i][0] + nor[i][0] * off * side, z = pts[i][1] + nor[i][1] * off * side;
        const r = nearest(x, z);
        const own = ahead(i, r.index) < 25 || ahead(r.index, i) < 25;
        if (!own || avoid(x, z)) break;
      }
      o = Math.max(0, o - 1);
      return o < 2 ? sandIn : sandIn + o;
    });
  });

  // Kerb width (m) past the edge line, per sample, for each side (0: right, 1: left).
  const edgeOut = w + CURB_WIDTH;
  const kerbOut = [new Float64Array(N), new Float64Array(N)];
  for (let j = 0; j < N && layout.kerbs; j++) {
    if (Math.abs(curv[j]) < 1 / KERB_RADIUS) continue;
    for (const k of kerbOut) {
      for (let i = j; ahead(i, j) < KERB_BEFORE; i = prev(i)) { k[i] = KERB_W; if (prev(i) === i) break; }
      for (let i = j; ahead(j, i) < KERB_AFTER; i = next(i)) { k[i] = KERB_W; if (next(i) === i) break; }
    }
  }
  // Guardrail offset from the centerline per sample and side, 0 where there is
  // none: just past the kerb, pulled in on the inside of tight bends, and left
  // out where another part of the road comes close.
  const railOut = [new Float64Array(N), new Float64Array(N)];
  for (let s = 0; s < 2 && layout.rails; s++) {
    const side = s === 0 ? 1 : -1;
    for (let i = 0; i < N; i++) {
      const want = edgeOut + kerbOut[s][i] + RAIL_GAP;
      const lim = curv[i] * side > 0 ? 0.85 / Math.abs(curv[i]) : Infinity;
      let o = Math.min(want, lim);
      const x = pts[i][0] + nor[i][0] * (o + 2) * side, z = pts[i][1] + nor[i][1] * (o + 2) * side;
      const r = nearest(x, z);
      const own = ahead(i, r.index) < 30 || ahead(r.index, i) < 30;
      railOut[s][i] = own && o > edgeOut + kerbOut[s][i] + 0.4 ? o : 0;
    }
  }
  // Offset of the rail at a point `t` of the way along segment i (0: none).
  const railAt = (s, i, t) => {
    const a = railOut[s][i], b = railOut[s][(i + 1) % N];
    return a && b ? a + (b - a) * t : 0;
  };

  // A strip between offsets [inner, outer] from the centerline, draped over the
  // terrain and lifted by `lift`. It's split into `lanes` across so it follows
  // the ground's curvature. `filter(i, lane)` picks pieces (alternating curb colors).
  function strip(inner, outer, lift, filter = () => true, lanes = 1) {
    const positions = [], normals = [], uvs = [];
    const at = vertexCache((i, o) => {
      const x = pts[i][0] + nor[i][0] * o, z = pts[i][1] + nor[i][1] * o;
      // Slope of the ground plus the bumps' slope along and across the road.
      const g = terrainSlope(x, z, groundHeight), e = 0.25;
      const ds = (bump(along[i] + e, o) - bump(along[i] - e, o)) / (2 * e);
      const dn = (bump(along[i], o + e) - bump(along[i], o - e)) / (2 * e);
      const gx = g.gx + ds * tan[i][0] + dn * nor[i][0], gz = g.gz + ds * tan[i][1] + dn * nor[i][1];
      const l = Math.hypot(gx, 1, gz);
      return [x, groundHeight(x, z) + bump(along[i], o) + (typeof lift === 'function' ? lift(o) : lift), z, -gx / l, 1 / l, -gz / l];
    }, positions, normals, (o) => uvs.push(o, 0)); // meters across, for the shader's wheel ruts
    for (let i = 0; i < segs; i++) {
      const k = (i + 1) % N;
      for (let l = 0; l < lanes; l++) {
        if (!filter(i, l)) continue;
        const o0 = inner + ((outer - inner) * l) / lanes, o1 = inner + ((outer - inner) * (l + 1)) / lanes;
        for (const [s, o] of [[i, o0], [i, o1], [k, o1], [i, o0], [k, o1], [k, o0]]) at(s, o);
      }
    }
    return { positions, normals, uvs };
  }

  // Grass from the road's edge out to RING_VERGE on one side (1: right,
  // -1: left), every other sample, in lanes that widen away from the road.
  // Each sample's strip stops before it reaches another part of the road or
  // folds over the inside of a bend.
  function vergeStrip(side) {
    const from = w + CURB_WIDTH, OFFS = [0, 1.5, 4, 8, 14, 22, 32, 44, RING_VERGE - from].map((o) => from + o);
    const reachOf = (i) => {
      const lim = Math.min(RING_VERGE, 0.9 / Math.max(1e-6, curv[i] * side > 0 ? Math.abs(curv[i]) : 0));
      const own = (o) => {
        const r = nearest(pts[i][0] + nor[i][0] * o * side, pts[i][1] + nor[i][1] * o * side);
        return ahead(i, r.index) < 40 || ahead(r.index, i) < 40;
      };
      // Usually nothing else is near: a few probes tell. Otherwise step out.
      if ([0.25, 0.5, 0.75, 1].every((f) => own(from + (lim - from) * f))) return lim;
      let o = from;
      while (o < lim && own(o)) o += 2;
      return Math.max(from, Math.min(lim, o - 2));
    };
    const idx = [];
    for (let i = 0; i < segs; i += 2) idx.push(i);
    if (!closed) idx.push(N - 1); else idx.push(0);
    const out = idx.map(reachOf);
    const positions = [], normals = [];
    const at = vertexCache((i, o) => {
      const x = pts[i][0] + nor[i][0] * o * side, z = pts[i][1] + nor[i][1] * o * side;
      return [x, groundHeight(x, z) + ROAD_LIFT * 0.5, z, ...terrainNormal(x, z, groundHeight)];
    }, positions, normals);
    for (let k = 0; k + 1 < idx.length; k++) {
      const i = idx[k], j = idx[k + 1];
      for (let l = 0; l + 1 < OFFS.length; l++) {
        const oi = (m) => Math.min(OFFS[m], out[k]), oj = (m) => Math.min(OFFS[m], out[k + 1]);
        if (oi(l) >= oi(l + 1) && oj(l) >= oj(l + 1)) continue;
        for (const [p, o] of [[i, oi(l)], [i, oi(l + 1)], [j, oj(l + 1)], [i, oi(l)], [j, oj(l + 1)], [j, oj(l)]]) at(p, o);
      }
    }
    return { positions, normals };
  }

  // Wraps `make(i, o)` -> [x, y, z, nx, ny, nz] (the vertex `o` meters right of
  // sample i) so each vertex is worked out once, however many triangles share it.
  function vertexCache(make, positions, normals, extra = () => {}) {
    const cache = new Map();
    return (i, o) => {
      const key = i * 8192 + Math.round(o * 40) + 4096;
      let v = cache.get(key);
      if (!v) cache.set(key, (v = make(i, o)));
      positions.push(v[0], v[1], v[2]);
      normals.push(v[3], v[4], v[5]);
      extra(o);
    };
  }

  const merge = (...ms) => ({
    positions: ms.flatMap((m) => m.positions),
    normals: ms.flatMap((m) => m.normals),
    uvs: ms.every((m) => m.uvs) ? ms.flatMap((m) => m.uvs) : undefined,
  });
  // Sand: like strip(), but out to a per-sample offset; tapers where it starts and ends.
  function sandStrip(s) {
    const side = s === 0 ? 1 : -1, out = sandOut[s], lanes = 4, positions = [], normals = [];
    const at = (i, o) => {
      const x = pts[i][0] + nor[i][0] * o * side, z = pts[i][1] + nor[i][1] * o * side;
      positions.push(x, terrainHeight(x, z) + ROAD_LIFT, z);
      normals.push(...terrainNormal(x, z));
    };
    for (let i = 0; i < segs; i++) {
      const k = (i + 1) % N;
      if (out[i] <= sandIn && out[k] <= sandIn) continue;
      for (let l = 0; l < lanes; l++) {
        const a = (o) => sandIn + ((o - sandIn) * l) / lanes, b = (o) => sandIn + ((o - sandIn) * (l + 1)) / lanes;
        for (const [p, o] of [[i, a(out[i])], [i, b(out[i])], [k, b(out[k])], [i, a(out[i])], [k, b(out[k])], [k, a(out[k])]]) at(p, o);
      }
    }
    return { positions, normals };
  }

  // Sausage pieces, each a center line of points with its across direction
  // (pointing away from the road), laid out by length along that line: on the
  // inside of a hairpin it is much shorter than the road beside it.
  const sausages = [];
  for (const c of layout.sausages ? corners : []) {
    let apex = c.entry;
    for (let i = c.entry; i !== c.exit; i = next(i)) if (Math.abs(curv[i]) > Math.abs(curv[apex])) apex = i;
    const side = c.right ? 1 : -1; // the inside
    const at = (d) => {
      const f = frameAt(d);
      // Inside a very tight bend, pull in so the line never folds over the bend's center.
      const off = Math.min(SAUSAGE_CENTER, 0.85 / Math.max(1e-6, Math.abs(f.curv)) - SAUSAGE_RADIUS);
      const n = [f.n[0] * side, f.n[1] * side];
      return { p: [f.p[0] + n[0] * off, f.p[1] + n[1] * off], n };
    };
    // Walk the sausage line both ways from the apex in small road steps.
    const walk = (dir, len) => {
      const out = [{ ...at(along[apex]), s: 0 }];
      for (let d = along[apex], s = 0; s < len;) {
        d += dir * 0.1;
        const q = at(d), last = out[out.length - 1];
        s += Math.hypot(q.p[0] - last.p[0], q.p[1] - last.p[1]);
        out.push({ ...q, s: dir * s });
      }
      return out;
    };
    const line = [...walk(-1, SAUSAGE_BEFORE).reverse(), ...walk(1, SAUSAGE_AFTER).slice(1)];
    const s0 = line[0].s, total = line[line.length - 1].s - s0;
    const count = Math.floor((total + PIECE_GAP) / (PIECE + PIECE_GAP));
    for (let k = 0; k < count; k++) {
      const from = s0 + k * (PIECE + PIECE_GAP);
      const ALONG = 10, pts = [];
      let j = 0;
      for (let a = 0; a <= ALONG; a++) {
        const want = from + (PIECE * a) / ALONG;
        while (j < line.length - 2 && line[j + 1].s < want) j++;
        const A = line[j], B = line[j + 1], t = Math.max(0, Math.min(1, (want - A.s) / (B.s - A.s)));
        const nx = A.n[0] + (B.n[0] - A.n[0]) * t, nz = A.n[1] + (B.n[1] - A.n[1]) * t, l = Math.hypot(nx, nz);
        pts.push({ p: [A.p[0] + (B.p[0] - A.p[0]) * t, A.p[1] + (B.p[1] - A.p[1]) * t], n: [nx / l, nz / l], e: (PIECE * a) / ALONG });
      }
      const xs = pts.map((q) => q.p[0]), zs = pts.map((q) => q.p[1]), m = SAUSAGE_RADIUS + 0.1;
      sausages.push({ pts, side, box: [Math.min(...xs) - m, Math.max(...xs) + m, Math.min(...zs) - m, Math.max(...zs) + m] });
    }
  }
  // Point, right normal and curvature `d` meters along the road, between samples.
  function frameAt(d) {
    d = closed ? ((d % length) + length) % length : Math.max(0, Math.min(length, d));
    let i = Math.max(0, along.findIndex((a) => a > d) - 1);
    i = Math.min(i, segs - 1);
    const k = (i + 1) % N, t = (d - along[i]) / Math.max(1e-6, along[i + 1] - along[i]);
    const nx = nor[i][0] + (nor[k][0] - nor[i][0]) * t, nz = nor[i][1] + (nor[k][1] - nor[i][1]) * t, l = Math.hypot(nx, nz);
    return { p: [pts[i][0] + (pts[k][0] - pts[i][0]) * t, pts[i][1] + (pts[k][1] - pts[i][1]) * t], n: [nx / l, nz / l], curv: curv[i] };
  }
  // A piece's cross-section `e` meters from its nearest end: a half round,
  // scaled down toward each end so the piece rounds off.
  const endScale = (e) => Math.sqrt(Math.max(0.02, 1 - Math.max(0, 1 - e / PIECE_ROUND) ** 2));
  function sausageMesh() {
    const positions = [], normals = [], ACROSS = 8;
    for (const s of sausages) {
      const rows = s.pts.map(({ p, n, e }) => {
        const k = endScale(Math.min(e, PIECE - e)), row = [];
        for (let c = 0; c <= ACROSS; c++) {
          const th = Math.PI * (c / ACROSS);          // around the half round, road side first
          const u = -Math.cos(th) * SAUSAGE_RADIUS * k, h = Math.sin(th) * SAUSAGE_HEIGHT * k;
          const x = p[0] + n[0] * u, z = p[1] + n[1] * u;
          const up = terrainNormal(x, z);
          // Ellipse normal: up and across.
          const cu = Math.sin(th) / SAUSAGE_HEIGHT, cx = -Math.cos(th) / SAUSAGE_RADIUS, l = Math.hypot(cu, cx);
          row.push([[x, terrainHeight(x, z) + ROAD_LIFT + h, z], [(n[0] * cx + up[0] * cu) / l, (up[1] * cu) / l, (n[1] * cx + up[2] * cu) / l]]);
        }
        return row;
      });
      for (let a = 0; a < rows.length - 1; a++) {
        for (let c = 0; c < ACROSS; c++) {
          for (const [i, j] of [[a, c], [a + 1, c], [a + 1, c + 1], [a, c], [a + 1, c + 1], [a, c + 1]]) {
            positions.push(...rows[i][j][0]);
            normals.push(...rows[i][j][1]);
          }
        }
      }
    }
    return { positions, normals };
  }
  // Height of a sausage's top above the ground at (x, z), 0 where there is none.
  function sausageHeight(x, z) {
    for (const { pts: q, box } of sausages) {
      if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) continue;
      for (let j = 0; j < q.length - 1; j++) {
        const A = q[j].p, B = q[j + 1].p, ex = B[0] - A[0], ez = B[1] - A[1];
        let t = ((x - A[0]) * ex + (z - A[1]) * ez) / (ex * ex + ez * ez);
        if (t < -0.1 || t > 1.1) continue; // a little overlap covers the outside of each joint
        t = Math.max(0, Math.min(1, t));
        const u = Math.hypot(x - A[0] - ex * t, z - A[1] - ez * t);
        const e = q[j].e + (q[j + 1].e - q[j].e) * t, k = endScale(Math.min(e, PIECE - e));
        const r = SAUSAGE_RADIUS * k;
        if (u < r) return SAUSAGE_HEIGHT * k * Math.sqrt(1 - (u / r) ** 2);
      }
    }
    return 0;
  }

  // Kerb surface height (m above the road) `u` meters past the edge line: a
  // ramp up to KERB_TOP over the first 40%, then flat.
  const kerbLift = (u) => KERB_TOP * Math.min(1, Math.max(0, u) / (KERB_W * 0.4));
  // The kerbs on one side (1: right, -1: left), in blocks picked by `filter(i)`.
  function kerbStrip(side, filter) {
    const s = side > 0 ? 0 : 1, positions = [], normals = [], uvs = [];
    const US = [0, 0.15, 0.3, 0.44, 0.7, 1];
    const at = vertexCache((i, o) => {
      const x = pts[i][0] + nor[i][0] * o * side, z = pts[i][1] + nor[i][1] * o * side;
      const u = o - edgeOut, n = terrainNormal(x, z, groundHeight);
      // Tilt the normal toward the road on the ramp, so it catches the light.
      const ramp = u < KERB_W * 0.4 ? KERB_TOP / (KERB_W * 0.4) : 0;
      const nx = n[0] - nor[i][0] * side * ramp, nz = n[2] - nor[i][1] * side * ramp, l = Math.hypot(nx, n[1], nz);
      return [x, groundHeight(x, z) + ROAD_LIFT + 0.01 + kerbLift(u), z, nx / l, n[1] / l, nz / l];
    }, positions, normals, (o) => uvs.push(o * side, 0));
    for (let i = 0; i < segs; i++) {
      const k = (i + 1) % N;
      if (!kerbOut[s][i] || !kerbOut[s][k] || !filter(i)) continue;
      for (let l = 0; l + 1 < US.length; l++) {
        const o0 = edgeOut + US[l] * KERB_W, o1 = edgeOut + US[l + 1] * KERB_W;
        for (const [p, o] of [[i, o0], [i, o1], [k, o1], [i, o0], [k, o1], [k, o0]]) at(p, o);
      }
      // Outer face, down to the grass.
      const o = edgeOut + KERB_W;
      for (const [p, dy] of [[i, 0], [k, 0], [k, 1], [i, 0], [k, 1], [i, 1]]) {
        const x = pts[p][0] + nor[p][0] * o * side, z = pts[p][1] + nor[p][1] * o * side;
        positions.push(x, groundHeight(x, z) + ROAD_LIFT + 0.01 + (dy ? 0 : KERB_TOP), z);
        normals.push(nor[p][0] * side, 0, nor[p][1] * side);
        uvs.push(o * side, 0);
      }
    }
    return { positions, normals, uvs };
  }
  // Guardrails: posts and beams, as boxes along the rail line.
  function railMeshes() {
    const beams = { positions: [], normals: [] }, posts = { positions: [], normals: [] };
    const quad = (m, a, b, c, d, n) => { for (const p of [a, b, c, a, c, d]) { m.positions.push(...p); m.normals.push(...n); } };
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1;
      const P = (i) => {
        const o = railOut[s][i], x = pts[i][0] + nor[i][0] * o * side, z = pts[i][1] + nor[i][1] * o * side;
        return { x, z, y: groundHeight(x, z), n: [-nor[i][0] * side, -nor[i][1] * side] }; // n faces the road
      };
      for (let i = 0; i < segs; i++) {
        const k = (i + 1) % N;
        if (!railOut[s][i]) continue;
        const a = P(i);
        // Post: a thin box behind the beams.
        const px = a.x - a.n[0] * 0.18, pz = a.z - a.n[1] * 0.18, t = [-a.n[1], a.n[0]], hw = 0.06;
        for (const [ux, uz, nx, nz] of [[1, 0, a.n[0], a.n[1]], [-1, 0, -a.n[0], -a.n[1]], [0, 1, t[0], t[1]], [0, -1, -t[0], -t[1]]]) {
          const cx = px + (a.n[0] * ux + t[0] * uz) * hw, cz = pz + (a.n[1] * ux + t[1] * uz) * hw;
          const ex = (t[0] * ux - a.n[0] * uz) * hw, ez = (t[1] * ux - a.n[1] * uz) * hw;
          quad(posts, [cx - ex, a.y - 0.3, cz - ez], [cx + ex, a.y - 0.3, cz + ez], [cx + ex, a.y + RAIL_HIGH - 0.05, cz + ez], [cx - ex, a.y + RAIL_HIGH - 0.05, cz - ez], [nx, 0, nz]);
        }
        if (!railOut[s][k]) continue;
        const b = P(k);
        // Two beams, each a front, a back and a top.
        const mid = (RAIL_LOW + RAIL_HIGH) / 2;
        for (const [y0, y1] of [[RAIL_LOW, mid - 0.04], [mid + 0.04, RAIL_HIGH]]) {
          const F = (q, y, d) => [q.x - q.n[0] * d, q.y + y, q.z - q.n[1] * d];
          const nf = [(a.n[0] + b.n[0]) / 2, 0, (a.n[1] + b.n[1]) / 2];
          quad(beams, F(a, y0, 0), F(b, y0, 0), F(b, y1, 0), F(a, y1, 0), nf);
          quad(beams, F(b, y0, 0.1), F(a, y0, 0.1), F(a, y1, 0.1), F(b, y1, 0.1), nf.map((v) => -v));
          quad(beams, F(a, y1, 0), F(b, y1, 0), F(b, y1, 0.1), F(a, y1, 0.1), [0, 1, 0]);
        }
      }
    }
    return { beams, posts };
  }
  // Height of a kerb at (x, z) above the road, 0 off them.
  function kerbHeight(x, z) {
    if (!layout.kerbs) return 0;
    const r = nearest(x, z), s = r.side > 0 ? 0 : 1;
    const k = kerbOut[s][r.index] && kerbOut[s][(r.index + 1) % N];
    const u = r.distance - edgeOut;
    if (!k || u < 0 || u > KERB_W) return 0;
    // A ripple along the blocks, so riding them shakes the car.
    const d = along[r.index] + (along[r.index + 1] - along[r.index]) * r.t;
    return Math.max(0.01, kerbLift(u) * (0.75 + 0.25 * Math.sin(d * 4.2)));
  }

  // Sample index `d` meters along the road.
  const indexAt = (d) => Math.max(0, along.findIndex((a) => a >= d));
  // Start and finish lines: the same line on a circuit, at each end of a stage.
  const startIndex = closed ? 0 : indexAt(layout.start);
  const finishIndex = closed ? 0 : indexAt(length - layout.finish);
  const edges = (filter) => merge(strip(w, w + CURB_WIDTH, ROAD_LIFT, filter), strip(-w - CURB_WIDTH, -w, ROAD_LIFT, filter));
  const line = (i, filter) => strip(-w, w, ROAD_LIFT + 0.02, (j, l) => j === i && filter(l), closed ? 4 : 8);

  // Surface layers, bottom to top; `top` ones need extra polygon offset over the road.
  let layers;
  if (layout.city) {
    // Asphalt, concrete gutters, a double yellow center line and a white start line.
    const yellow = (o) => strip(o - 0.06, o + 0.06, ROAD_LIFT + 0.02, undefined, 1);
    layers = [
      { mesh: strip(-w, w, ROAD_LIFT, undefined, 4), color: layout.colors.road, mat: 'asphalt' },
      { mesh: edges(() => true), color: [0.62, 0.62, 0.6], mat: 'concrete' },
      { mesh: merge(yellow(-0.12), yellow(0.12)), color: [0.95, 0.75, 0.12], mat: 'line', top: true },
      { mesh: line(startIndex, () => true), color: [0.95, 0.95, 0.95], mat: 'line', top: true },
    ];
  } else if (layout.verge) {
    // Nordschleife: asphalt with white edge lines, on grass verges that show
    // the exact ground out to RING_VERGE (see terrain.js).
    const red = (i) => i % 2 === 0, rails = railMeshes();
    layers = [
      { mesh: merge(vergeStrip(1), vergeStrip(-1)), color: [0.3, 0.55, 0.3], mat: 'grass' },
      { mesh: strip(-w, w, ROAD_LIFT, undefined, 4), color: layout.colors.road, mat: 'asphalt' },
      { mesh: edges(() => true), color: [0.92, 0.92, 0.9], mat: 'line' },
      { mesh: merge(kerbStrip(1, red), kerbStrip(-1, red)), color: [0.85, 0.15, 0.12], mat: 'kerb', raised: true },
      { mesh: merge(kerbStrip(1, (i) => !red(i)), kerbStrip(-1, (i) => !red(i))), color: [0.95, 0.95, 0.95], mat: 'kerb', raised: true },
      { mesh: line(startIndex, () => true), color: [0.95, 0.95, 0.95], mat: 'line', top: true },
      { mesh: rails.beams, color: [0.72, 0.74, 0.76], mat: 'metal', solid: true },
      { mesh: rails.posts, color: [0.5, 0.52, 0.55], mat: 'metal', solid: true },
    ];
  } else if (closed) {
    const red = (i) => Math.floor(i / 2) % 2 === 0;
    layers = [
      { mesh: merge(sandStrip(0), sandStrip(1)), color: [0.86, 0.76, 0.52], mat: 'sand' },
      { mesh: strip(-w, w, ROAD_LIFT, undefined, 4), color: layout.colors.road, mat: 'asphalt' },
      { mesh: edges(red), color: [0.85, 0.15, 0.12], mat: 'kerb' },
      { mesh: edges((i) => !red(i)), color: [0.95, 0.95, 0.95], mat: 'kerb' },
      { mesh: line(startIndex, () => true), color: [0.95, 0.95, 0.95], mat: 'line', top: true },
      { mesh: sausageMesh(), color: [0.98, 0.8, 0.08], mat: 'kerb', raised: true },
    ];
  } else {
    // Gravel with a darker, rutted verge; a white start line and a chequered finish.
    layers = [
      { mesh: edges(() => true), color: [0.45, 0.41, 0.32], mat: 'gravel' },
      { mesh: strip(-w, w, ROAD_LIFT, undefined, 4), color: layout.colors.road, mat: 'gravel' },
      { mesh: line(startIndex, () => true), color: [0.95, 0.95, 0.95], mat: 'line', top: true },
      { mesh: line(finishIndex, (l) => l % 2 === 0), color: [0.95, 0.95, 0.95], mat: 'line', top: true },
      { mesh: line(finishIndex, (l) => l % 2 === 1), color: [0.08, 0.08, 0.09], mat: 'line', top: true },
    ];
  }
  const mark = (i) => ({ x: pts[i][0], z: pts[i][1], tangent: tan[i], along: along[i] });

  return {
    closed,
    halfWidth: w,
    edgeWidth: CURB_WIDTH,
    surface: layout.surface,
    points: pts,
    tangents: tan,
    layers,
    corners,
    signs,
    sausages,
    sections: layout.sections ?? null, // [meters from the start, name], in order
    length,
    grid: mark(closed ? N - 4 : indexAt(12)), // where the car starts
    start: mark(startIndex),
    finish: mark(finishIndex),
    end: mark(N - 1),
    // Distance from the centerline, how far along the road, and what's underfoot:
    // track, sand or neither (grass). `surface` is the road's or the edge's
    // (kerb or verge) SURFACES key on the track, null off it.
    locate(x, z) {
      const r = nearest(x, z);
      const kerb = kerbOut[r.side > 0 ? 0 : 1];
      const onTrack = r.distance <= w + CURB_WIDTH + Math.min(kerb[r.index], kerb[(r.index + 1) % N]);
      const out = sandOut[r.side > 0 ? 0 : 1];
      const edge = out[r.index] + (out[(r.index + 1) % N] - out[r.index]) * r.t;
      const dist = along[r.index] + (along[r.index + 1] - along[r.index]) * r.t;
      const surface = !onTrack ? null : r.distance > w ? layout.edgeSurface : layout.surface;
      const rail = railAt(r.side > 0 ? 0 : 1, r.index, r.t);
      return { ...r, along: dist, onTrack, surface, sand: !onTrack && r.distance < edge, sandEdge: edge, rail };
    },
    // Height of a sausage kerb (or a tall Nordschleife kerb) at (x, z), 0 where there is none.
    sausageHeight: layout.kerbs ? (x, z) => Math.max(sausageHeight(x, z), kerbHeight(x, z)) : sausageHeight,
    // Guardrails: a point pushed into one gives how deep and which way out
    // (toward the road); points well behind a rail are left alone.
    blocked: layout.rails ? (x, z) => {
      const r = nearest(x, z), o = railAt(r.side > 0 ? 0 : 1, r.index, r.t);
      const depth = r.distance - (o - 0.05);
      if (!o || depth <= 0 || depth > 1.5) return null;
      const a = pts[r.index], b = pts[(r.index + 1) % N];
      const cx = a[0] + (b[0] - a[0]) * r.t, cz = a[1] + (b[1] - a[1]) * r.t, l = Math.hypot(cx - x, cz - z) || 1;
      return { depth, nx: (cx - x) / l, nz: (cz - z) / l };
    } : undefined,
  };

  // World-space bumps for the physics: the segments within reach of the road
  // are listed per grid cell, so a lookup only checks a handful of them.
  function bumpsAt() {
    const CELL = 20, cells = new Map();
    const key = (cx, cz) => cx * 100003 + cz;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % N];
      const x0 = Math.floor((Math.min(a[0], b[0]) - reach) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + reach) / CELL);
      const z0 = Math.floor((Math.min(a[1], b[1]) - reach) / CELL), z1 = Math.floor((Math.max(a[1], b[1]) + reach) / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = key(cx, cz);
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(i);
        }
      }
    }
    return (x, z) => {
      const list = cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!list) return 0;
      const r = nearestIn(x, z, list);
      if (r.distance >= reach) return 0;
      return bump(along[r.index] + (along[r.index + 1] - along[r.index]) * r.t, r.distance * r.side);
    };
  }

  // Nearest centerline sample and distance to the centerline polyline. Long
  // roads look in a grid of cells around (x, z) first, ring by ring, and only
  // check every segment when nothing is within LOOK cells.
  function nearest(x, z) {
    if (!near) return nearestIn(x, z);
    const cx = Math.floor(x / NEAR_CELL), cz = Math.floor(z / NEAR_CELL);
    let best = null;
    for (let r = 0; r <= NEAR_LOOK; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const list = near.get((cx + dx) * 100003 + cz + dz);
          if (!list) continue;
          const q = nearestIn(x, z, list);
          if (!best || q.distance < best.distance) best = q;
        }
      }
      // Anything in a further ring is at least r cells away.
      if (best && best.distance <= r * NEAR_CELL) return best;
    }
    return best ?? nearestIn(x, z);
  }

  // Nearest among the segments in `list` (all of them if null).
  function nearestIn(x, z, list = null) {
    let best = Infinity, index = 0, frac = 0, side = 1;
    for (let j = 0, n = list ? list.length : segs; j < n; j++) {
      const i = list ? list[j] : j;
      const a = pts[i], b = pts[(i + 1) % N];
      const ex = b[0] - a[0], ez = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez)));
      const dx = x - a[0] - ex * t, dz = z - a[1] - ez * t;
      const d = Math.hypot(dx, dz);
      if (d < best) { best = d; index = i; frac = t; side = dx * -ez + dz * ex >= 0 ? 1 : -1; }
    }
    // side: +1 on the driver's right (along `nor`), -1 on the left.
    return { distance: best, index, t: frac, side };
  }
}
