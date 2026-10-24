// Very simple kinematic bicycle model. Good enough to drive around;
// we'll swap in proper tire forces later.

export class Car {
  constructor() {
    this.wheelBase = 2.6;     // m
    this.maxSteer = 0.6;      // rad
    this.engineAccel = 10;    // m/s^2 at full throttle
    this.brakeDecel = 15;     // m/s^2
    this.reverseAccel = 4;    // m/s^2
    this.maxReverse = 8;      // m/s
    this.aero = 0.004;        // quadratic drag, top speed ~ sqrt(10/0.004) = 50 m/s
    this.rolling = 1.0;       // m/s^2
    this.grassDrag = 0.7;     // extra linear drag per second on grass (top ~36 km/h)
    this.grassRolling = 3.0;  // m/s^2
    this.reset();
  }

  reset(x = 0, z = 0, heading = 0) {
    this.x = x;
    this.z = z;
    this.heading = heading; // yaw, 0 = facing -Z
    this.speed = 0;         // m/s, signed along heading
    this.steer = 0;         // current steering angle (rad)
  }

  update(dt, c, onGrass = false) {
    // The wheel input is already gradual; just map it to road-wheel angle,
    // with less lock at high speed.
    const lock = this.maxSteer / (1 + Math.abs(this.speed) * 0.05);
    this.steer = c.steer * lock;

    const v = this.speed;
    let a = 0;
    if (c.throttle) a += this.engineAccel;
    if (c.brake) a -= v > 0.5 ? this.brakeDecel : this.reverseAccel;
    if (c.handbrake) a -= Math.sign(v) * this.brakeDecel;
    a -= this.aero * v * Math.abs(v);
    const rolling = onGrass ? this.grassRolling : this.rolling;
    if (!c.throttle && !c.brake) a -= Math.sign(v) * rolling;
    if (onGrass) a -= v * this.grassDrag + (c.throttle ? Math.sign(v) * this.grassRolling : 0);

    this.speed += a * dt;
    // Resistance alone must never flip the direction of travel.
    if (!c.throttle && !c.brake && Math.sign(v) !== Math.sign(this.speed)) this.speed = 0;
    this.speed = Math.max(-this.maxReverse, this.speed);

    // Bicycle model: yaw rate = v / L * tan(steer).
    this.heading += (this.speed / this.wheelBase) * Math.tan(this.steer) * dt;
    this.x -= Math.sin(this.heading) * this.speed * dt;
    this.z -= Math.cos(this.heading) * this.speed * dt;
  }
}
