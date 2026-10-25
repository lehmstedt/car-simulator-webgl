// Paddock beside the start/finish straight, on the driver's right: an asphalt
// apron with a pit wall, a row of garages, a race-control tower and team
// trucks behind. The ground there is levelled across the track (terrain.js),
// so it only follows the straight's gentle rise along its length.
// Everything is boxes, drawn with the shared unit cube.

import { terrainHeight } from './terrain.js';
import { ROAD_LIFT } from './track.js';

// World-space apron (the straight runs along +x at z ~ 120).
export const PADDOCK = { x0: -50, x1: 55, z0: 131, z1: 170 };

export const onPaddock = (x, z, margin = 0) =>
  x >= PADDOCK.x0 - margin && x <= PADDOCK.x1 + margin && z >= PADDOCK.z0 - margin && z <= PADDOCK.z1 + margin;

const CONCRETE = [0.78, 0.78, 0.75], WALL = [0.86, 0.86, 0.84], ROOF = [0.32, 0.34, 0.37];
const DOOR = [0.09, 0.1, 0.12], GLASS = [0.2, 0.32, 0.45], WHITE = [0.94, 0.94, 0.94];
const MATS = new Map([[CONCRETE, 'concrete'], [WALL, 'concrete'], [ROOF, 'metal'], [DOOR, 'matte'], [GLASS, 'glass'], [WHITE, 'paint']]);
const TEAMS = [[0.85, 0.15, 0.15], [0.15, 0.35, 0.8], [0.95, 0.75, 0.15], [0.1, 0.55, 0.3]];

// Lowest ground under a footprint, so boxes never float at a corner.
function base(x0, x1, z0, z1) {
  return Math.min(terrainHeight(x0, z0), terrainHeight(x1, z0), terrainHeight(x0, z1), terrainHeight(x1, z1));
}

export function buildPaddock() {
  const P = PADDOCK;
  // Apron: a grid draped over the (levelled) ground, 5 m cells.
  const positions = [], normals = [];
  const nx = Math.ceil((P.x1 - P.x0) / 5), nz = Math.ceil((P.z1 - P.z0) / 5);
  const v = (i, j) => {
    const x = P.x0 + ((P.x1 - P.x0) * i) / nx, z = P.z0 + ((P.z1 - P.z0) * j) / nz;
    positions.push(x, terrainHeight(x, z) + ROAD_LIFT, z);
    normals.push(0, 1, 0);
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      for (const [a, b] of [[i, j], [i, j + 1], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i + 1, j]]) v(a, b);
    }
  }

  // Boxes: center x/z, size, bottom height above `y0`, color. y0 defaults to
  // the ground under the box.
  const boxes = [];
  const box = (cx, cz, sx, sy, sz, color, lift = 0, y0 = null) => {
    const y = (y0 ?? base(cx - sx / 2, cx + sx / 2, cz - sz / 2, cz + sz / 2) - 0.3) + lift;
    boxes.push({ c: [cx, y + sy / 2, cz], s: [sx, sy, sz], color, mat: MATS.get(color) ?? 'paint' });
  };

  // Pit wall, open at both ends for the pit entry and exit.
  for (let x = -38; x < 42; x += 10) box(x + 5, 132, 10.05, 1.4, 0.5, WALL);
  // Pit lane line.
  for (let x = -45; x < 50; x += 5) box(x + 2.5, 137.5, 5, 0.4, 0.25, WHITE);

  // Garages: 8 units, each on its own footing as the ground rises along the straight.
  const front = 146, depth = 14, height = 5.2;
  for (let g = 0; g < 8; g++) {
    const cx = -31 + g * 10, x0 = cx - 5, x1 = cx + 5;
    const y0 = base(x0, x1, front - 3, front + depth) - 0.3;
    const team = TEAMS[Math.floor(g / 2) % TEAMS.length];
    box(cx, front + depth / 2, 10.02, height + 0.3, depth, CONCRETE, 0, y0);
    box(cx, front - 0.05, 7.4, 3.9, 0.2, DOOR, 0.3, y0);              // open garage door
    box(cx, front - 0.08, 10.02, 0.7, 0.2, team, 4.35, y0);            // team band
    box(cx, front + depth / 2 - 1.5, 10.02, 0.4, depth + 3, ROOF, height + 0.3, y0); // roof, overhangs the lane
  }

  // Race control tower at the start of the row.
  {
    const cx = -42.5, cz = 152, y0 = base(cx - 5, cx + 5, cz - 6, cz + 6) - 0.3;
    box(cx, cz, 9, 9, 11, CONCRETE, 0, y0);
    box(cx, cz, 9.6, 3.2, 11.6, GLASS, 9, y0);
    box(cx, cz, 10.4, 0.5, 12.4, ROOF, 12.2, y0);
  }

  // Team trucks behind the garages.
  for (let t = 0; t < 4; t++) {
    const cx = -26 + t * 20, cz = 165;
    box(cx, cz, 14.5, 1.1, 2.3, DOOR);              // wheels and chassis
    box(cx - 1.3, cz, 13, 3.6, 2.6, WHITE, 1.0);      // trailer
    box(cx + 6.6, cz, 2.6, 2.8, 2.5, TEAMS[t], 1.0); // cab
  }

  // Cars waiting in front of their garages, nose toward the track.
  const cars = [0, 2, 3, 5, 6].map((g) => ({
    x: -31 + g * 10, z: 142, heading: 0, steer: 0, frontSliding: false, rearSliding: false,
    colors: { body: TEAMS[Math.floor(g / 2) % TEAMS.length], cabin: [0.2, 0.2, 0.25], wheel: [0.08, 0.08, 0.08] },
  }));

  return { apron: { positions, normals }, boxes, cars };
}
