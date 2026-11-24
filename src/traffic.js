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
// - What stands at each crossing is checked when its lanes are made (plan()),
//   so it always makes sense: no crossing is left without any rule; two streets
//   that cross never both have the right of way; a big street never stops for
//   a small one that doesn't; lights of the same phase never face streets that
//   cross each other. Lights and signs stand on the sidewalk, never on another
//   street's asphalt; the short links inside a wide junction (between the two
//   roadways of a boulevard) share the junction's lights instead of their own.
// - Each car is driven, not placed: a driver steers it toward a point ahead on
//   its path (pure pursuit, the steering wheel turned at a human rate) and
//   works throttle and brake, which come in gradually. The car under it is a
//   light physics model, much simpler than the player's (car.js): a bicycle
//   that rolls where its wheels point while the tires hold, a single grip
//   limit shared between braking and cornering (so a car knocked sideways
//   slides and spins until the tires bite again), and a body on springs that
//   dives under braking, squats away from a stop and leans in the turns.
// - The drivers watch the player: where the player's car will be over the
//   next 3 s (its speed and turn held) against where they will be on their
//   path. Cut in front of one, come at it on the wrong side, or about to run
//   into it from the side, and it lifts after its reaction time (0.35 to
//   0.85 s), then brakes as hard as it must, swerves away if braking won't do,
//   speeds up out of the way of a car about to hit its rear half, and leans
//   on the horn. Hit, it's shoved (momentum shared by mass: a bus barely
//   moves), slides to a stop with its hazards on, then drives back to its lane.
// - Cars live within ~450 m of the player: far ones are taken away and new
//   ones put on streets out of sight, so the traffic around stays the same.
//   Sedans, SUVs, hatchbacks, taxis, vans, pickups and city buses (on the
//   bigger streets), with turn signals before a turn.
// - A car the player hits stops with its hazard lights on for a while; cars
//   pull over to the right and stop for a patrol car coming up behind them
//   with its siren on.
// - Parked cars line the bigger streets and the left side of one-way side
//   streets (made with a cell's lights and signs): solid, but they never move.
// - The island has ~185,000 pieces of street: their lanes are made only when
//   a car comes near (a crossing's lanes when a car reaches it), and the
//   lights and signs per map cell, when it is drawn.

import { nodeKey } from './openmap.js';
import { cube, cylinder } from './geometry.js';
import { loft, profile } from './bodies.js';
import { ROAD_LIFT } from './track.js';

const TRAFFIC_COUNT = 150;         // cars around the player
const SPAWN_NEAR = 400, SPAWN_FAR = 500; // m: cars are put this far out at most, taken away past SPAWN_FAR
// How readily a street gets a new car, by class: the big streets are the busy ones.
const BUSY = { primary: 1, secondary: 1, tertiary: 0.8, residential: 0.4, unclassified: 0.35, living_street: 0.2 };
const BUS_STREETS = new Set(['primary', 'secondary', 'tertiary']);
const PARK_SLOT = 6.4;             // m of curb per parked car
const PARK_CELL = 64;              // m: lookup grid for parked cars
const HALT_TIME = 5;               // s a car stays stopped after being hit (plus a few)
const SIREN_REACH = 45;            // m: cars make way for a siren this close behind
// Which street matters more where two meet.
const RANK = { primary: 5, secondary: 4, tertiary: 3, residential: 2, unclassified: 2, living_street: 1 };
const INNER_LINK = 30;             // m: a street piece this short between two lit crossings is inside one junction
const SIGNAL_CYCLE = 60;          // s: a light's full cycle
const SIGNAL_GREEN = 26, SIGNAL_YELLOW = 3; // s, for each of the two ways; then all red until the other's turn
const LANE_SPEED = { primary: 13.9, secondary: 13.9, tertiary: 12.5, residential: 9.7, unclassified: 9.7, living_street: 4.2 };
const COMFORT_BRAKE = 2.6;         // m/s²: comfortable braking, planned for
const CAR_CELL = 16;           // m: lookup grid for cars
// The traffic's physics and drivers.
const SIM_STEP = 1 / 60;           // s: longest physics step
const TRAFFIC_GRIP = 8.5, BUS_GRIP = 6.5; // m/s²: what the tires hold, braking and turning together
const STEER_RATE = 1.4;            // rad/s at the front wheels: how fast a driver turns the wheel
const MAX_LOCK = 0.65;             // rad
const JERK = 9, PANIC_JERK = 40;   // m/s³: how fast throttle and brake come in (calm, panicking)
const HARD_BRAKE = 8;              // m/s²: an emergency stop
const WATCH = 70;                  // m: drivers this close watch the player
const FORESEE = 3, FORESEE_STEP = 0.25; // s: how far ahead they see the player's car going, in steps
const PLAYER_HALF = [2.3, 0.95];   // m: the player's car, half length and width
const LOST = 7;                    // m off its path: knocked away, it finds its way back slowly

