// The ground, shared by the ground mesh, the road and the car physics.
//
// The Nürburgring ('ring' and 'gp', one map) uses real ground
// (nordschleife.js): a 30 m elevation grid from the Copernicus DEM, plus the
// roads' own smoothed height profiles (the Nordschleife, the GP circuit and
// the two links between them). Near a road the ground takes the road's height
// (flat across it), then blends back into the elevation grid over BLEND meters.
//
// Montreal ('montreal') uses real ground too (montreal-ground.js): a 30 m
// bare-earth elevation grid (NRCan's MRDEM), from the rivers (~6 m by the Old
// Port, ~21 m on Lac Saint-Louis) to Mount Royal (~232 m). The grid has no
// bridges, so the street bridges come as lines and get a straight deck from
// one end to the other (road bumps on top of the ground). It's unpacked once
// (loadCityGround()), before the map is built.

import { NORDSCHLEIFE, GP_STRECKE, RING_LINKS } from './nordschleife.js';
import { MONTREAL_GROUND } from './montreal-ground.js';

const LANDS = {
  ring: { real: true },
  gp: { real: true },
  montreal: { city: true },
};
let land = LANDS.ring;
let bumps = null; // (x, z) -> extra height (m, >= 0) on the road, or null

// Picks the ground for a layout ('ring', 'gp' or 'montreal'); call before building anything on it.
export function setTerrain(kind) {
  land = LANDS[kind];
  bumps = land.city ? deckBump : null;
}

// Road bumps on top of the ground; null for none.
export function setRoadBumps(fn) {
  bumps = fn;
}

// Ground plus road bumps: what the car drives on.
export function terrainHeight(x, z) {
  return groundHeight(x, z) + (bumps ? bumps(x, z) : 0);
}

// The ground alone, without road bumps.
export function groundHeight(x, z) {
  return land.real ? ringHeight(x, z) : land.city ? cityHeight(x, z) : 0;
}

// Height, gradient (gx = dh/dx, gz = dh/dz) and second derivatives at (x, z),
// for the car. Slopes and curvature are taken over 1.5 m either way, about
// what tires and springs smooth over, so kinks shorter than that don't jolt it.
export function terrainSample(x, z, f = terrainHeight) {
  const e = 1.5;
  const h = f(x, z);
  const xp = f(x + e, z), xm = f(x - e, z), zp = f(x, z + e), zm = f(x, z - e);
  return {
    h,
    gx: (xp - xm) / (2 * e),
    gz: (zp - zm) / (2 * e),
    hxx: (xp - 2 * h + xm) / (e * e),
    hzz: (zp - 2 * h + zm) / (e * e),
    hxz: (f(x + e, z + e) - f(x + e, z - e) - f(x - e, z + e) + f(x - e, z - e)) / (4 * e * e),
  };
}

// Slope (dh/dx, dh/dz) at (x, z): four lookups, for building meshes.
export function terrainSlope(x, z, f = terrainHeight) {
  const e = 0.5;
  return { gx: (f(x + e, z) - f(x - e, z)) / (2 * e), gz: (f(x, z + e) - f(x, z - e)) / (2 * e) };
}

export function terrainNormal(x, z, f = terrainHeight) {
  const { gx, gz } = terrainSlope(x, z, f);
  const l = Math.hypot(gx, 1, gz);
  return [-gx / l, 1 / l, -gz / l];
}

// --- Nürburgring ground -------------------------------------------------

export const RING_FLAT = 9;   // m from a 4.5 m half-width road's centerline: ground at the road's height
export const RING_BLEND = 40; // m beyond that to blend into the elevation grid
export const RING_VERGE = 62; // m: the verge strips (track.js) reach this far
const RING_CELL = 20;         // m: lookup grid for road segments
// The roads on the map: `halfWidth` of asphalt (track.js lays them out with
// it); the ground is flat across them out to `flat` meters from the centerline.
export const RING_ROADS = [
  { id: 'ring', data: NORDSCHLEIFE, closed: true, halfWidth: 4.5, flat: RING_FLAT },
  { id: 'gp', data: GP_STRECKE, closed: true, halfWidth: 6, flat: RING_FLAT + 1.5 },
  ...RING_LINKS.map((l, k) => ({ id: `link${k}`, data: l, closed: false, halfWidth: 4.5, flat: RING_FLAT })),
];
let ring = null;

