# Builds src/downtown-data.js from open data fetched by fetch_overture.py and
# fetch_dem.py: a street circuit through downtown Montreal along real streets,
# the other streets around it, building footprints with heights, parks and the
# ground's elevation (Mount Royal included).
#
#   python3 build.py data/ ../../src/downtown-data.js
#
# Coordinates: meters, x east, z south, origin near the middle of the circuit.
import sys, math, json, heapq, hashlib
from collections import defaultdict
import pyarrow.parquet as pq
import shapely, shapely.ops, shapely.affinity
from shapely.geometry import LineString, Polygon, Point, box

DATA, OUT = sys.argv[1].rstrip('/'), sys.argv[2]
LON0, LAT0 = -73.575, 45.5
KX, KZ = math.cos(math.radians(LAT0)) * 111320, 110574


def P(lon, lat):
    return ((lon - LON0) * KX, -(lat - LAT0) * KZ)


# The lap, clockwise from Rue Guy: Sherbrooke to Peel, down Peel, Sainte-Catherine
# back to Crescent, down Crescent, René-Lévesque to Guy, up Guy.
LOOP = ['Rue Sherbrooke Ouest', 'Rue Peel', 'Rue Sainte-Catherine Ouest', 'Rue Crescent',
        'Boulevard René-Lévesque Ouest', 'Rue Guy']
FILLET = 15        # m: centerline radius of the corners
HALF_WIDTH = 6.5   # m: keep in sync with LAYOUTS.downtown in track.js
CLEAR = 9          # m from the centerline kept free of buildings
MARGIN = 420       # m of city kept around the circuit
DRIVE = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'unknown'}
STREET_HALF = {'motorway': 8, 'trunk': 7, 'primary': 7, 'secondary': 6, 'tertiary': 5}

# --- Road graph: Overture segments split at their connectors.
edges = []
for r in pq.read_table(f'{DATA}/segments.parquet').to_pylist():
    if r['subtype'] != 'road' or r['class'] not in DRIVE:
        continue
    flags = json.dumps(r['road_flags'] or []) + json.dumps(r['level_rules'] or [])
    tunnel = 'is_tunnel' in flags or '"value": -' in flags
    g = LineString([P(*c) for c in shapely.from_wkb(r['geometry']).coords])
    name = (r['names'] or {}).get('primary')
    cs = sorted(r['connectors'] or [], key=lambda c: c['at'])
    for c0, c1 in zip(cs, cs[1:]):
        sub = shapely.ops.substring(g, c0['at'], c1['at'], normalized=True)
        if sub.length > 0.01:
            edges.append(dict(a=c0['connector_id'], b=c1['connector_id'], name=name, cls=r['class'], line=sub, tunnel=tunnel))

names_at = defaultdict(set)
for e in edges:
    names_at[e['a']].add(e['name'])
    names_at[e['b']].add(e['name'])


def route(name, starts, goals):
    """Shortest path along one street between two sets of nodes: (points, edge ids)."""
    adj = defaultdict(list)
    for i, e in enumerate(edges):
        if e['name'] == name:
            adj[e['a']].append((e['b'], i, False))
            adj[e['b']].append((e['a'], i, True))
    dist, prev, q = {s: 0 for s in starts}, {}, [(0, s) for s in starts]
    while q:
        d, u = heapq.heappop(q)
        if d > dist[u]:
            continue
        if u in goals:
            pts, used, v = [], [], u
            while v in prev:
                p, i, rev = prev[v]
                c = list(edges[i]['line'].coords)
                pts = (c[::-1] if rev else c)[1:] + pts
                used.append(i)
                v = p
            return [None] + pts, used, v
        for v, i, rev in adj[u]:
            nd = d + edges[i]['line'].length
            if nd < dist.get(v, 1e18):
                dist[v], prev[v] = nd, (u, i, rev)
                heapq.heappush(q, (nd, v))
    raise SystemExit(f'no route along {name}')


corners = []
for a, b in zip(LOOP, LOOP[1:] + LOOP[:1]):
    corners.append({k for k, v in names_at.items() if a in v and b in v})
node_pos = {}
for e in edges:
    node_pos[e['a']] = e['line'].coords[0]
    node_pos[e['b']] = e['line'].coords[-1]

# Street i runs from corner i-1 to corner i.
path, route_edges = [], set()
for i, name in enumerate(LOOP):
    pts, used, start = route(name, corners[i - 1], corners[i])
    pts[0] = node_pos[start]
    route_edges.update(used)
    path += pts[:-1]
ring = LineString(path + path[:1])

# Smooth the small jogs (carriageway changes), then round the corners off with arcs.
line = ring.simplify(2.0)
coords = list(line.coords)[:-1]


