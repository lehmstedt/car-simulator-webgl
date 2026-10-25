# Car Simulator (WebGL)

Barebone car simulator in raw WebGL2 — no frameworks, no build step.
Drive laps of a 1.25 km circuit with two hairpins, through wooded hills under a cloudy sky.
The grass is slippery and slow (about 45 km/h max) but you can drive back on.
Sand traps on the outside of the bends catch cars that run wide: they bog you down fast and you crawl out at about 13 km/h.
Yellow sausage kerbs sit just past the flat kerb on the inside of each tight corner. Cut the apex
over them and the car thumps up and rolls, the wheels that hit skip and lose grip for a moment, and you lose a little speed.
A paddock sits beside the start/finish straight: pit wall, garages, race control and team trucks (scenery only, no collisions).

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
- **Tire temperature**: each axle's tires warm up from how hard they work (cornering,
  braking and driving force, times speed), plus a little from rolling and some more
  from sliding, and cool in the airflow, faster at speed. Grip is best between 80 and
  100 °C and fades gradually outside it: cold tires (they start at 45 °C) give about
  5–10% less grip, and overheated ones lose more the hotter they get (−6% at 120 °C,
  −20% at 150 °C). Brisk laps bring both axles into the window (on the RWD car the
  driven rears run a little warmer); long slides and donuts push them over, and a
  calm straight cools them back. On the FWD car the fronts do the driving, braking
  and steering, so they run hotter and the rears stay cooler.
  The HUD shows a top view of the car with each tire colored blue (cold), green
  (in the window), amber then red (overheated), plus the grip lost.
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

An amber ghost replays Claude's run on the same layout and drivetrain; its time
shows as **Claude** in the HUD. `scripts/autodrive.mjs` drove it with the game's
own physics at 60 fps, using only what a player has (steering wheel, on/off
pedals) and never leaving the road. Re-run it after physics or track changes:
`node scripts/autodrive.mjs circuit both` (or `stage`).

## Cockpit view

Press **C** or the view button to sit in the driver's seat. You look over the
dashboard and hood, between the A-pillars, with a steering wheel that turns with
your input. The view pitches and rolls with the body as weight shifts and glances
a little into the turn. The choice is remembered.

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

On phones, slide the steering slider (bottom-left) left or right to turn — let go and it recenters, and use the brake/gas pedals bottom-right.
With the keyboard, holding A/D turns the wheel gradually; let go and it returns to center.


| Key            | Action          |
| -------------- | --------------- |
| W / ↑          | Throttle        |
| S / ↓          | Brake / reverse |
| A / D, ← / →   | Steer           |
| Space          | Handbrake       |
| T              | Switch FWD/RWD  |
| G              | Toggle ghost    |
| C              | Chase / cockpit view |
| R              | Reset           |

## Layout

- `src/main.js` — setup, render loop, chase and cockpit cameras, lap timing, HUD
- `src/track.js` — circuit spline, road/curb/sand meshes, surface test
- `src/paddock.js` — paddock apron, garages, tower, trucks, parked cars
- `src/trees.js` — low-poly trees, merged into a few meshes
- `src/sky.js` — sky dome with sun and clouds; its horizon color is the distance haze
- `src/car.js` — car physics (dynamic bicycle model, tire grip, FWD/RWD)
- `src/skids.js` — skid marks
- `src/ghost.js` — best-lap recording and ghost replay
- `src/bot-lap.js` — Claude's runs (generated by `scripts/autodrive.mjs`)
- `src/gl.js` — shader/mesh helpers
- `src/geometry.js` — cube, torus (ground grid is drawn in the shader)
- `src/terrain.js` — rolling hills, levelled beside the start straight for the paddock
- `src/math.js` — mat4 helpers
- `src/input.js` — keyboard and touch controls
- `scripts/autodrive.mjs` — self-driving bot that sets Claude's ghost runs
- `scripts/bundle.mjs` — inlines everything into one HTML file