// Decodes the elevation grid and indexes all the roads' segments, once.
// Segment g is segment segIdx[g] (joining points i and i + 1) of road segRoad[g].
function ringData() {
  if (ring) return ring;
  const { dem } = NORDSCHLEIFE;
  const bin = atob(dem.data), h = new Float32Array(dem.nx * dem.nz);
  for (let i = 0; i < h.length; i++) h[i] = (((bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16) >> 16) / 10;
  const loops = RING_ROADS.filter((r) => r.closed).map((r) => smoothProfile(r.data.road, true));
  const roads = RING_ROADS.map((spec) => {
    const road = spec.closed ? loops[RING_ROADS.filter((r) => r.closed).indexOf(spec)] : smoothProfile(spec.data.road, false, loops), n = road.length, segs = spec.closed ? n : n - 1, along = [0];
    for (let i = 1; i <= segs; i++) {
      const a = road[i - 1], b = road[i % n];
      along.push(along[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    // Normals at each point, along the bisector of the two segments meeting
    // there and stretched (miter) so the road's parallels pass through them.
    const normals = road.map((p, i) => {
      const seg = (j) => { const a = road[j], b = road[(j + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]; };
      const prev = spec.closed || i > 0 ? seg((i - 1 + n) % n) : null, next = spec.closed || i < n - 1 ? seg(i) : null;
      if (!prev || !next) return prev ?? next;
      const bx = prev[0] + next[0], bz = prev[1] + next[1], l = Math.hypot(bx, bz), c = Math.max(0.5, (bx * next[0] + bz * next[1]) / l);
      return [bx / l / c, bz / l / c];
    });
    return { ...spec, road, n, segs, along, normals, length: along[segs] };
  });
  const segRoad = [], segIdx = [];
  roads.forEach((r, k) => { for (let i = 0; i < r.segs; i++) { segRoad.push(k); segIdx.push(i); } });
  const reach = RING_VERGE, cells = new Map();
  for (let g = 0; g < segRoad.length; g++) {
    const { road, n } = roads[segRoad[g]], i = segIdx[g], a = road[i], b = road[(i + 1) % n];
    const x0 = Math.floor((Math.min(a[0], b[0]) - reach) / RING_CELL), x1 = Math.floor((Math.max(a[0], b[0]) + reach) / RING_CELL);
    const z0 = Math.floor((Math.min(a[1], b[1]) - reach) / RING_CELL), z1 = Math.floor((Math.max(a[1], b[1]) + reach) / RING_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = cx * 100003 + cz;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(g);
      }
    }
  }
  ring = { dem, h, roads, segRoad, segIdx, cells };
  return ring;
}

// The roads' height profiles come smoothed over ~20 m, which still leaves
// short dips and rises from the elevation data that throw the car about at
// speed. Smooth them again (Gaussian, PROFILE_SIGMA meters) on a copy. An open
// road (a link) eases its ends to the smoothed circuit it joins (`loops`).
const PROFILE_SIGMA = 18; // m
function smoothProfile(road, closed, loops = []) {
  const n = road.length, at = (k) => (closed ? ((k % n) + n) % n : Math.max(0, Math.min(n - 1, k)));
  const step = Math.hypot(road[1][0] - road[0][0], road[1][1] - road[0][1]) || 6;
  const sig = PROFILE_SIGMA / step, reach = Math.ceil(3 * sig), w = [];
  for (let k = -reach; k <= reach; k++) w.push(Math.exp(-(k * k) / (2 * sig * sig)));
  // Height at each end: the nearest smoothed circuit point, or its own.
  const endHeight = (p) => {
    let best = 15, h = p[2];
    for (const l of loops) for (const q of l) { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < best) { best = d; h = q[2]; } }
    return h;
  };
  const h0 = closed ? 0 : endHeight(road[0]), h1 = closed ? 0 : endHeight(road[n - 1]);
  return road.map((p, i) => {
    let sum = 0, tot = 0;
    for (let k = -reach; k <= reach; k++) { const q = road[at(i + k)]; sum += w[k + reach] * q[2]; tot += w[k + reach]; }
    let h = sum / tot;
    if (!closed) {
      // Shift by the change at each end (blended along the road), then ease
      // into the circuits' heights over the last few samples.
      const f = i / (n - 1), shift = (h0 - road[0][2]) * (1 - f) + (h1 - road[n - 1][2]) * f;
      const e = Math.min(1, Math.min(i, n - 1 - i) / reach), k = e * e * (3 - 2 * e);
      h = p[2] + shift + (h - p[2] - shift) * k;
    }
    return [p[0], p[1], h];
  }).map((p, i, out) => {
    if (closed) return p;
    // Where a link runs alongside a circuit it takes the circuit's height,
    // easing off as they part, so the two never disagree side by side.
    const { d, h } = nearestOn(loops, p[0], p[1]), k = smooth((d - 1) / 30);
    return [p[0], p[1], h + (p[2] - h) * k];
  });
}

// Distance from (x, z) to the nearest of the `loops` (closed roads) and the
// height there, interpolated along that segment.
function nearestOn(loops, x, z) {
  let d = Infinity, h = 0;
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      const a = l[i], b = l[(i + 1) % l.length], ex = b[0] - a[0], ez = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez)));
      const e = Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t);
      if (e < d) { d = e; h = a[2] + (b[2] - a[2]) * t; }
    }
  }
  return { d, h };
}

