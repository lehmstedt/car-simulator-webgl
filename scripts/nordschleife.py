"""Builds src/nordschleife.js: the Nurburgring (Nordschleife, GP circuit and the
two roads joining them) from public data.

  pip install numpy requests pyorc tifffile imagecodecs
  python3 scripts/nordschleife.py [cache dir]

- Paths: OpenStreetMap relations 38566 "Nürburgring Nordschleife" (its ways
  in driving order) and 38567 "Nürburgring Grand Prix Strecke" (one loop, its
  ways in no particular order), and ways 26543901 "Anbindung zur Nordschleife"
  and 27852583 "Anbindung zum GP Kurs" (the 24-hour race's links between them),
  read straight from the weekly planet file on AWS Open Data
  (s3://osm-pds, ORC format) with HTTP range requests: only the pieces holding
  the relations, their ways and their nodes are downloaded (~1 GB, mostly node
  pieces; cached in the cache dir).
- Heights: Copernicus GLO-30 DEM tiles N50 E006 and N50 E007 (s3://copernicus-dem-30m).

The path is smoothed a little (sigma 5 m) and resampled every ~6 m; the road
height is the DEM along it, smoothed over sigma 20 m, which keeps crests such
as Flugplatz and Pflanzgarten. The GP circuit is done the same way; each link
road too, its heights then eased to meet the circuits' at both ends. The ground
grid is the DEM at 30 m, lightly blurred, over all of them. Local meters: x
east, z south, from the Nordschleife's mean lat/lon.
"""
import base64, io, json, math, os, re, sys
import numpy as np, requests

CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '.cache', 'nordschleife')
os.makedirs(CACHE, exist_ok=True)
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'nordschleife.js')
PLANET = 'https://osm-pds.s3.amazonaws.com/planet/planet-latest.orc'
DEM_URL = 'https://copernicus-dem-30m.s3.amazonaws.com/{0}/{0}.tif'
RELATION, GP_RELATION = 38566, 38567
LINKS = [26543901, 27852583]  # GP -> Nordschleife, Nordschleife -> GP
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
    path = os.path.join(CACHE, 'osm-ring-gp.json')
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

    rels = fetch('relation', [RELATION, GP_RELATION], ('id', 'type', 'tags', 'members'))
    wids = {r: [m['ref'] for m in rels[r]['members'] if m['type'] == 'way'] for r in rels}
    ways = fetch('way', [w for l in wids.values() for w in l] + LINKS, ('id', 'type', 'tags', 'nds'))
    nodes = fetch('node', [x['ref'] for w in ways.values() for x in w['nds']], ('id', 'type', 'lat', 'lon'))
    data = {
        'wids': wids[RELATION], 'gp_wids': wids[GP_RELATION],
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


def smooth(a, sigma, step, closed=True):  # Gaussian; a closed loop wraps around, an open line repeats its ends
    r = int(3 * sigma / step)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) * step / sigma) ** 2)
    pad = np.concatenate([a[-r:], a, a[:r]]) if closed else np.concatenate([np.full(r, a[0]), a, np.full(r, a[-1])])
    return np.convolve(pad, k / k.sum(), 'valid')


