"""Builds src/montreal.js: an open map of the island of Montreal, from public data.

  pip install numpy requests pyarrow shapely
  python3 scripts/montreal.py [cache dir]

Everything comes from Overture Maps (release REL below; mostly OpenStreetMap
data, © OpenStreetMap contributors, ODbL), read from its GeoParquet files on
AWS Open Data (s3://overturemaps-us-west-2) with HTTP range requests: only the
row groups whose bounding boxes touch the map are downloaded (cached).

- area: the Montreal agglomeration (the island and the small islands around
  it) minus the St. Lawrence, the Rivière des Prairies, the lakes and the
  canals (base/water), plus the street bridges between its shores. The part
  connected to downtown by streets is kept: the island of Montreal, and
  Île Bizard by its bridge. Nuns' Island (motorway bridges only) and the
  bridges to Laval and the South Shore are left out.
- roads: drivable street segments (transportation/segment) inside the area,
  with their class and name. Motorways, their ramps and tunnels are left out.
- buildings: footprints and heights (buildings theme), out to a little past
  the area so the view doesn't end at the shore.
- trees: individually mapped trees (base/land, class tree).
- water: the rivers, lakes and canals around the area, as triangles.

Local meters: x east, z south, from the middle of the agglomeration. The map
is cut in square cells of CHUNK m; roads, buildings and trees are stored by
cell, so the game can unpack and draw only the cells near the car. Packed as
zigzag varints (first point of a line from its cell's middle, then steps),
deflated, base64.
"""
import base64, io, zlib, json, math, os, re, sys, struct, time, concurrent.futures as cf
import numpy as np, requests, shapely
import pyarrow as pa, pyarrow.parquet as pq, pyarrow.compute as pc
from shapely.geometry import LineString, MultiLineString, Polygon, MultiPolygon, Point, box
from shapely.ops import unary_union

CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '.cache', 'montreal')
os.makedirs(CACHE, exist_ok=True)
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'montreal.js')
REL = 'release/2026-10-21.0'
BUCKET = 'https://overturemaps-us-west-2.s3.amazonaws.com'
BBOX = (-74.0, 45.39, -73.46, 45.72)      # lon/lat box of the data downloaded
AGGLO = 'Agglomération de Montréal'       # the map: this, minus the water
HOME = (-73.5685, 45.4615)                # a point in Verdun (Wellington / de l'Église), on the map
UNIT = 0.2                                # m per step in the packed data
CHUNK = 300                               # m: cell size
S = requests.Session()


