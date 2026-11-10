// Police on the open map (Montreal): break the rules (rules.js) and they come
// after you. The more stars, the more it costs.
//
// - Offences add points; points make the wanted level (1 to 5 stars). Running
//   from patrol cars that have you in sight adds points too, so a chase that
//   goes on gets worse by itself. What each level brings is in LEVELS:
//     ★      one patrol car that follows and pulls you over: a ticket.
//     ★★     two cars; they start nudging you off your line. Caught: arrested.
//     ★★★    three, some sent ahead to cut you off; they ram, and park
//            roadblocks across the street you're on.
//     ★★★★   five, heavier and faster; two roadblocks; a helicopter that
//            sees over the buildings while it's on station.
//     ★★★★★  six; spike strips in front of the roadblocks (flat tires).
// - What they know is what they see. A patrol car sees the player when close
//   enough with no building between; the helicopter sees from above. Seen,
//   the player's position goes out by radio to all of them. Unseen, they drive
//   to where the player was last seen (or last broke a rule), then search the
//   streets around, further out the way the player was heading.
// - Patrol cars come from streets out of sight and find their way through the
//   street graph (A* over the traffic's crossings, one-way or not: sirens on).
//   Each has a job: chase from behind, pull alongside, or get ahead along the
//   streets the player is likely to take. Close and in sight, they drive
//   straight at the player.
// - Busted: a patrol car right beside a car that has stopped (or is wrecked)
//   for a few seconds (fewer at high levels).
// - Escaped: nobody has seen the player for a while (longer at high levels).
//
// Patrol cars are pushed out of buildings, other cars and each other, and back
// up when stuck. The traffic brakes for them and makes way (traffic.js).

const STARS = [1, 3, 6, 10, 15];           // points for each star
const LEVELS = [
  null,
  { units: 1, speed: 27, ram: 0, blocks: 0, spikes: false, heli: false, escape: 10, bust: 3, sight: 150 },
  { units: 2, speed: 31, ram: 0.5, blocks: 0, spikes: false, heli: false, escape: 14, bust: 3, sight: 170 },
  { units: 3, speed: 35, ram: 1, blocks: 1, spikes: false, heli: false, escape: 18, bust: 2.5, sight: 180 },
  { units: 5, speed: 39, ram: 1.3, blocks: 2, spikes: false, heli: true, escape: 22, bust: 2, sight: 190 },
  { units: 6, speed: 44, ram: 1.6, blocks: 2, spikes: true, heli: true, escape: 28, bust: 1.5, sight: 200 },
];
// What a new level means, for the HUD.
export const LEVEL_NOTES = [
  '',
  'A patrol car is after you',
  'Backup called · they will arrest you',
  'Interceptors and roadblocks',
  'Helicopter overhead · heavy units',
  'Spike strips · every unit in town',
];
const ROLES = ['chase', 'flank', 'intercept', 'chase', 'intercept', 'flank'];
const SPAWN_MIN = 140, SPAWN_MAX = 260;    // m from the player
const EVADE_EVERY = 14;                    // s chased in sight for a point
const POLICE_LENGTH = 4.7, POLICE_WIDTH = 1.82; // the patrol car (the traffic's sedan)
const SUV_LENGTH = 4.8, SUV_WIDTH = 1.92;       // the heavy unit (the traffic's SUV), from 4 stars
const LAT_ACCEL = 8.5;                     // m/s² they corner at
const BLOCK_AHEAD = [150, 250];            // m down the player's way a roadblock is set up
const HELI_ON = 40, HELI_OFF = 22;         // s on station, s away for fuel
const HELI_SIGHT = 230;                    // m (flat) the helicopter sees from
const HELI_SPEED = 55, HELI_HEIGHT = 55;

const norm = (x, z) => { const l = Math.hypot(x, z) || 1; return [x / l, z / l]; };

export class Police {
  constructor(map, traffic) {
    this.map = map;
    this.traffic = traffic;
    this.nextId = 1;
    this.reset();
  }

