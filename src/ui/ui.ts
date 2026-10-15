import type { CaptureOptions, CaptureResult, MainToUI } from '../shared/types';
import { DEMO_HTML } from './demo';

declare const CAPTURE_SCRIPT: string;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  html: $<HTMLTextAreaElement>('html'),
  file: $<HTMLInputElement>('file'),
  drop: $('drop'),
  demo: $<HTMLButtonElement>('demo'),
  codeEditor: $('codeEditor'),
  urlEditor: $('urlEditor'),
  sourceChip: $('sourceChip'),
  sourceName: $('sourceName'),
  sourceMeta: $('sourceMeta'),
  sourceHint: $('sourceHint'),
  editCode: $<HTMLButtonElement>('editCode'),
  clear: $<HTMLButtonElement>('clear'),
  url: $<HTMLInputElement>('url'),
  fetchUrl: $<HTMLButtonElement>('fetchUrl'),
  vw: $<HTMLInputElement>('vw'),
  vh: $<HTMLInputElement>('vh'),
  presets: $('presets'),
  textMode: $<HTMLSelectElement>('textMode'),
  mode: $<HTMLSelectElement>('mode'),
  modeHint: $('modeHint'),
  textHint: $('textHint'),
  slideSelector: $<HTMLInputElement>('slideSelector'),
  autoLayout: $<HTMLInputElement>('autoLayout'),
  flatten: $<HTMLInputElement>('flatten'),
  scripts: $<HTMLInputElement>('scripts'),
  baseUrl: $<HTMLInputElement>('baseUrl'),
  proxy: $<HTMLInputElement>('proxy'),
  refresh: $<HTMLButtonElement>('refresh'),
  previewSection: $('previewSection'),
  previewWrap: $('previewWrap'),
  scaler: $('scaler'),
  shimmer: $('shimmer'),
  kindBadge: $('kindBadge'),
  kindText: $('kindText'),
  sizeBadge: $('sizeBadge'),
  steps: $('steps'),
  status: $('status'),
  result: $('result'),
  resultText: $('resultText'),
  warnBox: $<HTMLDetailsElement>('warnBox'),
  warnCount: $('warnCount'),
  warnings: $('warnings'),
  import: $<HTMLButtonElement>('import'),
  importLabel: $('importLabel'),
  dropOverlay: $('dropOverlay'),
  grip: $('grip') as unknown as SVGElement,
};

let source = '';
let iframe: HTMLIFrameElement | null = null;
let ready = false;
let capturing = false;
/** viewport was switched to 1920×1080 automatically for a viewport-sized deck */
let autoSized = false;
/** where the current source came from, for the source chip */
let sourceLabel = { name: '', origin: '' };
/** last detection result from the rendered page */
let detected: { slides: { count: number; width: number; height: number } | null; height: number; title: string } | null = null;

// ---------- messaging ----------

function toMain(msg: unknown) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

function setStatus(text: string, kind: 'info' | 'error' | 'ok' = 'info') {
  els.status.textContent = text;
  els.status.classList.toggle('error', kind === 'error');
  els.status.classList.toggle('ok', kind === 'ok');
}

/** Import pipeline progress: 0 render, 1 analysis, 2 images, 3 layers. */
function setStep(step: number, ratio = 0) {
  els.steps.hidden = step < 0;
  for (const el of els.steps.querySelectorAll<HTMLElement>('.step')) {
    const i = Number(el.dataset.step);
    el.classList.toggle('done', i < step);
    el.classList.toggle('active', i === step);
    const bar = el.querySelector<HTMLElement>('.bar i')!;
    bar.style.width = i < step ? '100%' : i === step ? `${Math.max(8, Math.round(ratio * 100))}%` : '0';
  }
}

function setBusy(busy: boolean) {
  capturing = busy;
  els.import.classList.toggle('busy', busy);
  els.import.disabled = busy || !ready;
  const spinner = els.import.querySelector('.spinner');
  if (busy && !spinner) els.import.insertAdjacentHTML('afterbegin', '<span class="spinner"></span>');
  if (!busy && spinner) spinner.remove();
}

function showWarnings(list: string[]) {
  els.warnings.innerHTML = '';
  els.warnBox.hidden = !list.length;
  els.warnBox.open = false;
  els.warnCount.textContent = `${list.length} ${list.length === 1 ? 'попередження' : list.length < 5 ? 'попередження' : 'попереджень'}`;
  for (const w of list.slice(0, 50)) {
    const li = document.createElement('li');
    li.textContent = w;
    els.warnings.appendChild(li);
  }
}

function showResult(text: string | null) {
  els.result.hidden = !text;
  els.resultText.textContent = text ?? '';
  // The result card replaces the status line (its text stays for screen readers / tests).
  els.status.hidden = !!text;
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

const MODE_HINTS: Record<string, string> = {
  auto: 'Презентацію буде розпізнано автоматично, решта — одна сторінка',
  page: 'Уся сторінка — один фрейм',
  slides: 'Кожен слайд — окремий фрейм у секції',
};
const TEXT_HINTS: Record<string, string> = {
  exact: 'Рядки переносяться точно як у браузері',
  paragraph: 'Абзаци з автопереносом — зручніше редагувати текст',
};

function syncSegments() {
  for (const seg of document.querySelectorAll<HTMLElement>('.seg[data-bind]')) {
    const select = document.getElementById(seg.dataset.bind!) as HTMLSelectElement;
    for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.value === select.value));
  }
  els.modeHint.textContent = MODE_HINTS[els.mode.value] ?? '';
  els.textHint.textContent = TEXT_HINTS[els.textMode.value] ?? '';
}

