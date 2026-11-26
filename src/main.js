import { createProgram, createMesh, deleteMesh, canReverseDepth, createReversedDepth } from './gl.js';
import { cube, torus, cylinder } from './geometry.js';
import { gt3Body, yarisBody } from './bodies.js';
import { perspective, lookAt, multiply, identity, basis, rotate } from './math.js';
import { terrainHeight, terrainNormal, terrainSample, terrainMesh, ringTerrainChunks, setTerrain } from './terrain.js';
import { readControls, resetWheel, wheelAngle } from './input.js';
import { Car, PHYSICS_STEP, VARIANTS, TIRE_TEMP, tempGrip, variantSpec, wheelLayout, clamp } from './car.js';
import { Skids } from './skids.js';
import { Sound } from './audio.js';
import { Ghost } from './ghost.js';
import { buildTrack, LAYOUTS, LINK_LAYOUTS, ROAD_LIFT } from './track.js';
import { Signs, createTexture } from './signs.js';
import { Traffic } from './traffic.js';
import { Pedestrians } from './pedestrians.js';
import { createCityRenderer } from './cityrender.js';
import { Rules } from './rules.js';
import { Police } from './police.js';
import { buildTrees, buildTreesAt } from './trees.js';
import { buildOpenMap, loadOpenMap, BRICKS } from './openmap.js';
import { Minimap } from './minimap.js';
import { StartPicker } from './picker.js';
import { Sky } from './sky.js';
import { SCENE_VS, SCENE_FS, MAT } from './shading.js';
import { Climate, CLOCKS, CLOCK_ORDER, SEASONS, SEASON_ORDER } from './climate.js';
import { Precipitation } from './weather.js';

const canvas = document.getElementById('gl');
const speedEl = document.getElementById('speed');
const gearEl = document.getElementById('gear');
const lapEl = document.getElementById('lap');
const bestEl = document.getElementById('best');
const botEl = document.getElementById('bot');
const driveEl = document.getElementById('drive');
const balanceEl = document.getElementById('balance');
const ghostBtn = document.getElementById('ghost');
const viewBtn = document.getElementById('view');
const layoutBtn = document.getElementById('layout');
const soundBtn = document.getElementById('sound');
const sectionRowEl = document.getElementById('section-row');
const sectionEl = document.getElementById('section');
const loadEl = document.getElementById('load');
const gradeEl = document.getElementById('grade');
const gmeterEl = document.getElementById('gmeter');
const gdotEl = document.getElementById('gdot');
const glimitEl = document.getElementById('glimit');
const gtrailEl = document.getElementById('gtrail');
const gvalEl = document.getElementById('gval');
const guseEl = document.getElementById('guse');
const tireEls = ['fl', 'fr', 'rl', 'rr'].map((k) => document.getElementById(`tire-${k}`));
const tireTextEls = { front: document.getElementById('tire-f'), rear: document.getElementById('tire-r') };
const tireStateEl = document.getElementById('tire-state');
const tiresEl = document.getElementById('tires');
const minimap = new Minimap(document.getElementById('minimap'));
const healthEl = document.getElementById('health');
const healthBarEl = document.getElementById('health-bar');
const wantedRowEl = document.getElementById('wanted-row');
const starsEl = document.getElementById('stars');
const wantedEl = document.getElementById('wanted');
const limitEl = document.getElementById('limit');
const toastEl = document.getElementById('toast');
const bannerEl = document.getElementById('banner');
const pursuitEl = document.getElementById('pursuit');
const crackEl = document.getElementById('crack');
const finesRowEl = document.getElementById('fines-row');
const finesEl = document.getElementById('fines');
const crossRowEl = document.getElementById('cross-row');
const crossEl = document.getElementById('cross');
const damageBtn = document.getElementById('damage');
const policeBtn = document.getElementById('police');
const startBtn = document.getElementById('start');
const clockBtn = document.getElementById('clock-mode');
const seasonBtn = document.getElementById('season');
const clockEl = document.getElementById('clock');
const weatherEl = document.getElementById('weather');
const G_SCALE = 28; // px per g on the G-meter (grid rings at 0.5 g and 1 g)
const gTrail = [];
// With reversed-Z the scene is drawn (multisampled) off screen and only copied
// to the canvas, which then needs no antialiasing of its own.
const reverseZ = canReverseDepth();
const gl = canvas.getContext('webgl2', { antialias: !reverseZ });
if (!gl) {
  document.getElementById('hud').textContent = 'WebGL2 is not available in this browser.';
  throw new Error('WebGL2 not supported');
}
const depthTarget = reverseZ ? createReversedDepth(gl) : null;

const program = createProgram(gl, SCENE_VS, SCENE_FS);
const uModel = gl.getUniformLocation(program, 'uModel');
const uViewProj = gl.getUniformLocation(program, 'uViewProj');
const uColor = gl.getUniformLocation(program, 'uColor');
const uMat = gl.getUniformLocation(program, 'uMat');
const uAlpha = gl.getUniformLocation(program, 'uAlpha');
const uTextured = gl.getUniformLocation(program, 'uTextured');
const uCam = gl.getUniformLocation(program, 'uCam');
const uFog = gl.getUniformLocation(program, 'uFog');
const uZenith = gl.getUniformLocation(program, 'uZenith');
const uSun = gl.getUniformLocation(program, 'uSun');
const uTime = gl.getUniformLocation(program, 'uTime');
const U = Object.fromEntries(['uSunCol', 'uAmb', 'uAmbGround', 'uGroundEnv', 'uFogRange', 'uSnow', 'uWet', 'uLeaf', 'uAutumn', 'uFresh',
  'uGrass', 'uNight', 'uStreet', 'uHeadPos', 'uHeadDir', 'uHeadOn'].map((n) => [n, gl.getUniformLocation(program, n)]));
const sky = new Sky(gl);
const precipitation = new Precipitation(gl);

// Montreal's hour, season and weather (climate.js): the clock runs live, or
// faster; the season follows the date, cycles, or is held. Kept between visits.
const climate = new Climate();
try {
  const c = localStorage.getItem('clock'), se = localStorage.getItem('season');
  if (CLOCK_ORDER.includes(c)) climate.setClock(c);
  if (SEASON_ORDER.includes(se)) climate.setSeason(se);
} catch {}
function updateClimateBtns() {
  const set = (btn, text) => { const b = btn?.querySelector('b'); if (b) b.textContent = text; };
  set(clockBtn, CLOCKS[climate.clock].label);
  set(seasonBtn, SEASONS[climate.season].label);
}
updateClimateBtns();
clockBtn?.addEventListener('click', () => {
  const i = CLOCK_ORDER.indexOf(climate.clock);
  climate.setClock(CLOCK_ORDER[(i + 1) % CLOCK_ORDER.length]);
  try { localStorage.setItem('clock', climate.clock); } catch {}
  updateClimateBtns();
  toast(climate.clock === 'live' ? 'Time: live, as in Montreal now' : `Time: ${CLOCKS[climate.clock].label} · a day in ${Math.round(1440 / CLOCKS[climate.clock].rate)} min`);
});
seasonBtn?.addEventListener('click', () => {
  const i = SEASON_ORDER.indexOf(climate.season);
  climate.setSeason(SEASON_ORDER[(i + 1) % SEASON_ORDER.length]);
  try { localStorage.setItem('season', climate.season); } catch {}
  updateClimateBtns();
  toast(climate.season === 'live' ? "Season: today's" : climate.season === 'cycle' ? 'Season: a year in 40 min' : `Season: ${SEASONS[climate.season].label}`);
});
// , and . move the clock an hour back or ahead.
addEventListener('keydown', (e) => {
  if (e.code !== 'Comma' && e.code !== 'Period') return;
  climate.shift(e.code === 'Period' ? 1 : -1);
  updateClimateBtns();
  toast(`${climate.time} · ${climate.date}`);
});

// Everything that depends on the map: the ground, the roads, signs, trees and
// buildings. Layouts are 'montreal', the open map of the island of Montreal,
// and the Nürburgring's two circuits, 'ring' (the Nordschleife) and 'gp' (the
// GP circuit), which share one map: switching between those two only moves
// the car to the other circuit's grid. Driving from one circuit onto the
// other (through the links at T13) switches the timed layout too.
// M / the Track button cycles through them in this order.
const LAYOUT_ORDER = ['montreal', 'ring', 'gp'];
const LAYOUT_NAMES = { ring: 'Nordschleife', gp: 'GP-Strecke', montreal: 'Montreal' };
const MAPS = { ring: 'nurburgring', gp: 'nurburgring', montreal: 'montreal' };
let layout = 'montreal';
try {
  const v = localStorage.getItem('layout');
  if (LAYOUT_ORDER.includes(v)) layout = v;
} catch {}
// Scenery further than this (m) isn't drawn: past the far plane, or lost in the haze.
const DRAW_DISTANCE = 1100;
let world = null, track = null;

function buildWorld(kind) {
  if (world) {
    for (const m of world.gpu) deleteMesh(gl, m);
    for (const c of world.cells ?? []) unloadCell(c);
    gl.deleteTexture(world.signs.texture);
    if (world.streetSigns) gl.deleteTexture(world.streetSigns.texture);
  }
  setTerrain(kind);
  return MAPS[kind] === 'montreal' ? buildMontrealWorld() : buildRingWorld(kind);
}

