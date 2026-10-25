// Scene shader with materials. Each draw names a material; the fragment shader
// gives it a procedural texture (in world space, so nothing needs image files)
// and its own way of catching the light:
// - car paint and glass: a sharp sun highlight and a clear reflection of the sky
//   (with the horizon and the ground below it), strongest at grazing angles;
// - asphalt: a dull, broad highlight and a blurry sheen toward the horizon when
//   seen at a low angle, over a speckle of light stones;
// - sand, grass, gravel: rough, no reflection; sand glints in the sun.
// Fine detail fades out with distance (per pixel footprint), so it never shimmers.

export const MAT = {
  matte: 0, grass: 1, asphalt: 2, sand: 3, gravel: 4, paint: 5, glass: 6, rubber: 7,
  line: 8, metal: 9, concrete: 10, leaves: 11, bark: 12, kerb: 13, straw: 14,
};

export const SCENE_VS = `#version 300 es
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

const defines = Object.entries(MAT).map(([k, v]) => `#define M_${k.toUpperCase()} ${v}`).join('\n');

export const SCENE_FS = `#version 300 es
precision highp float;
${defines}
in vec3 vNormal;
in vec3 vWorld;
in vec2 vUV; // road strips: x = meters across from the center line (0 elsewhere)
uniform vec3 uColor;
uniform sampler2D uTex;
uniform bool uTextured; // color comes from uTex (sign faces)
uniform int uMat;
uniform float uAlpha;
uniform vec3 uCam;
uniform vec3 uFog;    // sky at the horizon
uniform vec3 uZenith; // sky overhead
uniform vec3 uSun;    // direction to the sun, normalized
out vec4 outColor;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fp; // meters covered by one pixel here
// Smooth noise at freq cycles per meter; fades to its mean once a cycle gets under ~2 pixels.
float tn(vec2 p, float freq) { return mix(vnoise(p * freq), 0.5, smoothstep(0.25, 0.6, freq * fp)); }
// A random value per cell (grains), faded the same way.
float tc(vec2 p, float freq) { return mix(hash(floor(p * freq)), 0.5, smoothstep(0.2, 0.5, freq * fp)); }
// Sparse speckles: 1 in cells above thr, faded to their average.
float spk(vec2 p, float freq, float thr) { return mix(step(thr, hash(floor(p * freq) + 7.3)), 1.0 - thr, smoothstep(0.2, 0.5, freq * fp)); }

// The world as seen in a reflection: sky above the horizon, ground below.
// Low gloss blurs the horizon.
vec3 env(vec3 r, float gloss) {
  float blur = mix(0.5, 0.015, gloss);
  vec3 sky = mix(uFog, uZenith, pow(max(r.y, 0.0), 0.55));
  vec3 ground = mix(vec3(0.2, 0.26, 0.18), uFog, 0.3);
  return mix(ground, sky, smoothstep(-blur, blur, r.y + 0.02));
}

void main() {
  fp = max(length(fwidth(vWorld)), 1e-4);
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCam - vWorld);
  vec3 alb = uTextured ? texture(uTex, vUV).rgb : uColor;
  // Texture coordinates on the face's main plane, so walls and trunks get them too.
  vec3 an = abs(N);
  vec2 p = an.y >= max(an.x, an.z) ? vWorld.xz : an.x > an.z ? vWorld.zy : vWorld.xy;

  float f0 = 0.04;    // reflectance head-on
  float gloss = 0.25; // 0 rough .. 1 mirror
  float refl = 0.08;  // how much of the environment it mirrors
  float metal = 0.0, h = 0.0, sparkle = 0.0, wrap = 0.0, fmin = 0.0;

  if (uMat == M_GRASS) {
    float mid = tn(p, 0.25), blade = tc(p, 14.0);
    alb *= 0.78 + 0.3 * tn(p, 0.04) + 0.18 * mid;
    alb = mix(alb, alb * vec3(1.18, 1.08, 0.68), smoothstep(0.55, 0.85, tn(p + 31.0, 0.12)) * 0.55); // dry patches
    alb *= 0.82 + 0.36 * mix(tn(p, 3.0), blade, 0.5);
    h = 0.012 * blade; gloss = 0.1; refl = 0.0; f0 = 0.02; wrap = 0.25;
  } else if (uMat == M_ASPHALT) {
    float agg = tn(p, 9.0), stone = spk(p, 38.0, 0.9);
    alb *= 0.8 + 0.24 * agg + 0.14 * tn(p, 0.12) - 0.08 * tn(p + 9.0, 0.6);
    alb += 0.07 * stone;
    h = 0.003 * agg + 0.0015 * stone; gloss = 0.38; refl = 0.38;
  } else if (uMat == M_SAND) {
    float grain = tc(p, 30.0);
    float ripple = sin(dot(p, vec2(4.0, 3.0)) + tn(p, 0.6) * 6.0) * (1.0 - smoothstep(0.15, 0.4, fp));
    alb *= 0.9 + 0.16 * tn(p, 0.5) + 0.14 * (grain - 0.5) - 0.04 * ripple;
    h = 0.012 * ripple + 0.0015 * grain; gloss = 0.12; refl = 0.0; f0 = 0.03;
    sparkle = spk(p, 45.0, 0.975);
  } else if (uMat == M_GRAVEL) {
    // Loose stones; on the stage road, two packed wheel ruts with fewer of them.
    float peb = tn(p, 24.0), mid = tn(p + 17.0, 6.0), grit = tc(p, 70.0);
    float rut = smoothstep(0.6, 0.15, abs(abs(vUV.x) - 0.95)) * step(0.01, abs(vUV.x));
    alb *= (0.78 + 0.3 * peb + 0.14 * mid + 0.12 * (grit - 0.5)) * mix(vec3(1.0), vec3(1.08, 1.0, 0.88), tn(p, 1.5));
    alb = mix(alb, uColor * (0.84 + 0.12 * mid), rut * 0.65);
    h = (0.006 * peb + 0.004 * mid) * (1.0 - 0.7 * rut); gloss = 0.15 + 0.15 * rut; refl = 0.04;
  } else if (uMat == M_PAINT) {
    gloss = 0.9; f0 = 0.05; refl = 0.9;
  } else if (uMat == M_GLASS) {
    gloss = 0.97; f0 = 0.05; refl = 1.0; fmin = 0.22;
  } else if (uMat == M_RUBBER) {
    gloss = 0.18; f0 = 0.03; refl = 0.03;
  } else if (uMat == M_LINE) {
    // Road paint: the stones of the asphalt show through.
    alb *= 0.92 + 0.1 * tn(p, 9.0) - 0.18 * spk(p, 38.0, 0.85);
    h = 0.001 * tn(p, 9.0); gloss = 0.45; refl = 0.25;
  } else if (uMat == M_METAL) {
    metal = 1.0; gloss = 0.6; refl = 1.0;
  } else if (uMat == M_CONCRETE) {
    alb *= 0.88 + 0.16 * tn(p, 0.8) + 0.08 * tc(p, 25.0);
    gloss = 0.2; refl = 0.04;
  } else if (uMat == M_LEAVES) {
    alb *= 0.72 + 0.5 * tn(p, 2.5);
    gloss = 0.3; refl = 0.0; f0 = 0.03; wrap = 0.5;
  } else if (uMat == M_BARK) {
    float s = tn(vec2(p.x * 6.0, p.y * 0.7), 1.0);
    alb *= 0.65 + 0.6 * s;
    h = 0.006 * s; gloss = 0.08; refl = 0.0;
  } else if (uMat == M_KERB) {
    alb *= 0.92 + 0.1 * tn(p, 6.0);
    gloss = 0.55; refl = 0.3;
  } else if (uMat == M_STRAW) {
    alb *= 0.72 + 0.5 * tn(p, 7.0) * (0.7 + 0.3 * tc(p, 30.0));
    gloss = 0.05; refl = 0.0;
  }

  // Bump from the height h (meters), using screen-space derivatives.
  {
    vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld);
    vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
    if (abs(det) > 1e-12) N = normalize(abs(det) * N - g);
  }

  vec3 sunCol = vec3(1.0, 0.96, 0.88);
  float nl = dot(N, uSun);
  float d = max((nl + wrap) / (1.0 + wrap), 0.0);
  float nv = max(dot(N, V), 1e-3);
  // Light from the sky above, a little from the ground below.
  vec3 amb = mix(vec3(0.27, 0.29, 0.26), vec3(0.35, 0.38, 0.43), N.y * 0.5 + 0.5);
  vec3 diffuse = uTextured ? alb * (0.6 + 0.4 * d) : alb * (amb + 0.65 * d * sunCol);

  vec3 F0 = mix(vec3(f0), alb, metal);
  vec3 F = max(F0 + (1.0 - F0) * pow(1.0 - nv, 5.0), vec3(fmin));
  vec3 H = normalize(uSun + V);
  float shin = exp2(1.0 + gloss * 10.0);
  vec3 Fh = F0 + (1.0 - F0) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  vec3 spec = Fh * ((shin + 8.0) / 25.0) * pow(max(dot(N, H), 0.0), shin) * max(nl, 0.0) * sunCol;
  vec3 mirror = env(reflect(-V, N), gloss) * F * refl;

  vec3 c = diffuse * (1.0 - metal) * (1.0 - F * refl) + spec + mirror;
  c += sparkle * 1.5 * sunCol * max(nl, 0.0) * pow(max(dot(N, H), 0.0), 6.0);
  // Haze: far things fade into the sky's horizon color.
  float fog = smoothstep(120.0, 750.0, distance(vWorld, uCam)) * 0.85;
  outColor = vec4(mix(c, uFog, fog), uAlpha);
}`;
