// Inline <svg> → standalone SVG string that Figma's createNodeFromSvg can parse.
// Styles coming from page CSS (classes, currentColor, CSS variables) are baked in as attributes.

const SVG_NS = 'http://www.w3.org/2000/svg';

const PRESENTATION_PROPS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
  'stroke-dashoffset', 'opacity', 'stop-color', 'stop-opacity', 'font-family',
  'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
  'visibility', 'display', 'clip-rule',
];

const DEFAULTS: Record<string, string> = {
  'fill-opacity': '1', 'stroke-opacity': '1', opacity: '1', 'stroke-miterlimit': '4',
  'stroke-dasharray': 'none', 'stroke-dashoffset': '0px', 'fill-rule': 'nonzero',
  'clip-rule': 'nonzero', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter',
  'stop-opacity': '1', visibility: 'visible', display: 'inline', 'text-anchor': 'start',
  'dominant-baseline': 'auto', 'font-style': 'normal',
};

const INHERITED = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
  'stroke-dashoffset', 'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'visibility', 'clip-rule',
]);

/**
 * Bakes computed presentation styles of `src` into `dst` as attributes.
 * Inherited properties are only written when they differ from the parent's value,
 * so content inlined from sprites keeps inheriting from its new <use> context.
 */
function bakeStyles(src: Element, dst: Element, parentStyle: CSSStyleDeclaration | null, isRoot: boolean): void {
  const cs = getComputedStyle(src);
  const tag = src.tagName.toLowerCase();
  for (const prop of PRESENTATION_PROPS) {
    let v = cs.getPropertyValue(prop);
    if (!v) continue;
    if (prop === 'display') {
      if (v === 'none') dst.setAttribute('display', 'none');
      continue;
    }
    if (prop.startsWith('stop-') && tag !== 'stop') continue;
    if (INHERITED.has(prop)) {
      if (!isRoot && parentStyle && parentStyle.getPropertyValue(prop) === v) continue;
      if (isRoot && DEFAULTS[prop] === v) continue;
    } else if (DEFAULTS[prop] === v) {
      continue;
    }
    if (v.includes('url(')) {
      // Keep only the local reference: url("#id")
      const m = /url\(\s*["']?[^#"')]*(#[^"')]+)["']?\s*\)/.exec(v);
      if (!m) continue;
      v = `url(${m[1]})`;
    }
    dst.setAttribute(prop, v);
  }
  // Root fill defaults to black in SVG; make it explicit when it inherits something else.
  if (isRoot && !dst.hasAttribute('fill')) dst.setAttribute('fill', cs.getPropertyValue('fill') || 'black');
  dst.removeAttribute('style');
  dst.removeAttribute('class');
}

function walk(src: Element, dst: Element, parentStyle: CSSStyleDeclaration | null, isRoot = false): void {
  bakeStyles(src, dst, parentStyle, isRoot);
  const own = getComputedStyle(src);
  const sChildren = src.children;
  const dChildren = dst.children;
  for (let i = 0; i < sChildren.length && i < dChildren.length; i++) walk(sChildren[i], dChildren[i], own);
}

/** Inlines <use href="#id"> references (icon sprites) so the SVG is self-contained. */
function inlineUses(svg: Element, srcDoc: Document, depth = 0): void {
  if (depth > 3) return;
  const uses = [...svg.querySelectorAll('use')];
  for (const use of uses) {
    const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
    if (!href.startsWith('#')) continue;
    const ref = srcDoc.getElementById(href.slice(1));
    if (!ref) continue;
    const g = srcDoc.createElementNS(SVG_NS, 'g');
    const x = parseFloat(use.getAttribute('x') || '0');
    const y = parseFloat(use.getAttribute('y') || '0');
    for (const attr of use.getAttributeNames()) {
      if (['href', 'xlink:href', 'x', 'y', 'width', 'height'].includes(attr)) continue;
      g.setAttribute(attr, use.getAttribute(attr)!);
    }
    if (x || y) g.setAttribute('transform', `${g.getAttribute('transform') || ''} translate(${x} ${y})`.trim());
    // Bake the referenced content's own (non-inherited-from-sprite) styles.
    const refClone = ref.cloneNode(true) as Element;
    walk(ref, refClone, ref.parentElement ? getComputedStyle(ref.parentElement) : null);
    if (ref.tagName.toLowerCase() === 'symbol') {
      const inner = srcDoc.createElementNS(SVG_NS, 'svg');
      for (const a of ['viewBox', 'preserveAspectRatio']) {
        const v = ref.getAttribute(a);
        if (v) inner.setAttribute(a, v);
      }
      inner.setAttribute('width', use.getAttribute('width') || '100%');
      inner.setAttribute('height', use.getAttribute('height') || '100%');
      inner.setAttribute('overflow', 'visible');
      while (refClone.firstChild) inner.appendChild(refClone.firstChild);
      g.appendChild(inner);
    } else {
      refClone.removeAttribute('id');
      g.appendChild(refClone);
    }
    use.replaceWith(g);
  }
  if (svg.querySelector('use')) inlineUses(svg, srcDoc, depth + 1);
}

export function serializeSvg(svg: SVGSVGElement, width: number, height: number): string {
  const doc = svg.ownerDocument;
  const out = svg.cloneNode(true) as SVGSVGElement;
  // Styles are read from the original (live) elements so page CSS selectors still match.
  walk(svg, out, svg.parentElement ? getComputedStyle(svg.parentElement) : null, true);
  inlineUses(out, doc);
  out.setAttribute('xmlns', SVG_NS);
  out.setAttribute('width', String(Math.max(0.01, Math.round(width * 100) / 100)));
  out.setAttribute('height', String(Math.max(0.01, Math.round(height * 100) / 100)));
  if (!out.getAttribute('viewBox')) {
    const w = parseFloat(svg.getAttribute('width') || '') || width;
    const h = parseFloat(svg.getAttribute('height') || '') || height;
    out.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
  out.removeAttribute('opacity'); // applied on the Figma node instead
  out.removeAttribute('x');
  out.removeAttribute('y');
  let str = new XMLSerializer().serializeToString(out);
  const color = getComputedStyle(svg).color;
  str = str.replace(/currentColor/gi, color);
  return str;
}

export function svgImageToString(text: string, width: number, height: number): string | null {
  try {
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = parsed.documentElement;
    if (!root || root.tagName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) return null;
    if (!root.getAttribute('viewBox')) {
      const w = parseFloat(root.getAttribute('width') || '');
      const h = parseFloat(root.getAttribute('height') || '');
      if (w && h) root.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    root.setAttribute('width', String(width));
    root.setAttribute('height', String(height));
    root.setAttribute('preserveAspectRatio', root.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
    return new XMLSerializer().serializeToString(root);
  } catch {
    return null;
  }
}
