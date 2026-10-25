// Rally stage furniture: a start arch at A, a chequered finish arch (a flying
// finish: keep going and stop further on), and a row of hay bales where the road
// ends at B. Everything is boxes, drawn with the shared unit cube.

import { terrainHeight } from './terrain.js';

const GATE_POST = [0.55, 0.57, 0.6], GATE_GREEN = [0.12, 0.55, 0.3], GATE_BLACK = [0.08, 0.08, 0.09];
const GATE_WHITE = [0.95, 0.95, 0.95], GATE_BALE = [0.83, 0.71, 0.38];

// Boxes as { c, axes: [right, up, back], s, color } for basis().
export function buildGates(track) {
  const boxes = [];
  const span = track.halfWidth + track.edgeWidth + 1;
  // A box at (side, height) in a mark's frame: `side` across the road, `fwd` along it.
  const put = (m, side, fwd, y0, sx, sy, sz, color) => {
    const [tx, tz] = m.tangent, right = [-tz, 0, tx];
    const x = m.x + right[0] * side + tx * fwd, z = m.z + right[2] * side + tz * fwd;
    const mat = color === GATE_POST ? 'metal' : color === GATE_BALE ? 'straw' : 'matte';
    boxes.push({ c: [x, y0 + sy / 2, z], axes: [right, [0, 1, 0], [-tx, 0, -tz]], s: [sx, sy, sz], color, mat });
  };
  // Ground under the road's center at a mark: the banner stays level across.
  const groundAt = (m) => Math.min(...[-span, 0, span].map((o) => terrainHeight(m.x - m.tangent[1] * o, m.z + m.tangent[0] * o)));

  const arch = (m, banner) => {
    const y = groundAt(m) - 0.5;
    for (const s of [-1, 1]) put(m, s * span, 0, y, 0.45, 6.2, 0.45, GATE_POST);
    banner(m, y + 4.6);
  };
  arch(track.start, (m, y) => {
    put(m, 0, 0, y, span * 2, 1.1, 0.2, GATE_GREEN);
    put(m, 0, 0, y - 0.12, span * 2, 0.12, 0.22, GATE_WHITE);
  });
  // Finish: two rows of black and white squares.
  arch(track.finish, (m, y) => {
    const cells = Math.round(span * 2 / 0.8), size = (span * 2) / cells;
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < cells; i++) {
        put(m, -span + size * (i + 0.5), 0, y + row * 0.55, size, 0.55, 0.2, (i + row) % 2 ? GATE_BLACK : GATE_WHITE);
      }
    }
  });

  // Bales across the end of the road, two high in the middle.
  const end = track.end;
  for (let o = -span + 0.7; o <= span - 0.7; o += 1.4) {
    const y = terrainHeight(end.x - end.tangent[1] * o, end.z + end.tangent[0] * o) - 0.15;
    put(end, o, -1, y, 1.3, 0.9, 1.2, GATE_BALE);
    if (Math.abs(o) < span / 2) put(end, o + 0.35, -1, y + 0.88, 1.3, 0.9, 1.2, GATE_BALE);
  }
  return boxes;
}
