// Police on the open map (Montreal): break the rules (rules.js) and they come
// after you.
//
// - Offences add points; points make the wanted level (1 to 5 stars), and the
//   level sets how many patrol cars chase (up to 4) and how fast they drive.
// - Patrol cars come from streets out of sight, then find their way to the
//   player through the street graph (A* over the traffic's crossings, one-way
//   streets or not: they have their sirens on). Once they see the player close
//   by, they drive straight at them.
// - Busted: a patrol car right beside a car that has stopped (or is wrecked),
//   for 3 s.
// - Escaped: once found, no patrol car sees the player (buildings hide them)
//   for 15 s; twice as fast when they're far away.
//
// Patrol cars are pushed out of buildings and other cars like the player is,
// and back up when stuck. The traffic brakes for them as it does for the player.

const STARS = [1, 3, 6, 10, 15];           // points for each star
const UNITS = [0, 1, 2, 3, 4, 4];          // patrol cars chasing, by stars
const SPAWN_MIN = 140, SPAWN_MAX = 260;    // m from the player
const ESCAPE_TIME = 15;                    // s unseen
const BUST_TIME = 3;                       // s held
const SIGHT = 170;                         // m: they can see this far (if nothing's in the way)
const POLICE_LENGTH = 4.7, POLICE_WIDTH = 1.82; // the patrol car (the traffic's sedan)
const LAT_ACCEL = 8.5;                     // m/s² they corner at

export class Police {
  constructor(map, traffic) {
    this.map = map;
    this.traffic = traffic;
    this.nextId = 1;
    this.reset();
  }

  reset() {
    this.units = [];
    this.points = 0;
    this.level = 0;
    this.state = 'clear';  // 'clear' | 'alerted' | 'pursuit' | 'busted'
    this.alert = 0;        // s until the first patrol car is sent
    this.lost = 0;         // s unseen
    this.found = false;    // seen by a patrol car yet (before that, they're still looking)
    this.search = 0;       // s spent looking
    this.bust = 0;         // s held by a patrol car
    this.spawnWait = 0;
    this.clock = 0;
    this.events = [];      // 'busted' | 'escaped'
  }

  get wanted() { return this.level > 0; }

  // Points for an offence.
  add(points) {
    if (this.state === 'busted') return;
    this.points += points;
    this.level = STARS.filter((p) => this.points >= p).length;
    if (this.state === 'clear' && this.level > 0) { this.state = 'alerted'; this.alert = 2; }
    this.lost = 0;
  }

  take() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // player: { x, z, speed, vx, vz, heading }, wrecked: whether the player's car is.
  update(dt, player, wrecked) {
    if (dt <= 0) return;
    this.clock += dt;
    if (this.state === 'alerted' && (this.alert -= dt) <= 0) this.state = 'pursuit';
    if (this.state !== 'pursuit') return;

    // Keep the numbers up: one more every 1.5 s, out of sight.
    this.spawnWait -= dt;
    // Ones left far behind give up; new ones come from closer.
    this.units = this.units.filter((u) => Math.hypot(u.x - player.x, u.z - player.z) < 480);
    if (this.units.length < UNITS[this.level] && this.spawnWait <= 0) {
      this.spawn(player);
      this.spawnWait = 1.5;
    }

    let seen = false, nearest = Infinity;
    for (const u of this.units) {
      this.drive(u, dt, player);
      const d = Math.hypot(u.x - player.x, u.z - player.z);
      nearest = Math.min(nearest, d);
      if (u.sees) seen = true;
    }

    // Held: a patrol car beside the player's stopped car.
    const held = nearest < 9 && (Math.abs(player.speed) < 2 || wrecked);
    this.bust = held ? this.bust + dt : Math.max(0, this.bust - dt * 2);
    if (this.bust >= BUST_TIME) {
      // They stay, stopped around the car, until it's taken away (reset()).
      this.events.push({ kind: 'busted', points: this.points, level: this.level });
      this.state = 'busted';
      for (const u of this.units) u.v = 0;
      return;
    }
    // Hidden from all of them (once they've found the player; if they never
    // do, they give up after a long search).
    if (seen) this.found = true;
    this.search += dt;
    this.lost = seen ? 0 : this.found ? this.lost + dt * (nearest > 350 ? 2 : 1) : 0;
    if (this.lost >= ESCAPE_TIME || (!this.found && this.search > 45)) {
      this.events.push({ kind: 'escaped', level: this.level });
      this.reset();
    }
  }

