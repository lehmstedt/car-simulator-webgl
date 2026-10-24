// Procedural geometry. All meshes are non-indexed triangle lists.

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
