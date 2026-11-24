// Falling snow and rain around the eye: points in a box that moves with the
// camera, wrapped so they never run out. Each falls at its own speed and
// drifts in the wind; snowflakes flutter and are soft dots, raindrops fall fast
// and are drawn as thin streaks inside their point. Only as many are drawn as
// the weather's strength asks for (climate.js).

import { createProgram } from './gl.js';

const COUNT = 6000;
const BOX = 70; // m, each side, centered on the eye

const PRECIP_VS = `#version 300 es
in vec4 aSeed; // x, y, z in 0..1, and a random value
uniform mat4 uViewProj;
uniform vec3 uCam;
uniform float uTime;
uniform float uRain;   // 0 snow .. 1 rain
uniform float uScale;  // pixels per meter at 1 m (viewport height / 2 / tan(fov / 2))
out float vFade;
void main() {
  float r = aSeed.w;
  float speed = mix(1.1 + 0.6 * r, 9.0 + 3.0 * r, uRain);
  vec3 drift = vec3(0.6, 0.0, 0.25) * (1.0 - uRain) + vec3(0.5, 0.0, 0.2) * uRain;
  vec3 p = aSeed.xyz * ${BOX.toFixed(1)} + drift * uTime - vec3(0.0, speed * uTime, 0.0);
  // Snow flutters.
  p.xz += (1.0 - uRain) * 0.35 * vec2(sin(uTime * 1.3 + r * 40.0), cos(uTime * 1.1 + r * 23.0));
  // Wrap into the box around the eye.
  vec3 w = uCam + mod(p - uCam, ${BOX.toFixed(1)}) - ${(BOX / 2).toFixed(1)};
  gl_Position = uViewProj * vec4(w, 1.0);
  float dist = max(gl_Position.w, 0.3);
  float size = mix(0.07, 0.6, uRain);
  gl_PointSize = clamp(size * uScale / dist, 1.0, mix(14.0, 40.0, uRain));
  vFade = smoothstep(${(BOX / 2).toFixed(1)}, ${(BOX / 4).toFixed(1)}, distance(w, uCam)) * smoothstep(0.3, 1.2, dist);
}`;

const PRECIP_FS = `#version 300 es
precision highp float;
in float vFade;
uniform float uRain;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float a;
  if (uRain > 0.5) a = smoothstep(0.08, 0.0, abs(q.x)) * smoothstep(0.5, 0.2, abs(q.y)) * 0.35;
  else a = smoothstep(0.5, 0.1, length(q));
  if (a * vFade < 0.01) discard;
  outColor = vec4(uColor, a * vFade);
}`;

export class Precipitation {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl, PRECIP_VS, PRECIP_FS);
    const seeds = new Float32Array(COUNT * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, 'aSeed');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    const u = (n) => gl.getUniformLocation(this.program, n);
    this.u = { viewProj: u('uViewProj'), cam: u('uCam'), time: u('uTime'), rain: u('uRain'), scale: u('uScale'), color: u('uColor') };
  }

  // Draw last, over the scene: `sky` is the Climate, `scale` pixels per meter at 1 m.
  draw(viewProj, cam, time, sky, scale) {
    const amount = Math.max(sky.snowing, sky.raining);
    const n = Math.round(COUNT * Math.min(1, amount * 1.2));
    if (n < 10) return;
    const { gl, u } = this;
    const rain = sky.raining > sky.snowing ? 1 : 0;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.uniform3fv(u.cam, cam);
    gl.uniform1f(u.time, time);
    gl.uniform1f(u.rain, rain);
    gl.uniform1f(u.scale, scale);
    // Flakes catch the light around them: bright by day, dim but visible at night.
    const k = 0.4 + 0.6 * Math.min(1, sky.amb[1] / 0.38);
    gl.uniform3fv(u.color, rain ? [0.7 * k + 0.1, 0.75 * k + 0.1, 0.82 * k + 0.12] : [0.95 * k + 0.05, 0.96 * k + 0.05, k + 0.06]);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
