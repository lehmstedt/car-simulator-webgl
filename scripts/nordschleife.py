"""Builds src/nordschleife.js: the Nurburgring Nordschleife from public data.

  pip install numpy requests pyorc tifffile imagecodecs
  python3 scripts/nordschleife.py [cache dir]

- Path: OpenStreetMap relation 38566 "Nürburgring Nordschleife" (its ways are
  in driving order), read straight from the weekly planet file on AWS Open Data
  (s3://osm-pds, ORC format) with HTTP range requests: only the pieces holding
  the relation, its ways and their nodes are downloaded (~1 GB, mostly node
  pieces; cached in the cache dir).
- Heights: Copernicus GLO-30 DEM tiles N50 E006 and N50 E007 (s3://copernicus-dem-30m).

The path is smoothed a little (sigma 5 m) and resampled every ~6 m; the road
height is the DEM along it, smoothed over sigma 20 m, which keeps crests such
as Flugplatz and Pflanzgarten. The ground grid is the DEM at 30 m, lightly
blurred. Local meters: x east, z south, from the track's mean lat/lon.
"""
import base64, io, json, math, os, re, sys
import numpy as np, requests

CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '.cache', 'nordschleife')
os.makedirs(CACHE, exist_ok=True)
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'nordschleife.js')
PLANET = 'https://osm-pds.s3.amazonaws.com/planet/planet-latest.orc'
DEM_URL = 'https://copernicus-dem-30m.s3.amazonaws.com/{0}/{0}.tif'
RELATION = 38566
BASE = 300.0  # m: heights are stored above this
S = requests.Session()


class RangeFile(io.RawIOBase):
    """Read-only file over HTTP range requests, in 1 MB blocks."""
    BS = 1 << 20

    def __init__(self, url):
        self.url, self.pos, self.blocks = url, 0, {}
        self.size = int(S.head(url).headers['Content-Length'])

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
            self.blocks[i] = r.content
            if len(self.blocks) > 400: self.blocks.pop(next(iter(self.blocks)))
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


def fetch_osm():
    """Relation, its ways and their nodes from the planet ORC file. Rows are
    sorted by type (node, way, relation) then id, so a binary search over the
    pieces' (stripes') id statistics finds each one."""
    path = os.path.join(CACHE, 'osm.json')
    if os.path.exists(path): return json.load(open(path))
    import pyorc
    f = RangeFile(PLANET)
    order = {'node': 0, 'way': 1, 'relation': 2}
    reader = pyorc.Reader(f, struct_repr=pyorc.StructRepr.DICT)
    n, stats = reader.num_of_stripes, {}

    def stat(i):  # (first type, first id, last type, last id) of stripe i
        if i not in stats:
            s = reader.read_stripe(i)
            ids, types = s[1].statistics, s[2].statistics
            t0, t1 = sorted((order[types['minimum']], order[types['maximum']]))
            stats[i] = (t0, ids['minimum'], t1, ids['maximum']) if t0 == t1 else (t0, 0, t1, stat(i + 1)[1] - 1)
        return stats[i]

    def find(typ, id):
        key, lo, hi = (order[typ], id), 0, n - 1
        while lo < hi:
            m = (lo + hi) // 2
            if stat(m)[2:] < key: lo = m + 1
            else: hi = m
        return lo

    def fetch(typ, ids, columns):
        r = pyorc.Reader(f, column_names=columns, struct_repr=pyorc.StructRepr.DICT)
        groups, out = {}, {}
        for i in sorted(set(ids)): groups.setdefault(find(typ, i), set()).add(i)
        for k, (si, want) in enumerate(sorted(groups.items())):
            for row in r.read_stripe(si):
                if row['type'] == typ and row['id'] in want: out[row['id']] = row
            print(f'{typ}s: piece {k + 1}/{len(groups)}, {f.pos >> 20} MB in', file=sys.stderr)
        return out

    rel = fetch('relation', [RELATION], ('id', 'type', 'tags', 'members'))[RELATION]
    wids = [m['ref'] for m in rel['members'] if m['type'] == 'way']
    ways = fetch('way', wids, ('id', 'type', 'tags', 'nds'))
    nodes = fetch('node', [x['ref'] for w in ways.values() for x in w['nds']], ('id', 'type', 'lat', 'lon'))
    data = {
        'wids': wids,
        'ways': {str(k): {'tags': v['tags'], 'nds': [x['ref'] for x in v['nds']]} for k, v in ways.items()},
        'nodes': {str(k): [float(v['lat']), float(v['lon'])] for k, v in nodes.items()},
    }
    json.dump(data, open(path, 'w'))
    return data