function syncPresets() {
  syncSegments();
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
  detected = null;
  els.import.disabled = true;
  showWarnings([]);
  showResult(null);
  setStep(-1);
  if (iframe) {
    iframe.remove();
    iframe = null;
  }
  const has = !!source.trim();
  els.previewSection.hidden = !has;
  els.clear.hidden = !has;
  updateSourceUI();
  if (!has) {
    setStatus('');
    updateImportLabel();
    return;
  }
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
  els.shimmer.hidden = false;
  els.kindBadge.hidden = true;
  els.sizeBadge.hidden = true;
  layoutPreview();
  setStatus('Рендеринг сторінки…');
}

function layoutPreview() {
  const opts = options();
  const avail = els.previewWrap.clientWidth || 400;
  const scale = avail / opts.viewportWidth;
  els.scaler.style.transform = `scale(${scale})`;
  els.scaler.style.width = `${opts.viewportWidth}px`;
  els.previewWrap.style.height = iframe ? `${Math.round(Math.min(opts.viewportHeight * scale, 300))}px` : '';
}

function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Source area: drop zone when empty, editors when open, a compact chip when loaded. */
let editor: 'none' | 'code' | 'url' = 'none';
function updateSourceUI() {
  const has = !!source.trim();
  els.drop.hidden = has || editor !== 'none';
  els.codeEditor.hidden = editor !== 'code';
  els.urlEditor.hidden = editor !== 'url';
  els.sourceChip.hidden = !has || editor === 'code';
  if (has) {
    const title = detected?.title || sourceLabel.name || 'HTML';
    els.sourceName.textContent = title;
    const parts = [sourceLabel.origin, formatSize(new Blob([source]).size)].filter(Boolean);
    els.sourceMeta.textContent = parts.join(' · ');
  }
  els.sourceHint.textContent = has ? '' : 'HTML-сторінка або презентація';
}

function openEditor(kind: 'none' | 'code' | 'url') {
  editor = kind;
  updateSourceUI();
  if (kind === 'code') els.html.focus();
  if (kind === 'url') els.url.focus();
}

function setSource(html: string, name: string, origin: string) {
  source = html;
  els.html.value = html;
  sourceLabel = { name, origin };
  autoSized = false;
  if (editor !== 'code') editor = 'none';
  render();
}

function updateImportLabel() {
  const opts = options();
  const slides = detected?.slides && opts.mode !== 'page' ? detected.slides : null;
  els.importLabel.textContent = slides ? `Імпортувати ${slidesWord(slides.count)}` : 'Імпортувати у Figma';
}

let renderTimer = 0;
function scheduleRender(delay = 500) {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(render, delay);
}

// ---------- capture ----------

function startCapture() {
  if (!iframe?.contentWindow || !ready || capturing) return;
  setBusy(true);
  showWarnings([]);
  showResult(null);
  setStep(1, 0.05);
  setStatus('Підготовка…');
  iframe.contentWindow.postMessage({ h2f: true, type: 'capture', options: options() }, '*');
}

