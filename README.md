# Car Simulator (WebGL)

Barebone car simulator in raw WebGL2 — no frameworks, no build step.
Drive freely from Verdun to downtown Montreal, or lap the Nürburgring Nordschleife through the Eifel forest
(switch in settings or with **M**).
The grass is slippery and slow (about 45 km/h max) but you can drive back on.
Surfaces are textured and catch the light by material (`src/shading.js`): car paint and
windows mirror the sky with a sharp sun highlight, asphalt has a speckle of stones and a soft
sheen toward the horizon, while grass stays matte.

Switch maps with **M** or the Track button (Verdun–Downtown ↔ Nordschleife).

## Nordschleife

The Nürburgring Nordschleife is: the full 20.7 km lap through the Eifel forest,
start/finish at T13, built from public geographic data:

- **Path**: OpenStreetMap relation 38566 "Nürburgring Nordschleife" (© OpenStreetMap contributors, ODbL).
  Its ways also name each corner, and the HUD shows the one you're in (Flugplatz, Fuchsröhre, Karussell…).
- **Elevation**: the Copernicus GLO-30 DEM (30 m, © DLR e.V. / Airbus Defence and Space, provided under
  COPERNICUS by the EU and ESA). The road climbs and falls about 290 m, from ~335 m at Breidscheid to
  ~628 m by T13. Grades run from −18% to +20%, and the crests at Flugplatz and Pflanzgarten are there.
  The ground around it is the same model; near the road it takes the road's height.
- The road is 9 m of asphalt with white edge lines and grass verges, in the woods. There are no kerbs,
  barriers or banking: the Karussell is flat.

`scripts/nordschleife.py` rebuilds `src/nordschleife.js` from those sources. It reads only the parts of
the OSM planet file (AWS Open Data) it needs, using HTTP range requests.

## Verdun–Downtown (open map)

Verdun–Downtown isn't a track: it's Montreal from Verdun up to downtown, to drive around freely. It covers all of
mainland Verdun (between the aqueduct canal and the St. Lawrence), then north through Pointe-Saint-Charles,
across the Lachine Canal into Griffintown and Little Burgundy, and downtown up to about Sherbrooke, from
Atwater to the edge of Old Montreal: about 16 km², 7.8 km from end to end. No laps or timers; the HUD
shows the street you're on and a heading-up minimap. You start on Rue Wellington in Verdun, by Rue de l'Église.
Rue Wellington itself takes you all the way to the canal and downtown.

- **Data**: [Overture Maps](https://overturemaps.org) (release 2026-10-21; mostly OpenStreetMap data,
  © OpenStreetMap contributors, ODbL): the borough boundaries, ~355 km of streets with their names, ~23,000
  building footprints and heights, ~28,000 individually mapped trees, and the river and canals.
- **Streets**: asphalt by road class (main streets wider, back lanes narrow), sidewalks on the bigger ones
  (they drive like road; lawns and yards are grass), and a yellow center line on the main streets.
  Motorways, their ramps and tunnels are left out.
- **Bridges**: the street bridges over the Lachine Canal (Charlevoix, des Seigneurs, Wellington, Mill) and
  the aqueduct canal are drivable, with railings.
- **Buildings**: footprints pushed up to their height (from the data, or the number of floors, or the
  building type), in four brick colors with windows; towers 35 m and up are glass. You can't drive
  through them: hit one and the car stops against it.
- **Edges**: the river and canals, and a low concrete barrier where the map ends on land. Nuns' Island is
  left out (only motorway bridges reach it). The ground is flat, though downtown really climbs ~50 m
  from the canal to Sherbrooke.
- **Streaming**: buildings and trees come in 300 m cells whose meshes are made as the car approaches and
  freed once it's far, so only the nearby part of the city uses memory. The minimap is drawn in cached tiles.

`scripts/verdun.py` rebuilds `src/verdun.js` from Overture's GeoParquet files on AWS Open Data, reading only
the parts that cover the map with HTTP range requests.

## Handling

The car uses tire forces, so rough driving gets punished:

- **Steering** winds on gradually while a key is held. Tap for small corrections;
  holding full lock at speed takes the tires past their grip peak and they slide.
- **Understeer** (front slides, car runs wide) and **oversteer** (rear slides, car
  rotates) are shown in the HUD. Sliding wheels turn orange and leave skid marks.
- **Lifting off or braking mid-corner** shifts weight forward and lightens the rear.
- **Hills**: the Nordschleife climbs and falls with grades up to about 20%.
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
  driven rears run a little warmer). Hot tires shed heat much faster, so they hover
  near the top of the window; only sustained abuse (long slides, donuts) pushes them
  over, to about 110–115 °C, and they recover quickly once you ease off. On the FWD car the fronts do the driving, braking
  and steering, so they run hotter and the rears stay cooler.
  The HUD shows a top view of the car with each tire colored blue (cold), green
  (in the window), amber then red (overheated), plus the grip lost.