// The Nürburgring: the Nordschleife with its kerbs and guardrails, the GP
// circuit with its sand traps, the two links between them, corner boards and
// the Eifel forest.
function buildRingWorld(kind) {
  const circuits = { ring: buildTrack(LAYOUTS.ring), gp: buildTrack(LAYOUTS.gp) };
  const links = LINK_LAYOUTS.map((l) => buildTrack(l));
  const roads = [...Object.values(circuits), ...links];
  const t = ringNetwork(circuits, links, kind);
  const gpu = [];
  const upload = (m) => { const mesh = createMesh(gl, program, m); gpu.push(mesh); return mesh; };
  const allSigns = roads.flatMap((r) => r.signs);
  const signs = new Signs(gl, program, allSigns);
  gpu.push(signs.faces);
  // Trees: off the roads and their verges (a wider clear run-off beside the GP
  // circuit), away from the signs.
  const trees = buildTrees((x, z) => {
    const at = t.locate(x, z);
    const roadside = at.road.halfWidth + (at.road === circuits.gp ? 22 : 8);
    if (at.distance < Math.max(at.rail ? at.rail + 1.2 : roadside, at.sandEdge + 4)) return false;
    return allSigns.every((s) => Math.hypot(s.x - x, s.z - z) > 6);
  }, terrainHeight, { points: roads.flatMap((r) => r.points), tangents: roads.flatMap((r) => r.tangents) },
  { count: 24000, tries: 480000, chunk: 400, near: 7.5, spread: 70, thick: true });
  return {
    kind: 'nurburgring',
    circuits,
    track: t,
    // ~70 km² of ground, in chunks drawn only when near.
    ground: ringTerrainChunks(20).map((c) => ({ mesh: upload(c), x: c.x, z: c.z, radius: c.radius })),
    groundLook: [[0.3, 0.55, 0.3], 'grass'],
    far: 1000,
    // What's underfoot off the timed road.
    offTrack: (x, z, where) => where.sand ? 'sand' : 'grass',
    layers: roads.flatMap((r) => r.layers).map((l) => ({ ...l, mesh: upload(l.mesh) })),
    signs,
    posts: signs.solids(),
    signParts: signs.parts().map(({ part, m }) => ({
      color: part === 'post' ? [0.55, 0.57, 0.6] : [0.3, 0.32, 0.35], mat: part === 'post' ? 'metal' : 'matte', model: basis(...m),
    })),
    trees: trees.pieces.map((p) => ({
      x: p.x, z: p.z, radius: p.radius,
      parts: [
        [upload(p.trunks), [0.36, 0.25, 0.16], 'bark'],
        [upload(p.pines), [0.13, 0.33, 0.18], 'needles'],
        [upload(p.leaves), [0.22, 0.45, 0.17], 'leaves'],
        [upload(p.leavesLight), [0.36, 0.55, 0.2], 'leaves'],
      ],
    })),
    gpu,
  };
}

// The Nürburgring's roads seen as one track: what's underfoot comes from the
// road the car is nearest (by how far past its asphalt), the lap clock and
// the corner names from the circuit being timed (`key`: 'ring' or 'gp').
function ringNetwork(circuits, links, key) {
  const roads = [...Object.values(circuits), ...links];
  // Bounding boxes, 100 m wider: a road further than that can't be the nearest.
  const boxes = roads.map((r) => {
    const xs = r.points.map((p) => p[0]), zs = r.points.map((p) => p[1]);
    return [Math.min(...xs) - 100, Math.max(...xs) + 100, Math.min(...zs) - 100, Math.max(...zs) + 100];
  });
  const net = {
    key,
    closed: true,
    get circuit() { return circuits[net.key]; },
    get points() { return net.circuit.points; },
    get sections() { return net.circuit.sections; },
    get grid() { return net.circuit.grid; },
    get length() { return net.circuit.length; },
    locate(x, z) {
      const timed = net.circuit, own = timed.locate(x, z);
      let best = own, road = timed, margin = own.distance - timed.halfWidth;
      roads.forEach((r, k) => {
        const b = boxes[k];
        if (r === timed || x < b[0] || x > b[1] || z < b[2] || z > b[3]) return;
        const at = r.locate(x, z), m = at.distance - r.halfWidth;
        if (m < margin) { best = at; road = r; margin = m; }
      });
      // Where on the timed circuit, whatever road the car is on.
      return { ...best, road, index: own.index, along: own.along };
    },
    sausageHeight: (x, z) => {
      let h = 0;
      for (const r of roads) h = Math.max(h, r.sausageHeight(x, z));
      return h;
    },
    blocked: (x, z) => {
      let hit = null;
      for (const r of roads) {
        const h = r.blocked?.(x, z);
        if (h && (!hit || h.depth > hit.depth)) hit = h;
      }
      return hit;
    },
  };
  return net;
}

// Open map, the island of Montreal: streets, buildings, trees and the rivers
// from map data (openmap.js). Streets, buildings, trees, lights and signs come
// in cells whose meshes are made when the car comes near and freed when it's
// far (see streamCells).
function buildMontrealWorld() {
  const t = buildOpenMap();
  const gpu = [];
  const upload = (m) => { const mesh = createMesh(gl, program, m); gpu.push(mesh); return mesh; };
  const signs = new Signs(gl, program, []);
  gpu.push(signs.faces);
  const traffic = new Traffic(t);
  const rules = new Rules(t, traffic), police = new Police(t, traffic);
  // Offences count only when the police see them (ramming one, they do).
  rules.witness = (kind) => kind === 'ramPolice' || police.witnessed();
  return {
    kind: 'montreal',
    // Traffic, and the lights and stop signs at the crossings.
    traffic,
    // The rules of the road, and the police who come after those who break them.
    rules,
    police,
    people: new Pedestrians(t),
    streetSigns: { texture: createTexture(gl, stopSignCanvas()) },
    track: t,
    // Lots of buildings and trees: far ones (mostly lost in the haze) aren't drawn.
    drawDistance: 800,
    treeDistance: 500,
    // The ground: a flat square that follows the car (in steps of its grid).
    ground: [{ mesh: upload(terrainMesh(6000, 250)), x: 0, z: 0, radius: Infinity, follow: 250 }],
    groundLook: [[0.3, 0.55, 0.3], 'grass'],
    far: 1000,
    offTrack: () => 'grass', // lawns and yards
    layers: t.layers.map((l) => ({ ...l, mesh: upload(l.mesh) })),
    signs,
    signParts: [],
    barriers: upload(t.barriers),
    cells: t.cells.map((data) => ({ x: data.x, data, buildings: null, trees: null, gpu: [], get z() { return data.z; }, get radius() { return data.radius; } })),
    loaded: new Set(),
    trees: [],
    gpu,
  };
}

