// The ground, shared by the ground mesh, the road and the car physics.
//
// The Nordschleife ('ring') uses real ground (nordschleife.js): a 30 m
// elevation grid from the Copernicus DEM, plus the road's own smoothed
// height profile. Near the road the ground takes the road's height (flat
// across it), then blends back into the elevation grid over BLEND meters.
//
// Verdun ('verdun') is flat: about 20 m above sea level all over, and wide.

import { NORDSCHLEIFE } from './nordschleife.js';

// flat: half-size (m) of the ground's fine middle part.
const LANDS = {
  ring: { real: true },
  verdun: { flat: 3000 },
};
let land = LANDS.ring;
let bumps = null; // (x, z) -> extra height (m, >= 0) on the road, or null

// Picks the ground for a layout ('ring' or 'verdun'); call before building anything on it.
export function setTerrain(kind) {
  land = LANDS[kind];
  bumps = null;
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
  return land.real ? ringHeight(x, z) : 0;
}

// Height, gradient (gx = dh/dx, gz = dh/dz) and second derivatives at (x, z).
export function terrainSample(x, z, f = terrainHeight) {
  const e = 0.5;
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

// Ground grid covering [-half, half]^2: cells of about `cell` meters in the
// middle, then a few wide cells out to the edge. Rows and columns share the
// same coordinates everywhere, so there are no cracks between the two.
export function terrainMesh(half, cell) {
  const FLAT = land.flat, fine = Math.ceil((2 * FLAT) / cell), coarse = 6;
  const axis = [];
  for (let i = 0; i < coarse; i++) axis.push(-half + ((half - FLAT) * i) / coarse);
  for (let i = 0; i <= fine; i++) axis.push(-FLAT + (2 * FLAT * i) / fine);
  for (let i = coarse - 1; i >= 0; i--) axis.push(half - ((half - FLAT) * i) / coarse);

  // Shared vertices + an index list: ~6x fewer vertices for the GPU to process.
  const n = axis.length, positions = [], normals = [], indices = [];
  for (const x of axis) {
    for (const z of axis) {
      positions.push(x, groundHeight(x, z), z);
      normals.push(...terrainNormal(x, z, groundHeight));
    }
  }
  const at = (i, j) => i * n + j;
  for (let i = 0; i + 1 < n; i++) {
    for (let j = 0; j + 1 < n; j++) {
      // Counter-clockwise seen from above.
      indices.push(at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i + 1, j));
    }
  }
  return { positions, normals, indices };
}

// --- Nordschleife ground -------------------------------------------------

export const RING_FLAT = 9;   // m from the centerline: ground at the road's height
export const RING_BLEND = 40; // m beyond that to blend into the elevation grid
export const RING_VERGE = 62; // m: the verge strips (track.js) reach this far
const RING_CELL = 20;         // m: lookup grid for road segments
let ring = null;

