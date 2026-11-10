import { clamp } from './car.js';

// Engine and tire sounds, synthesized with Web Audio (no sound files).
//
// - Engine: oscillators at the firing frequency (rpm / 60 * cylinders / 2),
//   through a soft clipper and a low-pass that opens with throttle.
//   GT3: 4.0 flat-six, 9000 rpm, with a 7-speed PDK that shifts on its own.
//   Yaris: 1.5 three-cylinder on an e-CVT (rpm follows the pedal more than the
//   speed, and the engine switches off when cruising slowly), plus the
//   electric motor's whine rising with speed.
// - Tires: band-passed noise that squeals as the tires slide or spin, gravel /
//   grass crunch off the road, a rumble over the kerbs, road roar and wind.
//
// Browsers only start audio after a tap or key press, so it starts on the first one.

const ENGINES = {
  gt3: {
    cylinders: 6, idle: 950, redline: 9000,
    // 7-speed PDK gear ratios and final drive.
    gears: [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84], final: 4.16,
    radius: 0.361, gain: 1, bright: 1,
  },
  yaris: { cylinders: 3, idle: 1100, redline: 5500, cvt: true, radius: 0.311, gain: 0.75, bright: 0.6 },
};

const LOOSE = new Set(['gravel', 'dirt', 'grass', 'sand']);