// Elevation grid, bicubic (Catmull-Rom) so slopes have no kinks.
function demHeight(x, z) {
  const { dem, h } = ringData();
  const u = Math.max(1, Math.min(dem.nx - 3, (x - dem.x0) / dem.cell)), v = Math.max(1, Math.min(dem.nz - 3, (z - dem.z0) / dem.cell));
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
  const w = (t) => [((-t + 2) * t - 1) * t / 2, ((3 * t - 5) * t * t + 2) / 2, ((-3 * t + 4) * t + 1) * t / 2, (t - 1) * t * t / 2];
  const wu = w(fu), wv = w(fv);
  let sum = 0;
  for (let b = 0; b < 4; b++) {
    const row = (j - 1 + b) * dem.nx + i - 1;
    sum += wv[b] * (wu[0] * h[row] + wu[1] * h[row + 1] + wu[2] * h[row + 2] + wu[3] * h[row + 3]);
  }
  return sum;
}

// Height of road r `t` of the way along its segment i: Catmull-Rom through
// the profile, so the grade changes smoothly (an open road repeats its ends).
function roadAt(r, i, t) {
  const { road, n } = r, at = (k) => (r.closed ? (k + n) % n : k < 0 ? 0 : k >= n ? n - 1 : k);
  const a = road[at(i - 1)][2], b = road[i][2], c = road[at(i + 1)][2], d = road[at(i + 2)][2], t2 = t * t;
  return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t2 * t);
}

// Weight of a road's height at distance d from it: 1 on it, 0 past the blend.
function roadWeight(d, flat) {
  return 1 - smooth((d - flat) / RING_BLEND);
}
// Smootherstep of t clamped to [0, 1]: no kink in the curvature at either end.
function smooth(t) {
  t = Math.min(1, Math.max(0, t));
  return t * t * t * (t * (6 * t - 15) + 10);
}

// Squared distance from (x, z) to segment g; its position along it goes in scratch.t.
function probe(g, x, z) {
  const R = ring, { road, n } = R.roads[R.segRoad[g]], i = R.segIdx[g];
  const a = road[i], b = road[i + 1 === n ? 0 : i + 1], ex = b[0] - a[0], ez = b[1] - a[1];
  let t = ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = x - a[0] - ex * t, dz = z - a[1] - ez * t;
  scratch.t = t;
  return dx * dx + dz * dz;
}

