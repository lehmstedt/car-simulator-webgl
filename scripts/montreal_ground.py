"""Builds src/montreal-ground.js: the ground of the island of Montreal, and its street bridges.

  pip install numpy rasterio pyproj requests pyarrow shapely
  python3 scripts/montreal_ground.py [cache dir]

Heights come from NRCan's Medium Resolution Digital Elevation Model (MRDEM-30,
the bare-earth DTM: no buildings or trees; Natural Resources Canada, Open
Government Licence - Canada), a cloud-optimized GeoTIFF on AWS
(s3://canelevation-dem) read with HTTP range requests: only the tiles over the
map are downloaded. It is resampled to a GRID-meter grid in the map's local
meters (the same as scripts/montreal.py: x east, z south, around ORIGIN).

Over the rivers the DTM gives the water's surface. Packed as heights in
decimeters, each row as steps from the previous row (zigzag varints),
deflated, base64.

The DTM has no bridges: a street over a canal, a river or a sunken road would
dip to the bottom. So the street bridges come too: the bridged stretches of
the street segments (Overture Maps, the release of scripts/montreal.py;
OpenStreetMap's bridge=yes), as lines in local meters (decimeters, zigzag
varints, base64). The game lays a straight deck between their ends.
"""
import base64, json, math, os, sys, zlib
import numpy as np, rasterio, shapely
import pyarrow.compute as pc
from rasterio.windows import from_bounds
from pyproj import Transformer

CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '.cache', 'montreal')
os.makedirs(CACHE, exist_ok=True)
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'montreal-ground.js')
DTM = 'https://canelevation-dem.s3.ca-central-1.amazonaws.com/mrdem-30/mrdem-30-dtm.tif'
# The map's origin (src/montreal.js `origin`), and the box it covers (local m), water around it included.
ORIGIN = (45.551636, -73.735048)
BOX = (-20400, 21810, -18420, 18210)  # x0, x1, z0, z1
GRID = 30  # m

lat0, lon0 = ORIGIN
R, rad = 6371008.8, math.pi / 180
k = math.cos(lat0 * rad)
xs = np.arange(BOX[0], BOX[1] + 1, GRID, dtype=np.float64)
zs = np.arange(BOX[2], BOX[3] + 1, GRID, dtype=np.float64)
X, Z = np.meshgrid(xs, zs)  # rows: z
lon = lon0 + X / (rad * R * k)
lat = lat0 - Z / (rad * R)

os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')
cache = os.path.join(CACHE, 'mrdem-window.npz')
to = Transformer.from_crs('EPSG:4326', 'EPSG:3979', always_xy=True)
E, N = to.transform(lon, lat)
if os.path.exists(cache):
    c = np.load(cache)
    data, left, top, res = c['data'], float(c['left']), float(c['top']), float(c['res'])
else:
    with rasterio.open('/vsicurl/' + DTM) as d:
        win = from_bounds(E.min() - 200, N.min() - 200, E.max() + 200, N.max() + 200, d.transform).round_offsets().round_lengths()
        data = d.read(1, window=win).astype(np.float32)
        data[data == d.nodata] = np.nan
        t = d.window_transform(win)
        left, top, res = t.c, t.f, t.a
    np.savez_compressed(cache, data=data, left=left, top=top, res=res)

# Bilinear, from pixel centers.
u = (E - left) / res - 0.5
v = (top - N) / res - 0.5
i0 = np.clip(np.floor(v).astype(int), 0, data.shape[0] - 2)
j0 = np.clip(np.floor(u).astype(int), 0, data.shape[1] - 2)
fv, fu = v - i0, u - j0
H = (data[i0, j0] * (1 - fu) * (1 - fv) + data[i0, j0 + 1] * fu * (1 - fv)
     + data[i0 + 1, j0] * (1 - fu) * fv + data[i0 + 1, j0 + 1] * fu * fv)
missing = np.isnan(H)
if missing.any():
    print(f'{missing.mean() * 100:.2f}% without data: filled with the lowest height')
    H[missing] = np.nanmin(H)
print(f'grid {H.shape[1]} x {H.shape[0]}, heights {H.min():.1f} to {H.max():.1f} m')