def load_dem():
    import tifffile
    tiles = []
    for lon in (6, 7):
        name = f'Copernicus_DSM_COG_10_N50_00_E{lon:03d}_00_DEM'
        path = os.path.join(CACHE, name + '.tif')
        if not os.path.exists(path):
            open(path, 'wb').write(S.get(DEM_URL.format(name), timeout=300).content)
        tiles.append(tifffile.imread(path))
    # 1 x 1 degree tiles, 3600 rows (lat 51 -> 50) by 2400 columns; pixel centers.
    A = np.hstack(tiles).astype(np.float64)

    def sample(lat, lon):  # bilinear
        r, c = (51 - np.asarray(lat)) * 3600, (np.asarray(lon) - 6) * 2400
        r0, c0 = np.floor(r).astype(int), np.floor(c).astype(int)
        fr, fc = r - r0, c - c0
        top = A[r0, c0] * (1 - fc) + A[r0, c0 + 1] * fc
        bottom = A[r0 + 1, c0] * (1 - fc) + A[r0 + 1, c0 + 1] * fc
        return top * (1 - fr) + bottom * fr
    return sample


def smooth(a, sigma, step):  # Gaussian, wrapping around (closed loop)
    r = int(3 * sigma / step)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) * step / sigma) ** 2)
    return np.convolve(np.concatenate([a[-r:], a, a[:r]]), k / k.sum(), 'valid')


