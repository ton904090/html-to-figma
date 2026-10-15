// Runs inside the sandboxed iframe that renders the user's HTML.
// Protocol (window.postMessage with parent):
//   iframe → parent  {h2f:'ready'} once the page is loaded
//   parent → iframe  {h2f:'capture', options}
//   iframe → parent  {h2f:'progress', message} … {h2f:'result', result} | {h2f:'error', message}

import type { CaptureOptions, CaptureResult, FrameSpec } from '../shared/types';
import { fetchText, ImageStore } from './images';
import { materializePseudoElements } from './pseudo';
import { createContext, serializeDocument, serializeSubtree } from './serialize';
import { findSlides, SlideStage, slideTitle } from './slides';

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

  const slideMode = options.mode !== 'page';
  if (!slideMode) {
    materializePseudoElements(document);
    await settle();
    settleAnimations();
  }

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

  const ctx = createContext({ opts: options, images, warnings, svgTexts, sx: 0, sy: 0 });
  const slides = slideMode ? findSlides(document, options.slideSelector) : null;
  if (slideMode && !slides) {
    materializePseudoElements(document);
    await settle();
  }
  if (options.mode === 'slides' && !slides) {
    throw new Error('Слайди не знайдено. Вкажіть CSS-селектор слайдів у розширених налаштуваннях.');
  }
  let frames: FrameSpec[];
  if (slides) {
    frames = [];
    const stage = new SlideStage(slides.elements);
    try {
      for (let i = 0; i < slides.elements.length; i++) {
        post({ type: 'progress', message: `Слайд ${i + 1} з ${slides.elements.length}…`, ratio: (i / slides.elements.length) * 0.5 });
        const slide = stage.show(i);
        window.scrollTo(0, 0);
        await settle();
        settleAnimations();
        // Pseudo-elements often depend on the slide's active state, so materialize them now.
        materializePseudoElements(document, slide);
        await settle();
        settleAnimations();
        ctx.sx = window.scrollX;
        ctx.sy = window.scrollY;
        frames.push(serializeSubtree(slide, ctx, slideTitle(slide, i)));
      }
    } finally {
      stage.restore();
    }
  } else {
    post({ type: 'progress', message: 'Аналіз макета…' });
    window.scrollTo(0, 0);
    ctx.sx = window.scrollX;
    ctx.sy = window.scrollY;
    frames = [serializeDocument(document, ctx)];
  }

  post({ type: 'progress', message: 'Завантаження зображень…' });
  await images.loadAll((done, total) => post({ type: 'progress', message: `Зображення ${done}/${total}`, ratio: done / total }));
  await Promise.all(ctx.pending);
  for (const fn of ctx.afterLoad) fn();

  return {
    kind: slides ? 'slides' : 'page',
    title: document.title || (slides ? 'Presentation' : 'HTML page'),
    frames,
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
  let slides: { count: number; width: number; height: number; viewportSized: boolean } | null = null;
  try {
    const opts = (window as unknown as { __H2F_SLIDE_SELECTOR__?: string }).__H2F_SLIDE_SELECTOR__;
    const found = findSlides(document, opts);
    if (found) slides = { count: found.elements.length, width: found.width, height: found.height, viewportSized: found.viewportSized };
  } catch {
    /* detection is best-effort */
  }
  post({
    type: 'ready',
    slides,
    width: document.documentElement.scrollWidth,
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    title: document.title,
  });
}
if (document.readyState === 'complete') announce();
else window.addEventListener('load', announce, { once: true });
