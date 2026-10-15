// Presentation support: finds the slides of an HTML deck (Claude-generated decks, reveal.js,
// remark, scroll-snap decks…) and shows them one at a time in their natural, unscaled size.

export interface SlideInfo {
  elements: Element[];
  width: number;
  height: number;
  /** slides are as large as the viewport (sized with vw/vh or 100%) */
  viewportSized: boolean;
  selector: string;
}

interface Candidate {
  selector: string;
  /** generic selectors must look like slides (size / aspect checks) */
  strict: boolean;
  /** keep all matches instead of the largest sibling group (reveal.js vertical stacks) */
  keepAll?: boolean;
}

const CANDIDATES: Candidate[] = [
  { selector: '.reveal .slides section:not(:has(> section))', strict: false, keepAll: true },
  { selector: '.remark-slide-container', strict: false },
  { selector: '[data-slide]', strict: false },
  { selector: '.slide', strict: true },
  { selector: '.slides > section, .slides > div', strict: true },
  { selector: '.deck > section, .deck > div, .presentation > section', strict: true },
  { selector: '[class*="slide"]:not([class*="slides"]):not([class*="slider"])', strict: true },
  { selector: 'body > section, main > section, body > div > section', strict: true },
];

/** Classes decks commonly use to mark the visible slide. */
const ACTIVE_CLASSES = [
  'active', 'current', 'present', 'is-active', 'is-current', 'visible', 'show', 'shown',
  'selected', 'slide-active', 'current-slide', 'active-slide', 'remark-visible',
];

function query(doc: Document, selector: string): Element[] {
  try {
    return [...doc.querySelectorAll(selector)];
  } catch {
    return []; // e.g. :has() unsupported
  }
}

function outermost(els: Element[]): Element[] {
  const set = new Set(els);
  return els.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
    return true;
  });
}

function largestSiblingGroup(els: Element[]): Element[] {
  const groups = new Map<Element | null, Element[]>();
  for (const el of els) {
    const key = el.parentElement;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(el);
  }
  let best: Element[] = [];
  for (const g of groups.values()) if (g.length > best.length) best = g;
  return best;
}

