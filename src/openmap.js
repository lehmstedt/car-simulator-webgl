// Montreal from Verdun to downtown: an open map to drive around freely, no
// laps. Streets, buildings, trees and the river come from public map data
// (verdun.js). The ground is flat, so everything sits at height 0 (in truth
// downtown climbs ~50 m from the canal to Sherbrooke).
//
// - Streets are asphalt strips with round joins, so bends and crossings have
//   no gaps; the bigger ones have sidewalks and a yellow center line.
// - Buildings are their footprints pushed up to their height, with windows
//   drawn by the shader. The car can't drive through them.
// - The street bridges over the Lachine and aqueduct canals have railings.
// - The map ends at the river, the canals and, on land, a low concrete
//   barrier along its edge.

import { VERDUN } from './verdun.js';
import { ROAD_LIFT } from './track.js';

// Half widths (m) of the roadway by class, and sidewalk widths beside it.
const HALF = { primary: 7, secondary: 6.5, tertiary: 5.5, residential: 4.5, unclassified: 4, living_street: 3.5, service: 2.6, pedestrian: 3 };
const WALK = { primary: 2.5, secondary: 2.5, tertiary: 2.2, residential: 2, unclassified: 1.8 };
const CENTER_LINE = new Set(['primary', 'secondary', 'tertiary']);
const CHUNK = 300;   // m: buildings and trees come in square cells, made only when near
const CELL = 25;     // m: lookup grid for roads and buildings
// Brick colors of Verdun's plexes (red, brown, buff, grey stone), with weights.
export const BRICKS = [[[0.52, 0.24, 0.17], 4], [[0.42, 0.28, 0.2], 3], [[0.7, 0.6, 0.46], 2], [[0.58, 0.57, 0.55], 1]];

