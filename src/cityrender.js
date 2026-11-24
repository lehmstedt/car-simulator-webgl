// Drawing what moves in the city (Montreal): traffic and parked cars, patrol
// cars, roadblocks and the helicopter, people, and the soft shadows under
// them all. Each thing is a few meshes drawn per instance in its own colors;
// far ones are drawn with fewer parts, and past DRAW not at all.

import { createMesh } from './gl.js';
import { cube } from './geometry.js';
import { basis } from './math.js';
import { carMeshes } from './traffic.js';

const DRAW = 320;        // m: moving cars
const PARKED_DRAW = 170; // m: parked cars
const PEOPLE_DRAW = 150; // m
const DETAIL = 150;      // m: lights, bumpers and wheels nearer than this
const PARKED_DETAIL = 80;
const CAR_GLASS = [0.1, 0.12, 0.15], CAR_TRIM = [0.06, 0.06, 0.07], HEAD = [0.86, 0.88, 0.9];
const TAIL = [0.5, 0.05, 0.05], TAIL_ON = [1, 0.12, 0.08], AMBER = [1, 0.6, 0.05], AMBER_OFF = [0.45, 0.25, 0.05];
const POLICE_WHITE = [0.92, 0.93, 0.95], POLICE_BLUE = [0.04, 0.12, 0.42], POLICE_DARK = [0.1, 0.1, 0.12];
const BLACK = [0, 0, 0], HEAD_ON = [1, 0.97, 0.88], TAIL_LIT = [0.65, 0.06, 0.05];

