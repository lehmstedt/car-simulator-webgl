// Downtown Montreal around the street circuit, from open data (downtown-data.js,
// built by scripts/downtown/): the other streets (drivable, not timed), parks
// and lawns, and the buildings, extruded from their real footprints to their
// mapped height (or a guess from their floors or use). Buildings are solid: the
// car stops against them. Everything is merged into a few meshes.

import { DOWNTOWN } from './downtown-data.js';
import { groundHeight, terrainNormal } from './terrain.js';
import { ROAD_LIFT, pairs } from './track.js';
const STREET_LIFT = ROAD_LIFT - 0.02; // just under the circuit where they meet
const PARK_LIFT = ROAD_LIFT - 0.03;

// Things listed per grid cell by their bounding box, so a lookup checks a handful.
class Grid {
  constructor(cell = 16) { this.cell = cell; this.cells = new Map(); }
  key(i, j) { return i * 100003 + j; }
  add(x0, x1, z0, z1, item) {
    const c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) {
      for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) {
        const k = this.key(i, j);
        if (!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k).push(item);
      }
    }
  }
  at(x, z) { return this.cells.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell))) ?? []; }
}

// Wall colors: Montreal greystone, red and brown brick, pale concrete; glass for towers.
const WALL_STONE = [[0.62, 0.6, 0.56], [0.55, 0.33, 0.25], [0.45, 0.3, 0.24], [0.72, 0.7, 0.66], [0.66, 0.6, 0.5]];
const WALL_GLASS = [[0.35, 0.45, 0.52], [0.3, 0.38, 0.42], [0.42, 0.47, 0.5]];
const TOWER = 45; // m: taller buildings get glass curtain walls

// Seeded pick from a building's footprint, so colors never change between visits.
const pick = (list, seed) => list[Math.abs(Math.floor(Math.sin(seed * 12.9898) * 43758.5453)) % list.length];

