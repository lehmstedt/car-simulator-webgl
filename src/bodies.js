// Car body meshes built from the same numbers as the physics (car.js VARIANTS),
// so the wheels sit where the tires push and the body spans the real length.
// Coordinates are the car frame: x right, y up, z back, origin on the ground
// under the center of gravity.

// Lofted body: rounded cross-sections (a superellipse from `y0` to `y1`, half
// width `w`) joined along z. `dip` lowers the middle of the top (a hood between
// raised fenders); `pinch` narrows the top relative to the bottom (tumblehome).
function loft(stations, seg = 40, n = 4) {
  const positions = [], indices = [];
  const ring = seg;
  for (const st of stations) {
    // Dense outline first, then `ring` points spaced evenly along it, so flat
    // tops get as many vertices as the rounded corners.
    const dense = [];
    for (let i = 0; i <= 256; i++) {
      const th = (i / 256) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const ex = Math.sign(c) * Math.abs(c) ** (2 / n), ey = Math.sign(s) * Math.abs(s) ** (2 / n);
      const up = (ey + 1) / 2; // 0 bottom .. 1 top
      const w = st.w * (1 - (st.pinch ?? 0) * up);
      const x = ex * w;
      let y = st.y0 + up * (st.y1 - st.y0);
      if (st.dip && ey > 0) y -= st.dip * Math.max(0, 1 - (x / (0.7 * w)) ** 2) * ey;
      dense.push([x, y]);
    }
    const acc = [0];
    for (let i = 1; i < dense.length; i++) acc.push(acc[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
    const total = acc[acc.length - 1];
    for (let i = 0, j = 0; i < ring; i++) {
      const want = (i / ring) * total;
      while (acc[j + 1] < want) j++;
      const k = (want - acc[j]) / Math.max(1e-9, acc[j + 1] - acc[j]);
      positions.push(dense[j][0] + (dense[j + 1][0] - dense[j][0]) * k, dense[j][1] + (dense[j + 1][1] - dense[j][1]) * k, st.z);
    }
  }
  for (let k = 0; k < stations.length - 1; k++) {
    for (let i = 0; i < ring; i++) {
      const a = k * ring + i, b = k * ring + ((i + 1) % ring), c = a + ring, d = b + ring;
      indices.push(a, b, d, a, d, c);
    }
  }
  // Caps: fans to each end ring's center.
  for (const [k, flip] of [[0, false], [stations.length - 1, true]]) {
    let cx = 0, cy = 0;
    for (let i = 0; i < ring; i++) { cx += positions[(k * ring + i) * 3]; cy += positions[(k * ring + i) * 3 + 1]; }
    const ci = positions.length / 3;
    positions.push(cx / ring, cy / ring, stations[k].z);
    for (let i = 0; i < ring; i++) {
      const a = k * ring + i, b = k * ring + ((i + 1) % ring);
      indices.push(...(flip ? [ci, a, b] : [ci, b, a]));
    }
  }
  return withNormals(positions, indices);
}

// Smooth normals, flipped outward if the winding came out inside-out.
function withNormals(positions, indices) {
  const nrm = new Float64Array(positions.length);
  const P = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  let cx = 0, cy = 0, cz = 0;
  const nv = positions.length / 3;
  for (let i = 0; i < nv; i++) { cx += positions[i * 3]; cy += positions[i * 3 + 1]; cz += positions[i * 3 + 2]; }
  cx /= nv; cy /= nv; cz /= nv;
  let out = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map(P);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    out += n[0] * (a[0] - cx) + n[1] * (a[1] - cy) + n[2] * (a[2] - cz);
    for (const i of [indices[t], indices[t + 1], indices[t + 2]]) for (let j = 0; j < 3; j++) nrm[i * 3 + j] += n[j];
  }
  const sign = out < 0 ? -1 : 1;
  if (sign < 0) for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];
  const normals = [];
  for (let i = 0; i < nv; i++) {
    const x = nrm[i * 3], y = nrm[i * 3 + 1], z = nrm[i * 3 + 2], l = Math.hypot(x, y, z) || 1;
    normals.push((sign * x) / l, (sign * y) / l, (sign * z) / l);
  }
  return { positions, normals, indices };
}

