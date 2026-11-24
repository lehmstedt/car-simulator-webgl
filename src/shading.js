// Scene shader with materials. Each draw names a material; the fragment shader
// gives it a procedural texture (in world space, so nothing needs image files)
// and its own way of catching the light:
// - car paint and glass: a sharp sun highlight and a clear reflection of the sky
//   (with the horizon and the ground below it), strongest at grazing angles;
// - asphalt: a dull, broad highlight and a blurry sheen toward the horizon when
//   seen at a low angle, over a speckle of light stones;
// - sand, grass, gravel: rough, no reflection; sand glints in the sun;
// - city walls (facade, curtain): a grid of windows from the wall's UVs (meters
//   along the wall, meters up), glassy and mirroring the sky. Some stretches of a
//   brick wall's ground floor are shops: a wide window under a colored awning.
//   Walls darken toward the sidewalk, where less of the sky reaches them;
// - shadow: the soft dark patch under a car, or a pool of light, in the draw's
//   color (a quad with UVs from -1 to 1).
// Fine detail fades out with distance (per pixel footprint), so it never shimmers.
//
// Hour and season (climate.js): the key light (sun or moon) and its color, the
// ambient from the sky and the ground, and the haze all come from uniforms.
// Snow settles on whatever faces up (ground, roofs, sidewalks, pines), in
// patches when thin; roads only get slush. Rain and slush make the asphalt
// darker and glossier. Maples (leaves) turn red, orange and yellow, then thin
// out to bare twigs; pines (needles) stay green. At night windows light up,
// shops glow, the streets get pools of light from their lamps, and the car's
// headlights light the road ahead.

export const MAT = {
  matte: 0, grass: 1, asphalt: 2, sand: 3, gravel: 4, paint: 5, glass: 6, rubber: 7,
  line: 8, metal: 9, concrete: 10, leaves: 11, bark: 12, kerb: 13, straw: 14,
  facade: 15, curtain: 16, water: 17, lamp: 18, signal: 19, shadow: 20, needles: 21,
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
in vec2 vUV; // road strips: x = meters across from the center line; walls: meters along, up
uniform vec3 uColor;
uniform sampler2D uTex;
uniform bool uTextured; // color comes from uTex (sign faces)
uniform int uMat;
uniform float uAlpha;
uniform vec3 uCam;
uniform vec3 uFog;    // sky at the horizon
uniform vec3 uZenith; // sky overhead
uniform vec3 uSun;    // direction to the sun, normalized
uniform float uTime;  // traffic clock (s), for the traffic lights
uniform vec3 uSunCol;     // the key light's color and strength (sun, or moon at night)
uniform vec3 uAmb;        // ambient from the sky above
uniform vec3 uAmbGround;  // ... and from the ground below
uniform vec3 uGroundEnv;  // the ground as seen in reflections
uniform vec2 uFogRange;   // haze from .. to (m)
uniform float uSnow;      // snow on the ground, 0 .. 1
uniform float uWet;       // wet roads, 0 .. 1
uniform float uLeaf;      // leaves on the maples, 0 bare .. 1
uniform float uAutumn;    // 0 green .. 1 turned
uniform float uFresh;     // young spring leaves
uniform vec3 uGrass;      // the season's tint of the grass
uniform float uNight;     // 0 day .. 1 night: lit windows
uniform float uStreet;    // street lamps (night, in the city)
uniform vec3 uHeadPos;    // the player's headlights: position,
uniform vec3 uHeadDir;    // direction,
uniform float uHeadOn;    // and strength (0 off)
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
  vec3 ground = mix(uGroundEnv, uFog, 0.3);
  return mix(ground, sky, smoothstep(-blur, blur, r.y + 0.02));
}

// How much snow lies here (0 .. 1), given the cover k and how much the face looks up:
// thin cover lies in patches, full cover everywhere.
float snowAt(vec2 p, float k, float up) {
  if (k <= 0.001) return 0.0;
  float n = 0.6 * tn(p, 0.13) + 0.4 * tn(p + 5.0, 0.9);
  float t = k * 1.3 - 0.15;
  return smoothstep(n - 0.07, n + 0.07, t) * smoothstep(0.5, 0.85, up);
}
const vec3 SNOW = vec3(0.9, 0.92, 0.96);

