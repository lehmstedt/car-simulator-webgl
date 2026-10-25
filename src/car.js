// Dynamic bicycle model: one tire per axle, slip-angle lateral forces with a
// grip peak that falls off past it, a friction circle shared between grip and
// drive/brake, and longitudinal weight transfer.
//
// That gives the classic behaviours:
// - Steer too much or too fast: the tires pass their peak and slide (less grip).
// - FWD: throttle in a corner uses up front grip -> understeer (the nose pushes wide).
// - RWD: throttle in a corner uses up rear grip -> oversteer (the tail steps out).
// - Lifting off or braking mid-corner moves weight forward -> the rear goes light.
//
// Elevation (see terrain.js) feeds the same model:
// - Gravity pulls the car back uphill and speeds it up downhill, and sideways on cambers.
// - Grade shifts weight: uphill loads the rear, downhill (worse: braking downhill) loads the front.
// - Crests unload all four tires (less grip at the top), dips press them down (more grip).

const G = 9.81;

// Tire curve (simplified Pacejka) up to its peak near 9 deg of slip, then flat.
// Past the peak the tire loses up to 10% of its grip, but over time (see
// `axle`), so slides build up and settle down smoothly instead of snapping.
const B = 17, C = 1.3;
export const PEAK_SLIP = Math.tan(Math.PI / (2 * C)) / B; // ~0.156 rad
const tireCurve = (alpha) => Math.abs(alpha) < PEAK_SLIP ? Math.sin(C * Math.atan(B * alpha)) : Math.sign(alpha);
// How quickly a tire's grip follows what the road allows (seconds): it lets go
// over ~0.1 s and takes ~0.3 s to bite again.
const GRIP_LOSS_TIME = 0.1, GRIP_GAIN_TIME = 0.3;

