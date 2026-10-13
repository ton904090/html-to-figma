// End-to-end check without Figma:
//   1. render the original HTML in Chromium and screenshot it;
//   2. run the real plugin UI (dist/ui.html) + main code (dist/code.js) against a DOM-backed
//      mock of the Figma API (test/mock-figma.js);
//   3. screenshot the layers the plugin created and diff them against the original.
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node22/lib/node_modules/playwright');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'test/out');
await mkdir(out, { recursive: true });

const args = process.argv.slice(2);
const width = Number(args.find((a) => a.startsWith('--width='))?.split('=')[1] ?? 1280);
const fixtures = args.filter((a) => !a.startsWith('--'));
const flags = {
  paragraph: args.includes('--paragraph'),
  autoLayout: args.includes('--autolayout'),
  flatten: args.includes('--flatten'),
  // fixtures named *.js.html need page scripts
  scripts: args.includes('--scripts'),
};
const tag = Object.entries(flags).filter(([, v]) => v).map(([k]) => k).join('-');
const files = fixtures.length
  ? fixtures.map((f) => resolve(f))
  : [
      ...(await readdir(resolve(root, 'examples'))).filter((f) => f.endsWith('.html')).map((f) => resolve(root, 'examples', f)),
      ...(await readdir(resolve(root, 'test/fixtures'))).filter((f) => f.endsWith('.html')).map((f) => resolve(root, 'test/fixtures', f)),
    ];

const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const mock = await readFile(resolve(root, 'test/mock-figma.js'), 'utf8');
const code = await readFile(resolve(root, 'dist/code.js'), 'utf8');
let failed = 0;

for (const file of files) {
  const name = basename(file, '.html') + (tag ? `.${tag}` : '');
  const html = await readFile(file, 'utf8');
  const height = 900;

  // 1. original
  const orig = await browser.newPage({ viewport: { width, height } });
  await orig.goto(pathToFileURL(file).href);
  await orig.evaluate(() => document.fonts.ready);
  await orig.waitForTimeout(2000); // let entrance animations finish
  const origPng = await orig.screenshot({ fullPage: true });
  await writeFile(resolve(out, `${name}.original.png`), origPng);
  await orig.close();

  // 2. plugin
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(resolve(root, 'dist/ui.html')).href);
  await page.addScriptTag({ content: mock });
  await page.addScriptTag({ content: code });
  await page.evaluate(({ html, width, height, flags }) => {
    document.getElementById('textMode').value = flags.paragraph ? 'paragraph' : 'exact';
    document.getElementById('autoLayout').checked = flags.autoLayout;
    document.getElementById('flatten').checked = flags.flatten;
    document.getElementById('scripts').checked = flags.scripts || /<script/i.test(html) && /customElements|innerHTML/.test(html);
    document.getElementById('vw').value = String(width);
    document.getElementById('vh').value = String(height);
    const ta = document.getElementById('html');
    ta.value = html;
    ta.dispatchEvent(new Event('input'));
  }, { html, width, height, flags });
  await page.waitForFunction(() => !document.getElementById('import').disabled, null, { timeout: 30000 });
  const t0 = Date.now();
  await page.click('#import');
  await page.waitForFunction(() => {
    const s = document.getElementById('status');
    return /Готово|Помилка/.test(s.textContent || '');
  }, null, { timeout: 120000 });
  const status = await page.textContent('#status');
  const warnings = await page.$$eval('#warnings li', (lis) => lis.map((l) => l.textContent));
  const stats = await page.evaluate(() => {
    const count = (n) => 1 + (n.children || []).reduce((a, c) => a + count(c), 0);
    const types = {};
    const walk = (n) => {
      types[n.type] = (types[n.type] || 0) + 1;
      if (n.layoutMode && n.layoutMode !== 'NONE') types.AUTO_LAYOUT = (types.AUTO_LAYOUT || 0) + 1;
      (n.children || []).forEach(walk);
    };
    figma.currentPage.children.forEach(walk);
    return { nodes: figma.currentPage.children.reduce((a, n) => a + count(n), 0), types };
  });
  // Wait for image decoding inside the mock
  await page.waitForTimeout(300);
  const rendered = await page.evaluate(() => {
    const rootEl = document.querySelector('#figma-stage > div');
    rootEl.style.left = '0px';
    rootEl.style.top = '0px';
    return rootEl.outerHTML;
  });
  await page.close();

  // 3. screenshot of the Figma result
  const res = await browser.newPage({ viewport: { width, height } });
  await res.setContent(`<!doctype html><html><head><style>body{margin:0}</style></head><body>${rendered}</body></html>`);
  await res.evaluate(() => document.fonts.ready);
  await res.waitForTimeout(300);
  const resPng = await res.screenshot({ fullPage: true });
  await writeFile(resolve(out, `${name}.figma.png`), resPng);
  await writeFile(resolve(out, `${name}.figma.html`), rendered);

  // 4. diff
  const diff = await res.evaluate(async ({ a, b }) => {
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.max(ia.width, ib.width);
    const h = Math.max(ia.height, ib.height);
    const ctx = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x; };
    const da = ctx(ia).getImageData(0, 0, w, h).data;
    const db = ctx(ib).getImageData(0, 0, w, h).data;
    const dc = document.createElement('canvas'); dc.width = w; dc.height = h;
    const dctx = dc.getContext('2d');
    const out = dctx.createImageData(w, h);
    let bad = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      const g = (da[i] + da[i + 1] + da[i + 2]) / 3;
      if (d > 60) { bad++; out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 0; out.data[i + 3] = 255; }
      else { out.data[i] = out.data[i + 1] = out.data[i + 2] = 200 + g / 5; out.data[i + 3] = 255; }
    }
    dctx.putImageData(out, 0, 0);
    return { ratio: bad / (w * h), sizeA: [ia.width, ia.height], sizeB: [ib.width, ib.height], png: dc.toDataURL('image/png') };
  }, { a: `data:image/png;base64,${origPng.toString('base64')}`, b: `data:image/png;base64,${resPng.toString('base64')}` });
  await writeFile(resolve(out, `${name}.diff.png`), Buffer.from(diff.png.split(',')[1], 'base64'));
  await res.close();

  const pct = (diff.ratio * 100).toFixed(2);
  const ok = diff.ratio < 0.03 && !errors.length && /Готово/.test(status);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${pct}% pixels differ · ${stats.nodes} nodes ${JSON.stringify(stats.types)} · ${Date.now() - t0}ms`);
  console.log(`     status: ${status}`);
  console.log(`     size original ${diff.sizeA.join('×')} vs figma ${diff.sizeB.join('×')}`);
  for (const w of warnings) console.log(`     warning: ${w}`);
  for (const e of errors) console.log(`     error: ${e}`);
}

await browser.close();
process.exit(failed ? 1 : 0);
