import { createProgram, createMesh, deleteMesh } from './gl.js';
import { cube, torus, cylinder } from './geometry.js';
import { gt3Body } from './bodies.js';
import { perspective, lookAt, multiply, identity, basis, rotate } from './math.js';
import { terrainHeight, terrainNormal, terrainSample, terrainMesh, ringTerrainChunks, setTerrain } from './terrain.js';
import { readControls, resetWheel, wheelAngle } from './input.js';
import { Car, VARIANTS, TIRE_TEMP, tempGrip, variantSpec, wheelLayout } from './car.js';
import { Skids } from './skids.js';
import { Ghost } from './ghost.js';
import { BOT_LAPS } from './bot-lap.js';
import { buildTrack, LAYOUTS, ROAD_LIFT } from './track.js';
import { Signs } from './signs.js';
import { onPaddock, buildPaddock } from './paddock.js';
import { buildTrees } from './trees.js';
import { buildGates } from './gates.js';
import { Sky, HORIZON, ZENITH, SUN_DIR } from './sky.js';
import { SCENE_VS, SCENE_FS, MAT } from './shading.js';

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
const lapLabelEl = document.getElementById('lap-label');
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
const G_SCALE = 28; // px per g on the G-meter (grid rings at 0.5 g and 1 g)
const gTrail = [];
const gl = canvas.getContext('webgl2', { antialias: true });
if (!gl) {
  document.getElementById('hud').textContent = 'WebGL2 is not available in this browser.';
  throw new Error('WebGL2 not supported');
}

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
const SUN = (() => { const l = Math.hypot(...SUN_DIR); return SUN_DIR.map((v) => v / l); })();
const sky = new Sky(gl);

// Everything that depends on the layout ('circuit', 'stage', 'montreal' or 'ring', the
// Nordschleife): the
// ground, the road, signs, trees and buildings. Rebuilt when the layout changes.
// M / the Track button cycles through them in this order.
const LAYOUT_ORDER = ['circuit', 'stage', 'montreal', 'ring'];
const LAYOUT_NAMES = { circuit: 'Circuit', stage: 'Stage', montreal: 'Montréal', ring: 'Nordschleife' };
let layout = 'circuit';
try { const v = localStorage.getItem('layout'); if (LAYOUT_ORDER.includes(v)) layout = v; } catch {}
// Scenery further than this (m) isn't drawn: past the far plane, or lost in the haze.
const DRAW_DISTANCE = 1100;
let world = null, track = null;

function buildWorld(kind) {
  if (world) {
    for (const m of world.gpu) deleteMesh(gl, m);
    gl.deleteTexture(world.signs.texture);
  }
  setTerrain(kind);
  const circuit = kind === 'circuit', stage = kind === 'stage', ring = kind === 'ring';
  const paddockAt = circuit ? onPaddock : () => false;
  const t = buildTrack(LAYOUTS[kind], (x, z) => paddockAt(x, z, 4));
  const paddock = circuit ? buildPaddock() : { apron: null, boxes: [], cars: [] };
  const gpu = [];
  const upload = (m) => { const mesh = createMesh(gl, program, m); gpu.push(mesh); return mesh; };
  const signs = new Signs(gl, program, t.signs);
  gpu.push(signs.faces);
  // Trees: off the road and the sand, away from the signs and the paddock.
  const trees = buildTrees((x, z) => {
    const at = t.locate(x, z);
    if (at.distance < Math.max(t.halfWidth + (stage ? t.edgeWidth + 4 : 8), at.sandEdge + 4)) return false;
    if (paddockAt(x, z, 10)) return false;
    return t.signs.every((s) => Math.hypot(s.x - x, s.z - z) > 6);
  }, terrainHeight, circuit ? null : { points: t.points, tangents: t.tangents },
  ring ? { count: 6000, tries: 70000, chunk: 500 } : {});
  const boxes = [
    ...paddock.boxes.map(({ c, s, color, mat }) => ({ color, mat, model: basis(c, [1, 0, 0], [0, 1, 0], [0, 0, 1], ...s) })),
    ...(stage ? buildGates(t) : []).map(({ c, axes, s, color, mat }) => ({ color, mat, model: basis(c, ...axes, ...s) })),
  ];
  return {
    kind,
    track: t,
    onPaddock: paddockAt,
    // The stage covers more ground: a wider hill mesh, in slightly bigger cells.
    // Montreal is ~2 km long but flat, so a few big cells do.
    // The Nordschleife's ~60 km² come in chunks, drawn only when near.
    ground: ring
      ? ringTerrainChunks(20).map((c) => ({ mesh: upload(c), x: c.x, z: c.z, radius: c.radius }))
      : [{ mesh: upload(circuit ? terrainMesh(600, 8) : stage ? terrainMesh(800, 11) : terrainMesh(1600, 100)), x: 0, z: 0, radius: Infinity }],
    apron: paddock.apron && upload(paddock.apron),
    layers: t.layers.map((l) => ({ ...l, mesh: upload(l.mesh) })),
    signs,
    signParts: signs.parts().map(({ part, m }) => ({
      color: part === 'post' ? [0.55, 0.57, 0.6] : [0.3, 0.32, 0.35], mat: part === 'post' ? 'metal' : 'matte', model: basis(...m),
    })),
    boxes,
    cars: paddock.cars,
    trees: trees.pieces.map((p) => ({
      x: p.x, z: p.z, radius: p.radius,
      parts: [
        [upload(p.trunks), [0.36, 0.25, 0.16], 'bark'],
        [upload(p.pines), [0.13, 0.33, 0.18], 'leaves'],
        [upload(p.leaves), [0.22, 0.45, 0.17], 'leaves'],
        [upload(p.leavesLight), [0.36, 0.55, 0.2], 'leaves'],
      ],
    })),
    gpu,
  };
}

