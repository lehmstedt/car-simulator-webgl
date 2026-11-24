// The rules of the road on the open map (Montreal), and the player breaking them.
//
// Watched every physics tick, from where the car is (openmap.js locate):
// - Speeding: over the street's limit (by its class) by more than 10 km/h for 2 s.
// - Red light: past the stop line of a crossing with lights while its way is red.
// - Stop sign: past the stop line without slowing to a stop (under 5 km/h) first.
// - Wrong way: against a one-way street, for over a second.
// - Off the road: on the sidewalk or the lawns, for over a second.
// - Crashes into other cars (reported by the collisions, main.js).
// - Scaring people on the sidewalk (they jump out of the way: pedestrians.js).
//
// An offence only counts when someone sees it: witness(kind), set by the game
// (a patrol car in sight, police.js). Unseen, it's as if it never happened, and
// a long one (speeding) counts the moment a patrol car comes into view.
//
// Each offence is worth points toward the wanted level (police.js). The same
// offence counts again only after a while, so one long speeding run isn't
// a dozen of them.

import { signalState } from './traffic.js';

// km/h, by street class (Montreal: 50 on the main streets, 40 or 30 elsewhere).
export const SPEED_LIMIT = { primary: 50, secondary: 50, tertiary: 50, residential: 40, unclassified: 40, living_street: 20, service: 20, pedestrian: 20 };
const TOLERANCE = 10;   // km/h over the limit before it counts

export const OFFENCES = {
  speeding: { points: 1, label: 'Speeding', again: 10 },
  speedingBad: { points: 2, label: 'Excessive speed', again: 10 },
  red: { points: 2, label: 'Ran a red light', again: 3 },
  stop: { points: 1, label: 'Rolled a stop sign', again: 3 },
  wrongWay: { points: 1, label: 'Wrong way on a one-way street', again: 12 },
  offRoad: { points: 1, label: 'Driving on the sidewalk', again: 12 },
  crash: { points: 2, label: 'Hit another car', again: 2 },
  ramPolice: { points: 3, label: 'Rammed a police car', again: 2 },
  pedestrian: { points: 2, label: 'Endangered a pedestrian', again: 4 },
};

export class Rules {
  constructor(map, traffic) {
    this.map = map;
    this.traffic = traffic;
    this.witness = () => true; // whether the police see offence `kind` happen
    this.reset();
  }

  reset() {
    this.limit = null;          // km/h on the current street, for the HUD
    this.timers = { speeding: 0, wrongWay: 0, offRoad: 0 };
    this.last = {};             // offence -> clock when last counted
    this.clock = 0;
    this.approach = null;       // { node, road, dir, minSpeed, d }: the crossing ahead
    this.events = [];           // offences since the last take()
  }

  // An offence happened (unless the same one did a moment ago, or nobody saw it).
  report(kind) {
    const o = OFFENCES[kind];
    if (this.clock - (this.last[kind] ?? -1e9) < o.again) return;
    if (!this.witness(kind)) return;
    this.last[kind] = this.clock;
    this.events.push({ kind, ...o });
  }

  // Offences since the last call.
  take() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // `at`: the map's locate() at the car; `car`: the player's car.
  update(h, car, at) {
    this.clock += h;
    const r = at.road, speed = Math.abs(car.speed), kmh = speed * 3.6;
    const onRoadway = r && at.edge < 0.3;
    this.limit = r && at.edge < r.walk + 2 ? SPEED_LIMIT[r.cls] ?? 50 : this.limit;
    if (!r || at.edge > r.walk + 6) this.limit = null;

    // Speeding.
    const over = this.limit !== null ? kmh - this.limit : 0;
    this.timers.speeding = over > TOLERANCE ? this.timers.speeding + h : 0;
    if (this.timers.speeding > 2) this.report(over > 40 ? 'speedingBad' : 'speeding');

    // Which way the car moves along the street (+1: the way its points run).
    const vx = -Math.sin(car.heading) * car.speed, vz = -Math.cos(car.heading) * car.speed;
    let along = 0, tx = 0, tz = 0;
    if (r && at.tangent) {
      const l = Math.hypot(...at.tangent) || 1;
      tx = at.tangent[0] / l; tz = at.tangent[1] / l;
      along = vx * tx + vz * tz;
    }

    // Wrong way on a one-way street.
    const wrong = onRoadway && r.oneWay && r.cars && along < -3 && car.speed > 1; // backing up doesn't count
    this.timers.wrongWay = wrong ? this.timers.wrongWay + h : 0;
    if (this.timers.wrongWay > 1.2) this.report('wrongWay');

    // On the sidewalk or the grass (the far side of the curb), moving.
    const off = (!r || at.edge > 0.8) && speed > 3;
    this.timers.offRoad = off ? this.timers.offRoad + h : 0;
    if (this.timers.offRoad > 1.2) this.report('offRoad');

    // The crossing ahead: lights or a stop sign at its stop line.
    if (onRoadway && r.a && Math.abs(along) > 0.5) {
      const dir = along > 0 ? 1 : -1, node = dir > 0 ? r.b : r.a;
      const d = Math.hypot(car.x - node.x, car.z - node.z);
      const a = this.approach;
      if (!a || a.node !== node || a.road !== r) {
        this.approach = { node, road: r, dir, minSpeed: speed, d };
      } else {
        if (d < node.r + 20) a.minSpeed = Math.min(a.minSpeed, speed);
        // Crossed the stop line, going in.
        if (node.crossing && a.d > node.r && d <= node.r) this.crossed(a);
        a.d = d;
      }
    } else if (!onRoadway) {
      this.approach = null;
    }
  }

  crossed(a) {
    // What stands there for this way, as the traffic sees it (traffic.js plan()).
    const n = a.node, c = this.traffic.controlAt(a.road, a.dir);
    if (c.control === 'signal') {
      if (signalState(this.traffic.clock, n.signal.offset, c.phase) === 'red') this.report('red');
    } else if (c.control === 'stop' && a.minSpeed > 1.4) {
      this.report('stop');
    }
  }
}
