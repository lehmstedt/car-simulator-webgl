import { createProgram, createMesh } from './gl.js';
import { cube, plane } from './geometry.js';
import { perspective, lookAt, multiply, trs, identity } from './math.js';
import { readControls } from './input.js';
import { Car } from './car.js';

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
    c = mix(c, c * 0.7, line);
  }
  outColor = vec4(c, 1.0);
}`;

const canvas = document.getElementById('gl');
const hud = document.getElementById('hud');
const gl = canvas.getContext('webgl2', { antialias: true });
if (!gl) {
  hud.textContent = 'WebGL2 not supported';
  throw new Error('WebGL2 not supported');
}

const program = createProgram(gl, VS, FS);
const uModel = gl.getUniformLocation(program, 'uModel');
const uViewProj = gl.getUniformLocation(program, 'uViewProj');
const uColor = gl.getUniformLocation(program, 'uColor');
const uGrid = gl.getUniformLocation(program, 'uGrid');

const meshes = {
  cube: createMesh(gl, program, cube()),
  ground: createMesh(gl, program, plane(500)),
};

// A few static obstacles so motion is visible.
const props = [];
for (let i = 0; i < 60; i++) {
  const ang = i * 2.399; // golden angle spiral
  const r = 20 + i * 6;
  props.push({ x: Math.cos(ang) * r, z: Math.sin(ang) * r, s: 2 + (i % 4) });
}

const car = new Car();
const cam = { x: 0, y: 4, z: 10 };

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

function draw(mesh, model, color, gridSize = 0) {
  gl.uniformMatrix4fv(uModel, false, model);
  gl.uniform3fv(uColor, color);
  gl.uniform1f(uGrid, gridSize);
  gl.bindVertexArray(mesh.vao);
  gl.drawArrays(mesh.mode, 0, mesh.count);
}

function drawCar() {
  const { x, z, heading: h, steer } = car;
  // Body + cabin.
  draw(meshes.cube, trs(x, 0.6, z, h, 1.8, 0.6, 4.2), [0.85, 0.15, 0.15]);
  const fx = -Math.sin(h), fz = -Math.cos(h);
  draw(meshes.cube, trs(x - fx * 0.3, 1.15, z - fz * 0.3, h, 1.5, 0.5, 2.0), [0.2, 0.2, 0.25]);
  // Wheels (front ones turn with steering).
  const rx = Math.cos(h), rz = -Math.sin(h);
  for (const [side, fwd, front] of [[-1, 1.3, true], [1, 1.3, true], [-1, -1.3, false], [1, -1.3, false]]) {
    const wx = x + rx * side * 0.95 + fx * fwd;
    const wz = z + rz * side * 0.95 + fz * fwd;
    draw(meshes.cube, trs(wx, 0.35, wz, h + (front ? steer : 0), 0.3, 0.7, 0.7), [0.08, 0.08, 0.08]);
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const controls = readControls();
  if (controls.reset) car.reset();
  car.update(dt, controls);

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
  gl.enable(gl.CULL_FACE);
  gl.useProgram(program);

  const proj = perspective(Math.PI / 3, canvas.width / canvas.height, 0.1, 1000);
  const view = lookAt([cam.x, cam.y, cam.z], [car.x, 1, car.z], [0, 1, 0]);
  gl.uniformMatrix4fv(uViewProj, false, multiply(proj, view));

  draw(meshes.ground, identity(), [0.3, 0.55, 0.3], 10);
  for (const p of props) draw(meshes.cube, trs(p.x, p.s / 2, p.z, 0, p.s, p.s, p.s), [0.7, 0.65, 0.5]);
  drawCar();

  hud.textContent =
    `Speed: ${(car.speed * 3.6).toFixed(0)} km/h\n` +
    `W/S or ↑/↓  throttle/brake\nA/D or ←/→  steer\nSpace handbrake · R reset`;

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