# --- street bridges --------------------------------------------------------
# Overture's reader from scripts/montreal.py (same release and cache), without running the rest of it.
src = open(os.path.join(os.path.dirname(__file__), 'montreal.py')).read()
head = src[:src.index('# --- the area')]
ns = {'__file__': os.path.join(os.path.dirname(__file__), 'montreal.py')}
sys.argv[1:] = [CACHE]
exec(compile(head, 'montreal.py', 'exec'), ns)
CLASSES = ['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service']
seg_t = ns['fetch']('theme=transportation/type=segment', 'segments')
seg_t = seg_t.filter(pc.and_(pc.equal(seg_t.column('subtype'), 'road'), pc.is_in(seg_t.column('class'), pc.cast(CLASSES, 'string'))))
bridges = []
for r in seg_t.select(['class', 'subclass', 'road_flags', 'geometry']).to_pylist():
    if r['subclass'] in ('link', 'driveway'): continue
    spans = [x['between'] or (0, 1) for x in (r['road_flags'] or []) if 'is_bridge' in x['values']]
    if not spans: continue
    g = shapely.from_wkb(r['geometry'])
    for a, b in spans:
        line = shapely.ops.substring(g, a, b, normalized=True)
        if line.geom_type != 'LineString': continue
        c = np.array(line.coords)
        x = (c[:, 0] - lon0) * rad * R * k
        z = -(c[:, 1] - lat0) * rad * R
        if x.max() < BOX[0] or x.min() > BOX[1] or z.max() < BOX[2] or z.min() > BOX[3]: continue
        if np.hypot(np.diff(x), np.diff(z)).sum() < 4: continue
        bridges.append((CLASSES.index(r['class']), np.round(np.column_stack([x, z]) * 10).astype(np.int64)))
print(f'street bridges: {len(bridges)}')


def varint(out, v):
    v = 2 * v if v >= 0 else -2 * v - 1
    while v >= 128:
        out.append((v & 127) | 128); v >>= 7
    out.append(v)


bb = bytearray()
varint(bb, len(bridges))
for c, b in bridges:
    varint(bb, c)
    varint(bb, len(b))
    px = pz = 0
    for x, z in b.tolist():
        varint(bb, x - px); varint(bb, z - pz); px, pz = x, z

dm = np.round(H * 10).astype(np.int64)
steps = np.vstack([dm[:1], np.diff(dm, axis=0)]).ravel()
zig = np.where(steps >= 0, 2 * steps, -2 * steps - 1)
out = bytearray()
for v in zig.tolist():
    while v >= 128:
        out.append((v & 127) | 128); v >>= 7
    out.append(v)
print(f'bridges: {len(bb) / 1e3:.0f} kB')
packed = zlib.compress(bytes(out), 9)
print(f'packed: {len(out) / 1e6:.2f} MB raw, {len(packed) / 1e6:.2f} MB deflated')
with open(OUT, 'w') as f:
    f.write(f'''// The ground of the island of Montreal, and its street bridges. Generated by
// scripts/montreal_ground.py: do not edit by hand.
//
// Heights from NRCan's MRDEM-30 bare-earth DTM (© Natural Resources Canada, Open Government
// Licence - Canada), resampled to a `cell` m grid in the map's local meters (x east, z south,
// as src/montreal.js): `nx` columns from x0, `nz` rows from z0. Over the water, the water's surface.
// `data` is base64 of zlib-deflated zigzag varints: heights in decimeters, each row as steps
// from the row before (the first from 0).
// `bridges`: the street bridges (Overture Maps, © OpenStreetMap contributors, ODbL), base64 of
// zigzag varints: count, then per bridge its street's class (an index in `classes`), point count
// and points (x, z in decimeters, steps).
export const MONTREAL_GROUND = {{
  x0: {BOX[0]}, z0: {BOX[2]}, cell: {GRID}, nx: {H.shape[1]}, nz: {H.shape[0]},
  data: '{base64.b64encode(packed).decode()}',
  classes: {json.dumps(CLASSES)},
  bridges: '{base64.b64encode(bytes(bb)).decode()}',
}};
''')
print('wrote', OUT)