window.addEventListener('message', (e) => {
  const data = e.data;
  // Messages from the plugin main thread
  if (data && data.pluginMessage) {
    const msg = data.pluginMessage as MainToUI;
    if (msg.type === 'settings') applySettings(msg.settings as Record<string, unknown>);
    else if (msg.type === 'progress') {
      setStep(3, msg.ratio ?? 0.1);
      setStatus(msg.message);
    } else if (msg.type === 'done') {
      setBusy(false);
      setStep(4);
      setStatus(msg.message, 'ok');
      showResult(`${msg.message.replace(/^Готово:\s*/, '')} — шари вже на полотні й виділені`);
      showWarnings(msg.warnings);
    } else if (msg.type === 'error') {
      setBusy(false);
      setStep(-1);
      setStatus(msg.message, 'error');
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
    detected = { slides, height: data.height, title: data.title || '' };
    els.import.disabled = false;
    els.shimmer.hidden = true;
    updateSourceUI();
    updateImportLabel();
    els.kindBadge.hidden = false;
    els.sizeBadge.hidden = false;
    if (asSlides) {
      els.kindText.textContent = `Презентація · ${slidesWord(slides.count)}`;
      els.sizeBadge.textContent = `${slides.width} × ${slides.height}`;
      setStatus('Кожен слайд стане окремим фреймом');
    } else {
      els.kindText.textContent = 'Сторінка';
      els.sizeBadge.textContent = `${opts.viewportWidth} × ${data.height}`;
      if (opts.mode === 'slides') setStatus('Слайди не знайдено — вкажіть CSS-селектор слайдів у розширених налаштуваннях', 'error');
      else setStatus('Сторінка стане одним фреймом');
    }
  } else if (data.type === 'progress') {
    const images = /Зображення/.test(data.message);
    setStep(images ? 2 : 1, data.ratio ?? 0.3);
    setStatus(data.message);
  } else if (data.type === 'error') {
    setBusy(false);
    setStep(-1);
    setStatus(`Помилка аналізу сторінки: ${data.message}`, 'error');
  } else if (data.type === 'result') {
    const result = data.result as CaptureResult;
    setStep(3, 0.05);
    setStatus('Створення шарів у Figma…');
    toMain({ type: 'import', result, options: options() });
  }
});

// ---------- inputs ----------

const looksLikeHtml = (t: string) => /<\/?[a-z!][\s\S]*>/i.test(t);

els.html.addEventListener('input', () => {
  source = els.html.value;
  sourceLabel = { name: '', origin: 'вставлений код' };
  autoSized = false;
  scheduleRender();
});

async function loadFile(file: File) {
  setSource(await file.text(), file.name.replace(/\.x?html?$/i, ''), file.name);
}

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-source]')) {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const kind = b.dataset.source;
    if (kind === 'file') els.file.click();
    else openEditor(kind === 'url' ? 'url' : 'code');
  });
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-close-editor]')) {
  b.addEventListener('click', () => openEditor('none'));
}
els.editCode.addEventListener('click', () => openEditor('code'));
els.demo.addEventListener('click', (e) => {
  e.stopPropagation();
  setSource(DEMO_HTML, 'Демо-презентація', 'вбудований приклад');
});
els.clear.addEventListener('click', () => {
  els.html.value = '';
  els.file.value = '';
  editor = 'none';
  setSource('', '', '');
});
els.file.addEventListener('change', () => {
  const f = els.file.files?.[0];
  if (f) loadFile(f);
});

// Drag a file anywhere into the plugin window.
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  els.dropOverlay.hidden = false;
  els.drop.classList.add('over');
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) {
    els.dropOverlay.hidden = true;
    els.drop.classList.remove('over');
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  els.drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// Paste HTML anywhere (outside text fields).
document.addEventListener('paste', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('input, textarea')) return;
  const text = e.clipboardData?.getData('text/plain') || e.clipboardData?.getData('text/html') || '';
  if (!looksLikeHtml(text)) {
    setStatus('У буфері обміну немає HTML-коду', 'error');
    return;
  }
  e.preventDefault();
  setSource(text, '', 'вставлений код');
});

// ⌘/Ctrl + Enter imports.
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    startCapture();
  }
  if (e.key === 'Escape' && editor !== 'none' && source.trim()) openEditor('none');
});

async function fetchUrl() {
  const url = els.url.value.trim();
  if (!url) return;
  setStatus('Завантаження сторінки…');
  els.fetchUrl.disabled = true;
  const proxy = els.proxy.value.trim();
  const attempts = [url, ...(proxy ? [proxy + encodeURIComponent(url)] : [])];
  try {
    for (const u of attempts) {
      try {
        const res = await fetch(u);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!els.baseUrl.value.trim()) els.baseUrl.value = url;
        editor = 'none';
        setSource(text, new URL(url).hostname, url);
        return;
      } catch {
        /* try next */
      }
    }
    setStatus('Не вдалося завантажити сторінку (ймовірно, CORS). Вкажіть CORS-проксі в розширених налаштуваннях або збережіть сторінку як .html.', 'error');
  } finally {
    els.fetchUrl.disabled = false;
  }
}
els.fetchUrl.addEventListener('click', fetchUrl);
els.url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchUrl();
});

for (const b of els.presets.querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    els.vw.value = b.dataset.w!;
    els.vh.value = b.dataset.h!;
    saveSettings();
    render();
  });
}
for (const seg of document.querySelectorAll<HTMLElement>('.seg[data-bind]')) {
  const select = document.getElementById(seg.dataset.bind!) as HTMLSelectElement;
  for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
    b.addEventListener('click', () => {
      if (select.value === b.dataset.value) return;
      select.value = b.dataset.value!;
      select.dispatchEvent(new Event('change'));
    });
  }
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

// Resize the plugin window by dragging the corner grip.
els.grip.addEventListener('pointerdown', (e) => {
  const start = { x: e.clientX, y: e.clientY, w: window.innerWidth, h: window.innerHeight };
  els.grip.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    const width = Math.max(360, Math.min(900, start.w + ev.clientX - start.x));
    const height = Math.max(480, Math.min(1100, start.h + ev.clientY - start.y));
    toMain({ type: 'resize', width, height });
  };
  const up = () => {
    els.grip.removeEventListener('pointermove', move);
    els.grip.removeEventListener('pointerup', up);
  };
  els.grip.addEventListener('pointermove', move);
  els.grip.addEventListener('pointerup', up);
});

// Shortcut hints match the platform.
if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
  document.getElementById('importKbd')!.textContent = 'Ctrl ↵';
  document.getElementById('pasteKbd')!.textContent = 'Ctrl V';
}

syncPresets();
updateSourceUI();
