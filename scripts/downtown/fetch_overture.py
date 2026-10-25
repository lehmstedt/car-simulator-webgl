# Rows of an Overture Maps theme (open data: https://overturemaps.org, roads and
# buildings mostly from OpenStreetMap, ODbL) inside a lon/lat box. Reads the
# public GeoParquet release on S3 with HTTP range requests, fetching only the row
# groups whose bbox statistics overlap the box.
#
#   python3 fetch_overture.py theme=transportation/type=segment W,S,E,N out.parquet
import io, os, sys, json, re, requests, pyarrow.parquet as pq, pyarrow as pa
from concurrent.futures import ThreadPoolExecutor
BASE = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com"
REL = "release/2026-10-21.0"
W, S, E, N = map(float, sys.argv[2].split(','))
theme = sys.argv[1]  # e.g. theme=transportation/type=segment
out = sys.argv[3]
os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
sess = requests.Session()

class HttpFile(io.RawIOBase):
    def __init__(self, url, size): self.url, self.size, self.pos = url, size, 0
    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos
    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos
    def read(self, n=-1):
        if n < 0: n = self.size - self.pos
        if n == 0 or self.pos >= self.size: return b""
        end = min(self.size, self.pos + n) - 1
        r = sess.get(self.url, headers={"Range": f"bytes={self.pos}-{end}"}, timeout=120)
        r.raise_for_status(); d = r.content; self.pos += len(d); return d
    def readinto(self, b):
        d = self.read(len(b)); b[:len(d)] = d; return len(d)

keys, token = [], None
while True:
    u = f"{BASE}/?list-type=2&prefix={REL}/{theme}/" + (f"&continuation-token={requests.utils.quote(token)}" if token else "")
    t = sess.get(u, timeout=60).text
    keys += list(zip(re.findall(r"<Key>([^<]+)</Key>", t), map(int, re.findall(r"<Size>(\d+)</Size>", t))))
    m = re.search(r"<NextContinuationToken>([^<]+)<", t)
    if not m: break
    token = m.group(1)
print(len(keys), "files", file=sys.stderr)

def groups(k):
    key, size = k
    f = pq.ParquetFile(HttpFile(f"{BASE}/{key}", size))
    md, names = f.metadata, f.schema_arrow.names
    hits = []
    for g in range(md.num_row_groups):
        rg = md.row_group(g); st = {}
        for c in range(rg.num_columns):
            col = rg.column(c); p = col.path_in_schema
            if p.startswith("bbox.") and col.statistics and col.statistics.has_min_max:
                st[p] = (col.statistics.min, col.statistics.max)
        if not st: continue
        if st["bbox.xmax"][1] < W or st["bbox.xmin"][0] > E or st["bbox.ymax"][1] < S or st["bbox.ymin"][0] > N: continue
        hits.append(g)
    return key, size, hits

with ThreadPoolExecutor(8) as ex: found = list(ex.map(groups, keys))
tables = []
for key, size, hits in found:
    if not hits: continue
    print(key, hits, file=sys.stderr)
    f = pq.ParquetFile(HttpFile(f"{BASE}/{key}", size))
    for g in hits:
        t = f.read_row_group(g)
        b = t.column("bbox").combine_chunks()
        xmin, xmax, ymin, ymax = (b.field(n).to_numpy() for n in ("xmin", "xmax", "ymin", "ymax"))
        mask = (xmax >= W) & (xmin <= E) & (ymax >= S) & (ymin <= N)
        if mask.any(): tables.append(t.filter(pa.array(mask)))
t = pa.concat_tables(tables, promote_options="permissive")
pq.write_table(t, out)
print(t.num_rows, "rows", file=sys.stderr)
