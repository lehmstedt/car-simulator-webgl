// Traffic on the open map: cars that drive the streets, keep to their lane
// and to one-way streets, stop at red lights and stop signs, and brake for
// the car ahead (the player's too).
//
// - The street graph: every piece of street open to cars has a lane each way
//   (one on one-way streets), a little right of its middle, cut back at both
//   ends so cars stop before the crossing. Through a crossing a car follows a
//   curve from the end of its lane to the start of the next one.
// - Traffic lights (from the map data, at ~3,000 crossings) cycle in 60 s: the
//   main street's way is green, then the cross street's, with a yellow and a
//   second of all-red between. Lights of close crossings change together.
// - Stop signs (map data, plus the Montreal habit filled in where the data has
//   none: side streets stop at bigger ones, residential crossings stop all
//   ways). A car stops fully, then goes when the crossing is clear, in turn.
// - Cars live within ~500 m of the player: far ones are taken away and new
//   ones put on streets out of sight, so the traffic around stays the same.
// - The island has ~185,000 pieces of street: their lanes are made only when
//   a car comes near (a crossing's lanes when a car reaches it), and the
//   lights and signs per map cell, when it is drawn.

import { nodeKey } from './openmap.js';
import { cube, cylinder } from './geometry.js';
import { ROAD_LIFT } from './track.js';

const TRAFFIC_COUNT = 70;          // cars around the player
const SPAWN_NEAR = 450, SPAWN_FAR = 560; // m: cars are put this far out at most, taken away past SPAWN_FAR
const SIGNAL_CYCLE = 60;          // s: a light's full cycle
const SIGNAL_GREEN = 26, SIGNAL_YELLOW = 3; // s, for each of the two ways; then all red until the other's turn
const LANE_SPEED = { primary: 13.9, secondary: 13.9, tertiary: 12.5, residential: 9.7, unclassified: 9.7, living_street: 4.2 };
const COMFORT_BRAKE = 2.6;         // m/s²: comfortable braking, planned for
const CAR_CELL = 16;           // m: lookup grid for cars

// A light's state for one way (phase 0 or 1) of a crossing: shared with the
// shader (shading.js, M_SIGNAL), which lights the lamps from the same clock.
export function signalState(t, offset, phase) {
  const u = (((t + offset - phase * SIGNAL_CYCLE / 2) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  return u < SIGNAL_GREEN ? 'green' : u < SIGNAL_GREEN + SIGNAL_YELLOW ? 'yellow' : 'red';
}

const polyLength = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

// A polyline with its running lengths, for positions along it.
function polyPath(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum[cum.length - 1] };
}
// Point and unit direction at distance s along a path.
function pointAt(p, s, out) {
  const { pts, cum } = p;
  let i = 1;
  while (i < pts.length - 1 && cum[i] < s) i++;
  const [ax, az] = pts[i - 1], [bx, bz] = pts[i], l = cum[i] - cum[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / l));
  out.x = ax + (bx - ax) * t; out.z = az + (bz - az) * t;
  out.dx = (bx - ax) / l; out.dz = (bz - az) / l;
  return out;
}
// Cuts a path to [s0, s1].
function polySlice(pts, s0, s1) {
  const p = polyPath(pts), out = [], o = {};
  pointAt(p, s0, o); out.push([o.x, o.z]);
  for (let i = 1; i < pts.length - 1; i++) if (p.cum[i] > s0 && p.cum[i] < s1) out.push(pts[i]);
  pointAt(p, s1, o); out.push([o.x, o.z]);
  return out;
}
// The polyline moved `off` m to its right (x east, z south: right of (dx, dz) is (-dz, dx)).
function polyOffset(pts, off) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    return [p[0] - dz * off, p[1] + dx * off];
  });
}

export class Traffic {
  constructor(map) {
    this.map = map;
    this.clock = 0;
    this.cars = [];
    this.nextId = 1;
    this.extra = []; // other cars to brake for: the police's
    this.buildGraph();
  }

