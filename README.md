# Car Simulator (WebGL)

Barebone car simulator in raw WebGL2 — no frameworks, no build step.
Drive laps of a 1 km circuit; leaving the road onto the grass slows you down hard.

## Run

ES modules need to be served over HTTP:

```sh
npm start            # http://localhost:8080
# or
python3 -m http.server 8080
```

To build a single self-contained page (used for the shareable artifact):

```sh
npm run bundle       # writes dist/car-simulator.html
```

## Controls

On phones, use the on-screen pads: steer bottom-left, brake/gas bottom-right.


| Key            | Action          |
| -------------- | --------------- |
| W / ↑          | Throttle        |
| S / ↓          | Brake / reverse |
| A / D, ← / →   | Steer           |
| Space          | Handbrake       |
| R              | Reset           |

## Layout

- `src/main.js` — setup, render loop, chase camera, lap timing, HUD
- `src/track.js` — circuit spline, road/curb meshes, on-track test
- `src/car.js` — car physics (kinematic bicycle model)
- `src/gl.js` — shader/mesh helpers
- `src/geometry.js` — cube, ground plane (grid is drawn in the shader)
- `src/math.js` — mat4 helpers
- `src/input.js` — keyboard and touch controls
- `scripts/bundle.mjs` — inlines everything into one HTML file