def main():
    osm, dem = fetch_osm(), load_dem()
    ways, nodes = osm['ways'], osm['nodes']
    # Chain the ways in relation order into one closed loop of node ids.
    seq = []
    for wid in osm['wids']:
        nd = ways[str(wid)]['nds']
        if not seq: seq = list(nd); continue
        if len(seq) == len(ways[str(osm['wids'][0])]['nds']) and seq[0] in (nd[0], nd[-1]): seq.reverse()
        if seq[-1] == nd[0]: seq += nd[1:]
        elif seq[-1] == nd[-1]: seq += nd[::-1][1:]
        else: raise SystemExit(f'way {wid} does not join the previous one')
    assert seq[0] == seq[-1], 'not a closed loop'
    ll = np.array([nodes[str(i)] for i in seq])
    lat0, lon0 = ll[:, 0].mean(), ll[:, 1].mean()
    R, k = 6371008.8, math.pi / 180
    P = np.c_[(ll[:, 1] - lon0) * k * R * math.cos(lat0 * k), -(ll[:, 0] - lat0) * k * R]
    to_ll = lambda x, z: (lat0 - z / (k * R), lon0 + x / (k * R * math.cos(lat0 * k)))
    s = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]

    # Where each named way starts (meters along the OSM line).
    first = {}
    for i, nid in enumerate(seq[:-1]): first.setdefault(nid, i)
    sections = []
    for wid in osm['wids']:
        w = ways[str(wid)]
        name = w['tags'].get('name')
        if not name or name == 'Nürburgring Nordschleife': continue
        a, b = first.get(w['nds'][0], 0), first.get(w['nds'][-1], 0)
        sections.append((P[min(a, b) if abs(a - b) < len(seq) / 2 else max(a, b)], name))

    # Smooth path every 1 m, its height from the DEM, then control points every ~6 m from T13.
    ss = np.arange(0, s[-1], 1.0)
    x, z = smooth(np.interp(ss, s, P[:, 0]), 5, 1), smooth(np.interp(ss, s, P[:, 1]), 5, 1)
    h = smooth(dem(*to_ll(x, z)), 20, 1)
    t13 = next(p for p, n in sections if n == 'T13')
    i0 = int(np.argmin(np.hypot(x - t13[0], z - t13[1])))
    x, z, h = np.roll(x, -i0), np.roll(z, -i0), np.roll(h, -i0)
    d = np.r_[0, np.cumsum(np.hypot(np.diff(x), np.diff(z)))]
    length = d[-1] + math.hypot(x[0] - x[-1], z[0] - z[-1])
    n = int(round(length / 6))
    at = np.arange(n) * length / n
    cx, cz, ch = np.interp(at, d, x), np.interp(at, d, z), np.interp(at, d, h)
    named = sorted((float(at[np.argmin(np.hypot(cx - p[0], cz - p[1]))]), name) for p, name in sections)

    # Ground: the DEM on a 30 m grid reaching 900 m past the track, lightly blurred.
    cell, margin = 30.0, 900
    x0, x1 = math.floor((cx.min() - margin) / cell) * cell, math.ceil((cx.max() + margin) / cell) * cell
    z0, z1 = math.floor((cz.min() - margin) / cell) * cell, math.ceil((cz.max() + margin) / cell) * cell
    gx, gz = np.arange(x0, x1 + 1, cell), np.arange(z0, z1 + 1, cell)
    X, Z = np.meshgrid(gx, gz)
    H = dem(*to_ll(X, Z))
    Hp, w = np.pad(H, 1, mode='edge'), np.array([1, 2, 1]) / 4
    H = sum(w[i] * w[j] * Hp[i:i + H.shape[0], j:j + H.shape[1]] for i in range(3) for j in range(3))
    grid = base64.b64encode(np.round((H - BASE) * 10).astype('<i2').tobytes()).decode()

    road = [[round(float(a), 2), round(float(b), 2), round(float(c) - BASE, 2)] for a, b, c in zip(cx, cz, ch)]
    js = (
        '// The Nürburgring Nordschleife from public geographic data. Generated by\n'
        '// scripts/nordschleife.py: do not edit by hand.\n'
        '//\n'
        '// - road: centerline every ~6 m as [x, z, height] in meters (x east, z south,\n'
        '//   height above `base`), from OpenStreetMap relation 38566 "Nürburgring\n'
        '//   Nordschleife" (© OpenStreetMap contributors, ODbL) with heights from the\n'
        '//   Copernicus GLO-30 DEM (© DLR e.V. 2010-2014 and © Airbus Defence and Space\n'
        '//   GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA),\n'
        '//   both lightly smoothed. Index 0 is the start/finish at T13; it runs clockwise.\n'
        '// - dem: the ground around it, a grid of `cell` meters from (x0, z0), rows\n'
        '//   along x, as little-endian int16 decimeters above `base`, in base64.\n'
        '// - sections: OSM corner and section names, by meters from the start.\n'
        'export const NORDSCHLEIFE = {\n'
        f'  base: {BASE}, origin: [{lat0:.6f}, {lon0:.6f}], length: {length:.1f},\n'
        f'  sections: {json.dumps([[round(a), nm] for a, nm in named], ensure_ascii=False)},\n'
        f"  dem: {{ x0: {x0}, z0: {z0}, cell: {cell}, nx: {len(gx)}, nz: {len(gz)}, data: '{grid}' }},\n"
        f"  road: {json.dumps(road, separators=(',', ':'))},\n"
        '};\n')
    open(OUT, 'w').write(js)
    g = np.diff(np.r_[ch, ch[0]]) / (length / n)
    print(f'{length:.0f} m, {n} points, {ch.min():.0f}-{ch.max():.0f} m high, grades {g.min():.1%} to {g.max():.1%}')


if __name__ == '__main__':
    main()