  // What the HUD shows.
  status() {
    if (this.state === 'alerted') return 'Police alerted';
    if (this.state === 'busted') return 'Busted';
    if (this.state !== 'pursuit') return '';
    if (this.bust > 0.2) return `Pulled over ${Math.max(0, BUST_TIME - this.bust).toFixed(1)} s`;
    if (!this.found) return 'Police on the way';
    if (this.lost > 0.5) return `Hiding ${Math.ceil(ESCAPE_TIME - this.lost)} s`;
    const n = this.units.length;
    return n ? `Pursuit · ${n} unit${n > 1 ? 's' : ''}` : 'Pursuit';
  }

  // --- patrol cars ---------------------------------------------------------
  spawn(player) {
    const roads = this.map.roadsNear(player.x, player.z, SPAWN_MAX).filter((r) => r.a);
    if (!roads.length) return;
    const fx = -Math.sin(player.heading), fz = -Math.cos(player.heading);
    for (let tries = 0; tries < 60; tries++) {
      const r = roads[Math.floor(Math.random() * roads.length)];
      const k = Math.floor(Math.random() * r.pts.length), [x, z] = r.pts[k];
      const d = Math.hypot(x - player.x, z - player.z);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
      // Rather not in front of the player, where they'd be seen popping up.
      if (tries < 40 && ((x - player.x) * fx + (z - player.z) * fz) / d > 0.3) continue;
      if (this.map.blocked(x, z) || this.units.some((o) => Math.hypot(o.x - x, o.z - z) < 20)) continue;
      if (tries < 50 && this.sight({ x, z }, player)) continue;
      const q = r.pts[Math.min(r.pts.length - 1, k + 1)], p = r.pts[Math.max(0, k - 1)];
      let dx = q[0] - p[0], dz = q[1] - p[1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      // Facing the player's way along the street.
      if (dx * (player.x - x) + dz * (player.z - z) < 0) { dx = -dx; dz = -dz; }
      this.units.push({
        id: this.nextId++, x, z, dx, dz, v: 8, path: null, at: 0, replan: 0, look: 0,
        sees: false, stuck: 0, reverse: 0, ghost: 0, length: POLICE_LENGTH, width: POLICE_WIDTH,
      });
      return;
    }
  }

  // Whether unit u can see the player: close enough, and no building between.
  sight(u, player) {
    const dx = player.x - u.x, dz = player.z - u.z, d = Math.hypot(dx, dz);
    if (d > SIGHT) return false;
    for (let s = 6; s < d - 3; s += 6) {
      if (this.map.blocked(u.x + (dx * s) / d, u.z + (dz * s) / d)) return false;
    }
    return true;
  }

  drive(u, dt, player) {
    const d = Math.hypot(player.x - u.x, player.z - u.z);
    if ((u.look -= dt) <= 0) { u.sees = this.sight(u, player); u.look = 0.25; }
    const vmax = 23 + 3 * this.level; // 100 to 140 km/h
    let tx, tz, vt;
    const direct = u.sees && d < 80;
    if (direct || u.reverse > 0) {
      // Straight at the player, aiming a little ahead of them.
      const lead = Math.min(0.7, d / 30);
      tx = player.x + player.vx * lead; tz = player.z + player.vz * lead;
      vt = d < 25 ? Math.max(0, Math.abs(player.speed) + (d - 6) * 0.8) : vmax;
      u.path = null;
    } else {
      if ((u.replan -= dt) <= 0 || !u.path) {
        u.path = this.route(u, player);
        u.at = 0;
        u.replan = 1.5 + Math.random() * 0.5;
      }
      if (!u.path) { tx = player.x; tz = player.z; vt = vmax * 0.6; } else {
        [tx, tz, vt] = this.follow(u, vmax);
      }
    }
    // Turn toward the target, as fast as the speed allows.
    let ax = tx - u.x, az = tz - u.z;
    const al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;
    const cross = u.dx * az - u.dz * ax, dot = u.dx * ax + u.dz * az;
    const err = Math.atan2(cross, dot);
    if (Math.abs(err) > 1.1) vt = Math.min(vt, 7); // sharp turn: slow right down
    if (u.reverse > 0) {
      // Backing out of a wall: steer the other way.
      u.reverse -= dt;
      vt = -5;
    }
    u.v += Math.max(-11 * dt, Math.min(7 * dt, vt - u.v)); // 7 m/s² up, 11 down
    const yawMax = Math.min(2.4, LAT_ACCEL / Math.max(Math.abs(u.v), 1));
    const turn = Math.max(-yawMax, Math.min(yawMax, err * 3)) * dt * (u.v < 0 ? -1 : 1);
    const c = Math.cos(turn), s = Math.sin(turn);
    [u.dx, u.dz] = [u.dx * c - u.dz * s, u.dx * s + u.dz * c];
    u.x += u.dx * u.v * dt;
    u.z += u.dz * u.v * dt;

    // Walls and other cars push it back out.
    let hit = false;
    u.ghost = Math.max(0, u.ghost - dt);
    for (const f of [u.length / 2 - 0.3, 0, -u.length / 2 + 0.3]) {
      for (const side of f === 0 ? [0] : [-0.8, 0.8]) {
        const px = u.x + u.dx * f - u.dz * side, pz = u.z + u.dz * f + u.dx * side;
        const b = this.map.blocked(px, pz) ?? (u.ghost > 0 ? null : this.traffic.blocked(px, pz));
        if (!b) continue;
        u.x += b.nx * (b.depth + 0.02); u.z += b.nz * (b.depth + 0.02);
        hit = true;
      }
    }
    // Not into the player's car either (the player's collisions do the rest).
    const pb = this.playerBox(player, u);
    if (pb) { u.x += pb.nx * pb.depth; u.z += pb.nz * pb.depth; u.v = Math.min(u.v, Math.max(0, Math.abs(player.speed))); }
    if (hit) u.v *= 0.85;
    // Stuck: back up a moment, and go through cars for a bit.
    u.stuck = Math.abs(u.v) < 1 && vt > 2 ? u.stuck + dt : 0;
    if (u.stuck > 1.5) { u.reverse = 1.2; u.stuck = 0; u.ghost = 3; u.replan = 0; }
  }

  // Overlap of patrol car u's nose with the player's car (an oriented box).
  playerBox(player, u) {
    const fx = -Math.sin(player.heading), fz = -Math.cos(player.heading);
    const px = u.x + u.dx * (u.length / 2), pz = u.z + u.dz * (u.length / 2);
    const rx = px - player.x, rz = pz - player.z;
    const f = rx * fx + rz * fz, l = rx * -fz + rz * fx;
    const hl = 2.4, hw = 1.0;
    if (Math.abs(f) > hl || Math.abs(l) > hw) return null;
    return { nx: -u.dx, nz: -u.dz, depth: Math.min(hl - Math.abs(f), hw - Math.abs(l)) + 0.02 };
  }

  // Along unit u's route: the point to steer at and the speed for what's ahead.
  follow(u, vmax) {
    const P = u.path;
    // Nearest point a little ahead of where it was.
    let best = Infinity;
    for (let i = u.at; i < Math.min(P.length, u.at + 12); i++) {
      const d = Math.hypot(P[i][0] - u.x, P[i][1] - u.z);
      if (d < best) { best = d; u.at = i; }
    }
    // Steer at the point ~ a speed-dependent distance down the route.
    const reach = Math.max(7, Math.abs(u.v) * 0.7);
    let i = u.at, s = 0;
    while (i < P.length - 1 && s < reach) { s += Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); i++; }
    // Slow for the corners within braking distance.
    let vt = vmax;
    s = Math.hypot(P[u.at][0] - u.x, P[u.at][1] - u.z);
    const brake = (u.v * u.v) / (2 * 8) + 20;
    for (let k = u.at + 1; k < P.length - 1 && s < brake; k++) {
      const ax = P[k][0] - P[k - 1][0], az = P[k][1] - P[k - 1][1], bx = P[k + 1][0] - P[k][0], bz = P[k + 1][1] - P[k][1];
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      s += la;
      if (la < 0.01 || lb < 0.01) continue;
      const th = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb))));
      if (th < 0.25) continue;
      const vc = Math.max(6.5, Math.sqrt(LAT_ACCEL * Math.max(6, Math.min(la, lb)) / th));
      vt = Math.min(vt, Math.sqrt(vc * vc + 2 * 8 * Math.max(0, s - 4)));
    }
    return [P[i][0], P[i][1], vt];
  }

  // A route from unit u to the player along the streets: a list of points.
  route(u, player) {
    const from = this.map.locate(u.x, u.z), to = this.map.locate(player.x, player.z);
    const ra = from.road?.a ? from.road : null, rb = to.road?.a ? to.road : null;
    if (!ra || !rb) return null;
    if (ra === rb) return [[u.x, u.z], [player.x, player.z]];
    const nearestIdx = (r, x, z) => {
      let k = 0, best = Infinity;
      r.pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - z); if (d < best) { best = d; k = i; } });
      return k;
    };
    const ia = nearestIdx(ra, u.x, u.z), ib = nearestIdx(rb, player.x, player.z);
    const lenOf = (r) => r.len ?? (r.len = r.pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - r.pts[i - 1][0], p[1] - r.pts[i - 1][1]) : 0), 0));
    // A*: from the ends of the unit's street to either end of the player's.
    const goal = new Set([rb.a, rb.b]);
    const g = new Map(), prev = new Map(), heap = [];
    const h = (n) => Math.hypot(n.x - player.x, n.z - player.z);
    const push = (n, cost, p) => {
      if (cost >= (g.get(n) ?? Infinity)) return;
      g.set(n, cost); prev.set(n, p);
      heap.push([cost + h(n), n]);
      let i = heap.length - 1;
      while (i > 0) { const j = (i - 1) >> 1; if (heap[j][0] <= heap[i][0]) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m], heap[i]]; i = m;
        }
      }
      return top;
    };
    push(ra.a, Math.hypot(u.x - ra.a.x, u.z - ra.a.z), null);
    push(ra.b, Math.hypot(u.x - ra.b.x, u.z - ra.b.z), null);
    let end = null;
    for (let guard = 0; heap.length && guard < 5000; guard++) {
      const [f, n] = pop();
      if (f - h(n) > (g.get(n) ?? Infinity) + 1e-6) continue;
      if (goal.has(n)) { end = n; break; }
      for (const r of n.roads) {
        const o = r.a === n ? r.b : r.a;
        if (o) push(o, g.get(n) + lenOf(r), { node: n, road: r });
      }
    }
    if (!end) return null;
    // Back from the end: the streets in order, each the way it's driven.
    const legs = [];
    for (let n = end; prev.get(n); n = prev.get(n).node) legs.unshift({ road: prev.get(n).road, to: n });
    const pts = [[u.x, u.z]];
    const add = (p) => { const q = pts[pts.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.5) pts.push(p); };
    // Along the unit's own street to the crossing the search set out from.
    let startNode = end;
    while (prev.get(startNode)) startNode = prev.get(startNode).node;
    if (startNode === ra.b) for (let i = ia + 1; i < ra.pts.length; i++) add(ra.pts[i]);
    else for (let i = ia - 1; i >= 0; i--) add(ra.pts[i]);
    for (const { road, to: n } of legs) {
      const p = road.b === n ? road.pts : [...road.pts].reverse();
      for (const q of p) add(q);
    }
    // Into the player's street, up to them.
    if (end === rb.a) for (let i = 0; i <= ib; i++) add(rb.pts[i]);
    else for (let i = rb.pts.length - 1; i >= ib; i--) add(rb.pts[i]);
    add([player.x, player.z]);
    return pts;
  }

  // Whether (x, z) is inside a patrol car, and if so the way out (as the map's blocked()).
  blocked(x, z) {
    let best = null;
    for (const c of this.units) {
      const rx = x - c.x, rz = z - c.z;
      if (rx * rx + rz * rz > 16) continue;
      const f = rx * c.dx + rz * c.dz, l = rx * -c.dz + rz * c.dx;
      const hl = c.length / 2, hw = c.width / 2;
      if (Math.abs(f) > hl || Math.abs(l) > hw) continue;
      const df = hl - Math.abs(f), dl = hw - Math.abs(l);
      const r = df < dl ? { nx: c.dx * Math.sign(f), nz: c.dz * Math.sign(f), depth: df } : { nx: -c.dz * Math.sign(l), nz: c.dx * Math.sign(l), depth: dl };
      r.police = c;
      if (!best || r.depth > best.depth) best = r;
    }
    return best;
  }
}
