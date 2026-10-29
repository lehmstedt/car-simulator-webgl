// The island of Montreal: an open map to drive around freely, no laps.
// Streets, buildings, trees and the rivers come from public map data
// (montreal.js). The ground is flat, so everything sits at height 0 (in truth
// the island rises from the river to Mount Royal's 233 m).
//
// - Streets are asphalt strips with round joins, so bends and crossings have
//   no gaps; the bigger ones have sidewalks and a yellow center line.
// - Buildings are their footprints pushed up to their height, with windows
//   drawn by the shader. The car can't drive through them.
// - The street bridges over the canals and to Île Bizard have railings.
// - The map ends at the shore and, on land, a low concrete barrier.
// - The whole island is ~500 km², so it is kept packed: streets are unpacked
//   once (~185,000 pieces), but buildings and trees only for the CHUNK-meter
//   cells near the car, and the meshes are made per cell when it comes near
//   (see main.js, streamCells).

import { MONTREAL } from './montreal.js';
import { ROAD_LIFT } from './track.js';

// Half widths (m) of the roadway by class, and sidewalk widths beside it.
const HALF = { primary: 7, secondary: 6.5, tertiary: 5.5, residential: 4.5, unclassified: 4, living_street: 3.5, service: 2.6, pedestrian: 3 };
const WALK = { primary: 2.5, secondary: 2.5, tertiary: 2.2, residential: 2, unclassified: 1.8 };
const MAIN = new Set(['primary', 'secondary', 'tertiary']);
const SIDE = new Set(['residential', 'unclassified']);
// One-way side streets are narrower: a lane and parking.
const ONE_WAY_HALF = 3.6;
const CHUNK = MONTREAL.chunk; // m: the cells the map is stored and drawn in
const CELL = 25;     // m: lookup grid for roads and buildings (CHUNK is a multiple)
const KEEP_CELLS = 600; // cells whose buildings and trees stay unpacked
const AREA_ROW = 2;     // m: rows of the area's inside/outside lookup
// Brick colors of Montreal's plexes (red, brown, buff, grey stone), with weights.
export const BRICKS = [[[0.52, 0.24, 0.17], 4], [[0.42, 0.28, 0.2], 3], [[0.7, 0.6, 0.46], 2], [[0.58, 0.57, 0.55], 1]];

const key = (cx, cz) => cx * 100003 + cz;
// Crossings: road ends at the same spot (to the meter) are the same node.
export const nodeKey = ([x, z]) => (Math.round(x) + 50000) * 100000 + Math.round(z) + 50000;

// Zigzag varints, as packed by scripts/montreal.py.
class Reader {
  constructor(bytes) { this.b = bytes; this.p = 0; }
  u() {
    let v = 0, s = 0, c;
    do { c = this.b[this.p++]; v += (c & 127) * 2 ** s; s += 7; } while (c & 128);
    return v;
  }
  s() { const v = this.u(); return v % 2 ? -(v + 1) / 2 : v / 2; }
  // n points: the first from (x, z) (in steps), then steps; in meters.
  line(n, x = 0, z = 0) {
    const U = MONTREAL.unit, out = [];
    for (let i = 0; i < n; i++) { x += this.s(); z += this.s(); out.push([x * U, z * U]); }
    return out;
  }
}

// Unpacks the map data (base64, deflated): call once before buildOpenMap().
let packed = null;
export async function loadOpenMap() {
  if (packed) return packed;
  const bin = atob(MONTREAL.data), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const out = {};
  let o = 0;
  for (const [name, len] of Object.entries(MONTREAL.sections)) { out[name] = raw.subarray(o, o + len); o += len; }
  return (packed = out);
}