// Montreal's stop sign, ARRÊT in white on a red octagon, filling the texture
// (the sign's octagon takes its UVs from the same shape).
function stopSignCanvas() {
  const n = 256, cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const g = cv.getContext('2d');
  const octagon = (r) => {
    g.beginPath();
    for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + (k * Math.PI) / 4; g.lineTo(n / 2 + Math.cos(a) * r, n / 2 - Math.sin(a) * r); }
    g.closePath();
  };
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, n, n);
  g.fillStyle = '#c4161c'; octagon(n * 0.47); g.fill();
  g.strokeStyle = '#ffffff'; g.lineWidth = n * 0.035; octagon(n * 0.43); g.stroke();
  g.fillStyle = '#ffffff';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold ${Math.round(n * 0.25)}px "Arial Narrow", Arial, sans-serif`;
  g.fillText('ARRÊT', n / 2, n / 2 + n * 0.01, n * 0.78);
  return cv;
}

// Smoke from a damaged engine and sparks from crashes: small boxes that
// drift, fade and fall. Drawn see-through, after everything else.
const puffs = [];
function puff(p) { if (puffs.length < 400) puffs.push(p); }
function sparks(x, y, z, nx, nz, strength) {
  const n = Math.min(40, Math.round(8 + strength * 30));
  for (let i = 0; i < n; i++) {
    const sp = 3 + Math.random() * 6 * (0.5 + strength);
    const a = Math.random() * Math.PI * 2;
    puff({
      x, y, z, vx: nx * sp + Math.cos(a) * sp * 0.6, vy: 1 + Math.random() * 3, vz: nz * sp + Math.sin(a) * sp * 0.6,
      age: 0, life: 0.25 + Math.random() * 0.35, size: 0.05, grow: 0, spark: true, gravity: 9.8,
    });
  }
}
let smokeWait = 0;
function updatePuffs(dt) {
  // Smoke out of the engine bay (the front of the Yaris, the rear of the 911) once it's hurt.
  const d = car.damage, engine = car.drive === 'front' ? d.front : d.rear, h = car.health;
  const hurt = Math.max(engine * 1.2, 1 - h);
  if (hurt > 0.45 && (smokeWait -= dt) <= 0) {
    smokeWait = 0.07 / Math.min(2, hurt);
    const v = model(car.variant).spec, F = carFrame(car);
    const z = car.drive === 'front' ? -(v.cgToFront + v.overhangFront) * 0.7 : (v.length - v.cgToFront - v.overhangFront) * 0.7;
    const [x, y, zz] = toWorld(F, (Math.random() - 0.5) * 0.6, 0.85, z);
    const dark = hurt > 0.8 || car.wrecked;
    puff({ x, y, z: zz, vx: (Math.random() - 0.5) * 0.8, vy: 0.8 + Math.random() * 0.8, vz: (Math.random() - 0.5) * 0.8, age: 0, life: 1.2 + Math.random() * 0.8, size: 0.22, grow: 2.2, shade: dark ? 0.15 : 0.6, gravity: -0.2, spin: Math.random() * 3 });
  }
  for (let i = puffs.length - 1; i >= 0; i--) {
    const p = puffs[i];
    p.age += dt;
    if (p.age > p.life) { puffs.splice(i, 1); continue; }
    p.vy -= p.gravity * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (p.spark && p.y < 0.05) { p.y = 0.05; p.vy *= -0.3; p.vx *= 0.6; p.vz *= 0.6; }
  }
}
function drawPuffs() {
  if (!puffs.length) return;
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
  gl.depthMask(false);
  for (const p of puffs) {
    const k = p.age / p.life, s = p.size * (1 + p.grow * k);
    const a = (p.spin ?? 0) + p.age, c = Math.cos(a), sn = Math.sin(a);
    const M = basis([p.x, p.y, p.z], [c, 0, -sn], [0, 1, 0], [sn, 0, c], s, s, s);
    if (p.spark) draw(meshes.cube, M, [1, 0.75 - 0.4 * k, 0.25], 'lamp', 1 - k);
    else draw(meshes.cube, M, [p.shade, p.shade, p.shade], 'matte', 0.32 * (1 - k) * Math.min(1, p.age * 6));
  }
  gl.depthMask(true);
  gl.disable(gl.BLEND);
}

// What the traffic needs to know of the player's car.
// (vx, vz): its velocity on the ground, slides included; yaw: its rate of turn (+ left).
const playerState = () => {
  const s = Math.sin(car.heading), c = Math.cos(car.heading);
  return { x: car.x, z: car.z, heading: car.heading, speed: car.speed, vx: -s * car.vx - c * car.vy, vz: -c * car.vx + s * car.vy, yaw: car.yawRate };
};

// Makes a cell's meshes (open map): streets, lights and signs, buildings, trees.
function loadCell(c) {
  const upload = (m) => { const mesh = createMesh(gl, program, m); c.gpu.push(mesh); return mesh; };
  const m = track.cellMeshes(c.data);
  const f = world.traffic.furniture(c.data.roads);
  c.layers = [
    [m.walk, [0.62, 0.62, 0.6], 'concrete', false],
    [m.asphalt, [0.3, 0.31, 0.33], 'asphalt', false],
    [m.yellow, [0.95, 0.75, 0.15], 'line', true],
    [m.white, [0.92, 0.92, 0.9], 'line', true],
    [f.lines, [0.92, 0.92, 0.9], 'line', true],
  ].filter(([mesh]) => mesh.positions.length).map(([mesh, ...rest]) => [upload(mesh), ...rest]);
  c.posts = f.posts.map(([x, z, r]) => [x, z, x, z, r]);
  c.furniture = f.poles.positions.length ? { poles: upload(f.poles), lamps: upload(f.lamps), backs: upload(f.backs), faces: upload(f.signs) } : null;
  world.loaded.add(c);
  c.buildings = [
    ...m.walls.map((w, i) => [w.positions.length && upload(w), BRICKS[i][0], 'facade']),
    [m.towers.positions.length && upload(m.towers), [0.32, 0.42, 0.5], 'curtain'],
    [m.sheds.positions.length && upload(m.sheds), [0.55, 0.5, 0.44], 'concrete'],
    [m.roofs.positions.length && upload(m.roofs), [0.27, 0.27, 0.28], 'concrete'],
  ].filter(([mesh]) => mesh);
  const p = buildTreesAt(m.trees, terrainHeight, 1e9).pieces[0];
  c.trees = p ? [
    [upload(p.trunks), [0.36, 0.25, 0.16], 'bark'],
    [upload(p.leaves), [0.22, 0.45, 0.17], 'leaves'],
    [upload(p.leavesLight), [0.36, 0.55, 0.2], 'leaves'],
  ].filter(([mesh]) => mesh.count) : [];
}
function unloadCell(c) {
  for (const m of c.gpu) deleteMesh(gl, m);
  c.gpu = [];
  c.buildings = c.trees = c.layers = c.furniture = c.posts = null;
  world?.loaded?.delete(c);
}
// Loads cells coming within reach of (x, z), nearest first (one per frame, so
// driving never stutters, but all those within `now` m at once), and frees
// those left far behind.
function streamCells(x, z, now = 0) {
  if (!world.cells) return;
  const near = (c) => Math.hypot(c.x - x, c.z - z) - c.radius;
  const want = [];
  for (const c of world.cells) {
    const d = near(c);
    if (c.buildings && d > world.drawDistance + 400) unloadCell(c);
    // (Once its part of the map is in: until then, it's being fetched.)
    else if (!c.buildings && d < world.drawDistance + 150 && track.cellReady(c.data)) want.push([d, c]);
  }
  want.sort((a, b) => a[0] - b[0]);
  for (const [d, c] of want) if (d < now || c === want[0][1]) loadCell(c);
}

const meshes = {
  cube: createMesh(gl, program, cube()),
  wheelRim: createMesh(gl, program, torus(0.17, 0.018)),
  wheel: createMesh(gl, program, cylinder()),
};
// Per-car drawing data: physics spec, wheel layout and body meshes.
const BODIES = { gt3: gt3Body, yaris: yarisBody };
const MODELS = {};
for (const name of Object.keys(VARIANTS)) {
  const spec = variantSpec(name);
  const b = BODIES[spec.body](spec);
  MODELS[name] = {
    ...b, spec, wheels: wheelLayout(spec),
    skin: createMesh(gl, program, b.skin), tub: createMesh(gl, program, b.tub),
    glass: createMesh(gl, program, b.glass), roofPanel: createMesh(gl, program, b.roofPanel),
  };
}
const DEFAULT_CAR = 'gt3';
// Traffic, police, people and their shadows (the open map).
const city = createCityRenderer(gl, program, draw);
const model = (variant) => MODELS[variant] ?? MODELS[DEFAULT_CAR];

// Grid starts a few meters before the line, facing along the track.
// On the open map, a start chosen on the map (picker.js) replaces the map's own.
let customStart = null; // { x, z, heading }
try {
  const v = JSON.parse(localStorage.getItem('start') ?? 'null');
  if (v && [v.x, v.z, v.heading].every(Number.isFinite)) customStart = v;
} catch {}
function startPose() {
  if (track.open && customStart) return [customStart.x, customStart.z, customStart.heading];
  const { x, z, tangent: [tx, tz] } = track.grid;
  return [x, z, Math.atan2(-tx, -tz)];
}

// Game options (settings panel), kept between visits: crash damage, and the
// police with the rules they enforce.
const options = { damage: true, police: true };
try { Object.assign(options, { damage: localStorage.getItem('damage') !== 'off', police: localStorage.getItem('police') !== 'off' }); } catch {}
function updateOptionBtns() {
  for (const [btn, on] of [[damageBtn, options.damage], [policeBtn, options.police]]) {
    btn?.setAttribute('aria-pressed', String(on));
    const b = btn?.querySelector('b'); if (b) b.textContent = on ? 'On' : 'Off';
  }
}
updateOptionBtns();
// A crash's damage to the player's car, if damage is on (car.js crash()).
const takeDamage = (zone, speed) => (options.damage ? car.crash(zone, speed) : 0);

let savedDrive = DEFAULT_CAR;
try { savedDrive = localStorage.getItem('drive') in VARIANTS ? localStorage.getItem('drive') : DEFAULT_CAR; } catch {}
const car = new Car(savedDrive);
const skids = new Skids(gl, program);
const sound = new Sound();
const updateSoundBtn = () => {
  soundBtn?.setAttribute('aria-pressed', String(sound.on));
  const v = soundBtn?.querySelector('b'); if (v) v.textContent = sound.on ? 'On' : 'Off';
};
updateSoundBtn();
let ghost = null;
let showGhost = true;
try { showGhost = localStorage.getItem('showGhost') !== 'off'; } catch {}
const updateGhostBtn = () => {
  ghostBtn?.setAttribute('aria-pressed', String(showGhost));
  const v = ghostBtn?.querySelector('b'); if (v) v.textContent = showGhost ? 'On' : 'Off';
};
updateGhostBtn();
function toggleGhost() {
  showGhost = !showGhost;
  try { localStorage.setItem('showGhost', showGhost ? 'on' : 'off'); } catch {}
  updateGhostBtn();
}
const cam = { x: 0, y: 4, z: 0 };
// Camera: 'cockpit' (driver's seat, the default) or 'chase' (behind the car).
let view = 'cockpit';
try { view = localStorage.getItem('view') === 'chase' ? 'chase' : 'cockpit'; } catch {}
const updateViewBtn = () => {
  const v = viewBtn?.querySelector('b'); if (v) v.textContent = view === 'cockpit' ? 'Cockpit' : 'Chase';
};
updateViewBtn();
function toggleView() {
  view = view === 'cockpit' ? 'chase' : 'cockpit';
  try { localStorage.setItem('view', view); } catch {}
  updateViewBtn();
}
let glance = 0; // cockpit head turn into corners (rad), smoothed
// Bounce over sausage kerbs: the body springs up, pitches and rolls with the
// wheels it rides on (visual only), and the wheels lift onto the humps.
const kerb = { lift: 0, vlift: 0, pitch: 0, vpitch: 0, roll: 0, vroll: 0, wheels: [0, 0, 0, 0] };
let lean = { pitch: 0, roll: 0, lift: 0, wheels: kerb.wheels }; // tilt + kerb, used to draw the car
// Laps: the track is split into 4 sectors; a lap counts only after visiting all of them.
// Best times are kept per layout and car.
const lap = { start: null, last: null, done: false, best: {}, sector: 3, visited: new Set(), along: 0 };

function setLayout(kind) {
  layout = kind;
  try { localStorage.setItem('layout', kind); } catch {}
  if (!world || world.kind !== MAPS[kind]) world = buildWorld(kind);
  track = world.track;
  if (world.circuits) track.key = kind;
  ghost = new Ghost(kind);
  if (!track.open) botLapsLoading ??= fetch('data/bot-laps.json').then((r) => r.json()).then((v) => { BOT_LAPS = v; }, () => { botLapsLoading = null; });
  lap.best = Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, ghost.best(v)]));
  lap.last = null;
  const b = layoutBtn?.querySelector('b'); if (b) b.textContent = LAYOUT_NAMES[kind];
  if (sectionRowEl) sectionRowEl.hidden = !track.sections && !track.open;
  // The open map has no laps: no timers, a minimap instead.
  for (const el of document.querySelectorAll('.lap-only')) el.hidden = !!track.open;
  for (const el of document.querySelectorAll('.city-only')) el.hidden = !track.open;
  if (picker.isOpen) picker.close();
  minimap.set(track.open ? track : null);
}

function switchDrive() {
  if (!world) return;
  const names = Object.keys(VARIANTS);
  car.setVariant(names[(names.indexOf(car.variant) + 1) % names.length]);
  try { localStorage.setItem('drive', car.variant); } catch {}
  resetRace();
}

function resetRace() {
  car.reset(...startPose());
  // The cells around the car now; the farther ones follow over the next frames.
  streamCells(car.x, car.z, 250);
  world.traffic?.unpark(car.x, car.z, 9);
  world.traffic?.reset(playerState());
  world.people?.reset(playerState());
  resetWheel();
  cam.x = car.x + Math.sin(car.heading) * 9;
  cam.z = car.z + Math.cos(car.heading) * 9;
  cam.y = terrainHeight(car.x, car.z) + 3.5;
  glance = 0;
  Object.assign(kerb, { lift: 0, vlift: 0, pitch: 0, vpitch: 0, roll: 0, vroll: 0, wheels: [0, 0, 0, 0] });
  lap.start = null;
  lap.done = false;
  lap.sector = 3;
  lap.along = track.locate(car.x, car.z).along;
  lap.visited.clear();
  ghost.stop();
  skids.clear();
  world.rules?.reset();
  world.police?.reset();
  puffs.length = 0;
  held = null;
  shake = 0;
  driveEl.querySelector('b').textContent = VARIANTS[car.variant].label;
}

function switchLayout() {
  if (!world) return;
  setLayout(LAYOUT_ORDER[(LAYOUT_ORDER.indexOf(layout) + 1) % LAYOUT_ORDER.length]);
  resetRace();
}

// Drove from one Nürburgring circuit onto the other: time that one from its
// next start/finish line, without moving the car.
function followCircuit(where) {
  if (!world.circuits || !where.onTrack) return;
  const key = Object.keys(world.circuits).find((k) => world.circuits[k] === where.road);
  if (!key || key === layout) return;
  setLayout(key);
  const at = track.locate(car.x, car.z);
  lap.start = null;
  lap.done = false;
  lap.sector = Math.floor((at.index / track.points.length) * 4);
  lap.visited.clear();
  ghost.stop();
}

function updateLap(index, now) {
  const sector = Math.floor((index / track.points.length) * 4);
  if (sector === lap.sector) return;
  if (lap.sector === 3 && sector === 0) {
    // Crossed the start/finish line going forward.
    if (lap.start !== null && lap.visited.size === 3) {
      lap.last = now - lap.start;
      const v = car.variant;
      if (lap.best[v] === null || lap.last < lap.best[v]) {
        lap.best[v] = lap.last;
        ghost.save(v, lap.last, car);
      }
    }
    lap.start = now;
    ghost.start();
    lap.visited.clear();
  } else if (sector !== 0) {
    lap.visited.add(sector);
  }
  lap.sector = sector;
}

const fmt = (ms) => {
  if (ms === null) return '–:––.––';
  const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

function resize() {
  const dpr = Math.min(devicePixelRatio, 2);
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
}

// mat: a material name from MAT (shading.js).
function draw(mesh, model, color, mat = 'matte', alpha = 1) {
  gl.uniformMatrix4fv(uModel, false, model);
  gl.uniform3fv(uColor, color);
  gl.uniform1i(uMat, MAT[mat]);
  gl.uniform1f(uAlpha, alpha);
  gl.bindVertexArray(mesh.vao);
  if (mesh.indexed) gl.drawElements(mesh.mode, mesh.count, gl.UNSIGNED_INT, 0);
  else gl.drawArrays(mesh.mode, 0, mesh.count);
}


// A car's frame, lying on the slope under it: origin on the road surface,
// right / up (surface normal) / back axes.
function carFrame({ x, z, heading: h }) {
  const up = terrainNormal(x, z);
  const f = [-Math.sin(h), 0, -Math.cos(h)];
  const d = f[0] * up[0] + f[1] * up[1] + f[2] * up[2];
  let fwd = [f[0] - up[0] * d, f[1] - up[1] * d, f[2] - up[2] * d];
  const l = Math.hypot(...fwd);
  fwd = fwd.map((v) => v / l);
  const back = fwd.map((v) => -v);
  const right = [up[1] * back[2] - up[2] * back[1], up[2] * back[0] - up[0] * back[2], up[0] * back[1] - up[1] * back[0]];
  return { o: [x, terrainHeight(x, z) + ROAD_LIFT, z], right, up, back };
}

// World position of a point given in a car's frame (x right, y up, z back).
const toWorld = (F, lx, ly, lz) => [0, 1, 2].map((i) => F.o[i] + F.right[i] * lx + F.up[i] * ly + F.back[i] * lz);

// Contact patches, from the same wheel layout the physics uses.
function wheelPositions(pose = car, m = model(car.variant)) {
  const F = carFrame(pose);
  return m.wheels.map(([side, ahead, front]) => {
    const [x, , z] = toWorld(F, side, 0, -ahead);
    return { x, z, y: terrainHeight(x, z) + ROAD_LIFT + 0.03, front, sliding: front ? pose.frontSliding : pose.rearSliding };
  });
}

const CAR_COLORS = { body: [0.85, 0.15, 0.15], cabin: [0.2, 0.2, 0.25], wheel: [0.08, 0.08, 0.08] };
// The paint gets scuffed and dull with damage.
function damagedColors() {
  const k = (1 - car.health) * 0.55;
  if (k <= 0) return CAR_COLORS;
  const mix = (c, to) => c.map((v, i) => v + (to[i] - v) * k);
  return { ...CAR_COLORS, body: mix(CAR_COLORS.body, [0.28, 0.24, 0.22]), cabin: mix(CAR_COLORS.cabin, [0.45, 0.47, 0.5]) };
}
const GHOST_COLORS = { body: [0.75, 0.9, 1], cabin: [0.55, 0.7, 0.85], wheel: [0.45, 0.55, 0.65], trim: [0.55, 0.7, 0.85], light: [0.75, 0.9, 1], tail: [0.75, 0.9, 1], rim: [0.45, 0.55, 0.65] };
// Claude's run (scripts/autodrive.mjs): same physics, amber so it's told apart.
const BOT_COLORS = { body: [1, 0.72, 0.2], cabin: [0.8, 0.55, 0.15], wheel: [0.55, 0.42, 0.2], trim: [0.8, 0.55, 0.15], light: [1, 0.72, 0.2], tail: [1, 0.72, 0.2], rim: [0.55, 0.42, 0.2] };

// The body leans on its springs: nose dives under braking, squats under
// throttle, rolls toward the outside of a turn.
function bodyFrame(F, lean) {
  let { right, up, back } = F;
  const o = F.o.map((v, i) => v + up[i] * (lean.lift ?? 0));
  up = rotate(up, right, lean.pitch); back = rotate(back, right, lean.pitch);
  up = rotate(up, back, lean.roll); right = rotate(right, back, lean.roll);
  return { o, right, up, back };
}

// Wheels on sausage kerbs: feeds the car's grip and kicks the body's bounce.
function updateKerbs(dt) {
  const on = [];
  const hs = wheelPositions().map((w, i) => {
    const h = track.sausageHeight(w.x, w.z);
    const [side, , front] = car.wheels[i];
    if (h > 0) on.push({ front, side: Math.sign(side), hit: kerb.wheels[i] === 0 });
    return h;
  });
  const s = Math.min(1, Math.abs(car.vx) / 25);
  for (const w of on) {
    if (!w.hit) continue;
    kerb.vlift += 0.9 * s;                                   // thump up
    kerb.vroll += w.side * 1.6 * s;                          // and toward the other side
    kerb.vpitch += (w.front ? 1 : -1) * 0.8 * s;
  }
  car.kerbs(on);
  kerb.wheels = hs;
  // Spring-damper toward resting on the wheels: ~3 Hz, well damped.
  const target = {
    lift: (hs[0] + hs[1] + hs[2] + hs[3]) / 4,
    roll: (hs[1] + hs[3] - hs[0] - hs[2]) / (car.trackFront + car.trackRear),
    pitch: (hs[0] + hs[1] - hs[2] - hs[3]) / (2 * car.wheelBase),
  };
  const n = Math.ceil(dt / 0.005), h = dt / n;
  for (let k = 0; k < n; k++) {
    for (const q of ['lift', 'roll', 'pitch']) {
      const v = 'v' + q;
      kerb[v] += (400 * (target[q] - kerb[q]) - 16 * kerb[v]) * h;
      kerb[q] += kerb[v] * h;
    }
  }
}

let lightsOn = false;
function drawCar(pose = car, colors = CAR_COLORS, alpha = 1, lean = { pitch: 0, roll: 0 }, cabin = true, m = model(car.variant)) {
  const F = carFrame(pose);
  const body = bodyFrame(F, lean);
  const { right, up, back } = body;
  const B = basis(body.o, right, up, back);
  draw(m.skin, B, colors.body, 'paint', alpha);
  draw(m.tub, B, colors.trim ?? TRIM, 'matte', alpha);
  if (cabin) {
    draw(m.glass, B, colors.cabin, 'glass', alpha);
    draw(m.roofPanel, B, colors.body, 'paint', alpha);
  }
  for (const p of m.parts) {
    if (!cabin && p.y > 0.98) continue; // wing and mirrors would clutter the cockpit view
    let c = p.color === 'body' ? colors.body : p.color === 'light' ? colors.light ?? [0.85, 0.88, 0.9]
      : p.color === 'tail' ? colors.tail ?? [0.75, 0.05, 0.05] : colors.trim ?? TRIM;
    let mat = p.mat;
    // The player's car (not a ghost) has its lights on at night.
    if (lightsOn && !colors.light && (p.color === 'light' || p.color === 'tail')) {
      c = p.color === 'light' ? [1, 0.97, 0.88] : [0.7, 0.06, 0.05];
      mat = 'lamp';
    }
    draw(meshes.cube, basis(toWorld(body, p.x, p.y, p.z), right, up, back, p.sx, p.sy, p.sz), c, mat, alpha);
  }
  // Wheels stay on the road frame and glow orange when past the grip peak.
  m.wheels.forEach(([side, ahead, front, radius, width], i) => {
    const sliding = front ? pose.frontSliding : pose.rearSliding;
    const a = front ? pose.steer : 0;
    const r = rotate(F.right, F.up, a), b = rotate(F.back, F.up, a);
    const color = sliding ? [0.95, 0.55, 0.1] : colors.wheel;
    const y = radius + (lean.wheels?.[i] ?? 0);
    const at = toWorld(F, side, y, -ahead);
    draw(meshes.wheel, basis(at, r, F.up, b, width, 2 * radius, 2 * radius), color, 'rubber', alpha);
    // Rim face, on the outside of the tire.
    const rim = [0, 1, 2].map((k) => at[k] + r[k] * Math.sign(side) * (width / 2 + 0.003));
    draw(meshes.wheel, basis(rim, r, F.up, b, 0.01, 1.4 * radius, 1.4 * radius), colors.rim ?? m.rim ?? [0.12, 0.12, 0.13], 'metal', alpha);
  });
}

// Driver's seat (left-hand drive) in the body frame (x right, y up, z back), from the car's body.
const eyeOf = (variant) => model(variant).cockpit.eye;
const INTERIOR = [0.13, 0.13, 0.15], DASH_TOP = [0.2, 0.2, 0.23], TRIM = [0.06, 0.06, 0.07];

// A box stretched between two body-frame points, w wide and h thick.
function drawBeam(B, a, b, w, h, color, mat) {
  const pa = toWorld(B, ...a), pb = toWorld(B, ...b);
  let ax = [0, 1, 2].map((i) => pb[i] - pa[i]);
  const len = Math.hypot(...ax);
  ax = ax.map((v) => v / len);
  let r = [ax[1] * B.up[2] - ax[2] * B.up[1], ax[2] * B.up[0] - ax[0] * B.up[2], ax[0] * B.up[1] - ax[1] * B.up[0]];
  const rl = Math.hypot(...r);
  r = r.map((v) => v / rl);
  const u = [r[1] * ax[2] - r[2] * ax[1], r[2] * ax[0] - r[0] * ax[2], r[0] * ax[1] - r[1] * ax[0]];
  const mid = [0, 1, 2].map((i) => (pa[i] + pb[i]) / 2);
  draw(meshes.cube, basis(mid, r, u, ax, w, h, len), color, mat);
}

// Dashboard, pillars, roof edge, mirror and a steering wheel that follows the input.
function drawCockpit() {
  const B = bodyFrame(carFrame(shown), lean);
  const box = (x, y, z, sx, sy, sz, c) => draw(meshes.cube, basis(toWorld(B, x, y, z), B.right, B.up, B.back, sx, sy, sz), c);
  const ck = model(car.variant).cockpit;
  const eye = eyeOf(car.variant);
  // Low dash under the screen, A-pillars along the glass, roof header.
  const w = car.width - 0.34;
  const [f0, f1] = ck.floorZ;
  box(0, ck.floorY, (f0 + f1) / 2, car.width - 0.2, 0.03, f1 - f0, TRIM);        // floor, hides the body's top
  box(0, ck.dashY - 0.07, ck.dashZ + 0.15, w, 0.14, 0.5, INTERIOR);          // dashboard
  box(0, ck.dashY + 0.005, ck.dashZ - 0.02, w, 0.01, 0.24, DASH_TOP);        // top of the dash, toward the glass
  box(eye[0], ck.dashY + 0.02, ck.dashZ + 0.33, 0.34, 0.05, 0.12, INTERIOR); // instrument hood
  for (const s of [-1, 1]) {
    const [px, py, pz] = ck.pillarBase, [tx, ty, tz] = ck.pillarTop;
    drawBeam(B, [s * px, py, pz], [s * tx, ty, tz], 0.05, 0.06, TRIM);       // A-pillar
    box(s * (car.width / 2 - 0.12), ck.dashY - 0.02, eye[2] - 0.05, 0.08, 0.14, 1.3, INTERIOR); // door top
  }
  box(0, ck.roofY, ck.roofZ, 2 * ck.pillarTop[0], 0.03, 0.06, TRIM);         // roof edge
  draw(meshes.cube, basis(toWorld(B, 0, ck.roofY - 0.06, ck.roofZ - 0.05), B.right, B.up, B.back, 0.2, 0.05, 0.02), [0.35, 0.38, 0.42], 'metal'); // mirror
  // Steering wheel, tilted toward the driver and turned with the input.
  const c = toWorld(B, eye[0], eye[1] - 0.25, eye[2] - 0.55);
  let wb = rotate(B.back, B.right, -0.42), wu = rotate(B.up, B.right, -0.42); // wheel axis and up
  const a = wheelAngle();
  const wr = rotate(B.right, wb, a);
  wu = rotate(wu, wb, a);
  draw(meshes.wheelRim, basis(c, wr, wu, wb), TRIM, 'rubber');
  const W = { o: c, right: wr, up: wu, back: wb };
  draw(meshes.cube, basis(c, wr, wu, wb, 0.08, 0.08, 0.05), [0.18, 0.18, 0.2]); // hub
  draw(meshes.cube, basis(toWorld(W, 0, 0.16, 0), wr, wu, wb, 0.03, 0.025, 0.025), [0.95, 0.77, 0.24], 'paint'); // top marker
  for (const s of [-1, 1]) draw(meshes.cube, basis(toWorld(W, s * 0.1, -0.01, 0), wr, wu, wb, 0.12, 0.03, 0.015), TRIM);
  draw(meshes.cube, basis(toWorld(W, 0, -0.1, 0), wr, wu, wb, 0.03, 0.12, 0.015), TRIM);
}

// The ghost is see-through and never hides anything behind it. Blending keeps
// the canvas alpha at 1 so the page never shows through.
function drawGhost(now) {
  if (!showGhost || lap.start === null) return;
  const t = now - lap.start;
  const ghosts = [[ghost.pose(car.variant, t), GHOST_COLORS], [ghost.pose(car.variant, t, BOT_LAPS[layout] ?? null), BOT_COLORS]];
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
  gl.depthMask(false);
  for (const [pose, colors] of ghosts) {
    if (!pose) continue;
    // Fade it out when it overlaps the player's car so the view stays clear.
    const d = Math.hypot(pose.x - shown.x, pose.z - shown.z);
    const alpha = 0.45 * Math.min(1, Math.max(0.5, d / 8));
    drawCar(pose, colors, alpha, { pitch: 0, roll: 0 });
  }
  gl.depthMask(true);
  gl.disable(gl.BLEND);
}

// The dot shows the push the driver feels: braking moves it up, a left turn
// moves it right. It sits inside the dashed ring (the grip limit) until the
// tires are maxed out.
function updateGMeter() {
  const clampR = (x, y, r) => { const d = Math.hypot(x, y); return d > r ? [x * r / d, y * r / d] : [x, y]; };
  const [x, y] = clampR(car.gLat * G_SCALE, car.gLong * G_SCALE, 42);
  gdotEl.setAttribute('cx', x.toFixed(1));
  gdotEl.setAttribute('cy', y.toFixed(1));
  glimitEl.setAttribute('r', Math.min(42, car.gripLimit * G_SCALE).toFixed(1));
  gTrail.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  if (gTrail.length > 30) gTrail.shift();
  gtrailEl.setAttribute('points', gTrail.join(' '));
  gvalEl.textContent = Math.hypot(car.gLong, car.gLat).toFixed(2);
  const use = Math.max(car.tires.front.use, car.tires.rear.use);
  guseEl.textContent = `${Math.min(100, Math.round(use * 100))}%`;
  const sliding = car.frontSliding || car.rearSliding;
  gmeterEl.classList.toggle('slide', sliding);
  gmeterEl.classList.toggle('near', !sliding && use > 0.85);
}

// Tire color by temperature: blue when cold, green across the grip window,
// then amber and red as they overheat. Blended between stops so the change is gradual.
const TIRE_COLORS = [
  [45, [108, 196, 255]], [TIRE_TEMP.optLo, [79, 209, 122]], [TIRE_TEMP.optHi, [79, 209, 122]],
  [115, [255, 196, 61]], [130, [255, 107, 90]],
];
function tireColor(t) {
  let i = 0;
  while (i < TIRE_COLORS.length - 1 && t > TIRE_COLORS[i + 1][0]) i++;
  const [t0, c0] = TIRE_COLORS[i], [t1, c1] = TIRE_COLORS[Math.min(i + 1, TIRE_COLORS.length - 1)];
  const k = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
  return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(',')})`;
}
function updateTires() {
  const { front, rear } = car.tires;
  const cf = tireColor(front.temp), cr = tireColor(rear.temp);
  tireEls.forEach((el, i) => { el.style.fill = i < 2 ? cf : cr; });
  tireTextEls.front.textContent = `${Math.round(front.temp)}°`;
  tireTextEls.rear.textContent = `${Math.round(rear.temp)}°`;
  tireTextEls.front.style.color = cf;
  tireTextEls.rear.style.color = cr;
  // The axle furthest from the window sets the label; grip lost shown as a %.
  const worst = Math.abs(front.temp - 90) > Math.abs(rear.temp - 90) ? front.temp : rear.temp;
  const lost = Math.round((1 - Math.min(tempGrip(front.temp), tempGrip(rear.temp))) * 100);
  const state = worst < TIRE_TEMP.optLo ? 'Cold' : worst > TIRE_TEMP.optHi ? 'Hot' : 'Optimal';
  tireStateEl.textContent = lost > 0 ? `${state} −${lost}%` : state;
  tireStateEl.style.color = tireColor(worst);
  tiresEl.setAttribute('aria-label', `Tire temperatures: front ${Math.round(front.temp)}, rear ${Math.round(rear.temp)} degrees, ${state.toLowerCase()}`);
}