  // --- the street graph --------------------------------------------------
  // Nodes (street ends) for every street open to cars; lanes come later.
  buildGraph() {
    const nodes = new Map();
    const node = (p) => {
      const k = nodeKey(p);
      let n = nodes.get(k);
      if (!n) nodes.set(k, (n = { key: k, x: p[0], z: p[1], roads: [], signal: null, r: 0, crossing: false, full: false, out: null, into: null, inside: null, queue: null }));
      return n;
    };
    for (const r of this.map.roads) {
      if (!r.cars || !(r.cls in LANE_SPEED)) continue;
      r.a = node(r.pts[0]); r.b = node(r.pts[r.pts.length - 1]);
      r.a.roads.push(r); r.b.roads.push(r);
    }
    // Crossings: three or more streets. Cars stop clear of the widest other street.
    for (const n of nodes.values()) {
      n.crossing = n.roads.length >= 3;
      n.r = n.crossing ? Math.max(...n.roads.map((r) => r.w)) + 1.5 : 1;
    }
    const groups = new Map();
    for (const s of this.map.signals) {
      const n = nodes.get(nodeKey([s.x, s.z]));
      if (!n) continue;
      if (!groups.has(s.group)) groups.set(s.group, (s.group * 23.7) % SIGNAL_CYCLE);
      n.signal = { axis: s.axis, offset: groups.get(s.group) };
    }
    this.nodes = nodes;
    this.used = new Set(); // nodes with lanes
    this.laneCount = 0;
    this.connectors = new Map();
  }

  // A node ready for lanes.
  prep(n) {
    if (n.out) return;
    n.out = []; n.into = []; n.inside = new Set(); n.queue = [];
    this.used.add(n);
  }

  // All the lanes in and out of node n.
  ensure(n) {
    if (n.full) return n;
    n.full = true;
    for (const r of n.roads) this.lanesOf(r);
    return n;
  }

  // Road r's lanes (made the first time): one each way, one on a one-way street.
  lanesOf(r) {
    if (r.lanes || !r.a) return r.lanes ?? [];
    r.lanes = [];
    this.prep(r.a); this.prep(r.b);
    const len = polyLength(r.pts);
    // Lane: right of the middle (the inner lane of a wide street); a one-way
    // street's is the right lane, or the middle one of three or more.
    const perDir = r.oneWay ? Math.max(1, Math.floor((2 * r.w) / 3.4)) : Math.max(1, Math.floor(r.w / 3.3));
    const lw = (r.oneWay ? 2 * r.w : r.w) / perDir;
    const off = r.oneWay ? (perDir === 1 ? 0.5 : r.w - lw * (perDir >= 3 ? 1.5 : 0.5)) : perDir === 1 ? Math.min(r.w / 2, 2.2) : lw / 2 + 0.15;
    for (const dir of r.oneWay ? [1] : [1, -1]) {
      const from = dir > 0 ? r.a : r.b, to = dir > 0 ? r.b : r.a;
      let t0 = from.r, t1 = to.r;
      if (t0 + t1 > len - 0.5) { const k = Math.max(0, len - 0.5) / (t0 + t1); t0 *= k; t1 *= k; }
      const pts = polyOffset(polySlice(dir > 0 ? r.pts : [...r.pts].reverse(), t0, len - t1), off);
      const lane = { id: this.laneCount++, road: r, dir, from, to, off, speed: LANE_SPEED[r.cls], cars: [], ...polyPath(pts) };
      const end = pointAt(lane, lane.len, {});
      lane.endDir = [end.dx, end.dz];
      const st = pointAt(lane, 0, {});
      lane.startDir = [st.dx, st.dz];
      // What stands at its end: lights, a stop sign or nothing.
      const e = 2 * r.index + (dir > 0 ? 1 : 0);
      if (to.signal) {
        lane.control = 'signal';
        const a = to.signal.axis;
        lane.phase = Math.abs(Math.cos(Math.atan2(end.dz, end.dx) - a)) > Math.SQRT1_2 ? 0 : 1;
      } else if (to.crossing && this.map.stops.has(e)) lane.control = 'stop';
      else lane.control = to.crossing ? 'yield' : null;
      r.lanes.push(lane);
      from.out.push(lane);
      to.into.push(lane);
    }
    return r.lanes;
  }

