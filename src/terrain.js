// Rolling hills: a smooth height field shared by the ground, the road and the
// car physics. Long wavelengths keep grades under ~14% and crests gentle enough
// that the car only goes light near top speed.

export function terrainHeight(x, z) {
  return (
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

// Ground grid covering [-half, half]^2 with cells of `cell` meters.
export function terrainMesh(half, cell) {
  const n = Math.round((2 * half) / cell);
  const positions = [], normals = [];
  const vert = (i, j) => {
    const x = -half + i * cell, z = -half + j * cell;
    positions.push(x, terrainHeight(x, z), z);
    normals.push(...terrainNormal(x, z));
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // Counter-clockwise seen from above.
      for (const [a, b] of [[0, 0], [0, 1], [1, 1], [0, 0], [1, 1], [1, 0]]) vert(i + a, j + b);
    }
  }
  return { positions, normals };
}
