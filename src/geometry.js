// Procedural geometry. All meshes are non-indexed triangle lists.
// The circuit's own geometry lives in track.js.

// Unit cube centered at origin (size 1).
export function cube() {
  const faces = [
    // normal, then 4 corners (counter-clockwise from outside)
    [[ 1, 0, 0], [[ .5,-.5, .5], [ .5,-.5,-.5], [ .5, .5,-.5], [ .5, .5, .5]]],
    [[-1, 0, 0], [[-.5,-.5,-.5], [-.5,-.5, .5], [-.5, .5, .5], [-.5, .5,-.5]]],
    [[ 0, 1, 0], [[-.5, .5, .5], [ .5, .5, .5], [ .5, .5,-.5], [-.5, .5,-.5]]],
    [[ 0,-1, 0], [[-.5,-.5,-.5], [ .5,-.5,-.5], [ .5,-.5, .5], [-.5,-.5, .5]]],
    [[ 0, 0, 1], [[-.5,-.5, .5], [ .5,-.5, .5], [ .5, .5, .5], [-.5, .5, .5]]],
    [[ 0, 0,-1], [[ .5,-.5,-.5], [-.5,-.5,-.5], [-.5, .5,-.5], [ .5, .5,-.5]]],
  ];
  const positions = [], normals = [];
  for (const [n, [a, b, c, d]] of faces) {
    for (const v of [a, b, c, a, c, d]) {
      positions.push(...v);
      normals.push(...n);
    }
  }
  return { positions, normals };
}

// Flat ground quad of given half-size, at y = 0.
export function plane(half) {
  const h = half;
  const positions = [-h,0,-h,  -h,0,h,  h,0,h,  -h,0,-h,  h,0,h,  h,0,-h];
  const normals = Array(6).fill([0, 1, 0]).flat();
  return { positions, normals };
}

// Torus in the XY plane (axis along z): ring radius R, tube radius r.
export function torus(R, r, segs = 32, sides = 8) {
  const positions = [], normals = [];
  const vert = (i, j) => {
    const u = (i / segs) * Math.PI * 2, v = (j / sides) * Math.PI * 2;
    const n = [Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v)];
    positions.push(R * Math.cos(u) + r * n[0], R * Math.sin(u) + r * n[1], r * n[2]);
    normals.push(...n);
  };
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < sides; j++) {
      for (const [a, b] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]]) vert(a, b);
    }
  }
  return { positions, normals };
}

// Closed cylinder along x (a wheel): diameter 1, width 1, centered at origin.
export function cylinder(segs = 24) {
  const positions = [], normals = [];
  const p = (i) => { const a = (i / segs) * Math.PI * 2; return [Math.cos(a) * 0.5, Math.sin(a) * 0.5]; };
  for (let i = 0; i < segs; i++) {
    const [y0, z0] = p(i), [y1, z1] = p(i + 1);
    const n0 = [0, y0 * 2, z0 * 2], n1 = [0, y1 * 2, z1 * 2];
    // Tread, wound counter-clockwise seen from outside.
    for (const [v, n] of [[[-.5, y0, z0], n0], [[.5, y1, z1], n1], [[.5, y0, z0], n0], [[-.5, y0, z0], n0], [[-.5, y1, z1], n1], [[.5, y1, z1], n1]]) {
      positions.push(...v); normals.push(...n);
    }
    // Side walls.
    positions.push(.5, 0, 0, .5, y0, z0, .5, y1, z1, -.5, 0, 0, -.5, y1, z1, -.5, y0, z0);
    normals.push(1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0);
  }
  return { positions, normals };
}