// Buildings, the map's edge and other cars (open map; the guardrails at the
// Nürburgring): points around the car's outline that end up inside one push it
// back out, and the speed into it is lost (a little bounce, some scrub along
// it). How fast it went in, against what the obstacle was doing, is the
// crash: it damages the side of the car that took it (car.js crash()).
let shake = 0; // camera shake after a crash (m), decays

// Poles and sign boards near the car, as [ax, az, bx, bz, radius] (a post is a
// zero-length line): the Nürburgring's corner boards, the open map's lamp
// posts, traffic lights and stop signs (of the cells loaded around the car).
function postsNear(x, z, reach) {
  const out = [];
  const add = (list) => {
    for (const p of list) if (Math.min(Math.hypot(p[0] - x, p[1] - z), Math.hypot(p[2] - x, p[3] - z)) < reach) out.push(p);
  };
  if (world.posts) add(world.posts);
  for (const c of world.loaded ?? []) if (c.posts && Math.hypot(c.x - x, c.z - z) < c.radius + reach) add(c.posts);
  return out;
}

// The deepest a post goes into the car's outline (a box `f` ahead of its
// middle, `r` behind, `hw` each side): the push out of it (nx, nz), depth and
// where they touch, as blocked() gives; null if none does.
function postHit(posts, f, r, hw) {
  const s = Math.sin(car.heading), c = Math.cos(car.heading);
  // forward = (-sin, -cos), right = (cos, -sin)
  const fx = -s, fz = -c, rx = c, rz = -s;
  let best = null;
  for (const [ax, az, bx, bz, rad] of posts) {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.2));
    for (let i = 0; i <= n; i++) {
      const px = ax + ((bx - ax) * i) / n, pz = az + ((bz - az) * i) / n;
      const ox = px - car.x, oz = pz - car.z, a = ox * fx + oz * fz, b = ox * rx + oz * rz;
      const ca = clamp(a, -r, f), cb = clamp(b, -hw, hw);
      let h;
      if (ca !== a || cb !== b) {
        // Outside: the outline's nearest point is pushed away from the post.
        const d = Math.hypot(a - ca, b - cb);
        if (d >= rad) continue;
        const ua = (ca - a) / d, ub = (cb - b) / d;
        h = { depth: rad - d, nx: fx * ua + rx * ub, nz: fz * ua + rz * ub, at: [car.x + fx * ca + rx * cb, car.z + fz * ca + rz * cb] };
      } else {
        // Inside: out the nearest side, past the post.
        const sides = [[f - a, 1, 0], [a + r, -1, 0], [hw - b, 0, 1], [b + hw, 0, -1]].sort((p, q) => p[0] - q[0]);
        const [d, ea, eb] = sides[0];
        h = { depth: d + rad, nx: -(fx * ea + rx * eb), nz: -(fz * ea + rz * eb), at: [px, pz] };
      }
      if (!best || h.depth > best.depth) best = h;
    }
  }
  return best;
}

