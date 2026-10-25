# Car Simulator (WebGL)

Barebone car simulator in raw WebGL2 — no frameworks, no build step.
Drive laps of a 1.25 km circuit with two hairpins; the grass is slippery and slow (about 50 km/h max) but you can drive back on.

## Handling

The car uses tire forces, so rough driving gets punished:

- **Steering** winds on gradually while a key is held. Tap for small corrections;
  holding full lock at speed takes the tires past their grip peak and they slide.
- **Understeer** (front slides, car runs wide) and **oversteer** (rear slides, car
  rotates) are shown in the HUD. Sliding wheels turn orange and leave skid marks.
- **Lifting off or braking mid-corner** shifts weight forward and lightens the rear.
- **Hills**: the circuit rolls over terrain with grades up to about 14%.
  - Gravity slows you uphill, speeds you up downhill and pushes you sideways on cambered bits.
  - Grade moves weight between the axles: uphill loads the rear (good for RWD traction,
    FWD loses front grip), downhill loads the front. Braking downhill makes the rear very light.
  - Crests unload the tires, so there is less grip at the top of a rise taken fast;
    dips press the car down and add grip.
  - The HUD shows the current grade and the weight on each axle (F / R, % of the car's
    weight; it turns blue when the car is going light). The handbrake holds the car on a hill.
- A light traction control stops full throttle from using all the grip of the driven wheels.
- **Two drivetrains**, switched with **T** or the FWD/RWD button (best laps kept per car):
  - **FWD** — front-heavy, front wheels drive. Throttle in a corner makes it push wide.
  - **RWD** — balanced, rear wheels drive. Throttle in a slow corner kicks the tail out.

## Corner boards

Count-down boards stand at 150, 100 and 50 m before each tight corner, on the
outside of the turn. The arrow shows which way it goes. Corners are found from
the track's curvature, so boards follow any change to the layout.

## Ghost car

Your best lap for each drivetrain is replayed as a see-through ghost car, so you
can race it. It starts when you cross the line and is saved in the browser along
with your best time. Toggle it with **G** or the Ghost button.

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

On phones, drag the steering wheel (bottom-left) to turn, and use the brake/gas pedals bottom-right.
With the keyboard, holding A/D turns the wheel gradually; let go and it returns to center.


| Key            | Action          |
| -------------- | --------------- |
| W / ↑          | Throttle        |
| S / ↓          | Brake / reverse |
| A / D, ← / →   | Steer           |
| Space          | Handbrake       |
| T              | Switch FWD/RWD  |
| G              | Toggle ghost    |
| R              | Reset           |

## Layout

- `src/main.js` — setup, render loop, chase camera, lap timing, HUD
- `src/track.js` — circuit spline, road/curb meshes, on-track test
- `src/car.js` — car physics (dynamic bicycle model, tire grip, FWD/RWD)
- `src/skids.js` — skid marks
- `src/ghost.js` — best-lap recording and ghost replay
- `src/gl.js` — shader/mesh helpers
- `src/geometry.js` — cube, ground plane (grid is drawn in the shader)
- `src/math.js` — mat4 helpers
- `src/input.js` — keyboard and touch controls
- `scripts/bundle.mjs` — inlines everything into one HTML file