class RangeFile(io.RawIOBase):
    """Read-only file over HTTP range requests, in 1 MB blocks."""
    BS = 1 << 20

    def __init__(self, url):
        self.url, self.pos, self.blocks = url, 0, {}
        for attempt in range(6):
            try:
                self.size = int(S.head(url, timeout=60).headers['Content-Length'])
                break
            except requests.RequestException:
                if attempt == 5: raise
                time.sleep(2 ** attempt)

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, o, w=0):
        self.pos = o if w == 0 else self.pos + o if w == 1 else self.size + o
        return self.pos

    def block(self, i):
        if i not in self.blocks:
            a = i * self.BS
            for attempt in range(5):
                try:
                    r = S.get(self.url, headers={'Range': f'bytes={a}-{min(self.size, a + self.BS) - 1}'}, timeout=60)
                    r.raise_for_status()
                    break
                except requests.RequestException:
                    if attempt == 4: raise
                    time.sleep(2 ** attempt)
            self.blocks[i] = r.content
        return self.blocks[i]

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0: return 0
        out = bytearray()
        while len(out) < n:
            p = self.pos + len(out)
            out += self.block(p // self.BS)[p % self.BS:p % self.BS + n - len(out)]
        b[:n] = out
        self.pos += n
        return n


def keys(theme):
    out, token = [], None
    while True:
        url = f'{BUCKET}/?list-type=2&prefix={REL}/{theme}/' + (f'&continuation-token={requests.utils.quote(token)}' if token else '')
        x = S.get(url).text
        out += re.findall(r'<Key>([^<]*\.parquet)</Key>', x)
        m = re.search(r'<NextContinuationToken>([^<]*)<', x)
        if not m: return out
        token = m.group(1)


def fetch(theme, name):
    """Rows of an Overture theme whose bbox touches BBOX, cached as parquet."""
    path = os.path.join(CACHE, name + '.parquet')
    if os.path.exists(path): return pq.read_table(path)
    x0, y0, x1, y1 = BBOX

    def one(key):
        f = pq.ParquetFile(io.BufferedReader(RangeFile(f'{BUCKET}/{key}'), 1 << 20))
        md = f.metadata
        names = [md.schema.column(i).path for i in range(md.num_columns)]
        ix = {n: names.index(n) for n in ['bbox.xmin', 'bbox.xmax', 'bbox.ymin', 'bbox.ymax']}
        groups = []
        for r in range(md.num_row_groups):
            g = md.row_group(r)
            st = lambda n: g.column(ix[n]).statistics
            if st('bbox.xmin').min > x1 or st('bbox.xmax').max < x0 or st('bbox.ymin').min > y1 or st('bbox.ymax').max < y0: continue
            groups.append(r)
        if not groups: return None
        t = f.read_row_groups(groups)
        b = t.column('bbox').combine_chunks()
        keep = pc.and_(pc.and_(pc.less_equal(b.field('xmin'), x1), pc.greater_equal(b.field('xmax'), x0)),
                       pc.and_(pc.less_equal(b.field('ymin'), y1), pc.greater_equal(b.field('ymax'), y0)))
        return t.filter(keep)

    with cf.ThreadPoolExecutor(8) as ex:
        parts = [t for t in ex.map(one, keys(theme)) if t is not None and t.num_rows]
    t = pa.concat_tables(parts)
    pq.write_table(t, path)
    print(f'{name}: {t.num_rows} rows')
    return t



rows = lambda t, cols: t.select(cols).to_pylist()
geom = lambda r: shapely.from_wkb(r['geometry'])

# --- the area ---------------------------------------------------------------
divisions = fetch('theme=divisions/type=division_area', 'divisions')
agglo = next(geom(r) for r in rows(divisions, ['names', 'subtype', 'geometry'])
             if r['subtype'] == 'county' and r['names']['primary'] == AGGLO)
CLIP = agglo.bounds
# Local meters around the middle of the agglomeration: x east, z south.
lat0, lon0 = (CLIP[1] + CLIP[3]) / 2, (CLIP[0] + CLIP[2]) / 2
R, rad = 6371008.8, math.pi / 180
k = math.cos(lat0 * rad)


def proj(g):
    return shapely.transform(g, lambda c: np.column_stack([(c[:, 0] - lon0) * rad * R * k, -(c[:, 1] - lat0) * rad * R]))


region = proj(agglo)
water_rows = rows(fetch('theme=base/type=water', 'water'), ['subtype', 'class', 'geometry'])
water = proj(unary_union([g for r in water_rows if r['subtype'] in ('river', 'canal', 'physical', 'water', 'lake')
                          for g in [geom(r)] if g.geom_type in ('Polygon', 'MultiPolygon')]).buffer(0))
print('water', round(water.area / 1e6, 1), 'km²')
# Street bridges: their decks (a little wider and longer than the road) join the
# banks. Only bridges inside the agglomeration (not to Laval or the South Shore).
CLASSES = ['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service', 'pedestrian']
HALF = {'primary': 7, 'secondary': 6.5, 'tertiary': 5.5, 'residential': 4.5, 'unclassified': 4, 'living_street': 3.5, 'service': 2.6, 'pedestrian': 3}
seg_t = fetch('theme=transportation/type=segment', 'segments')
seg_t = seg_t.filter(pc.and_(pc.equal(seg_t.column('subtype'), 'road'), pc.is_in(seg_t.column('class'), pa.array(CLASSES))))
segs = rows(seg_t, ['class', 'subclass', 'names', 'road_flags', 'connectors', 'access_restrictions'])
seg_geoms = proj(shapely.from_wkb(np.array(seg_t.column('geometry').to_pylist(), dtype=object)))
print(f'segments: {len(segs)}')
flagged = lambda r, f: [x['between'] or (0, 1) for x in (r['road_flags'] or []) if f in x['values']]
decks = []
inregion = region.buffer(30)
shapely.prepare(inregion)
for r, g in zip(segs, seg_geoms):
    if r['subclass'] == 'link': continue
    for a, b in flagged(r, 'is_bridge'):
        deck = shapely.ops.substring(g, a, b, normalized=True)
        if not inregion.contains(deck): continue
        decks.append(deck.buffer(HALF[r['class']] + 2.5, cap_style='flat').buffer(3))
print(f'bridge decks: {len(decks)}')
land = region.difference(water).union(unary_union(decks))
home = proj(Point(HOME))
mainland = next(p for p in getattr(land, 'geoms', [land]) if p.contains(home))
# Lakes, ponds and the canals between their bridges stay holes.
area = Polygon(mainland.exterior, [h for h in mainland.interiors if Polygon(h).area > 2000]).simplify(1.0)
if area.geom_type != 'Polygon': area = max(area.geoms, key=lambda p: p.area)
minx, minz, maxx, maxz = area.bounds
print(f'area: {area.area / 1e6:.1f} km², x {minx:.0f}..{maxx:.0f}, z {minz:.0f}..{maxz:.0f}, {len(area.interiors)} holes, '
      f'{len(area.exterior.coords) + sum(len(h.coords) for h in area.interiors)} points')
view = area.buffer(450)  # scenery reaches this far past the edge
shapely.prepare(view)
cell_of = lambda x, z: (math.floor(x / CHUNK), math.floor(z / CHUNK))
U = lambda v: int(round(v / UNIT))
mid = lambda c: (c * CHUNK + CHUNK // 2) * 5  # a cell's middle, in steps (CHUNK / UNIT = 1500)
assert CHUNK / UNIT == 1500


# --- roads ------------------------------------------------------------------
# Service roads are back lanes and parking aisles. Each street segment is cut
# at its connectors, so pieces end at the crossings and share their end points.
# flags: 1 one-way (in the drawn direction), 2 closed to cars (pedestrian
# streets, bus lanes...).
def oneway(r):
    for a in r['access_restrictions'] or []:
        w = a['when'] or {}
        if a['access_type'] == 'denied' and w.get('heading') in ('backward', 'forward') and not a['between'] \
                and not any(w.get(k) for k in ('mode', 'using', 'during', 'recognized', 'vehicle')):
            return w['heading']
    return None


def no_cars(r):
    return any(a['access_type'] == 'denied' and not a['between'] and set((a['when'] or {}).get('mode') or []) & {'motor_vehicle', 'car'}
               and not (a['when'] or {}).get('heading') for a in r['access_restrictions'] or [])


def cut(intervals, gaps):
    """Intervals [a, b] (fractions along a segment) minus the gaps."""
    for g0, g1 in gaps:
        out = []
        for a, b in intervals:
            if g1 <= a or g0 >= b: out.append((a, b)); continue
            if g0 > a: out.append((a, g0))
            if g1 < b: out.append((g1, b))
        intervals = out
    return intervals


inside = area.buffer(-0.5)
shapely.prepare(inside)
pieces = []  # (class, name, flags, head, line)
for r, g in zip(segs, seg_geoms):
    if r['subclass'] in ('link', 'driveway'): continue
    if not inregion.intersects(g): continue
    ats = sorted({0.0, 1.0, *[c['at'] for c in r['connectors'] or []]})
    # Tunnels: keep only the open-air parts.
    spans = cut([(a, b) for a, b in zip(ats, ats[1:]) if b - a > 1e-9], flagged(r, 'is_tunnel'))
    head = oneway(r)
    flags = (1 if head else 0) | (2 if no_cars(r) else 0)
    name = (r['names'] or {}).get('primary') or ''
    for a, b in spans:
        sub = shapely.ops.substring(g, a, b, normalized=True)
        if sub.geom_type == 'LineString': pieces.append((CLASSES.index(r['class']), name, flags, head, sub))
lines = np.array([p[4] for p in pieces], dtype=object)
whole = shapely.contains(inside, lines)
names, roads = [], []
for (c, name, flags, head, sub), ok in zip(pieces, whole):
    line = sub if ok else sub.intersection(inside)
    if line.is_empty: continue
    for piece in getattr(line, 'geoms', [line]):
        if piece.geom_type != 'LineString' or piece.length < 1: continue
        xy = np.round(np.array(piece.simplify(0.3).coords) / UNIT).astype(int)
        if head == 'forward': xy = xy[::-1]  # one-way against the drawing: flip it
        if name not in names: names.append(name)
        roads.append([c, names.index(name), flags, xy])
# By cell (of the middle of their box), so a cell's roads are listed together.
road_cell = [cell_of(*((r[3].min(0) + r[3].max(0)) / 2 * UNIT)) for r in roads]
order = sorted(range(len(roads)), key=lambda i: (road_cell[i][1], road_cell[i][0]))
roads = [roads[i] for i in order]
road_cell = [road_cell[i] for i in order]
print(f'roads: {len(roads)} pieces, {sum(LineString(r[3] * UNIT).length for r in roads) / 1000:.0f} km, '
      f'{sum(r[2] & 1 for r in roads)} one-way, {len(names)} names')

# --- traffic control --------------------------------------------------------
# Crossings: piece ends shared by three or more streets open to cars. Each one
# gets traffic lights if the map has signals at or just before it, or stop
# signs on the approaches that have them (an all-way stop when tagged so).
CAR = {CLASSES.index(c) for c in CLASSES if c not in ('service', 'pedestrian')}
ends = {}
for i, r in enumerate(roads):
    if r[0] not in CAR or r[2] & 2: continue
    ends.setdefault(tuple(r[3][0]), []).append(2 * i)       # start of piece i
    ends.setdefault(tuple(r[3][-1]), []).append(2 * i + 1)  # its end
nodes = {nk: v for nk, v in ends.items() if len(v) >= 3}
GRID = 40
ngrid = {}
for nk in nodes: ngrid.setdefault((math.floor(nk[0] * UNIT / GRID), math.floor(nk[1] * UNIT / GRID)), []).append(nk)
rline = lambda i: LineString(roads[i][3] * UNIT)
infra = rows(fetch('theme=base/type=infrastructure', 'infrastructure'), ['class', 'source_tags', 'geometry'])
tags = lambda r: dict(r['source_tags'] or [])


def near_nodes(p, reach):
    gi, gj = math.floor(p.x / GRID), math.floor(p.y / GRID)
    out = []
    for i in range(gi - 1, gi + 2):
        for j in range(gj - 1, gj + 2):
            for nk in ngrid.get((i, j), []):
                d = math.hypot(nk[0] * UNIT - p.x, nk[1] * UNIT - p.y)
                if d < reach: out.append((d, nk))
    return sorted(out)


def approach(p, reach=30):
    """The crossing approach (piece end) that the point p lies on, if any: the
    nearest crossing within reach along a piece through p."""
    for d, nk in near_nodes(p, reach):
        if d < 2.5: return nk, None  # on the crossing itself
        for e in nodes[nk]:
            if rline(e // 2).distance(p) < 3: return nk, e
    return None


signal_nodes, stops, allway = set(), set(), set()
for r in infra:
    if r['class'] not in ('traffic_signals', 'stop'): continue
    p = proj(geom(r))
    if p.geom_type != 'Point' or not inside.contains(p): continue
    a = approach(p, 30 if r['class'] == 'traffic_signals' else 25)
    if not a: continue
    nk, e = a
    if r['class'] == 'traffic_signals': signal_nodes.add(nk)
    elif tags(r).get('stop') == 'all': allway.add(nk)
    elif e is not None: stops.add(e)
    else:
        # A stop sign on the crossing itself: the minor streets stop.
        top = min(roads[x // 2][0] for x in nodes[nk])
        minor = [x for x in nodes[nk] if roads[x // 2][0] > top]
        stops.update(minor or nodes[nk])
# Divided streets cross in several close nodes: lights spread to the nodes of
# the same crossing (joined by a short piece).
for _ in range(2):
    for nk in list(signal_nodes):
        for e in nodes[nk]:
            i = e // 2
            if rline(i).length > 22 or roads[i][0] not in CAR: continue
            o = tuple(roads[i][3][0]) if e % 2 else tuple(roads[i][3][-1])
            if o in nodes: signal_nodes.add(o)
for nk in allway: stops.update(nodes[nk])
# Each signalised crossing: its main axis (the biggest street through it) and
# a group, shared by close nodes so their lights change together.
sig_list, groups, ggrid = [], {}, {}
for nk in sorted(signal_nodes):
    stops -= set(nodes[nk])
    p = np.array(nk) * UNIT
    gi, gj = math.floor(p[0] / 40), math.floor(p[1] / 40)
    g = next((gid for i in range(gi - 1, gi + 2) for j in range(gj - 1, gj + 2) for q, gid in ggrid.get((i, j), [])
              if np.hypot(*(np.array(q) * UNIT - p)) < 40), len(groups))
    groups.setdefault(g, 0)
    ggrid.setdefault((gi, gj), []).append((nk, g))
    best = min(nodes[nk], key=lambda e: (roads[e // 2][0], -rline(e // 2).length))
    c = roads[best // 2][3]
    v = c[1] - c[0] if best % 2 == 0 else c[-2] - c[-1]
    sig_list.append((int(nk[0]), int(nk[1]), int(round(math.atan2(v[1], v[0]) * 1000)), g))
# Crossings the map has no signs for, the Montreal way: side streets stop
# where they meet a bigger street, and residential crossings are all-way stops.
# Crossings of main streets only are left as they are.
RESIDENTIAL = {CLASSES.index(c) for c in ('residential', 'unclassified', 'living_street')}
guessed = 0
for nk, es in nodes.items():
    if nk in signal_nodes or any(e in stops for e in es): continue
    cls = [roads[e // 2][0] for e in es]
    top = min(cls)
    add = [e for e, c in zip(es, cls) if c > top] or (es if top in RESIDENTIAL else [])
    stops.update(add)
    guessed += bool(add)
print(f'guessed stop signs at {guessed} crossings')
print(f'crossings: {len(nodes)}, with lights: {len(signal_nodes)}, stop approaches: {len(stops)} ({len(allway)} all-way)')

# The edge of the area: a low barrier where it is on land (not a shore), and
# railings along the bridges over the water.
near_water = water.buffer(12)
walls = []
rings = [area.exterior, *area.interiors]
edge = unary_union([LineString(rg.coords) for rg in rings])
edge = unary_union([edge.difference(near_water), edge.intersection(water.buffer(-2))])
for piece in getattr(edge, 'geoms', [edge]):
    if piece.geom_type == 'LineString' and piece.length > 5:
        walls.append(np.round(np.array(piece.coords) / UNIT).astype(int))
print(f'walls: {len(walls)}, {sum(LineString(w * UNIT).length for w in walls) / 1000:.1f} km')

# --- buildings --------------------------------------------------------------
# Heights: the data's when given, else from floors, else by kind (most of the
# city is two- and three-storey brick plexes).
DEFAULT_H = {'outbuilding': 3.2, 'garage': 3, 'garages': 3, 'shed': 2.6, 'house': 7.5, 'detached': 7.5,
             'semidetached_house': 8, 'terrace': 9, 'apartments': 12, 'residential': 9.5, 'church': 16,
             'school': 11, 'commercial': 9, 'retail': 7, 'industrial': 8, 'warehouse': 9}
bt = fetch('theme=buildings/type=building', 'buildings')
bcols = bt.select(['class', 'height', 'num_floors', 'is_underground']).to_pydict()
bg = proj(shapely.from_wkb(np.array(bt.column('geometry').to_pylist(), dtype=object)))
parts, pidx = shapely.get_parts(bg, return_index=True)
keep = (shapely.get_type_id(parts) == 3) & (shapely.area(parts) >= 8)
cen = shapely.centroid(parts)
keep &= shapely.contains_xy(view, shapely.get_x(cen), shapely.get_y(cen))
parts, pidx = parts[keep], pidx[keep]
parts = shapely.simplify(parts, 0.25)
buildings = {}  # cell -> [(height dm, ring steps)]
nb = big = 0
for p, i in zip(parts, pidx):
    if bcols['is_underground'][i] or p.geom_type != 'Polygon' or p.is_empty: continue
    h = bcols['height'][i] or (bcols['num_floors'][i] and bcols['num_floors'][i] * 3.2 + 0.8) or DEFAULT_H.get(bcols['class'][i] or '', 0)
    if not h:
        h = 7.5 + (zlib.crc32(p.wkb) % 5) * 0.9  # unknown: 2-3 storeys
    tol = 0.5
    while len(p.exterior.coords) > 201 and tol < 8:
        p = p.simplify(tol); tol *= 2
    ring = np.round(np.array(p.exterior.coords)[:-1] / UNIT).astype(int)
    if len(ring) < 3 or len(ring) > 200: continue
    lo, hi = ring.min(0) * UNIT, ring.max(0) * UNIT
    if (hi - lo).max() > CHUNK * 2: big += 1
    buildings.setdefault(cell_of(*((lo + hi) / 2)), []).append((int(round(min(h, 250) * 10)), ring))
    nb += 1
print(f'buildings: {nb} ({big} over {2 * CHUNK} m across)')

# --- trees ------------------------------------------------------------------
tt = fetch('theme=base/type=land', 'land')
tt = tt.filter(pc.equal(tt.column('class'), 'tree'))
tg = proj(shapely.from_wkb(np.array(tt.column('geometry').to_pylist(), dtype=object)))
tg = tg[shapely.get_type_id(tg) == 0]
tx, tz = shapely.get_x(tg), shapely.get_y(tg)
inner = area.buffer(-1)
shapely.prepare(inner)
ok = shapely.contains_xy(inner, tx, tz)
trees = {}
for x, z in zip(tx[ok], tz[ok]): trees.setdefault(cell_of(x, z), []).append((U(x), U(z)))
print(f'trees: {int(ok.sum())}')

# --- water ------------------------------------------------------------------
wview = water.intersection(box(minx - 1500, minz - 1500, maxx + 1500, maxz + 1500)).simplify(1.0)
wtri = []
for p in getattr(wview, 'geoms', [wview]):
    if p.geom_type != 'Polygon': continue
    for t in shapely.constrained_delaunay_triangles(p).geoms:
        wtri += [(round(x), round(z)) for x, z in list(t.exterior.coords)[:3]]  # whole meters
print(f'water: {len(wtri) // 3} triangles')

# --- start: on Rue Wellington, 40 m before Rue de l'Église, facing it -------
def lines_named(n):
    return [LineString(r[3] * UNIT) for r in roads if names[r[1]] == n]
well = shapely.line_merge(unary_union(lines_named('Rue Wellington')))
church = unary_union(lines_named("Rue de l'Église"))
hit = well.intersection(church)
cross = min(getattr(hit, 'geoms', [hit]), key=lambda q: q.distance(home))  # the one in Verdun
line = min(getattr(well, 'geoms', [well]), key=lambda l: l.distance(cross))
s0 = line.project(cross)
# 40 m south of the crossing (Wellington runs about north there), facing it.
p0, p1 = max(([line.interpolate(s0 - 40), line.interpolate(s0 - 39)], [line.interpolate(s0 + 40), line.interpolate(s0 + 39)]), key=lambda c: c[0].y)
start = [round(p0.x, 1), round(p0.y, 1), round(math.atan2(-(p1.x - p0.x), -(p1.y - p0.y)), 3)]
print('start', start)


# --- packing ----------------------------------------------------------------
class Pack:
    def __init__(self): self.b = bytearray()

    def u(self, n):
        assert n >= 0
        while n >= 0x80:
            self.b.append((n & 0x7f) | 0x80); n >>= 7
        self.b.append(n)

    def s(self, n): self.u(2 * n if n >= 0 else -2 * n - 1)

    def line(self, pts, x0=0, z0=0):
        """Points: the first from (x0, z0), then steps."""
        px, pz = x0, z0
        for x, z in pts:
            x, z = int(x), int(z)
            self.s(x - px); self.s(z - pz); px, pz = x, z


cells = sorted(set(road_cell) | set(buildings) | set(trees), key=lambda c: (c[1], c[0]))
road_count = {}
for c in road_cell: road_count[c] = road_count.get(c, 0) + 1
P = {n: Pack() for n in ['cells', 'roads', 'buildings', 'trees', 'area', 'walls', 'water', 'signals', 'stops']}
P['cells'].u(len(cells))
ri = 0
for c in cells:
    x0, z0 = mid(c[0]), mid(c[1])
    bp, tp = Pack(), Pack()
    # Buildings and trees in order, each from the one before (the first from the middle).
    bx, bz = x0, z0
    for h, ring in sorted(buildings.get(c, []), key=lambda b: (int(b[1][0][1]), int(b[1][0][0]))):
        bp.u(len(ring)); bp.u(h); bp.line(ring, bx, bz); bx, bz = int(ring[0][0]), int(ring[0][1])
    tp.line(sorted(trees.get(c, []), key=lambda t: (t[1], t[0])), x0, z0)
    n = road_count.get(c, 0)
    for r in roads[ri:ri + n]:
        P['roads'].u(r[0]); P['roads'].u(r[1]); P['roads'].u(r[2]); P['roads'].u(len(r[3])); P['roads'].line(r[3], x0, z0)
    ri += n
    for v in (c[0], c[1]): P['cells'].s(v)
    for v in (n, len(buildings.get(c, [])), len(bp.b), len(trees.get(c, [])), len(tp.b)): P['cells'].u(v)
    P['buildings'].b += bp.b
    P['trees'].b += tp.b
assert ri == len(roads)
P['area'].u(len(rings))
for rg in rings:
    pts = np.round(np.array(rg.coords)[:-1] / UNIT).astype(int)
    P['area'].u(len(pts)); P['area'].line(pts)
P['walls'].u(len(walls))
for w in walls: P['walls'].u(len(w)); P['walls'].line(w)
P['water'].u(len(wtri)); P['water'].line(wtri)
P['signals'].u(len(sig_list))
px = pz = 0
for x, z, a, g in sig_list:
    P['signals'].s(x - px); P['signals'].s(z - pz); P['signals'].s(a); P['signals'].u(g); px, pz = x, z
P['stops'].u(len(stops))
prev = 0
for e in sorted(stops): P['stops'].u(e - prev); prev = e
raw = bytearray()
for n, p in P.items():
    print(f'  {n}: {len(p.b) / 1e6:.2f} MB')
    raw += p.b
packed = zlib.compress(bytes(raw), 9)
print(f'packed: {len(raw) / 1e6:.1f} MB raw, {len(packed) / 1e6:.1f} MB deflated')

js = f"""// The island of Montreal: an open map from public data. Generated by
// scripts/montreal.py: do not edit by hand.
//
// From Overture Maps {REL.split('/')[1]} (© OpenStreetMap contributors, ODbL, and
// other open sources), meters around {lat0:.5f}° N, {-lon0:.5f}° W: x east, z south.
// `data` is base64 of zlib-deflated zigzag varints, in `sections` of the given
// byte lengths (unpacked by openmap.js, loadOpenMap()). Lengths are in steps of
// `unit` m; lines start from their cell's middle (absolute for area, walls,
// water), then go in steps. Cells are `chunk` m squares.
// - cells: count, then per cell: i, j, roads, buildings, building bytes, trees, tree bytes.
// - roads (in cell order): class index into `classes`, name index into `names`,
//   flags (1 one-way in the drawn direction, 2 closed to cars), point count, points.
//   Pieces end at crossings.
// - buildings: point count, height (dm), points. trees: x, z.
// - area: ring count, then per ring (the shore, then lakes and canals): point count, points.
// - walls: where the area's edge is on land, as area.
// - water: vertex count, then triangles' vertices in whole meters.
// - signals: count, then crossings with traffic lights: x, z (steps from the
//   previous), main axis (mrad), group: lights of a group change together.
// - stops: count, then approaches with a stop sign, as 2 × road index (+ 1
//   for the road's last point), in steps from the previous.
export const MONTREAL = {{
  origin: [{lat0:.6f}, {lon0:.6f}], unit: {UNIT}, chunk: {CHUNK}, start: {json.dumps(start)},
  classes: {json.dumps(CLASSES)},
  sections: {json.dumps({n: len(p.b) for n, p in P.items()})},
  names: {json.dumps(names, ensure_ascii=False)},
  data: "{base64.b64encode(packed).decode()}",
}};
"""
open(OUT, 'w').write(js)
print(f'wrote {OUT}: {len(js) / 1e6:.2f} MB')
