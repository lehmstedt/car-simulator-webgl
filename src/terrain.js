// Rolling hills: a smooth height field shared by the ground, the road and the
// car physics. Long wavelengths keep grades under ~14% and crests gentle enough
// that the car only goes light near top speed. Past the circuit the hills fade
// to flat, so the far ground can be a few big cells (cheap to draw on phones).

const HILLS = 200, FLAT = 250; // fade from hills to flat between these (m, square radius)

export function terrainHeight(x, z) {
  const r = Math.max(Math.abs(x), Math.abs(z));
  if (r >= FLAT) return 0;
  const t = Math.max(0, (r - HILLS) / (FLAT - HILLS));
  const fade = 1 - t * t * (3 - 2 * t);
  return fade * (
    6.0 * Math.sin(x / 55 + 0.6) * Math.cos(z / 62 - 0.3) +
    3.0 * Math.sin((x + z) / 47 + 1.7) +
    1.2 * Math.cos((x - 0.6 * z) / 40)
  );
}

// Height, gradient (gx = dh/dx, gz = dh/dz) and second derivatives at (x, z).
export function terrainSample(x, z) {
  const e = 0.5, f = terrainHeight;
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

export function terrainNormal(x, z) {
  const { gx, gz } = terrainSample(x, z);
  const l = Math.hypot(gx, 1, gz);
  return [-gx / l, 1 / l, -gz / l];
}

// Ground grid covering [-half, half]^2: cells of about `cell` meters over the
// hills, then a few wide cells out to the flat edge. Rows and columns share the
// same coordinates everywhere, so there are no cracks between the two.
export function terrainMesh(half, cell) {
  const fine = Math.ceil((2 * FLAT) / cell), coarse = 6;
  const axis = [];
  for (let i = 0; i < coarse; i++) axis.push(-half + ((half - FLAT) * i) / coarse);
  for (let i = 0; i <= fine; i++) axis.push(-FLAT + (2 * FLAT * i) / fine);
  for (let i = coarse - 1; i >= 0; i--) axis.push(half - ((half - FLAT) * i) / coarse);

  // Shared vertices + an index list: ~6x fewer vertices for the GPU to process.
  const n = axis.length, positions = [], normals = [], indices = [];
  for (const x of axis) {
    for (const z of axis) {
      positions.push(x, terrainHeight(x, z), z);
      normals.push(...terrainNormal(x, z));
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