def resample(pts, step, closed=True):
    L = LineString(pts + pts[:1]) if closed else LineString(pts)
    n = max(2, round(L.length / step))
    return [L.interpolate(L.length * k / n).coords[0] for k in range(n)]


def unit(v):
    l = math.hypot(*v)
    return (v[0] / l, v[1] / l)


pts = resample(coords, 1.0)
N = len(pts)
# Heading change over +-25 m finds the corners; each gets a fillet.
def heading(i, j):
    return unit((pts[j % N][0] - pts[i % N][0], pts[j % N][1] - pts[i % N][1]))


turn = []
for i in range(N):
    d1, d2 = heading(i - 25, i), heading(i, i + 25)
    turn.append(math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]))
apexes = []
for i in range(N):
    if abs(turn[i]) > math.radians(40) and all(abs(turn[i]) >= abs(turn[(i + k) % N]) for k in range(-20, 21)):
        apexes.append(i)
print('corners at', [round(math.degrees(turn[i])) for i in apexes])

keep = [True] * N
arcs = {}
for i in apexes:
    d1, d2 = heading(i - 30, i), heading(i, i + 30)
    theta = abs(math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]))
    T = FILLET * math.tan(theta / 2)
    c = pts[i]
    p1 = (c[0] - d1[0] * T, c[1] - d1[1] * T)
    side = 1 if d1[0] * d2[1] - d1[1] * d2[0] > 0 else -1
    nrm = (-d1[1] * side, d1[0] * side)
    ctr = (p1[0] + nrm[0] * FILLET, p1[1] + nrm[1] * FILLET)
    a0 = math.atan2(p1[1] - ctr[1], p1[0] - ctr[0])
    n = max(3, int(theta * FILLET / 2))
    arcs[i] = [(ctr[0] + FILLET * math.cos(a0 + side * theta * k / n), ctr[1] + FILLET * math.sin(a0 + side * theta * k / n)) for k in range(n + 1)]
    for k in range(-int(T) - 1, int(T) + 2):
        keep[(i + k) % N] = False
out = []
for i in range(N):
    if i in arcs:
        out += arcs[i]
    elif keep[i]:
        out.append(pts[i])
center = resample(out, 3.0)

# Start the list a third of the way along Sherbrooke, so the line is on a straight.
xs, zs = [p[0] for p in center], [p[1] for p in center]
cx, cz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
guy = corners[-1]
g0 = Point(node_pos[next(iter(guy))])
s0 = min(range(len(center)), key=lambda k: Point(center[k]).distance(g0))
center = center[s0:] + center[:s0]
center = center[90:] + center[:90]
center = [(x - cx, z - cz) for x, z in center]
track = LineString(center + center[:1])
print('lap', round(track.length), 'm,', len(center), 'control points')


def shift(g):
    return shapely.affinity.translate(g, -cx, -cz)


xs, zs = [p[0] for p in center], [p[1] for p in center]
WORLD = box(min(xs) - MARGIN, min(zs) - MARGIN, max(xs) + MARGIN, max(zs) + MARGIN)
corridor = track.buffer(CLEAR)


def flat(coords, nd=1):
    return [round(v, nd) for c in coords for v in c]


# --- Other streets: drawn and drivable, not timed.
streets = []
route_strip = track.buffer(HALF_WIDTH + 0.3)
for i, e in enumerate(edges):
    if i in route_edges or e['tunnel']:
        continue
    g = shift(e['line']).intersection(WORLD)
    if g.is_empty:
        continue
    for part in getattr(g, 'geoms', [g]):
        rest = part.difference(route_strip)
        for seg in getattr(rest, 'geoms', [rest]):
            if seg.is_empty or seg.length < 3:
                continue
            seg = seg.simplify(0.5)
            streets.append({'w': STREET_HALF.get(e['cls'], 4), 'p': flat(seg.coords)})
print(len(streets), 'streets')

# --- Buildings: footprints, roof triangles (indices into the ring) and height.
def default_height(r):
    h = int(hashlib.md5(r['id'].encode()).hexdigest()[:4], 16) / 65535
    if r['num_floors']:
        return r['num_floors'] * 3.4 + 1
    if r['subtype'] in ('residential', None):
        return 9 + 7 * h
    if r['subtype'] == 'outbuilding':
        return 4
    return 12 + 14 * h


