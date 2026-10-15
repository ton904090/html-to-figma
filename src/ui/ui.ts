import type { CaptureOptions, CaptureResult, MainToUI } from '../shared/types';

declare const CAPTURE_SCRIPT: string;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  html: $<HTMLTextAreaElement>('html'),
  file: $<HTMLInputElement>('file'),
  drop: $('drop'),
  fileInfo: $('fileInfo'),
  url: $<HTMLInputElement>('url'),
  fetchUrl: $<HTMLButtonElement>('fetchUrl'),
  vw: $<HTMLInputElement>('vw'),
  vh: $<HTMLInputElement>('vh'),
  presets: $('presets'),
  textMode: $<HTMLSelectElement>('textMode'),
  mode: $<HTMLSelectElement>('mode'),
  slideSelector: $<HTMLInputElement>('slideSelector'),
  autoLayout: $<HTMLInputElement>('autoLayout'),
  flatten: $<HTMLInputElement>('flatten'),
  scripts: $<HTMLInputElement>('scripts'),
  baseUrl: $<HTMLInputElement>('baseUrl'),
  proxy: $<HTMLInputElement>('proxy'),
  refresh: $<HTMLButtonElement>('refresh'),
  previewWrap: $('previewWrap'),
  previewEmpty: $('previewEmpty'),
  scaler: $('scaler'),
  bar: $('bar'),
  status: $('status'),
  warnings: $('warnings'),
  import: $<HTMLButtonElement>('import'),
};

let source = '';
let iframe: HTMLIFrameElement | null = null;
let ready = false;
let capturing = false;
/** viewport was switched to 1920×1080 automatically for a viewport-sized deck */
let autoSized = false;

// ---------- messaging ----------

function toMain(msg: unknown) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

function setStatus(text: string, error = false, ratio?: number) {
  els.status.textContent = text;
  els.status.classList.toggle('error', error);
  if (ratio !== undefined) els.bar.style.width = `${Math.round(ratio * 100)}%`;
}

function showWarnings(list: string[]) {
  els.warnings.innerHTML = '';
  els.warnings.hidden = !list.length;
  for (const w of list.slice(0, 50)) {
    const li = document.createElement('li');
    li.textContent = w;
    els.warnings.appendChild(li);
  }
}