// Pools of light under the street lamps: one in each 24 m square, near its middle.
float streetPools(vec2 w) {
  vec2 g = w / 24.0, base = floor(g - 0.5);
  float sum = 0.0;
  for (int i = 0; i < 2; i++) for (int j = 0; j < 2; j++) {
    vec2 cell = base + vec2(i, j);
    vec2 c = (cell + 0.5 + (vec2(hash(cell + 1.7), hash(cell + 9.2)) - 0.5) * 0.5) * 24.0;
    vec2 d = w - c;
    sum += exp(-dot(d, d) / 90.0);
  }
  return sum;
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
  float emit = 0.0; // lamps: their own light, no shading
  float alpha = uAlpha;
  vec3 glow = vec3(0.0); // light of its own, added after shading (lit windows)
  float snow = 0.0;      // snow lying on it
  float pools = 0.0;     // street lamps light it

  if (uMat == M_GRASS) {
    float mid = tn(p, 0.25), blade = tc(p, 14.0);
    alb *= 0.78 + 0.3 * tn(p, 0.04) + 0.18 * mid;
    alb = mix(alb, alb * vec3(1.18, 1.08, 0.68), smoothstep(0.55, 0.85, tn(p + 31.0, 0.12)) * 0.55); // dry patches
    alb *= 0.82 + 0.36 * mix(tn(p, 3.0), blade, 0.5);
    alb *= uGrass;
    h = 0.012 * blade; gloss = 0.1; refl = 0.0; f0 = 0.02; wrap = 0.25;
    snow = snowAt(p, uSnow, N.y);
  } else if (uMat == M_ASPHALT) {
    float agg = tn(p, 9.0), stone = spk(p, 38.0, 0.9);
    alb *= 0.8 + 0.24 * agg + 0.14 * tn(p, 0.12) - 0.08 * tn(p + 9.0, 0.6);
    alb += 0.07 * stone;
    h = 0.003 * agg + 0.0015 * stone; gloss = 0.38; refl = 0.38;
    // Wet: darker, and a mirror where the water lies.
    float puddle = smoothstep(0.45, 0.75, tn(p + 23.0, 0.35));
    alb *= 1.0 - 0.32 * uWet;
    gloss = mix(gloss, 0.85, uWet * (0.6 + 0.4 * puddle)); refl = mix(refl, 0.8, uWet * (0.5 + 0.5 * puddle));
    // Plowed, but salt greys it and small bits of slush stay behind.
    alb = mix(alb, vec3(0.5, 0.5, 0.52), uSnow * 0.3);
    float slush = smoothstep(0.62, 0.8, 0.5 * tn(p, 0.6) + 0.5 * tn(p + 3.0, 2.4)) * uSnow;
    alb = mix(alb, SNOW * 0.8, slush * 0.55);
    pools = 1.0;
  } else if (uMat == M_SAND) {
    float grain = tc(p, 30.0);
    float ripple = sin(dot(p, vec2(4.0, 3.0)) + tn(p, 0.6) * 6.0) * (1.0 - smoothstep(0.15, 0.4, fp));
    alb *= 0.9 + 0.16 * tn(p, 0.5) + 0.14 * (grain - 0.5) - 0.04 * ripple;
    h = 0.012 * ripple + 0.0015 * grain; gloss = 0.12; refl = 0.0; f0 = 0.03;
    sparkle = spk(p, 45.0, 0.975);
    snow = snowAt(p, uSnow, N.y);
  } else if (uMat == M_GRAVEL) {
    // Loose stones; on the stage road, two packed wheel ruts with fewer of them.
    float peb = tn(p, 24.0), mid = tn(p + 17.0, 6.0), grit = tc(p, 70.0);
    float rut = smoothstep(0.6, 0.15, abs(abs(vUV.x) - 0.95)) * step(0.01, abs(vUV.x));
    alb *= (0.78 + 0.3 * peb + 0.14 * mid + 0.12 * (grit - 0.5)) * mix(vec3(1.0), vec3(1.08, 1.0, 0.88), tn(p, 1.5));
    alb = mix(alb, uColor * (0.84 + 0.12 * mid), rut * 0.65);
    h = (0.006 * peb + 0.004 * mid) * (1.0 - 0.7 * rut); gloss = 0.15 + 0.15 * rut; refl = 0.04;
    snow = snowAt(p, uSnow, N.y) * (1.0 - 0.6 * rut);
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
    alb *= 1.0 - 0.2 * uWet; gloss = mix(gloss, 0.8, uWet); refl = mix(refl, 0.6, uWet);
    alb = mix(alb, vec3(0.5, 0.5, 0.52), uSnow * 0.3);
    pools = 1.0;
  } else if (uMat == M_METAL) {
    metal = 1.0; gloss = 0.6; refl = 1.0;
  } else if (uMat == M_CONCRETE) {
    alb *= 0.88 + 0.16 * tn(p, 0.8) + 0.08 * tc(p, 25.0);
    gloss = 0.2; refl = 0.04;
    alb *= 1.0 - 0.25 * uWet * step(0.8, N.y);
    snow = snowAt(p, uSnow, N.y);
  } else if (uMat == M_LEAVES) {
    // Maples: fresh in May, red, orange or yellow in October (one color per
    // tree, some later than others), then thinning out to bare twigs.
    vec2 tree = floor(vWorld.xz / 4.0);
    float kind = hash(tree + 2.3), late = hash(tree + 8.1);
    alb *= mix(vec3(1.0), vec3(1.15, 1.22, 0.75), uFresh);
    vec3 fall = kind < 0.45 ? vec3(0.72, 0.13, 0.06) : kind < 0.8 ? vec3(0.88, 0.42, 0.08) : vec3(0.85, 0.68, 0.14);
    alb = mix(alb, fall * (0.8 + 0.4 * hash(tree + 5.0)), smoothstep(late * 0.5, late * 0.5 + 0.5, uAutumn));
    alb *= 0.72 + 0.5 * tn(p, 2.5);
    gloss = 0.3; refl = 0.0; f0 = 0.03; wrap = 0.5;
    // Gone: what's left is a tangle of twigs (and, far away, a thin grey haze of them).
    float n = vnoise(vWorld.xz * 1.1 + vWorld.y * 0.8 + 3.0);
    if (n > uLeaf * (0.75 + 0.5 * late) - 0.02) {
      float tw = abs(fract(dot(vWorld, vec3(1.3, 2.1, 0.9)) + vnoise(vWorld.xz * 2.2 + vWorld.y) * 2.5) - 0.5);
      float keep = mix(0.07, 0.22, smoothstep(0.02, 0.15, fp));
      if (tw > keep) discard;
      alb = vec3(0.24, 0.2, 0.17); wrap = 0.0;
      snow = snowAt(p, uSnow, N.y) * 0.6;
    }
  } else if (uMat == M_NEEDLES) {
    // Pines: green all year, with snow on their boughs in winter.
    alb *= 0.72 + 0.5 * tn(p, 2.5);
    gloss = 0.25; refl = 0.0; f0 = 0.03; wrap = 0.4;
    snow = snowAt(p + 7.0, uSnow, N.y + 0.15) * 0.6;
  } else if (uMat == M_BARK) {
    float s = tn(vec2(p.x * 6.0, p.y * 0.7), 1.0);
    alb *= 0.65 + 0.6 * s;
    h = 0.006 * s; gloss = 0.08; refl = 0.0;
  } else if (uMat == M_KERB) {
    alb *= 0.92 + 0.1 * tn(p, 6.0);
    gloss = 0.55; refl = 0.3;
    snow = snowAt(p, uSnow * 0.7, N.y);
  } else if (uMat == M_FACADE) {
    // Stone or brick with punched windows: 2.6 m bays, 3.4 m floors.
    vec2 g = vec2(vUV.x / 2.6, vUV.y / 3.4), f = fract(g);
    float win = step(0.24, f.x) * step(f.x, 0.76) * step(0.3, f.y) * step(f.y, 0.85);
    win = mix(win, 0.28, smoothstep(0.1, 0.35, fp / 2.6));
    alb *= 0.86 + 0.16 * tn(p, 0.7) + 0.05 * tc(p, 12.0);
    // Some windows have their blinds down, a few a lamp on.
    float room = hash(floor(g) + 3.1);
    vec3 pane = vec3(0.09, 0.12, 0.16) + 0.07 * room;
    pane = mix(pane, vec3(0.55, 0.53, 0.47), step(0.82, room) * step(f.y, 0.3 + 0.55 * fract(room * 7.0)) * 0.8);
    pane = mix(pane, vec3(0.75, 0.6, 0.35), step(room, 0.07) * 0.6);
    float glassy = win;
    // Shops: every 7.8 m of wall may be one, with a wide window and an awning over it.
    vec2 shop = vec2(floor(vUV.x / 7.8), floor(N.x * 3.0 + 0.5) + 5.0 * floor(N.z * 3.0 + 0.5));
    float kind = hash(shop + 17.0), sx = fract(vUV.x / 7.8);
    if (kind > 0.62 && vUV.y < 3.4) {
      float inShop = step(0.06, sx) * step(sx, 0.94);
      float front = inShop * step(0.5, vUV.y) * step(vUV.y, 2.55);
      float door = step(0.78, sx) * step(sx, 0.9) * step(vUV.y, 2.3) * step(0.08, vUV.y);
      float awn = inShop * step(2.55, vUV.y) * step(vUV.y, 3.15);
      float lod = smoothstep(0.25, 0.9, fp);
      vec3 tint = 0.25 + 0.6 * vec3(hash(shop + 1.0), hash(shop + 2.0), hash(shop + 3.0));
      win = mix(max(front, door), win, lod);
      glassy = win * (1.0 - awn);
      // What's in the window: dark, with the goods on display in the shop's color lower down.
      pane = mix(vec3(0.16, 0.17, 0.18) + 0.25 * tint * step(vUV.y, 1.1 + 0.5 * hash(floor(vec2(vUV.x * 1.3, 2.0)))), pane, lod);
      // Striped or plain awning in the shop's color.
      vec3 cloth = tint * (kind > 0.8 ? 0.75 + 0.25 * step(0.5, fract(vUV.x / 0.5)) : 1.0);
      alb = mix(alb, cloth, awn * (1.0 - lod));
    }
    alb = mix(alb, pane, win);
    // At night about a third of the rooms have a lamp on, and the shops their window lit.
    float home = step(hash(floor(g) + 9.7), 0.34) * (0.6 + 0.6 * hash(floor(g) + 4.4));
    vec3 lampCol = mix(vec3(1.0, 0.72, 0.4), vec3(0.85, 0.9, 1.0), step(0.75, hash(floor(g) + 2.2)));
    glow = win * lampCol * mix(home, 0.3, smoothstep(0.1, 0.35, fp / 2.6)) * uNight * 0.85;
    if (kind > 0.62 && vUV.y < 3.4) glow = mix(glow, vec3(1.0, 0.88, 0.65) * 1.1, glassy * step(vUV.y, 2.55) * uNight);
    // Less sky reaches the foot of a wall.
    alb *= mix(0.72, 1.0, smoothstep(0.0, 2.2, vUV.y));
    gloss = mix(0.15, 0.92, glassy); refl = mix(0.03, 0.7, glassy);
  } else if (uMat == M_CURTAIN) {
    // Glass tower: tinted panes in a grid of light mullions.
    vec2 g = vec2(vUV.x / 1.6, vUV.y / 3.8), f = fract(g);
    float mull = 1.0 - step(0.05, f.x) * step(f.x, 0.95) * step(0.06, f.y) * step(f.y, 0.94);
    mull = mix(mull, 0.14, smoothstep(0.1, 0.35, fp / 1.6));
    alb = mix(alb * (0.85 + 0.25 * hash(floor(g))), vec3(0.6, 0.62, 0.65), mull);
    gloss = mix(0.96, 0.4, mull); refl = mix(0.9, 0.2, mull); f0 = 0.05; fmin = mix(0.2, 0.0, mull);
    // Offices with the lights still on.
    float on = step(0.7, hash(floor(g) + 4.0)) * (0.6 + 0.4 * hash(floor(g / vec2(6.0, 1.0)) + 1.0));
    glow = (1.0 - mull) * vec3(0.85, 0.92, 1.0) * mix(on, 0.25, smoothstep(0.1, 0.35, fp / 1.6)) * uNight * 0.7;
  } else if (uMat == M_WATER) {
    // The river: small ripples, a mirror of the sky.
    float r = tn(p + vec2(3.0, 1.0), 0.35) + 0.5 * tn(p * 1.7 + 11.0, 0.9);
    alb *= 0.85 + 0.2 * tn(p, 0.02);
    h = 0.06 * r; gloss = 0.85; f0 = 0.03; refl = 0.75;
  } else if (uMat == M_LAMP) {
    emit = 1.0;
  } else if (uMat == M_SIGNAL) {
    // Traffic light lamp. vUV.x: the crossing's offset in the cycle (s);
    // vUV.y: its way (0 or 1) * 3 + the lamp (0 red, 1 yellow, 2 green).
    // Same timing as signalState() in traffic.js: 60 s, 26 s green, 3 s yellow.
    float way = floor(vUV.y / 3.0 + 0.01), lamp = floor(vUV.y - way * 3.0 + 0.5);
    float u = mod(uTime + vUV.x - way * 30.0, 60.0);
    float state = u < 26.0 ? 2.0 : u < 29.0 ? 1.0 : 0.0;
    vec3 col = lamp < 0.5 ? vec3(1.0, 0.12, 0.08) : lamp < 1.5 ? vec3(1.0, 0.7, 0.1) : vec3(0.25, 1.0, 0.65);
    alb = abs(state - lamp) < 0.5 ? col * 1.4 : col * 0.06 + 0.02;
    emit = 1.0;
  } else if (uMat == M_SHADOW) {
    // Darkest under the middle of the car, gone at the quad's edge.
    vec2 q = abs(vUV);
    float edge = max(q.x, q.y), corner = length(max(q - 0.55, 0.0)) / 0.45;
    alpha *= (1.0 - smoothstep(0.55, 1.0, max(edge, corner)));
    emit = 1.0;
  } else if (uMat == M_STRAW) {
    alb *= 0.72 + 0.5 * tn(p, 7.0) * (0.7 + 0.3 * tc(p, 30.0));
    gloss = 0.05; refl = 0.0;
    snow = snowAt(p, uSnow, N.y);
  }
  if (snow > 0.0) {
    alb = mix(alb, SNOW * (0.94 + 0.06 * tn(p, 3.0)), snow);
    gloss = mix(gloss, 0.3, snow); refl = mix(refl, 0.05, snow); h *= 1.0 - snow; wrap = mix(wrap, 0.2, snow);
    sparkle = max(sparkle, spk(p, 50.0, 0.97) * snow);
  }

  // Bump from the height h (meters), using screen-space derivatives.
  {
    vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld);
    vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
    if (abs(det) > 1e-12) N = normalize(abs(det) * N - g);
  }

  vec3 sunCol = uSunCol;
  float nl = dot(N, uSun);
  float d = max((nl + wrap) / (1.0 + wrap), 0.0);
  float nv = max(dot(N, V), 1e-3);
  // Light from the sky above, a little from the ground below.
  vec3 amb = mix(uAmbGround, uAmb, N.y * 0.5 + 0.5);
  // Lights of the night: street lamps on the road, the car's headlights ahead.
  vec3 lit = vec3(0.0);
  if (uStreet > 0.0 && pools > 0.0) lit += vec3(1.0, 0.8, 0.55) * streetPools(vWorld.xz) * 2.2 * uStreet;
  if (uHeadOn > 0.0) {
    vec3 L = uHeadPos - vWorld;
    float dist = length(L);
    L /= dist;
    float ca = dot(-L, uHeadDir);
    float beam = smoothstep(0.9, 0.975, ca) + 0.25 * smoothstep(0.55, 0.9, ca);
    float fall = 1.0 / (1.0 + dist * dist / 500.0) * smoothstep(0.5, 2.5, dist);
    lit += vec3(1.0, 0.95, 0.85) * beam * fall * (0.3 + 0.7 * max(dot(N, L), 0.0)) * 1.8 * uHeadOn;
  }
  vec3 diffuse = uTextured ? alb * (amb * 1.6 + 0.4 * d * sunCol + lit) : alb * (amb + 0.65 * d * sunCol + lit);

  vec3 F0 = mix(vec3(f0), alb, metal);
  vec3 F = max(F0 + (1.0 - F0) * pow(1.0 - nv, 5.0), vec3(fmin));
  vec3 H = normalize(uSun + V);
  float shin = exp2(1.0 + gloss * 10.0);
  vec3 Fh = F0 + (1.0 - F0) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  vec3 spec = Fh * ((shin + 8.0) / 25.0) * pow(max(dot(N, H), 0.0), shin) * max(nl, 0.0) * sunCol;
  vec3 mirror = env(reflect(-V, N), gloss) * F * refl;

  vec3 c = diffuse * (1.0 - metal) * (1.0 - F * refl) + spec + mirror;
  c += sparkle * 1.5 * sunCol * max(nl, 0.0) * pow(max(dot(N, H), 0.0), 6.0);
  c += glow;
  if (emit > 0.5) c = alb;
  // Haze: far things fade into the sky's horizon color.
  float fog = smoothstep(uFogRange.x, uFogRange.y, distance(vWorld, uCam)) * 0.9;
  outColor = vec4(mix(c, uFog, fog), uMat == M_SHADOW ? alpha * (1.0 - fog) : alpha);
}`;