  reset() {
    this.units = [];       // patrol cars on the move
    this.barricade = [];   // patrol cars parked across the street (roadblocks)
    this.blocks = [];      // roadblocks: { x, z, cars, spikes, born }
    this.heli = null;      // { x, y, z, dx, dz, on, clock, sees }
    this.points = 0;
    this.level = 0;
    this.state = 'clear';  // 'clear' | 'alerted' | 'pursuit' | 'busted'
    this.alert = 0;        // s until the first patrol car is sent
    this.lost = 0;         // s unseen
    this.found = false;    // seen by a patrol car yet (before that, they're still looking)
    this.seen = false;     // in sight right now
    this.search = 0;       // s spent looking
    this.bust = 0;         // s held by a patrol car
    this.evade = 0;        // s chased in sight since the last point for it
    this.known = null;     // where they think the player is: { x, z, vx, vz, age }
    this.report = false;   // an offence just told them where the player is
    this.spawnWait = 0;
    this.blockWait = 6;
    this.clock = 0;
    this.events = [];      // see take()
  }

  get wanted() { return this.level > 0; }
  get rules() { return LEVELS[this.level] ?? LEVELS[1]; }
  // Everything of theirs that's solid: for the traffic to brake for, and the map.
  get cars() { return this.barricade.length ? [...this.units, ...this.barricade] : this.units; }

  // Points for an offence.
  add(points) {
    if (this.state === 'busted') return;
    const before = this.level;
    this.points += points;
    this.level = STARS.filter((p) => this.points >= p).length;
    if (this.state === 'clear' && this.level > 0) { this.state = 'alerted'; this.alert = 2; }
    if (this.level > before) this.events.push({ kind: 'level', level: this.level, note: LEVEL_NOTES[this.level] });
    this.report = true;
    // Seen breaking one more rule while hiding: the search starts over.
    this.lost = Math.min(this.lost, this.rules.escape / 2);
  }

  // What happened since the last call:
  // { kind: 'busted', points, level } | { kind: 'escaped', level } | { kind: 'level', level, note }
  // | { kind: 'rammed', speed, nx, nz, x, z } (a patrol car hit the player)
  // | { kind: 'spiked' } | { kind: 'roadblock' } | { kind: 'evading', points } | { kind: 'heli', on }
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
    const L = this.rules;

    // An offence gives the player's position away.
    if (this.report || !this.known) this.known = { x: player.x, z: player.z, vx: player.vx, vz: player.vz, age: 0 };
    this.report = false;

    // Keep the numbers up: one more every 1.5 s, out of sight.
    this.spawnWait -= dt;
    // Ones left far behind give up; new ones come from closer.
    this.units = this.units.filter((u) => Math.hypot(u.x - player.x, u.z - player.z) < 480);
    if (this.units.length < L.units && this.spawnWait <= 0) {
      this.spawn(player);
      this.spawnWait = 1.5;
    }
    this.updateHeli(dt, player, L);

    let seen = !!this.heli?.sees, nearest = Infinity;
    for (const u of this.cars) {
      if ((u.look -= dt) <= 0) { u.sees = this.sight(u, player, L.sight); u.look = 0.25; }
      if (u.sees) seen = true;
      nearest = Math.min(nearest, Math.hypot(u.x - player.x, u.z - player.z));
    }
    this.seen = seen;
    // The radio: where the player is, or was.
    if (seen) this.known = { x: player.x, z: player.z, vx: player.vx, vz: player.vz, age: 0 };
    else this.known.age += dt;

    const ahead = seen ? this.predict(player, 260) : null;
    for (const u of this.units) this.drive(u, dt, player, L, ahead);
    this.separate();
    this.updateBlocks(dt, player, L, ahead);

