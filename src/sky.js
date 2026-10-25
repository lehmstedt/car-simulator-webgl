// Sky: a dome that follows the camera, shaded from a hazy horizon to a deeper
// blue overhead, with the sun (same direction as the scene's light) and soft
// drifting clouds. The scene fades into the horizon color with distance (see
// the fog in main.js), so the far ground blends into the sky.

import { createProgram, createMesh } from './gl.js';

export const HORIZON = [0.78, 0.86, 0.93];
export const ZENITH = [0.27, 0.5, 0.86];
export const SUN_DIR = [0.4, 1.0, 0.3];

const SKY_VS = `#version 300 es
in vec3 aPosition;
uniform mat4 uViewProj;
uniform vec3 uCam;
out vec3 vDir;
void main() {
  vDir = aPosition;
  gl_Position = uViewProj * vec4(uCam + aPosition * 500.0, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
in vec3 vDir;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uSun;
uniform float uTime;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 c = mix(uHorizon, uZenith, pow(h, 0.55));
  // Sun disc and glow.
  float s = max(dot(d, normalize(uSun)), 0.0);
  c += vec3(1.0, 0.95, 0.8) * (pow(s, 900.0) * 1.2 + pow(s, 12.0) * 0.18);
  // Clouds: noise projected on a flat layer overhead, thinning toward the horizon.
  if (d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.12) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
    float n = fbm(uv);
    float cover = smoothstep(0.52, 0.78, n) * smoothstep(0.0, 0.25, d.y);
    vec3 cloud = mix(vec3(0.82, 0.85, 0.9), vec3(1.0), smoothstep(0.55, 0.9, n));
    c = mix(c, cloud, cover * 0.9);
  }
  outColor = vec4(c, 1.0);
}`;

// Unit sphere, as a triangle list.
function sphere(segs = 24, rings = 12) {
  const positions = [];
  const p = (i, j) => {
    const u = (i / segs) * Math.PI * 2, v = (j / rings) * Math.PI - Math.PI / 2;
    return [Math.cos(v) * Math.cos(u), Math.sin(v), Math.cos(v) * Math.sin(u)];
  };
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < rings; j++) {
      for (const [a, b] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]]) positions.push(...p(a, b));
    }
  }
  return { positions, normals: positions };
}

export class Sky {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl, SKY_VS, SKY_FS);
    this.mesh = createMesh(gl, this.program, sphere());
    const u = (n) => gl.getUniformLocation(this.program, n);
    this.u = { viewProj: u('uViewProj'), cam: u('uCam'), horizon: u('uHorizon'), zenith: u('uZenith'), sun: u('uSun'), time: u('uTime') };
  }

  // Draw first: it writes no depth, so everything else draws over it.
  draw(viewProj, cam, time) {
    const { gl, u } = this;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.uniform3fv(u.cam, cam);
    gl.uniform3fv(u.horizon, HORIZON);
    gl.uniform3fv(u.zenith, ZENITH);
    gl.uniform3fv(u.sun, SUN_DIR);
    gl.uniform1f(u.time, time);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.bindVertexArray(this.mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.mesh.count);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }
}
