// Minimal column-major 4x4 matrix helpers (WebGL convention).

export function identity() {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
}

export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

// reversed: depth 1 at the near plane down to 0 at the far one, for a 0..1
// clip range (see createReversedDepth in gl.js); else OpenGL's -1..1, near to far.
export function perspective(fovy, aspect, near, far, reversed = false) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const [a, b] = reversed ? [near / (far - near), (far * near) / (far - near)] : [(far + near) * nf, 2 * far * near * nf];
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, a, -1,
    0, 0, b, 0,
  ]);
}

export function lookAt(eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

// Translation * rotationY * scale, the only transform we need for now.
export function trs(x, y, z, yaw, sx = 1, sy = 1, sz = 1) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return new Float32Array([
    c * sx, 0, -s * sx, 0,
    0, sy, 0, 0,
    s * sz, 0, c * sz, 0,
    x, y, z, 1,
  ]);
}

// Model matrix from an origin and a frame: local x -> right, y -> up, z -> back.
export function basis(o, right, up, back, sx = 1, sy = 1, sz = 1) {
  return new Float32Array([
    right[0] * sx, right[1] * sx, right[2] * sx, 0,
    up[0] * sy, up[1] * sy, up[2] * sy, 0,
    back[0] * sz, back[1] * sz, back[2] * sz, 0,
    o[0], o[1], o[2], 1,
  ]);
}

// Rotate vector v around unit axis k by angle a (Rodrigues).
export function rotate(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const d = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c);
  return [
    v[0] * c + (k[1] * v[2] - k[2] * v[1]) * s + k[0] * d,
    v[1] * c + (k[2] * v[0] - k[0] * v[2]) * s + k[1] * d,
    v[2] * c + (k[0] * v[1] - k[1] * v[0]) * s + k[2] * d,
  ];
}
