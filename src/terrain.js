// Rolling hills: a smooth height field shared by the ground, the road and the
// car physics. Long wavelengths keep grades under ~14% and crests gentle enough
// that the car only goes light near top speed. Past the circuit the hills fade
// to flat, so the far ground can be a few big cells (cheap to draw on phones).
//
// Beside the start straight the ground is levelled across the track for the
// paddock: there it keeps the straight's own height, so the road is unchanged.
//
// The rally stage (track.js) has its own, wider ground: a long valley wave on
// top of the same rolling hills, and no paddock levelling. Its road also has
// bumps (track.js registers them with setRoadBumps): they raise the road only,
// so the physics and the road mesh feel them but the ground mesh does not.

// hills / flat: fade from hills to flat between these (m, square radius).
const LANDS = {
  circuit: { hills: 200, flat: 250, valley: 0, level: { x0: -55, x1: 60, z0: 118, z1: 172, ref: 121, blend: 40 } },
  stage: { hills: 470, flat: 530, valley: 7, level: null },
};
let land = LANDS.circuit;
let bumps = null; // (x, z) -> extra height (m, >= 0) on the road, or null

// Picks the ground for a layout ('circuit' or 'stage'); call before building anything on it.
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
  const h = hills(x, z);
  const L = land.level;
  if (!L) return h;
  const dx = Math.max(L.x0 - x, 0, x - L.x1), dz = Math.max(L.z0 - z, 0, z - L.z1);
  const t = Math.min(1, Math.hypot(dx, dz) / L.blend);
  if (t >= 1) return h;
  const w = 1 - t * t * t * (t * (6 * t - 15) + 10); // smootherstep: no kink in the curvature
  return h + (hills(x, L.ref) - h) * w;
}

function hills(x, z) {
  const r = Math.max(Math.abs(x), Math.abs(z));
  if (r >= land.flat) return 0;
  const t = Math.max(0, (r - land.hills) / (land.flat - land.hills));
  const fade = 1 - t * t * (3 - 2 * t);
  return fade * (
    6.0 * Math.sin(x / 55 + 0.6) * Math.cos(z / 62 - 0.3) +
    3.0 * Math.sin((x + z) / 47 + 1.7) +
    1.2 * Math.cos((x - 0.6 * z) / 40) +
    land.valley * Math.sin(x / 140 + 0.4) * Math.cos(z / 120 - 1.1)
  );
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

export function terrainNormal(x, z, f = terrainHeight) {
  const { gx, gz } = terrainSample(x, z, f);
  const l = Math.hypot(gx, 1, gz);
  return [-gx / l, 1 / l, -gz / l];
}

// Ground grid covering [-half, half]^2: cells of about `cell` meters over the
// hills, then a few wide cells out to the flat edge. Rows and columns share the
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