const decode = (b64) => {
  const bin = atob(b64), out = new Int16Array(bin.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16 >> 16;
  return out;
};
const key = (cx, cz) => cx * 100003 + cz;

export function buildOpenMap() {
  const U = VERDUN.unit;

  // --- roads -----------------------------------------------------------
  const roads = VERDUN.roads.map(([c, n, ...xy]) => {
    const cls = VERDUN.classes[c], pts = [];
    for (let i = 0; i < xy.length; i += 2) pts.push([xy[i] * U, xy[i + 1] * U]);
    return { cls, name: VERDUN.names[n], w: HALF[cls], walk: WALK[cls] ?? 0, pts };
  });
  // Segments by grid cell, for the nearest road.
  const segs = [], segCells = new Map();
  for (const r of roads) {
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const s = { a: r.pts[i], b: r.pts[i + 1], road: r }, reach = r.w + r.walk + 2;
      segs.push(s);
      const [ax, az] = s.a, [bx, bz] = s.b;
      for (let cx = Math.floor((Math.min(ax, bx) - reach) / CELL); cx <= Math.floor((Math.max(ax, bx) + reach) / CELL); cx++) {
        for (let cz = Math.floor((Math.min(az, bz) - reach) / CELL); cz <= Math.floor((Math.max(az, bz) + reach) / CELL); cz++) {
          const k = key(cx, cz);
          if (!segCells.has(k)) segCells.set(k, []);
          segCells.get(k).push(s);
        }
      }
    }
  }
  // Road ends shared by three or more pieces are crossings: center lines stop short of them.
  const ends = new Map(), endKey = ([x, z]) => `${Math.round(x)},${Math.round(z)}`;
  for (const r of roads) for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) ends.set(endKey(p), (ends.get(endKey(p)) ?? 0) + 1);
  const crossing = (p) => (ends.get(endKey(p)) ?? 0) >= 3;

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
  // Yellow center line on the bigger streets, stopping short of crossings.
  function centerLines() {
    const positions = [], normals = [], put = (x, z) => { positions.push(x, ROAD_LIFT + 0.02, z); normals.push(0, 1, 0); };
    for (const r of roads) {
      if (!CENTER_LINE.has(r.cls)) continue;
      const len = r.pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - r.pts[i - 1][0], p[1] - r.pts[i - 1][1]) : 0), 0);
      const from = crossing(r.pts[0]) ? 9 : 0, to = len - (crossing(r.pts[r.pts.length - 1]) ? 9 : 0);
      let s = 0;
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], l = Math.hypot(bx - ax, bz - az);
        const t0 = Math.max(0, (from - s) / l), t1 = Math.min(1, (to - s) / l);
        s += l;
        if (t1 <= t0) continue;
        const nx = (-(bz - az) / l) * 0.08, nz = ((bx - ax) / l) * 0.08;
        const px = ax + (bx - ax) * t0, pz = az + (bz - az) * t0, qx = ax + (bx - ax) * t1, qz = az + (bz - az) * t1;
        put(px + nx, pz + nz); put(px - nx, pz - nz); put(qx - nx, qz - nz);
        put(px + nx, pz + nz); put(qx - nx, qz - nz); put(qx + nx, qz + nz);
      }
    }
    fixWinding(positions);
    return { positions, normals };
  }

  // --- the area and its edge -------------------------------------------
  const area = [];
  for (let i = 0; i < VERDUN.area.length; i += 2) area.push([VERDUN.area[i] * U, VERDUN.area[i + 1] * U]);
  // Inside/outside mask in MASK-meter cells, filled row by row.
  const MASK = 3;
  const xs = area.map((p) => p[0]), zs = area.map((p) => p[1]);
  const mx0 = Math.min(...xs) - 4, mz0 = Math.min(...zs) - 4;
  const mnx = Math.ceil((Math.max(...xs) + 4 - mx0) / MASK), mnz = Math.ceil((Math.max(...zs) + 4 - mz0) / MASK);
  const mask = new Uint8Array(mnx * mnz);
  for (let j = 0; j < mnz; j++) {
    const z = mz0 + (j + 0.5) * MASK, hits = [];
    for (let i = 0; i < area.length; i++) {
      const [ax, az] = area[i], [bx, bz] = area[(i + 1) % area.length];
      if ((az <= z) !== (bz <= z)) hits.push(ax + ((z - az) / (bz - az)) * (bx - ax));
    }
    hits.sort((a, b) => a - b);
    for (let h = 0; h + 1 < hits.length; h += 2) {
      const i0 = Math.max(0, Math.ceil((hits[h] - mx0) / MASK - 0.5)), i1 = Math.min(mnx - 1, Math.floor((hits[h + 1] - mx0) / MASK - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * mnx + i] = 1;
    }
  }
  const inArea = (x, z) => {
    const i = Math.floor((x - mx0) / MASK), j = Math.floor((z - mz0) / MASK);
    return i >= 0 && j >= 0 && i < mnx && j < mnz && mask[j * mnx + i] === 1;
  };
  const areaEdges = area.map((a, i) => [a, area[(i + 1) % area.length]]);

  // Concrete barrier along the land edges: 0.6 m wide, 0.9 m tall.
  function barriers() {
    const positions = [], normals = [], H = 0.9, W = 0.3;
    const quad = (a, b, c, d, n) => { for (const p of [a, b, c, a, c, d]) { positions.push(...p); normals.push(...n); } };
    for (const line of VERDUN.walls) {
      for (let i = 0; i + 2 < line.length; i += 2) {
        const ax = line[i] * U, az = line[i + 1] * U, bx = line[i + 2] * U, bz = line[i + 3] * U;
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
  function waterMesh() {
    const t = decode(VERDUN.water), positions = [], normals = [];
    for (let i = 0; i < t.length; i += 2) { positions.push(t[i], 0.01, t[i + 1]); normals.push(0, 1, 0); }
    fixWinding(positions);
    return { positions, normals };
  }

  // --- buildings -------------------------------------------------------
  const raw = decode(VERDUN.buildings), buildings = [], bCells = new Map();
  for (let i = 0, id = 0; i < raw.length; id++) {
    const n = raw[i], h = raw[i + 1] / 10, ring = [];
    for (let k = 0; k < n; k++) ring.push([raw[i + 2 + 2 * k] * U, raw[i + 3 + 2 * k] * U]);
    i += 2 + 2 * n;
    // Clockwise in x/z (shoelace < 0), so walls and roofs face out and up.
    let s = 0;
    for (let k = 0; k < n; k++) { const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % n]; s += ax * bz - bx * az; }
    if (s > 0) ring.reverse();
    const bx = ring.map((p) => p[0]), bz = ring.map((p) => p[1]);
    const b = { ring, h, id, box: [Math.min(...bx), Math.max(...bx), Math.min(...bz), Math.max(...bz)] };
    buildings.push(b);
    for (let cx = Math.floor(b.box[0] / CELL); cx <= Math.floor(b.box[1] / CELL); cx++) {
      for (let cz = Math.floor(b.box[2] / CELL); cz <= Math.floor(b.box[3] / CELL); cz++) {
        const k = key(cx, cz);
        if (!bCells.has(k)) bCells.set(k, []);
        bCells.get(k).push(b);
      }
    }
  }
  const inside = (ring, x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[j];
      if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
    }
    return c;
  };
  const buildingAt = (x, z) => {
    for (const b of bCells.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? []) {
      if (x >= b.box[0] && x <= b.box[1] && z >= b.box[2] && z <= b.box[3] && inside(b.ring, x, z)) return b;
    }
    return null;
  };

  // The map in square cells of CHUNK meters, each with its buildings and trees
  // (filled in below). Their meshes are made by cellMeshes() when the car
  // comes near, so only the nearby ones take memory.
  const cellMap = new Map();
  const cellOf = (x, z) => {
    const i = Math.floor(x / CHUNK), j = Math.floor(z / CHUNK), k = key(i, j);
    if (!cellMap.has(k)) cellMap.set(k, { x: (i + 0.5) * CHUNK, z: (j + 0.5) * CHUNK, radius: CHUNK * 0.75, buildings: [], trees: [] });
    return cellMap.get(k);
  };
  for (const b of buildings) cellOf((b.box[0] + b.box[1]) / 2, (b.box[2] + b.box[3]) / 2).buildings.push(b);

  // A cell's building meshes: walls by brick color (plus plain sheds), roofs.
  // Wall UVs are meters along the wall and up it, for the shader's windows.
  function cellMeshes(cell) {
    const weights = BRICKS.reduce((s, [, w]) => s + w, 0);
    const c = {
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
    return c;
  }

  // --- trees -----------------------------------------------------------
  // The mapped trees, minus any on the asphalt or inside a building.
  const tr = decode(VERDUN.trees), trees = [];
  for (let i = 0; i < tr.length; i += 2) {
    const x = tr[i] * U, z = tr[i + 1] * U, r = nearestRoad(x, z);
    if ((r && r.edge < 0.6) || buildingAt(x, z)) continue;
    trees.push([x, z]);
    cellOf(x, z).trees.push([x, z]);
  }

  // Nearest road segment within reach of (x, z): distance past its roadway's
  // edge (< 0 on the asphalt) and the road.
  function nearestRoad(x, z) {
    let best = null;
    for (const s of segCells.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? []) {
      const [ax, az] = s.a, [bx, bz] = s.b, ex = bx - ax, ez = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
      const d = Math.hypot(x - ax - ex * t, z - az - ez * t), edge = d - s.road.w;
      if (!best || edge < best.edge) best = { edge, distance: d, road: s.road, tangent: [ex, ez] };
    }
    return best;
  }

  // Start: on Rue Wellington, Verdun's main street, by Rue de l'Église.
  const [sx, sz, sh] = VERDUN.start;

  return {
    open: true,
    closed: false,
    halfWidth: 4.5,
    edgeWidth: 2,
    signs: [],
    sections: null,
    grid: { x: sx, z: sz, tangent: [-Math.sin(sh), -Math.cos(sh)] },
    roads,
    area,
    water: decode(VERDUN.water), // triangles, x z x z x z

    buildings,
    trees,
    cells: [...cellMap.values()],
    cellMeshes,
    layers: [
      { mesh: waterMesh(), color: [0.2, 0.36, 0.45], mat: 'water' },
      { mesh: ribbons(roads, (r) => r.walk && r.w + r.walk, ROAD_LIFT * 0.6), color: [0.62, 0.62, 0.6], mat: 'concrete' },
      { mesh: ribbons(roads, (r) => r.w, ROAD_LIFT), color: [0.3, 0.31, 0.33], mat: 'asphalt' },
      { mesh: centerLines(), color: [0.95, 0.75, 0.15], mat: 'line', top: true },
    ],
    barriers: barriers(),
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
      if (!inArea(x, z)) edges = areaEdges;
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