const meshes = {
  cube: createMesh(gl, program, cube()),
  wheelRim: createMesh(gl, program, torus(0.17, 0.018)),
  wheel: createMesh(gl, program, cylinder()),
};
// Per-variant drawing data: physics spec, wheel layout and (for modeled cars) body meshes.
const MODELS = {};
for (const name of Object.keys(VARIANTS)) {
  const spec = variantSpec(name);
  const m = { spec, wheels: wheelLayout(spec) };
  if (spec.body === 'gt3') {
    const b = gt3Body(spec);
    Object.assign(m, b, {
      skin: createMesh(gl, program, b.skin), tub: createMesh(gl, program, b.tub),
      glass: createMesh(gl, program, b.glass), roofPanel: createMesh(gl, program, b.roofPanel),
    });
  }
  MODELS[name] = m;
}
const model = (variant) => MODELS[variant] ?? MODELS.rwd;

// Grid starts a few meters before the line, facing along the track.
function startPose() {
  const { x, z, tangent: [tx, tz] } = track.grid;
  return [x, z, Math.atan2(-tx, -tz)];
}

let savedDrive = 'rwd';
try { savedDrive = localStorage.getItem('drive') in VARIANTS ? localStorage.getItem('drive') : 'rwd'; } catch {}
const car = new Car(savedDrive);
const skids = new Skids(gl, program);
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
const tilt = { pitch: 0, roll: 0 }; // body lean from weight transfer (visual only)
// Bounce over sausage kerbs: the body springs up, pitches and rolls with the
// wheels it rides on (visual only), and the wheels lift onto the humps.
const kerb = { lift: 0, vlift: 0, pitch: 0, vpitch: 0, roll: 0, vroll: 0, wheels: [0, 0, 0, 0] };
let lean = { pitch: 0, roll: 0, lift: 0, wheels: kerb.wheels }; // tilt + kerb, used to draw the car
// Laps: the track is split into 4 sectors; a lap counts only after visiting all of them.
// On the stage the clock starts at the start line and stops at the finish, once
// the three middle quarters were driven. Best times are kept per layout and
// drivetrain so FWD and RWD can be compared.
const lap = { start: null, last: null, done: false, best: {}, sector: 3, visited: new Set(), along: 0 };

function setLayout(kind) {
  layout = kind;
  try { localStorage.setItem('layout', kind); } catch {}
  world = buildWorld(kind);
  track = world.track;
  ghost = new Ghost(kind);
  lap.best = Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, ghost.best(v)]));
  lap.last = null;
  const b = layoutBtn?.querySelector('b'); if (b) b.textContent = LAYOUT_NAMES[kind];
  if (lapLabelEl) lapLabelEl.textContent = kind === 'stage' ? 'Stage' : 'Lap';
  if (sectionRowEl) sectionRowEl.hidden = !track.sections;
}
setLayout(layout);

function switchDrive() {
  const names = Object.keys(VARIANTS);
  car.setVariant(names[(names.indexOf(car.variant) + 1) % names.length]);
  try { localStorage.setItem('drive', car.variant); } catch {}
  resetRace();
}