export function buildOpenMap() {
  if (!packed) throw new Error('loadOpenMap() first');
  const D = packed, U = MONTREAL.unit;
  const mid = (i) => Math.round(((i + 0.5) * CHUNK) / U); // a cell's middle, in steps

  // --- cells and roads -------------------------------------------------
  const cells = [], cellMap = new Map(), roads = [];
  const roadIndex = new Map(); // chunk -> roads within reach of it
  const index = (map, item, x0, x1, z0, z1, size) => {
    for (let i = Math.floor(x0 / size); i <= Math.floor(x1 / size); i++) {
      for (let j = Math.floor(z0 / size); j <= Math.floor(z1 / size); j++) {
        const k = key(i, j);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(item);
      }
    }
  };
  {
    const cr = new Reader(D.cells), rr = new Reader(D.roads);
    let bo = 0, to = 0;
    for (let n = cr.u(), q = 0; q < n; q++) {
      const i = cr.s(), j = cr.s(), nr = cr.u(), nb = cr.u(), bl = cr.u(), nt = cr.u(), tl = cr.u();
      const cell = {
        i, j, x: (i + 0.5) * CHUNK, z: (j + 0.5) * CHUNK, radius: CHUNK * 0.75, roads: [],
        nb, bytes: [bo, bo + bl], nt, treeBytes: [to, to + tl], buildings: null, grid: null, trees: null,
      };
      bo += bl; to += tl;
      cells.push(cell);
      cellMap.set(key(i, j), cell);
      for (let r = 0; r < nr; r++) {
        const c = rr.u(), nm = rr.u(), f = rr.u(), pts = rr.line(rr.u(), mid(i), mid(j));
        const cls = MONTREAL.classes[c], oneWay = !!(f & 1);
        const w = oneWay && SIDE.has(cls) ? ONE_WAY_HALF : HALF[cls];
        // (a, b: its end nodes, and lanes: set by the traffic; clear: by the paint below.)
        const road = {
          index: roads.length, cls, name: MONTREAL.names[nm], w, walk: WALK[cls] ?? 0, pts, oneWay, cars: !(f & 2) && cls !== 'pedestrian',
          box: null, clear: null, a: null, b: null, lanes: null,
        };
        roads.push(road);
        cell.roads.push(road);
        const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]), reach = road.w + road.walk + 2;
        road.box = [Math.min(...xs) - reach, Math.max(...xs) + reach, Math.min(...zs) - reach, Math.max(...zs) + reach];
        index(roadIndex, road, ...road.box, CHUNK);
        for (const [x, z] of pts) cell.radius = Math.max(cell.radius, Math.hypot(x - cell.x, z - cell.z) + reach);
      }
    }
  }
  // Segments by CELL-meter square, for the nearest road: made per chunk when first needed.
  const segGrids = new Map();
  function segGrid(ci, cj) {
    const k = key(ci, cj);
    let g = segGrids.get(k);
    if (g) return g;
    g = new Map();
    const lo = ci * (CHUNK / CELL), hi = lo + CHUNK / CELL - 1, lz = cj * (CHUNK / CELL), hz = lz + CHUNK / CELL - 1;
    for (const r of roadIndex.get(k) ?? []) {
      const reach = r.w + r.walk + 2;
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const s = { a: r.pts[i], b: r.pts[i + 1], road: r }, [ax, az] = s.a, [bx, bz] = s.b;
        const x0 = Math.max(lo, Math.floor((Math.min(ax, bx) - reach) / CELL)), x1 = Math.min(hi, Math.floor((Math.max(ax, bx) + reach) / CELL));
        const z0 = Math.max(lz, Math.floor((Math.min(az, bz) - reach) / CELL)), z1 = Math.min(hz, Math.floor((Math.max(az, bz) + reach) / CELL));
        for (let cx = x0; cx <= x1; cx++) {
          for (let cz = z0; cz <= z1; cz++) {
            const c = key(cx, cz);
            if (!g.has(c)) g.set(c, []);
            g.get(c).push(s);
          }
        }
      }
    }
    segGrids.set(k, g);
    return g;
  }
  // Nearest road segment within reach of (x, z): distance past its roadway's
  // edge (< 0 on the asphalt) and the road.
  function nearestRoad(x, z) {
    let best = null;
    const g = segGrid(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
    for (const s of g.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? []) {
      const [ax, az] = s.a, [bx, bz] = s.b, ex = bx - ax, ez = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
      const d = Math.hypot(x - ax - ex * t, z - az - ez * t), edge = d - s.road.w;
      if (!best || edge < best.edge) best = { edge, distance: d, road: s.road, tangent: [ex, ez] };
    }
    return best;
  }
  // Road ends shared by three or more pieces are crossings: lines stop short
  // of them, by the half width of the widest other street there.
  {
    const ends = new Map();
    for (const r of roads) for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) {
      const k = nodeKey(p);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(r);
    }
    const clearance = (p, r) => {
      const at = ends.get(nodeKey(p));
      return at.length < 3 ? 0 : Math.max(...at.map((o) => (o === r ? 0 : o.w))) + 1;
    };
    for (const r of roads) r.clear = [clearance(r.pts[0], r), clearance(r.pts[r.pts.length - 1], r)];
  }

  // --- traffic control -------------------------------------------------
  const signals = [], stops = new Set();
  {
    const r = new Reader(D.signals);
    let x = 0, z = 0;
    for (let n = r.u(), i = 0; i < n; i++) {
      x += r.s(); z += r.s();
      signals.push({ x: x * U, z: z * U, axis: r.s() / 1000, group: r.u() });
    }
    const s = new Reader(D.stops);
    let e = 0;
    for (let n = s.u(), i = 0; i < n; i++) stops.add((e += s.u()));
  }

  // --- the area and its edge -------------------------------------------
  // Rings: the shore, then lakes and canals (holes). Inside or not: crossings
  // of the rings with rows AREA_ROW m apart, counted left of the point.
  const area = [];
  {
    const r = new Reader(D.area);
    for (let n = r.u(), i = 0; i < n; i++) area.push(r.line(r.u()));
  }
  const areaEdges = area.flatMap((ring) => ring.map((a, i) => [a, ring[(i + 1) % ring.length]]));
  const zs = area[0].map((p) => p[1]), rowZ = Math.min(...zs) - AREA_ROW, nRows = Math.ceil((Math.max(...zs) - rowZ) / AREA_ROW) + 2;
  const rowHits = Array.from({ length: nRows }, () => []);
  for (const [[ax, az], [bx, bz]] of areaEdges) {
    if (az === bz) continue;
    const j0 = Math.max(0, Math.ceil((Math.min(az, bz) - rowZ) / AREA_ROW - 0.5)), j1 = Math.min(nRows - 1, Math.floor((Math.max(az, bz) - rowZ) / AREA_ROW - 0.5));
    for (let j = j0; j <= j1; j++) {
      const z = rowZ + (j + 0.5) * AREA_ROW;
      if ((az <= z) !== (bz <= z)) rowHits[j].push(ax + ((z - az) / (bz - az)) * (bx - ax));
    }
  }
  const rows = rowHits.map((h) => Float64Array.from(h.sort((a, b) => a - b)));
  const inArea = (x, z) => {
    const row = rows[Math.floor((z - rowZ) / AREA_ROW)];
    if (!row) return false;
    let lo = 0, hi = row.length; // crossings left of x
    while (lo < hi) { const m = (lo + hi) >> 1; if (row[m] < x) lo = m + 1; else hi = m; }
    return lo % 2 === 1;
  };
  // The area's edges by chunk, for the way back in.
  const edgeIndex = new Map();
  for (const e of areaEdges) {
    const [[ax, az], [bx, bz]] = e;
    index(edgeIndex, e, Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz), CHUNK);
  }
  const edgesNear = (x, z) => {
    const out = [], ci = Math.floor(x / CHUNK), cj = Math.floor(z / CHUNK);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) out.push(...(edgeIndex.get(key(i, j)) ?? []));
    return out.length ? out : areaEdges;
  };
  const walls = [];
  {
    const r = new Reader(D.walls);
    for (let n = r.u(), i = 0; i < n; i++) walls.push(r.line(r.u()));
  }

  // Concrete barrier along the land edges: 0.6 m wide, 0.9 m tall.
  function barriers() {
    const positions = [], normals = [], H = 0.9, W = 0.3;
    const quad = (a, b, c, d, n) => { for (const p of [a, b, c, a, c, d]) { positions.push(...p); normals.push(...n); } };
    for (const line of walls) {
      for (let i = 0; i + 1 < line.length; i++) {
        const [ax, az] = line[i], [bx, bz] = line[i + 1];
        const l = Math.hypot(bx - ax, bz - az);
        if (l < 0.01) continue;
        const nx = -(bz - az) / l, nz = (bx - ax) / l;
        const P = (x, z, s, y) => [x + nx * W * s, y, z + nz * W * s];
        quad(P(ax, az, 1, 0), P(bx, bz, 1, 0), P(bx, bz, 1, H), P(ax, az, 1, H), [nx, 0, nz]);
        quad(P(bx, bz, -1, 0), P(ax, az, -1, 0), P(ax, az, -1, H), P(bx, bz, -1, H), [-nx, 0, -nz]);
        quad(P(ax, az, 1, H), P(bx, bz, 1, H), P(bx, bz, -1, H), P(ax, az, -1, H), [0, 1, 0]);
      }
    }
    fixWinding(positions, normals);
    return { positions, normals };
  }

  // --- water -----------------------------------------------------------
  const water = (() => {
    const r = new Reader(D.water), n = r.u(), out = new Float32Array(2 * n);
    let x = 0, z = 0;
    for (let i = 0; i < n; i++) { x += r.s(); z += r.s(); out[2 * i] = x; out[2 * i + 1] = z; }
    return out; // triangles, x z x z x z, in whole meters
  })();
  function waterMesh() {
    const positions = [], normals = [];
    for (let i = 0; i < water.length; i += 2) { positions.push(water[i], 0.01, water[i + 1]); normals.push(0, 1, 0); }
    fixWinding(positions);
    return { positions, normals };
  }

  // --- buildings and trees, unpacked per cell --------------------------
  const unpacked = new Set(); // cells with buildings unpacked, least recently used first
  function unpack(cell) {
    if (cell.buildings) {
      unpacked.delete(cell); unpacked.add(cell);
      return cell;
    }
    const r = new Reader(D.buildings.subarray(...cell.bytes));
    let px = mid(cell.i), pz = mid(cell.j);
    cell.buildings = [];
    cell.grid = new Map();
    for (let q = 0; q < cell.nb; q++) {
      const n = r.u(), h = r.u() / 10, ring = r.line(n, px, pz);
      px = Math.round(ring[0][0] / U); pz = Math.round(ring[0][1] / U);
      // Clockwise in x/z (shoelace < 0), so walls and roofs face out and up.
      let s = 0;
      for (let k = 0; k < n; k++) { const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % n]; s += ax * bz - bx * az; }
      if (s > 0) ring.reverse();
      const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
      // A stable id, for its color.
      const b = { ring, h, id: ((cell.i * 7919 + cell.j) * 4099 + q) >>> 0, box: [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)] };
      cell.buildings.push(b);
      index(cell.grid, b, ...b.box, CELL);
      for (const [x, z] of ring) cell.radius = Math.max(cell.radius, Math.hypot(x - cell.x, z - cell.z));
    }
    unpacked.add(cell);
    // Keep memory in check: pack away the least recently used (they unpack again when needed).
    for (const c of unpacked) {
      if (unpacked.size <= KEEP_CELLS) break;
      unpacked.delete(c);
      c.buildings = c.grid = c.trees = null;
    }
    return cell;
  }
  const inside = (ring, x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[j];
      if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
    }
    return c;
  };
  // The building at (x, z): buildings are stored in the cell of their middle,
  // so look in this cell and its neighbors.
  const buildingAt = (x, z) => {
    const ci = Math.floor(x / CHUNK), cj = Math.floor(z / CHUNK), k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        const cell = cellMap.get(key(i, j));
        if (!cell || !cell.nb) continue;
        for (const b of unpack(cell).grid.get(k) ?? []) {
          if (x >= b.box[0] && x <= b.box[1] && z >= b.box[2] && z <= b.box[3] && inside(b.ring, x, z)) return b;
        }
      }
    }
    return null;
  };
  // A cell's mapped trees, minus any on the asphalt or inside a building.
  function treesOf(cell) {
    unpack(cell);
    if (cell.trees) return cell.trees;
    const r = new Reader(D.trees.subarray(...cell.treeBytes)), spots = r.line(cell.nt, mid(cell.i), mid(cell.j));
    const trees = spots.filter(([x, z]) => {
      const n = nearestRoad(x, z);
      return !(n && n.edge < 0.6) && !buildingAt(x, z);
    });
    unpack(cell); // buildingAt may have packed it away
    return (cell.trees = trees);
  }

  // --- meshes ----------------------------------------------------------
  // Asphalt (or sidewalk) along each road: a quad per segment and a disc at
  // every point, so bends and crossings are filled.
  function ribbons(list, half, lift) {
    const positions = [], normals = [], put = (x, z) => { positions.push(x, lift, z); normals.push(0, 1, 0); };
    for (const r of list) {
      const w = half(r);
      if (!w) continue;
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], l = Math.hypot(bx - ax, bz - az) || 1;
        const nx = (-(bz - az) / l) * w, nz = ((bx - ax) / l) * w;
        // Counter-clockwise seen from above.
        put(ax + nx, az + nz); put(ax - nx, az - nz); put(bx - nx, bz - nz);
        put(ax + nx, az + nz); put(bx - nx, bz - nz); put(bx + nx, bz + nz);
      }
      for (const [x, z] of r.pts) {
        const n = w > 4 ? 12 : 8;
        for (let k = 0; k < n; k++) {
          const a0 = (k / n) * 2 * Math.PI, a1 = ((k + 1) / n) * 2 * Math.PI;
          put(x, z); put(x + Math.cos(a1) * w, z + Math.sin(a1) * w); put(x + Math.cos(a0) * w, z + Math.sin(a0) * w);
        }
      }
    }
    fixWinding(positions);
    return { positions, normals };
  }
  // Road paint, on streets wide enough for it (narrow side streets, mostly
  // one-way, have none): a double yellow line down two-way main streets, a
  // dashed yellow one down two-way side streets, and dashed white lines between
  // the lanes of one-way main streets. Lines stop short of crossings.
  function roadLines(list) {
    const yellow = { positions: [], normals: [] }, white = { positions: [], normals: [] };
    // A strip `half` wide, `off` m right of the road's line, dashed if `dash` ([on, off] m).
    const strip = (m, r, off, half, dash) => {
      const put = (x, z) => { m.positions.push(x, ROAD_LIFT + 0.02, z); m.normals.push(0, 1, 0); };
      const len = r.pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - r.pts[i - 1][0], p[1] - r.pts[i - 1][1]) : 0), 0);
      const from = r.clear[0], to = len - r.clear[1];
      let s = 0;
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], l = Math.hypot(bx - ax, bz - az);
        if (l < 1e-3) continue;
        const ux = (bx - ax) / l, uz = (bz - az) / l, rx = -uz, rz = ux; // along, right
        // Pieces of this segment: the whole of it, or its dashes.
        const spans = [];
        if (!dash) spans.push([Math.max(from, s), Math.min(to, s + l)]);
        else {
          const period = dash[0] + dash[1];
          for (let d = Math.floor(Math.max(from, s) / period) * period; d < Math.min(to, s + l); d += period) {
            spans.push([Math.max(d, from, s), Math.min(d + dash[0], to, s + l)]);
          }
        }
        for (const [d0, d1] of spans) {
          if (d1 - d0 < 0.05) continue;
          const px = ax + ux * (d0 - s) + rx * off, pz = az + uz * (d0 - s) + rz * off;
          const qx = ax + ux * (d1 - s) + rx * off, qz = az + uz * (d1 - s) + rz * off;
          const nx = rx * half, nz = rz * half;
          put(px + nx, pz + nz); put(px - nx, pz - nz); put(qx - nx, qz - nz);
          put(px + nx, pz + nz); put(qx - nx, qz - nz); put(qx + nx, qz + nz);
        }
        s += l;
      }
    };
    for (const r of list) {
      if (!r.cars) continue;
      if (MAIN.has(r.cls) && !r.oneWay) { strip(yellow, r, -0.13, 0.06); strip(yellow, r, 0.13, 0.06); }
      else if (SIDE.has(r.cls) && !r.oneWay) strip(yellow, r, 0, 0.06, [3, 5]);
      else if (MAIN.has(r.cls)) {
        const lanes = Math.max(2, Math.floor((2 * r.w) / 3.6));
        for (let k = 1; k < lanes; k++) strip(white, r, -r.w + (2 * r.w * k) / lanes, 0.06, [3, 6]);
      }
    }
    fixWinding(yellow.positions);
    fixWinding(white.positions);
    return { yellow, white };
  }

  // A cell's meshes: its streets (sidewalks, asphalt, paint), buildings (walls
  // by brick color, plus glass towers and plain sheds, and roofs) and the
  // spots of its trees. Wall UVs are meters along the wall and up it, for the
  // shader's windows.
  function cellMeshes(cell) {
    unpack(cell);
    const weights = BRICKS.reduce((s, [, w]) => s + w, 0);
    const lines = roadLines(cell.roads);
    const c = {
      walk: ribbons(cell.roads, (r) => r.walk && r.w + r.walk, ROAD_LIFT * 0.6),
      asphalt: ribbons(cell.roads, (r) => r.w, ROAD_LIFT),
      yellow: lines.yellow, white: lines.white,
      walls: BRICKS.map(() => ({ positions: [], normals: [], uvs: [] })),
      towers: { positions: [], normals: [], uvs: [] }, // glass, 35 m and up
      sheds: { positions: [], normals: [] }, roofs: { positions: [], normals: [] },
    };
    for (const b of cell.buildings) {
      // A stable pick per building.
      let r = ((b.id * 2654435761) >>> 0) / 4294967296 * weights, color = 0;
      while (r >= BRICKS[color][1]) r -= BRICKS[color++][1];
      const shed = b.h < 4.5;
      const m = shed ? c.sheds : b.h >= 35 ? c.towers : c.walls[color];
      const n = b.ring.length;
      let u = 0;
      for (let i = 0; i < n; i++) {
        const [ax, az] = b.ring[i], [bx, bz] = b.ring[(i + 1) % n], l = Math.hypot(bx - ax, bz - az);
        if (l < 1e-3) continue;
        const nx = -(bz - az) / l, nz = (bx - ax) / l; // outward for a clockwise ring
        const v = [[ax, 0, az, u, 0], [bx, 0, bz, u + l, 0], [bx, b.h, bz, u + l, b.h], [ax, b.h, az, u, b.h]];
        for (const q of [0, 1, 2, 0, 2, 3]) {
          m.positions.push(v[q][0], v[q][1], v[q][2]);
          m.normals.push(nx, 0, nz);
          m.uvs?.push(v[q][3], v[q][4]);
        }
        u += l;
      }
      for (const tri of earClip(b.ring)) {
        for (const i of tri) { c.roofs.positions.push(b.ring[i][0], b.h, b.ring[i][1]); c.roofs.normals.push(0, 1, 0); }
      }
    }
    for (const m of [...c.walls, c.towers, c.sheds]) fixWinding(m.positions, m.normals);
    fixWinding(c.roofs.positions);
    c.trees = treesOf(cell);
    return c;
  }

  // Cells around (x, z), within r m (by their middle).
  const cellsNear = (x, z, r) => {
    const out = [];
    for (let i = Math.floor((x - r) / CHUNK); i <= Math.floor((x + r) / CHUNK); i++) {
      for (let j = Math.floor((z - r) / CHUNK); j <= Math.floor((z + r) / CHUNK); j++) {
        const c = cellMap.get(key(i, j));
        if (c) out.push(c);
      }
    }
    return out;
  };

  // Start: on Rue Wellington, Verdun's main street, by Rue de l'Église.
  const [sx, sz, sh] = MONTREAL.start;

  return {
    open: true,
    closed: false,
    halfWidth: 4.5,
    edgeWidth: 2,
    signs: [],
    sections: null,
    grid: { x: sx, z: sz, tangent: [-Math.sin(sh), -Math.cos(sh)] },
    roads,
    signals,
    stops,
    area,
    water,
    cells,
    cellMeshes,
    layers: [{ mesh: waterMesh(), color: [0.2, 0.36, 0.45], mat: 'water' }],
    barriers: barriers(),
    // Car roads with a piece within r m of (x, z) (by cell).
    roadsNear: (x, z, r) => cellsNear(x, z, r + CHUNK).flatMap((c) => c.roads),
    // For the minimap: buildings and roads touching a box.
    buildingsIn(x0, x1, z0, z1) {
      const out = [];
      for (const c of cellsNear((x0 + x1) / 2, (z0 + z1) / 2, Math.max(x1 - x0, z1 - z0) / 2 + CHUNK)) {
        if (!c.nb) continue;
        for (const b of unpack(c).buildings) if (b.box[1] >= x0 && b.box[0] <= x1 && b.box[3] >= z0 && b.box[2] <= z1) out.push(b);
      }
      return out;
    },
    roadsIn(x0, x1, z0, z1) {
      const out = new Set();
      for (let i = Math.floor(x0 / CHUNK); i <= Math.floor(x1 / CHUNK); i++) {
        for (let j = Math.floor(z0 / CHUNK); j <= Math.floor(z1 / CHUNK); j++) {
          for (const r of roadIndex.get(key(i, j)) ?? []) if (r.box[1] >= x0 && r.box[0] <= x1 && r.box[3] >= z0 && r.box[2] <= z1) out.add(r);
        }
      }
      return [...out];
    },
    // What's underfoot at (x, z): roadway and sidewalk drive as road, the rest is grass.
    // `name` is the street's, when on or beside one.
    locate(x, z) {
      const r = nearestRoad(x, z);
      const onTrack = !!r && r.edge <= r.road.walk + 0.3;
      return { distance: r ? r.distance : Infinity, along: 0, index: 0, onTrack, surface: onTrack ? 'road' : null, sand: false, sandEdge: 0, name: r && r.edge < r.road.walk + 6 ? r.road.name : '' };
    },
    sausageHeight: () => 0,
    // Whether (x, z) is inside a building or off the map, and if so the way
    // out: the unit push direction (nx, nz) and how far (depth).
    blocked(x, z) {
      let edges = null;
      if (!inArea(x, z)) edges = edgesNear(x, z);
      else {
        const b = buildingAt(x, z);
        if (b) edges = b.ring.map((a, i) => [a, b.ring[(i + 1) % b.ring.length]]);
      }
      if (!edges) return null;
      let best = Infinity, qx = x, qz = z;
      for (const [[ax, az], [bx, bz]] of edges) {
        const ex = bx - ax, ez = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
        const px = ax + ex * t, pz = az + ez * t, d = Math.hypot(px - x, pz - z);
        if (d < best) { best = d; qx = px; qz = pz; }
      }
      const d = Math.max(best, 1e-6);
      return { nx: (qx - x) / d, nz: (qz - z) / d, depth: best };
    },
  };
}

