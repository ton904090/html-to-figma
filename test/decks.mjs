// Presentation import check: every slide of an HTML deck must become its own Figma frame that
// looks like the slide shown by the deck itself (navigated with its own keyboard/scroll logic).
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node22/lib/node_modules/playwright'); }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'test/out');
await mkdir(out, { recursive: true });

const DECKS = [
  // Claude-style deck: fixed 1280×720 slides, JS navigation, deck scaled to the window.
  { file: 'test/decks/claude-deck.html', slides: 4, size: [1280, 720], nav: 'keys', hide: '.nav,.counter,.progress' },
  // Scroll deck: 100vw × 100vh sections (plugin switches the window to 1920×1080).
  { file: 'test/decks/scroll-deck.html', slides: 3, size: [1920, 1080], nav: 'scroll' },
  // Same Claude deck with its scripts running: the deck scales itself with transform: scale().
  { file: 'test/decks/claude-deck.html', slides: 4, size: [1280, 720], nav: 'keys', hide: '.nav,.counter,.progress', scripts: true, viewport: [1440, 900] },
  // reveal.js structure: nested vertical stacks, hidden fragments, zoomed container. Ground truth
  // is the slide with all fragments shown.
  { file: 'test/decks/reveal-deck.html', slides: 4, size: [960, 540], nav: 'reveal' },
];

const browser = await playwright.chromium.launch();
const mock = await readFile(resolve(root, 'test/mock-figma.js'), 'utf8');
const code = await readFile(resolve(root, 'dist/code.js'), 'utf8');
let failed = 0;

async function diff(page, a, b) {
  return page.evaluate(async ({ a, b }) => {
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
    const px = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const da = px(ia), db = px(ib);
    let bad = 0;
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 60) bad++;
    return { ratio: bad / (w * h), a: [ia.width, ia.height], b: [ib.width, ib.height] };
  }, { a: `data:image/png;base64,${a.toString('base64')}`, b: `data:image/png;base64,${b.toString('base64')}` });
}

for (const deck of DECKS) {
  const file = resolve(root, deck.file);
  const name = deck.file.split('/').pop().replace('.html', '') + (deck.scripts ? '.js' : '');
  const html = await readFile(file, 'utf8');
  const [W, H] = deck.size;

  // 1. Ground truth: the deck's own rendering of each slide.
  const truth = [];
  const orig = await browser.newPage({ viewport: { width: W, height: H } });
  await orig.goto(pathToFileURL(file).href);
  if (deck.hide) await orig.addStyleTag({ content: `${deck.hide}{display:none!important}` });
  await orig.evaluate(() => document.fonts.ready);
  if (deck.nav === 'reveal') {
    await orig.addStyleTag({ content: '.reveal .slides{zoom:1!important;left:0!important;top:0!important;margin:0!important}.fragment{opacity:1!important}.reveal .slides section.past{transform:none}' });
  }
  for (let i = 0; i < deck.slides; i++) {
    if (i > 0 && deck.nav === 'keys') await orig.keyboard.press('ArrowRight');
    if (deck.nav === 'reveal') {
      await orig.evaluate((i) => {
        const leaves = [...document.querySelectorAll('.reveal .slides section')].filter((s) => !s.querySelector('section'));
        document.querySelectorAll('.reveal section').forEach((s) => s.classList.remove('present'));
        leaves[i].classList.add('present');
        leaves[i].parentElement.closest('section')?.classList.add('present');
      }, i);
    }
    await orig.waitForTimeout(deck.nav === 'reveal' ? 100 : 1600);
    let png;
    if (deck.nav === 'scroll') png = await (await orig.$$('section'))[i].screenshot();
    else png = await orig.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
    truth.push(png);
    await writeFile(resolve(out, `${name}.${i + 1}.original.png`), png);
  }
  await orig.close();

  // 2. Plugin (auto mode, default settings: page scripts disabled).
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(resolve(root, 'dist/ui.html')).href);
  await page.addScriptTag({ content: mock });
  await page.addScriptTag({ content: code });
  await page.evaluate(({ h, deck }) => {
    document.getElementById('scripts').checked = !!deck.scripts;
    if (deck.viewport) { document.getElementById('vw').value = deck.viewport[0]; document.getElementById('vh').value = deck.viewport[1]; }
    const t = document.getElementById('html'); t.value = h; t.dispatchEvent(new Event('input'));
  }, { h: html, deck });
  await page.waitForFunction(() => !document.getElementById('import').disabled, null, { timeout: 30000 });
  const ready = await page.textContent('#status');
  await page.click('#import');
  await page.waitForFunction(() => /Готово|Помилка/.test(document.getElementById('status').textContent || ''), null, { timeout: 120000 });
  const status = await page.textContent('#status');
  await page.waitForTimeout(300);
  const frames = await page.evaluate(() => {
    const section = figma.currentPage.children[0];
    return {
      container: section.type,
      title: section.name,
      slides: section.children.map((f) => {
        const el = f.el.cloneNode(true);
        el.style.left = '0px';
        el.style.top = '0px';
        return { name: f.name, w: f.width, h: f.height, html: el.outerHTML };
      }),
    };
  });
  await page.close();

  console.log(`${name}: ${ready.trim()}`);
  console.log(`   ${status.trim()} → ${frames.container} «${frames.title}» with ${frames.slides.length} frames`);
  if (frames.slides.length !== deck.slides || frames.container !== 'SECTION') failed++;

  // 3. Compare each slide.
  const res = await browser.newPage({ viewport: { width: W, height: H } });
  for (let i = 0; i < frames.slides.length; i++) {
    const f = frames.slides[i];
    await res.setContent(`<!doctype html><html><head><style>body{margin:0}</style></head><body>${f.html}</body></html>`);
    await res.evaluate(() => document.fonts.ready);
    await res.waitForTimeout(200);
    const png = await res.screenshot({ clip: { x: 0, y: 0, width: f.w, height: f.h } });
    await writeFile(resolve(out, `${name}.${i + 1}.figma.png`), png);
    const d = truth[i] ? await diff(res, truth[i], png) : { ratio: 1, a: [], b: [] };
    const ok = d.ratio < 0.03 && f.w === W && f.h === H;
    if (!ok) failed++;
    console.log(`   ${ok ? 'PASS' : 'FAIL'} ${f.name} ${f.w}×${f.h}: ${(d.ratio * 100).toFixed(2)}% pixels differ`);
  }
  await res.close();
  for (const e of errors) { console.log(`   error: ${e}`); failed++; }
}

await browser.close();
process.exit(failed ? 1 : 0);
