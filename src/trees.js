// Low-poly trees around the circuit or along the stage and the Nordschleife: pines (stacked cones) and round broadleaf
// trees (icosahedra). All trees are merged into a few meshes, one per color,
// so they cost a handful of draw calls. They grow in clumps, kept clear of the
// road, the sand traps, the signs and the paddock.

// Small seeded RNG so the forest is the same every visit.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mesh() { return { positions: [], normals: [] }; }

// Push a triangle, transformed by yaw + scale + translate.
function tri(m, T, ...verts) {
  for (const [p, n] of verts) {
    const [x, y, z] = p, c = Math.cos(T.yaw), s = Math.sin(T.yaw);
    m.positions.push(T.x + (c * x + s * z) * T.s, T.y + y * T.s * T.sy, T.z + (-s * x + c * z) * T.s);
    const nx = c * n[0] + s * n[2], nz = -s * n[0] + c * n[2], ny = n[1] / T.sy;
    const l = Math.hypot(nx, ny, nz);
    m.normals.push(nx / l, ny / l, nz / l);
  }
}

// Cone (or prism when r1 = r0) from y0 to y1, open at the bottom.
function cone(m, T, r0, r1, y0, y1, sides) {
  const slope = (r0 - r1) / (y1 - y0);
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
    const p = (a, r, y) => [Math.cos(a) * r, y, Math.sin(a) * r];
    const n = (a) => [Math.cos(a), slope, Math.sin(a)];
    tri(m, T, [p(a0, r0, y0), n(a0)], [p(a1, r1, y1), n(a1)], [p(a1, r0, y0), n(a1)]);
    tri(m, T, [p(a0, r0, y0), n(a0)], [p(a0, r1, y1), n(a0)], [p(a1, r1, y1), n(a1)]);
  }
}

// Icosahedron with flat faces, for a faceted crown.
const ICO = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((p) => p.map((c) => c / Math.hypot(1, t)));
  const f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  return f.map((idx) => idx.map((i) => v[i]));
})();

function blob(m, T, r, cy) {
  for (const [a, b, c] of ICO) {
    const n = [0, 1, 2].map((k) => a[k] + b[k] + c[k]);
    const p = (v) => [v[0] * r, cy + v[1] * r, v[2] * r];
    tri(m, T, [p(a), n], [p(c), n], [p(b), n]);
  }
}

// `clear(x, z)` says whether a tree may stand there; `height(x, z)` is the ground.
// `road` (stage only): centerline points and tangents to line with woods.
// `opts` (stage-style roads): how many trees at most, after how many tries,
// and `chunk`, a size (m) to split the forest into square pieces so far ones
// can be skipped when drawing (0: one piece).
export function buildTrees(clear, height, road = null, opts = {}) {
  const { count: most = 900, tries = 9000, chunk = 0 } = opts;
  const rand = rng(7);
  const pieces = new Map(); // chunk key -> meshes
  let trunks, pines, leaves, leavesLight;
  const pick = (x, z) => {
    const key = chunk ? `${Math.floor(x / chunk)},${Math.floor(z / chunk)}` : '0';
    if (!pieces.has(key)) {
      const [i, j] = key.split(',').map(Number);
      pieces.set(key, {
        trunks: mesh(), pines: mesh(), leaves: mesh(), leavesLight: mesh(),
        x: chunk ? (i + 0.5) * chunk : 0, z: chunk ? (j + 0.5) * chunk : 0, radius: chunk ? chunk * 0.75 : Infinity,
      });
    }
    ({ trunks, pines, leaves, leavesLight } = pieces.get(key));
  };
  const taken = new Map(); // coarse grid, keeps trees a few meters apart
  const cellOf = (x, z) => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
  const free = (x, z) => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (taken.has(cellOf(x + dx * 4, z + dz * 4))) return false;
    return true;
  };
  // Clumps: a smooth density field, so trees gather in woods with open fields between.
  const density = (x, z) => 0.5 + 0.5 * Math.sin(x / 31 + 1.3) * Math.cos(z / 27 - 0.4) + 0.25 * Math.sin((x - z) / 19);

  let count = 0;
  const plant = (x, z) => {
    pick(x, z);
    const T = { x, z, y: height(x, z) - 0.2, yaw: rand() * Math.PI * 2, s: 0.8 + rand() * 0.6, sy: 0.85 + rand() * 0.35 };
    if (rand() < 0.55) {
      cone(trunks, T, 0.28, 0.2, 0, 2, 5);
      cone(pines, T, 2.4, 0.9, 1.6, 5.2, 7);
      cone(pines, T, 1.8, 0, 4.2, 8.4, 7);
    } else {
      cone(trunks, T, 0.32, 0.24, 0, 3.2, 5);
      const crown = rand() < 0.5 ? leaves : leavesLight;
      blob(crown, T, 2.6, 4.6);
      blob(crown, { ...T, x: x + Math.cos(T.yaw) * 1.3 * T.s, z: z + Math.sin(T.yaw) * 1.3 * T.s }, 1.8, 3.9);
    }
    taken.set(cellOf(x, z), true);
    count++;
  };

  if (road) {
    // Stage: woods close along both sides of the road, gaps where the density dips.
    const { points, tangents } = road;
    for (let i = 0; i < tries && count < most; i++) {
      const k = Math.floor(rand() * points.length), [px, pz] = points[k], [tx, tz] = tangents[k];
      const off = (rand() < 0.5 ? -1 : 1) * (8 + rand() * rand() * 60);
      const x = px - tz * off, z = pz + tx * off;
      if (rand() > density(x, z) * 0.6 + 0.35 || !clear(x, z) || !free(x, z)) continue;
      plant(x, z);
    }
    return { pieces: [...pieces.values()], count };
  }

  // Around the circuit.
  for (let i = 0; i < 6000 && count < 340; i++) {
    const x = (rand() * 2 - 1) * 240, z = (rand() * 2 - 1) * 240;
    if (rand() > density(x, z) * 0.9 || !clear(x, z) || !free(x, z)) continue;
    plant(x, z);
  }
  // A sparser ring further out, so the horizon isn't bare.
  for (let i = 0; i < 3000 && count < 480; i++) {
    const a = rand() * Math.PI * 2, r = 250 + rand() * 180;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (rand() > density(x, z) || !free(x, z)) continue;
    plant(x, z);
  }
  return { pieces: [...pieces.values()], count };
}
