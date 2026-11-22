// Renders icons/icon.svg to the PNG sizes the web app manifest needs.
//   node scripts/icons.mjs   (needs Playwright's Chromium)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const svg = readFileSync(new URL('../icons/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
for (const size of [192, 512, 180]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  const name = size === 180 ? 'apple-touch-icon' : `icon-${size}`;
  await page.screenshot({ path: new URL(`../icons/${name}.png`, import.meta.url).pathname });
  await page.close();
}
await browser.close();
console.log('wrote icons/*.png');