  // The curve from the end of lane a to the start of lane b, through their node.
  connector(a, b) {
    const k = a.id * 4194304 + b.id;
    let c = this.connectors.get(k);
    if (c) return c;
    const p0 = a.pts[a.pts.length - 1], p2 = b.pts[0];
    const [ux, uz] = a.endDir, [vx, vz] = b.startDir;
    // Control point: where the lanes' lines meet, else halfway.
    let p1 = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2];
    const den = ux * vz - uz * vx;
    if (Math.abs(den) > 0.15) {
      const t = ((p2[0] - p0[0]) * vz - (p2[1] - p0[1]) * vx) / den;
      const d = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
      if (t > 0 && t < d * 1.5) p1 = [p0[0] + ux * t, p0[1] + uz * t];
    }
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, s = 1 - t;
      pts.push([s * s * p0[0] + 2 * s * t * p1[0] + t * t * p2[0], s * s * p0[1] + 2 * s * t * p1[1] + t * t * p2[1]]);
    }
    c = polyPath(pts);
    const turn = Math.acos(Math.max(-1, Math.min(1, ux * vx + uz * vz)));
    c.vmax = turn < 0.25 ? 99 : Math.max(3.5, Math.sqrt(2.8 * Math.max(c.len, 1) / turn));
    c.left = ux * vz - uz * vx < -0.5;
    c.node = a.to;
    this.connectors.set(k, c);
    return c;
  }

  // Where a car goes after lane a: mostly straight on, sometimes a turn; back
  // the way it came only at a dead end.
  choose(a) {
    this.ensure(a.to);
    let opts = a.to.out.filter((b) => b.road !== a.road && b.len > 0.5);
    if (!opts.length) opts = a.to.out.filter((b) => b.len > 0.5);
    if (!opts.length) return null;
    const w = opts.map((b) => (a.endDir[0] * b.startDir[0] + a.endDir[1] * b.startDir[1] > 0.8 ? 4 : 1));
    let r = Math.random() * w.reduce((s, v) => s + v, 0);
    for (let i = 0; i < opts.length; i++) if ((r -= w[i]) < 0) return opts[i];
    return opts[opts.length - 1];
  }

  // --- cars ----------------------------------------------------------------
  reset(player) {
    for (const c of this.cars) this.remove(c, false);
    this.cars = [];
    for (const n of this.used) { n.inside.clear(); n.queue = []; }
    this.near = null;
    for (let i = 0; i < TRAFFIC_COUNT * 3 && this.cars.length < TRAFFIC_COUNT; i++) this.spawn(player, 25, SPAWN_NEAR);
  }

  // Streets open to cars around the player (refreshed as the player moves).
  roadsAround(player) {
    if (!this.near || Math.hypot(player.x - this.near.x, player.z - this.near.z) > 100) {
      const roads = this.map.roadsNear(player.x, player.z, SPAWN_NEAR + 100).filter((r) => r.a);
      this.near = { x: player.x, z: player.z, roads };
    }
    return this.near.roads;
  }

  spawn(player, minD, maxD) {
    const roads = this.roadsAround(player);
    if (!roads.length) return null;
    for (let tries = 0; tries < 40; tries++) {
      const lanes = this.lanesOf(roads[Math.floor(Math.random() * roads.length)]);
      const lane = lanes[Math.floor(Math.random() * lanes.length)];
      if (!lane) continue;
      if (lane.len < 12) continue;
      const s = 3 + Math.random() * (lane.len - 6), p = pointAt(lane, s, {});
      const d = Math.hypot(p.x - player.x, p.z - player.z);
      if (d < minD || d > maxD) continue;
      if (lane.cars.some((o) => Math.abs(o.s - s) < 12)) continue;
      const next = this.choose(lane);
      if (!next) continue;
      const kind = CAR_SHAPES[Math.floor(Math.random() * CAR_SHAPES.length)];
      const c = {
        id: this.nextId++, lane, s, conn: null, next, v: lane.speed * 0.6, x: p.x, z: p.z, dx: p.dx, dz: p.dz,
        kind, color: CAR_PAINTS[Math.floor(Math.random() * CAR_PAINTS.length)], mood: 0.88 + Math.random() * 0.2,
        stoppedAt: null, stuck: 0, braking: false,
      };
      lane.cars.push(c);
      this.cars.push(c);
      return c;
    }
    return null;
  }

  remove(c, splice = true) {
    const l = c.lane.cars, i = l.indexOf(c);
    if (i >= 0) l.splice(i, 1);
    if (c.conn) c.conn.node.inside.delete(c);
    for (const n of [c.lane.to]) { const q = n.queue.indexOf(c); if (q >= 0) n.queue.splice(q, 1); }
    if (splice) { const k = this.cars.indexOf(c); if (k >= 0) this.cars.splice(k, 1); }
  }

  // The nearest thing ahead of car c in its lane's corridor (another car or
  // the player): its distance, bumper to bumper, and speed; null if none.
  ahead(c, player, look) {
    let best = null;
    const fx = c.dx, fz = c.dz, half = c.kind.length / 2;
    const test = (ox, oz, olen, ov, other) => {
      const rx = ox - c.x, rz = oz - c.z;
      const f = rx * fx + rz * fz;
      if (f <= 0 || f > look) return;
      if (Math.abs(rz * fx - rx * fz) > 1.9) return;
      const gap = f - half - olen / 2;
      if (!best || gap < best.gap) best = { gap, v: ov, other };
    };
    const ci = Math.floor(c.x / CAR_CELL), cj = Math.floor(c.z / CAR_CELL), reach = Math.ceil(look / CAR_CELL);
    for (let i = ci - reach; i <= ci + reach; i++) {
      for (let j = cj - reach; j <= cj + reach; j++) {
        for (const o of this.grid.get(i * 7919 + j) ?? []) {
          if (o === c) continue;
          // Only cars on its way: in its lane or the next, or in the crossing ahead.
          const onWay = o.conn ? o.conn.node === (c.conn ? c.conn.node : c.lane.to) : o.lane === c.next || (!c.conn && o.lane === c.lane);
          if (onWay) test(o.x, o.z, o.kind.length, o.v, o);
        }
      }
    }
    test(player.x, player.z, 4.6, player.speed, null);
    for (const u of this.extra) test(u.x, u.z, u.length, u.v, null); // patrol cars (police.js)
    // Two cars that see each other (nose to nose in a crossing): the older one goes.
    if (best?.other) {
      const o = best.other, rx = c.x - o.x, rz = c.z - o.z, f = rx * o.dx + rz * o.dz;
      if (f > 0 && Math.abs(rz * o.dx - rx * o.dz) < 1.9 && o.dx * fx + o.dz * fz < 0.3 && c.id < o.id) best = null;
    }
    return best;
  }

  // May car c, waiting at the end of its lane, go into the crossing now?
  clear(c, player) {
    const lane = c.lane, n = this.ensure(lane.to);
    if (n.inside.size) return false;
    // Nothing coming on the streets that don't stop, and not the player.
    for (const l of n.into) {
      if (l === lane || l.control === 'stop') continue;
      for (const o of l.cars) if (l.len - o.s < 30 && o.v > 1) return false;
    }
    const px = n.x - player.x, pz = n.z - player.z, pd = Math.hypot(px, pz);
    if (pd < n.r + 25 && Math.abs(player.speed) > 1.5) {
      const behind = (player.x - c.x) * c.dx + (player.z - c.z) * c.dz < 0;
      if (!behind && (player.vx * px + player.vz * pz) > 0) return false;
    }
    // The next lane has room.
    if (c.next && c.next.cars.some((o) => o.s < 7)) return false;
    return true;
  }

  // Must car c stop at the end of its lane (as things stand now)?
  mustStop(c, player, dEnd) {
    const lane = c.lane;
    this.ensure(lane.to);
    if (!c.next) return true;
    if (lane.control === 'signal') {
      const st = signalState(this.clock, lane.to.signal.offset, lane.phase);
      if (st === 'red') return true;
      if (st === 'yellow' && dEnd > (c.v * c.v) / (2 * 4) + 1.5) return true;
      if (c.next.cars.some((o) => o.s < 7 && o.v < 3)) return true; // don't block the crossing
      // Turning left: let the oncoming cars by.
      if (this.connector(lane, c.next).left) {
        for (const l of lane.to.into) {
          if (l === lane || l.phase !== lane.phase || l.endDir[0] * lane.endDir[0] + l.endDir[1] * lane.endDir[1] > -0.7) continue;
          for (const o of l.cars) if (l.len - o.s < 40 && o.v > 1.5) return true;
        }
      }
      return false;
    }
    if (lane.control === 'stop') {
      if (c.stoppedAt === null) return true;
      if (this.clock - c.stoppedAt < 1) return true;
      if (lane.to.queue[0] !== c) return true;
      return !this.clear(c, player);
    }
    if (lane.control === 'yield') {
      if (dEnd < 10 && [...lane.to.inside].some((o) => o.conn && o.lane !== lane)) return true;
      if (c.next.cars.some((o) => o.s < 7 && o.v < 3)) return true;
    }
    return false;
  }

  update(dt, player) {
    if (dt <= 0) return;
    this.clock = (this.clock + dt) % (SIGNAL_CYCLE * 100);
    // Lookup grid of the cars.
    this.grid = new Map();
    for (const c of this.cars) {
      const k = Math.floor(c.x / CAR_CELL) * 7919 + Math.floor(c.z / CAR_CELL);
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(c);
    }
    const gone = [];
    for (const c of this.cars) {
      const d = Math.hypot(c.x - player.x, c.z - player.z);
      if (d > SPAWN_FAR || (c.stuck > 40 && d > 70)) { gone.push(c); continue; }
      // Speed wanted: the street's, slowing for the turn ahead or to stop at the line.
      let target = c.lane.speed * c.mood;
      const look = Math.max(12, c.v * 3 + 8);
      if (c.conn) {
        target = Math.min(target, c.conn.vmax);
      } else {
        const dEnd = c.lane.len - c.s;
        if (dEnd < 70) {
          const stop = this.mustStop(c, player, dEnd);
          const vEnd = stop ? 0 : c.next ? this.connector(c.lane, c.next).vmax : 0;
          target = Math.min(target, Math.sqrt(vEnd * vEnd + 2 * COMFORT_BRAKE * Math.max(0, dEnd - (stop ? 0.3 : 0))));
          if (stop && dEnd < 0.6) target = 0;
          // At a stop sign: stopped at the line, now waiting for its turn.
          if (c.lane.control === 'stop' && c.stoppedAt === null && dEnd < 2 && c.v < 0.4) {
            c.stoppedAt = this.clock;
            c.lane.to.queue.push(c);
          }
        }
      }
      const a = this.ahead(c, player, look);
      if (a) target = Math.min(target, Math.max(0, Math.min(Math.sqrt(2 * 3.5 * Math.max(0, a.gap - 2)), a.v + (a.gap - 2 - c.v * 1.2) * 0.6)));
      const acc = Math.max(-7, Math.min(1.8, (target - c.v) * 2));
      c.braking = acc < -0.6 || (c.v < 0.3 && target < 0.3);
      c.v = Math.max(0, c.v + acc * dt);
      if (!c.conn && c.v < 0.05 && target < 0.05 && c.lane.len - c.s < 0.6) c.v = 0;
      c.stuck = c.v < 0.2 ? c.stuck + dt : 0;
      this.advance(c, c.v * dt, player, gone);
    }
    for (const c of gone) this.remove(c);
    // Keep the numbers up: new cars out of sight.
    if (this.cars.length < TRAFFIC_COUNT) this.spawn(player, 160, SPAWN_NEAR);
  }

  // Moves car c ds along its path, through crossings.
  advance(c, ds, player, gone) {
    const o = {};
    for (let guard = 0; guard < 4; guard++) {
      if (c.conn) {
        c.cs += ds;
        if (c.cs < c.conn.len) break;
        ds = c.cs - c.conn.len;
        c.conn.node.inside.delete(c);
        c.conn = null;
        c.lane = c.next;
        c.lane.cars.push(c);
        c.s = 0;
        c.next = this.choose(c.lane);
        c.stoppedAt = null;
        continue;
      }
      c.s += ds;
      if (c.s < c.lane.len) break;
      // A dead end (the map's edge): the car goes away, unless the player sees it.
      if (!c.next && Math.hypot(c.x - player.x, c.z - player.z) > 50) { gone.push(c); return; }
      if (this.mustStop(c, player, 0)) { c.s = c.lane.len; c.v = 0; break; }
      ds = c.s - c.lane.len;
      const q = c.lane.to.queue.indexOf(c);
      if (q >= 0) c.lane.to.queue.splice(q, 1);
      c.lane.cars.splice(c.lane.cars.indexOf(c), 1);
      c.conn = this.connector(c.lane, c.next);
      c.conn.node.inside.add(c);
      c.cs = 0;
    }
    pointAt(c.conn ?? c.lane, c.conn ? c.cs : c.s, o);
    c.x = o.x; c.z = o.z; c.dx = o.dx; c.dz = o.dz;
  }

  // Whether (x, z) is inside a traffic car, and if so the way out (as the
  // map's blocked()): unit push (nx, nz) and depth.
  blocked(x, z) {
    let best = null;
    const hit = (c) => {
      const rx = x - c.x, rz = z - c.z, f = rx * c.dx + rz * c.dz, l = rx * -c.dz + rz * c.dx;
      const hl = c.kind.length / 2, hw = c.kind.width / 2;
      if (Math.abs(f) > hl || Math.abs(l) > hw) return;
      const df = hl - Math.abs(f), dl = hw - Math.abs(l);
      const r = df < dl ? { nx: c.dx * Math.sign(f), nz: c.dz * Math.sign(f), depth: df } : { nx: -c.dz * Math.sign(l), nz: c.dx * Math.sign(l), depth: dl };
      r.car = c; // what was hit, for how fast it was going (crash damage)
      if (!best || r.depth > best.depth) best = r;
    };
    // The cell and its neighbors: a car can reach over a cell's edge.
    const ci = Math.floor(x / CAR_CELL), cj = Math.floor(z / CAR_CELL);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (const c of this.grid?.get(i * 7919 + j) ?? []) hit(c);
    return best;
  }

  // --- what stands at the crossings --------------------------------------
  // Traffic lights (pole and heads; lamps lit by the shader) and stop signs,
  // with white stop lines across the lanes, at the ends of the given roads.
  furniture(roads) {
    const poles = { positions: [], normals: [] }, lamps = { positions: [], normals: [], uvs: [] };
    const signs = { positions: [], normals: [], uvs: [] }, backs = { positions: [], normals: [] };
    const lines = { positions: [], normals: [] };
    const C = cube();
    // A box at c with axes right (x), up (y) and face (z, toward the driver).
    const box = (m, c, rgt, face, sx, sy, sz) => {
      for (let i = 0; i < C.positions.length; i += 3) {
        const [x, y, z] = [C.positions[i] * sx, C.positions[i + 1] * sy, C.positions[i + 2] * sz];
        m.positions.push(c[0] + rgt[0] * x + face[0] * z, c[1] + y, c[2] + rgt[1] * x + face[1] * z);
        const [nx, ny, nz] = [C.normals[i], C.normals[i + 1], C.normals[i + 2]];
        m.normals.push(rgt[0] * nx + face[0] * nz, ny, rgt[1] * nx + face[1] * nz);
      }
    };
    // An octagon (disc) facing `face`, radius r, with UVs from the unit octagon.
    const disc = (m, c, rgt, face, r, uv) => {
      const pt = (k) => { const a = Math.PI / 8 + (k * Math.PI) / 4; return [Math.cos(a), Math.sin(a)]; };
      for (let k = 0; k < 8; k++) {
        for (const [u, v] of [[0, 0], pt(k), pt(k + 1)]) {
          m.positions.push(c[0] + rgt[0] * u * r, c[1] + v * r, c[2] + rgt[1] * u * r);
          m.normals.push(face[0], 0, face[1]);
          if (m.uvs) m.uvs.push(...uv(u, v));
        }
      }
    };
    const line = (p, q, half) => {
      const dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * half, nz = (dx / l) * half;
      const put = (x, z) => { lines.positions.push(x, ROAD_LIFT + 0.02, z); lines.normals.push(0, 1, 0); };
      put(p[0] + nx, p[1] + nz); put(p[0] - nx, p[1] - nz); put(q[0] - nx, q[1] - nz);
      put(p[0] + nx, p[1] + nz); put(q[0] - nx, q[1] - nz); put(q[0] + nx, q[1] + nz);
    };
    for (const lane of roads.flatMap((r) => this.lanesOf(r))) {
      if (lane.control !== 'signal' && lane.control !== 'stop') continue;
      const r = lane.road, [dx, dz] = lane.endDir, rgt = [-dz, dx], face = [-dx, -dz];
      const end = lane.pts[lane.pts.length - 1];
      const mid = [end[0] - rgt[0] * lane.off, end[1] - rgt[1] * lane.off]; // the street's middle at the line
      // Stop line, from the middle (or the far edge of a one-way street) to the curb.
      const s0 = r.oneWay ? -r.w + 0.2 : 0.3, s1 = r.w - 0.2;
      const across = (s) => [mid[0] + rgt[0] * s + dx * 0.6, mid[1] + rgt[1] * s + dz * 0.6];
      line(across(s0), across(s1), 0.22);
      const side = r.w + Math.min(r.walk || 0.6, 1.4) * 0.6;
      if (lane.control === 'stop') {
        // Stop sign at the curb by the line, facing the driver.
        const base = [mid[0] + rgt[0] * side, 0, mid[1] + rgt[1] * side];
        box(poles, [base[0], 1.15, base[2]], rgt, face, 0.07, 2.3, 0.07);
        const c = [base[0] + face[0] * 0.06, 2.35, base[2] + face[1] * 0.06];
        disc(signs, c, rgt, face, 0.38, (u, v) => [0.5 + u * 0.5, 0.5 + v * 0.5]);
        disc(backs, [c[0] - face[0] * 0.01, c[1], c[2] - face[1] * 0.01], [-rgt[0], -rgt[1]], [-face[0], -face[1]], 0.38);
      } else {
        // Traffic light across the crossing on the right, facing the driver.
        const n = lane.to, far = n.r - 1;
        const base = [mid[0] + dx * (far * 2 + 1) + rgt[0] * side, mid[1] + dz * (far * 2 + 1) + rgt[1] * side];
        box(poles, [base[0], 1.9, base[1]], rgt, face, 0.16, 3.8, 0.16);
        const head = [base[0] + face[0] * 0.25, 3.3, base[1] + face[1] * 0.25];
        box(poles, head, rgt, face, 0.42, 1.15, 0.28);
        for (let k = 0; k < 3; k++) {
          const c = [head[0] + face[0] * 0.145, head[1] + 0.36 - k * 0.36, head[2] + face[1] * 0.145];
          disc(lamps, c, rgt, face, 0.13, () => [n.signal.offset, lane.phase * 3 + k]);
          // A visor over each lamp.
          box(poles, [c[0] + face[0] * 0.1, c[1] + 0.15, c[2] + face[1] * 0.1], rgt, face, 0.3, 0.02, 0.2);
        }
      }
    }
    return { poles, lamps, signs, backs, lines };
  }
}

