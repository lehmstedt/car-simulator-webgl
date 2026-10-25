import { createProgram, createMesh } from './gl.js';
import { cube, torus } from './geometry.js';
import { perspective, lookAt, multiply, identity, basis, rotate } from './math.js';
import { terrainHeight, terrainNormal, terrainSample, terrainMesh } from './terrain.js';
import { readControls, resetWheel, wheelAngle } from './input.js';
import { Car, VARIANTS } from './car.js';
import { Skids } from './skids.js';
import { Ghost } from './ghost.js';
import { buildTrack, ROAD_HALF_WIDTH, ROAD_LIFT } from './track.js';
import { Signs } from './signs.js';

const VS = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
in vec2 aUV;
uniform mat4 uModel;
uniform mat4 uViewProj;
out vec3 vNormal;
out vec3 vWorld;
out vec2 vUV;
void main() {
  vUV = aUV;
  vec4 world = uModel * vec4(aPosition, 1.0);
  vNormal = mat3(uModel) * aNormal;
  vWorld = world.xyz;
  gl_Position = uViewProj * world;
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec3 vWorld;
in vec2 vUV;
uniform vec3 uColor;
uniform sampler2D uTex;
uniform bool uTextured; // color comes from uTex (sign faces), lit more evenly
uniform float uGrid; // grid cell size in meters, 0 = off
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec3 L = normalize(vec3(0.4, 1.0, 0.3));
  float d = max(dot(normalize(vNormal), L), 0.0);
  vec3 c = uTextured ? texture(uTex, vUV).rgb * (0.6 + 0.4 * d) : uColor * (0.35 + 0.65 * d);
  if (uGrid > 0.0) {
    // Anti-aliased grid lines on the XZ plane.
    vec2 g = vWorld.xz / uGrid;
    vec2 w = fwidth(g);
    vec2 a = abs(fract(g - 0.5) - 0.5) / w;
    float line = 1.0 - min(min(a.x, a.y), 1.0);
    c = mix(c, c * 0.85, line);
  }
  outColor = vec4(c, uAlpha);
}`;

const canvas = document.getElementById('gl');
const speedEl = document.getElementById('speed');
const gearEl = document.getElementById('gear');
const lapEl = document.getElementById('lap');
const bestEl = document.getElementById('best');
const driveEl = document.getElementById('drive');
const balanceEl = document.getElementById('balance');
const ghostBtn = document.getElementById('ghost');
const viewBtn = document.getElementById('view');
const loadEl = document.getElementById('load');
const gradeEl = document.getElementById('grade');
const gl = canvas.getContext('webgl2', { antialias: true });
if (!gl) {
  document.getElementById('hud').textContent = 'WebGL2 is not available in this browser.';
  throw new Error('WebGL2 not supported');
}

const program = createProgram(gl, VS, FS);
const uModel = gl.getUniformLocation(program, 'uModel');
const uViewProj = gl.getUniformLocation(program, 'uViewProj');
const uColor = gl.getUniformLocation(program, 'uColor');
const uGrid = gl.getUniformLocation(program, 'uGrid');
const uAlpha = gl.getUniformLocation(program, 'uAlpha');
const uTextured = gl.getUniformLocation(program, 'uTextured');

const track = buildTrack();
const meshes = {
  cube: createMesh(gl, program, cube()),
  wheelRim: createMesh(gl, program, torus(0.17, 0.018)),
  ground: createMesh(gl, program, terrainMesh(600, 8)),
  road: createMesh(gl, program, track.meshes.road),
  curbRed: createMesh(gl, program, track.meshes.curbRed),
  curbWhite: createMesh(gl, program, track.meshes.curbWhite),
  startLine: createMesh(gl, program, track.meshes.startLine),
};
const signs = new Signs(gl, program, track.signs);
const signParts = signs.parts().map(({ part, m }) => ({ color: part === 'post' ? [0.55, 0.57, 0.6] : [0.3, 0.32, 0.35], model: basis(...m) }));

// Scenery blocks scattered around, kept well clear of the road.
const props = [];
for (let i = 0; props.length < 50 && i < 400; i++) {
  const ang = i * 2.399; // golden-angle spiral
  const r = 30 + i * 2.2;
  const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
  // Sunk a little so they don't float on slopes.
  if (track.locate(x, z).distance > ROAD_HALF_WIDTH + 14) props.push({ x, z, s: 2 + (i % 4), y: terrainHeight(x, z) - 0.6 });
}

// Grid starts a few meters before the line, facing along the track.
function startPose() {
  const n = track.points.length, i = n - 4;
  const [x, z] = track.points[i], [tx, tz] = track.tangents[i];
  return [x, z, Math.atan2(-tx, -tz)];
}

let savedDrive = 'rwd';
try { savedDrive = localStorage.getItem('drive') in VARIANTS ? localStorage.getItem('drive') : 'rwd'; } catch {}
const car = new Car(savedDrive);
const skids = new Skids(gl, program);
const ghost = new Ghost();
let showGhost = true;
try { showGhost = localStorage.getItem('showGhost') !== 'off'; } catch {}
const updateGhostBtn = () => ghostBtn?.setAttribute('aria-pressed', String(showGhost));
updateGhostBtn();
function toggleGhost() {
  showGhost = !showGhost;
  try { localStorage.setItem('showGhost', showGhost ? 'on' : 'off'); } catch {}
  updateGhostBtn();
}
const cam = { x: 0, y: 4, z: 0 };
// Camera: 'chase' (behind the car) or 'cockpit' (driver's seat).
let view = 'chase';
try { view = localStorage.getItem('view') === 'cockpit' ? 'cockpit' : 'chase'; } catch {}
const updateViewBtn = () => { if (viewBtn) viewBtn.textContent = view === 'cockpit' ? 'Cockpit' : 'Chase'; };
updateViewBtn();
function toggleView() {
  view = view === 'cockpit' ? 'chase' : 'cockpit';
  try { localStorage.setItem('view', view); } catch {}
  updateViewBtn();
}
let glance = 0; // cockpit head turn into corners (rad), smoothed
const tilt = { pitch: 0, roll: 0 }; // body lean from weight transfer (visual only)
// Laps: the track is split into 4 sectors; a lap counts only after visiting all of them.
// Best laps are kept per drivetrain so FWD and RWD can be compared.
const lap = { start: null, last: null, best: { fwd: ghost.best('fwd'), rwd: ghost.best('rwd') }, sector: 3, visited: new Set() };

function switchDrive() {
  car.setVariant(car.variant === 'fwd' ? 'rwd' : 'fwd');
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
  lap.start = null;
  lap.sector = 3;
  lap.visited.clear();
  ghost.stop();
  skids.clear();
  driveEl.textContent = VARIANTS[car.variant].label;
}
resetRace();

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

function draw(mesh, model, color, gridSize = 0, alpha = 1) {
  gl.uniformMatrix4fv(uModel, false, model);
  gl.uniform3fv(uColor, color);
  gl.uniform1f(uGrid, gridSize);
  gl.uniform1f(uAlpha, alpha);
  gl.bindVertexArray(mesh.vao);
  if (mesh.indexed) gl.drawElements(mesh.mode, mesh.count, gl.UNSIGNED_INT, 0);
  else gl.drawArrays(mesh.mode, 0, mesh.count);
}

const WHEELS = [[-1, 1.3, true], [1, 1.3, true], [-1, -1.3, false], [1, -1.3, false]];

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

function wheelPositions(pose = car) {
  const F = carFrame(pose);
  return WHEELS.map(([side, fwd, front]) => {
    const [x, , z] = toWorld(F, side * 0.95, 0, -fwd);
    return { x, z, y: terrainHeight(x, z) + ROAD_LIFT + 0.03, front, sliding: front ? pose.frontSliding : pose.rearSliding };
  });
}

const CAR_COLORS = { body: [0.85, 0.15, 0.15], cabin: [0.2, 0.2, 0.25], wheel: [0.08, 0.08, 0.08] };
const GHOST_COLORS = { body: [0.75, 0.9, 1], cabin: [0.55, 0.7, 0.85], wheel: [0.45, 0.55, 0.65] };

// The body leans on its springs: nose dives under braking, squats under
// throttle, rolls toward the outside of a turn.
function bodyFrame(F, lean) {
  let { right, up, back } = F;
  up = rotate(up, right, lean.pitch); back = rotate(back, right, lean.pitch);
  up = rotate(up, back, lean.roll); right = rotate(right, back, lean.roll);
  return { o: F.o, right, up, back };
}

function drawCar(pose = car, colors = CAR_COLORS, alpha = 1, lean = tilt, cabin = true) {
  const F = carFrame(pose);
  const body = bodyFrame(F, lean);
  const { right, up, back } = body;
  draw(meshes.cube, basis(toWorld(body, 0, 0.6, 0), right, up, back, 1.8, 0.6, 4.2), colors.body, 0, alpha);
  if (cabin) draw(meshes.cube, basis(toWorld(body, 0, 1.15, 0.3), right, up, back, 1.5, 0.5, 2.0), colors.cabin, 0, alpha);
  // Wheels stay on the road frame and glow orange when past the grip peak.
  for (const [side, fwd, front] of WHEELS) {
    const sliding = front ? pose.frontSliding : pose.rearSliding;
    const a = front ? pose.steer : 0;
    const r = rotate(F.right, F.up, a), b = rotate(F.back, F.up, a);
    const color = sliding ? [0.95, 0.55, 0.1] : colors.wheel;
    draw(meshes.cube, basis(toWorld(F, side * 0.95, 0.35, -fwd), r, F.up, b, 0.3, 0.7, 0.7), color, 0, alpha);
  }
}

// Driver's seat, left-hand drive, in the body frame (x right, y up, z back).
const EYE = [-0.35, 1.22, 0.15];
const INTERIOR = [0.13, 0.13, 0.15], DASH_TOP = [0.2, 0.2, 0.23], TRIM = [0.06, 0.06, 0.07];

// A box stretched between two body-frame points, w wide and h thick.
function drawBeam(B, a, b, w, h, color) {
  const pa = toWorld(B, ...a), pb = toWorld(B, ...b);
  let ax = [0, 1, 2].map((i) => pb[i] - pa[i]);
  const len = Math.hypot(...ax);
  ax = ax.map((v) => v / len);
  let r = [ax[1] * B.up[2] - ax[2] * B.up[1], ax[2] * B.up[0] - ax[0] * B.up[2], ax[0] * B.up[1] - ax[1] * B.up[0]];
  const rl = Math.hypot(...r);
  r = r.map((v) => v / rl);
  const u = [r[1] * ax[2] - r[2] * ax[1], r[2] * ax[0] - r[0] * ax[2], r[0] * ax[1] - r[1] * ax[0]];
  const mid = [0, 1, 2].map((i) => (pa[i] + pb[i]) / 2);
  draw(meshes.cube, basis(mid, r, u, ax, w, h, len), color);
}

// Dashboard, pillars, roof edge, mirror and a steering wheel that follows the input.
function drawCockpit() {
  const B = bodyFrame(carFrame(car), tilt);
  const box = (x, y, z, sx, sy, sz, c) => draw(meshes.cube, basis(toWorld(B, x, y, z), B.right, B.up, B.back, sx, sy, sz), c);
  box(0, 0.905, -0.2, 1.56, 0.05, 1.3, TRIM);          // floor, hides the body's top
  box(0, 0.9, -0.8, 1.56, 0.16, 0.5, INTERIOR);        // dashboard
  box(0, 0.985, -0.92, 1.56, 0.01, 0.24, DASH_TOP);    // top of the dash, toward the glass
  box(EYE[0], 1.0, -0.64, 0.34, 0.05, 0.12, INTERIOR); // instrument hood
  for (const s of [-1, 1]) {
    drawBeam(B, [s * 0.8, 0.98, -1.15], [s * 0.7, 1.45, -0.25], 0.045, 0.06, TRIM); // A-pillar
    box(s * 0.8, 0.98, 0.1, 0.06, 0.16, 1.2, INTERIOR);                            // door top
  }
  box(0, 1.46, -0.22, 1.5, 0.04, 0.1, TRIM);         // roof edge
  box(0, 1.39, -0.5, 0.2, 0.05, 0.02, [0.35, 0.38, 0.42]); // rear-view mirror
  drawBeam(B, [0, 1.46, -0.3], [0, 1.4, -0.5], 0.02, 0.02, TRIM); // its stem
  // Steering wheel, tilted toward the driver and turned with the input.
  const c = toWorld(B, EYE[0], 0.88, -0.3);
  let wb = rotate(B.back, B.right, -0.42), wu = rotate(B.up, B.right, -0.42); // wheel axis and up
  const a = wheelAngle();
  const wr = rotate(B.right, wb, a);
  wu = rotate(wu, wb, a);
  draw(meshes.wheelRim, basis(c, wr, wu, wb), TRIM);
  const W = { o: c, right: wr, up: wu, back: wb };
  draw(meshes.cube, basis(c, wr, wu, wb, 0.08, 0.08, 0.05), [0.18, 0.18, 0.2]); // hub
  draw(meshes.cube, basis(toWorld(W, 0, 0.16, 0), wr, wu, wb, 0.03, 0.025, 0.025), [0.95, 0.77, 0.24]); // top marker
  for (const s of [-1, 1]) draw(meshes.cube, basis(toWorld(W, s * 0.1, -0.01, 0), wr, wu, wb, 0.12, 0.03, 0.015), TRIM);
  draw(meshes.cube, basis(toWorld(W, 0, -0.1, 0), wr, wu, wb, 0.03, 0.12, 0.015), TRIM);
}

// The ghost is see-through and never hides anything behind it. Blending keeps
// the canvas alpha at 1 so the page never shows through.
function drawGhost(now) {
  if (!showGhost || lap.start === null) return;
  const pose = ghost.pose(car.variant, now - lap.start);
  if (!pose) return;
  // Fade it out when it overlaps the player's car so the view stays clear.
  const d = Math.hypot(pose.x - car.x, pose.z - car.z);
  const alpha = 0.45 * Math.min(1, Math.max(0.5, d / 8));
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
  gl.depthMask(false);
  drawCar(pose, GHOST_COLORS, alpha, { pitch: 0, roll: 0 });
  gl.depthMask(true);
  gl.disable(gl.BLEND);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const controls = readControls(dt);
  if (controls.toggleGhost) toggleGhost();
  if (controls.toggleView) toggleView();
  if (controls.switchDrive) switchDrive();
  else if (controls.reset) resetRace();
  const where = track.locate(car.x, car.z);
  car.update(dt, controls, !where.onTrack, terrainSample(car.x, car.z));
  updateLap(track.locate(car.x, car.z).index, now);
  if (lap.start !== null) ghost.record(now - lap.start, car);
  wheelPositions().forEach((w, i) => skids.track(i, w.x, w.y, w.z, w.sliding));

  // Body lean follows the accelerations, smoothed like a damped spring.
  const kt = Math.min(1, dt * 6);
  tilt.pitch += (car.accel * 0.006 - tilt.pitch) * kt;
  tilt.roll += (-car.vx * car.yawRate * 0.005 - tilt.roll) * kt;
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
  gl.clearColor(0.55, 0.75, 0.95, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.useProgram(program);

  const aspect = canvas.width / canvas.height;
  // Keep a usable horizontal view on tall (portrait phone) screens.
  const fovy = aspect < 1 ? 2 * Math.atan(Math.tan(Math.PI / 6) * 0.8 / aspect) : Math.PI / 3;
  const cockpit = view === 'cockpit';
  let viewMat;
  if (cockpit) {
    // Eye rides the leaning body; it looks a touch down and glances into turns.
    glance += (Math.max(-0.25, Math.min(0.25, car.yawRate * 0.12)) - glance) * Math.min(1, dt * 3);
    const B = bodyFrame(carFrame(car), tilt);
    const eye = toWorld(B, ...EYE);
    const dir = rotate(rotate(B.back.map((v) => -v), B.right, -0.08), B.up, glance);
    viewMat = lookAt(eye, [0, 1, 2].map((i) => eye[i] + dir[i]), B.up);
  } else {
    viewMat = lookAt([cam.x, cam.y, cam.z], [car.x, carY + 1, car.z], [0, 1, 0]);
  }
  const proj = perspective(cockpit ? fovy * 1.1 : fovy, aspect, cockpit ? 0.05 : 0.1, 1000);
  gl.uniformMatrix4fv(uViewProj, false, multiply(proj, viewMat));

  // Road layers sit a few cm above the ground; polygon offset keeps them from
  // z-fighting with it (and the start line and skids with the road) far away.
  gl.disable(gl.CULL_FACE);
  draw(meshes.ground, identity(), [0.3, 0.55, 0.3], 10);
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(-1, -2);
  draw(meshes.road, identity(), [0.32, 0.33, 0.36]);
  draw(meshes.curbRed, identity(), [0.85, 0.15, 0.12]);
  draw(meshes.curbWhite, identity(), [0.95, 0.95, 0.95]);
  gl.polygonOffset(-2, -4);
  draw(meshes.startLine, identity(), [0.95, 0.95, 0.95]);
  if (skids.used) draw(skids.mesh, identity(), [0.12, 0.12, 0.13]);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.enable(gl.CULL_FACE);

  for (const p of signParts) draw(meshes.cube, p.model, p.color);
  gl.uniform1i(uTextured, 1);
  gl.bindTexture(gl.TEXTURE_2D, signs.texture);
  draw(signs.faces, identity(), [1, 1, 1]);
  gl.uniform1i(uTextured, 0);
  for (const p of props) draw(meshes.cube, basis([p.x, p.y + p.s / 2, p.z], [1, 0, 0], [0, 1, 0], [0, 0, 1], p.s, p.s, p.s), [0.7, 0.65, 0.5]);
  drawCar(car, CAR_COLORS, 1, tilt, !cockpit);
  if (cockpit) drawCockpit();
  drawGhost(now);

  speedEl.textContent = Math.abs(car.speed * 3.6).toFixed(0).padStart(3, ' ');
  speedEl.classList.toggle('grass', !where.onTrack);
  gearEl.textContent = car.speed < -0.3 ? 'R' : Math.abs(car.speed) < 0.3 ? 'N' : 'D';
  lapEl.textContent = fmt(lap.start === null ? null : now - lap.start);
  bestEl.textContent = fmt(lap.best[car.variant]);
  balanceEl.textContent = car.balance === 'over' ? 'Oversteer' : car.balance === 'under' ? 'Understeer' : '';
  balanceEl.className = car.balance ?? '';
  // Weight on each axle as a share of the car's weight: grade and braking move
  // it between the axles, crests and dips change the total.
  const weight = car.mass * 9.81;
  const front = Math.round((car.loadFront / weight) * 100), rear = Math.round((car.loadRear / weight) * 100);
  loadEl.textContent = `${front} / ${rear}`;
  loadEl.classList.toggle('light', front + rear < 85);
  const grade = Math.round(car.grade * 100);
  gradeEl.textContent = `${grade > 0 ? '+' : grade < 0 ? '−' : ''}${Math.abs(grade)}%`;

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
