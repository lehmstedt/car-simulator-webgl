// Bundles index.html + src/*.js into one self-contained page (dist/car-simulator.html),
// in the body-only format used for a Claude artifact: no doctype/html/head/body tags.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Modules in dependency order: each after everything it imports, from main.js down.
const ORDER = [];
(function visit(f) {
  if (ORDER.includes(f)) return;
  const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  for (const [, dep] of src.matchAll(/^import .* from '\.\/([\w.-]+)';$/gm)) visit(dep);
  ORDER.push(f);
})('main.js');

// All modules share one scope in the bundle: two can't declare the same top-level name.
const owner = new Map();
for (const f of ORDER) {
  const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  for (const [, name] of src.matchAll(/^(?:export )?(?:async )?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (owner.has(name)) throw new Error(`"${name}" is declared at the top of both ${owner.get(name)} and ${f}: rename one`);
    owner.set(name, f);
  }
}

const js = ORDER.map((f) => {
  const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '')
    .replace(/^export /gm, '');
  return `// --- ${f} ---\n${src}`;
}).join('\n');

// Parsing it catches what the check above can't see (`const A = 1, B = 2;`).
try { new Function(`{\n${js}\n}`); } catch (e) { throw new Error(`the bundled script doesn't parse: ${e.message}`); }

let html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<\/?(html|head|body)[^>]*>\s*/gi, '')
  .replace(/<meta (charset|name="viewport")[^>]*>\s*/gi, '')
  // The installable app's manifest, icons and service worker only work on the hosted site.
  .replace(/<!-- pwa\b[\s\S]*?<!-- \/pwa -->\s*/g, '');
const tag = '<script type="module" src="src/main.js"></script>';
if (!html.includes(tag)) throw new Error('module script tag not found in index.html');
html = html.replace(tag, () => `<script>\n{\n${js}\n}\n</script>`);

mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/car-simulator.html', import.meta.url), html);
console.log('wrote dist/car-simulator.html');