// --- the cars' look ----------------------------------------------------------
// Three shapes, in car frame (x right, y up, z back), on the ground. Parts by
// how they're drawn: paint, glass, dark trim and tires, head and tail lights.
const CAR_SHAPES = [
  { name: 'sedan', length: 4.7, width: 1.82, body: [0.28, 0.82], cabin: [0.82, 1.42, -0.55, 1.45], wheel: 0.33 },
  { name: 'suv', length: 4.8, width: 1.92, body: [0.36, 1.02], cabin: [1.02, 1.72, -0.95, 1.95], wheel: 0.37 },
  { name: 'hatch', length: 4.1, width: 1.76, body: [0.3, 0.84], cabin: [0.84, 1.45, -0.6, 1.85], wheel: 0.31 },
];
const CAR_PAINTS = [
  [0.9, 0.9, 0.9], [0.08, 0.08, 0.09], [0.55, 0.56, 0.58], [0.33, 0.34, 0.36], [0.12, 0.2, 0.42],
  [0.55, 0.08, 0.08], [0.85, 0.85, 0.82], [0.2, 0.3, 0.25], [0.7, 0.62, 0.48], [0.15, 0.32, 0.6],
];

export function carMeshes() {
  const C = cube(), W = cylinder(12);
  return CAR_SHAPES.map((k) => {
    const m = { paint: [], glass: [], trim: [], head: [], tail: [] };
    const box = (part, src, cx, cy, cz, sx, sy, sz) => {
      const P = part.positions ?? (part.positions = []), N = part.normals ?? (part.normals = []);
      for (let i = 0; i < src.positions.length; i += 3) {
        P.push(cx + src.positions[i] * sx, cy + src.positions[i + 1] * sy, cz + src.positions[i + 2] * sz);
        // Scaled normals stay right for boxes and the wheel's axis-aligned parts.
        N.push(src.normals[i], src.normals[i + 1], src.normals[i + 2]);
      }
    };
    for (const key in m) m[key] = {};
    const L = k.length, Wd = k.width, [b0, b1] = k.body, [c0, c1, cf, cb] = k.cabin;
    box(m.paint, C, 0, (b0 + b1) / 2, 0, Wd, b1 - b0, L);                                   // body
    box(m.glass, C, 0, (c0 + c1) / 2 - 0.02, (cf + cb) / 2 - 0.15, Wd - 0.2, c1 - c0, cb - cf); // cabin
    box(m.paint, C, 0, c1, (cf + cb) / 2 - 0.15, Wd - 0.26, 0.05, cb - cf - 0.2);             // roof
    box(m.trim, C, 0, b0 + 0.08, -L / 2 + 0.02, Wd + 0.02, 0.16, 0.1);                       // bumpers
    box(m.trim, C, 0, b0 + 0.08, L / 2 - 0.02, Wd + 0.02, 0.16, 0.1);
    const ax = L / 2 - 0.95;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(m.trim, W, sx * (Wd / 2 - 0.12), k.wheel, sz * ax, 0.24, 2 * k.wheel, 2 * k.wheel);
    for (const sx of [-1, 1]) {
      box(m.head, C, sx * (Wd / 2 - 0.3), b1 - 0.16, -L / 2 - 0.005, 0.38, 0.12, 0.02);
      box(m.tail, C, sx * (Wd / 2 - 0.25), b1 - 0.14, L / 2 + 0.005, 0.32, 0.13, 0.02);
    }
    return m;
  });
}
CAR_SHAPES.forEach((k, i) => { k.index = i; });
