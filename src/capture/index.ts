// Runs inside the sandboxed iframe that renders the user's HTML.
// Protocol (window.postMessage with parent):
//   iframe → parent  {h2f:'ready'} once the page is loaded
//   parent → iframe  {h2f:'capture', options}
//   iframe → parent  {h2f:'progress', message} … {h2f:'result', result} | {h2f:'error', message}

import type { CaptureOptions, CaptureResult } from '../shared/types';
import { fetchText, ImageStore } from './images';
import { materializePseudoElements } from './pseudo';
import { serializeDocument } from './serialize';

function post(msg: Record<string, unknown>, transfer?: Transferable[]) {
  parent.postMessage({ h2f: true, ...msg }, '*', transfer);
}

function timeout(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function settle(): Promise<void> {
  // Lazy images would never load in an off-screen iframe.
  for (const img of document.images) {
    if (img.loading === 'lazy') img.loading = 'eager';
  }
  const imgs = [...document.images].filter((i) => !i.complete);
  await Promise.race([
    Promise.all([
      document.fonts?.ready,
      ...imgs.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); })),
    ]),
    timeout(15000),
  ]);
  // Let layout settle. requestAnimationFrame never fires while the preview iframe is scrolled
  // out of view, so it is raced against a timer.
  await Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    timeout(120),
  ]);
}

function settleAnimations() {
  if (typeof document.getAnimations !== 'function') return;
  for (const a of document.getAnimations()) {
    try {
      const timing = a.effect?.getComputedTiming();
      if (timing && timing.endTime !== Infinity) a.finish();
      else a.pause();
    } catch {
      /* ignore */
    }
  }
}

const SVG_URL = /\.svg(\?|#|$)|^data:image\/svg\+xml/i;

async function capture(options: CaptureOptions): Promise<CaptureResult> {
  post({ type: 'progress', message: 'Очікування шрифтів і зображень…' });
  await settle();
  // Capture the final state: finish entrance animations (fade-in etc.), stop transitions,
  // pause infinite animations where they are.
  const freeze = document.createElement('style');
  freeze.setAttribute('data-h2f', '');
  freeze.textContent = '*,*::before,*::after{transition:none!important;caret-color:transparent!important}';
  document.head.appendChild(freeze);
  settleAnimations();

  materializePseudoElements(document);
  await settle();
  settleAnimations();

  const images = new ImageStore(options.corsProxy);
  const warnings = new Set<string>();

  // SVG <img> sources become vectors, so fetch their markup up front.
  const svgTexts = new Map<string, string>();
  const svgUrls = new Set<string>();
  for (const img of document.images) {
    const src = img.currentSrc || img.src;
    if (src && SVG_URL.test(src)) svgUrls.add(src);
  }
  await Promise.all(
    [...svgUrls].map(async (u) => {
      const text = await fetchText(u, options.corsProxy);
      if (text && /<svg[\s>]/i.test(text)) svgTexts.set(u, text);
    }),
  );

  post({ type: 'progress', message: 'Аналіз макета…' });
  window.scrollTo(0, 0);
  const { root, afterLoad, pending } = serializeDocument(document, {
    opts: options,
    images,
    warnings,
    svgTexts,
    sx: window.scrollX,
    sy: window.scrollY,
  });

  post({ type: 'progress', message: 'Завантаження зображень…' });
  await images.loadAll((done, total) => post({ type: 'progress', message: `Зображення ${done}/${total}`, ratio: done / total }));
  await Promise.all(pending);
  for (const fn of afterLoad) fn();

  return {
    title: document.title || 'HTML page',
    width: root.w,
    height: root.h,
    root,
    images: images.bytes(),
    warnings: [...warnings],
  };
}

window.addEventListener('message', async (e) => {
  const data = e.data;
  if (!data || data.h2f !== true || data.type !== 'capture') return;
  try {
    const result = await capture(data.options as CaptureOptions);
    const transfer = Object.values(result.images).map((b) => b.buffer as ArrayBuffer);
    // Transfer only unique buffers.
    post({ type: 'result', result }, [...new Set(transfer)]);
  } catch (err) {
    post({ type: 'error', message: (err as Error)?.stack || String(err) });
  }
});

function announce() {
  post({
    type: 'ready',
    width: document.documentElement.scrollWidth,
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    title: document.title,
  });
}
if (document.readyState === 'complete') announce();
else window.addEventListener('load', announce, { once: true });