export function buildCity() {
  // --- Streets: ribbons draped over the ground, mitred at their bends.
  const streets = DOWNTOWN.streets.map(({ w, p }) => ({ w, p: pairs(p) }));
  const roadGrid = new Grid();
  const street = { positions: [], normals: [] };
  for (const { w, p } of streets) {
    const segN = [];
    for (let i = 0; i + 1 < p.length; i++) {
      const dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1], l = Math.hypot(dx, dz);
      segN.push([-dz / l, dx / l]);
      roadGrid.add(Math.min(p[i][0], p[i + 1][0]) - w, Math.max(p[i][0], p[i + 1][0]) + w,
        Math.min(p[i][1], p[i + 1][1]) - w, Math.max(p[i][1], p[i + 1][1]) + w, [p[i], p[i + 1], w]);
    }
    // Miter at each point: the mean of its segments' normals, stretched to keep the width.
    const miter = p.map((_, i) => {
      const a = segN[Math.max(0, i - 1)], b = segN[Math.min(segN.length - 1, i)];
      let nx = a[0] + b[0], nz = a[1] + b[1];
      const l = Math.hypot(nx, nz) || 1;
      nx /= l; nz /= l;
      const k = Math.min(2, 1 / Math.max(0.5, nx * b[0] + nz * b[1]));
      return [nx * k, nz * k];
    });
    const vert = (x, z) => {
      street.positions.push(x, groundHeight(x, z) + STREET_LIFT, z);
      street.normals.push(...terrainNormal(x, z, groundHeight));
    };
    for (let i = 0; i + 1 < p.length; i++) {
      const n = Math.max(1, Math.ceil(Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]) / 5));
      for (let k = 0; k < n; k++) {
        const at = (t) => {
          const x = p[i][0] + (p[i + 1][0] - p[i][0]) * t, z = p[i][1] + (p[i + 1][1] - p[i][1]) * t;
          const mx = miter[i][0] + (miter[i + 1][0] - miter[i][0]) * t, mz = miter[i][1] + (miter[i + 1][1] - miter[i][1]) * t;
          return [[x - mx * w, z - mz * w], [x + mx * w, z + mz * w]];
        };
        const [l0, r0] = at(k / n), [l1, r1] = at((k + 1) / n);
        for (const q of [l0, r0, r1, l0, r1, l1]) vert(...q);
      }
    }
  }

  // --- Parks: triangles, split until small enough to follow the hills.
  const park = { positions: [], normals: [] };
  const parkGrid = new Grid(24);
  const P = DOWNTOWN.parks;
  const drape = (a, b, c) => {
    const len = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1]);
    const mid = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
    const e = [len(a, b), len(b, c), len(c, a)], m = Math.max(...e);
    if (m > 18) {
      // Split the longest edge.
      if (m === e[0]) { const d = mid(a, b); drape(a, d, c); drape(d, b, c); }
      else if (m === e[1]) { const d = mid(b, c); drape(a, b, d); drape(a, d, c); }
      else { const d = mid(c, a); drape(a, b, d); drape(d, b, c); }
      return;
    }
    for (const [x, z] of [a, b, c]) {
      park.positions.push(x, groundHeight(x, z) + PARK_LIFT, z);
      park.normals.push(...terrainNormal(x, z, groundHeight));
    }
  };
  for (let i = 0; i < P.length; i += 6) {
    const a = [P[i], P[i + 1]], b = [P[i + 2], P[i + 3]], c = [P[i + 4], P[i + 5]];
    drape(a, b, c);
    parkGrid.add(Math.min(a[0], b[0], c[0]), Math.max(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.max(a[1], b[1], c[1]), [a, b, c]);
  }

  // --- Buildings: walls (UVs in meters for the window grid) and flat roofs,
  // grouped by color. They stand on the lowest ground under them.
  const groups = new Map();
  const group = (color, mat) => {
    const k = `${mat}:${color}`;
    if (!groups.has(k)) groups.set(k, { color, mat, mesh: { positions: [], normals: [], uvs: [] } });
    return groups.get(k).mesh;
  };
  const roofs = { positions: [], normals: [] };
  const blockGrid = new Grid();
  const blocks = [];
  for (const b of DOWNTOWN.buildings) {
    const ring = pairs(b.p);
    let base = Infinity, top = -Infinity, seed = 0;
    for (const [x, z] of ring) {
      const g = groundHeight(x, z);
      base = Math.min(base, g); top = Math.max(top, g);
      seed += x * 0.37 + z * 0.11;
    }
    base -= 0.5;
    top += b.h;
    const tower = b.h >= TOWER;
    const walls = group(tower ? pick(WALL_GLASS, seed) : pick(WALL_STONE, seed), tower ? 'curtain' : 'facade');
    let u = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % ring.length];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-3) continue;
      // Counter-clockwise ring (x east, z south): outward is (dz, -dx).
      const nx = (z1 - z0) / len, nz = -(x1 - x0) / len;
      const g0 = groundHeight(x0, z0), g1 = groundHeight(x1, z1);
      // Windows count from the street: v is meters above the ground at that corner.
      const quad = [[x0, base, z0, u, base - g0], [x1, base, z1, u + len, base - g1], [x1, top, z1, u + len, top - g1],
        [x0, base, z0, u, base - g0], [x1, top, z1, u + len, top - g1], [x0, top, z0, u, top - g0]];
      for (const [x, y, z, s, t] of quad) {
        walls.positions.push(x, y, z);
        walls.normals.push(nx, 0, nz);
        walls.uvs.push(s, t);
      }
      u += len;
    }
    for (const k of b.t) {
      roofs.positions.push(ring[k][0], top, ring[k][1]);
      roofs.normals.push(0, 1, 0);
    }
    const xs = ring.map((q) => q[0]), zs = ring.map((q) => q[1]);
    const block = { ring, h: b.h };
    blocks.push(block);
    blockGrid.add(Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs), block);
  }

  // --- Lookups.
  const onStreet = (x, z) => roadGrid.at(x, z).some(([a, b, w]) => segDist(x, z, a, b) <= w);
  const inPark = (x, z) => parkGrid.at(x, z).some(([a, b, c]) => inTriangle(x, z, a, b, c));
  // The building at (x, z), if any (`margin` meters around it counts too).
  const buildingAt = (x, z, margin = 0) => blockGrid.at(x, z).find((k) => inRing(x, z, k.ring) || (margin > 0 && ringDist(x, z, k.ring) < margin));

  // Car against buildings: points around the body are pushed out of any wall
  // they went through, and the speed into the wall is taken away (a small
  // bounce, plus scrubbing along it).
  const OUTLINE = [[-0.9, 2.1], [0.9, 2.1], [-0.9, -2.1], [0.9, -2.1], [-0.9, 0], [0.9, 0], [0, 2.15], [0, -2.15]];
  function collide(car) {
    let hit = 0;
    for (let pass = 0; pass < 3; pass++) {
      const s = Math.sin(car.heading), c = Math.cos(car.heading);
      let deepest = null;
      for (const [side, fwd] of OUTLINE) {
        // Forward is (-sin, -cos); right is (cos, -sin).
        const x = car.x - s * fwd + c * side, z = car.z - c * fwd - s * side;
        for (const k of blockGrid.at(x, z)) {
          if (!inRing(x, z, k.ring)) continue;
          const e = nearestEdge(x, z, k.ring);
          if (!deepest || e.d > deepest.d) deepest = e;
        }
      }
      if (!deepest) break;
      const { d, n } = deepest;
      car.x += n[0] * (d + 0.02);
      car.z += n[1] * (d + 0.02);
      // World velocity from the body frame (vx forward, vy left).
      let vxw = -s * car.vx - c * car.vy, vzw = -c * car.vx + s * car.vy;
      const into = vxw * n[0] + vzw * n[1];
      if (into < 0) {
        vxw -= 1.2 * into * n[0];
        vzw -= 1.2 * into * n[1];
        vxw *= 0.8; vzw *= 0.8;
        car.vx = -s * vxw - c * vzw;
        car.vy = -c * vxw + s * vzw;
        car.yawRate *= 0.5;
        hit = Math.max(hit, -into);
      }
    }
    return hit; // m/s of impact
  }

  // Places for trees: scattered over the parks (about one per 120 m², nearer
  // ones first), and along the sidewalks beside the circuit, `side` meters out.
  function treeSpots(points, side) {
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const spots = [];
    for (let i = 0; i < points.length; i += 4) {
      for (const s of [-1, 1]) {
        const a = points[i], b = points[(i + 1) % points.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const x = a[0] - ((b[1] - a[1]) / l) * side * s, z = a[1] + ((b[0] - a[0]) / l) * side * s;
        if (!buildingAt(x, z, 3.5) && !onStreet(x, z) && rand() < 0.6) spots.push([x, z]);
      }
    }
    const inParks = [];
    for (let i = 0; i < P.length; i += 6) {
      const [ax, az, bx, bz, cx, cz] = P.slice(i, i + 6);
      const area = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
      for (let k = area / 120 + rand(); k >= 1; k--) {
        let u = rand(), v = rand();
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        const x = ax + (bx - ax) * u + (cx - ax) * v, z = az + (bz - az) * u + (cz - az) * v;
        if (Math.hypot(x, z) < 1100 && !buildingAt(x, z, 3) && !onStreet(x, z)) inParks.push([x, z]);
      }
    }
    inParks.sort((p, q) => Math.hypot(...p) - Math.hypot(...q));
    return [...spots, ...inParks.slice(0, 1800)];
  }

  return {
    treeSpots,
    streets: street,
    parks: park,
    roofs,
    walls: [...groups.values()],
    // What's underfoot off the circuit: a street, a park's grass, or the sidewalks and plazas.
    surfaceAt: (x, z) => (onStreet(x, z) ? 'road' : inPark(x, z) ? 'grass' : 'sidewalk'),
    onStreet,
    inPark,
    buildingAt,
    collide,
  };
}

function segDist(x, z, a, b) {
  const ex = b[0] - a[0], ez = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez || 1)));
  return Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t);
}

function inTriangle(x, z, a, b, c) {
  const s = (p, q) => (q[0] - p[0]) * (z - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function inRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function ringDist(x, z, ring) {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, segDist(x, z, ring[i], ring[(i + 1) % ring.length]));
  return d;
}

// Nearest wall to a point inside a ring: how deep the point is and the wall's outward normal.
function nearestEdge(x, z, ring) {
  let best = { d: Infinity, n: [0, 0] };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const d = segDist(x, z, a, b), l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d < best.d && l > 1e-3) best = { d, n: [(b[1] - a[1]) / l, -(b[0] - a[0]) / l] };
  }
  return best;
}