- A light traction control stops full throttle from using all the grip of the driven wheels.
- **Three cars**, switched with **T** or the Car button (best laps kept per car):
  - **FWD** — front-heavy, front wheels drive. Throttle in a corner makes it push wide.
  - **RWD** — balanced, rear wheels drive. Throttle in a slow corner kicks the tail out.
  - **GT3** — a Porsche 911 GT3 (992), modeled from published data (see below).

## Porsche 911 GT3 (992)

The physics and the drawn car come from the same numbers (`VARIANTS.gt3` in `src/car.js`;
the body is lofted from them in `src/bodies.js`), so the wheels sit where the tires push,
kerbs and skids line up with them, and the cockpit sits where the driver does.

| | Data used |
| --- | --- |
| Size | 4573 × 1852 × 1279 mm, 2457 mm wheelbase, 1600 / 1553 mm track |
| Weight | 1435 kg (DIN, PDK) + 75 kg driver, ~39 / 61 % front / rear |
| Engine | 4.0 L flat-six behind the rear axle, 375 kW (510 PS), 470 Nm, rear-wheel drive |
| Tires | 255/35 ZR20 front, 315/30 ZR21 rear (Cup 2) |
| Aero | Cd 0.34, 144 kg of downforce at 200 km/h (wing in its track setting) |
| Claimed | 0–100 km/h 3.4 s, 318 km/h |

In the game it does 0–100 km/h in 3.35 s and tops out at 318 km/h, corners at about
1.3 g, and stops from 100 km/h in about 35 m (pedal travel included).

How the rear engine shows up:
- **Traction**: 61% of the weight sits on the driven wheels, so it launches and
  powers out of slow corners with little wheelspin.
- **Steady-state understeer**: the light nose runs out of grip first at a constant throttle.
- **Lift-off and trail-brake oversteer**: tire grip grows less than the load on it
  (load sensitivity, on for this car), so when weight comes off the heavy tail it
  lets go quickly. Lift or brake mid-corner and the car rotates; overdo it and the
  tail swings like a pendulum (high yaw inertia from the engine's overhang).
- **Downforce** grows with speed squared, so fast corners have more grip than slow ones.
- **Stiffer body**: it pitches and rolls less than the other two cars.

## Corner boards

Count-down boards stand at 150, 100 and 50 m before each tight corner, on the
outside of the turn. The arrow shows which way it goes. Corners are found from
the track's curvature, so boards follow any change to the layout.

## Ghost car

Your best lap for each car is replayed as a see-through ghost car, so you
can race it. It starts when you cross the line and is saved in the browser along
with your best time. Toggle it with **G** or the Ghost button.

An amber ghost replays Claude's run on the same layout and car; its time
shows as **Claude** in the HUD. `scripts/autodrive.mjs` drove it with the game's
own physics at 60 fps, using only what a player has (steering wheel, on/off
pedals) and never leaving the road. Re-run it after physics or track changes:
`node scripts/autodrive.mjs ring all` (`both` = FWD and RWD, or name one car).

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
| T              | Switch car (FWD/RWD/GT3) |
| G              | Toggle ghost    |
| C              | Chase / cockpit view |
| M              | Switch map (Verdun–Downtown, Nordschleife) |
| R              | Reset           |

## Layout

- `src/main.js` — setup, render loop, chase and cockpit cameras, lap timing, HUD
- `src/track.js` — road spline, road/kerb/guardrail meshes, surface test
- `src/nordschleife.js` — Nordschleife path, road heights and ground grid (generated)
- `src/trees.js` — low-poly trees, merged into a few meshes
- `src/sky.js` — sky dome with sun and clouds; its horizon color is the distance haze
- `src/car.js` — car physics (dynamic bicycle model, tire grip, FWD/RWD)
- `src/skids.js` — skid marks
- `src/ghost.js` — best-lap recording and ghost replay
- `src/bot-lap.js` — Claude's runs (generated by `scripts/autodrive.mjs`)
- `src/gl.js` — shader/mesh helpers
- `src/geometry.js` — cube, torus (ground grid is drawn in the shader)
- `src/terrain.js` — the ground: the Nordschleife's real terrain, flat for Verdun
- `src/bodies.js` — lofted car bodies (the GT3), built from the physics dimensions
- `src/math.js` — mat4 helpers
- `src/input.js` — keyboard and touch controls
- `scripts/autodrive.mjs` — self-driving bot that sets Claude's ghost runs
- `scripts/nordschleife.py` — builds `src/nordschleife.js` from OpenStreetMap and Copernicus DEM data
- `scripts/bundle.mjs` — inlines everything into one HTML file