function collide() {
  if (!track.blocked) return;
  const v = model(car.variant).spec;
  const f = v.cgToFront + v.overhangFront, r = v.length - f, hw = v.width / 2;
  const outline = [];
  for (const a of [f, f / 2, 0, -r / 2, -r]) for (const b of [-hw, hw]) outline.push([a, b]);
  outline.push([f, 0], [-r, 0]);
  let impact = null;
  const posts = postsNear(car.x, car.z, 8);
  for (let pass = 0; pass < 3; pass++) {
    const s = Math.sin(car.heading), c = Math.cos(car.heading);
    let hit = null, at = null;
    for (const [a, b] of outline) {
      // forward = (-sin, -cos), right = (cos, -sin)
      const px = car.x - s * a + c * b, pz = car.z - c * a - s * b;
      let h = track.blocked(px, pz);
      if (h) h.what = 'wall';
      else if ((h = world.traffic?.blocked(px, pz))) h.what = 'car';
      else if ((h = world.police?.blocked(px, pz))) h.what = 'police';
      if (h && (!hit || h.depth > hit.depth)) { hit = h; at = [px, pz]; }
    }
    const ph = posts.length ? postHit(posts, f, r, hw) : null;
    if (ph && (!hit || ph.depth > hit.depth)) { hit = ph; hit.what = 'wall'; at = ph.at; }
    if (!hit) break;
    car.x += hit.nx * (hit.depth + 0.02);
    car.z += hit.nz * (hit.depth + 0.02);
    // The obstacle's own velocity along the push (other cars move).
    const o = hit.car ?? hit.police;
    const on = !o ? 0 : o.wx !== undefined ? o.wx * hit.nx + o.wz * hit.nz : (o.dx * hit.nx + o.dz * hit.nz) * o.v;
    const wx = -s * car.vx - c * car.vy, wz = -c * car.vx + s * car.vy;
    const wn = wx * hit.nx + wz * hit.nz, rel = wn - on;
    if (rel < 0) {
      // Remove the push into it (plus a 20% bounce), scrub 30% of the slide along
      // it. A traffic car takes its share of the blow by weight: it's shoved
      // away and spun, and the player's car keeps the rest of its way.
      const tx = (wx - wn * hit.nx) * 0.7, tz = (wz - wn * hit.nz) * 0.7;
      const moving = hit.car && !hit.car.parked, mc = moving ? hit.car.kind.mass : Infinity;
      const ours = moving ? v.mass / (v.mass + mc) : 0;
      if (moving) { const dv = 1.2 * rel * ours; world.traffic.knock(hit.car, hit.nx * dv, hit.nz * dv, at[0], at[1]); }
      const n = wn - rel * 1.2 * (1 - ours);
      const ux = tx + n * hit.nx, uz = tz + n * hit.nz;
      car.vx = -s * ux - c * uz;
      car.vy = -c * ux + s * uz;
      car.yawRate *= 0.5;
      if (!impact || -rel > impact.speed) impact = { speed: -rel, hit, at, own: wn < -2 };
    }
  }
  if (impact) crashed(impact);
}