    // Held: a patrol car beside the player's stopped car.
    const held = nearest < 9 && (Math.abs(player.speed) < 2 || wrecked);
    this.bust = held ? this.bust + dt : Math.max(0, this.bust - dt * 2);
    if (this.bust >= L.bust) {
      // They stay, stopped around the car, until it's taken away (reset()).
      this.events.push({ kind: 'busted', points: this.points, level: this.level });
      this.state = 'busted';
      for (const u of this.units) u.v = 0;
      return;
    }
    // Running while they watch makes it worse.
    if (seen && Math.abs(player.speed) > 8 && nearest < 120) {
      if ((this.evade += dt) >= EVADE_EVERY) {
        this.evade = 0;
        this.events.push({ kind: 'evading', points: 1 });
        this.add(1);
      }
    }
    // Hidden from all of them (once they've found the player; if they never
    // do, they give up after a long search).
    if (seen) this.found = true;
    this.search += dt;
    this.lost = seen ? 0 : this.found ? this.lost + dt * (nearest > 350 ? 2 : 1) : 0;
    if (this.lost >= L.escape || (!this.found && this.search > 45)) {
      const level = this.level, events = this.events;
      this.reset();
      this.events = [...events, { kind: 'escaped', level }];
    }
  }

  // What the HUD shows.
  status() {
    if (this.state === 'alerted') return 'Police alerted';
    if (this.state === 'busted') return 'Busted';
    if (this.state !== 'pursuit') return '';
    if (this.bust > 0.2) return `Pulled over ${Math.max(0, this.rules.bust - this.bust).toFixed(1)} s`;
    if (!this.found) return 'Police on the way';
    if (this.lost > 0.5) return `Hiding ${Math.ceil(this.rules.escape - this.lost)} s`;
    if (this.heli?.sees && !this.units.some((u) => u.sees)) return 'Helicopter has you';
    const n = this.units.length;
    return n ? `Pursuit · ${n} unit${n > 1 ? 's' : ''}` : 'Pursuit';
  }

  // --- patrol cars ---------------------------------------------------------
  spawn(player) {
    const roads = this.map.roadsNear(player.x, player.z, SPAWN_MAX).filter((r) => r.a);
    if (!roads.length) return;
    const fx = -Math.sin(player.heading), fz = -Math.cos(player.heading);
    // The job of the next one: the first chases; interceptors come from ahead.
    const role = ROLES[this.units.length % ROLES.length], front = role === 'intercept';
    for (let tries = 0; tries < 60; tries++) {
      const r = roads[Math.floor(Math.random() * roads.length)];
      const k = Math.floor(Math.random() * r.pts.length), [x, z] = r.pts[k];
      const d = Math.hypot(x - player.x, z - player.z);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
      // Chasers come from behind, where they aren't seen popping up; interceptors from ahead.
      const side = ((x - player.x) * fx + (z - player.z) * fz) / d;
      if (tries < 40 && (front ? side < 0.2 : side > 0.3)) continue;
      if (this.map.blocked(x, z) || this.cars.some((o) => Math.hypot(o.x - x, o.z - z) < 20)) continue;
      if (tries < 50 && this.sight({ x, z }, player, 200)) continue;
      const q = r.pts[Math.min(r.pts.length - 1, k + 1)], p = r.pts[Math.max(0, k - 1)];
      let [dx, dz] = norm(q[0] - p[0], q[1] - p[1]);
      // Facing the player's way along the street.
      if (dx * (player.x - x) + dz * (player.z - z) < 0) { dx = -dx; dz = -dz; }
      const heavy = this.level >= 4 && this.units.length % 2 === 1;
      this.units.push({
        id: this.nextId++, x, z, dx, dz, v: 8, role, heavy, path: null, at: 0, replan: 0, look: 0,
        sees: false, stuck: 0, reverse: 0, ghost: 0, ramWait: 0, goal: null, side: this.units.length % 4 < 2 ? 1 : -1,
        length: heavy ? SUV_LENGTH : POLICE_LENGTH, width: heavy ? SUV_WIDTH : POLICE_WIDTH,
      });
      return;
    }
  }

  // Whether unit u can see the player: close enough, and no building between.
  sight(u, player, reach) {
    const dx = player.x - u.x, dz = player.z - u.z, d = Math.hypot(dx, dz);
    if (d > reach) return false;
    for (let s = 6; s < d - 3; s += 6) {
      if (this.map.blocked(u.x + (dx * s) / d, u.z + (dz * s) / d)) return false;
    }
    return true;
  }

  // The streets the player is likely to take from here: straight on at every
  // crossing, for `reach` m. Points with the street under each, or null off the streets.
  predict(player, reach) {
    const at = this.map.locate(player.x, player.z), r0 = at.road;
    if (!r0?.a || Math.abs(player.speed) < 3) return null;
    const [tx, tz] = norm(...at.tangent);
    let dir = player.vx * tx + player.vz * tz >= 0 ? 1 : -1, road = r0;
    // The point of the street the player is at, then along it.
    let k = 0, best = Infinity;
    road.pts.forEach((p, i) => { const d = Math.hypot(p[0] - player.x, p[1] - player.z); if (d < best) { best = d; k = i; } });
    const pts = [[player.x, player.z]], roads = [road];
    let len = 0;
    const add = (p, r) => {
      const q = pts[pts.length - 1], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d < 0.5) return;
      len += d; pts.push(p); roads.push(r);
    };
    for (let hops = 0; hops < 12 && len < reach; hops++) {
      if (dir > 0) for (let i = k + 1; i < road.pts.length; i++) add(road.pts[i], road);
      else for (let i = k - 1; i >= 0; i--) add(road.pts[i], road);
      const node = dir > 0 ? road.b : road.a;
      // Out of the crossing: the street that bends the least.
      const a = pts[pts.length - 2] ?? pts[0], b = pts[pts.length - 1], [hx, hz] = norm(b[0] - a[0], b[1] - a[1]);
      let next = null, score = -0.2;
      for (const r of node.roads) {
        if (r === road) continue;
        const out = r.a === node ? 1 : -1, i0 = out > 0 ? 0 : r.pts.length - 1, i1 = out > 0 ? Math.min(2, r.pts.length - 1) : Math.max(0, r.pts.length - 3);
        const [ox, oz] = norm(r.pts[i1][0] - r.pts[i0][0], r.pts[i1][1] - r.pts[i0][1]);
        const sc = hx * ox + hz * oz + (r.w > road.w ? 0.05 : 0);
        if (sc > score) { score = sc; next = r; dir = out; }
      }
      if (!next) break;
      road = next;
      k = dir > 0 ? 0 : road.pts.length - 1;
    }
    return { pts, roads, len };
  }

  // The point `s` m down a predicted way, with the street there and its direction.
  static along(way, s) {
    const { pts, roads } = way;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (s <= l || i === pts.length - 1) {
        const t = Math.max(0, Math.min(1, s / (l || 1))), [dx, dz] = norm(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        return { x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, z: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t, dx, dz, road: roads[i] };
      }
      s -= l;
    }
    return null;
  }

  // Where unit u is headed when it can't drive straight at the player.
  target(u, player, ahead) {
    const K = this.known;
    if (this.seen) {
      u.goal = null;
      // Get in front: a point down the player's way, further the further the unit is.
      if (u.role === 'intercept' && ahead) {
        const d = Math.hypot(player.x - u.x, player.z - u.z);
        const p = Police.along(ahead, Math.min(ahead.len, Math.max(50, Math.min(220, d * 0.8))));
        if (p) return p;
      }
      return player;
    }
    // Unseen: to where the player was, then around: the streets beyond, the way they went.
    if (!u.goal && Math.hypot(K.x - u.x, K.z - u.z) > 30 && K.age < 6) return K;
    if (!u.goal || Math.hypot(u.goal.x - u.x, u.goal.z - u.z) < 18 || (u.goalAge += 1) > 400) {
      const [hx, hz] = norm(K.vx, K.vz), reach = 70 + Math.min(260, K.age * 14);
      let best = null, score = -Infinity;
      for (const r of this.map.roadsNear(K.x, K.z, reach)) {
        if (!r.a) continue;
        const n = Math.random() < 0.5 ? r.a : r.b, ox = n.x - K.x, oz = n.z - K.z, d = Math.hypot(ox, oz);
        if (d > reach || d < 20) continue;
        // Further out the way the player went, not where another unit is looking.
        let sc = Math.random() * 1.2 + ((ox * hx + oz * hz) / d) * 0.8 + d / reach;
        for (const o of this.units) if (o !== u && o.goal && Math.hypot(o.goal.x - n.x, o.goal.z - n.z) < 60) sc -= 1;
        if (sc > score) { score = sc; best = n; }
      }
      u.goal = best ? { x: best.x, z: best.z } : { x: K.x, z: K.z };
      u.goalAge = 0;
      u.replan = 0;
    }
    return u.goal;
  }

  drive(u, dt, player, L, ahead) {
    const d = Math.hypot(player.x - u.x, player.z - u.z);
    const vmax = L.speed * (u.heavy ? 0.94 : 1);
    const pf = norm(player.vx, player.vz), fast = Math.abs(player.speed) > 6;
    // As fast as it can and still be down to v0 when `gap` m are left.
    const approach = (v0, gap) => Math.min(vmax, Math.sqrt(v0 * v0 + 2 * 9 * Math.max(0, gap)));
    let tx, tz, vt;
    const direct = u.sees && d < 80;
    if (direct || u.reverse > 0) {
      // Straight at the player, aiming a little ahead of them.
      const lead = Math.min(0.7, d / 30);
      tx = player.x + player.vx * lead; tz = player.z + player.vz * lead;
      if (L.ram > 0 && fast) {
        // Alongside, then into them: at the rear quarter (it turns the car around).
        if (u.role === 'flank' || d < 14) {
          const off = d > 9 ? 3 : 0.6;
          tx += -pf[1] * u.side * off - pf[0] * 1.2; tz += pf[0] * u.side * off - pf[1] * 1.2;
        }
        vt = approach(Math.abs(player.speed) + 3 + 5 * L.ram, d - 12);
        // Coming the other way: across the player's way, and stop there.
        if (u.role === 'intercept' && u.dx * pf[0] + u.dz * pf[1] < -0.3 && d < 45) vt = Math.min(vt, d * 0.4);
      } else {
        // Behind the player, at their speed: lights and siren, waiting for them to stop.
        vt = d < 25 ? Math.max(0, Math.abs(player.speed) + (d - 6) * 0.8) : approach(Math.abs(player.speed) + 15, d - 25);
      }
      u.path = null;
    } else {
      const goal = this.target(u, player, ahead);
      if ((u.replan -= dt) <= 0 || !u.path) {
        u.path = this.route(u, goal);
        u.at = 0;
        u.replan = 1.5 + Math.random() * 0.5;
      }
      const cruise = this.seen ? vmax : Math.min(vmax, 20); // looking around: slower
      if (!u.path) { tx = goal.x; tz = goal.z; vt = cruise * 0.6; } else {
        [tx, tz, vt] = this.follow(u, cruise);
      }
    }
    // Turn toward the target, as fast as the speed allows.
    const [ax, az] = norm(tx - u.x, tz - u.z);
    const cross = u.dx * az - u.dz * ax, dot = u.dx * ax + u.dz * az;
    const err = Math.atan2(cross, dot);
    if (Math.abs(err) > 1.1) vt = Math.min(vt, 7); // sharp turn: slow right down
    if (u.reverse > 0) {
      // Backing out of a wall: steer the other way.
      u.reverse -= dt;
      vt = -5;
    }
    u.v += Math.max(-11 * dt, Math.min((u.heavy ? 6 : 7.5) * dt, vt - u.v));
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
    // Into the player's car: a ram if it came in fast (the player's own
    // collisions handle them driving into it).
    u.ramWait -= dt;
    const pb = this.playerBox(player, u);
    if (pb) {
      const closing = (u.dx * u.v - player.vx) * u.dx + (u.dz * u.v - player.vz) * u.dz;
      u.x += pb.nx * pb.depth; u.z += pb.nz * pb.depth;
      if (L.ram > 0 && closing > 2.5 && u.ramWait <= 0) {
        this.events.push({ kind: 'rammed', speed: Math.min(16, closing) * (u.heavy ? 1.3 : 1), nx: u.dx, nz: u.dz, x: pb.x, z: pb.z });
        u.ramWait = 1;
        u.v -= closing * 0.5;
      } else u.v = Math.min(u.v, Math.max(0, Math.abs(player.speed)) + (L.ram > 0 ? 2 : 0));
    }
    if (hit) u.v *= 0.85;
    // Stuck: back up a moment, and go through cars for a bit.
    u.stuck = Math.abs(u.v) < 1 && vt > 2 ? u.stuck + dt : 0;
    if (u.stuck > 1.5) { u.reverse = 1.2; u.stuck = 0; u.ghost = 3; u.replan = 0; }
  }

  // Patrol cars don't drive through each other.
  separate() {
    const U = this.units, all = this.cars;
    for (let i = 0; i < U.length; i++) {
      for (let j = 0; j < all.length; j++) {
        const a = U[i], b = all[j];
        if (a === b || (j < U.length && j <= i)) continue;
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = 2.7;
        if (d >= min || d < 1e-3) continue;
        const k = (min - d) / d / (b.static ? 1 : 2);
        a.x -= dx * k; a.z -= dz * k;
        if (!b.static) { b.x += dx * k; b.z += dz * k; }
      }
    }
  }

  // Overlap of patrol car u's nose with the player's car (an oriented box).
  playerBox(player, u) {
    const fx = -Math.sin(player.heading), fz = -Math.cos(player.heading);
    const px = u.x + u.dx * (u.length / 2), pz = u.z + u.dz * (u.length / 2);
    const rx = px - player.x, rz = pz - player.z;
    const f = rx * fx + rz * fz, l = rx * -fz + rz * fx;
    const hl = 2.4, hw = 1.0;
    if (Math.abs(f) > hl || Math.abs(l) > hw) return null;
    return { nx: -u.dx, nz: -u.dz, depth: Math.min(hl - Math.abs(f), hw - Math.abs(l)) + 0.02, x: px, z: pz };
  }

  // --- roadblocks ----------------------------------------------------------
  // Two patrol cars parked nose to nose across the street the player is coming
  // down, the sidewalks left open; at 5 stars, a spike strip in front.
  updateBlocks(dt, player, L, ahead) {
    // Old ones, passed or avoided, pack up.
    this.blocks = this.blocks.filter((b) => {
      const d = Math.hypot(b.x - player.x, b.z - player.z), age = this.clock - b.born;
      const keep = !(age > 12 && d > 320) && !(age > 50 && d > 110) && age < 120;
      if (!keep) this.barricade = this.barricade.filter((c) => !b.cars.includes(c));
      return keep;
    });
    // Over the spikes.
    for (const b of this.blocks) {
      const s = b.spikes;
      if (!s || s.used) continue;
      const rx = player.x - s.x, rz = player.z - s.z;
      if (Math.abs(rx * s.dx + rz * s.dz) < 1.4 && Math.abs(rx * -s.dz + rz * s.dx) < s.half + 0.8 && Math.abs(player.speed) > 2) {
        s.used = true;
        this.events.push({ kind: 'spiked' });
      }
    }
    this.blockWait -= dt;
    if (!L.blocks || this.blocks.length >= L.blocks || this.blockWait > 0 || !ahead || Math.abs(player.speed) < 10) return;
    this.blockWait = 2;
    const s = BLOCK_AHEAD[0] + Math.random() * (BLOCK_AHEAD[1] - BLOCK_AHEAD[0]);
    const p = Police.along(ahead, s);
    if (!p || ahead.len < s || !p.road?.a) return;
    const r = p.road;
    // Clear of the crossings, on a street wide enough to be worth closing, and out of sight.
    if (Math.hypot(p.x - r.a.x, p.z - r.a.z) < r.a.r + 16 || Math.hypot(p.x - r.b.x, p.z - r.b.z) < r.b.r + 16) return;
    if (this.blocks.some((b) => Math.hypot(b.x - p.x, b.z - p.z) < 150)) return;
    const cars = [];
    const n = r.w > 5.2 ? 2 : 1; // patrol cars it takes
    for (let i = 0; i < n; i++) {
      // Side by side across the street, each turned a little toward the player.
      const off = n === 1 ? 0 : (i ? 1 : -1) * (r.w - POLICE_LENGTH / 2 - 0.2), tilt = (i ? 1 : -1) * 0.3;
      const cs = Math.cos(tilt), sn = Math.sin(tilt), ax = -p.dz, az = p.dx; // across
      const c = {
        id: this.nextId++, static: true, x: p.x + ax * off, z: p.z + az * off, dx: ax * cs - az * sn, dz: ax * sn + az * cs, v: 0,
        sees: false, look: Math.random() * 0.25, heavy: false, length: POLICE_LENGTH, width: POLICE_WIDTH,
      };
      if (this.map.blocked(c.x, c.z)) return;
      cars.push(c);
    }
    const spikes = L.spikes ? { x: p.x - p.dx * 14, z: p.z - p.dz * 14, dx: p.dx, dz: p.dz, half: r.w - 0.3, used: false } : null;
    this.blocks.push({ x: p.x, z: p.z, cars, spikes, born: this.clock });
    this.barricade.push(...cars);
    this.blockWait = 16;
    this.events.push({ kind: 'roadblock', spikes: !!spikes });
  }

  // --- the helicopter --------------------------------------------------------
  // From 4 stars: it circles over the player and sees them whatever stands in
  // the way, for HELI_ON s; then it leaves for fuel, and that's the time to hide.
  updateHeli(dt, player, L) {
    if (!L.heli) {
      if (this.heli) { this.heli.on = false; this.heli.clock = 0; }
      if (!this.heli) return;
    }
    if (!this.heli) {
      const a = Math.random() * Math.PI * 2;
      this.heli = { x: player.x + Math.cos(a) * 450, z: player.z + Math.sin(a) * 450, y: HELI_HEIGHT + 25, dx: 0, dz: 1, v: 0, on: true, clock: 0, sees: false, home: a };
    }
    const h = this.heli;
    h.clock += dt;
    if (L.heli && h.on && h.clock > HELI_ON) { h.on = false; h.clock = 0; this.events.push({ kind: 'heli', on: false }); }
    else if (L.heli && !h.on && h.clock > HELI_OFF) { h.on = true; h.clock = 0; this.events.push({ kind: 'heli', on: true }); }
    // On station: a circle over where the player is (or was last seen). Off: away, high.
    const K = this.seen || h.sees ? player : this.known ?? player;
    const a = this.clock * 0.35;
    const tx = h.on ? K.x + Math.cos(a) * 38 : player.x + Math.cos(h.home) * 700;
    const tz = h.on ? K.z + Math.sin(a) * 38 : player.z + Math.sin(h.home) * 700;
    const d = Math.hypot(tx - h.x, tz - h.z), [ax, az] = norm(tx - h.x, tz - h.z);
    const vt = Math.min(HELI_SPEED, d * 0.9);
    h.v += Math.max(-25 * dt, Math.min(18 * dt, vt - h.v));
    const k = Math.min(1, dt * 2.5);
    [h.dx, h.dz] = norm(h.dx + (ax - h.dx) * k, h.dz + (az - h.dz) * k);
    h.x += h.dx * h.v * dt; h.z += h.dz * h.v * dt;
    h.y += ((h.on ? HELI_HEIGHT : HELI_HEIGHT + 60) - h.y) * Math.min(1, dt * 0.5);
    h.dist = Math.hypot(player.x - h.x, player.z - h.z);
    h.sees = h.on && h.dist < HELI_SIGHT;
    if (!L.heli && h.dist > 600) this.heli = null;
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

  // A route from unit u to `goal` ({ x, z }) along the streets: a list of points.
  route(u, goal) {
    const from = this.map.locate(u.x, u.z), to = this.map.locate(goal.x, goal.z);
    const ra = from.road?.a ? from.road : null, rb = to.road?.a ? to.road : null;
    if (!ra || !rb) return null;
    if (ra === rb) return [[u.x, u.z], [goal.x, goal.z]];
    const nearestIdx = (r, x, z) => {
      let k = 0, best = Infinity;
      r.pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - z); if (d < best) { best = d; k = i; } });
      return k;
    };
    const ia = nearestIdx(ra, u.x, u.z), ib = nearestIdx(rb, goal.x, goal.z);
    const lenOf = (r) => r.len ?? (r.len = r.pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - r.pts[i - 1][0], p[1] - r.pts[i - 1][1]) : 0), 0));
    // A*: from the ends of the unit's street to either end of the goal's.
    const ends = new Set([rb.a, rb.b]);
    const g = new Map(), prev = new Map(), heap = [];
    const h = (n) => Math.hypot(n.x - goal.x, n.z - goal.z);
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
      if (ends.has(n)) { end = n; break; }
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
    // Into the goal's street, up to it.
    if (end === rb.a) for (let i = 0; i <= ib; i++) add(rb.pts[i]);
    else for (let i = rb.pts.length - 1; i >= ib; i--) add(rb.pts[i]);
    add([goal.x, goal.z]);
    return pts;
  }

  // Whether (x, z) is inside a patrol car, and if so the way out (as the map's blocked()).
  blocked(x, z) {
    let best = null;
    for (const c of this.cars) {
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
