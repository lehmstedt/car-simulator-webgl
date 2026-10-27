// Self-driving bot: drives a layout with the game's own physics (car.js,
// terrain.js, track.js, sausage kerbs) at the game's 60 fps, using only inputs
// a player has: a rate-limited steering wheel and on/off pedals. It tunes
// itself, then writes its best run to src/bot-lap.js, which the game replays
// as Claude's ghost.
//
//   node scripts/autodrive.mjs [ring] [fwd|rwd|gt3|both|all] [iterations]
import { writeFileSync, readFileSync } from 'node:fs';
import { Car, VARIANTS } from '../src/car.js';
import { buildTrack, LAYOUTS } from '../src/track.js';
import { terrainSample, terrainNormal, setTerrain } from '../src/terrain.js';

const DT = 1 / 60;            // one game frame
const STEER_RATE = 4;         // wheel travel per second (the keyboard's counter-steer rate)
const kind = process.argv[2] ?? 'ring';
const circuit = false, asphalt = true;
// Laps per try: the Nordschleife's one lap (from the standing start) is long enough.
const LAPS = kind === 'ring' ? 1 : 2;
setTerrain(kind);
const track = buildTrack(LAYOUTS[kind]);
const P = track.points, N = P.length, closed = track.closed;
const wrap = (i) => (closed ? (i + N) % N : Math.max(0, Math.min(N - 1, i)));

// Same as the game's startPose().
const startPose = () => { const { x, z, tangent: [tx, tz] } = track.grid; return [x, z, Math.atan2(-tx, -tz)]; };

// Wheel contact points, as main.js wheelPositions() (car frame lying on the slope).
function wheelXZ(car) {
  const up = terrainNormal(car.x, car.z), h = car.heading;
  const f = [-Math.sin(h), 0, -Math.cos(h)], d = f[0] * up[0] + f[1] * up[1] + f[2] * up[2];
  let fwd = [f[0] - up[0] * d, f[1] - up[1] * d, f[2] - up[2] * d];
  const l = Math.hypot(...fwd); fwd = fwd.map((v) => v / l);
  const back = fwd.map((v) => -v);
  const right = [up[1] * back[2] - up[2] * back[1], up[2] * back[0] - up[0] * back[2], up[0] * back[1] - up[1] * back[0]];
  return car.wheels.map(([side, ahead]) => [car.x + right[0] * side + fwd[0] * ahead, car.z + right[2] * side + fwd[2] * ahead]);
}

// Racing line: lateral offsets from the centerline, relaxed toward minimum
// curvature (each point pulled to its neighbors' midpoint), kept on the road.
const lineCache = new Map();
function racingLine(margin) {
  const key = margin.toFixed(2);
  if (lineCache.has(key)) return lineCache.get(key);
  const nor = track.tangents.map(([tx, tz]) => [-tz, tx]);
  const off = new Float64Array(N);
  const lim = Math.max(0, track.halfWidth + track.edgeWidth - margin);
  for (let it = 0; it < 3000; it++) {
    for (let i = closed ? 0 : 1; i < (closed ? N : N - 1); i++) {
      const a = wrap(i - 1), b = wrap(i + 1);
      const mx = (P[a][0] + nor[a][0] * off[a] + P[b][0] + nor[b][0] * off[b]) / 2 - P[i][0];
      const mz = (P[a][1] + nor[a][1] * off[a] + P[b][1] + nor[b][1] * off[b]) / 2 - P[i][1];
      const want = mx * nor[i][0] + mz * nor[i][1];
      off[i] = Math.max(-lim, Math.min(lim, off[i] + (want - off[i]) * 0.5));
    }
  }
  const line = P.map((p, i) => [p[0] + nor[i][0] * off[i], p[1] + nor[i][1] * off[i]]);
  lineCache.set(key, line);
  return line;
}