// The car hit something at impact.speed (m/s).
function crashed({ speed, hit, at, own }) {
  // Which side took it: where the obstacle is, in the car's frame.
  const s = Math.sin(car.heading), c = Math.cos(car.heading);
  const ahead = -hit.nx * -s + -hit.nz * -c, right = -hit.nx * c + -hit.nz * -s;
  const zone = Math.abs(ahead) > 0.6 ? (ahead > 0 ? 'front' : 'rear') : right > 0 ? 'right' : 'left';
  const amount = takeDamage(zone, speed);
  if (speed < 2.5) return;
  const k = Math.min(1, speed / 20);
  sound.crash(k);
  shake = Math.max(shake, 0.04 + 0.25 * k);
  if (speed > 4) sparks(at[0], ROAD_LIFT + 0.4, at[1], hit.nx, hit.nz, k);
  // Your doing: driving into another car (a patrol car is worse).
  if (own && world.rules && hit.what !== 'wall') world.rules.report(hit.what === 'police' ? 'ramPolice' : 'crash');
  if (hit.car) world.traffic.hit(hit.car, speed);
  if (amount > 0.02) flashDamage();
}

// A patrol car drove into the player's car (police.js): it's shoved the way
// the patrol car was going and spun around its middle, and the side that took
// it is damaged.
function shoved(e) {
  const s = Math.sin(car.heading), c = Math.cos(car.heading);
  const rx = e.x - car.x, rz = e.z - car.z, ahead = rx * -s + rz * -c, right = rx * c + rz * -s;
  const zone = Math.abs(ahead) / 2.3 > Math.abs(right) / 0.95 ? (ahead > 0 ? 'front' : 'rear') : right > 0 ? 'right' : 'left';
  const dv = Math.min(12, e.speed * 0.45), wx = e.nx * dv, wz = e.nz * dv;
  car.vx += -s * wx - c * wz;
  car.vy += -c * wx + s * wz;
  car.yawRate -= clamp((rx * wz - rz * wx) * 0.3, -2.5, 2.5);
  const amount = takeDamage(zone, e.speed * 0.8);
  const k = Math.min(1, e.speed / 20);
  sound.crash(k);
  shake = Math.max(shake, 0.05 + 0.25 * k);
  sparks(e.x, ROAD_LIFT + 0.5, e.z, -e.nx, -e.nz, k);
  if (amount > 0.02) flashDamage();
}

// --- the police and the HUD around them --------------------------------------
let held = null; // busted: { until } (ms), the car waits, then goes back to the start
let toastTimer = 0;
function toast(text) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.remove('show');
  void toastEl.offsetWidth; // restart the fade
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}
function flashDamage() {
  const row = healthEl?.parentElement;
  if (!row) return;
  row.classList.remove('hit');
  void row.offsetWidth;
  row.classList.add('hit');
}
function banner(title, sub = '', kind = '') {
  if (!bannerEl) return;
  bannerEl.hidden = !title;
  bannerEl.className = kind;
  bannerEl.querySelector('b').textContent = title;
  bannerEl.querySelector('span').textContent = sub;
}

// What being caught costs, by wanted level ($), plus some per point.
const FINES = [0, 150, 600, 1500, 4000, 10000];
let fines = 0; // paid so far, kept between visits
try { fines = Number(localStorage.getItem('fines')) || 0; } catch {}
const money = (n) => `$${n.toLocaleString('en-CA')}`;

function updatePolice(h, now) {
  const p = world.police, ps = playerState();
  p.update(h, ps, car.wrecked);
  world.traffic.extra = p.cars;
  for (const e of p.take()) {
    if (e.kind === 'busted') {
      const fine = FINES[e.level] + e.points * 50;
      fines += fine;
      try { localStorage.setItem('fines', fines); } catch {}
      // One star: a ticket at the roadside, and on you go. More: the car is
      // taken away and you start over.
      const ticket = e.level <= 1 && !car.wrecked;
      held = { until: now + (ticket ? 2800 : 4000), ticket };
      banner(ticket ? 'Ticket' : 'Busted', ticket ? `Fine: ${money(fine)} · drive on` : `Fine: ${money(fine)} · car impounded, back to the start`, 'busted');
    } else if (e.kind === 'escaped') {
      toast('You lost them');
    } else if (e.kind === 'level') {
      toast(`${'★'.repeat(e.level)}  ${e.note}`);
    } else if (e.kind === 'evading') {
      toast(`Evading the police  +${e.points}`);
    } else if (e.kind === 'rammed') {
      shoved(e);
    } else if (e.kind === 'spiked') {
      if (!options.damage) continue;
      car.flats = 1;
      sound.hiss();
      toast('Spike strip · tires flat');
    } else if (e.kind === 'roadblock') {
      toast(e.spikes ? 'Roadblock and spikes ahead' : 'Roadblock ahead');
    } else if (e.kind === 'heli') {
      toast(e.on ? 'Helicopter overhead' : 'Helicopter leaving for fuel');
    }
  }
  let nearest = Infinity;
  for (const u of p.units) nearest = Math.min(nearest, Math.hypot(u.x - car.x, u.z - car.z));
  sound.sirens(p.state === 'pursuit' ? nearest : Infinity);
  sound.heli(p.heli ? Math.hypot(p.heli.dist ?? 900, p.heli.y) : Infinity);

  // The street's own life: people jumping out of the way, drivers on the horn.
  world.people.update(h, ps);
  for (const e of world.people.take()) if (e.sidewalk && !held) world.rules.report('pedestrian');
  for (const e of world.traffic.take()) if (e.kind === 'honk') sound.horn(Math.hypot(e.car.x - car.x, e.car.z - car.z));
}

damageBtn?.addEventListener('click', () => {
  options.damage = !options.damage;
  try { localStorage.setItem('damage', options.damage ? 'on' : 'off'); } catch {}
  // Off: the car is whole again, and stays so.
  if (!options.damage) { Object.assign(car.damage, { front: 0, rear: 0, left: 0, right: 0 }); car.flats = 0; }
  updateOptionBtns();
  toast(options.damage ? 'Damage on' : 'Damage off · car repaired');
});
policeBtn?.addEventListener('click', () => {
  options.police = !options.police;
  try { localStorage.setItem('police', options.police ? 'on' : 'off'); } catch {}
  // Off: whoever was chasing goes home, and nothing is an offence any more.
  if (!options.police && world.police && !held) { world.police.reset(); world.rules.reset(); }
  updateOptionBtns();
  toast(options.police ? 'Police on' : 'Police off · drive as you like');
});

// The start picker: a map of the island to choose where the car is put down.
const picker = new StartPicker(document.getElementById('picker'), (start) => {
  customStart = start;
  try { if (start) localStorage.setItem('start', JSON.stringify(start)); else localStorage.removeItem('start'); } catch {}
  resetRace();
  syncPose();
});
function openPicker() {
  if (!track.open) { toast('The start can be chosen on the Montreal map'); return; }
  picker.open(track, car);
}
startBtn?.addEventListener('click', openPicker);
addEventListener('keydown', (e) => { if (e.code === 'KeyP' && !e.repeat && !picker.isOpen) openPicker(); });