// Decodes the elevation grid and indexes the road's segments, once.
function ringData() {
  if (ring) return ring;
  const { dem, road } = NORDSCHLEIFE;
  const bin = atob(dem.data), h = new Float32Array(dem.nx * dem.nz);
  for (let i = 0; i < h.length; i++) h[i] = (((bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16) >> 16) / 10;
  const n = road.length, along = [0];
  for (let i = 1; i <= n; i++) {
    const a = road[i - 1], b = road[i % n];
    along.push(along[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const reach = RING_VERGE, cells = new Map();
  for (let i = 0; i < n; i++) {
    const a = road[i], b = road[(i + 1) % n];
    const x0 = Math.floor((Math.min(a[0], b[0]) - reach) / RING_CELL), x1 = Math.floor((Math.max(a[0], b[0]) + reach) / RING_CELL);
    const z0 = Math.floor((Math.min(a[1], b[1]) - reach) / RING_CELL), z1 = Math.floor((Math.max(a[1], b[1]) + reach) / RING_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = cx * 100003 + cz;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(i);
      }
    }
  }
  // Cells reached by more than one stretch of road (> 150 m apart along it).
  const multi = new Set();
  for (const [k, list] of cells) {
    const s0 = along[list[0]];
    if (list.some((i) => { const ds = Math.abs(along[i] - s0); return Math.min(ds, along[n] - ds) > 150; })) multi.add(k);
  }
  for (const k of multi) cells.get(k).multi = true;
  ring = { dem, h, road, n, along, length: along[n], cells };
  return ring;
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

// Road height `t` of the way along segment i: Catmull-Rom through the
// profile, so the grade changes smoothly.
function roadAt(R, i, t) {
  const p = (k) => R.road[(k + R.n) % R.n][2];
  const a = p(i - 1), b = p(i), c = p(i + 1), d = p(i + 2), t2 = t * t;
  return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t2 * t);
}

// Weight of the road's height at distance d from it: 1 on it, 0 past the blend.
function roadWeight(d) {
  return 1 - smooth((d - RING_FLAT) / RING_BLEND);
}
// Smootherstep of t clamped to [0, 1]: no kink in the curvature at either end.
function smooth(t) {
  t = Math.min(1, Math.max(0, t));
  return t * t * t * (t * (6 * t - 15) + 10);
}

// The nearest point of the road and, when another stretch of it is also near
// (more than 150 m further along), the nearest point of that one too. Both
// pull the ground to their height; on the line halfway between them they
// pull equally, so the ground has no step there.
function ringHeight(x, z) {
  const R = ringData(), base = demHeight(x, z);
  const list = R.cells.get(Math.floor(x / RING_CELL) * 100003 + Math.floor(z / RING_CELL));
  if (!list) return base;
  const { road, n, along, length } = R;
  // Squared distance and position along segment i, in scratch.
  const probe = (i) => {
    const a = road[i], b = road[i + 1 === n ? 0 : i + 1], ex = b[0] - a[0], ez = b[1] - a[1];
    let t = ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - a[0] - ex * t, dz = z - a[1] - ez * t;
    scratch.t = t;
    return dx * dx + dz * dz;
  };
  let d1 = Infinity, i1 = -1, t1 = 0;
  for (let k = 0; k < list.length; k++) {
    const d = probe(list[k]);
    if (d < d1) { d1 = d; i1 = list[k]; t1 = scratch.t; }
  }
  const s1 = along[i1] + (along[i1 + 1] - along[i1]) * t1;
  let d2 = Infinity, i2 = -1, t2 = 0;
  for (let k = 0; list.multi && k < list.length; k++) {
    const i = list[k];
    let ds = Math.abs(along[i] - s1);
    ds = Math.min(ds, length - ds);
    if (ds < 150) continue;
    const d = probe(i);
    if (d < d2) { d2 = d; i2 = i; t2 = scratch.t; }
  }
  const w1 = roadWeight(Math.sqrt(d1)), w2 = i2 < 0 ? 0 : roadWeight(Math.sqrt(d2));
  if (w1 + w2 === 0) return base;
  // Shares: the nearer road wins outright when the car is on it.
  const g1 = w2 === 0 ? 1 : w1 + w2 >= 2 ? 0.5 : (1 - w2) / (2 - w1 - w2);
  let h = base + w1 * g1 * (roadAt(R, i1, t1) - base);
  if (w2 > 0) h += w2 * (1 - g1) * (roadAt(R, i2, t2) - base);
  return h;
}
const scratch = { t: 0 };

// Ground for the Nordschleife: square chunks of a grid of `cell` meters
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

// Distance to the Nordschleife's centerline polyline (Infinity when far).
function nearRoad(x, z) {
  const R = ringData(), list = R.cells.get(Math.floor(x / RING_CELL) * 100003 + Math.floor(z / RING_CELL));
  let best = Infinity;
  for (const i of list ?? []) {
    const a = R.road[i], b = R.road[(i + 1) % R.n], ex = b[0] - a[0], ez = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez)));
    best = Math.min(best, Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t));
  }
  return best;
}