def resample(P, every, closed=True):
    """Points every ~`every` m along polyline P (closed: back to the start)."""
    if closed: P = np.vstack([P, P[:1]])
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
    n = max(2, int(round(d[-1] / every)))
    at = np.arange(n) * d[-1] / n if closed else np.linspace(0, d[-1], n + 1)
    return np.c_[np.interp(at, d, P[:, 0]), np.interp(at, d, P[:, 1])], d[-1]


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
    to_xz = lambda ll: np.c_[(ll[:, 1] - lon0) * k * R * math.cos(lat0 * k), -(ll[:, 0] - lat0) * k * R]
    P = to_xz(ll)
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
    ring = np.c_[cx, cz, ch]

    # GP circuit: its ways make one loop but come in no order, some reversed.
    # Walk it node by node, in the direction its one-way ways run.
    nb = {}
    for wid in osm['gp_wids']:
        nd = ways[str(wid)]['nds']
        for a, b in zip(nd, nd[1:]): nb.setdefault(a, set()).add(b); nb.setdefault(b, set()).add(a)
    assert all(len(v) == 2 for v in nb.values()), 'GP circuit is not a single loop'
    w0 = next(ways[str(w)]['nds'] for w in osm['gp_wids'] if ways[str(w)]['tags'].get('oneway') == 'yes')
    gseq = [w0[0], w0[1]]
    while gseq[-1] != gseq[0]: gseq.append(next(iter(nb[gseq[-1]] - {gseq[-2]})))
    step = {(a, b) for a, b in zip(gseq, gseq[1:])}
    for wid in osm['gp_wids']:
        w = ways[str(wid)]
        if w['tags'].get('oneway') == 'yes': assert (w['nds'][0], w['nds'][1]) in step, f'way {wid} runs the other way'
    GP = to_xz(np.array([nodes[str(i)] for i in gseq]))
    gs = np.r_[0, np.cumsum(np.hypot(*np.diff(GP, axis=0).T))]
    gpos = {nid: i for i, nid in enumerate(gseq[:-1])}
    ss = np.arange(0, gs[-1], 1.0)
    gx, gz = smooth(np.interp(ss, gs, GP[:, 0]), 5, 1), smooth(np.interp(ss, gs, GP[:, 1]), 5, 1)
    # Start/finish: halfway down the pit straight, the longest stretch without a bend.
    tx, tz = np.gradient(gx), np.gradient(gz)
    turn = np.abs(smooth(np.gradient(np.unwrap(np.arctan2(tz, tx))), 10, 1))
    straight = turn < 1 / 1500
    best, run, i_best = 0, 0, 0
    for i in range(2 * len(straight)):
        run = run + 1 if straight[i % len(straight)] else 0
        if run > best: best, i_best = run, i
    i0 = (i_best - best // 2) % len(gx)
    gx, gz = np.roll(gx, -i0), np.roll(gz, -i0)
    gh = smooth(dem(*to_ll(gx, gz)), 20, 1)
    gd = np.r_[0, np.cumsum(np.hypot(np.diff(gx), np.diff(gz)))]
    glength = gd[-1] + math.hypot(gx[0] - gx[-1], gz[0] - gz[-1])
    n = int(round(glength / 6))
    at = np.arange(n) * glength / n
    gp = np.c_[np.interp(at, gd, gx), np.interp(at, gd, gz), np.interp(at, gd, gh)]
    gsections = [(0.0, 'Start/Ziel'), (glength - best / 2, 'Start/Ziel')]  # the pit straight, both sides of the line
    for wid in osm['gp_wids']:
        w = ways[str(wid)]
        name = w['tags'].get('name')
        if not name or 'Sprintstrecke' in name or name.startswith('Anbindung'): continue
        p0 = GP[min(gpos[w['nds'][0]], gpos[w['nds'][-1]])]
        gsections.append((float(at[np.argmin(np.hypot(gp[:, 0] - p0[0], gp[:, 1] - p0[1]))]), name))
    gsections.sort()

    # Links: open roads from one circuit to the other, their ends snapped onto
    # the circuits' smoothed centerlines and their heights eased to meet them.
    def on(road, p):  # nearest point of a circuit to p: index
        return int(np.argmin(np.hypot(road[:, 0] - p[0], road[:, 1] - p[1])))
    links = []
    for wid in LINKS:
        w = ways[str(wid)]
        L = to_xz(np.array([nodes[str(i)] for i in w['nds']]))
        a_on, b_on = [(r, nm) for r, nm in ((gp, 'gp'), (ring, 'ring')) if np.hypot(*(r[on(r, L[0]), :2] - L[0])) < 15][0], \
                     [(r, nm) for r, nm in ((gp, 'gp'), (ring, 'ring')) if np.hypot(*(r[on(r, L[-1]), :2] - L[-1])) < 15][0]
        L[0], L[-1] = a_on[0][on(a_on[0], L[0]), :2], b_on[0][on(b_on[0], L[-1]), :2]
        Q, total = resample(L, 1.0, closed=False)
        Q = np.c_[smooth(Q[:, 0], 3, 1, False), smooth(Q[:, 1], 3, 1, False)]
        Q[0], Q[-1] = L[0], L[-1]
        q = smooth(dem(*to_ll(Q[:, 0], Q[:, 1])), 20, 1, False)
        u = np.linspace(0, 1, len(q))
        ease = u * u * (3 - 2 * u)
        q += (a_on[0][on(a_on[0], Q[0]), 2] - q[0]) * (1 - ease) + (b_on[0][on(b_on[0], Q[-1]), 2] - q[-1]) * ease
        C, _ = resample(Q, 6, closed=False)
        dq = np.r_[0, np.cumsum(np.hypot(*np.diff(Q, axis=0).T))]
        dc = np.r_[0, np.cumsum(np.hypot(*np.diff(C, axis=0).T))]
        links.append((w['tags'].get('name', ''), a_on[1], b_on[1], np.c_[C, np.interp(dc, dq, q)], dc[-1]))

    # Ground: the DEM on a 30 m grid reaching 900 m past all the roads, lightly blurred.
    allx, allz = np.r_[cx, gp[:, 0]], np.r_[cz, gp[:, 1]]
    cell, margin = 30.0, 900
    x0, x1 = math.floor((allx.min() - margin) / cell) * cell, math.ceil((allx.max() + margin) / cell) * cell
    z0, z1 = math.floor((allz.min() - margin) / cell) * cell, math.ceil((allz.max() + margin) / cell) * cell
    gxs, gzs = np.arange(x0, x1 + 1, cell), np.arange(z0, z1 + 1, cell)
    X, Z = np.meshgrid(gxs, gzs)
    H = dem(*to_ll(X, Z))
    Hp, w = np.pad(H, 1, mode='edge'), np.array([1, 2, 1]) / 4
    H = sum(w[i] * w[j] * Hp[i:i + H.shape[0], j:j + H.shape[1]] for i in range(3) for j in range(3))
    grid = base64.b64encode(np.round((H - BASE) * 10).astype('<i2').tobytes()).decode()

    pts = lambda A: json.dumps([[round(float(a), 2), round(float(b), 2), round(float(c) - BASE, 2)] for a, b, c in A], separators=(',', ':'))
    js = (
        '// The Nürburgring from public geographic data. Generated by\n'
        '// scripts/nordschleife.py: do not edit by hand.\n'
        '//\n'
        '// Roads are centerlines every ~6 m as [x, z, height] in meters (x east,\n'
        '// z south, height above `base`), from OpenStreetMap (© OpenStreetMap\n'
        '// contributors, ODbL) with heights from the Copernicus GLO-30 DEM (© DLR e.V.\n'
        '// 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under\n'
        '// COPERNICUS by the European Union and ESA), both lightly smoothed.\n'
        '//\n'
        '// NORDSCHLEIFE:\n'
        '// - road: relation 38566 "Nürburgring Nordschleife". Index 0 is the\n'
        '//   start/finish at T13; it runs clockwise.\n'
        '// - dem: the ground around all the roads, a grid of `cell` meters from\n'
        '//   (x0, z0), rows along x, as little-endian int16 decimeters above `base`, in base64.\n'
        '// - sections: OSM corner and section names, by meters from the start.\n'
        '// GP_STRECKE: relation 38567 "Nürburgring Grand Prix Strecke" (with the\n'
        '// Mercedes-Arena and the Müllenbachschleife), the same way; index 0 is\n'
        '// halfway down the pit straight.\n'
        '// RING_LINKS: the 24-hour race\'s links, open roads `from` one circuit `to`\n'
        '// the other (\'gp\' or \'ring\'), each end on that circuit\'s centerline.\n'
        'export const NORDSCHLEIFE = {\n'
        f'  base: {BASE}, origin: [{lat0:.6f}, {lon0:.6f}], length: {length:.1f},\n'
        f'  sections: {json.dumps([[round(a), nm] for a, nm in named], ensure_ascii=False)},\n'
        f"  dem: {{ x0: {x0}, z0: {z0}, cell: {cell}, nx: {len(gxs)}, nz: {len(gzs)}, data: '{grid}' }},\n"
        f"  road: {pts(ring)},\n"
        '};\n'
        'export const GP_STRECKE = {\n'
        f'  length: {glength:.1f},\n'
        f'  sections: {json.dumps([[round(a), nm] for a, nm in gsections], ensure_ascii=False)},\n'
        f"  road: {pts(gp)},\n"
        '};\n'
        'export const RING_LINKS = [\n'
        + ''.join(f"  {{ name: {json.dumps(nm, ensure_ascii=False)}, from: '{a}', to: '{b}', length: {ln:.1f}, road: {pts(R_)} }},\n" for nm, a, b, R_, ln in links) +
        '];\n')
    open(OUT, 'w').write(js)
    g = np.diff(np.r_[ch, ch[0]]) / (length / len(ch))
    print(f'Nordschleife {length:.0f} m, {len(ch)} points, {ch.min():.0f}-{ch.max():.0f} m high, grades {g.min():.1%} to {g.max():.1%}')
    g = np.diff(np.r_[gp[:, 2], gp[0, 2]]) / (glength / len(gp))
    print(f'GP {glength:.0f} m, {len(gp)} points, {gp[:, 2].min():.0f}-{gp[:, 2].max():.0f} m high, grades {g.min():.1%} to {g.max():.1%}')
    for nm, a, b, R_, ln in links: print(f'{nm}: {a} -> {b}, {ln:.0f} m, {len(R_)} points')


if __name__ == '__main__':
    main()
