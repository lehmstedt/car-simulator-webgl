// People on the sidewalks of the open map (Montreal).
//
// - They live within ~180 m of the player: far ones are taken away and new
//   ones put on sidewalks further off, more of them on the bigger streets.
// - Each walks along a street's sidewalk at their own pace. At the corner they
//   turn back, or go around it onto the next street's sidewalk (across the
//   street, where that's the nearest one).
// - A car coming at them, or just too close and fast, and they jump out of
//   the way toward the buildings. The player's car never touches them; a
//   scare on the sidewalk is an offence (rules.js).

import { polyPath, pointAt } from './traffic.js';

const PEOPLE_COUNT = 90;
const PEOPLE_NEAR = 180, PEOPLE_FAR = 215;      // m: put this far out at most, taken away past PEOPLE_FAR
const FOOT_TRAFFIC = { primary: 1, secondary: 1, tertiary: 0.8, residential: 0.45, unclassified: 0.3, pedestrian: 1, living_street: 0.5 };
const SHIRTS = [
  [0.75, 0.16, 0.14], [0.14, 0.3, 0.6], [0.9, 0.88, 0.82], [0.12, 0.12, 0.14], [0.2, 0.45, 0.3], [0.85, 0.65, 0.15],
  [0.5, 0.2, 0.5], [0.3, 0.55, 0.7], [0.55, 0.55, 0.58], [0.85, 0.4, 0.5],
];
const PANTS = [[0.12, 0.14, 0.22], [0.2, 0.2, 0.22], [0.35, 0.3, 0.24], [0.25, 0.3, 0.42], [0.1, 0.1, 0.1]];
const SKINS = [[0.87, 0.68, 0.55], [0.72, 0.5, 0.36], [0.5, 0.33, 0.22], [0.93, 0.76, 0.64], [0.36, 0.24, 0.17]];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export class Pedestrians {
  constructor(map) {
    this.map = map;
    this.people = [];
    this.events = []; // { kind: 'scared', sidewalk }: the player's car made someone jump
    this.near = null;
  }

  reset(player) {
    this.people = [];
    this.near = null;
    this.events = [];
    for (let i = 0; i < PEOPLE_COUNT * 4 && this.people.length < PEOPLE_COUNT; i++) this.spawn(player, 8, PEOPLE_NEAR);
  }

  take() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // Streets with sidewalks around the player (refreshed as the player moves).
  roadsAround(player) {
    if (!this.near || Math.hypot(player.x - this.near.x, player.z - this.near.z) > 60) {
      const roads = this.map.roadsNear(player.x, player.z, PEOPLE_NEAR).filter((r) => r.walk > 0);
      this.near = { x: player.x, z: player.z, roads };
    }
    return this.near.roads;
  }

  // The stretch of road r's sidewalks people walk: clear of the crossings at its ends.
  static span(r) {
    if (!r.path) r.path = polyPath(r.pts);
    const m0 = (r.a?.r ?? 1) + 1.5, m1 = (r.b?.r ?? 1) + 1.5;
    return r.path.len - m0 - m1 > 6 ? [m0, r.path.len - m1] : null;
  }

  spawn(player, minD, maxD) {
    const roads = this.roadsAround(player);
    if (!roads.length) return;
    const o = {};
    for (let tries = 0; tries < 30; tries++) {
      const r = roads[Math.floor(Math.random() * roads.length)];
      if (Math.random() > (FOOT_TRAFFIC[r.cls] ?? 0.3)) continue;
      const span = Pedestrians.span(r);
      if (!span) continue;
      const s = span[0] + Math.random() * (span[1] - span[0]), side = Math.random() < 0.5 ? 1 : -1;
      const off = r.w + 0.5 + Math.random() * Math.max(0.2, r.walk - 1);
      pointAt(r.path, s, o);
      const x = o.x - o.dz * side * off, z = o.z + o.dx * side * off, d = Math.hypot(x - player.x, z - player.z);
      if (d < minD || d > maxD || this.map.blocked(x, z)) continue;
      const size = 0.9 + Math.random() * 0.2;
      this.people.push({
        r, s, side, off, dir: Math.random() < 0.5 ? 1 : -1, pace: 1.0 + Math.random() * 0.7, size,
        x, z, dx: o.dx, dz: o.dz, step: Math.random() * 6, moving: 1,
        hop: null,   // going around a corner: { x, z, r, s, side, dir }
        flee: 0,     // s left jumping out of the way
        fx: 0, fz: 0,
        wait: Math.random() < 0.12 ? 2 + Math.random() * 8 : 0, // some stand a moment (a phone, a shop window)
        shirt: pick(SHIRTS), pants: pick(PANTS), skin: pick(SKINS),
      });
      return;
    }
  }

  // The corner at the end of p's sidewalk: turn back, or on to the nearest
  // sidewalk of another street there.
  corner(p) {
    const node = p.dir > 0 ? p.r.b : p.r.a;
    p.dir = -p.dir;
    if (!node || Math.random() < 0.3) return;
    let best = null, bd = 16;
    const o = {};
    for (const r of node.roads) {
      if (r === p.r || !(r.walk > 0)) continue;
      const span = Pedestrians.span(r);
      if (!span) continue;
      const out = r.a === node ? 1 : -1, s = out > 0 ? span[0] : span[1];
      pointAt(r.path, s, o);
      for (const side of [1, -1]) {
        const off = r.w + 0.5 + Math.random() * Math.max(0.2, r.walk - 1);
        const x = o.x - o.dz * side * off, z = o.z + o.dx * side * off, d = Math.hypot(x - p.x, z - p.z);
        if (d < bd) { bd = d; best = { x, z, r, s, side, off, dir: out }; }
      }
    }
    if (best) p.hop = best;
  }

  update(dt, player) {
    if (dt <= 0) return;
    const P = this.people, o = {};
    const speed = Math.abs(player.speed);
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      const rx = p.x - player.x, rz = p.z - player.z, d = Math.hypot(rx, rz);
      if (d > PEOPLE_FAR) { P[i] = P[P.length - 1]; P.pop(); continue; }
      // The car: coming this way (within a second and a half), or right here and moving.
      if (d < 30 && speed > 2.5 && p.flee <= 0) {
        const t = Math.max(0, Math.min(1.5, (rx * player.vx + rz * player.vz) / (speed * speed)));
        const mx = rx - player.vx * t, mz = rz - player.vz * t, miss = Math.hypot(mx, mz);
        if (miss < 2.2 || d < 2.6) {
          // Away from the car's path, sideways.
          const sgn = mx * -player.vz + mz * player.vx >= 0 ? 1 : -1, l = speed || 1;
          p.fx = (-player.vz / l) * sgn; p.fz = (player.vx / l) * sgn;
          p.flee = 0.7;
          const at = this.map.locate(player.x, player.z);
          this.events.push({ kind: 'scared', sidewalk: !at.road || at.edge > 0.5 });
        }
      }
      let moving = 1;
      if (p.flee > 0) {
        p.flee -= dt;
        const nx = p.x + p.fx * 5 * dt, nz = p.z + p.fz * 5 * dt;
        if (!this.map.blocked(nx, nz)) { p.x = nx; p.z = nz; }
        p.dx = p.fx; p.dz = p.fz;
        moving = 2.2;
        // Back to walking from wherever they landed.
        if (p.flee <= 0) { p.hop = { x: p.x, z: p.z, r: p.r, s: p.s, side: p.side, off: p.off, dir: p.dir, back: true }; }
      } else if (p.hop) {
        const h = p.hop;
        let tx = h.x, tz = h.z;
        if (h.back) { pointAt(p.r.path, p.s, o); tx = o.x - o.dz * p.side * p.off; tz = o.z + o.dx * p.side * p.off; }
        const ex = tx - p.x, ez = tz - p.z, l = Math.hypot(ex, ez);
        if (l < 0.3) {
          Object.assign(p, { r: h.r, s: h.s, side: h.side, off: h.off, dir: h.dir, hop: null });
        } else {
          p.dx = ex / l; p.dz = ez / l;
          p.x += p.dx * Math.min(l, p.pace * dt); p.z += p.dz * Math.min(l, p.pace * dt);
        }
      } else if (p.wait > 0) {
        p.wait -= dt;
        moving = 0;
      } else {
        const span = Pedestrians.span(p.r);
        p.s += p.dir * p.pace * dt;
        if (!span || p.s < span[0] || p.s > span[1]) {
          if (span) p.s = Math.max(span[0], Math.min(span[1], p.s));
          this.corner(p);
        }
        pointAt(p.r.path, p.s, o);
        p.x = o.x - o.dz * p.side * p.off; p.z = o.z + o.dx * p.side * p.off;
        p.dx = o.dx * p.dir; p.dz = o.dz * p.dir;
        if (Math.random() < dt * 0.01) p.wait = 2 + Math.random() * 6;
      }
      // Never under the car.
      if (d < 1.5 && d > 1e-3) { p.x += (rx / d) * (1.5 - d); p.z += (rz / d) * (1.5 - d); }
      p.moving += (moving - p.moving) * Math.min(1, dt * 8);
      p.step += dt * p.pace * 3.4 * p.moving;
    }
    // Keep the numbers up: new people out of sight.
    for (let k = 0; k < 2 && P.length < PEOPLE_COUNT; k++) this.spawn(player, 70, PEOPLE_NEAR);
  }
}
