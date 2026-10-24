# Car Simulator (WebGL)

Barebone car simulator in raw WebGL2 — no frameworks, no build step.

## Run

ES modules need to be served over HTTP:

```sh
npm start            # http://localhost:8080
# or
python3 -m http.server 8080
```

## Controls

| Key            | Action          |
| -------------- | --------------- |
| W / ↑          | Throttle        |
| S / ↓          | Brake / reverse |
| A / D, ← / →   | Steer           |
| Space          | Handbrake       |
| R              | Reset           |

## Layout

- `src/main.js` — setup, render loop, chase camera, HUD
- `src/car.js` — car physics (kinematic bicycle model)
- `src/gl.js` — shader/mesh helpers
- `src/geometry.js` — cube, ground plane (grid is drawn in the shader)
- `src/math.js` — mat4 helpers
- `src/input.js` — keyboard controls
