// Sky: a dome that follows the camera, shaded from the horizon to overhead in
// the colors of the hour and the weather (climate.js): blue by day, orange
// toward the sun at dusk, near black at night with stars and the moon, grey
// under overcast. Clouds drift across, lit by the sun, thicker in bad weather.
// The scene fades into the horizon color with distance (the haze in
// shading.js), so the far ground blends into the sky.

import { createProgram, createMesh } from './gl.js';


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
uniform vec3 uSun;     // direction to the sun (may be below the horizon)
uniform vec3 uSunCol;  // its disc and the light on the clouds' edges
uniform vec3 uGlow;    // dusk: warm glow around the sun's side of the horizon
uniform vec3 uMoon;
uniform float uMoonPhase; // 0 new .. 1 full
uniform float uNight;  // 0 day .. 1 night: stars
uniform float uCloud;  // 0 clear .. 1 overcast
uniform vec3 uCloudCol;
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
  vec3 sd = normalize(uSun);
  // Dusk: the horizon glows on the sun's side.
  float toward = max(dot(normalize(d.xz + 1e-4), normalize(sd.xz + 1e-4)), 0.0);
  c += uGlow * pow(toward, 3.0) * pow(1.0 - h, 4.0);
  // Stars, where the night sky is clear.
  if (uNight > 0.01 && d.y > 0.0) {
    vec2 sp = d.xz / (d.y + 0.6) * 140.0;
    vec2 cell = floor(sp);
    float star = hash(cell);
    vec2 off = vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5;
    float dist = length(fract(sp) - 0.5 - off * 0.6);
    float tw = 0.75 + 0.25 * sin(uTime * 3.0 + star * 50.0);
    c += vec3(0.9, 0.93, 1.0) * step(0.985, star) * smoothstep(0.12, 0.0, dist) * tw * uNight * (1.0 - uCloud) * smoothstep(0.0, 0.2, d.y);
  }
  // The moon: a disc, its lit share by the phase, and a halo.
  vec3 md = normalize(uMoon);
  float m = max(dot(d, md), 0.0);
  float disc = smoothstep(0.99955, 0.99975, m);
  c += vec3(0.95, 0.95, 0.88) * disc * (0.15 + 0.85 * uMoonPhase) * (0.35 + 0.65 * uNight) * (1.0 - 0.85 * uCloud);
  c += vec3(0.5, 0.55, 0.7) * pow(m, 60.0) * 0.12 * uMoonPhase * uNight * (1.0 - uCloud);
  // Sun disc and glow.
  float s = max(dot(d, sd), 0.0);
  c += uSunCol * (pow(s, 900.0) * 1.2 + pow(s, 12.0) * 0.18);
  // Clouds: noise projected on a flat layer overhead, thinning toward the horizon.
  if (d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.12) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
    float n = fbm(uv);
    float lo = mix(0.52, 0.12, uCloud);
    float cover = smoothstep(lo, lo + 0.26, n) * smoothstep(0.0, 0.25, d.y);
    vec3 cloud = mix(uCloudCol * 0.82, uCloudCol, smoothstep(0.55, 0.9, n));
    cloud += uSunCol * pow(s, 6.0) * 0.35 * (1.0 - n);
    c = mix(c, cloud, cover * mix(0.9, 0.97, uCloud));
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
    this.u = Object.fromEntries(['uViewProj', 'uCam', 'uHorizon', 'uZenith', 'uSun', 'uSunCol', 'uGlow', 'uMoon', 'uMoonPhase', 'uNight', 'uCloud', 'uCloudCol', 'uTime']
      .map((n) => [n.slice(1, 2).toLowerCase() + n.slice(2), u(n)]));
  }

  // Draw first: it writes no depth, so everything else draws over it.
  // `sky`: the Climate (climate.js).
  draw(viewProj, cam, time, sky) {
    const { gl, u } = this;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.uniform3fv(u.cam, cam);
    gl.uniform3fv(u.horizon, sky.horizon);
    gl.uniform3fv(u.zenith, sky.zenith);
    gl.uniform3fv(u.sun, sky.sun);
    gl.uniform3fv(u.sunCol, sky.sunDisc);
    gl.uniform3fv(u.glow, sky.glow);
    gl.uniform3fv(u.moon, sky.moon);
    gl.uniform1f(u.moonPhase, sky.moonPhase);
    gl.uniform1f(u.night, sky.night);
    gl.uniform1f(u.cloud, sky.cloud);
    // Clouds: white by day, grey when heavy, dim at night (with the city's glow under them).
    const day = Math.max(0, Math.min(1, (sky.sun[1] + 0.12) / 0.3));
    const k = (0.12 + 0.88 * day) * (1 - 0.4 * sky.cloud);
    gl.uniform3fv(u.cloudCol, [0.97 * k + 0.04 * (1 - day), 0.98 * k + 0.03 * (1 - day), 1.0 * k + 0.03 * (1 - day)]);
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
