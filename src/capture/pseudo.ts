// ::before / ::after and list markers have no DOM nodes, so their geometry can't be
// measured. We replace them with real <h2f-pseudo> elements carrying a copy of the
// pseudo-element's computed style, and disable the original pseudo-elements.

export const PSEUDO_TAG = 'h2f-pseudo';

const NO_PSEUDO = new Set([
  'IMG', 'INPUT', 'TEXTAREA', 'SELECT', 'BR', 'HR', 'IFRAME', 'VIDEO', 'AUDIO', 'CANVAS',
  'OBJECT', 'EMBED', 'SVG', 'svg', 'METER', 'PROGRESS', 'SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK',
]);

function unescapeCss(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex, ch) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : ch,
  );
}

/** Resolves the `content` property into text (or an image url). Returns null if no box is generated. */
function resolveContent(content: string, el: Element): { text: string; image?: string } | null {
  if (!content || content === 'none' || content === 'normal') return null;
  let text = '';
  let image: string | undefined;
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([\w-]+)\s*\)|url\(\s*(['"]?)(.*?)\4\s*\)|(counters?\([^)]*\))|(open-quote|close-quote|no-open-quote|no-close-quote)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[1] !== undefined) text += unescapeCss(m[1]);
    else if (m[2] !== undefined) text += unescapeCss(m[2]);
    else if (m[3]) text += el.getAttribute(m[3]) ?? '';
    else if (m[5] !== undefined) image = m[5];
    else if (m[6]) text += resolveCounter(m[6], el);
    else if (m[7] === 'open-quote') text += '“';
    else if (m[7] === 'close-quote') text += '”';
  }
  // Content alternative text after "/" is not rendered.
  return { text, image };
}

/** Best-effort counter() support: counts same-tag previous siblings (covers most list numbering). */
function resolveCounter(expr: string, el: Element): string {
  const style = /,\s*([\w-]+)\s*\)$/.exec(expr)?.[1] ?? 'decimal';
  let n = 1;
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === el.tagName) n++;
    sib = sib.previousElementSibling;
  }
  return formatCounter(n, style);
}

function toRoman(n: number): string {
  const map: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

function toAlpha(n: number): string {
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

export function formatCounter(n: number, style: string): string {
  switch (style) {
    case 'decimal-leading-zero': return n < 10 ? `0${n}` : String(n);
    case 'lower-alpha': case 'lower-latin': return toAlpha(n);
    case 'upper-alpha': case 'upper-latin': return toAlpha(n).toUpperCase();
    case 'lower-roman': return toRoman(n);
    case 'upper-roman': return toRoman(n).toUpperCase();
    case 'lower-greek': return String.fromCharCode(945 + ((n - 1) % 24));
    default: return String(n);
  }
}

function markerText(li: Element, type: string): string | null {
  switch (type) {
    case 'none': return null;
    case 'disc': return '•';
    case 'circle': return '◦';
    case 'square': return '▪';
    case 'disclosure-closed': return '\u25B6';
    case 'disclosure-open': return '\u25BC';
  }
  if (/^["']/.test(type)) return unescapeCss(type.slice(1, -1));
  // Ordinal list
  const parent = li.parentElement;
  let n = 1;
  if (parent) {
    const reversed = parent.tagName === 'OL' && parent.hasAttribute('reversed');
    const items = [...parent.children].filter((c) => getComputedStyle(c).display === 'list-item');
    const startAttr = parent.getAttribute('start');
    let value = startAttr !== null ? parseInt(startAttr, 10) : reversed ? items.length : 1;
    for (const item of items) {
      const v = item.getAttribute('value');
      if (v !== null && !isNaN(parseInt(v, 10))) value = parseInt(v, 10);
      if (item === li) break;
      value += reversed ? -1 : 1;
    }
    n = value;
  }
  return formatCounter(n, type) + '.';
}

interface PseudoJob {
  el: Element;
  where: 'before' | 'after' | 'marker';
  text: string;
  image?: string;
  style: string;
  inside?: boolean;
}

function cssTextOf(cs: CSSStyleDeclaration): string {
  let out = '';
  for (let i = 0; i < cs.length; i++) {
    const name = cs[i];
    if (name === 'content' || name.startsWith('transition') || name.startsWith('animation')) continue;
    out += `${name}:${cs.getPropertyValue(name)};`;
  }
  return out;
}

export function materializePseudoElements(doc: Document): void {
  const jobs: PseudoJob[] = [];
  const all = doc.body ? doc.body.querySelectorAll('*') : [];
  // 1) read phase
  for (const el of all) {
    if (NO_PSEUDO.has(el.tagName) || el.closest('svg')) continue;
    const ownStyle = getComputedStyle(el);
    if (ownStyle.display === 'none') continue;
    for (const where of ['before', 'after'] as const) {
      const cs = getComputedStyle(el, `::${where}`);
      const content = resolveContent(cs.content, el);
      if (!content || cs.display === 'none') continue;
      jobs.push({ el, where, text: content.text, image: content.image, style: cssTextOf(cs) });
    }
    if (ownStyle.display === 'list-item') {
      const type = ownStyle.listStyleType;
      const text = markerText(el, type);
      if (text && ownStyle.listStyleImage === 'none') {
        const ms = getComputedStyle(el, '::marker');
        const inside = ownStyle.listStylePosition === 'inside';
        const font = `font-family:${ms.fontFamily};font-size:${ms.fontSize};font-weight:${ms.fontWeight};font-style:${ms.fontStyle};color:${ms.color};`;
        jobs.push({
          el,
          where: 'marker',
          text: inside ? `${text} ` : `${text} `,
          inside,
          style: inside
            ? `${font}display:inline;white-space:pre;`
            : `${font}position:absolute;display:inline;white-space:pre;transform:translateX(-100%);margin:0;padding:0;background:none;border:0;line-height:inherit;`,
        });
      }
    }
  }
  if (!jobs.length) return;

  // 2) write phase
  const style = doc.createElement('style');
  style.setAttribute('data-h2f', '');
  style.textContent =
    '[data-h2f-before]::before{content:none!important;display:none!important}' +
    '[data-h2f-after]::after{content:none!important;display:none!important}' +
    '[data-h2f-marker]{list-style-type:none!important}' +
    `${PSEUDO_TAG}{display:inline}`;
  for (const job of jobs) {
    const node = doc.createElement(PSEUDO_TAG);
    node.setAttribute('style', job.style);
    node.setAttribute('data-pseudo', job.where);
    if (job.image) {
      const img = doc.createElement('img');
      img.src = job.image;
      img.setAttribute('style', 'display:inline-block;vertical-align:baseline');
      node.appendChild(img);
    }
    if (job.text) node.appendChild(doc.createTextNode(job.text));
    if (job.where === 'before' || job.where === 'marker') job.el.insertBefore(node, job.el.firstChild);
    else job.el.appendChild(node);
    if (job.where === 'marker') {
      // Outside markers stay out of flow, so removing the native marker doesn't shift layout.
      job.el.setAttribute('data-h2f-marker', '');
    } else {
      job.el.setAttribute(`data-h2f-${job.where}`, '');
    }
  }
  doc.head.appendChild(style);
}