// Where (x, z) lies across segment g: the point along it (t, in scratch.t)
// whose normal, blended between the normals at its two ends, passes through
// (x, z). Across neighboring segments t moves on without a jump, so heights
// taken off the road's centerline follow it smoothly. Returns the distance
// along that normal, or Infinity when (x, z) is beyond the segment's ends
// (open roads reach on past their last points).
function across(g, x, z) {
  const R = ring, r = R.roads[R.segRoad[g]], { road, n, normals } = r, i = R.segIdx[g], j = i + 1 === n ? 0 : i + 1;
  const a = road[i], b = road[j], na = normals[i], nb = normals[j];
  const ex = b[0] - a[0], ez = b[1] - a[1], qx = x - a[0], qz = z - a[1], dx = nb[0] - na[0], dz = nb[1] - na[1];
  // cross(q - t e, na + t dn) = 0: a quadratic in t.
  const cross = (u0, u1, v0, v1) => u0 * v1 - u1 * v0;
  const c0 = cross(qx, qz, na[0], na[1]), c1 = cross(qx, qz, dx, dz) - cross(ex, ez, na[0], na[1]), c2 = -cross(ex, ez, dx, dz);
  let t;
  if (Math.abs(c2) < 1e-9) t = -c0 / c1;
  else {
    const disc = c1 * c1 - 4 * c2 * c0;
    if (disc < 0) return Infinity;
    const sq = Math.sqrt(disc), t1 = (-c1 + sq) / (2 * c2), t2 = (-c1 - sq) / (2 * c2);
    t = Math.abs(t1 - 0.5) < Math.abs(t2 - 0.5) ? t1 : t2;
  }
  const E = 1e-6;
  if (!(t >= -E && t <= 1 + E)) {
    // Past an open road's end: the distance to that end.
    if (r.closed || !((t < 0 && i === 0) || (t > 1 && i === r.segs - 1))) return Infinity;
    t = t < 0 ? 0 : 1;
    scratch.t = t;
    return Math.hypot(qx - ex * t, qz - ez * t);
  }
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  scratch.t = t;
  const nx = na[0] + t * dx, nz = na[1] + t * dz;
  return Math.abs(((qx - ex * t) * nx + (qz - ez * t) * nz) / (nx * nx + nz * nz));
}

// Every road near (x, z) pulls the ground toward its height at the point
// across from (x, z) (the nearest stretch of it, when a road passes by more
// than once). They share by inverse distance, so on a road's asphalt its own
// height all but decides; how far the ground follows the roads is set by the
// strongest weight (1 on a road, fading to 0 past the blend).
let shares = new Float64Array(256), ts = new Float64Array(256), ds = new Float64Array(256);
function ringHeight(x, z) {
  const R = ringData(), base = demHeight(x, z);
  const list = R.cells.get(Math.floor(x / RING_CELL) * 100003 + Math.floor(z / RING_CELL));
  if (!list) return base;
  if (shares.length < list.length) { const m = list.length * 2; shares = new Float64Array(m); ts = new Float64Array(m); ds = new Float64Array(m); }
  for (let k = 0; k < list.length; k++) {
    const g = list[k], r = R.roads[R.segRoad[g]], far = r.flat + RING_BLEND;
    ds[k] = Infinity;
    const d = across(g, x, z);
    if (d < far) { ds[k] = d; ts[k] = scratch.t; }
  }
  // Of a road's nearby segments, only the closest counts (its neighbors
  // agree with it where they meet).
  let most = 0, sum = 0, top = 0;
  for (let k = 0; k < list.length; k++) {
    shares[k] = 0;
    const d = ds[k];
    if (d === Infinity) continue;
    const g = list[k], ri = R.segRoad[g], r = R.roads[ri];
    let beaten = false;
    for (let j = 0; j < list.length && !beaten; j++) {
      if (j === k || ds[j] === Infinity || R.segRoad[list[j]] !== ri) continue;
      let gap = Math.abs(R.segIdx[list[j]] - R.segIdx[g]);
      if (r.closed) gap = Math.min(gap, r.n - gap);
      if (gap <= NEIGHBORS && (ds[j] < d || (ds[j] === d && j < k))) beaten = true;
    }
    if (beaten) continue;
    const w = roadWeight(d, r.flat);
    if (w <= 0) continue;
    const q = (d + 0.5) * (d + 0.5), share = w / (q * q);
    shares[k] = share;
    sum += share;
    if (share > top) top = share;
    if (w > most) most = w;
  }
  if (sum === 0) return base;
  // Roads with a millionth of the top share or less change nothing that shows.
  let near = 0;
  for (let k = 0; k < list.length; k++) {
    if (shares[k] <= top * 1e-6) continue;
    const g = list[k];
    near += shares[k] * (roadAt(R.roads[R.segRoad[g]], R.segIdx[g], ts[k]) - base);
  }
  return base + most * (near / sum);
}
const NEIGHBORS = 12; // segments: closer than this along a road is the same stretch of it
const scratch = { t: 0 };

