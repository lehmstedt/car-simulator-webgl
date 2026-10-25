# Elevation grid from the AWS Terrain Tiles open dataset (Terrarium PNGs,
# https://registry.opendata.aws/terrain-tiles/; in Canada built from the open
# Canadian Digital Elevation Model). Samples an nx x ny grid over a lon/lat box.
#
#   python3 fetch_dem.py W,S,E,N out.json nx ny
import os, sys, math, io, json, requests
from PIL import Image

Z = 15
W, S, E, N = map(float, sys.argv[1].split(','))
out, nx, ny = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
os.makedirs(os.path.dirname(out) or '.', exist_ok=True)


def tile(lon, lat):
    n = 2 ** Z
    return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n


x0, y0 = tile(W, N)
x1, y1 = tile(E, S)
tiles = {}
for tx in range(int(x0), int(x1) + 1):
    for ty in range(int(y0), int(y1) + 1):
        r = requests.get(f"https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{Z}/{tx}/{ty}.png", timeout=60)
        r.raise_for_status()
        tiles[(tx, ty)] = Image.open(io.BytesIO(r.content)).convert('RGB').load()


def elev(lon, lat):
    fx, fy = tile(lon, lat)
    tx, ty = int(fx), int(fy)
    px = tiles[(tx, ty)][min(255, int((fx - tx) * 256)), min(255, int((fy - ty) * 256))]
    return px[0] * 256 + px[1] + px[2] / 256 - 32768


# Rows run south to north, columns west to east.
grid = [[round(elev(W + (E - W) * i / (nx - 1), S + (N - S) * j / (ny - 1)), 2) for i in range(nx)] for j in range(ny)]
json.dump({"bbox": [W, S, E, N], "nx": nx, "ny": ny, "h": grid}, open(out, 'w'))
print(len(tiles), "tiles, heights", min(map(min, grid)), "to", max(map(max, grid)))
