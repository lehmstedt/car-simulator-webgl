// Bundles index.html + src/*.js into one self-contained page (dist/car-simulator.html),
// in the body-only format used for a Claude artifact: no doctype/html/head/body tags.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ORDER = ['math.js', 'gl.js', 'geometry.js', 'bodies.js', 'nordschleife.js', 'downtown-data.js', 'terrain.js', 'montreal.js', 'track.js', 'city.js', 'verdun.js', 'openmap.js', 'traffic.js', 'minimap.js', 'gates.js', 'signs.js', 'paddock.js', 'trees.js', 'sky.js', 'shading.js', 'input.js', 'car.js', 'skids.js', 'ghost.js', 'bot-lap.js', 'main.js'];

const js = ORDER.map((f) => {
  const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '')
    .replace(/^export /gm, '');
  return `// --- ${f} ---\n${src}`;
}).join('\n');

let html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<\/?(html|head|body)[^>]*>\s*/gi, '')
  .replace(/<meta (charset|name="viewport")[^>]*>\s*/gi, '');
const tag = '<script type="module" src="src/main.js"></script>';
if (!html.includes(tag)) throw new Error('module script tag not found in index.html');
html = html.replace(tag, () => `<script>\n{\n${js}\n}\n</script>`);

mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/car-simulator.html', import.meta.url), html);
console.log('wrote dist/car-simulator.html');