// Meters from (x, z) to the edge of the asphalt of the nearest road other than
// `except` (a RING_ROADS id): negative on it, Infinity when none is near.
export function roadClearance(x, z, except) {
  const R = ringData(), list = R.cells.get(Math.floor(x / RING_CELL) * 100003 + Math.floor(z / RING_CELL));
  let best = Infinity;
  for (const g of list ?? []) {
    const r = R.roads[R.segRoad[g]];
    if (r.id === except) continue;
    best = Math.min(best, Math.sqrt(probe(g, x, z)) - r.halfWidth);
  }
  return best;
}

// Ground for the Nürburgring: square chunks of a grid of `cell` meters
// covering the elevation data, each with its center and radius so far ones can
// be skipped. Near the road the verge strips (track.js) show the exact ground,
// so the grid there is pushed down a little to never poke through them.
export function ringTerrainChunks(cell, chunkCells = 48) {
  const R = ringData(), { dem } = R;
  const x0 = dem.x0 + dem.cell * 2, z0 = dem.z0 + dem.cell * 2;
  const nx = Math.floor(((dem.nx - 4) * dem.cell) / cell), nz = Math.floor(((dem.nz - 4) * dem.cell) / cell);
  const H = new Float32Array((nx + 1) * (nz + 1)), NRM = new Float32Array((nx + 1) * (nz + 1) * 3);
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      const x = x0 + i * cell, z = z0 + j * cell, k = i * (nz + 1) + j;
      let h = groundHeight(x, z);
      const near = 1 - smooth((nearRoad(x, z) - RING_FLAT - RING_BLEND + 4) / (RING_VERGE - RING_FLAT - RING_BLEND + 4));
      if (near > 0) {
        let lo = h;
        for (let a = 0; a < 8; a++) {
          const r = cell * 0.75;
          lo = Math.min(lo, groundHeight(x + Math.cos(a * Math.PI / 4) * r, z + Math.sin(a * Math.PI / 4) * r));
        }
        h += (lo - 0.3 - h) * near;
      }
      H[k] = h;
      NRM.set(terrainNormal(x, z, groundHeight), k * 3);
    }
  }
  const chunks = [];
  for (let ci = 0; ci < nx; ci += chunkCells) {
    for (let cj = 0; cj < nz; cj += chunkCells) {
      const i1 = Math.min(nx, ci + chunkCells), j1 = Math.min(nz, cj + chunkCells);
      const positions = [], normals = [], indices = [], m = j1 - cj + 1;
      for (let i = ci; i <= i1; i++) {
        for (let j = cj; j <= j1; j++) {
          const k = i * (nz + 1) + j;
          positions.push(x0 + i * cell, H[k], z0 + j * cell);
          normals.push(NRM[k * 3], NRM[k * 3 + 1], NRM[k * 3 + 2]);
        }
      }
      const at = (i, j) => (i - ci) * m + (j - cj);
      for (let i = ci; i < i1; i++) {
        for (let j = cj; j < j1; j++) indices.push(at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i + 1, j));
      }
      const cx = x0 + ((ci + i1) / 2) * cell, cz = z0 + ((cj + j1) / 2) * cell;
      chunks.push({ positions, normals, indices, x: cx, z: cz, radius: Math.hypot(i1 - ci, j1 - cj) * cell / 2 });
    }
  }
  return chunks;
}