// Target speed along the line: lateral-grip limit in corners, then braking and
// acceleration limits passed backward and forward.
function profile(line, p, car) {
  const M = line.length;
  const seg = line.map((a, i) => { const b = line[wrap(i + 1)]; return Math.hypot(b[0] - a[0], b[1] - a[1]); });
  const mean = seg.reduce((s, v) => s + v, 0) / M, s = Math.max(1, Math.round(10 / mean));
  const k = line.map((_, i) => {
    const a = line[wrap(i - s)], b = line[i], c = line[wrap(i + s)];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    return (2 * cross) / Math.max(1e-6, ab * bc * ca);
  });
  const v = k.map((c) => Math.min(60, Math.sqrt(p.lat / Math.max(c, 1e-4))));
  for (let pass = 0; pass < 3; pass++) {
    for (let i = M - 1; i >= 0; i--) {
      if (!closed && i === M - 1) continue;
      const j = wrap(i + 1);
      v[i] = Math.min(v[i], Math.sqrt(v[j] ** 2 + 2 * p.brake * seg[i]));
    }
    for (let i = 0; i < M; i++) {
      if (!closed && i === M - 1) continue;
      const j = wrap(i + 1), acc = Math.min(car.maxDrive, car.power / Math.max(v[i], 1)) / car.mass - car.drag * v[i] ** 2 / car.mass;
      v[j] = Math.min(v[j], Math.sqrt(v[i] ** 2 + 2 * Math.max(0.1, acc) * seg[i]));
    }
  }
  return v;
}

function nearestOnLine(line, x, z, hint) {
  let best = Infinity, idx = hint;
  for (let d = -15; d <= 40; d++) {
    const i = wrap(hint + d), dd = (line[i][0] - x) ** 2 + (line[i][1] - z) ** 2;
    if (dd < best) { best = dd; idx = i; }
  }
  return idx;
}
const walk = (line, i, meters) => {
  let j = i, d = 0;
  while (d < meters) { const n = wrap(j + 1); if (n === j) break; d += Math.hypot(line[n][0] - line[j][0], line[n][1] - line[j][1]); j = n; }
  return j;
};
const pose = (car) => [Math.round(car.x * 100) / 100, Math.round(car.z * 100) / 100, Math.round(car.heading * 1000) / 1000];

// Drive from the grid. Circuit: up to `laps` timed laps, keeps the best flying
// lap. Stage: one run, start line to finish. `off` counts frames off the road.
function run(variant, p, laps = LAPS, record = false) {
  const line = racingLine(p.margin);
  const car = new Car(variant);
  const vt = profile(line, p, car);
  car.reset(...startPose());
  let wheel = 0, hint = nearestOnLine(line, car.x, car.z, track.locate(car.x, car.z).index);
  const lap = { start: null, sector: 3, visited: new Set(), along: track.locate(car.x, car.z).along };
  let kerbWheels = [0, 0, 0, 0], rec = null, next = 0, done = 0, best = null, off = 0;
  const maxFrames = closed ? 60 * Math.max(75, track.length / 20) * (laps + 1) : 60 * 300;
  for (let frame = 0; frame < maxFrames; frame++) {
    const t = frame * (1000 / 60);
    hint = nearestOnLine(line, car.x, car.z, hint);
    const speed = Math.max(car.vx, 1);
    // Pure pursuit toward a point ahead on the line.
    const look = p.look0 + p.lookK * speed, j = walk(line, hint, look);
    const dx = line[j][0] - car.x, dz = line[j][1] - car.z;
    const s = Math.sin(car.heading), c = Math.cos(car.heading);
    const alpha = Math.atan2(-c * dx + s * dz, -s * dx - c * dz);
    const delta = Math.atan2(2 * car.wheelBase * Math.sin(alpha), look) - p.damp * car.yawRate * 0.1 + p.slipK * car.vy * 0.01;
    const lock = car.maxSteer / (1 + Math.abs(car.vx) * 0.05);
    const want = Math.max(-1, Math.min(1, delta / lock));
    wheel += Math.max(-STEER_RATE * DT, Math.min(STEER_RATE * DT, want - wheel));
    // Pedals (on/off): brake when over the target speed a little ahead, else throttle.
    const target = Math.min(vt[hint], vt[walk(line, hint, p.pre * speed)]);
    const throttle = car.vx < target * p.gas ? 1 : 0;
    const brake = car.vx > target * p.over ? 1 : 0;

    // One game frame, in main.js order.
    const where = track.locate(car.x, car.z);
    const surface = where.surface ?? (paddockAt(car.x, car.z) ? 'road' : where.sand ? 'sand' : 'grass');
    if (!where.onTrack) off++;
    const on = [];
    const hs = wheelXZ(car).map(([x, z], i) => {
      const h = track.sausageHeight(x, z);
      if (h > 0) on.push({ front: car.wheels[i][2], side: Math.sign(car.wheels[i][0]), hit: kerbWheels[i] === 0 });
      return h;
    });
    car.kerbs(on);
    kerbWheels = hs;
    car.update(DT, { steer: wheel, throttle, brake, handbrake: 0 }, surface, terrainSample(car.x, car.z));
    const after = track.locate(car.x, car.z);

    if (closed) {
      const sector = Math.floor((after.index / N) * 4);
      if (sector !== lap.sector) {
        if (lap.sector === 3 && sector === 0) {
          if (lap.start !== null && lap.visited.size === 3) {
            const time = t - lap.start;
            if (rec) rec.push(Math.round(time), ...pose(car));
            if (!best || time < best.time) best = { time, samples: rec, off };
            if (++done >= laps) break;
          }
          lap.start = t; lap.visited.clear(); off = 0;
          rec = record ? [] : null; next = 0;
        } else if (sector !== 0) lap.visited.add(sector);
        lap.sector = sector;
      }
    } else {
      const prev = lap.along;
      lap.along = after.along;
      if (Math.abs(after.along - prev) <= 20) {
        const st = track.start.along, f = track.finish.along;
        if (lap.start === null) {
          if (prev < st && after.along >= st) { lap.start = t; off = 0; rec = record ? [] : null; next = 0; }
        } else {
          const q = Math.floor(((after.along - st) / (f - st)) * 4);
          if (q >= 1 && q <= 3) lap.visited.add(q);
          if (prev < f && after.along >= f && lap.visited.size === 3) {
            const time = t - lap.start;
            if (rec) rec.push(Math.round(time), ...pose(car));
            best = { time, samples: rec, off };
            break;
          }
        }
      }
    }
    if (rec && lap.start !== null && t - lap.start >= next) {
      rec.push(Math.round(t - lap.start), ...pose(car));
      next = t - lap.start + 50;
    }
    if (!circuit && frame > 60 * 20 && car.vx < 1) break; // stuck
  }
  return best;
}

