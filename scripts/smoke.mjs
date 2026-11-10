// Smoke test of the city's simulation, without a browser: unpacks the open
// map, then runs traffic, pedestrians and the police around a scripted player
// who drives the streets at speed while the wanted level climbs. Fails on any
// exception, on NaN positions, and if the police never do their job.
//
//   npm test              (node scripts/smoke.mjs [seed])
import { loadOpenMap, buildOpenMap } from '../src/openmap.js';
import { Traffic } from '../src/traffic.js';
import { Pedestrians } from '../src/pedestrians.js';
import { Police } from '../src/police.js';
import { MONTREAL } from '../src/montreal.js';

// The same run every time: the simulation's dice are replaced by a seeded generator.
let seed = Number(process.argv[2] ?? 7) >>> 0;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const assert = (ok, msg) => { if (!ok) { console.error(`FAIL: ${msg}`); process.exitCode = 1; } };

await loadOpenMap();
const map = buildOpenMap();
const traffic = new Traffic(map);
const people = new Pedestrians(map);
const police = new Police(map, traffic);

// The player: follows the street they're on at `speed`, straight on at crossings.
const [sx, sz, heading] = MONTREAL.start;
const player = { x: sx, z: sz, heading, speed: 0, vx: 0, vz: 0 };
function drivePlayer(dt, speed) {
  const at = map.locate(player.x, player.z);
  let fx = -Math.sin(player.heading), fz = -Math.cos(player.heading);
  if (at.road && at.tangent) {
    // Along the street, the way the car already points, pulled back to its middle.
    let [tx, tz] = at.tangent;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    if (tx * fx + tz * fz < 0) { tx = -tx; tz = -tz; }
    fx += (tx - fx) * Math.min(1, dt * 4); fz += (tz - fz) * Math.min(1, dt * 4);
  }
  const l = Math.hypot(fx, fz) || 1;
  fx /= l; fz /= l;
  const nx = player.x + fx * speed * dt, nz = player.z + fz * speed * dt;
  if (map.blocked(nx, nz)) { fx = -fz; fz = fx; } else { player.x = nx; player.z = nz; }
  Object.assign(player, { heading: Math.atan2(-fx, -fz), speed, vx: fx * speed, vz: fz * speed });
}

const seen = new Set(), counts = {};
const DT = 1 / 30;
traffic.reset(player);
people.reset(player);
assert(traffic.cars.length > 100, `traffic: only ${traffic.cars.length} cars`);
assert(people.people.length > 50, `pedestrians: only ${people.people.length}`);

let maxUnits = 0, maxLevel = 0;
for (let t = 0, step = 0; t < 240; t += DT, step++) {
  // An offence every few seconds: the level climbs to 5 over the first minutes.
  if (step % 240 === 60 && police.state !== 'busted') police.add(1);
  drivePlayer(DT, t < 200 ? 24 : 0); // then stop: they should make the arrest
  traffic.update(DT, player);
  people.update(DT, player);
  police.update(DT, player, false);
  traffic.extra = police.cars;
  for (const e of police.take()) { seen.add(e.kind); counts[e.kind] = (counts[e.kind] ?? 0) + 1; }
  traffic.take(); people.take();
  maxUnits = Math.max(maxUnits, police.units.length);
  maxLevel = Math.max(maxLevel, police.level);
  for (const c of [...traffic.cars, ...police.cars, ...people.people]) {
    if (!Number.isFinite(c.x + c.z + c.dx + c.dz)) { assert(false, `NaN in ${JSON.stringify(c, (k, v) => (typeof v === 'object' && k ? undefined : v))}`); t = Infinity; break; }
  }
  if (police.state === 'busted') break;
}
console.log({ maxLevel, maxUnits, events: counts, state: police.state, cars: traffic.cars.length, people: people.people.length });
assert(maxLevel === 5, `wanted level reached ${maxLevel}, not 5`);
assert(maxUnits >= 5, `at most ${maxUnits} patrol cars chased`);
assert(seen.has('level'), 'no level event');
assert(seen.has('roadblock'), 'no roadblock was set up');
assert(seen.has('heli'), 'the helicopter never cycled');
assert(police.state === 'busted', `stopped among patrol cars but not busted (${police.state})`);
if (!process.exitCode) console.log('ok');