// Distance to the nearest road's centerline (Infinity when far), less how
// much wider than RING_FLAT its flat strip is.
function nearRoad(x, z) {
  const R = ringData(), list = R.cells.get(Math.floor(x / RING_CELL) * 100003 + Math.floor(z / RING_CELL));
  let best = Infinity;
  for (const g of list ?? []) best = Math.min(best, Math.sqrt(probe(g, x, z)) - (R.roads[R.segRoad[g]].flat - RING_FLAT));
  return best;
}

// --- Montreal's ground ----------------------------------------------------

// Half width (m) a bridge's deck reaches from its line, by street class
// (montreal-ground.js `classes`): the roadway and sidewalks (openmap.js), plus a little.
const DECK_HALF = { primary: 10, secondary: 9.5, tertiary: 8.2, residential: 7, unclassified: 6.3, living_street: 4.5, service: 3.6 };
const DECK_EDGE = 4;  // m beyond that over which the deck lets go of the road (no cliff at its side)
const DECK_CELL = 50; // m: lookup grid for the decks
let cityLand = null;

// Unpacks the elevation grid and the bridges (deflated, base64): call once, before building Montreal.
export async function loadCityGround() {
  if (cityLand) return cityLand;
  const G = MONTREAL_GROUND, bin = atob(G.data), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const h = new Float32Array(G.nx * G.nz);
  let p = 0;
  const zig = (b) => {
    let v = 0, s = 0, c;
    do { c = b[p++]; v += (c & 127) * 2 ** s; s += 7; } while (c & 128);
    return v % 2 ? -(v + 1) / 2 : v / 2;
  };
  // Rows of steps from the row before, in decimeters.
  for (let j = 0, o = 0; j < G.nz; j++) {
    for (let i = 0; i < G.nx; i++, o++) h[o] = (j ? h[o - G.nx] : 0) + zig(raw) / 10;
  }
  cityLand = { h, decks: [], cells: new Map() };
  // Bridges: lines with their street class.
  const bb = atob(G.bridges), b = new Uint8Array(bb.length);
  for (let i = 0; i < bb.length; i++) b[i] = bb.charCodeAt(i);
  p = 0;
  for (let n = zig(b), q = 0; q < n; q++) {
    const half = DECK_HALF[G.classes[zig(b)]] ?? 7, pts = [];
    let x = 0, z = 0;
    for (let m = zig(b), k = 0; k < m; k++) { x += zig(b); z += zig(b); pts.push([x / 10, z / 10]); }
    const along = [0];
    for (let k = 1; k < pts.length; k++) along.push(along[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const L = along[along.length - 1], [ax, az] = pts[0], [bx, bz] = pts[pts.length - 1];
    // A straight deck from end to end, at the ground's height there.
    const deck = { pts, along, half, h0: cityHeight(ax, az), h1: cityHeight(bx, bz), length: L };
    cityLand.decks.push(deck);
    const reach = half + DECK_EDGE, xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]);
    for (let i = Math.floor((Math.min(...xs) - reach) / DECK_CELL); i <= Math.floor((Math.max(...xs) + reach) / DECK_CELL); i++) {
      for (let j = Math.floor((Math.min(...zs) - reach) / DECK_CELL); j <= Math.floor((Math.max(...zs) + reach) / DECK_CELL); j++) {
        const k = i * 100003 + j;
        if (!cityLand.cells.has(k)) cityLand.cells.set(k, []);
        cityLand.cells.get(k).push(deck);
      }
    }
  }
  return cityLand;
}