export class Sound {
  constructor() {
    this.ctx = null;
    this.on = true;
    try { this.on = localStorage.getItem('sound') !== 'off'; } catch {}
    this.rpm = 1000;
    this.gear = 0;
    this.shiftCut = 0;  // seconds of ignition cut left during a shift
    this.engineOn = 1;  // hybrid engine running (0..1, smoothed)
    const start = () => this.start();
    for (const e of ['pointerdown', 'keydown', 'touchend']) addEventListener(e, start, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend(); else if (this.on) this.ctx.resume();
    });
  }

  toggle() {
    this.on = !this.on;
    try { localStorage.setItem('sound', this.on ? 'on' : 'off'); } catch {}
    if (!this.ctx) return;
    if (this.on) this.ctx.resume(); else this.ctx.suspend();
  }

  start() {
    if (this.ctx) { if (this.on && this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    const master = this.master = ctx.createGain();
    master.gain.value = 0.6;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);

    // Two seconds of white noise, shared by every noisy sound.
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noiseSrc = () => {
      const s = ctx.createBufferSource();
      s.buffer = noise; s.loop = true;
      s.start(0, Math.random() * 2);
      return s;
    };
    const filter = (type, freq, Q = 1) => {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = Q;
      return f;
    };
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const osc = (type, freq = 100) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.start(); return o; };

    // Engine: firing pulse (sawtooth), a half-order sub for body (the rumble
    // between firings) and a soft clipper for grit.
    const e = this.e = {};
    e.fire = osc('sawtooth');
    e.sub = osc('square');
    e.body = osc('triangle');
    const subGain = gain(0.35), bodyGain = gain(0.6), mix = gain(0.5);
    e.fire.connect(mix);
    e.sub.connect(subGain).connect(mix);
    e.body.connect(bodyGain).connect(mix);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((i / 511.5 - 1) * 2.5);
    shaper.curve = curve;
    e.lp = filter('lowpass', 800, 3);
    e.out = gain(0);
    mix.connect(shaper).connect(e.lp).connect(e.out).connect(master);
    // Intake / exhaust hiss on throttle.
    e.hiss = filter('bandpass', 1200, 1.5);
    e.hissGain = gain(0);
    noiseSrc().connect(e.hiss).connect(e.hissGain).connect(master);
    // Electric motor whine (Yaris).
    e.whine = osc('sine');
    e.whine2 = osc('sine');
    e.whineGain = gain(0);
    e.whine.connect(e.whineGain);
    const w2 = gain(0.4);
    e.whine2.connect(w2).connect(e.whineGain);
    e.whineGain.connect(master);

    // Tire squeal: two resonant bands over noise.
    const t = this.t = {};
    t.band1 = filter('bandpass', 900, 9);
    t.band2 = filter('bandpass', 1800, 12);
    t.squeal = gain(0);
    const sq = noiseSrc();
    sq.connect(t.band1).connect(t.squeal);
    const b2 = gain(0.5);
    sq.connect(t.band2).connect(b2).connect(t.squeal);
    t.squeal.connect(master);
    // Off-road crunch.
    t.crunchLp = filter('lowpass', 500, 0.7);
    t.crunch = gain(0);
    noiseSrc().connect(filter('highpass', 80)).connect(t.crunchLp).connect(t.crunch).connect(master);
    // Road roar and wind.
    t.roar = gain(0);
    noiseSrc().connect(filter('lowpass', 220, 0.8)).connect(t.roar).connect(master);
    t.wind = gain(0);
    t.windBand = filter('bandpass', 500, 0.6);
    noiseSrc().connect(t.windBand).connect(t.wind).connect(master);
    // Kerb rumble: a thump per red/white stripe.
    t.kerbOsc = osc('square', 40);
    t.kerb = gain(0);
    t.kerbOsc.connect(filter('lowpass', 180, 1)).connect(t.kerb).connect(master);

    // Police siren: two detuned square waves, swept by sirens().
    const sr = this.s = {};
    sr.a = osc('square', 700);
    sr.b = osc('square', 703);
    sr.gain = gain(0);
    const sirenLp = filter('lowpass', 2600, 0.7);
    sr.a.connect(sirenLp); sr.b.connect(sirenLp);
    sirenLp.connect(sr.gain).connect(master);
    // Helicopter: low noise chopped by the blades, set by heli().
    const hl = this.h = {};
    hl.gain = gain(0);
    const chop = gain(0.5), lfo = osc('sine', 13), depth = gain(0.5);
    lfo.connect(depth).connect(chop.gain);
    noiseSrc().connect(filter('lowpass', 260, 0.9)).connect(chop).connect(hl.gain).connect(master);
    this.noise = noise;
    this.filter = filter;
    this.gain = gain;

    if (!this.on || document.hidden) ctx.suspend();
  }

  // A crash: a burst of crunching noise and a thump, louder the harder (0..1).
  crash(strength) {
    if (!this.ctx || this.ctx.state !== 'running' || strength <= 0) return;
    const ctx = this.ctx, now = ctx.currentTime, k = Math.min(1, strength);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = this.filter('lowpass', 900 + 2500 * k, 0.8), g = this.gain(0);
    src.connect(lp).connect(g).connect(this.master);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.25 + 0.9 * k, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25 + 0.5 * k);
    src.start(now, Math.random());
    src.stop(now + 0.9);
    const o = ctx.createOscillator(), og = this.gain(0);
    o.type = 'sine';
    o.frequency.setValueAtTime(90, now);
    o.frequency.exponentialRampToValueAtTime(35, now + 0.25);
    o.connect(og).connect(this.master);
    og.gain.setValueAtTime(0.6 * k, now);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    o.start(now);
    o.stop(now + 0.35);
  }

  // A car horn `d` m away: two notes, half a second.
  horn(d = 10) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, now = ctx.currentTime, loud = clamp(1 - d / 120, 0, 1) ** 2 * 0.22;
    if (loud < 0.005) return;
    const g = this.gain(0), lp = this.filter('lowpass', 1800, 0.7), len = 0.35 + Math.random() * 0.4;
    lp.connect(g).connect(this.master);
    for (const f of [392, 494]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f * (0.97 + Math.random() * 0.06);
      o.connect(lp); o.start(now); o.stop(now + len + 0.05);
    }
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(loud, now + 0.02);
    g.gain.setValueAtTime(loud, now + len - 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + len);
  }

  // A tire going flat: a sharp hiss.
  hiss() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, now = ctx.currentTime, src = ctx.createBufferSource(), g = this.gain(0);
    src.buffer = this.noise;
    src.connect(this.filter('highpass', 2500, 0.7)).connect(g).connect(this.master);
    g.gain.setValueAtTime(0.5, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    src.start(now, Math.random()); src.stop(now + 1);
  }

  // The police helicopter `d` m away (Infinity: none).
  heli(d) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const loud = Number.isFinite(d) ? clamp(1 - d / 500, 0, 1) ** 2 : 0;
    this.h.gain.gain.setTargetAtTime(0.5 * loud, this.ctx.currentTime, 0.2);
  }

  // Sirens of the nearest patrol car `d` m away (Infinity: none): a slow wail,
  // a fast yelp when it's close.
  sirens(d) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime, sr = this.s;
    const loud = Number.isFinite(d) ? clamp(1 - d / 400, 0, 1) ** 1.5 : 0;
    const period = d < 70 ? 0.4 : 3.6, u = (now % period) / period;
    const f = d < 70 ? 650 + 700 * (u < 0.5 ? u * 2 : 2 - u * 2) : 650 + 650 * (0.5 - 0.5 * Math.cos(2 * Math.PI * u));
    sr.a.frequency.setTargetAtTime(f, now, 0.01);
    sr.b.frequency.setTargetAtTime(f * 1.004, now, 0.01);
    sr.gain.gain.setTargetAtTime(0.07 * loud, now, 0.05);
  }

  // Engine speed for this car, and the gear it's in (GT3).
  engineRpm(car, dt, eng) {
    const v = Math.abs(car.vx), thr = car.throttle;
    const wheelRpm = (v / (2 * Math.PI * eng.radius)) * 60;
    // Wheelspin of the driven axle revs the engine up.
    const driven = car.drive === 'front' ? car.tires.front : car.tires.rear;
    const spin = thr > 0.1 ? Math.min(driven.scrub, 12) / (2 * Math.PI * eng.radius) * 60 : 0;
    if (eng.cvt) {
      // e-CVT: the engine sits at a speed set by the pedal (and a bit by road speed).
      const target = eng.idle + thr * (eng.redline - eng.idle - 600) + Math.min(v * 12, 600) + spin * 2;
      return { rpm: clamp(target, eng.idle, eng.redline), gear: 0 };
    }
    const g = eng.gears;
    const at = (i) => (wheelRpm + spin) * g[i] * eng.final;
    let gear = clamp(this.gear, 0, g.length - 1);
    if (car.vx < -0.3) gear = 0;
    // Upshift near the redline (earlier when cruising), downshift as revs fall.
    const up = thr > 0.5 ? eng.redline - 300 : 3500 + thr * 4000;
    const down = car.brake > 0.2 ? 6000 : thr > 0.7 ? 5200 : 2000;
    if (gear < g.length - 1 && at(gear) > up) { gear++; this.shiftCut = 0.09; }
    else if (gear > 0 && at(gear) < down && at(gear - 1) < eng.redline - 800) { gear--; this.shiftCut = car.brake > 0.2 ? 0 : 0.06; }
    this.gear = gear;
    // The clutch slips in first, holding the revs up with the pedal until the
    // road speed catches up (~40 km/h at full throttle).
    const launch = gear === 0 ? eng.idle + thr * 3500 : 0;
    return { rpm: clamp(Math.max(at(gear), launch, eng.idle), eng.idle, eng.redline + 150), gear };
  }

  // Call every frame. `surface` is the SURFACES key under the car.
  update(dt, car, surface) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const eng = ENGINES[car.variant] ?? ENGINES.gt3;
    const now = this.ctx.currentTime, tc = 0.03;
    const set = (p, v, k = tc) => p.setTargetAtTime(v, now, k);
    const v = Math.abs(car.vx), thr = car.throttle;

    // Engine.
    const { rpm: target } = this.engineRpm(car, dt, eng);
    // Revs move fast but not instantly (they drop quicker on a shift).
    const rate = target > this.rpm ? 12 : 18;
    this.rpm += (target - this.rpm) * Math.min(1, dt * rate);
    if (this.rpm > eng.redline) this.rpm = eng.redline - 200 * Math.random(); // limiter bounce
    this.shiftCut = Math.max(0, this.shiftCut - dt);
    // The hybrid's engine stops when coasting slowly and idles at rest otherwise.
    const runs = !eng.cvt || thr > 0.08 || v > 18 ? 1 : v < 0.5 ? 1 : 0;
    this.engineOn += (runs - this.engineOn) * Math.min(1, dt * 3);
    const f = (this.rpm / 60) * (eng.cylinders / 2);
    const e = this.e;
    set(e.fire.frequency, f, 0.01);
    set(e.sub.frequency, f / 2, 0.01);
    set(e.body.frequency, f / (eng.cylinders === 3 ? 1.5 : 3), 0.01);
    const load = this.shiftCut > 0 ? 0 : thr;
    const r = (this.rpm - eng.idle) / (eng.redline - eng.idle);
    set(e.lp.frequency, (250 + r * 1500 + load * 2500) * eng.bright);
    set(e.out.gain, eng.gain * this.engineOn * (0.12 + 0.1 * r + 0.25 * load) * (this.shiftCut > 0 ? 0.4 : 1));
    set(e.hiss.frequency, 600 + f * 4);
    set(e.hissGain.gain, eng.gain * this.engineOn * load * (0.02 + 0.05 * r));
    const wf = eng.cvt ? 300 + v * 55 : 0;
    set(e.whine.frequency, Math.max(wf, 1));
    set(e.whine2.frequency, Math.max(wf * 2.5, 1));
    set(e.whineGain.gain, eng.cvt ? clamp(v / 8, 0, 1) * (0.012 + 0.02 * thr) : 0);

    // Tires: the slide of the worst axle, plus a bit of hum near the limit.
    const t = this.t, loose = LOOSE.has(surface);
    const axle = (tire) => clamp((tire.scrub - 0.6) / 6, 0, 1) + clamp((tire.use - 0.92) / 0.2, 0, 0.25) * clamp(v / 15, 0, 1);
    const slide = clamp(Math.max(axle(car.tires.front), axle(car.tires.rear)), 0, 1);
    const moving = clamp(v / 3, 0, 1);
    const squeal = loose ? 0 : slide * moving;
    set(t.squeal.gain, 0.5 * squeal ** 1.3);
    // Pitch rises with how hard they slide, wobbling a little like real rubber.
    const pitch = 700 + 450 * slide + 60 * Math.sin(now * 23);
    set(t.band1.frequency, pitch, 0.05);
    set(t.band2.frequency, pitch * 2.1, 0.05);
    set(t.crunch.gain, loose ? clamp(v / 25, 0, 1) * 0.25 + slide * 0.25 : 0, 0.08);
    set(t.crunchLp.frequency, 300 + v * 15 + slide * 600);
    set(t.roar.gain, loose ? 0 : clamp(v / 70, 0, 1) * 0.18);
    set(t.wind.gain, clamp(v / 85, 0, 1.2) ** 2 * 0.12);
    set(t.windBand.frequency, 300 + v * 8);
    const kerb = car.onKerb.front || car.onKerb.rear;
    set(t.kerbOsc.frequency, Math.max(v / 1.0, 1), 0.01); // stripes ~1 m apart
    set(t.kerb.gain, kerb ? clamp(v / 10, 0, 1) * 0.35 : 0, 0.02);
  }
}