// The next street that crosses the one the car is on, for the HUD (looked up a few times a second).
let crossWait = 0;
function updateCrossStreet(dt) {
  if ((crossWait -= dt) > 0) return;
  crossWait = 0.25;
  const fwd = car.speed < -0.5 ? -1 : 1;
  const c = after.road && after.edge < after.road.walk + 6
    ? world.traffic.crossingAhead(after.road, car.x, car.z, -Math.sin(car.heading) * fwd, -Math.cos(car.heading) * fwd, after.tangent) : null;
  crossRowEl.hidden = !c;
  if (!c) return;
  const d = c.distance < 95 ? Math.round(c.distance / 10) * 10 : Math.round(c.distance / 50) * 50;
  const text = `${c.name} · ${d < 20 ? 'here' : d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${d} m`}`;
  if (crossEl.textContent !== text) crossEl.textContent = text;
}

// Health, wanted level and speed limit, and the overlays: busted, wrecked,
// red and blue at the screen's edges while patrol cars are close.
function updateLawHud(cockpit) {
  const hp = Math.round(car.health * 100);
  healthEl.textContent = `${hp}%`;
  healthBarEl.style.width = `${hp}%`;
  healthBarEl.style.background = hp > 60 ? 'var(--gas)' : hp > 30 ? 'var(--accent)' : 'var(--brake)';
  const p = world.police, limit = world.rules?.limit ?? null;
  wantedRowEl.hidden = !p || p.state === 'clear'; // only while wanted
  limitEl.hidden = !limit;
  if (limit && limitEl.textContent !== String(limit)) limitEl.textContent = limit;
  limitEl.classList.toggle('over', !!limit && Math.abs(car.speed * 3.6) > limit + 10);
  finesRowEl.hidden = !p || !fines;
  if (p && fines) { const f = money(fines); if (finesEl.textContent !== f) finesEl.textContent = f; }
  if (p) {
    const stars = '★'.repeat(p.level) + '☆'.repeat(5 - p.level);
    if (starsEl.textContent !== stars) starsEl.textContent = stars;
    starsEl.classList.toggle('on', p.wanted);
    const st = p.status();
    if (wantedEl.textContent !== st) wantedEl.textContent = st;
    let near = Infinity;
    for (const u of p.cars) near = Math.min(near, Math.hypot(u.x - car.x, u.z - car.z));
    pursuitEl.style.opacity = p.state === 'pursuit' ? Math.max(0.15, Math.min(1, 1 - near / 200)).toFixed(2) : '0';
  } else pursuitEl.style.opacity = '0';
  if (!held) banner(car.wrecked ? 'Wrecked' : '', car.wrecked ? 'Press Reset (R) to tow it and repair' : '', 'wrecked');
  // A cracked windshield, seen from the seat.
  const crack = cockpit ? Math.max(0, Math.min(1, (car.damage.front - 0.2) / 0.5)) : 0;
  crackEl.style.opacity = crack.toFixed(2);
}

// Physics runs on its own fixed clock, faster than the screen refreshes: each
// frame runs however many physics ticks fit in the time that passed (often
// several), and the car is drawn between the last two ticks so motion stays
// smooth whatever the display rate.
const PHYSICS_HZ = Math.round(1 / PHYSICS_STEP);
const MAX_TICKS = Math.ceil(0.05 * PHYSICS_HZ); // after a stall, slow down rather than spiral
let physicsLag = 0;  // simulated time owed (s)
let simTime = 0;     // physics clock (ms): lap times and the ghost run on it
let prevPose = null; // car pose before the last physics tick
let where = null, after = null, surface = 'road';
let shown = null;    // the car's pose to draw this frame

const poseOf = (c) => ({ x: c.x, z: c.z, heading: c.heading });
function syncPose() {
  prevPose = poseOf(car);
  physicsLag = 0;
}

// One fixed physics step of the player's car and everything it touches.
function physicsTick(h, controls) {
  prevPose = poseOf(car);
  where = track.locate(car.x, car.z);
  surface = where.surface ?? world.offTrack(car.x, car.z, where);
  updateKerbs(h);
  car.update(h, controls, surface, terrainSample(car.x, car.z));
  collide();
  simTime += h * 1000;
  after = track.locate(car.x, car.z);
  if (world.circuits && after.onTrack && after.road !== track.circuit) {
    followCircuit(after);
    after = track.locate(car.x, car.z);
  }
  if (!track.open) updateLap(after.index, simTime); // the open map has no clock
  if (world.rules && !held) {
    world.rules.update(h, car, after);
    for (const o of world.rules.take()) {
      if (!options.police) continue;
      world.police.add(o.points);
      toast(`${o.label}  +${o.points}`);
    }
  }
  if (lap.start !== null && !lap.done) ghost.record(simTime - lap.start, car);
  wheelPositions().forEach((w, i) => skids.track(i, w.x, w.y, w.z, w.sliding));
}

let last = performance.now();
function frame(now) {
  // rAF timestamps can be a little older than performance.now(): never step back in time.
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;

  const controls = readControls(dt);
  // Busted: the car is held (brakes on) until it's taken back to the start.
  if (held) Object.assign(controls, { throttle: 0, brake: 0, steer: 0, handbrake: 1 });
  if (held && now > held.until) {
    // A ticket: the slate is clean, drive on. Arrested: back to the start.
    if (held.ticket) { world.police.reset(); world.rules.reset(); banner(''); } else controls.reset = true;
    held = null;
  }
  if (controls.toggleGhost) toggleGhost();
  if (controls.toggleView) toggleView();
  if (controls.toggleSound) { sound.toggle(); updateSoundBtn(); }
  if (controls.switchLayout) switchLayout();
  else if (controls.switchDrive) switchDrive();
  else if (controls.reset) resetRace();
  if (prevPose === null || controls.switchLayout || controls.switchDrive || controls.reset) syncPose();

  // The hour and the weather; the tires feel the snow and the rain.
  climate.update(picker.isOpen ? 0 : dt);
  car.weatherGrip = climate.grip(surface ?? 'road');
  // The game stands still while the start picker is open.
  if (!picker.isOpen) physicsLag += dt;
  let ticks = 0;
  for (; physicsLag >= PHYSICS_STEP && ticks < MAX_TICKS; ticks++) {
    physicsTick(PHYSICS_STEP, controls);
    physicsLag -= PHYSICS_STEP;
  }
  if (ticks === MAX_TICKS) physicsLag = Math.min(physicsLag, PHYSICS_STEP);
  if (!where) { where = after = track.locate(car.x, car.z); surface = where.surface ?? world.offTrack(car.x, car.z, where); }
  // Traffic runs its own lighter physics (traffic.js), once a frame for the physics time that passed.
  world.traffic?.update(ticks * PHYSICS_STEP, playerState());
  if (world.police) updatePolice(ticks * PHYSICS_STEP, now);
  updatePuffs(dt);
  sound.update(dt, car, surface);

  // Where the car is drawn: between the last two physics ticks.
  const a = physicsLag / PHYSICS_STEP;
  let dh = car.heading - prevPose.heading;
  dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI;
  shown = Object.create(car, {
    x: { value: prevPose.x + (car.x - prevPose.x) * a },
    z: { value: prevPose.z + (car.z - prevPose.z) * a },
    heading: { value: car.heading - dh * (1 - a) },
  });
  const clock = simTime + physicsLag * 1000; // the physics clock at this frame

  // The body as the suspension holds it (see car.js), plus the kerb bounce.
  const b = car.body;
  // A crushed corner sits lower: the nose (or tail) drops, the body leans to
  // the hit side (seen from outside; from the seat it would just tilt the view).
  const dmg = car.damage, sag = view === 'cockpit' ? 0 : 1;
  lean = {
    pitch: b.pitch + kerb.pitch + sag * (-0.05 * dmg.front + 0.04 * dmg.rear),
    roll: b.roll + kerb.roll + sag * 0.045 * (dmg.left - dmg.right),
    lift: kerb.lift - clamp(b.heave, -0.1, 0.1), wheels: kerb.wheels,
  };
  const carY = terrainHeight(shown.x, shown.z);

  // Chase camera: lag behind the car, smoothed.
  const back = 9, height = 3.5;
  const tx = shown.x + Math.sin(shown.heading) * back;
  const tz = shown.z + Math.cos(shown.heading) * back;
  const k = Math.min(1, dt * 4);
  cam.x += (tx - cam.x) * k;
  cam.z += (tz - cam.z) * k;
  cam.y += (carY + height - cam.y) * k;
  cam.y = Math.max(cam.y, terrainHeight(cam.x, cam.z) + 1.2); // never inside a hill

  resize();
  depthTarget?.begin(canvas.width, canvas.height);
  gl.clearColor(...climate.horizon, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const aspect = canvas.width / canvas.height;
  // Keep a usable horizontal view on tall (portrait phone) screens.
  const fovy = aspect < 1 ? 2 * Math.atan(Math.tan(Math.PI / 6) * 0.8 / aspect) : Math.PI / 3;
  const cockpit = view === 'cockpit';
  let viewMat, eyePos;
  if (cockpit) {
    // Eye rides the leaning body; it looks a touch down and glances into turns.
    glance += (Math.max(-0.25, Math.min(0.25, car.yawRate * 0.12)) - glance) * Math.min(1, dt * 3);
    const B = bodyFrame(carFrame(shown), lean);
    const eye = toWorld(B, ...eyeOf(car.variant));
    const dir = rotate(rotate(B.back.map((v) => -v), B.right, -0.08), B.up, glance);
    viewMat = lookAt(eye, [0, 1, 2].map((i) => eye[i] + dir[i]), B.up);
    eyePos = eye;
  } else {
    eyePos = [cam.x, cam.y, cam.z];
    viewMat = lookAt(eyePos, [shown.x, carY + 1, shown.z], [0, 1, 0]);
  }
  if (shake > 0.002) {
    // After a crash the view jolts, then settles.
    const j = [0, 1, 2].map(() => (Math.random() - 0.5) * shake);
    eyePos = eyePos.map((v, i) => v + j[i]);
    viewMat = multiply(viewMat, basis([-j[0], -j[1], -j[2]], [1, 0, 0], [0, 1, 0], [0, 0, 1]));
  }
  shake *= Math.exp(-dt * 7);
  // The cockpit sees a little wider, but never so tall upright that the windshield shrinks to a strip.
  const camFov = cockpit ? Math.min(fovy * 1.1, aspect < 1 ? (80 * Math.PI) / 180 : Infinity) : fovy;
  const proj = perspective(camFov, aspect, cockpit ? 0.05 : 0.1, world.far, !!depthTarget);
  const viewProj = multiply(proj, viewMat);
  streamCells(eyePos[0], eyePos[2]);
  sky.draw(viewProj, eyePos, now / 1000, climate);
  gl.useProgram(program);
  gl.uniformMatrix4fv(uViewProj, false, viewProj);
  gl.uniform3fv(uCam, eyePos);
  gl.uniform3fv(uFog, climate.horizon);
  gl.uniform3fv(uZenith, climate.zenith);
  gl.uniform3fv(uSun, climate.key);
  gl.uniform1f(uTime, world.traffic?.clock ?? 0);
  gl.uniform3fv(U.uSunCol, climate.keyCol);
  gl.uniform3fv(U.uAmb, climate.amb);
  gl.uniform3fv(U.uAmbGround, climate.ambGround);
  gl.uniform3fv(U.uGroundEnv, climate.groundEnv);
  gl.uniform2fv(U.uFogRange, climate.fog);
  gl.uniform1f(U.uSnow, climate.snow);
  gl.uniform1f(U.uWet, climate.wet);
  gl.uniform1f(U.uLeaf, climate.leaf);
  gl.uniform1f(U.uAutumn, climate.autumn);
  gl.uniform1f(U.uFresh, climate.fresh);
  gl.uniform3fv(U.uGrass, climate.grass);
  gl.uniform1f(U.uNight, climate.night);
  // Montreal's streets are lit at night; the Nürburgring isn't.
  gl.uniform1f(U.uStreet, world.traffic ? climate.night : 0);
  lightsOn = climate.headlights;
  {
    // The headlights: from the nose, a little up, aimed a touch down the road ahead.
    const B = bodyFrame(carFrame(shown), lean);
    const len = model(car.variant).spec.length ?? 4.4;
    const at = toWorld(B, 0, 0.7, -len / 2);
    const dir = rotate(B.back.map((v) => -v), B.right, -0.045);
    gl.uniform3fv(U.uHeadPos, at);
    gl.uniform3fv(U.uHeadDir, dir);
    gl.uniform1f(U.uHeadOn, lightsOn ? 0.2 + 0.8 * climate.night : 0);
  }
  city.setSun(climate.key, climate.keyStrength);
  city.setLights(lightsOn);

  // Road layers sit a few cm above the ground; polygon offset keeps them from
  // z-fighting with it (and the start line and skids with the road) far away.
  // Toward the eye is up in reversed-Z depth, down otherwise.
  const pull = depthTarget ? 1 : -1;
  gl.disable(gl.CULL_FACE);
  const seen = (c, far = world.drawDistance ?? DRAW_DISTANCE) => Math.hypot(c.x - eyePos[0], c.z - eyePos[2]) - c.radius < far;
  for (const g of world.ground) {
    if (!seen(g)) continue;
    // A ground that follows the car moves in whole steps of its grid.
    const at = g.follow ? basis([Math.round(eyePos[0] / g.follow) * g.follow, 0, Math.round(eyePos[2] / g.follow) * g.follow], [1, 0, 0], [0, 1, 0], [0, 0, 1]) : identity();
    draw(g.mesh, at, ...world.groundLook);
  }
  // The open map's cells in view, with their meshes made.
  const cells = world.loaded ? [...world.loaded].filter((c) => seen(c)) : [];
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(pull, 2 * pull);
  for (const l of world.layers) if (!l.top) draw(l.mesh, identity(), l.color, l.mat);
  for (const c of cells) for (const [mesh, color, mat, top] of c.layers) if (!top) draw(mesh, identity(), color, mat);
  gl.polygonOffset(2 * pull, 4 * pull);
  for (const l of world.layers) if (l.top) draw(l.mesh, identity(), l.color, l.mat);
  for (const c of cells) for (const [mesh, color, mat, top] of c.layers) if (top) draw(mesh, identity(), color, mat);
  if (skids.used) draw(skids.mesh, identity(), [0.12, 0.12, 0.13], 'rubber');
  if (world.traffic) {
    // Soft shadows under the cars and the people, and the helicopter's light.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.depthMask(false);
    const casters = city.casters(eyePos, world.traffic, world.police, world.people.people);
    const v = model(car.variant).spec;
    casters.push({ x: shown.x, z: shown.z, dx: -Math.sin(shown.heading), dz: -Math.cos(shown.heading), length: v.length, width: v.width, height: 1.2 });
    city.shadows(casters, ROAD_LIFT + 0.01, eyePos);
    city.spot(world.police.heli, shown, ROAD_LIFT + 0.012);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
  gl.disable(gl.POLYGON_OFFSET_FILL);
  for (const c of cells) {
    if (!c.trees || !seen(c, world.treeDistance)) continue;
    for (const [mesh, color, mat] of c.trees) draw(mesh, identity(), color, mat);
  }
  for (const t of world.trees) {
    if (!seen(t, world.treeDistance)) continue;
    for (const [mesh, color, mat] of t.parts) draw(mesh, identity(), color, mat); // open cones: no culling
  }
  gl.enable(gl.CULL_FACE);
  for (const c of cells) {
    for (const [mesh, color, mat] of c.buildings) draw(mesh, identity(), color, mat);
  }
  if (world.barriers) draw(world.barriers, identity(), [0.7, 0.7, 0.68], 'concrete');

  for (const p of world.signParts) draw(meshes.cube, p.model, p.color, p.mat);
  gl.uniform1i(uTextured, 1);
  gl.bindTexture(gl.TEXTURE_2D, world.signs.texture);
  draw(world.signs.faces, identity(), [1, 1, 1]);
  gl.uniform1i(uTextured, 0);
  if (world.traffic) {
    const ss = world.streetSigns;
    city.traffic(world.traffic, ROAD_LIFT, eyePos, now / 1000);
    city.police(world.police, ROAD_LIFT, eyePos, now / 1000);
    city.people(world.people.people, ROAD_LIFT * 0.6, eyePos);
    city.heli(world.police.heli, eyePos, now / 1000);
    gl.disable(gl.CULL_FACE);
    const lit = cells.filter((c) => c.furniture);
    for (const { furniture: f } of lit) {
      draw(f.poles, identity(), [0.2, 0.22, 0.2], 'metal');
      draw(f.backs, identity(), [0.6, 0.62, 0.64], 'metal');
      draw(f.lamps, identity(), [1, 1, 1], 'signal');
    }
    gl.uniform1i(uTextured, 1);
    gl.bindTexture(gl.TEXTURE_2D, ss.texture);
    for (const { furniture: f } of lit) draw(f.faces, identity(), [1, 1, 1]);
    gl.uniform1i(uTextured, 0);
    gl.enable(gl.CULL_FACE);
  }
  drawCar(shown, damagedColors(), 1, lean, !cockpit);
  if (cockpit) drawCockpit();
  drawGhost(clock);
  drawPuffs();
  precipitation.draw(viewProj, eyePos, now / 1000, climate, canvas.height / 2 / Math.tan(camFov / 2));

  speedEl.textContent = Math.abs(car.speed * 3.6).toFixed(0).padStart(3, ' ');
  speedEl.classList.toggle('grass', !where.onTrack && surface !== 'road');
  gearEl.textContent = car.reverse ? 'R' : Math.abs(car.speed) < 0.3 ? 'N' : 'D';
  lapEl.textContent = fmt(lap.done ? lap.last : lap.start === null ? null : clock - lap.start);
  bestEl.textContent = fmt(lap.best[car.variant]);
  botEl.textContent = fmt(BOT_LAPS[layout]?.[car.variant]?.time ?? null);
  balanceEl.textContent = car.balance === 'over' ? 'Oversteer' : car.balance === 'under' ? 'Understeer' : '';
  balanceEl.className = car.balance ?? '';
  // Weight on each axle as a share of the car's weight: grade and braking move
  // it between the axles, crests and dips change the total.
  const weight = car.mass * 9.81;
  const front = Math.round((car.loadFront / weight) * 100), rear = Math.round((car.loadRear / weight) * 100);
  loadEl.textContent = `${front} / ${rear}`;
  loadEl.classList.toggle('light', front + rear < 85);
  updateGMeter();
  updateTires();
  updateLawHud(cockpit);
  if (track.open) {
    // The street the car is on (or beside).
    const name = after.name || ' ';
    if (sectionEl.textContent !== name) sectionEl.textContent = name;
    updateCrossStreet(dt);
    minimap.draw(car, world.traffic?.cars, world.police?.cars, now / 1000, world.police?.heli);
  } else if (track.sections) {
    // Name of the corner or stretch the car is in (the last one started).
    const s = track.sections;
    let k = s.length - 1;
    while (k > 0 && s[k][0] > after.along) k--;
    if (sectionEl.textContent !== s[k][1]) sectionEl.textContent = s[k][1];
  }
  // The hour, the date and the weather in Montreal.
  const time = climate.time, cond = `${climate.date} · ${climate.conditions}`;
  if (clockEl.textContent !== time) clockEl.textContent = time;
  if (weatherEl.textContent !== cond) weatherEl.textContent = cond;
  const grade = Math.round(car.grade * 100);
  gradeEl.textContent = `${grade > 0 ? '+' : grade < 0 ? '−' : ''}${Math.abs(grade)}%`;

  depthTarget?.end();
  requestAnimationFrame(frame);
}
// Claude's laps (scripts/autodrive.mjs), for its ghost: fetched when a circuit
// is first picked (see setLayout), not packed in the page.
let BOT_LAPS = {}, botLapsLoading = null;
// For poking at the game from the browser's console: open the page with ?debug.
if (location.search.includes('debug')) window.game = { get world() { return world; }, car, climate };
// Start once the open map's streets are in, and on it the buildings and
// trees around the start (the rest comes as the car drives).
loadOpenMap(customStart?.x, customStart?.z, 800 + 150).then(async () => {
  setLayout(layout);
  if (track.prefetch) { const [x, z] = startPose(); await track.prefetch(x, z, world.drawDistance + 150); }
  resetRace();
  last = performance.now();
  requestAnimationFrame(frame);
});