/** Layout size without transforms (decks are usually scaled to fit the window). */
function naturalSize(el: Element): { w: number; h: number } {
  if (el instanceof HTMLElement && el.offsetWidth) return { w: el.offsetWidth, h: el.offsetHeight };
  const r = el.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

function looksLikeSlides(els: Element[], strict: boolean, selector: string): boolean {
  const win = els[0].ownerDocument.defaultView!;
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const visible = els.map(naturalSize).filter((s) => s.w > 0 && s.h > 0);
  if (!visible.length) return !strict;
  return visible.every((s) => {
    const aspect = s.w / s.h;
    if (s.w < 240 || s.h < 135) return false;
    if (!strict) return true;
    // Sections of an ordinary landing page are not slides: they must fill the viewport…
    if (/section/.test(selector) && !/slide|deck|presentation/.test(selector)) {
      return Math.abs(s.h - vh) <= vh * 0.03 && Math.abs(s.w - vw) <= vw * 0.03;
    }
    // …and a carousel item is not a slide either: slides are big and landscape-ish.
    return aspect >= 1.2 && aspect <= 2.4 && s.w >= Math.min(vw * 0.4, 640);
  });
}

export function findSlides(doc: Document, userSelector?: string): SlideInfo | null {
  const candidates: Candidate[] = userSelector?.trim()
    ? [{ selector: userSelector.trim(), strict: false, keepAll: true }]
    : CANDIDATES;
  const min = userSelector?.trim() ? 1 : 2;
  for (const c of candidates) {
    let els = query(doc, c.selector).filter((el) => !el.closest('[data-h2f-ignore]'));
    if (!c.keepAll) els = largestSiblingGroup(outermost(els));
    else els = outermost(els);
    if (els.length < min || !looksLikeSlides(els, c.strict, c.selector)) continue;
    const sizes = els.map(naturalSize).filter((s) => s.w > 0 && s.h > 0);
    const size = sizes[0] ?? { w: 0, h: 0 };
    const win = doc.defaultView!;
    return {
      elements: els,
      width: Math.round(size.w),
      height: Math.round(size.h),
      viewportSized: Math.abs(size.w - win.innerWidth) < 2 && Math.abs(size.h - win.innerHeight) < 2,
      selector: c.selector,
    };
  }
  return null;
}

const SLIDE_STYLE = `
[data-h2f-slide]:not([data-h2f-current]){display:none!important}
[data-h2f-current]{visibility:visible!important;opacity:1!important;transform:none!important;translate:none!important;scale:none!important;rotate:none!important;zoom:1!important;filter:none!important;transition:none!important}
[data-h2f-anc]{transform:none!important;translate:none!important;scale:none!important;rotate:none!important;zoom:1!important;opacity:1!important;visibility:visible!important;filter:none!important}
[data-h2f-force-display]{display:block!important}
[data-h2f-current] .fragment,[data-h2f-current] [data-fragment-index]{opacity:1!important;visibility:visible!important;transform:none!important}
`;

/** Shows one slide at a time; `restore()` puts the deck back as it was. */
export class SlideStage {
  private style: HTMLStyleElement;
  private activeClasses: string[];
  private original = new Map<Element, { className: string; hidden: boolean; ariaHidden: string | null }>();

  constructor(private slides: Element[]) {
    const doc = slides[0].ownerDocument;
    this.style = doc.createElement('style');
    this.style.setAttribute('data-h2f', '');
    this.style.textContent = SLIDE_STYLE;
    doc.head.appendChild(this.style);
    // Only toggle state classes the deck actually uses (present on some slides, not all).
    this.activeClasses = ACTIVE_CLASSES.filter((cls) => {
      const n = slides.filter((s) => s.classList.contains(cls)).length;
      return n > 0 && n < slides.length;
    });
    for (const s of slides) {
      this.original.set(s, {
        className: s.getAttribute('class') ?? '',
        hidden: s.hasAttribute('hidden'),
        ariaHidden: s.getAttribute('aria-hidden'),
      });
      s.setAttribute('data-h2f-slide', '');
    }
  }

  show(index: number): Element {
    this.clearMarks();
    this.slides.forEach((s, i) => {
      const current = i === index;
      s.toggleAttribute('data-h2f-current', current);
      for (const cls of this.activeClasses) s.classList.toggle(cls, current);
      if (current) {
        s.removeAttribute('hidden');
        s.removeAttribute('aria-hidden');
      }
    });
    const slide = this.slides[index];
    const chain: Element[] = [];
    for (let p = slide.parentElement; p && p !== slide.ownerDocument.documentElement; p = p.parentElement) {
      p.setAttribute('data-h2f-anc', '');
      chain.unshift(p);
    }
    // Hidden containers (e.g. reveal.js vertical stacks) and slides whose deck shows them some
    // other way than a class must still be laid out.
    for (const el of [...chain, slide]) {
      if (getComputedStyle(el).display === 'none') el.setAttribute('data-h2f-force-display', '');
    }
    return slide;
  }

  private clearMarks(): void {
    const doc = this.slides[0].ownerDocument;
    for (const el of doc.querySelectorAll('[data-h2f-anc]')) el.removeAttribute('data-h2f-anc');
    for (const el of doc.querySelectorAll('[data-h2f-force-display]')) el.removeAttribute('data-h2f-force-display');
  }

  restore(): void {
    for (const [s, o] of this.original) {
      s.setAttribute('class', o.className);
      if (o.hidden) s.setAttribute('hidden', '');
      if (o.ariaHidden !== null) s.setAttribute('aria-hidden', o.ariaHidden);
      s.removeAttribute('data-h2f-slide');
      s.removeAttribute('data-h2f-current');
    }
    this.clearMarks();
    this.style.remove();
  }
}

export function slideTitle(slide: Element, index: number): string {
  const heading = slide.querySelector('h1, h2, h3, [class*="title"]');
  const text = heading?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 50);
  return `Слайд ${index + 1}${text ? ` — ${text}` : ''}`;
}