buildings = []
for r in pq.read_table(f'{DATA}/buildings.parquet').to_pylist():
    if r['is_underground'] or (r['min_height'] or 0) > 2:
        continue
    g = shapely.from_wkb(r['geometry'])
    for poly in getattr(g, 'geoms', [g]):
        if poly.geom_type != 'Polygon':
            continue
        poly = Polygon([(x - cx, z - cz) for x, z in (P(*c) for c in poly.exterior.coords)])
        if not WORLD.contains(poly.centroid) or poly.intersects(corridor):
            continue
        poly = shapely.geometry.polygon.orient(poly.simplify(0.4), 1.0)
        if not poly.is_valid or poly.area < 12 or poly.geom_type != 'Polygon':
            continue
        ring = list(poly.exterior.coords)[:-1]
        idx = {(round(x, 3), round(y, 3)): k for k, (x, y) in enumerate(ring)}
        tris = []
        for t in shapely.constrained_delaunay_triangles(poly).geoms:
            tris += [idx.get((round(x, 3), round(y, 3)), -1) for x, y in list(t.exterior.coords)[:3]]
        if -1 in tris:
            continue
        h = r['height'] or default_height(r)
        buildings.append({'h': round(min(h, 230), 1), 'p': flat(ring), 't': tris})
print(len(buildings), 'buildings, tallest', max(b['h'] for b in buildings))

# --- Parks and lawns.
GREEN = {('park', 'park'), ('managed', 'grass'), ('horticulture', 'garden'), ('recreation', 'pitch'),
         ('recreation', 'recreation_ground'), ('recreation', 'playground'), ('cemetery', 'cemetery'),
         ('protected', 'nature_reserve'), ('park', 'dog_park'), ('winter_sports', 'nordic')}
polys = []
for r in pq.read_table(f'{DATA}/landuse.parquet').to_pylist():
    if (r['subtype'], r['class']) not in GREEN:
        continue
    g = shapely.from_wkb(r['geometry'])
    for poly in getattr(g, 'geoms', [g]):
        if poly.geom_type != 'Polygon':
            continue
        polys.append(Polygon([P(*c) for c in poly.exterior.coords], [[P(*c) for c in h.coords] for h in poly.interiors]).buffer(0))
green = shapely.affinity.translate(shapely.unary_union(polys), -cx, -cz).intersection(WORLD.buffer(600)).difference(track.buffer(HALF_WIDTH + 1)).simplify(1.0)
park_tris = []
for poly in getattr(green, 'geoms', [green]):
    if poly.geom_type != 'Polygon' or poly.area < 40:
        continue
    for t in shapely.constrained_delaunay_triangles(poly).geoms:
        park_tris += flat(list(t.exterior.coords)[:3])
print(len(park_tris) // 6, 'park triangles')

# --- Ground elevation, rows north to south (z increasing), relative to the circuit.
dem = json.load(open(f'{DATA}/dem.json'))
W, S, E, N_ = dem['bbox']
nx, ny = dem['nx'], dem['ny']
rows = dem['h'][::-1]
x0, z0 = P(W, N_)
x1, z1 = P(E, S)
ground = {'x0': round(x0 - cx, 2), 'z0': round(z0 - cz, 2), 'dx': (x1 - x0) / (nx - 1), 'dz': (z1 - z0) / (ny - 1), 'nx': nx, 'nz': ny}


def dem_at(x, z):
    fx = (x - ground['x0']) / ground['dx']
    fz = (z - ground['z0']) / ground['dz']
    i, j = int(fx), int(fz)
    tx, tz = fx - i, fz - j
    h = lambda a, b: rows[b][a]
    return (h(i, j) * (1 - tx) + h(i + 1, j) * tx) * (1 - tz) + (h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx) * tz


ref = sum(dem_at(x, z) for x, z in center) / len(center)
ground['h'] = [round(v - ref, 1) for row in rows for v in row]
ground['ref'] = round(ref, 1)
print('circuit from', round(min(dem_at(x, z) for x, z in center)), 'to', round(max(dem_at(x, z) for x, z in center)), 'm above sea level')

lon_c, lat_c = LON0 + cx / KX, LAT0 - cz / KZ
data = {
    'origin': [round(lon_c, 6), round(lat_c, 6)],
    'route': flat(center),
    'streets': streets,
    'buildings': buildings,
    'parks': park_tris,
    'ground': ground,
}
with open(OUT, 'w') as f:
    f.write('// Generated by scripts/downtown/build.py from open data: Overture Maps roads,\n'
            '// buildings and land use (OpenStreetMap contributors, ODbL) and AWS Terrain Tiles\n'
            '// elevation (Canadian Digital Elevation Model, Open Government Licence - Canada).\n'
            '// Meters, x east, z south; origin at ' + f'{lat_c:.5f} N, {-lon_c:.5f} W.\n')
    f.write('export const DOWNTOWN = ' + json.dumps(data, separators=(',', ':')) + ';\n')
print('wrote', OUT)
