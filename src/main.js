import { createProgram, createMesh } from './gl.js';
import { cube, plane } from './geometry.js';
import { perspective, lookAt, multiply, trs, identity } from './math.js';
import { readControls, resetWheel } from './input.js';
import { Car, VARIANTS } from './car.js';
import { Skids } from './skids.js';
import { Ghost } from './ghost.js';
import { buildTrack, ROAD_HALF_WIDTH } from './track.js';

const VS = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uModel;
uniform mat4 uViewProj;
out vec3 vNormal;
out vec3 vWorld;
void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vNormal = mat3(uModel) * aNormal;
  vWorld = world.xyz;
  gl_Position = uViewProj * world;
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec3 vWorld;
uniform vec3 uColor;
uniform float uGrid; // grid cell size in meters, 0 = off
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec3 L = normalize(vec3(0.4, 1.0, 0.3));
  float d = max(dot(normalize(vNormal), L), 0.0);
  vec3 c = uColor * (0.35 + 0.65 * d);
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

const track = buildTrack();
const meshes = {
  cube: createMesh(gl, program, cube()),
  ground: createMesh(gl, program, plane(600)),
  road: createMesh(gl, program, track.meshes.road),
  curbRed: createMesh(gl, program, track.meshes.curbRed),
  curbWhite: createMesh(gl, program, track.meshes.curbWhite),
  startLine: createMesh(gl, program, track.meshes.startLine),
};

// Scenery blocks scattered around, kept well clear of the road.
const props = [];
for (let i = 0; props.length < 50 && i < 400; i++) {
  const ang = i * 2.399; // golden-angle spiral
  const r = 30 + i * 2.2;
  const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
  if (track.locate(x, z).distance > ROAD_HALF_WIDTH + 14) props.push({ x, z, s: 2 + (i % 4) });
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
  gl.drawArrays(mesh.mode, 0, mesh.count);
}

const WHEELS = [[-1, 1.3, true], [1, 1.3, true], [-1, -1.3, false], [1, -1.3, false]];

function wheelPositions(pose = car) {
  const { x, z, heading: h } = pose;
  const fx = -Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h);
  return WHEELS.map(([side, fwd, front]) => ({
    x: x + rx * side * 0.95 + fx * fwd,
    z: z + rz * side * 0.95 + fz * fwd,
    front,
    sliding: front ? pose.frontSliding : pose.rearSliding,
  }));
}

const CAR_COLORS = { body: [0.85, 0.15, 0.15], cabin: [0.2, 0.2, 0.25], wheel: [0.08, 0.08, 0.08] };
const GHOST_COLORS = { body: [0.75, 0.9, 1], cabin: [0.55, 0.7, 0.85], wheel: [0.45, 0.55, 0.65] };

function drawCar(pose = car, colors = CAR_COLORS, alpha = 1) {
  const { x, z, heading: h, steer } = pose;
  draw(meshes.cube, trs(x, 0.6, z, h, 1.8, 0.6, 4.2), colors.body, 0, alpha);
  const fx = -Math.sin(h), fz = -Math.cos(h);
  draw(meshes.cube, trs(x - fx * 0.3, 1.15, z - fz * 0.3, h, 1.5, 0.5, 2.0), colors.cabin, 0, alpha);
  // Wheels glow orange when their tires are past the grip peak.
  for (const w of wheelPositions(pose)) {
    const color = w.sliding ? [0.95, 0.55, 0.1] : colors.wheel;
    draw(meshes.cube, trs(w.x, 0.35, w.z, h + (w.front ? steer : 0), 0.3, 0.7, 0.7), color, 0, alpha);
  }
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
  drawCar(pose, GHOST_COLORS, alpha);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const controls = readControls(dt);
  if (controls.toggleGhost) toggleGhost();
  if (controls.switchDrive) switchDrive();
  else if (controls.reset) resetRace();
  const where = track.locate(car.x, car.z);
  car.update(dt, controls, !where.onTrack);
  updateLap(track.locate(car.x, car.z).index, now);
  if (lap.start !== null) ghost.record(now - lap.start, car);
  wheelPositions().forEach((w, i) => skids.track(i, w.x, w.z, w.sliding));

  // Chase camera: lag behind the car, smoothed.
  const back = 9, height = 3.5;
  const tx = car.x + Math.sin(car.heading) * back;
  const tz = car.z + Math.cos(car.heading) * back;
  const k = Math.min(1, dt * 4);
  cam.x += (tx - cam.x) * k;
  cam.z += (tz - cam.z) * k;
  cam.y += (height - cam.y) * k;

  resize();
  gl.clearColor(0.55, 0.75, 0.95, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.useProgram(program);

  const aspect = canvas.width / canvas.height;
  // Keep a usable horizontal view on tall (portrait phone) screens.
  const fovy = aspect < 1 ? 2 * Math.atan(Math.tan(Math.PI / 6) * 0.8 / aspect) : Math.PI / 3;
  const proj = perspective(fovy, aspect, 0.1, 1000);
  const view = lookAt([cam.x, cam.y, cam.z], [car.x, 1, car.z], [0, 1, 0]);
  gl.uniformMatrix4fv(uViewProj, false, multiply(proj, view));

  // Flat ground layers all sit at y = 0: draw them back to front without
  // writing depth, so they never z-fight; everything after sits on top.
  gl.disable(gl.CULL_FACE);
  gl.depthMask(false);
  draw(meshes.ground, identity(), [0.3, 0.55, 0.3], 10);
  draw(meshes.road, identity(), [0.32, 0.33, 0.36]);
  draw(meshes.curbRed, identity(), [0.85, 0.15, 0.12]);
  draw(meshes.curbWhite, identity(), [0.95, 0.95, 0.95]);
  draw(meshes.startLine, identity(), [0.95, 0.95, 0.95]);
  if (skids.used) draw(skids.mesh, identity(), [0.12, 0.12, 0.13]);
  gl.depthMask(true);
  gl.enable(gl.CULL_FACE);

  for (const p of props) draw(meshes.cube, trs(p.x, p.s / 2, p.z, 0, p.s, p.s, p.s), [0.7, 0.65, 0.5]);
  drawCar();
  drawGhost(now);

  speedEl.textContent = Math.abs(car.speed * 3.6).toFixed(0).padStart(3, ' ');
  speedEl.classList.toggle('grass', !where.onTrack);
  gearEl.textContent = car.speed < -0.3 ? 'R' : Math.abs(car.speed) < 0.3 ? 'N' : 'D';
  lapEl.textContent = fmt(lap.start === null ? null : now - lap.start);
  bestEl.textContent = fmt(lap.best[car.variant]);
  balanceEl.textContent = car.balance === 'over' ? 'Oversteer' : car.balance === 'under' ? 'Understeer' : '';
  balanceEl.className = car.balance ?? '';

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