// Piecewise-linear profile: pts = [[s, value], ...] sorted by s.
const profile = (pts) => (s) => {
  if (s <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (s <= pts[i][0]) {
      const [s0, v0] = pts[i - 1], [s1, v1] = pts[i];
      const k = (s - s0) / (s1 - s0), e = k * k * (3 - 2 * k); // smoothstep between keys
      return v0 + (v1 - v0) * e;
    }
  }
  return pts[pts.length - 1][1];
};

// Stations every `step` m from s0 to s1 (s = meters back from the front bumper).
const range = (s0, s1, step) => {
  const out = [], n = Math.ceil((s1 - s0) / step);
  for (let i = 0; i <= n; i++) out.push(s0 + ((s1 - s0) * i) / n);
  return out;
};

// Porsche 911 (992) GT3. Side profile keyed on distance from the front bumper,
// with the axles placed from the physics: front overhang, then the wheelbase.
export function gt3Body(v) {
  const L = v.length, front = v.overhangFront, sF = front, sR = front + v.cgToFront + v.cgToRear;
  const toZ = (s) => s - front - v.cgToFront;
  const halfW = v.width / 2;
  // Beltline / hood / fender tops: low nose, fenders over the front wheels,
  // flat doors, wide rear haunches, then the tail drops to the bumper.
  const top = profile([[0, 0.5], [0.12, 0.64], [0.5, 0.74], [sF, 0.8], [sF + 0.6, 0.83], [sR - 0.6, 0.86], [sR, 0.89], [L - 0.35, 0.88], [L - 0.08, 0.78], [L, 0.62]]);
  const width = profile([[0, halfW - 0.18], [0.3, halfW - 0.08], [sF, halfW - 0.035], [sF + 0.7, halfW - 0.06], [sR - 0.9, halfW - 0.06], [sR - 0.2, halfW], [sR + 0.4, halfW - 0.01], [L - 0.1, halfW - 0.07], [L, halfW - 0.14]]);
  const bottom = profile([[0, 0.24], [0.15, 0.13], [L - 0.25, 0.14], [L, 0.32]]);
  // The hood sits between raised front fenders (the 911's face).
  const dip = profile([[0, 0.02], [0.4, 0.07], [sF + 0.45, 0.06], [sF + 0.65, 0], [L, 0]]);
  // Wheel arches: the outer skin's lower edge rises over each wheel.
  const arch = (s) => {
    let y = bottom(s);
    for (const [c, r] of [[sF, v.wheelRadiusFront], [sR, v.wheelRadiusRear]]) {
      const R = r + 0.05, d = s - c;
      if (Math.abs(d) < R) y = Math.max(y, r + Math.sqrt(R * R - d * d));
    }
    return y;
  };
  const S = range(0, L, 0.04);
  const skin = loft(S.map((s) => ({ z: toZ(s), y0: arch(s), y1: top(s), w: width(s), dip: dip(s), pinch: 0.06 })));
  // Inner tub between the wheels so the arches aren't see-through.
  const tubW = Math.min(v.trackFront - v.tireWidthFront, v.trackRear - v.tireWidthRear) / 2 - 0.04;
  const tub = loft(range(0.1, L - 0.1, 0.1).map((s) => ({ z: toZ(s), y0: bottom(s) + 0.02, y1: top(s) - 0.06, w: Math.min(tubW, width(s) - 0.05) })), 16);

  // Greenhouse: windscreen from the cowl up to the roof, then the long
  // fastback down onto the engine lid.
  const g0 = sF + 0.62, g1 = L - 0.42;
  const roof = profile([[g0, 0.84], [g0 + 0.7, 1.24], [g0 + 0.95, 1.279], [g0 + 1.3, 1.27], [g0 + 1.75, 1.18], [g0 + 2.2, 1.04], [g1, 0.88]]);
  const gw = profile([[g0, halfW - 0.17], [g0 + 0.9, halfW - 0.2], [g0 + 1.6, halfW - 0.17], [g1, halfW - 0.3]]);
  const glass = loft(range(g0, g1, 0.05).map((s) => ({ z: toZ(s), y0: top(s) - 0.08, y1: roof(s), w: gw(s), pinch: 0.32 })), 24, 3);
  // Painted roof panel over the glass, from the windscreen header to the rear window.
  const roofPanel = loft(range(g0 + 0.82, g0 + 1.6, 0.05).map((s) => ({ z: toZ(s), y0: roof(s) - 0.09, y1: roof(s) + 0.008, w: gw(s) * 0.69 })), 24, 3);

  // Small parts: [x, y, s, sx, sy, sz, color key, material] in the car frame.
  const parts = [];
  const box = (x, y, s, sx, sy, sz, color, mat) => parts.push({ x, y, z: toZ(s), sx, sy, sz, color, mat });
  for (const side of [-1, 1]) {
    box(side * (halfW - 0.24), top(0.28) - 0.03, 0.28, 0.25, 0.08, 0.26, 'light', 'glass'); // headlights, up on the fenders
    box(side * (halfW + 0.07), 1.0, g0 + 0.32, 0.16, 0.09, 0.07, 'body', 'paint');          // mirrors
    box(side * (halfW - 0.12), 0.2, sF + 0.28, 0.24, 0.1, 0.22, 'trim', 'matte');           // front side intakes
    box(side * 0.33, 1.05, L - 0.55, 0.035, 0.32, 0.12, 'trim', 'matte');                   // swan-neck wing stays
  }
  box(0, 0.12, 0.12, v.width - 0.3, 0.03, 0.24, 'trim', 'matte');                // front splitter
  box(0, 0.3, 0.04, v.width - 0.6, 0.12, 0.08, 'trim', 'matte');                 // grille
  box(0, top(L - 0.05) - 0.06, L - 0.02, v.width - 0.2, 0.05, 0.04, 'tail', 'glass'); // light bar across the tail
  box(0, 0.22, L - 0.05, v.width - 0.5, 0.14, 0.12, 'trim', 'matte');            // diffuser
  box(0, 1.24, L - 0.5, 1.64, 0.03, 0.34, 'body', 'paint');                      // rear wing
  for (const side of [-1, 1]) box(side * 0.83, 1.2, L - 0.5, 0.02, 0.14, 0.38, 'trim', 'matte'); // wing end plates
  box(0, 0.95, L - 0.75, 0.9, 0.03, 0.4, 'trim', 'matte');                       // engine lid vents
  // Driver's eye (left-hand drive) and cockpit landmarks, for the cockpit view.
  const cockpit = {
    eye: [-0.37, 1.12, toZ(g0 + 1.48)],
    // Cabin floor just above the body's top, so the skin doesn't show inside.
    floorY: Math.max(...range(g0, g0 + 2.2, 0.1).map(top)) + 0.03,
    dashY: Math.max(...range(g0, g0 + 2.2, 0.1).map(top)) + 0.03, dashZ: toZ(g0 + 0.25),
    floorZ: [toZ(g0 + 0.2), toZ(g0 + 2.1)],
    pillarBase: [halfW - 0.2, top(g0), toZ(g0 + 0.05)], pillarTop: [halfW - 0.3, roof(g0 + 0.8) - 0.02, toZ(g0 + 0.8)],
    roofY: roof(g0 + 0.85) - 0.02, roofZ: toZ(g0 + 0.85),
  };
  return { skin, tub, glass, roofPanel, parts, cockpit };
}