// The elevation grid, bicubic (Catmull-Rom) so slopes have no kinks; 0 before it's loaded.
function cityHeight(x, z) {
  if (!cityLand) return 0;
  const G = MONTREAL_GROUND, h = cityLand.h;
  const u = Math.max(1, Math.min(G.nx - 3, (x - G.x0) / G.cell)), v = Math.max(1, Math.min(G.nz - 3, (z - G.z0) / G.cell));
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
  const wu0 = ((-fu + 2) * fu - 1) * fu / 2, wu1 = ((3 * fu - 5) * fu * fu + 2) / 2, wu2 = ((-3 * fu + 4) * fu + 1) * fu / 2, wu3 = (fu - 1) * fu * fu / 2;
  const wv = [((-fv + 2) * fv - 1) * fv / 2, ((3 * fv - 5) * fv * fv + 2) / 2, ((-3 * fv + 4) * fv + 1) * fv / 2, (fv - 1) * fv * fv / 2];
  let sum = 0;
  for (let b = 0; b < 4; b++) {
    const row = (j - 1 + b) * G.nx + i - 1;
    sum += wv[b] * (wu0 * h[row] + wu1 * h[row + 1] + wu2 * h[row + 2] + wu3 * h[row + 3]);
  }
  return sum;
}

// How far a bridge's deck lifts the road above the ground at (x, z): the
// highest deck over it (0 off the bridges). Within `half` of a bridge's line
// the deck is level across; past that it eases back to the ground. Given a
// heading (dx, dz), only decks running that way (within ~45°) count: a street
// that passes under a bridge stays on the ground.
function deckBump(x, z, dx = 0, dz = 0) {
  const list = cityLand?.cells.get(Math.floor(x / DECK_CELL) * 100003 + Math.floor(z / DECK_CELL));
  if (!list) return 0;
  let best = 0, ground = null;
  for (const d of list) {
    const { pts, along } = d;
    let dist = Infinity, s = 0, way = 1;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1], ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1;
      const t = ((x - ax) * ex + (z - az) * ez) / l2;
      // Past the deck's ends the ground carries the road.
      if ((t < 0 && k === 0) || (t > 1 && k === pts.length - 2)) continue;
      const tc = Math.max(0, Math.min(1, t)), e = Math.hypot(x - ax - ex * tc, z - az - ez * tc);
      if (e < dist) { dist = e; s = along[k] + (along[k + 1] - along[k]) * tc; way = dx || dz ? Math.abs(ex * dx + ez * dz) / Math.sqrt(l2 * (dx * dx + dz * dz)) : 1; }
    }
    if (dist > d.half + DECK_EDGE || way < 0.7) continue;
    ground ??= cityHeight(x, z);
    const lift = d.h0 + (d.h1 - d.h0) * (s / (d.length || 1)) - ground;
    if (lift <= 0) continue;
    const w = 1 - smooth((dist - d.half) / DECK_EDGE);
    best = Math.max(best, lift * w);
  }
  return best;
}

// The road's height at (x, z) for something heading (dx, dz): on a bridge's
// deck only going along it (see deckBump). Elsewhere, terrainHeight().
export function levelHeight(x, z, dx, dz) {
  return land.city ? cityHeight(x, z) + deckBump(x, z, dx, dz) : terrainHeight(x, z);
}

// Montreal's ground in a square tile [x0, x0 + size] x [z0, z0 + size], a
// grid of `cell` m: tiles side by side share their edges' heights. `under`
// (x, z, h) can change a height (to keep the ground under the water).
export function cityGroundTile(x0, z0, size, cell, under = (x, z, h) => h) {
  const n = Math.round(size / cell), positions = [], normals = [], indices = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const x = x0 + i * cell, z = z0 + j * cell;
      positions.push(x, under(x, z, groundHeight(x, z)), z);
      normals.push(...terrainNormal(x, z, groundHeight));
    }
  }
  const at = (i, j) => i * (n + 1) + j;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) indices.push(at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i + 1, j));
  }
  return { positions, normals, indices };
}

// Height of the water's surface near (x, z) (Montreal): the lowest ground
// within `reach` m (the DTM gives the water's surface over the rivers), a
// little raised so the ground under the water never shows through.
export function cityWaterLevel(x, z, reach = 60) {
  let lo = Infinity;
  for (let a = -reach; a <= reach; a += 30) for (let b = -reach; b <= reach; b += 30) lo = Math.min(lo, cityHeight(x + a, z + b));
  return lo + 0.3;
}