/** Ukrainian plural: 1 слайд, 2 слайди, 5 слайдів */
function slidesWord(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return `${n} слайд`;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} слайди`;
  return `${n} слайдів`;
}

// ---------- settings ----------

function options(): CaptureOptions {
  return {
    viewportWidth: clamp(parseInt(els.vw.value, 10) || 1440, 200, 4000),
    viewportHeight: clamp(parseInt(els.vh.value, 10) || 900, 200, 8000),
    textMode: els.textMode.value === 'paragraph' ? 'paragraph' : 'exact',
    autoLayout: els.autoLayout.checked,
    flattenWrappers: els.flatten.checked,
    corsProxy: els.proxy.value.trim(),
    mode: els.mode.value === 'page' ? 'page' : els.mode.value === 'slides' ? 'slides' : 'auto',
    slideSelector: els.slideSelector.value.trim(),
  };
}

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n));
}

function saveSettings() {
  toMain({
    type: 'save-settings',
    settings: {
      ...options(),
      scripts: els.scripts.checked,
      baseUrl: els.baseUrl.value,
    },
  });
  syncPresets();
}

function applySettings(s: Record<string, unknown>) {
  if (typeof s.viewportWidth === 'number') els.vw.value = String(s.viewportWidth);
  if (typeof s.viewportHeight === 'number') els.vh.value = String(s.viewportHeight);
  if (s.textMode === 'exact' || s.textMode === 'paragraph') els.textMode.value = s.textMode;
  if (typeof s.autoLayout === 'boolean') els.autoLayout.checked = s.autoLayout;
  if (typeof s.flattenWrappers === 'boolean') els.flatten.checked = s.flattenWrappers;
  if (typeof s.scripts === 'boolean') els.scripts.checked = s.scripts;
  if (typeof s.baseUrl === 'string') els.baseUrl.value = s.baseUrl;
  if (typeof s.corsProxy === 'string') els.proxy.value = s.corsProxy;
  if (s.mode === 'auto' || s.mode === 'page' || s.mode === 'slides') els.mode.value = s.mode;
  if (typeof s.slideSelector === 'string') els.slideSelector.value = s.slideSelector;
  syncPresets();
}

function syncPresets() {
  for (const b of els.presets.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.w === els.vw.value && (!('slides' in b.dataset) || b.dataset.h === els.vh.value));
  }
}

// ---------- HTML preparation ----------

function prepareHtml(html: string, baseUrl: string, runScripts: boolean, slideSelector: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Policies or redirects inside the page would block our capture script.
  doc.querySelectorAll('meta[http-equiv]').forEach((m) => {
    const v = (m.getAttribute('http-equiv') || '').toLowerCase();
    if (v === 'content-security-policy' || v === 'refresh') m.remove();
  });
  if (baseUrl && !doc.querySelector('base[href]')) {
    const base = doc.createElement('base');
    base.href = baseUrl;
    doc.head.insertBefore(base, doc.head.firstChild);
  }
  if (!runScripts) {
    doc.querySelectorAll('script').forEach((s) => s.remove());
    doc.querySelectorAll('*').forEach((el) => {
      for (const a of [...el.attributes]) {
        if (a.name.startsWith('on')) el.removeAttribute(a.name);
        else if ((a.name === 'href' || a.name === 'src') && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
      }
    });
    // <noscript> content is what the page shows without JS.
    doc.querySelectorAll('noscript').forEach((n) => {
      const tpl = doc.createElement('template');
      tpl.innerHTML = n.textContent || '';
      n.replaceWith(tpl.content);
    });
  }
  doc.querySelectorAll('img[loading="lazy"]').forEach((img) => img.setAttribute('loading', 'eager'));
  const config = doc.createElement('script');
  config.setAttribute('data-h2f-ignore', '');
  config.textContent = `window.__H2F_SLIDE_SELECTOR__=${JSON.stringify(slideSelector).replace(/</g, '\\u003c')};`;
  (doc.body || doc.documentElement).appendChild(config);
  const script = doc.createElement('script');
  script.setAttribute('data-h2f-ignore', '');
  script.textContent = CAPTURE_SCRIPT.replace(/<\/script/gi, '<\\/script');
  (doc.body || doc.documentElement).appendChild(script);
  // Always standards mode: fragments without a doctype would otherwise render in quirks mode.
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

// ---------- preview ----------

function render() {
  ready = false;
  els.import.disabled = true;
  showWarnings([]);
  els.bar.style.width = '0';
  if (iframe) {
    iframe.remove();
    iframe = null;
  }
  if (!source.trim()) {
    els.previewEmpty.hidden = false;
    setStatus('');
    return;
  }
  els.previewEmpty.hidden = true;
  const opts = options();
  iframe = document.createElement('iframe');
  // Opaque origin: page scripts (if enabled) can't reach the plugin.
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.width = String(opts.viewportWidth);
  iframe.height = String(opts.viewportHeight);
  iframe.style.width = `${opts.viewportWidth}px`;
  iframe.style.height = `${opts.viewportHeight}px`;
  iframe.srcdoc = prepareHtml(source, els.baseUrl.value.trim(), els.scripts.checked, opts.slideSelector);
  els.scaler.appendChild(iframe);
  layoutPreview();
  setStatus('Рендеринг сторінки…');
}

function layoutPreview() {
  const opts = options();
  const avail = els.previewWrap.clientWidth || 400;
  const scale = avail / opts.viewportWidth;
  els.scaler.style.transform = `scale(${scale})`;
  els.scaler.style.width = `${opts.viewportWidth}px`;
  els.previewWrap.style.height = iframe ? `${Math.min(opts.viewportHeight * scale, 320)}px` : '';
}

let renderTimer = 0;
function scheduleRender(delay = 500) {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(render, delay);
}

// ---------- capture ----------

function startCapture() {
  if (!iframe?.contentWindow || !ready || capturing) return;
  capturing = true;
  els.import.disabled = true;
  showWarnings([]);
  setStatus('Підготовка…', false, 0.02);
  iframe.contentWindow.postMessage({ h2f: true, type: 'capture', options: options() }, '*');
}

window.addEventListener('message', (e) => {
  const data = e.data;
  // Messages from the plugin main thread
  if (data && data.pluginMessage) {
    const msg = data.pluginMessage as MainToUI;
    if (msg.type === 'settings') applySettings(msg.settings as Record<string, unknown>);
    else if (msg.type === 'progress') setStatus(msg.message, false, msg.ratio !== undefined ? 0.5 + msg.ratio * 0.5 : undefined);
    else if (msg.type === 'done') {
      capturing = false;
      els.import.disabled = false;
      setStatus(msg.message, false, 1);
      showWarnings(msg.warnings);
    } else if (msg.type === 'error') {
      capturing = false;
      els.import.disabled = false;
      setStatus(msg.message, true, 0);
    }
    return;
  }
  // Messages from the rendered page
  if (!data || data.h2f !== true || !iframe || e.source !== iframe.contentWindow) return;
  if (data.type === 'ready') {
    const opts = options();
    const slides = data.slides as { count: number; width: number; height: number; viewportSized: boolean } | null;
    const asSlides = slides && opts.mode !== 'page';
    // Slides sized by the window (100vw × 100vh) take the window's size: use a 16:9 slide size.
    if (asSlides && slides.viewportSized && !autoSized && Math.abs(opts.viewportWidth / opts.viewportHeight - 16 / 9) > 0.02) {
      autoSized = true;
      els.vw.value = '1920';
      els.vh.value = '1080';
      saveSettings();
      render();
      return;
    }
    ready = true;
    els.import.disabled = false;
    if (asSlides) {
      setStatus(`Презентація${data.title ? ` «${data.title}»` : ''}: ${slidesWord(slides.count)} ${slides.width}×${slides.height}px — кожен стане окремим фреймом`);
      els.import.textContent = `Імпортувати ${slidesWord(slides.count)} у Figma`;
    } else {
      if (opts.mode === 'slides') {
        setStatus('Слайди не знайдено автоматично — вкажіть CSS-селектор слайдів у розширених налаштуваннях', true);
      } else {
        setStatus(`Сторінка готова${data.title ? `: «${data.title}»` : ''} · ${opts.viewportWidth}×${data.height}px`);
      }
      els.import.textContent = 'Імпортувати у Figma';
    }
  } else if (data.type === 'progress') {
    setStatus(data.message, false, data.ratio !== undefined ? data.ratio * 0.5 : undefined);
  } else if (data.type === 'error') {
    capturing = false;
    els.import.disabled = false;
    setStatus(`Помилка аналізу сторінки: ${data.message}`, true, 0);
  } else if (data.type === 'result') {
    const result = data.result as CaptureResult;
    setStatus('Створення шарів у Figma…', false, 0.5);
    toMain({ type: 'import', result, options: options() });
  }
});

// ---------- inputs ----------

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll<HTMLButtonElement>('.tab')) t.setAttribute('aria-selected', String(t === tab));
    for (const p of document.querySelectorAll<HTMLElement>('.panel')) p.hidden = p.dataset.panel !== tab.dataset.tab;
  });
}

els.html.addEventListener('input', () => {
  source = els.html.value;
  autoSized = false;
  scheduleRender();
});

async function loadFile(file: File) {
  source = await file.text();
  els.html.value = source;
  els.fileInfo.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  render();
}

els.drop.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  const f = els.file.files?.[0];
  if (f) loadFile(f);
});
els.drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.drop.classList.add('over');
});
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

els.fetchUrl.addEventListener('click', async () => {
  const url = els.url.value.trim();
  if (!url) return;
  setStatus('Завантаження сторінки…');
  const proxy = els.proxy.value.trim();
  const attempts = [url, ...(proxy ? [proxy + encodeURIComponent(url)] : [])];
  for (const u of attempts) {
    try {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      source = await res.text();
      els.html.value = source;
      if (!els.baseUrl.value.trim()) els.baseUrl.value = url;
      render();
      return;
    } catch {
      /* try next */
    }
  }
  setStatus(
    'Не вдалося завантажити сторінку (ймовірно, CORS). Вкажіть CORS-проксі в розширених налаштуваннях або збережіть сторінку як .html і відкрийте як файл.',
    true,
  );
});

for (const b of els.presets.querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    els.vw.value = b.dataset.w!;
    els.vh.value = b.dataset.h!;
    saveSettings();
    render();
  });
}
for (const input of [els.vw, els.vh]) {
  input.addEventListener('change', () => {
    saveSettings();
    render();
  });
}
for (const input of [els.textMode, els.autoLayout, els.flatten, els.proxy]) input.addEventListener('change', saveSettings);
for (const input of [els.scripts, els.baseUrl, els.mode, els.slideSelector]) {
  input.addEventListener('change', () => {
    saveSettings();
    render();
  });
}
els.refresh.addEventListener('click', render);
els.import.addEventListener('click', startCapture);
window.addEventListener('resize', layoutPreview);
syncPresets();