// Flips triangles (in place) whose winding faces down, so all face up / out
// of a clockwise-in-x/z layout; `normals` (optional) picks the side.
function fixWinding(p, normals = null) {
  for (let i = 0; i < p.length; i += 9) {
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
    const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const want = normals ? [normals[i], normals[i + 1], normals[i + 2]] : [0, 1, 0];
    if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) {
      for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
    }
  }
}

// Triangles of a simple polygon (index triples), by ear clipping.
function earClip(ring) {
  const n = ring.length, idx = [...Array(n).keys()], out = [];
  // Orientation of the ring, so convex corners can be told from reflex ones.
  let s = 0;
  for (let i = 0; i < n; i++) s += ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1];
  const sign = Math.sign(s) || 1;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) => cross(a, b, p) * sign >= 0 && cross(b, c, p) * sign >= 0 && cross(c, a, p) * sign >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 5000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[(k - 1 + idx.length) % idx.length], j = idx[k], l = idx[(k + 1) % idx.length];
      const a = ring[i], b = ring[j], c = ring[l];
      if (cross(a, b, c) * sign <= 0) continue; // reflex
      if (idx.some((m) => m !== i && m !== j && m !== l && inTri(ring[m], a, b, c))) continue;
      out.push([i, j, l]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break; // degenerate: give up on the rest
  }
  if (idx.length === 3) out.push(idx);
  return out;
}
