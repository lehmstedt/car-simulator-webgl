"""Builds src/verdun.js: an open map of Montreal from Verdun to downtown, from public data.

  pip install numpy requests pyarrow shapely
  python3 scripts/verdun.py [cache dir]

Everything comes from Overture Maps (release REL below; mostly OpenStreetMap
data, © OpenStreetMap contributors, ODbL), read from its GeoParquet files on
AWS Open Data (s3://overturemaps-us-west-2) with HTTP range requests: only the
row groups whose bounding boxes touch the map are downloaded (cached).

- area: the borough of Verdun, and north of it the parts of Le Sud-Ouest
  (Pointe-Saint-Charles, Griffintown, Little Burgundy) and Ville-Marie
  (downtown, the edge of Old Montreal) inside NORTH, minus the St. Lawrence and the
  canals (base/water), plus the street bridges over them. The part connected
  to Verdun is kept (Nuns' Island is left out: it is only reached by
  motorway bridges).
- roads: drivable street segments (transportation/segment) inside the area,
  with their class and name. Motorways, their ramps and tunnels are left out.
- buildings: footprints and heights (buildings theme), out to a little past
  the area so the view doesn't end at the edge.
- trees: the city's individually mapped trees (base/land, class tree).
- water: the river and canal around the area, as triangles.

Local meters: x east, z south, from the area's center.
"""
import base64, io, json, math, os, re, sys, struct, time, concurrent.futures as cf
import numpy as np, requests, shapely
import pyarrow as pa, pyarrow.parquet as pq, pyarrow.compute as pc
from shapely.geometry import LineString, MultiLineString, Polygon, MultiPolygon, Point, box
from shapely.ops import unary_union

CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '.cache', 'verdun-downtown')
os.makedirs(CACHE, exist_ok=True)
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'verdun.js')
REL = 'release/2026-10-21.0'
BUCKET = 'https://overturemaps-us-west-2.s3.amazonaws.com'
BBOX = (-73.61, 45.425, -73.54, 45.51)    # lon/lat box of the data downloaded
CLIP = (-73.60, 45.428, -73.552, 45.5055) # the map's bounds
NORTH = (-73.588, 45.4655, -73.552, 45.5055) # north of Verdun: Atwater to Old Montreal, up to Sherbrooke
BOROUGHS = ('Le Sud-Ouest', 'Ville-Marie')   # cut to NORTH, plus all of Verdun
HOME = (-73.5685, 45.4615)                # a point in Verdun (Wellington / de l'Église)
UNIT = 0.2                                # m per int16 step in the packed data
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
# Local meters around the middle of CLIP: x east, z south.
lat0, lon0 = (CLIP[1] + CLIP[3]) / 2, (CLIP[0] + CLIP[2]) / 2
R, rad = 6371008.8, math.pi / 180
k = math.cos(lat0 * rad)


def proj(g):
    return shapely.transform(g, lambda c: np.column_stack([(c[:, 0] - lon0) * rad * R * k, -(c[:, 1] - lat0) * rad * R]))


macro = {r['names']['primary']: geom(r) for r in rows(divisions, ['names', 'subtype', 'geometry']) if r['subtype'] == 'macrohood'}
boroughs = proj(unary_union([macro['Verdun'].intersection(box(*CLIP))] + [macro[n].intersection(box(*NORTH)) for n in BOROUGHS]))
water_rows = rows(fetch('theme=base/type=water', 'water'), ['subtype', 'class', 'geometry'])
water = proj(unary_union([g for r in water_rows if r['subtype'] in ('river', 'canal', 'physical', 'water', 'lake')
                          for g in [geom(r)] if g.geom_type in ('Polygon', 'MultiPolygon')]).buffer(0))
