# Car Simulator (WebGL)

Barebone car simulator in raw WebGL2 — no frameworks, no build step.
Drive laps of a 1 km circuit; leaving the road onto the grass slows you down hard.

## Handling

The car uses tire forces, so rough driving gets punished:

- **Steering** winds on gradually while a key is held. Tap for small corrections;
  holding full lock at speed takes the tires past their grip peak and they slide.
- **Understeer** (front slides, car runs wide) and **oversteer** (rear slides, car
  rotates) are shown in the HUD. Sliding wheels turn orange and leave skid marks.
- **Lifting off or braking mid-corner** shifts weight forward and lightens the rear.
- **Two drivetrains**, switched with **T** or the FWD/RWD button (best laps kept per car):
  - **FWD** — front-heavy, front wheels drive. Throttle in a corner makes it push wide.
  - **RWD** — balanced, rear wheels drive. Throttle in a slow corner kicks the tail out.

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
| T              | Switch FWD/RWD  |
| R              | Reset           |

## Layout

- `src/main.js` — setup, render loop, chase camera, lap timing, HUD
- `src/track.js` — circuit spline, road/curb meshes, on-track test
- `src/car.js` — car physics (dynamic bicycle model, tire grip, FWD/RWD)
- `src/skids.js` — skid marks
- `src/gl.js` — shader/mesh helpers
- `src/geometry.js` — cube, ground plane (grid is drawn in the shader)
- `src/math.js` — mat4 helpers
- `src/input.js` — keyboard and touch controls
- `scripts/bundle.mjs` — inlines everything into one HTML file
