// Very simple kinematic bicycle model. Good enough to drive around;
// we'll swap in proper tire forces later.

export class Car {
  constructor() {
    this.wheelBase = 2.6;     // m
    this.maxSteer = 0.6;      // rad
    this.engineAccel = 8;     // m/s^2 at full throttle
    this.brakeDecel = 15;     // m/s^2
    this.reverseAccel = 4;    // m/s^2
    this.maxSpeed = 50;       // m/s
    this.maxReverse = 8;      // m/s
    this.drag = 0.4;          // per second (linear)
    this.rolling = 1.0;       // m/s^2
    this.reset();
  }

  reset() {
    this.x = 0;
    this.z = 0;
    this.heading = 0;   // yaw, 0 = facing -Z
    this.speed = 0;     // m/s, signed along heading
    this.steer = 0;     // current steering angle (rad)
  }

  update(dt, c) {
    // Smooth steering toward target, less lock at high speed.
    const lock = this.maxSteer / (1 + Math.abs(this.speed) * 0.05);
    const target = c.steer * lock;
    this.steer += (target - this.steer) * Math.min(1, dt * 8);

    let a = 0;
    if (c.throttle) a += this.engineAccel;
    if (c.brake) a -= this.speed > 0.5 ? this.brakeDecel : this.reverseAccel;
    if (c.handbrake) a -= Math.sign(this.speed) * this.brakeDecel;
    a -= this.speed * this.drag;
    if (!c.throttle && !c.brake) a -= Math.sign(this.speed) * this.rolling;

    const prev = this.speed;
    this.speed += a * dt;
    // Don't let rolling resistance/handbrake flip direction on its own.
    if (!c.throttle && !c.brake && Math.sign(prev) !== Math.sign(this.speed)) this.speed = 0;
    this.speed = Math.max(-this.maxReverse, Math.min(this.maxSpeed, this.speed));

    // Bicycle model: yaw rate = v / L * tan(steer).
    this.heading += (this.speed / this.wheelBase) * Math.tan(this.steer) * dt;
    this.x -= Math.sin(this.heading) * this.speed * dt;
    this.z -= Math.cos(this.heading) * this.speed * dt;
  }
}