# Street bridges: their decks (a little wider and longer than the road) join the banks.
CLASSES = ['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service', 'pedestrian']
HALF = {'primary': 7, 'secondary': 6.5, 'tertiary': 5.5, 'residential': 4.5, 'unclassified': 4, 'living_street': 3.5, 'service': 2.6, 'pedestrian': 3}
segs = rows(fetch('theme=transportation/type=segment', 'segments'), ['subtype', 'class', 'subclass', 'names', 'road_flags', 'geometry'])
flagged = lambda r, f: [x['between'] or (0, 1) for x in (r['road_flags'] or []) if f in x['values']]
decks = []
for r in segs:
    if r['subtype'] != 'road' or r['class'] not in CLASSES or r['subclass'] == 'link': continue
    for a, b in flagged(r, 'is_bridge'):
        deck = shapely.ops.substring(proj(geom(r)), a, b, normalized=True)
        decks.append(deck.buffer(HALF[r['class']] + 2.5, cap_style='flat').buffer(3))
land = boroughs.difference(water).union(unary_union(decks).intersection(boroughs.buffer(30)))
home = proj(Point(HOME))
mainland = next(p for p in getattr(land, 'geoms', [land]) if p.contains(home))
area = Polygon(mainland.exterior).simplify(1.0)  # no holes
minx, minz, maxx, maxz = area.bounds
print(f'area: {area.area / 1e6:.2f} km², x {minx:.0f}..{maxx:.0f}, z {minz:.0f}..{maxz:.0f}')
view = area.buffer(450)  # scenery reaches this far past the edge

# --- roads ------------------------------------------------------------------
# Service roads are back lanes and parking aisles.
names, roads = [], []
inside = area.buffer(-0.5)
for r in segs:
    if r['subtype'] != 'road' or r['class'] not in CLASSES or r['subclass'] in ('link', 'driveway'): continue
    g = geom(r)
    tunnels = [shapely.ops.substring(g, a, b, normalized=True).buffer(1e-6) for a, b in flagged(r, 'is_tunnel')]
    if tunnels: g = g.difference(unary_union(tunnels))  # tunnels: keep only the open-air parts
    line = proj(g).intersection(inside)
    if line.is_empty: continue
    name = (r['names'] or {}).get('primary') or ''
    if name not in names: names.append(name)
    for piece in getattr(line, 'geoms', [line]):
        if piece.geom_type != 'LineString' or piece.length < 2: continue
        c = np.round(np.array(piece.simplify(0.3).coords) / UNIT).astype(int)
        roads.append([CLASSES.index(r['class']), names.index(name), *c.flatten().tolist()])
print(f'roads: {len(roads)} pieces, {sum(LineString(np.array(r[2:]).reshape(-1, 2) * UNIT).length for r in roads) / 1000:.1f} km')

# The edge of the area: a low barrier where it is on land (not the river or
# canal shore), and railings along the bridges over the water.
near_water = water.buffer(12)
walls = []
edge = unary_union([area.exterior.difference(near_water), area.exterior.intersection(water.buffer(-2))])
for piece in getattr(edge, 'geoms', [edge]):
    if piece.geom_type == 'LineString' and piece.length > 5:
        walls.append(np.round(np.array(piece.coords) / UNIT).astype(int).flatten().tolist())


def pack(values, fmt):
    return base64.b64encode(struct.pack('<' + fmt * len(values), *values)).decode()


def q(v):
    v = int(round(v / UNIT))
    assert -32768 <= v <= 32767, v
    return v


# --- buildings --------------------------------------------------------------
# Heights: the data's when given, else from floors, else by kind (Verdun is
# mostly two- and three-storey brick plexes).
DEFAULT_H = {'outbuilding': 3.2, 'garage': 3, 'garages': 3, 'shed': 2.6, 'house': 7.5, 'detached': 7.5,
             'semidetached_house': 8, 'terrace': 9, 'apartments': 12, 'residential': 9.5, 'church': 16,
             'school': 11, 'commercial': 9, 'retail': 7, 'industrial': 8}