// Tire temperature (deg C, one value per axle). Grip is best in a window and
// fades gradually outside it: cold tires feel a little greasy, overheated ones
// go off faster. Most heat comes from the rubber flexing under load: the harder
// a tire is working (cornering, braking, driving) and the faster it rolls, the
// hotter it gets, so both axles warm up in hard driving. Sliding adds some more
// (rubber scrubbing on the road), but not so much that one slide cooks the tires.
// The air cools them, faster at speed.
export const TIRE_TEMP = { ambient: 20, start: 45, optLo: 80, optHi: 100 };
const FLEX_HEAT = 1.1e-5;  // deg C per (N of tire force * m/s rolled)
const ROLL_HEAT = 5e-6;    // deg C per (N of load * m/s): rolling alone, a little
const SLIDE_HEAT = 4e-5;   // deg C per joule scrubbed off sliding
const COOL = 0.006, COOL_SPEED = 0.0008; // per second, plus per (m/s)
// Grip multiplier for a temperature: 1 inside the window, then a loss that
// starts gently (quadratic) and grows linearly further out.
export function tempGrip(t) {
  const { optLo, optHi } = TIRE_TEMP;
  const cold = Math.max(0, optLo - t), hot = Math.max(0, t - optHi);
  const loss = (0.0035 * cold * cold) / (cold + 20) + (0.006 * hot * hot) / (hot + 20);
  return Math.max(0.6, 1 - loss);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Sign that fades to 0 near zero, so forces don't chatter at standstill.
const softSign = (v, eps = 0.3) => clamp(v / eps, -1, 1);

export const VARIANTS = {
  // Front-heavy (60% front), front wheels drive and steer.
  fwd: { label: 'FWD', drive: 'front', cgToFront: 1.04, cgToRear: 1.56, muFront: 1.06, muRear: 1.2 },
  // Near 50/50, rear wheels drive.
  rwd: { label: 'RWD', drive: 'rear', cgToFront: 1.35, cgToRear: 1.25, muFront: 1.0, muRear: 1.16 },
};

// Off the asphalt: grip multiplier, extra linear drag (per second) and rolling
// resistance (m/s^2). Sand traps bog the car down hard: it crawls out at ~10 km/h.
// The stage's gravel is loose: less grip, so the car slides and drifts, but it stays fast.
export const SURFACES = {
  road: { grip: 1, drag: 0, rolling: 0 },
  gravel: { grip: 0.78, drag: 0.02, rolling: 0.3 },
  grass: { grip: 0.75, drag: 0.2, rolling: 0.8 },  // top ~40 km/h
  sand: { grip: 0.6, drag: 0.35, rolling: 1.6 },
};

// Sausage kerbs: a wheel that hits one skips off it, so its axle's tires lose
// grip for a moment and the car is slowed and tugged toward that side. While
// riding on top, that axle has less grip.
const KERB_GRIP = 0.7;      // grip multiplier for an axle on a sausage
const KERB_SPEED = 25;      // m/s at which a hit is at full strength

const STEP = 1 / 240; // fixed physics step; tire forces are stiff

export class Car {
  constructor(variant = 'rwd') {
    this.mass = 1200;          // kg
    this.yawInertia = 2100;    // kg m^2
    this.cgHeight = 0.45;      // m, sets how much weight shifts under accel/brake
    this.maxSteer = 0.6;       // rad at standstill
    this.maxDrive = 5500;      // N at the tires (low speed)
    this.power = 140000;       // W, caps drive force at speed
    this.reverseForce = 4000;  // N
    this.maxReverse = 8;       // m/s
    this.brakeForce = 10000;   // N total
    this.brakeFront = 0.8;     // brake bias
    this.drag = 1.1;           // N per (m/s)^2, top speed ~50 m/s
    this.rolling = 150;        // N
    this.tractionControl = 0.85; // drive never uses more than this share of axle grip
    this.pedalRate = 3;        // pedals reach full travel in ~1/3 s
    this.setVariant(variant);
    this.reset();
  }

  setVariant(name) {
    this.variant = name;
    Object.assign(this, VARIANTS[name]);
    this.wheelBase = this.cgToFront + this.cgToRear;
  }

  reset(x = 0, z = 0, heading = 0) {
    this.x = x;
    this.z = z;
    this.heading = heading; // yaw, 0 = facing -Z, positive turns left
    this.vx = 0;            // m/s forward (body frame)
    this.vy = 0;            // m/s to the left (body frame)
    this.yawRate = 0;       // rad/s
    this.steer = 0;         // road wheel angle (rad)
    this.throttle = 0;      // smoothed pedals, 0..1
    this.brake = 0;
    this.accel = 0;         // filtered longitudinal accel, drives weight transfer
    this.slipFront = 0;     // slip angles (rad), for HUD / visuals
    this.slipRear = 0;
    this.ground = { gx: 0, gz: 0, hxx: 0, hxz: 0, hzz: 0 }; // terrain under the car
    this.grade = 0;         // rise per meter driven forward (+ = uphill)
    this.loadFront = this.loadRear = 0; // N, for the HUD
    this.frontSliding = false;
    this.rearSliding = false;
    this.balance = null;    // 'under' | 'over' | null
    // Per-axle tire state: share of peak cornering grip on hand right now,
    // whether it is sliding, and how much of its grip it is using (0..1+).
    // `temp` is the tire temperature (deg C); `heat` how fast it is changing (deg C/s).
    const tire = () => ({ grip: 1, sliding: false, use: 0, temp: TIRE_TEMP.start, heat: 0 });
    this.tires = { front: tire(), rear: tire() };
    this.gLong = this.gLat = 0; // tire acceleration in g (forward, left), smoothed
    this.gripLimit = 1;     // what the tires can give in total, in g
    this.onKerb = { front: false, rear: false };
    this._felt = null;
    this._sinceUnder = this._sinceOver = 1;
  }

  get speed() { return this.vx; }

  // Wheels on a sausage kerb right now, as [{ front, side, hit }]: side is -1
  // left / +1 right, `hit` marks a wheel that just climbed onto one.
  kerbs(wheels) {
    const s = clamp(Math.abs(this.vx) / KERB_SPEED, 0, 1), dir = Math.sign(this.vx);
    this.onKerb = { front: false, rear: false };
    for (const w of wheels) {
      const axle = w.front ? 'front' : 'rear';
      this.onKerb[axle] = true;
      if (!w.hit) continue;
      const tire = this.tires[axle];
      tire.grip = Math.min(tire.grip, 1 - 0.5 * s);
      this.vx -= dir * 0.5 * s;
      this.yawRate -= dir * w.side * 0.12 * s; // that side is held back
    }
  }

  // `surface` is a SURFACES key; `ground` is terrainSample() at the car's position.
  update(dt, c, surface = 'road', ground = null) {
    const surf = SURFACES[surface] ?? SURFACES.road;
    if (ground) this.ground = ground;
    // The wheel input is already gradual (see input.js); map it to road-wheel
    // angle. Lock shrinks only a little with speed, so cranking the wheel at
    // speed still overloads the tires: that's the punishment for rough steering.
    const lock = this.maxSteer / (1 + Math.abs(this.vx) * 0.05);
    this.steer = c.steer * lock;

    // Pedals ramp in (keys are on/off) but release twice as fast.
    const ramp = (cur, want) => cur + clamp(want - cur, -2 * this.pedalRate * dt, this.pedalRate * dt);
    this.throttle = ramp(this.throttle, c.throttle);
    this.brake = ramp(this.brake, c.brake);
    const pedals = { throttle: this.throttle, brake: this.brake, handbrake: c.handbrake };

    let front = { slip: 0 }, rear = front;
    for (let t = dt; t > 1e-6; t -= STEP) [front, rear] = this.step(Math.min(STEP, t), pedals, surf);

    this.slipFront = front.slip;
    this.slipRear = rear.slip;
    this.frontSliding = this.tires.front.sliding;
    this.rearSliding = this.tires.rear.sliding;
    // Smoothed for the G-meter so it reads steadily.
    const k = Math.min(1, dt * 8);
    const felt = this._felt;
    if (felt) {
      this.gLong += (felt.long - this.gLong) * k;
      this.gLat += (felt.lat - this.gLat) * k;
      this.gripLimit += (felt.limit - this.gripLimit) * k;
    }
    this.updateBalance(dt);
  }

  // Forces from one axle's tires, in that axle's wheel frame (x along the wheel).
  // `tire` is that axle's state in this.tires; `h` the time step.
  axle(u, w, load, mu, fxDemand, locked, tire, h) {
    const max = mu * load * tempGrip(tire.temp);
    const slip = Math.atan2(w, Math.max(Math.abs(u), 3));
    const ease = (target) => {
      const tau = target < tire.grip ? GRIP_LOSS_TIME : GRIP_GAIN_TIME;
      tire.grip += (target - tire.grip) * Math.min(1, h / tau);
    };
    if (locked) {
      // Locked wheels just slide: friction opposes the contact patch velocity.
      // Grip drops too, so it comes back gradually once the handbrake is off.
      ease(0.5);
      const v = Math.max(Math.hypot(u, w), 0.5);
      tire.sliding = Math.hypot(u, w) > 1;
      tire.use = 1;
      // All the friction work goes into the rubber: locked wheels heat fast.
      this.heatTire(tire, 0.9 * max * Math.hypot(u, w), 0.9 * max, load, u, h);
      return { fx: -0.9 * max * u / v, fy: -0.9 * max * w / v, slip };
    }
    // Wheelspin or brake lock-up past the limit: drive eases down to 90%.
    let fx = fxDemand;
    const demand = Math.abs(fx) / Math.max(max, 1e-6);
    const spin = clamp((demand - 1) / 0.3, 0, 1);
    if (demand > 1) fx = Math.sign(fx) * max * (1 - 0.1 * spin);
    // Friction circle: whatever grip drive/brake uses is gone from cornering
    // (never below half). Sliding past the peak costs up to 10% more.
    const circle = Math.sqrt(Math.max(0.25, 1 - Math.min(demand, 1) ** 2));
    const past = Math.max(0, Math.abs(slip) / PEAK_SLIP - 1);
    ease(circle * (1 - 0.1 * Math.min(1, past / 3)));
    const fy = -max * tire.grip * tireCurve(slip);
    // Hysteresis so the sliding state (orange wheels, skids) doesn't flicker.
    tire.sliding = spin > 0 || Math.abs(slip) > PEAK_SLIP * (tire.sliding ? 1 : 1.15);
    tire.use = Math.hypot(fx, fy) / Math.max(max, 1e-6);
    // Scrubbing: cornering force times the patch's sideways speed, plus
    // drive/brake force times the wheel's slip (small normally, a lot more
    // when it spins).
    const slipSpeed = Math.abs(u) * 0.03 * Math.min(demand, 1) + spin * 4;
    this.heatTire(tire, Math.abs(fy * w) + Math.abs(fx) * slipSpeed, Math.hypot(fx, fy), load, u, h);
    return { fx, fy, slip };
  }

  // `scrub`: power lost sliding (W); `force`: total tire force (N).
  heatTire(tire, scrub, force, load, u, h) {
    const speed = Math.abs(u);
    const gain = (FLEX_HEAT * force + ROLL_HEAT * load) * speed + SLIDE_HEAT * scrub;
    const loss = (tire.temp - TIRE_TEMP.ambient) * (COOL + COOL_SPEED * speed);
    tire.heat = gain - loss;
    tire.temp += tire.heat * h;
  }

  step(h, c, surf) {
    const m = this.mass, a = this.cgToFront, b = this.cgToRear, L = this.wheelBase;
    const { vx, vy, yawRate: r } = this;

    // Slope under the car, in the body frame. forward = (-sin, -cos), left = (-cos, sin).
    const g = this.ground;
    const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    const pitch = -(g.gx * sh + g.gz * ch); // rise per meter forward
    const bank = -g.gx * ch + g.gz * sh;    // rise per meter to the left
    const sinPitch = pitch / Math.hypot(1, pitch), sinBank = bank / Math.hypot(1, bank);
    this.grade = pitch;

    // Total load: the share of gravity pressing into the slope, plus the push from
    // following the road's vertical curvature (v^2 * h''): crests go light, dips heavy.
    const wx = -sh * vx - ch * vy, wz = -ch * vx + sh * vy; // world velocity
    const bump = g.hxx * wx * wx + 2 * g.hxz * wx * wz + g.hzz * wz * wz;
    const normal = m * G * clamp(1 / Math.hypot(1, pitch, bank) + bump / G, 0.15, 2.5);

    // Weight transfer: whatever the tires push the car along with (accelerating,
    // or holding it against gravity uphill) loads the rear; braking and going
    // downhill load the front.
    const transfer = (m * (this.accel + G * sinPitch) * this.cgHeight) / L;
    const minLoad = 0.05 * m * G;
    const loadF = Math.max(minLoad, (normal * b) / L - transfer);
    const loadR = Math.max(minLoad, (normal * a) / L + transfer);
    this.loadFront = loadF;
    this.loadRear = loadR;
    const grip = surf.grip;

    // Drive and brake demand.
    let drive = 0, brake = 0;
    if (c.throttle) drive += c.throttle * Math.min(this.maxDrive, this.power / Math.max(Math.abs(vx), 1));
    if (c.brake) {
      if (vx > 0.5) brake = c.brake * this.brakeForce;
      else if (vx > -this.maxReverse) drive -= c.brake * this.reverseForce;
    }

    // Contact patch velocities (front is rotated by the steering angle).
    const cs = Math.cos(this.steer), sn = Math.sin(this.steer);
    const vyF = vy + a * r, vyR = vy - b * r;
    const uF = vx * cs + vyF * sn, wF = -vx * sn + vyF * cs;

    const fwd = this.drive === 'front';
    // Light traction control: forward drive is capped below the driven axle's
    // grip, so full throttle unsettles the car but leaves some grip for cornering.
    if (drive > 0) {
      const driven = fwd ? this.muFront * loadF * tempGrip(this.tires.front.temp) : this.muRear * loadR * tempGrip(this.tires.rear.temp);
      drive = Math.min(drive, this.tractionControl * driven * grip);
    }
    const demandF = (fwd ? drive : 0) - brake * this.brakeFront * softSign(uF);
    const demandR = (fwd ? 0 : drive) - brake * (1 - this.brakeFront) * softSign(vx);
    const kF = this.onKerb.front ? KERB_GRIP : 1, kR = this.onKerb.rear ? KERB_GRIP : 1;
    const front = this.axle(uF, wF, loadF, this.muFront * grip * kF, demandF, false, this.tires.front, h);
    const rear = this.axle(vx, vyR, loadR, this.muRear * grip * kR, demandR, !!c.handbrake, this.tires.rear, h);

    // Into the body frame.
    const fxF = front.fx * cs - front.fy * sn;
    const fyF = front.fx * sn + front.fy * cs;
    let fx = fxF + rear.fx - m * G * sinPitch;
    const fy = fyF + rear.fy - m * G * sinBank;
    // What the driver feels: tire forces only, in g (smoothed in update()).
    this._felt = {
      long: (fxF + rear.fx) / (m * G),
      lat: (fyF + rear.fy) / (m * G),
      limit: ((this.muFront * loadF * tempGrip(this.tires.front.temp) + this.muRear * loadR * tempGrip(this.tires.rear.temp)) * grip) / (m * G),
    };

    // Resistance.
    fx -= this.drag * vx * Math.abs(vx);
    fx -= this.rolling * softSign(vx);
    fx -= m * (surf.drag * vx + surf.rolling * softSign(vx));

    // Rigid body in a rotating frame.
    this.vx += (fx / m + r * vy) * h;
    this.vy += (fy / m - r * vx) * h;
    this.yawRate += ((a * fyF - b * rear.fy) / this.yawInertia) * h;
    this.accel += (fx / m - this.accel) * Math.min(1, h * 6); // springs: weight shifts over ~0.15 s

    // Let the car come to rest instead of creeping, unless the slope is steep
    // enough to roll it (the handbrake holds it on any hill).
    const slow = (lim) => Math.abs(this.vx) < lim && Math.abs(this.vy) < lim;
    const rests = c.handbrake ? slow(0.3) : m * G * Math.abs(sinPitch) <= this.rolling && slow(0.05);
    if (rests && !c.throttle && !c.brake) {
      this.vx = this.vy = 0;
      if (Math.abs(this.yawRate) < 0.05) this.yawRate = 0;
    }

    this.heading += this.yawRate * h;
    const s = Math.sin(this.heading), co = Math.cos(this.heading);
    // forward = (-sin, -cos), left = (-cos, sin)
    this.x += (-s * this.vx - co * this.vy) * h;
    this.z += (-co * this.vx + s * this.vy) * h;
    return [front, rear];
  }

  // Which end lets go first, held briefly so the HUD label doesn't flicker.
  updateBalance(dt) {
    const fast = Math.hypot(this.vx, this.vy) > 4;
    const f = Math.abs(this.slipFront), r = Math.abs(this.slipRear);
    const over = fast && this.rearSliding && r > f * 0.8;
    const under = fast && this.frontSliding && !over && f > r * 1.2;
    this._sinceOver = over ? 0 : this._sinceOver + dt;
    this._sinceUnder = under ? 0 : this._sinceUnder + dt;
    this.balance = this._sinceOver < 0.25 ? 'over' : this._sinceUnder < 0.25 ? 'under' : null;
  }
}
