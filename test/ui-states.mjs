// Screenshots of the plugin UI in its main states (light and dark), for visual review.
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node22/lib/node_modules/playwright'); }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'test/out');
await mkdir(out, { recursive: true });
const mock = await readFile(resolve(root, 'test/mock-figma.js'), 'utf8');
const code = await readFile(resolve(root, 'dist/code.js'), 'utf8');
const browser = await playwright.chromium.launch();

for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 420, height: 720 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(resolve(root, 'dist/ui.html')).href);
  await page.evaluate((t) => document.documentElement.classList.add(`figma-${t}`), theme);
  await page.addScriptTag({ content: mock });
  await page.addScriptTag({ content: code });
  await page.evaluate(() => document.getElementById('figma-stage').style.display = 'none');
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, `ui.${theme}.1-empty.png`) });
  await page.click('#demo');
  await page.waitForFunction(() => !document.getElementById('import').disabled);
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, `ui.${theme}.2-ready.png`) });
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => /Готово/.test(document.getElementById('status').textContent));
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(out, `ui.${theme}.3-done.png`) });
  await page.click('details.adv summary');
  await page.evaluate(() => document.querySelector('main').scrollTo(0, 9999));
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(out, `ui.${theme}.4-advanced.png`) });
  console.log(theme, errors.length ? errors : 'no errors', await page.textContent('#status'));
  await page.close();
}
await browser.close();