blds = rows(fetch('theme=buildings/type=building', 'buildings'), ['class', 'height', 'num_floors', 'is_underground', 'geometry'])
bdata = []
nb = 0
for r in blds:
    if r['is_underground']: continue
    g = proj(geom(r))
    for p in getattr(g, 'geoms', [g]):
        if p.geom_type != 'Polygon' or p.area < 8 or not view.contains(p.centroid): continue
        p = p.simplify(0.25)
        if p.geom_type != 'Polygon' or p.is_empty: continue
        h = r['height'] or (r['num_floors'] and r['num_floors'] * 3.2 + 0.8) or DEFAULT_H.get(r['class'] or '', 0)
        if not h:
            h = 7.5 + (hash(p.wkb) % 5) * 0.9  # unknown: 2-3 storeys
        ring = list(p.exterior.coords)[:-1]
        if len(ring) < 3 or len(ring) > 255: continue
        bdata.append(len(ring))
        bdata.append(int(round(min(h, 150) * 10)))
        for x, z in ring: bdata += [q(x), q(z)]
        nb += 1
print(f'buildings: {nb}')

# --- trees ------------------------------------------------------------------
lands = rows(fetch('theme=base/type=land', 'land'), ['subtype', 'class', 'geometry'])
pts = [proj(geom(r)) for r in lands if r['class'] == 'tree']
tdata = []
inner = area.buffer(-1)
for p in pts:
    if p.geom_type == 'Point' and inner.contains(p): tdata += [q(p.x), q(p.y)]
print(f'trees: {len(tdata) // 2}')

# --- water ------------------------------------------------------------------
wview = water.intersection(box(minx - 1500, minz - 1500, maxx + 1500, maxz + 1500)).simplify(1.0)
wtri = []
for p in getattr(wview, 'geoms', [wview]):
    if p.geom_type != 'Polygon': continue
    for t in shapely.constrained_delaunay_triangles(p).geoms:
        c = list(t.exterior.coords)[:3]
        for x, z in c: wtri += [round(x), round(z)]  # whole meters
print(f'water: {len(wtri) // 6} triangles')

# --- start: on Rue Wellington, 40 m before Rue de l'Église, facing it -------
def lines_named(n):
    return [LineString(np.array(r[2:]).reshape(-1, 2) * UNIT) for r in roads if names[r[1]] == n]
well, church = lines_named('Rue Wellington'), unary_union(lines_named("Rue de l'Église"))
line = next(l for l in well if l.length > 60 and Point(l.coords[-1]).distance(church) < 1)
p0 = line.interpolate(line.length - 40)
p1 = line.interpolate(line.length - 39)
start = [round(p0.x, 1), round(p0.y, 1), round(math.atan2(-(p1.x - p0.x), -(p1.y - p0.y)), 3)]
print('start', start)

r1 = lambda v: round(v, 1)
js = f"""// Verdun, Montreal: an open map from public data. Generated by
// scripts/verdun.py: do not edit by hand.
//
// From Overture Maps {REL.split('/')[1]} (© OpenStreetMap contributors, ODbL, and
// other open sources), meters around {lat0:.5f}° N, {-lon0:.5f}° W: x east, z south.
// Lengths in the packed data are int16 steps of `unit` meters.
// - area: the drivable part of the map, outer ring [x, z, ...].
// - names: street names. roads: [class index into `classes`, name index, x, z, x, z, ...].
// - walls: where the area's edge is on land, polylines [x, z, ...].
// - buildings: base64 int16: point count, height (dm), then x, z per point.
// - trees: base64 int16 x, z. water: base64 int16 triangles x, z ×3, in whole meters.
export const VERDUN = {{
  origin: [{lat0:.6f}, {lon0:.6f}], unit: {UNIT}, start: {json.dumps(start)},
  classes: {json.dumps(CLASSES)},
  area: {json.dumps(np.round(np.array(area.exterior.coords[:-1]) / UNIT).astype(int).flatten().tolist())},
  walls: {json.dumps(walls)},
  names: {json.dumps(names, ensure_ascii=False)},
  roads: {json.dumps(roads, separators=(',', ':'))},
  buildings: "{pack(bdata, 'h')}",
  trees: "{pack(tdata, 'h')}",
  water: "{pack(wtri, 'h')}",
}};
"""
open(OUT, 'w').write(js)
print(f'wrote {OUT}: {len(js) / 1e6:.2f} MB')