// A light's state for one way (phase 0 or 1) of a crossing: shared with the
// shader (shading.js, M_SIGNAL), which lights the lamps from the same clock.
export function signalState(t, offset, phase) {
  const u = (((t + offset - phase * SIGNAL_CYCLE / 2) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  return u < SIGNAL_GREEN ? 'green' : u < SIGNAL_GREEN + SIGNAL_YELLOW ? 'yellow' : 'red';
}

const polyLength = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

// A polyline with its running lengths, for positions along it.
export function polyPath(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum[cum.length - 1] };
}
// Point and unit direction at distance s along a path.
export function pointAt(p, s, out) {
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

const POSE_F = {}, POSE_R = {}, AIM_PT = {}, THREAT_PT = {}, FOLLOW_PT = {};

export class Traffic {
  constructor(map) {
    this.map = map;
    this.clock = 0;
    this.cars = [];
    this.nextId = 1;
    this.extra = []; // other cars to brake for: the police's
    this.parked = new Map(); // parked cars, by PARK_CELL cell
    this.events = [];        // 'honk': a driver the player annoyed
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

  // What stands at crossing n, for each way into it: a Map from the way's
  // number (2 × road index, + 1 driving the way the road's points run) to
  // { control: 'signal' | 'stop' | 'yield', phase }. Lights and stop signs come
  // from the map data, then are made consistent:
  // - lights: ways of the same phase must be one street (not cross each other);
  // - no rule at all in the data: the through street (two pieces in line, the
  //   biggest street there) goes, the others stop; with no through street,
  //   everybody stops;
  // - two ways that cross can't both go: the smaller street stops, or both;
  // - a bigger street never stops for a smaller one that doesn't.
  plan(n) {
    if (n.plan) return n.plan;
    const P = n.plan = new Map();
    if (!n.crossing && !n.signal) return P;
    // Every piece of street at n, pointing away from it; the ways in are the
    // pieces that may be driven toward n.
    const arms = [];
    for (const r of n.roads) {
      for (const end of r.a === r.b ? [] : [r.a === n ? 1 : -1]) {
        const i0 = end > 0 ? 0 : r.pts.length - 1, step = end > 0 ? 1 : -1;
        let i1 = i0 + step;
        while (r.pts[i1 + step] && Math.hypot(r.pts[i1][0] - r.pts[i0][0], r.pts[i1][1] - r.pts[i0][1]) < 6) i1 += step;
        const l = Math.hypot(r.pts[i1][0] - r.pts[i0][0], r.pts[i1][1] - r.pts[i0][1]) || 1;
        const ox = (r.pts[i1][0] - r.pts[i0][0]) / l, oz = (r.pts[i1][1] - r.pts[i0][1]) / l;
        // Driving toward n on this piece is against its points when it starts at n.
        const key = 2 * r.index + (end > 0 ? 0 : 1), enters = !(r.oneWay && end > 0);
        arms.push({ road: r, ox, oz, key, enters, rank: RANK[r.cls] ?? 1, stop: this.map.stops.has(key), phase: 0 });
      }
    }
    const ways = arms.filter((a) => a.enters);
    const cross = (a, b) => Math.abs(a.ox * b.ox + a.oz * b.oz) < 0.6;
    if (n.signal) {
      const axis = n.signal.axis;
      for (const a of ways) a.phase = Math.abs(Math.cos(Math.atan2(-a.oz, -a.ox) - axis)) > Math.SQRT1_2 ? 0 : 1;
      if (ways.some((a) => ways.some((b) => a.phase === b.phase && cross(a, b)))) {
        // The data's axis doesn't sort them: the biggest street keeps its phase, what crosses it gets the other.
        const ref = ways.reduce((m, a) => (a.rank > m.rank || (a.rank === m.rank && a.road.w > m.road.w) ? a : m));
        for (const a of ways) a.phase = cross(a, ref) ? 1 - ref.phase : ref.phase;
      }
      for (const a of ways) P.set(a.key, { control: 'signal', phase: a.phase });
      return P;
    }
    if (ways.length && !ways.some((a) => a.stop)) {
      // The through street: two pieces in line, of the biggest street here.
      let best = null;
      for (const a of arms) {
        for (const b of arms) {
          if (a === b || a.ox * b.ox + a.oz * b.oz > -0.75) continue;
          const rank = Math.min(a.rank, b.rank) + (a.road.name && a.road.name === b.road.name ? 0.5 : 0);
          if (!best || rank > best.rank) best = { a, b, rank };
        }
      }
      const top = Math.max(...arms.map((a) => a.rank));
      for (const a of ways) a.stop = !(best && Math.floor(best.rank) >= top && (a === best.a || a === best.b));
    }
    for (const a of ways) {
      for (const b of ways) {
        if (a.stop || b.stop || !cross(a, b)) continue;
        if (a.rank <= b.rank) a.stop = true;
        if (b.rank <= a.rank) b.stop = true;
      }
    }
    const free = ways.filter((a) => !a.stop);
    if (free.length && ways.some((a) => a.stop && free.some((b) => b.rank < a.rank))) for (const a of ways) a.stop = true;
    for (const a of ways) P.set(a.key, { control: a.stop ? 'stop' : 'yield', phase: 0 });
    return P;
  }

  // What stands at the end of road r driven in direction dir (1: the way its
  // points run): { control, phase }, control null where nothing does.
  controlAt(r, dir) {
    const n = dir > 0 ? r.b : r.a;
    return (n && this.plan(n).get(2 * r.index + (dir > 0 ? 1 : 0))) || { control: null, phase: 0 };
  }

  // The next street that crosses the one the car is on: { name, distance }
  // (m, to the crossing), or null. (x, z): the car, on road r, heading (fx, fz).
  crossingAhead(r, x, z, fx, fz, tangent) {
    if (!r?.a) return null;
    let dir = fx * tangent[0] + fz * tangent[1] >= 0 ? 1 : -1, node = dir > 0 ? r.b : r.a;
    let d = Math.hypot(node.x - x, node.z - z), road = r;
    for (let hops = 0; hops < 14 && d < 1500; hops++) {
      const names = [...new Set(node.roads.filter((o) => o.name && o.name !== r.name).map((o) => o.name))];
      if (names.length && node.crossing) return { name: names.slice(0, 2).join(' / '), distance: d };
      // On along the same street: its next piece, the one most in line.
      const i = dir > 0 ? road.pts.length - 1 : 0, j = dir > 0 ? i - 1 : 1;
      const hx = road.pts[i][0] - road.pts[j][0], hz = road.pts[i][1] - road.pts[j][1];
      let next = null, best = 0;
      for (const o of node.roads) {
        if (o === road || o.a === o.b) continue;
        const out = o.a === node ? 1 : -1, p = o.pts[out > 0 ? 0 : o.pts.length - 1], q = o.pts[out > 0 ? 1 : o.pts.length - 2];
        const sc = (hx * (q[0] - p[0]) + hz * (q[1] - p[1])) / ((Math.hypot(hx, hz) || 1) * (Math.hypot(q[0] - p[0], q[1] - p[1]) || 1)) + (o.name === r.name ? 0.5 : 0);
        if (sc > best) { best = sc; next = o; dir = out; }
      }
      if (!next || best < 0.6) return null;
      road = next;
      d += road.len ?? (road.len = polyLength(road.pts));
      node = dir > 0 ? road.b : road.a;
    }
    return null;
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
      const c = this.controlAt(r, dir);
      lane.control = c.control;
      lane.phase = c.phase;
      // Inside a wide junction: between two crossings whose lights change together.
      lane.inner = c.control === 'signal' && !!from.signal && from.signal.offset === to.signal.offset && len < INNER_LINK;
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
    const p0 = a.pts[a.pts.length - 1], p3 = b.pts[0];
    const [ux, uz] = a.endDir, [vx, vz] = b.startDir;
    // A cubic that leaves along lane a and arrives along lane b, so the car's
    // heading never jumps: its handles are longer the further apart the lanes
    // are, and for a turn back (a dead end) long enough to make a loop of it.
    const d = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]), back = ux * vx + uz * vz < -0.3;
    const h = back ? Math.max(4, d * 0.9) : d * 0.38;
    const p1 = [p0[0] + ux * h, p0[1] + uz * h], p2 = [p3[0] - vx * h, p3[1] - vz * h];
    const pts = [];
    for (let i = 0; i <= 18; i++) {
      const t = i / 18, m = 1 - t, b0 = m * m * m, b1 = 3 * m * m * t, b2 = 3 * m * t * t, b3 = t * t * t;
      pts.push([b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0], b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1]]);
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
      const road = roads[Math.floor(Math.random() * roads.length)];
      if (Math.random() > (BUSY[road.cls] ?? 0.3)) continue;
      const lanes = this.lanesOf(road);
      const lane = lanes[Math.floor(Math.random() * lanes.length)];
      if (!lane) continue;
      if (lane.len < 12) continue;
      const s = 3 + Math.random() * (lane.len - 6), p = pointAt(lane, s, {});
      const d = Math.hypot(p.x - player.x, p.z - player.z);
      if (d < minD || d > maxD) continue;
      if (lane.cars.some((o) => Math.abs(o.s - s) < 12)) continue;
      const next = this.choose(lane);
      if (!next) continue;
      const kind = pickShape(BUS_STREETS.has(lane.road.cls) && lane.len > 30);
      if (lane.cars.some((o) => Math.abs(o.s - s) < 8 + (kind.length + o.kind.length) / 2)) continue;
      const taxi = kind.name === 'sedan' && Math.random() < 0.12;
      const c = {
        id: this.nextId++, lane, s, conn: null, next, v: lane.speed * 0.6, x: p.x, z: p.z, dx: p.dx, dz: p.dz, cs: 0,
        kind, color: taxi ? TAXI_PAINT : pickPaint(kind), taxi, mood: (0.88 + Math.random() * 0.2) * (kind.pace ?? 1),
        stoppedAt: null, stuck: 0, braking: false, behind: null,
        turn: 0,     // turn signal: -1 left, 1 right
        halt: 0,     // s left stopped after a crash, hazards on
        side: 0,     // m moved to the right of its lane, making way for a siren
        honked: 0,   // clock when it last honked
        // Physics (see step()): speed along the car and across it (m/s, + right),
        // yaw rate (rad/s, + right), front wheels' angle, the accel it's making.
        vy: 0, yaw: 0, steer: 0, steerWant: 0, acc: 0, want: 0, panic: false, hold: false,
        wx: 0, wz: 0, // its velocity on the ground (for the player's collisions)
        pitch: 0, pitchV: 0, roll: 0, rollV: 0, ay: 0, // the body on its springs (rad, + nose down, + leaning left)
        // The driver: how long it takes to react to the player, how alarmed it is, swerving (m right of its lane).
        react: 0.35 + Math.random() * 0.5, alert: 0, dodge: 0, dodgeWant: 0, lost: false,
      };
      this.place(c);
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
    const ci = Math.floor(c.x / CAR_CELL), cj = Math.floor(c.z / CAR_CELL), reach = Math.ceil(look / CAR_CELL), way = this.way(c);
    for (let i = ci - reach; i <= ci + reach; i++) {
      for (let j = cj - reach; j <= cj + reach; j++) {
        for (const o of this.grid.get(i * 7919 + j) ?? []) {
          if (o === c) continue;
          // Ahead on its way (lane, crossing, next lane, next crossing): the gap along it.
          const along = this.along(c, o, way);
          if (along !== null) {
            if (along > -o.kind.length && along <= look && (!best || along < best.gap)) best = { gap: along, v: o.v, other: o };
            continue;
          }
          // Others on its way: in the crossing ahead, or the next lane.
          const onWay = o.conn ? o.conn.node === (c.conn ? c.conn.node : c.lane.to) : o.lane === c.next || (!c.conn && o.lane === c.lane);
          if (onWay) test(o.x, o.z, o.kind.length, o.v, o);
        }
      }
    }
    const before = best;
    test(player.x, player.z, 4.6, player.speed, null);
    if (best !== before) best.player = true;
    for (const u of this.extra) test(u.x, u.z, u.length, u.v, null); // patrol cars (police.js)
    // Two cars that see each other (nose to nose in a crossing): the older one goes.
    if (best?.other) {
      const o = best.other, rx = c.x - o.x, rz = c.z - o.z, f = rx * o.dx + rz * o.dz;
      if (f > 0 && Math.abs(rz * o.dx - rx * o.dz) < 1.9 && o.dx * fx + o.dz * fz < 0.3 && c.id < o.id) best = null;
    }
    return best;
  }

  // The pieces of car c's way from where it is: [{ p: path, off: where it
  // starts, m from c's front axle }], through the next two crossings.
  way(c) {
    const w = [];
    let off = -(c.conn ? c.cs : c.s);
    const add = (p) => { w.push({ p, off }); off += p.len; };
    add(c.conn ?? c.lane);
    if (c.next) {
      if (!c.conn) add(this.connector(c.lane, c.next));
      add(c.next);
      if (c.after) add(this.connector(c.next, c.after));
    }
    return w;
  }

  // How far car o is ahead of car c along c's way (`way`, from way()), bumper
  // to bumper (m); null if o isn't on it. A car just into a crossing from a
  // lane on the way counts too, whichever way it turns there.
  along(c, o, way) {
    const path = o.conn ?? o.lane, s = o.conn ? o.cs : o.s;
    let d = null;
    for (const w of way) {
      if (w.p === path) { d = w.off + s; break; }
      if (o.conn && w.p === o.lane && o.cs < 6) { d = w.off + w.p.len + o.cs; break; }
    }
    if (d === null || d < -0.5) return null;
    return d - 0.8 * o.kind.length - 0.2 * c.kind.length; // front axle to front bumper is 0.2 of a car
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
    // Where the player's car is going, as the drivers see it.
    const seen = this.foresee(player);
    const steps = Math.ceil(dt / SIM_STEP - 1e-6), h = dt / steps;
    const gone = [];
    for (const c of this.cars) {
      const d = Math.hypot(c.x - player.x, c.z - player.z);
      if (d > SPAWN_FAR || (c.stuck > 40 && d > 70) || (c.lost && c.stuck > 12 && d > 50)) { gone.push(c); continue; }
      this.drive(c, player, seen, d, dt);
      for (let i = 0; i < steps; i++) this.step(c, h);
      this.follow(c, player, gone);
    }
    for (const c of gone) this.remove(c);
    // Keep the numbers up: new cars out of sight.
    if (this.cars.length < TRAFFIC_COUNT) this.spawn(player, 160, SPAWN_NEAR);
  }

  // The driver of car c: the speed it wants, the throttle or brake for it, and
  // where it steers. `seen`: the player's car over the next seconds (foresee()),
  // `dist`: how far away it is now.
  drive(c, player, seen, dist, dt) {
    // Speed wanted: the street's, slowing for the turn ahead or to stop at the line.
    let target = c.lane.speed * c.mood, need = 0;
    const look = Math.max(12, c.v * 3 + 8);
    if (c.conn) {
      target = Math.min(target, c.conn.vmax);
    } else {
      const dEnd = c.lane.len - c.s;
      if (dEnd < 70) {
        const stop = this.mustStop(c, player, dEnd);
        const vEnd = stop ? 0 : c.next ? this.connector(c.lane, c.next).vmax : 0;
        // (Stops are aimed a little short of the line: the brakes take a moment to come in.)
        target = Math.min(target, Math.sqrt(vEnd * vEnd + 2 * COMFORT_BRAKE * Math.max(0, dEnd - (stop ? 0.9 : 0))));
        if (stop && dEnd < 1.1) target = 0;
        // The braking it takes to stop at the line from here.
        if (stop) need = (c.v * c.v) / (2 * Math.max(0.15, dEnd - 0.9 - c.v * 0.12));
        // At a stop sign: stopped at the line, now waiting for its turn.
        if (c.lane.control === 'stop' && c.stoppedAt === null && dEnd < 2 && c.v < 0.4) {
          c.stoppedAt = this.clock;
          c.lane.to.queue.push(c);
        }
      }
    }
    // A stop at the end of the next piece of the same street (streets are cut
    // in pieces between crossings too): seen from here, not when it's reached.
    const nx = c.next;
    if (nx && nx.len < 60 && !(c.conn ? c.conn.node : c.lane.to).crossing) {
      const halt = nx.control === 'stop' || (nx.control === 'signal' && signalState(this.clock, nx.to.signal.offset, nx.phase) !== 'green');
      if (halt) target = Math.min(target, Math.sqrt(2 * COMFORT_BRAKE * ((c.conn ? c.conn.len - c.cs : c.lane.len - c.s + 1) + nx.len)));
    }
    // The turn after the next lane, when that lane is short: it's planned for
    // now, so a car never arrives at a tight corner too fast to make it.
    if (nx && c.after === undefined) c.after = this.choose(nx);
    if (nx && c.after && nx.len < 60) {
      const d2 = (c.conn ? c.conn.len - c.cs : c.lane.len - c.s + this.connector(c.lane, nx).len) + nx.len;
      const v2 = this.connector(nx, c.after).vmax;
      target = Math.min(target, Math.sqrt(v2 * v2 + 2 * COMFORT_BRAKE * Math.max(0, d2)));
    }
    const a = this.ahead(c, player, look);
    if (a) target = Math.min(target, Math.max(0, Math.min(Math.sqrt(2 * 3.5 * Math.max(0, a.gap - 2)), a.v + (a.gap - 2 - c.v * 1.2) * 0.6)));
    // The player stopped right in front of it for a while: a honk.
    if (a && a.player && a.gap < 6 && c.stuck > 2.5 && this.clock - c.honked > 6 && Math.abs(player.speed) < 0.5 && !this.waiting(c)) this.honk(c);

    // The player's car coming at it: once the driver has reacted, as much brake
    // as it takes (a swerve when that's not enough), or away out of its way.
    let panic = false, push = false;
    const t = dist < WATCH && c.halt <= 0 ? this.threat(c, seen) : null;
    c.alert = t ? c.alert + dt : Math.max(0, c.alert - dt * 0.5);
    c.dodgeWant = 0;
    if (t && c.alert < c.react) {
      target = Math.min(target, c.v); // seen it: off the throttle, foot over the brake
    } else if (t && t.front) {
      const room = t.dist - 1.2, want = (c.v * c.v) / (2 * Math.max(0.3, room));
      target = Math.min(target, Math.sqrt(2 * 4 * Math.max(0, room)));
      if (want > 2.2) need = Math.max(need, want);
      panic = want > 4.5;
      // Braking won't do it: swerve, behind the player's car if it's crossing,
      // else away from it (to the right when it comes head on).
      if (want > 6.5 && t.t < 2) {
        let side = Math.abs(t.across) > 2 ? -Math.sign(t.across) : Math.abs(t.l) < 0.6 ? 1 : -Math.sign(t.l);
        let room = side > 0 ? this.room(c) : this.leftRoom(c);
        if (room < 0.6 && Math.abs(t.l) < 0.6) { side = -side; room = side > 0 ? this.room(c) : this.leftRoom(c); }
        if (room >= 0.6) c.dodgeWant = side * Math.min(room, 2.4);
      }
    } else if (t && t.beside && c.v > 1 && !this.waiting(c)) {
      push = true; // about to be hit in its rear half: on the gas, out of the way
    }
    if ((panic || push) && this.clock - c.honked > 4) this.honk(c);

    // Hit a moment ago: stopped, hazards on.
    if (c.halt > 0) { c.halt -= dt; target = 0; }
    // A siren coming up behind: over to the right, and stop (not in a crossing).
    const siren = !c.conn && this.sirenBehind(c);
    if (siren) target = Math.min(target, 1.5);
    c.side += Math.max(-dt * 1.2, Math.min(dt * 1.6, (siren ? this.room(c) : 0) - c.side));
    const dr = c.dodgeWant ? 3.5 * dt : 1.2 * dt;
    c.dodge += Math.max(-dr, Math.min(dr, c.dodgeWant - c.dodge));
    // Knocked off its path: back to it slowly.
    if (c.lost) target = Math.min(target, 4);
    // Signal for the turn ahead.
    c.turn = 0;
    if (c.next && (c.conn || c.lane.len - c.s < 45)) {
      const tn = c.lane.endDir[0] * c.next.startDir[1] - c.lane.endDir[1] * c.next.startDir[0];
      c.turn = tn > 0.4 ? 1 : tn < -0.4 ? -1 : 0;
    }
    let acc = Math.max(-7, Math.min(c.kind.accel ?? 1.8, (target - c.v) * 2));
    // Steady on the brakes all the way to the line, rather than late and hard;
    // and the last bit firmly, not creeping up to it.
    if (need > 1.5) acc = Math.min(acc, -Math.min(HARD_BRAKE, need));
    if (target < 0.05 && c.v < 2) acc = Math.min(acc, -Math.max(1.5, c.v * 2));
    if (push) acc = Math.max(acc, (c.kind.accel ?? 1.8) * 1.3);
    // Held at the line it just reached (follow()), or wrecked: on the brakes.
    const hold = c.hold;
    if (hold) acc = Math.min(acc, -HARD_BRAKE);
    if (c.halt > 0) acc = -HARD_BRAKE;
    c.hold = false;
    c.want = acc;
    c.panic = panic || c.halt > 0 || hold;
    c.braking = acc < -0.6 || (c.v < 0.3 && target < 0.3);
    c.stuck = c.v < 0.2 && c.halt <= 0 ? c.stuck + dt : 0;
    c.steerWant = this.aim(c);
  }

  honk(c) {
    c.honked = this.clock;
    this.events.push({ kind: 'honk', car: c });
  }

  // The player's car over the next FORESEE s, its speed and rate of turn held:
  // [{ t, x, z, fx, fz }] (fx, fz: the way it points), and its speed.
  foresee(player) {
    const out = [];
    let x = player.x, z = player.z, hd = player.heading, vx = player.vx, vz = player.vz;
    const yaw = Math.max(-1.2, Math.min(1.2, player.yaw ?? 0)), a = yaw * FORESEE_STEP, ca = Math.cos(a), sa = Math.sin(a);
    for (let t = 0; t <= FORESEE + 1e-6; t += FORESEE_STEP) {
      out.push({ t, x, z, fx: -Math.sin(hd), fz: -Math.cos(hd) });
      // (Heading up turns it left: forward (-sin h, -cos h) turns with it.)
      const rx = vx * ca + vz * sa, rz = vz * ca - vx * sa;
      x += (vx + rx) * 0.5 * FORESEE_STEP; z += (vz + rz) * 0.5 * FORESEE_STEP;
      vx = rx; vz = rz; hd += a;
    }
    out.speed = Math.hypot(player.vx, player.vz);
    return out;
  }

  // Whether car c, going on along its path at its speed, meets the player's car
  // as foreseen: the first moment their outlines (with a margin) overlap, as
  // { t, dist: how far c can go before that (m), l: where the player's car is
  // then, m right of c, across: how fast it's crossing c's path then (+ to the right), front: ahead of c's middle (braking helps), beside: at
  // its rear half (getting on helps) }; null if they don't.
  threat(c, seen) {
    const k = c.kind, L2 = k.length / 2, W2 = k.width / 2, back = k.length * 0.3;
    const p0 = seen[0];
    if (Math.hypot(p0.x - c.x, p0.z - c.z) - L2 - PLAYER_HALF[0] > (Math.max(0, c.v) + seen.speed) * FORESEE + 1) return null;
    for (const p of seen) {
      let cx, cz, dx, dz;
      if (p.t === 0) { cx = c.x; cz = c.z; dx = c.dx; dz = c.dz; }
      else { const q = this.routePoint(c, Math.max(0, c.v) * p.t, THREAT_PT); dx = q.dx; dz = q.dz; cx = q.x - dx * back; cz = q.z - dz * back; }
      const rx = p.x - cx, rz = p.z - cz, f = rx * dx + rz * dz, l = -rx * dz + rz * dx;
      const co = Math.min(1, Math.abs(p.fx * dx + p.fz * dz)), si = Math.sqrt(1 - co * co);
      const ef = co * PLAYER_HALF[0] + si * PLAYER_HALF[1], el = si * PLAYER_HALF[0] + co * PLAYER_HALF[1];
      if (Math.abs(f) < L2 + ef + 0.6 && Math.abs(l) < W2 + el + 0.35) {
        // Which way the player's car is crossing c's path (m/s, + to c's right).
        const q = seen[Math.min(seen.length - 1, seen.indexOf(p) + 1)], o = seen[Math.max(0, seen.indexOf(p) - 1)];
        const across = q === o ? 0 : (-(q.x - o.x) * dz + (q.z - o.z) * dx) / (q.t - o.t);
        return { t: p.t, dist: Math.max(0, c.v) * p.t, l, across, front: f > 0, beside: f <= 0 && Math.abs(l) > W2 };
      }
    }
    return null;
  }

  // The point d m ahead of car c's front axle along its way (lane, crossing, next lane).
  routePoint(c, d, out) {
    let path = c.conn ?? c.lane, s = (c.conn ? c.cs : c.s) + d;
    if (s > path.len && c.next) {
      s -= path.len;
      if (c.conn) path = c.next;
      else {
        const cn = this.connector(c.lane, c.next);
        if (s > cn.len) { s -= cn.len; path = c.next; } else path = cn;
      }
    }
    return pointAt(path, Math.min(s, path.len), out);
  }

  // The steering the driver wants: pure pursuit of a point ahead on its way
  // (moved right when making way or swerving), from the rear axle.
  aim(c) {
    const k = c.kind, wb = k.wb;
    const T = this.routePoint(c, Math.min(14, Math.max(2.5, c.v * 0.6 + 2)), AIM_PT);
    const off = c.side + c.dodge, tx = T.x - T.dz * off, tz = T.z + T.dx * off;
    const ex = tx - (c.x - c.dx * k.length * 0.28), ez = tz - (c.z - c.dz * k.length * 0.28), l = Math.hypot(ex, ez) || 1;
    const lat = (-ex * c.dz + ez * c.dx) / l;
    const sinA = ex * c.dx + ez * c.dz > 0 ? lat : lat < 0 ? -1 : 1;
    return Math.max(-MAX_LOCK, Math.min(MAX_LOCK, Math.atan((2 * wb * sinA) / l)));
  }

  // One step of car c's physics: steering and pedals come in at their rates; the
  // tires give what the car asks of them up to the grip it has, shared between
  // braking (or driving) and turning; past that it slides. The body follows on
  // its springs.
  step(c, h) {
    const k = c.kind, wb = k.wb, grip = k.bus ? BUS_GRIP : TRAFFIC_GRIP;
    c.steer += Math.max(-STEER_RATE * h, Math.min(STEER_RATE * h, c.steerWant - c.steer));
    const jerk = c.panic ? PANIC_JERK : JERK;
    c.acc += Math.max(-jerk * h, Math.min(jerk * h, c.want - c.acc));
    let ax = Math.max(-grip, Math.min(grip, c.acc));
    if (c.v < 0) ax = Math.min(grip * 0.8, -c.v / h);  // knocked backward: braked to a stop
    else if (ax < 0) ax = Math.max(ax, -c.v / h);       // brakes stop it, never back it up
    // Sideways: the tires turn it the way its wheels point and kill any slide,
    // with what grip the brakes or throttle leave them.
    const cap = Math.sqrt(Math.max(0, grip * grip - ax * ax));
    const wantAy = c.v * c.yaw - c.vy / 0.08, ay = Math.max(-cap, Math.min(cap, wantAy));
    const held = Math.abs(wantAy) <= cap ? 1 : cap / Math.abs(wantAy);
    const yawTo = (c.v * Math.tan(c.steer)) / wb;
    c.vy += (ay - c.v * c.yaw) * h;
    c.v += (ax + c.vy * c.yaw) * h;
    c.yaw += Math.max(-12, Math.min(12, (yawTo - c.yaw) / 0.12)) * held * h;
    if (Math.abs(c.v) < 0.02 && Math.abs(c.vy) < 0.05 && c.want <= 0.05) {
      c.v = c.vy = 0;
      if (Math.abs(c.yaw) < 0.05) c.yaw = 0;
    }
    const r = c.yaw * h, cr = Math.cos(r), sr = Math.sin(r);
    [c.dx, c.dz] = [c.dx * cr - c.dz * sr, c.dx * sr + c.dz * cr];
    c.wx = c.dx * c.v - c.dz * c.vy; c.wz = c.dz * c.v + c.dx * c.vy;
    c.x += c.wx * h; c.z += c.wz * h;
    // The body: dives under braking, squats under throttle, leans out of turns.
    c.ay += (ay - c.ay) * Math.min(1, h * 12);
    const w = 2 * Math.PI * (k.bus ? 1.1 : 1.5), zeta = 0.45, gain = k.bus ? 0.004 : 0.008;
    c.pitchV += (w * w * (-ax * gain - c.pitch) - 2 * zeta * w * c.pitchV) * h;
    c.rollV += (w * w * (c.ay * gain * 0.9 - c.roll) - 2 * zeta * w * c.rollV) * h;
    c.pitch = Math.max(-0.07, Math.min(0.07, c.pitch + c.pitchV * h));
    c.roll = Math.max(-0.09, Math.min(0.09, c.roll + c.rollV * h));
  }

  // Keeps car c's place on its way in step with where its physics took it: its
  // front axle's distance along the path, onto the next lane through a crossing.
  follow(c, player, gone) {
    const path = c.conn ?? c.lane, s = c.conn ? c.cs : c.s, fa = c.kind.length * 0.3;
    const p = pointAt(path, s, FOLLOW_PT);
    const ex = c.x + c.dx * fa - p.x, ez = c.z + c.dz * fa - p.z;
    let ds = ex * p.dx + ez * p.dz;
    c.lost = Math.abs(-ex * p.dz + ez * p.dx) > LOST + Math.abs(c.side + c.dodge) || c.dx * p.dx + c.dz * p.dz < 0;
    if (ds < 0) {
      if (c.conn) c.cs = Math.max(0, c.cs + ds); else c.s = Math.max(0, c.s + ds);
      ds = 0;
    }
    this.advance(c, ds, player, gone);
  }

  // Moves car c's place ds along its way, through crossings.
  advance(c, ds, player, gone) {
    for (let guard = 0; guard < 4; guard++) {
      if (c.conn) {
        c.cs += ds;
        if (c.cs < c.conn.len) break;
        ds = c.cs - c.conn.len;
        c.conn.node.inside.delete(c);
        c.behind = c.conn;
        c.conn = null;
        c.lane = c.next;
        c.lane.cars.push(c);
        c.s = 0;
        c.next = c.after ?? this.choose(c.lane);
        c.after = undefined;
        c.stoppedAt = null;
        continue;
      }
      c.s += ds;
      if (c.s < c.lane.len) break;
      // A dead end (the map's edge): the car goes away, unless the player sees it.
      if (!c.next && Math.hypot(c.x - player.x, c.z - player.z) > 50) { gone.push(c); return; }
      // At the line and told to stop: it stops there, unless it's still going too
      // fast to (a light that just changed, a gap that just closed): then it goes through.
      if (!c.next || (c.v < 3 && this.mustStop(c, player, 0))) { c.s = c.lane.len; c.hold = true; break; }
      ds = c.s - c.lane.len;
      const q = c.lane.to.queue.indexOf(c);
      if (q >= 0) c.lane.to.queue.splice(q, 1);
      c.lane.cars.splice(c.lane.cars.indexOf(c), 1);
      c.behind = c.lane;
      c.conn = this.connector(c.lane, c.next);
      c.conn.node.inside.add(c);
      c.cs = 0;
    }
  }

  // Puts a new car c on its path at its place: front axle at c.s, rear axle a
  // wheelbase back along it, the car the line between them.
  place(c) {
    const path = c.lane, wb = c.kind.length * 0.58;
    const f = pointAt(path, c.s, POSE_F), r = pointAt(path, Math.max(0, c.s - wb), POSE_R);
    let dx = f.x - r.x, dz = f.z - r.z;
    const l = Math.hypot(dx, dz);
    if (l > 0.5) { dx /= l; dz /= l; } else { dx = f.dx; dz = f.dz; }
    const back = c.kind.length * 0.3;
    c.x = f.x - dx * back; c.z = f.z - dz * back;
    c.dx = dx; c.dz = dz;
    c.wx = dx * c.v; c.wz = dz * c.v;
  }

  // Whether car c has its own reason to stand still: a red light or a stop sign ahead.
  waiting(c) {
    if (c.conn) return false;
    const l = c.lane;
    if (l.control === 'signal') return signalState(this.clock, l.to.signal.offset, l.phase) !== 'green';
    return l.control === 'stop' && l.len - c.s < 25;
  }

  // A patrol car on its way (siren on) close behind car c, going the same way.
  sirenBehind(c) {
    for (const u of this.extra) {
      if (u.static || u.v < 6) continue;
      const rx = u.x - c.x, rz = u.z - c.z, f = rx * c.dx + rz * c.dz;
      if (f > 0 || f < -SIREN_REACH || Math.abs(rz * c.dx - rx * c.dz) > 6) continue;
      if (u.dx * c.dx + u.dz * c.dz > 0.5) return true;
    }
    return false;
  }

  // How far right of its lane car c can go before the curb (m).
  room(c) {
    const r = c.lane.road;
    return Math.max(0, Math.min(1.7, r.w - c.lane.off - c.kind.width / 2 - 0.25));
  }

  // How far left of its lane car c can swerve (m): to the far curb of a one-way
  // street, a little over the middle line of a two-way one.
  leftRoom(c) {
    const r = c.lane.road, hw = c.kind.width / 2;
    return Math.max(0, Math.min(2.5, r.oneWay ? r.w + c.lane.off - hw - 0.25 : c.lane.off + 0.3));
  }

  // The player's car shoved car c: its middle's velocity changes by (dvx, dvz),
  // pushed at (px, pz), which also sets it turning.
  knock(c, dvx, dvz, px, pz) {
    if (c.parked) return;
    const k = c.kind, rx = px - c.x, rz = pz - c.z;
    c.v += dvx * c.dx + dvz * c.dz;
    c.vy += -dvx * c.dz + dvz * c.dx;
    c.yaw = Math.max(-3, Math.min(3, c.yaw + ((rx * dvz - rz * dvx) * 12) / (k.length ** 2 + k.width ** 2)));
    c.wx += dvx; c.wz += dvz;
    c.panic = true;
  }

  // The player ran into car c at `speed` m/s: it brakes to a stop, hazards on, for a while.
  hit(c, speed) {
    if (c.parked || speed < 2) return;
    c.halt = HALT_TIME + Math.random() * 4;
    if (this.clock - c.honked > 2) this.honk(c);
  }

  // What happened since the last call (honks, for the sound).
  take() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // --- parked cars -----------------------------------------------------------
  // Along road r's curbs, where no lane runs: both sides of the bigger streets,
  // the left side of one-way side streets. The same cars every time (by the
  // road's number), made when the road's cell is drawn.
  park(r) {
    if (r.parked || !r.a) return;
    r.parked = [];
    const big = BUS_STREETS.has(r.cls), sideStreet = r.oneWay && (r.cls === 'residential' || r.cls === 'unclassified');
    if (!big && !sideStreet) return;
    const path = r.path ?? (r.path = polyPath(r.pts));
    const s0 = r.a.r + 9, s1 = path.len - r.b.r - 9;
    if (s1 - s0 < PARK_SLOT) return;
    let seed = (r.index * 2654435761) >>> 0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const fill = big ? 0.32 + 0.3 * rnd() : 0.45 + 0.35 * rnd(); // how full this street's curb is
    const o = {};
    for (const side of big ? [1, -1] : [-1]) {
      for (let s = s0 + PARK_SLOT / 2; s < s1; s += PARK_SLOT) {
        if (rnd() > fill) continue;
        const kind = PARKED_SHAPES[Math.floor(rnd() * PARKED_SHAPES.length)];
        pointAt(path, s + (rnd() - 0.5) * 0.8, o);
        // Right of the way the points run is (-dz, dx); cars face the way their side drives.
        const off = side * (r.w - kind.width / 2 - 0.22), face = r.oneWay ? 1 : side;
        const c = {
          parked: true, x: o.x - o.dz * off, z: o.z + o.dx * off, dx: o.dx * face, dz: o.dz * face, v: 0,
          kind, color: CAR_PAINTS[Math.floor(rnd() * CAR_PAINTS.length)], braking: false, turn: 0, halt: 0,
        };
        r.parked.push(c);
        const k = Math.floor(c.x / PARK_CELL) * 7919 + Math.floor(c.z / PARK_CELL);
        if (!this.parked.has(k)) this.parked.set(k, []);
        this.parked.get(k).push(c);
      }
    }
  }

  // Takes away the parked cars within r m of (x, z): where the player's car is put down.
  unpark(x, z, r) {
    for (const c of this.parkedNear(x, z, r)) {
      for (const list of [this.parked.get(Math.floor(c.x / PARK_CELL) * 7919 + Math.floor(c.z / PARK_CELL))]) list.splice(list.indexOf(c), 1);
    }
  }

  // Parked cars within r m of (x, z).
  parkedNear(x, z, r, out = []) {
    const i0 = Math.floor((x - r) / PARK_CELL), i1 = Math.floor((x + r) / PARK_CELL);
    const j0 = Math.floor((z - r) / PARK_CELL), j1 = Math.floor((z + r) / PARK_CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const c of this.parked.get(i * 7919 + j) ?? []) if (Math.hypot(c.x - x, c.z - z) < r) out.push(c);
      }
    }
    return out;
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
    const pi = Math.floor(x / PARK_CELL), pj = Math.floor(z / PARK_CELL), fx = x / PARK_CELL - pi, fz = z / PARK_CELL - pj;
    // A parked car reaches at most ~3 m over its cell's edge.
    for (const i of fx < 0.06 ? [pi - 1, pi] : fx > 0.94 ? [pi, pi + 1] : [pi]) {
      for (const j of fz < 0.06 ? [pj - 1, pj] : fz > 0.94 ? [pj, pj + 1] : [pj]) {
        for (const c of this.parked.get(i * 7919 + j) ?? []) if (Math.abs(c.x - x) < 4 && Math.abs(c.z - z) < 4) hit(c);
      }
    }
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
    for (const r of roads) {
      this.park(r);
      // Street lamps down the bigger streets, on alternate sides, arm over the roadway.
      if (!r.a || !BUS_STREETS.has(r.cls)) continue;
      const path = r.path ?? (r.path = polyPath(r.pts)), o = {};
      for (let s = r.a.r + 14, k = r.index; s < path.len - r.b.r - 10; s += 38, k++) {
        pointAt(path, s, o);
        const side = k % 2 ? 1 : -1, rgt = [-o.dz * side, o.dx * side], face = [o.dx, o.dz];
        const off = r.w + 0.7, base = [o.x + rgt[0] * off, o.z + rgt[1] * off];
        box(poles, [base[0], 3.6, base[1]], rgt, face, 0.14, 7.2, 0.14);
        box(poles, [base[0] - rgt[0] * 1.0, 7.15, base[1] - rgt[1] * 1.0], rgt, face, 2.1, 0.09, 0.09);
        box(poles, [base[0] - rgt[0] * 1.9, 7.08, base[1] - rgt[1] * 1.9], rgt, face, 0.55, 0.12, 0.26);
      }
    }
    // Whether a pole may stand at (x, z): not on any street's asphalt, not in a building.
    const stands = (x, z) => {
      const at = this.map.locate(x, z);
      return !(at.road && at.edge < 0.25) && !this.map.blocked(x, z);
    };
    // The first of the spots tried that a pole may stand on.
    const spot = (...tries) => tries.find(([x, z]) => stands(x, z));
    for (const lane of roads.flatMap((r) => this.lanesOf(r))) {
      if (lane.control !== 'signal' && lane.control !== 'stop') continue;
      // Inside a wide junction: no line, no lights of its own.
      if (lane.inner) continue;
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
        // (Further from the roadway, or back from the corner, where another street's asphalt is in the way.)
        const at = (out, back) => [mid[0] + rgt[0] * (side + out) - dx * back, mid[1] + rgt[1] * (side + out) - dz * back];
        const b = spot(at(0, 0), at(0.8, 0), at(0, 2.5), at(0.8, 2.5), at(1.6, 5), at(0, 8));
        if (!b) continue;
        const base = [b[0], 0, b[1]];
        box(poles, [base[0], 1.15, base[2]], rgt, face, 0.07, 2.3, 0.07);
        const c = [base[0] + face[0] * 0.06, 2.35, base[2] + face[1] * 0.06];
        disc(signs, c, rgt, face, 0.38, (u, v) => [0.5 + u * 0.5, 0.5 + v * 0.5]);
        disc(backs, [c[0] - face[0] * 0.01, c[1], c[2] - face[1] * 0.01], [-rgt[0], -rgt[1]], [-face[0], -face[1]], 0.38);
      } else {
        // Traffic light across the crossing on the right, facing the driver.
        // (Else on the near corner, by the stop line.)
        const n = lane.to, far = n.r - 1;
        const at = (ahead, out) => [mid[0] + dx * ahead + rgt[0] * (side + out), mid[1] + dz * ahead + rgt[1] * (side + out)];
        const base = spot(at(far * 2 + 1, 0), at(far * 2 + 1, 1.2), at(far * 2 + 3, 0.6), at(far * 2 + 3, 2), at(0, 0), at(0, 1), at(-2, 0.6));
        if (!base) continue;
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
// Shapes in car frame (x right, y up, z back), on the ground; lengths along
// the car are `s`, meters back from the front bumper. `top` is the painted
// body's top edge along s, `glass` the greenhouse on it (from, to, roof height,
// windscreen and rear window run). Parts by how they're drawn: paint, glass,
// dark trim and tires, head and tail lights, turn signals per side, and an
// accent (the bus's stripe). `mass` (kg): for who gets shoved how far in a crash.
const CAR_SHAPES = [
  { name: 'sedan', mass: 1500, weight: 6, length: 4.7, width: 1.82, clear: 0.22, wheel: 0.33,
    top: [[0, 0.6], [0.25, 0.76], [1.3, 0.9], [3.7, 0.92], [4.5, 0.9], [4.7, 0.72]], glass: [1.3, 3.95, 1.43, 0.8, 0.85] },
  { name: 'suv', mass: 2000, weight: 5, length: 4.8, width: 1.92, clear: 0.3, wheel: 0.37,
    top: [[0, 0.78], [0.25, 0.98], [1.25, 1.08], [4.6, 1.1], [4.8, 0.92]], glass: [1.25, 4.72, 1.72, 0.6, 0.3] },
  { name: 'hatch', mass: 1250, weight: 5, length: 4.1, width: 1.76, clear: 0.24, wheel: 0.31,
    top: [[0, 0.62], [0.25, 0.8], [1.1, 0.92], [3.95, 0.95], [4.1, 0.78]], glass: [1.1, 4.03, 1.46, 0.7, 0.45] },
  { name: 'pickup', mass: 2200, weight: 2, length: 5.5, width: 2.0, clear: 0.34, wheel: 0.4,
    top: [[0, 0.85], [0.25, 1.05], [1.4, 1.15], [5.3, 1.15], [5.5, 1.0]], glass: [1.4, 3.35, 1.82, 0.55, 0.15] },
  { name: 'van', mass: 2300, weight: 2, length: 5.4, width: 2.0, clear: 0.32, wheel: 0.36, pace: 0.94, boxy: true,
    paints: [[0.9, 0.9, 0.9], [0.86, 0.86, 0.84], [0.78, 0.8, 0.82], [0.9, 0.78, 0.2], [0.2, 0.32, 0.5]],
    top: [[0, 0.85], [0.2, 1.05], [0.9, 1.2], [1.85, 1.25], [2.05, 2.3], [5.3, 2.3], [5.4, 2.2]], glass: [0.85, 2.02, 1.95, 0.6, 0.04] },
  // A city bus: only on the bigger streets, slow away from its stops.
  { name: 'bus', mass: 12000, weight: 1.2, bus: true, length: 12, width: 2.55, clear: 0.34, wheel: 0.48, pace: 0.85, accel: 1.1, boxy: true,
    axles: [2.7, 8.6], paints: [[0.93, 0.94, 0.95]], accent: [0.0, 0.42, 0.75],
    top: [[0, 2.85], [0.3, 3.05], [11.8, 3.05], [12, 2.9]] },
];
const PARKED_SHAPES = CAR_SHAPES.filter((k) => !k.bus && k.name !== 'van');
const CAR_PAINTS = [
  [0.9, 0.9, 0.9], [0.08, 0.08, 0.09], [0.55, 0.56, 0.58], [0.33, 0.34, 0.36], [0.12, 0.2, 0.42],
  [0.55, 0.08, 0.08], [0.85, 0.85, 0.82], [0.2, 0.3, 0.25], [0.7, 0.62, 0.48], [0.15, 0.32, 0.6],
  [0.62, 0.64, 0.66], [0.1, 0.11, 0.13], [0.36, 0.12, 0.1], [0.8, 0.45, 0.1],
];
const TAXI_PAINT = [0.95, 0.74, 0.08];

// A shape for a new car, by weight (buses only where they fit).
function pickShape(busOk) {
  const opts = busOk ? CAR_SHAPES : CAR_SHAPES.filter((k) => !k.bus);
  let r = Math.random() * opts.reduce((s, k) => s + k.weight, 0);
  for (const k of opts) if ((r -= k.weight) < 0) return k;
  return opts[0];
}
const pickPaint = (k) => { const p = k.paints ?? CAR_PAINTS; return p[Math.floor(Math.random() * p.length)]; };

export function carMeshes() {
  const C = cube(), W = cylinder(12);
  return CAR_SHAPES.map((k) => {
    const m = { paint: {}, glass: {}, trim: {}, head: {}, tail: {}, blinkL: {}, blinkR: {}, accent: {} };
    for (const key in m) { m[key].positions = []; m[key].normals = []; }
    const box = (part, src, cx, cy, cz, sx, sy, sz) => {
      for (let i = 0; i < src.positions.length; i += 3) {
        part.positions.push(cx + src.positions[i] * sx, cy + src.positions[i + 1] * sy, cz + src.positions[i + 2] * sz);
        // Scaled normals stay right for boxes and the wheel's axis-aligned parts.
        part.normals.push(src.normals[i], src.normals[i + 1], src.normals[i + 2]);
      }
    };
    // A lofted surface (bodies.js), added as plain triangles.
    const skin = (part, stations, seg, n) => {
      const l = loft(stations, seg, n);
      for (const i of l.indices) {
        part.positions.push(l.positions[i * 3], l.positions[i * 3 + 1], l.positions[i * 3 + 2]);
        part.normals.push(l.normals[i * 3], l.normals[i * 3 + 1], l.normals[i * 3 + 2]);
      }
    };
    const L = k.length, hw = k.width / 2, toZ = (s) => s - L / 2;
    const axles = k.axles ?? [0.92, L - 0.98];
    const top = profile(k.top);
    // The body's lower edge rises over each wheel (the arches); its corners are rounded in plan.
    const R = k.wheel + 0.07;
    const arch = (s) => {
      let y = k.clear;
      for (const c of axles) { const d = s - c; if (Math.abs(d) < R) y = Math.max(y, k.wheel + Math.sqrt(R * R - d * d)); }
      return y;
    };
    const width = (s) => hw - 0.12 * Math.max(0, 1 - Math.min(s, L - s) / 0.4) ** 2;
    const stations = [];
    for (let i = 0, n = Math.round(L / 0.16); i <= n; i++) {
      const s = (L * i) / n;
      stations.push({ z: toZ(s), y0: arch(s), y1: top(s), w: width(s), pinch: k.boxy ? 0.02 : 0.05 });
    }
    skin(m.paint, stations, 12, k.boxy ? 7 : 4.5);
    // Dark tub between the wheels, so the arches aren't see-through.
    box(m.trim, C, 0, (k.clear + 0.02 + Math.min(...k.top.map((t) => t[1])) - 0.05) / 2, 0, k.width - 0.56, Math.min(...k.top.map((t) => t[1])) - 0.07 - k.clear, L - 0.3);
    if (k.glass) {
      const [g0, g1, roofY, rf, rr] = k.glass, pinch = k.boxy ? 0.1 : 0.2, gw = hw - 0.09;
      const roof = profile([[g0, top(g0)], [g0 + rf, roofY], [g1 - rr, roofY], [g1, top(g1) + 0.02]]);
      const gs = [];
      for (let i = 0, n = Math.round((g1 - g0) / 0.18); i <= n; i++) { const s = g0 + ((g1 - g0) * i) / n; gs.push({ z: toZ(s), y0: top(s) - 0.07, y1: roof(s), w: gw, pinch }); }
      skin(m.glass, gs, 12, 3);
      const rs = [];
      for (let i = 0, a = g0 + rf * 0.92, b = g1 - rr * 0.9, n = Math.max(2, Math.round((b - a) / 0.3)); i <= n; i++) { const s = a + ((b - a) * i) / n; rs.push({ z: toZ(s), y0: roofY - 0.08, y1: roofY + 0.012, w: gw * (1 - pinch) * 0.97 }); }
      skin(m.paint, rs, 10, 3);
      for (const sx of [-1, 1]) box(m.paint, C, sx * (hw + 0.07), top(g0 + 0.35) + 0.1, toZ(g0 + 0.4), 0.16, 0.1, 0.08); // mirrors
    } else {
      // The bus: a band of windows down each side, a tall windscreen, a rear window.
      for (const sx of [-1, 1]) box(m.glass, C, sx * (hw - 0.01), 2.0, 0.2, 0.03, 1.0, L - 1.6);
      box(m.glass, C, 0, 1.95, toZ(0) + 0.02, k.width - 0.3, 1.5, 0.06);
      box(m.glass, C, 0, 2.2, toZ(L) - 0.02, k.width - 0.5, 0.8, 0.06);
      for (const sx of [-1, 1]) box(m.accent, C, sx * (hw - 0.005), 0.95, 0, 0.03, 0.5, L - 0.5);
      box(m.accent, C, 0, 0.95, toZ(0) + 0.03, k.width - 0.2, 0.5, 0.06);
      for (const sx of [-1, 1]) box(m.paint, C, sx * (hw + 0.12), 2.3, toZ(0.25), 0.2, 0.3, 0.08); // mirrors
    }
    const yF = top(0) - 0.12, yR = top(L) - 0.1;
    box(m.trim, C, 0, k.clear + 0.1, toZ(0) - 0.01, k.width - 0.2, 0.16, 0.1);   // bumpers
    box(m.trim, C, 0, k.clear + 0.1, toZ(L) + 0.01, k.width - 0.2, 0.16, 0.1);
    box(m.trim, C, 0, yF - 0.02, toZ(0) + 0.005, k.width * 0.4, 0.1, 0.06);       // grille
    for (const c of axles) for (const sx of [-1, 1]) box(m.trim, W, sx * (hw - 0.13), k.wheel, toZ(c), 0.24, 2 * k.wheel, 2 * k.wheel);
    for (const sx of [-1, 1]) {
      box(m.head, C, sx * (hw - 0.48), yF, toZ(0) + 0.01, 0.36, 0.11, 0.06);
      box(m.tail, C, sx * (hw - 0.46), yR, toZ(L) - 0.01, 0.34, 0.12, 0.06);
      const b = sx < 0 ? m.blinkL : m.blinkR;
      box(b, C, sx * (hw - 0.2), yF, toZ(0) + 0.02, 0.14, 0.1, 0.08);
      box(b, C, sx * (hw - 0.2), yR, toZ(L) - 0.02, 0.14, 0.1, 0.08);
    }
    return m;
  });
}
CAR_SHAPES.forEach((k, i) => { k.index = i; k.wb = k.axles ? k.axles[1] - k.axles[0] : k.length * 0.58; });
// The shapes behind carMeshes(), in the same order (the police drive the first two).
carMeshes.shapes = CAR_SHAPES;