// gl, the scene's program, and its draw(mesh, model, color, material, alpha).
// setSun() gives the direction of the light (shadows fall away from it) and
// how strong it is; setLights() turns the cars' headlights on at night.
export function createCityRenderer(gl, program, draw) {
  const box = createMesh(gl, program, cube());
  const cars = carMeshes().map((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v.positions.length).map(([k, v]) => [k, createMesh(gl, program, v)])));
  const shapes = carMeshes.shapes;
  // A flat square from -1 to 1 with its own coordinates as UVs (shading.js, shadow).
  const quad = createMesh(gl, program, {
    positions: [-1, 0, -1, -1, 0, 1, 1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0, -1],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    uvs: [-1, -1, -1, 1, 1, 1, -1, -1, 1, 1, 1, -1],
  });
  let lean = 0, sx = 0, sz = 0, shade = 1, lights = false;
  function setSun(sun, strength = 1) {
    lean = Math.min(3, Math.hypot(sun[0], sun[2]) / Math.max(0.2, sun[1])); // shadow length per meter of height
    [sx, sz] = [-sun[0], -sun[2]].map((v) => v / (Math.hypot(sun[0], sun[2]) || 1));
    // Under a grey sky or at night only the dark patch right under things is left.
    lean *= strength;
    shade = 0.55 + 0.45 * strength;
  }
  setSun([0.33, 0.83, 0.25]);
  const far = (o, eye, d) => Math.abs(o.x - eye[0]) > d || Math.abs(o.z - eye[2]) > d || Math.hypot(o.x - eye[0], o.z - eye[2]) > d;

  // A part in the frame F ({ o, right, up, back }) at (x, y, z), sized (w, h, l).
  const part = (F, x, y, z, w, h, l, color, mat, alpha = 1) => draw(box, basis(
    [0, 1, 2].map((i) => F.o[i] + F.right[i] * x + F.up[i] * y + F.back[i] * z), F.right, F.up, F.back, w, h, l), color, mat, alpha);
  const frameOf = (c, y) => ({ o: [c.x, y, c.z], right: [-c.dz, 0, c.dx], up: [0, 1, 0], back: [-c.dx, 0, -c.dz] });

  // One car of the traffic's shapes. `blink`: whether turn signals are in their lit half.
  function car(c, y, eye, blink, paint = c.color) {
    const m = cars[c.kind.index];
    // The body on its springs (traffic.js step()): pitched nose down by `pitch`,
    // leaning left by `roll` (small angles).
    const p = c.pitch ?? 0, q = c.roll ?? 0;
    const B = basis([c.x, y, c.z], [-c.dz, q, c.dx], [c.dx * p + c.dz * q, 1, c.dz * p - c.dx * q], [-c.dx, p, -c.dz]);
    draw(m.paint, B, paint, 'paint');
    if (m.glass) draw(m.glass, B, CAR_GLASS, 'glass');
    if (m.accent) draw(m.accent, B, c.kind.accent, 'paint');
    if (far(c, eye, c.parked ? PARKED_DETAIL : DETAIL)) return;
    draw(m.trim, B, CAR_TRIM, 'rubber');
    // At night the headlights are lit (parked cars' are off) and the tail lights glow.
    const on = lights && !c.parked;
    draw(m.head, B, on ? HEAD_ON : HEAD, on ? 'lamp' : 'glass');
    draw(m.tail, B, c.braking ? TAIL_ON : on ? TAIL_LIT : TAIL, c.braking || on ? 'lamp' : 'paint');
    if (c.parked) return;
    const hazard = c.halt > 0;
    for (const [mesh, side] of [[m.blinkL, -1], [m.blinkR, 1]]) {
      const on = blink && (hazard || c.turn === side);
      draw(mesh, B, on ? AMBER : AMBER_OFF, on ? 'lamp' : 'paint');
    }
  }

  return {
    setSun,
    setLights(on) { lights = on; },

    // Soft shadows on the road under everything given: [{ x, z, dx, dz, length, width, height }].
    // Call with blending on and depth writes off, after the roads.
    shadows(list, y, eye, reach = 200) {
      for (const c of list) {
        if (far(c, eye, reach)) continue;
        const h = c.height ?? 1.3, w = c.width / 2 + 0.3, l = c.length / 2 + 0.3, off = h * lean * 0.5;
        draw(quad, basis([c.x + sx * off, y, c.z + sz * off], [-c.dz, 0, c.dx], [0, 1, 0], [-c.dx, 0, -c.dz], w + off * 0.4, 1, l + off * 0.4), BLACK, 'shadow', (c.alpha ?? 0.5) * shade);
      }
    },

    // What casts a shadow near the eye: cars (moving, parked, police) and people.
    casters(eye, traffic, police, people) {
      const out = [];
      const add = (c, k) => out.push({ x: c.x, z: c.z, dx: c.dx, dz: c.dz, length: k.length, width: k.width, height: k.name === 'bus' ? 3 : k.name === 'van' ? 2.2 : 1.4 });
      for (const c of traffic.cars) if (!far(c, eye, 200)) add(c, c.kind);
      for (const c of traffic.parkedNear(eye[0], eye[2], Math.min(PARKED_DRAW, 150))) add(c, c.kind);
      for (const u of police.cars) if (!far(u, eye, 200)) add(u, u);
      for (const p of people) if (!far(p, eye, 70)) out.push({ x: p.x, z: p.z, dx: p.dx, dz: p.dz, length: 0.2, width: 0.3, height: 1.7, alpha: 0.4 });
      return out;
    },

    traffic(traffic, y, eye, t) {
      const blink = (t * 2.7) % 1 < 0.5;
      for (const c of traffic.cars) {
        if (far(c, eye, DRAW)) continue;
        car(c, y, eye, blink);
        // A taxi's roof light.
        if (c.taxi && !far(c, eye, DETAIL)) part(frameOf(c, y), 0, 1.5, -0.1, 0.5, 0.14, 0.22, [1, 0.95, 0.7], 'lamp');
      }
      for (const c of traffic.parkedNear(eye[0], eye[2], PARKED_DRAW)) car(c, y, eye, false);
    },

    // Patrol cars: the traffic's sedan (or SUV, the heavy units) in white with a
    // blue stripe and a light bar flashing red and blue. Roadblocks: the cars
    // across the street, cones before them, and the spike strip.
    police(police, y, eye, t) {
      const blink = Math.floor(t * 5) % 2 === 0;
      for (const u of police.cars) {
        const flash = u.patrol ? null : blink; // cruising: the light bar is off
        if (far(u, eye, DRAW)) continue;
        const k = shapes[u.heavy ? 1 : 0], F = frameOf(u, y), hw = k.width / 2, roof = k.glass[2];
        car({ ...u, kind: k, braking: u.v < 0.5, turn: 0, halt: 0 }, y, eye, false, POLICE_WHITE);
        for (const side of [-1, 1]) part(F, side * (hw - 0.012), k.clear + (u.heavy ? 0.52 : 0.42), 0.1, 0.03, 0.2, k.length - 1.3, POLICE_BLUE, 'paint');
        const mid = (k.glass[0] + k.glass[3] + k.glass[1] - k.glass[4]) / 2 - k.length / 2;
        part(F, 0, roof + 0.04, mid, 1.15, 0.06, 0.3, POLICE_DARK, 'matte');
        part(F, -0.3, roof + 0.11, mid, 0.48, 0.1, 0.26, flash ? [1, 0.1, 0.08] : [0.35, 0.04, 0.04], flash ? 'lamp' : 'glass');
        part(F, 0.3, roof + 0.11, mid, 0.48, 0.1, 0.26, flash === false ? [0.15, 0.35, 1] : [0.08, 0.1, 0.3], flash === false ? 'lamp' : 'glass');
        if (u.heavy) part(F, 0, 0.62, -k.length / 2 - 0.08, 1.5, 0.5, 0.1, POLICE_DARK, 'metal'); // push bar
      }
      for (const b of police.blocks) {
        if (far(b, eye, DRAW)) continue;
        const s = b.spikes;
        if (!s) continue;
        const F = { o: [s.x, y, s.z], right: [-s.dz, 0, s.dx], up: [0, 1, 0], back: [-s.dx, 0, -s.dz] };
        part(F, 0, 0.03, 0, 2 * s.half, 0.05, 0.45, [0.12, 0.12, 0.13], 'rubber');
        for (let x = -s.half + 0.2; x < s.half; x += 0.45) part(F, x, 0.08, 0, 0.05, 0.1, 0.05, [0.75, 0.77, 0.8], 'metal');
        for (const side of [-1, 1]) part(F, side * (s.half + 0.5), 0.3, 0, 0.3, 0.6, 0.3, [1, 0.45, 0.05], 'paint'); // cones at its ends
      }
    },

    // The helicopter (police.js): body, tail, skids and a turning rotor; and the
    // pool of its searchlight on the ground around `spot` ({ x, z }) when it has one.
    heli(h, eye, t) {
      if (!h || far(h, eye, 900)) return;
      const tilt = Math.min(0.25, h.v / 220);
      const up = [h.dx * tilt, Math.sqrt(1 - tilt * tilt), h.dz * tilt], back = [-h.dx * up[1], tilt, -h.dz * up[1]];
      const F = { o: [h.x, h.y, h.z], right: [-h.dz, 0, h.dx], up, back };
      part(F, 0, 0, 0, 1.7, 1.6, 3.4, POLICE_WHITE, 'paint');
      part(F, 0, 0.15, -1.0, 1.72, 0.9, 1.5, CAR_GLASS, 'glass');
      part(F, 0, -0.3, 0.4, 1.74, 0.35, 2.4, POLICE_BLUE, 'paint');
      part(F, 0, 0.35, 3.6, 0.3, 0.32, 4.2, POLICE_WHITE, 'paint');
      part(F, 0, 0.9, 5.5, 0.08, 1.2, 0.6, POLICE_BLUE, 'paint');
      for (const side of [-1, 1]) part(F, side * 0.9, -1.15, 0, 0.09, 0.09, 3.0, POLICE_DARK, 'metal');
      part(F, 0, 0.95, 0, 0.2, 0.35, 0.2, POLICE_DARK, 'metal');
      const a = t * 38, c = Math.cos(a), s = Math.sin(a);
      const R = { o: F.o, right: [0, 1, 2].map((i) => F.right[i] * c + F.back[i] * s), up, back: [0, 1, 2].map((i) => -F.right[i] * s + F.back[i] * c) };
      part(R, 0, 1.15, 0, 10.5, 0.04, 0.3, POLICE_DARK, 'matte');
      part(R, 0, 1.15, 0, 0.3, 0.04, 10.5, POLICE_DARK, 'matte');
      const flash = Math.floor(t * 3) % 2 === 0;
      part(F, 0, -0.85, 0.5, 0.2, 0.12, 0.2, flash ? [1, 0.1, 0.08] : [0.3, 0.03, 0.03], 'lamp');
    },

    // The searchlight's pool on the ground: with blending on, depth writes off.
    spot(h, at, y) {
      if (!h?.sees) return;
      draw(quad, basis([at.x, y, at.z], [1, 0, 0], [0, 1, 0], [0, 0, 1], 11, 1, 11), [1, 0.97, 0.8], 'shadow', 0.22);
    },

    // People (pedestrians.js): torso, head, and legs and arms that swing as they walk.
    people(people, y, eye) {
      for (const p of people) {
        if (far(p, eye, PEOPLE_DRAW)) continue;
        const k = p.size, F = { o: [p.x, y, p.z], right: [-p.dz, 0, p.dx], up: [0, 1, 0], back: [-p.dx, 0, -p.dz] };
        const swing = Math.sin(p.step) * 0.55 * Math.min(1.4, p.moving), bob = Math.abs(Math.cos(p.step)) * 0.03 * Math.min(1, p.moving);
        part(F, 0, (1.14 + bob) * k, 0, 0.42 * k, 0.6 * k, 0.24 * k, p.shirt, 'matte');
        part(F, 0, (1.58 + bob) * k, 0, 0.21 * k, 0.24 * k, 0.22 * k, p.skin, 'matte');
        if (far(p, eye, 80)) { part(F, 0, 0.43 * k, 0, 0.32 * k, 0.86 * k, 0.2 * k, p.pants, 'matte'); continue; }
        // A limb hangs from its joint at height `top`, swung by angle a about the body's right axis.
        const limb = (x, top, len, w, a, color) => {
          const c = Math.cos(a), s = Math.sin(a);
          const up = [-F.back[0] * s, c, -F.back[2] * s], back = [F.back[0] * c, s, F.back[2] * c];
          const o = [F.o[0] + F.right[0] * x - up[0] * len / 2, y + top - up[1] * len / 2, F.o[2] + F.right[2] * x - up[2] * len / 2];
          draw(box, basis(o, F.right, up, back, w, len, w * 1.15), color, 'matte');
        };
        for (const side of [-1, 1]) {
          limb(side * 0.11 * k, (0.86 + bob) * k, 0.86 * k, 0.15 * k, side * swing, p.pants);
          limb(side * 0.27 * k, (1.42 + bob) * k, 0.58 * k, 0.1 * k, -side * swing * 0.8 + (p.flee > 0 ? 2.6 : 0), p.shirt);
        }
      }
    },
  };
}