function resetRace() {
  car.reset(...startPose());
  resetWheel();
  cam.x = car.x + Math.sin(car.heading) * 9;
  cam.z = car.z + Math.cos(car.heading) * 9;
  cam.y = terrainHeight(car.x, car.z) + 3.5;
  tilt.pitch = tilt.roll = glance = 0;
  Object.assign(kerb, { lift: 0, vlift: 0, pitch: 0, vpitch: 0, roll: 0, vroll: 0, wheels: [0, 0, 0, 0] });
  lap.start = null;
  lap.done = false;
  lap.sector = 3;
  lap.along = track.locate(car.x, car.z).along;
  lap.visited.clear();
  ghost.stop();
  skids.clear();
  driveEl.querySelector('b').textContent = VARIANTS[car.variant].label;
}
resetRace();

function switchLayout() {
  setLayout(LAYOUT_ORDER[(LAYOUT_ORDER.indexOf(layout) + 1) % LAYOUT_ORDER.length]);
  resetRace();
}

// Stage clock. Only small steps along the road count as crossing a line, so the
// nearest-road lookup jumping to another part of the stage doesn't.
function updateStage(at, now) {
  const prev = lap.along;
  lap.along = at.along;
  if (lap.done || Math.abs(at.along - prev) > 20) return;
  const s = track.start.along, f = track.finish.along;
  if (lap.start === null) {
    if (prev < s && at.along >= s) { lap.start = now; ghost.start(); lap.visited.clear(); }
    return;
  }
  const quarter = Math.floor(((at.along - s) / (f - s)) * 4);
  if (quarter >= 1 && quarter <= 3) lap.visited.add(quarter);
  if (prev < f && at.along >= f && lap.visited.size === 3) {
    lap.last = now - lap.start;
    lap.done = true;
    const v = car.variant;
    if (lap.best[v] === null || lap.last < lap.best[v]) {
      lap.best[v] = lap.last;
      ghost.save(v, lap.last, car);
    }
  }
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

function drawCar(pose = car, colors = CAR_COLORS, alpha = 1, lean = { pitch: 0, roll: 0 }, cabin = true, m = model(car.variant)) {
  const F = carFrame(pose);
  const body = bodyFrame(F, lean);
  const { right, up, back } = body;
  const v = m.spec;
  if (m.skin) {
    const B = basis(body.o, right, up, back);
    draw(m.skin, B, colors.body, 'paint', alpha);
    draw(m.tub, B, colors.trim ?? TRIM, 'matte', alpha);
    if (cabin) {
      draw(m.glass, B, colors.cabin, 'glass', alpha);
      draw(m.roofPanel, B, colors.body, 'paint', alpha);
    }
    for (const p of m.parts) {
      if (!cabin && p.y > 0.98) continue; // wing and mirrors would clutter the cockpit view
      const c = p.color === 'body' ? colors.body : p.color === 'light' ? colors.light ?? [0.85, 0.88, 0.9]
        : p.color === 'tail' ? colors.tail ?? [0.75, 0.05, 0.05] : colors.trim ?? TRIM;
      draw(meshes.cube, basis(toWorld(body, p.x, p.y, p.z), right, up, back, p.sx, p.sy, p.sz), c, p.mat, alpha);
    }
  } else {
    // Plain box car, centered between the bumpers.
    const mid = v.length / 2 - v.overhangFront - v.cgToFront;
    draw(meshes.cube, basis(toWorld(body, 0, 0.6, mid), right, up, back, v.width, 0.6, v.length), colors.body, 'paint', alpha);
    if (cabin) draw(meshes.cube, basis(toWorld(body, 0, 1.15, mid + 0.3), right, up, back, v.width - 0.3, 0.5, 2.0), colors.cabin, 'glass', alpha);
  }
  // Wheels stay on the road frame and glow orange when past the grip peak.
  m.wheels.forEach(([side, ahead, front, radius, width], i) => {
    const sliding = front ? pose.frontSliding : pose.rearSliding;
    const a = front ? pose.steer : 0;
    const r = rotate(F.right, F.up, a), b = rotate(F.back, F.up, a);
    const color = sliding ? [0.95, 0.55, 0.1] : colors.wheel;
    const y = radius + (lean.wheels?.[i] ?? 0);
    const at = toWorld(F, side, y, -ahead);
    if (m.skin) {
      draw(meshes.wheel, basis(at, r, F.up, b, width, 2 * radius, 2 * radius), color, 'rubber', alpha);
      // Centre-lock rim face, on the outside of the tire.
      const rim = [0, 1, 2].map((k) => at[k] + r[k] * Math.sign(side) * (width / 2 + 0.003));
      draw(meshes.wheel, basis(rim, r, F.up, b, 0.01, 1.4 * radius, 1.4 * radius), colors.rim ?? [0.12, 0.12, 0.13], 'metal', alpha);
    } else {
      draw(meshes.cube, basis(at, r, F.up, b, width, 2 * radius, 2 * radius), color, 'rubber', alpha);
    }
  });
}

// Driver's seat, left-hand drive, in the body frame (x right, y up, z back).
const EYE = [-0.35, 1.22, 0.15];
const eyeOf = (variant) => model(variant).cockpit?.eye ?? EYE;
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
  const B = bodyFrame(carFrame(car), lean);
  const box = (x, y, z, sx, sy, sz, c) => draw(meshes.cube, basis(toWorld(B, x, y, z), B.right, B.up, B.back, sx, sy, sz), c);
  const ck = model(car.variant).cockpit;
  const eye = eyeOf(car.variant);
  if (ck) {
    // Modeled car: low dash under the screen, A-pillars along the glass, roof header.
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
  } else {
    box(0, 0.905, -0.2, 1.56, 0.05, 1.3, TRIM);          // floor, hides the body's top
    box(0, 0.9, -0.8, 1.56, 0.16, 0.5, INTERIOR);        // dashboard
    box(0, 0.985, -0.92, 1.56, 0.01, 0.24, DASH_TOP);    // top of the dash, toward the glass
    box(EYE[0], 1.0, -0.64, 0.34, 0.05, 0.12, INTERIOR); // instrument hood
    for (const s of [-1, 1]) {
      drawBeam(B, [s * 0.8, 0.98, -1.15], [s * 0.7, 1.45, -0.25], 0.045, 0.06, TRIM); // A-pillar
      box(s * 0.8, 0.98, 0.1, 0.06, 0.16, 1.2, INTERIOR);                            // door top
    }
    box(0, 1.46, -0.22, 1.5, 0.04, 0.1, TRIM);         // roof edge
    draw(meshes.cube, basis(toWorld(B, 0, 1.39, -0.5), B.right, B.up, B.back, 0.2, 0.05, 0.02), [0.35, 0.38, 0.42], 'metal'); // rear-view mirror
    drawBeam(B, [0, 1.46, -0.3], [0, 1.4, -0.5], 0.02, 0.02, TRIM); // its stem
  }
  // Steering wheel, tilted toward the driver and turned with the input.
  const c = ck ? toWorld(B, eye[0], eye[1] - 0.25, eye[2] - 0.55) : toWorld(B, eye[0], eye[1] - 0.34, eye[2] - 0.45);
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
    const d = Math.hypot(pose.x - car.x, pose.z - car.z);
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

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const controls = readControls(dt);
  if (controls.toggleGhost) toggleGhost();
  if (controls.toggleView) toggleView();
  if (controls.switchLayout) switchLayout();
  else if (controls.switchDrive) switchDrive();
  else if (controls.reset) resetRace();
  const where = track.locate(car.x, car.z);
  const surface = where.surface ?? (world.onPaddock(car.x, car.z) ? 'road' : where.sand ? 'sand' : 'grass');
  updateKerbs(dt);
  car.update(dt, controls, surface, terrainSample(car.x, car.z));
  const after = track.locate(car.x, car.z);
  if (track.closed) updateLap(after.index, now);
  else updateStage(after, now);
  if (lap.start !== null && !lap.done) ghost.record(now - lap.start, car);
  wheelPositions().forEach((w, i) => skids.track(i, w.x, w.y, w.z, w.sliding));

  // Body lean follows the accelerations, smoothed like a damped spring.
  const kt = Math.min(1, dt * 6);
  tilt.pitch += (car.accel * car.pitchGain - tilt.pitch) * kt;
  tilt.roll += (-car.vx * car.yawRate * car.rollGain - tilt.roll) * kt;
  lean = { pitch: tilt.pitch + kerb.pitch, roll: tilt.roll + kerb.roll, lift: kerb.lift, wheels: kerb.wheels };
  const carY = terrainHeight(car.x, car.z);

  // Chase camera: lag behind the car, smoothed.
  const back = 9, height = 3.5;
  const tx = car.x + Math.sin(car.heading) * back;
  const tz = car.z + Math.cos(car.heading) * back;
  const k = Math.min(1, dt * 4);
  cam.x += (tx - cam.x) * k;
  cam.z += (tz - cam.z) * k;
  cam.y += (carY + height - cam.y) * k;
  cam.y = Math.max(cam.y, terrainHeight(cam.x, cam.z) + 1.2); // never inside a hill

  resize();
  gl.clearColor(...HORIZON, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const aspect = canvas.width / canvas.height;
  // Keep a usable horizontal view on tall (portrait phone) screens.
  const fovy = aspect < 1 ? 2 * Math.atan(Math.tan(Math.PI / 6) * 0.8 / aspect) : Math.PI / 3;
  const cockpit = view === 'cockpit';
  let viewMat, eyePos;
  if (cockpit) {
    // Eye rides the leaning body; it looks a touch down and glances into turns.
    glance += (Math.max(-0.25, Math.min(0.25, car.yawRate * 0.12)) - glance) * Math.min(1, dt * 3);
    const B = bodyFrame(carFrame(car), lean);
    const eye = toWorld(B, ...eyeOf(car.variant));
    const dir = rotate(rotate(B.back.map((v) => -v), B.right, -0.08), B.up, glance);
    viewMat = lookAt(eye, [0, 1, 2].map((i) => eye[i] + dir[i]), B.up);
    eyePos = eye;
  } else {
    eyePos = [cam.x, cam.y, cam.z];
    viewMat = lookAt(eyePos, [car.x, carY + 1, car.z], [0, 1, 0]);
  }
  const proj = perspective(cockpit ? fovy * 1.1 : fovy, aspect, cockpit ? 0.05 : 0.1, 1000);
  const viewProj = multiply(proj, viewMat);
  sky.draw(viewProj, eyePos, now / 1000);
  gl.useProgram(program);
  gl.uniformMatrix4fv(uViewProj, false, viewProj);
  gl.uniform3fv(uCam, eyePos);
  gl.uniform3fv(uFog, HORIZON);
  gl.uniform3fv(uZenith, ZENITH);
  gl.uniform3fv(uSun, SUN);

  // Road layers sit a few cm above the ground; polygon offset keeps them from
  // z-fighting with it (and the start line and skids with the road) far away.
  gl.disable(gl.CULL_FACE);
  const seen = (c) => Math.hypot(c.x - eyePos[0], c.z - eyePos[2]) - c.radius < DRAW_DISTANCE;
  for (const g of world.ground) if (seen(g)) draw(g.mesh, identity(), [0.3, 0.55, 0.3], 'grass');
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(-1, -2);
  if (world.apron) draw(world.apron, identity(), [0.4, 0.41, 0.43], 'asphalt');
  for (const l of world.layers) if (!l.top) draw(l.mesh, identity(), l.color, l.mat);
  gl.polygonOffset(-2, -4);
  for (const l of world.layers) if (l.top) draw(l.mesh, identity(), l.color, l.mat);
  if (skids.used) draw(skids.mesh, identity(), [0.12, 0.12, 0.13], 'rubber');
  gl.disable(gl.POLYGON_OFFSET_FILL);
  for (const t of world.trees) {
    if (!seen(t)) continue;
    for (const [mesh, color, mat] of t.parts) draw(mesh, identity(), color, mat); // open cones: no culling
  }
  gl.enable(gl.CULL_FACE);

  for (const p of world.signParts) draw(meshes.cube, p.model, p.color, p.mat);
  gl.uniform1i(uTextured, 1);
  gl.bindTexture(gl.TEXTURE_2D, world.signs.texture);
  draw(world.signs.faces, identity(), [1, 1, 1]);
  gl.uniform1i(uTextured, 0);
  for (const b of world.boxes) draw(meshes.cube, b.model, b.color, b.mat);
  for (const p of world.cars) drawCar(p, p.colors, 1, { pitch: 0, roll: 0 }, true, model(p.variant));
  drawCar(car, CAR_COLORS, 1, lean, !cockpit);
  if (cockpit) drawCockpit();
  drawGhost(now);

  speedEl.textContent = Math.abs(car.speed * 3.6).toFixed(0).padStart(3, ' ');
  speedEl.classList.toggle('grass', !where.onTrack && surface !== 'road');
  gearEl.textContent = car.speed < -0.3 ? 'R' : Math.abs(car.speed) < 0.3 ? 'N' : 'D';
  lapEl.textContent = fmt(lap.done ? lap.last : lap.start === null ? null : now - lap.start);
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
  if (track.sections) {
    // Name of the corner or stretch the car is in (the last one started).
    const s = track.sections;
    let k = s.length - 1;
    while (k > 0 && s[k][0] > after.along) k--;
    if (sectionEl.textContent !== s[k][1]) sectionEl.textContent = s[k][1];
  }
  const grade = Math.round(car.grade * 100);
  gradeEl.textContent = `${grade > 0 ? '+' : grade < 0 ? '−' : ''}${Math.abs(grade)}%`;

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