// Score: run time; any frame off the road (kerbs count as road) disqualifies.
const score = (v, p) => { const b = run(v, p); return b && b.off === 0 ? b.time : Infinity; };

const BOUNDS = {
  margin: [0.6, 3], lat: [3, 14], brake: [3, 11], look0: [2, 12], lookK: [0, 0.6],
  damp: [0, 3], slipK: [-3, 3], pre: [0, 0.6], gas: [0.9, 1.05], over: [1, 1.15],
};
function tune(variant, iters) {
  let p = { margin: 1.5, lat: asphalt ? 9 : 6, brake: asphalt ? 6 : 4, look0: 5, lookK: 0.3, damp: 1, slipK: 1, pre: 0.1, gas: 1, over: 1.05 };
  let best = score(variant, p);
  // Find something that stays on the road first by backing off.
  while (best === Infinity && p.lat > 2.5) { p.lat -= 0.5; p.brake = Math.max(3, p.brake - 0.3); best = score(variant, p); }
  console.log(variant, 'start', best);
  let step = 0.25;
  for (let it = 0; it < iters; it++) {
    const q = { ...p };
    for (const key of Object.keys(BOUNDS)) {
      if (Math.random() < 0.4) {
        const [lo, hi] = BOUNDS[key];
        q[key] = Math.min(hi, Math.max(lo, q[key] + (Math.random() * 2 - 1) * step * (hi - lo)));
      }
    }
    const s = score(variant, q);
    if (s < best) { best = s; p = q; console.log(variant, it, (s / 1000).toFixed(2)); }
    if (it % 200 === 199) step = Math.max(0.03, step * 0.8);
  }
  return p;
}

const which = process.argv[3] ?? 'both', iters = +(process.argv[4] ?? 1500);
const file = new URL('../src/bot-lap.js', import.meta.url);
const read = () => { try { return JSON.parse(readFileSync(file, 'utf8').match(/BOT_LAPS = (.*);/s)[1]); } catch { return {}; } };
for (const v of which === 'all' ? Object.keys(VARIANTS) : which === 'both' ? ['fwd', 'rwd'] : [which]) {
  const p = tune(v, iters);
  const lap = run(v, p, kind === 'ring' ? 1 : 3, true);
  if (!lap || lap.off) { console.log(`${kind} ${v}: no clean run`); continue; }
  console.log(`${kind} ${v}: ${(lap.time / 1000).toFixed(2)} s`, JSON.stringify(p));
  // Re-read so parallel runs for other layouts / drivetrains aren't lost; keep the faster run.
  const all = read(), old = all[kind]?.[v];
  if (old && old.time <= lap.time) continue;
  all[kind] = { ...all[kind], [v]: { time: Math.round(lap.time), samples: lap.samples } };
  writeFileSync(file,
    `// Generated by scripts/autodrive.mjs: Claude's best run per layout and drivetrain,\n` +
    `// driven with the game's physics and player inputs. Same format as ghost.js laps.\n` +
    `export const BOT_LAPS = ${JSON.stringify(all)};\n`);
}
