// Converts a run of inline content (text nodes inside inline elements) into Figma text specs.
// The browser has already laid the text out, so we measure every character to learn exactly
// where lines wrap, where inline padding/margins create gaps, and how far apart lines are.

import type { FillSpec, FontSpec, Matrix, RGBA, ShadowSpec, TextRun, TextSpec } from '../shared/types';
import { parseColor } from './color';
import { parseGradient, parseShadows, px, splitTopLevel } from './css';

export interface InlineText {
  kind: 'text';
  node: Text;
  /** element that provides the computed style */
  el: Element;
}
export interface InlineBreak {
  kind: 'br';
}
export type InlineItem = InlineText | InlineBreak;

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface RunStyle {
  key: string;
  font: FontSpec;
  size: number;
  color: RGBA;
  lineHeight: number | null;
  letterSpacing: number;
  decoration: TextRun['decoration'];
  textCase: TextRun['textCase'];
  href?: string;
  shadows: ShadowSpec[];
  /** element whose background is clipped to the text (gradient text) */
  clipEl?: Element;
  /** vertical-align of the nearest inline ancestor (sub/sup/top… shift the baseline) */
  valign: string;
}

interface Seg {
  text: string;
  runs: TextRun[];
  styles: RunStyle[]; // style per run (same index)
  rect: Rect | null;
  /** rect of the biggest-font glyph, used for baseline/vertical placement */
  main: { size: number; top: number; bottom: number } | null;
  trimmedSpace: boolean;
  spaceWidth: number;
}

interface Line {
  segs: Seg[];
}

const styleCache = new WeakMap<Element, RunStyle>();
const decoCache = new WeakMap<Element, Set<string>>();

function decorationOf(el: Element): Set<string> {
  let d = decoCache.get(el);
  if (d) return d;
  const cs = getComputedStyle(el);
  const own = cs.textDecorationLine || '';
  d = new Set<string>();
  if (own.includes('underline')) d.add('underline');
  if (own.includes('line-through')) d.add('line-through');
  // Decorations propagate to descendants except into atomic / out-of-flow boxes.
  const atomic =
    /^inline-(block|flex|grid|table)$/.test(cs.display) ||
    cs.position === 'absolute' || cs.position === 'fixed' || cs.cssFloat !== 'none';
  if (!atomic && el.parentElement && el.parentElement !== el.ownerDocument.documentElement) {
    for (const x of decorationOf(el.parentElement)) d.add(x);
  }
  decoCache.set(el, d);
  return d;
}

export function fontFamilies(value: string): string[] {
  return splitTopLevel(value, ',').map((f) => f.trim().replace(/^["']|["']$/g, ''));
}

function styleOf(el: Element): RunStyle {
  let s = styleCache.get(el);
  if (s) return s;
  const cs = getComputedStyle(el);
  let color = parseColor(cs.getPropertyValue('-webkit-text-fill-color')) ?? parseColor(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
  let clipEl: Element | undefined;
  if (color.a === 0) {
    // background-clip: text (gradient headings)
    let cur: Element | null = el;
    while (cur) {
      const c = getComputedStyle(cur);
      const clip = c.getPropertyValue('background-clip') || c.getPropertyValue('-webkit-background-clip');
      if (clip.includes('text') && c.backgroundImage !== 'none') {
        clipEl = cur;
        break;
      }
      cur = cur.parentElement;
    }
    if (clipEl) {
      const c = getComputedStyle(clipEl);
      color = parseColor(c.backgroundColor) ?? color;
      if (color.a === 0) {
        const g = parseGradient(splitTopLevel(c.backgroundImage)[0], 100, 100);
        if (g?.stops.length) {
          const st = g.stops[0];
          color = { r: st.r, g: st.g, b: st.b, a: st.a };
        }
      }
    }
  }
  const deco = decorationOf(el);
  const tt = cs.textTransform;
  const lh = cs.lineHeight;
  const a = el.closest('a[href]') as HTMLAnchorElement | null;
  const href = a && /^https?:|^mailto:/i.test(a.href) ? a.href : undefined;
  const weight = parseInt(cs.fontWeight, 10) || (cs.fontWeight === 'bold' ? 700 : 400);
  s = {
    key: '',
    font: {
      families: fontFamilies(cs.fontFamily),
      weight,
      italic: cs.fontStyle === 'italic' || cs.fontStyle.startsWith('oblique'),
    },
    size: px(cs.fontSize, 16),
    color,
    lineHeight: lh === 'normal' ? null : px(lh, 0) || null,
    letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
    decoration: deco.has('underline') ? 'UNDERLINE' : deco.has('line-through') ? 'STRIKETHROUGH' : 'NONE',
    textCase: tt === 'uppercase' ? 'UPPER' : tt === 'lowercase' ? 'LOWER' : tt === 'capitalize' ? 'TITLE' : 'ORIGINAL',
    href,
    shadows: parseShadows(cs.textShadow).filter((x) => !x.inset),
    clipEl,
    valign: cs.verticalAlign,
  };
  s.key = JSON.stringify([s.font, s.size, s.color, s.lineHeight, s.letterSpacing, s.decoration, s.textCase, s.href]);
  styleCache.set(el, s);
  return s;
}

function union(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

function newSeg(): Seg {
  return { text: '', runs: [], styles: [], rect: null, main: null, trimmedSpace: false, spaceWidth: 0 };
}

const range = () => document.createRange();

export interface BlockContext {
  /** text-align of the containing block */
  align: TextSpec['align'];
  /** content box of the containing block (absolute coords) */
  content: { x: number; y: number; w: number; h: number };
  mode: 'exact' | 'paragraph';
  /** single-line block with text-overflow: ellipsis */
  ellipsis?: boolean;
  scrollX: number;
  scrollY: number;
  namePrefix?: string;
}

export function buildTextSpecs(items: InlineItem[], block: BlockContext): TextSpec[] {
  const lines: Line[] = [];
  let line: Line = { segs: [newSeg()] };
  let seg = line.segs[0];
  let prevGlyph: Rect | null = null; // last measured non-space glyph
  let lastNode: Text | null = null;
  let lastWasSpace = false; // for whitespace collapsing across nodes
  const sx = block.scrollX;
  const sy = block.scrollY;
  const r = range();

  const trimSeg = (s: Seg) => {
    let trimmed = false;
    while (s.text.endsWith(' ')) {
      s.text = s.text.slice(0, -1);
      trimmed = true;
    }
    if (trimmed) s.trimmedSpace = true;
    // fix up runs
    for (let i = s.runs.length - 1; i >= 0; i--) {
      const run = s.runs[i];
      if (run.start >= s.text.length) {
        s.runs.splice(i, 1);
        s.styles.splice(i, 1);
      } else if (run.end > s.text.length) run.end = s.text.length;
    }
  };
  const endLine = () => {
    trimSeg(seg);
    lines.push(line);
    line = { segs: [newSeg()] };
    seg = line.segs[0];
    lastWasSpace = false;
    prevGlyph = null;
  };
  const newSegment = () => {
    trimSeg(seg);
    seg = newSeg();
    line.segs.push(seg);
  };
  const append = (text: string, style: RunStyle) => {
    const last = seg.runs[seg.runs.length - 1];
    if (last && seg.styles[seg.styles.length - 1].key === style.key && last.end === seg.text.length) {
      last.end += text.length;
    } else {
      seg.runs.push({
        start: seg.text.length,
        end: seg.text.length + text.length,
        font: style.font,
        size: style.size,
        color: style.color,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        decoration: style.decoration,
        textCase: style.textCase,
        href: style.href,
      });
      seg.styles.push(style);
    }
    seg.text += text;
  };
  const measure = (node: Text, start: number, end: number): Rect | null => {
    r.setStart(node, start);
    r.setEnd(node, end);
    const rects = r.getClientRects();
    let best: DOMRect | null = null;
    for (const rect of rects) {
      if (rect.width > 0 || rect.height > 0) {
        best = rect;
        break;
      }
    }
    if (!best) return null;
    return { left: best.left + sx, right: best.right + sx, top: best.top + sy, bottom: best.bottom + sy };
  };
  let prevStyle: RunStyle | null = null;
  const placeGlyph = (g: Rect, style: RunStyle, nodeChanged: boolean) => {
    const lineRect = line.segs.reduce<Rect | null>((acc, s) => (s.rect ? union(acc, s.rect) : acc), null);
    if (prevGlyph && lineRect) {
      const wrapped =
        (g.left < prevGlyph.left - 0.5 && g.top > prevGlyph.top + 0.5) || g.top >= lineRect.bottom - 0.5;
      if (wrapped) {
        endLine();
      } else if (prevStyle && (prevStyle.clipEl !== style.clipEl || prevStyle.valign !== style.valign)) {
        // Gradient text (background-clip: text) needs its own node to carry the gradient fill;
        // sub/sup/top… shift the baseline, which a single Figma text line can't express.
        newSegment();
      } else if (nodeChanged && block.align !== 'JUSTIFIED') {
        // Inline padding / margins / atomic boxes create horizontal gaps that plain text can't express.
        const expected = seg.text.endsWith(' ') ? (seg.spaceWidth || style.size * 0.3) : 0;
        const gap = g.left - prevGlyph.right;
        if (Math.abs(gap - expected) > Math.max(2, style.size * 0.15)) newSegment();
      }
    }
    seg.rect = union(seg.rect, g);
    if (!seg.main || style.size > seg.main.size) seg.main = { size: style.size, top: g.top, bottom: g.bottom };
    prevGlyph = g;
    prevStyle = style;
  };

  for (const item of items) {
    if (item.kind === 'br') {
      endLine();
      continue;
    }
    const node = item.node;
    const style = styleOf(item.el);
    const cs = getComputedStyle(item.el);
    if (cs.visibility !== 'visible') {
      lastNode = node;
      continue;
    }
    const ws = cs.whiteSpace;
    const collapse = ws === 'normal' || ws === 'nowrap' || ws === 'pre-line' || ws === '';
    const keepNewlines = ws !== 'normal' && ws !== 'nowrap' && ws !== '';
    const data = node.data;
    let nodeChanged = node !== lastNode;
    lastNode = node;

    // Fast path: whole node sits on a single line.
    const whole = (() => {
      // Range over the visible glyphs only: surrounding whitespace would widen the box.
      const first = data.search(/[^\s]|\u00A0/);
      if (first < 0 || (keepNewlines && data.includes('\n'))) return null;
      let last = data.length;
      while (last > first && /\s/.test(data[last - 1]) && data[last - 1] !== '\u00A0') last--;
      r.setStart(node, first);
      r.setEnd(node, last);
      const rects = [...r.getClientRects()].filter((x) => x.width > 0);
      return rects.length === 1 ? rects[0] : null;
    })();
    let fastPlaced = false;

    for (let i = 0; i < data.length; ) {
      const cp = data.codePointAt(i)!;
      const len = cp > 0xffff ? 2 : 1;
      const ch = data.slice(i, i + len);
      if (ch === '\n' && keepNewlines) {
        endLine();
        i += len;
        continue;
      }
      if (/\s/.test(ch) && ch !== ' ') {
        if (collapse) {
          if (seg.text.length === 0 && line.segs.length === 1 ? true : lastWasSpace) {
            i += len;
            continue;
          }
          if (!seg.spaceWidth) {
            const g = measure(node, i, i + len);
            if (g && g.right - g.left > 0) seg.spaceWidth = g.right - g.left;
          }
          append(' ', style);
          lastWasSpace = true;
        } else {
          // Preserved whitespace (pre / pre-wrap): it has real geometry, e.g. indentation.
          const g = measure(node, i, i + len);
          if (g && g.right > g.left) {
            placeGlyph(g, style, nodeChanged);
            nodeChanged = false;
          }
          append(ch === '\t' ? '    ' : ' ', style);
          lastWasSpace = false;
        }
        i += len;
        continue;
      }
      // Visible glyph
      if (whole) {
        if (!fastPlaced) {
          const first = measure(node, i, i + len) ?? {
            left: whole.left + sx, right: whole.left + sx, top: whole.top + sy, bottom: whole.bottom + sy,
          };
          placeGlyph(first, style, nodeChanged);
          const wr = { left: whole.left + sx, right: whole.right + sx, top: whole.top + sy, bottom: whole.bottom + sy };
          seg.rect = union(seg.rect, wr);
          prevGlyph = { ...wr, left: first.left };
          fastPlaced = true;
        }
      } else {
        const g = measure(node, i, i + len);
        if (!g) {
          // Not rendered (e.g. inside a closed <details>): skip.
          i += len;
          continue;
        }
        placeGlyph(g, style, nodeChanged);
      }
      if (!whole || fastPlaced) {
        // After the first glyph of the node only real node changes count as boundaries.
        nodeChanged = false;
      }
      append(ch, style);
      lastWasSpace = false;
      i += len;
    }
    if (whole && fastPlaced && prevGlyph) {
      // Track right edge of the node for gap detection on the next node.
      prevGlyph = { ...prevGlyph, right: whole.right + sx, left: prevGlyph.left };
    }
  }
  trimSeg(seg);
  lines.push(line);

  return groupLines(lines, block);
}

// ---------- grouping lines into text nodes ----------

interface Piece {
  segs: Seg[];
}

function anchorOf(seg: Seg, align: TextSpec['align']): number {
  const rect = seg.rect!;
  if (align === 'CENTER') return (rect.left + rect.right) / 2;
  if (align === 'RIGHT') return rect.right;
  return rect.left;
}

function centerOf(seg: Seg): number {
  if (seg.main) return (seg.main.top + seg.main.bottom) / 2;
  return (seg.rect!.top + seg.rect!.bottom) / 2;
}

function groupLines(lines: Line[], block: BlockContext): TextSpec[] {
  const pieces: Piece[] = [];
  let current: Piece | null = null;
  let pitch: number | null = null;
  const align = block.align;
  for (const line of lines) {
    const segs = line.segs.filter((s) => s.text.length > 0 && s.rect);
    if (segs.length !== 1) {
      current = null;
      for (const s of segs) pieces.push({ segs: [s] });
      continue;
    }
    const s = segs[0];
    if (current) {
      const prev = current.segs[current.segs.length - 1];
      const sameAnchor = Math.abs(anchorOf(prev, align) - anchorOf(s, align)) <= 1.5 || align === 'JUSTIFIED';
      const step = centerOf(s) - centerOf(prev);
      const lh = prev.runs[0]?.lineHeight ?? null;
      const expected = pitch ?? lh ?? (prev.rect!.bottom - prev.rect!.top);
      const pitchOk = step > 0 && Math.abs(step - expected) <= Math.max(2, expected * 0.2);
      const sameSizes = sizeSignature(prev) === sizeSignature(s) || pitch === null;
      if (sameAnchor && pitchOk && sameSizes) {
        if (pitch === null) pitch = step;
        current.segs.push(s);
        continue;
      }
    }
    current = { segs: [s] };
    pitch = null;
    pieces.push(current);
  }
  return pieces.map((p) => pieceToSpec(p, block));
}

function sizeSignature(seg: Seg): string {
  return seg.main ? String(Math.round(seg.main.size)) : '';
}

function pieceToSpec(piece: Piece, block: BlockContext): TextSpec {
  const segs = piece.segs;
  const multi = segs.length > 1;
  let rect: Rect | null = null;
  for (const s of segs) rect = union(rect, s.rect!);
  const r = rect!;

  // Paragraph mode: keep one flowing text box when the lines span the whole containing block.
  let sizing: TextSpec['sizing'] = 'auto';
  let x = r.left;
  let w = r.right - r.left;
  // Justified lines can't be reproduced with explicit line breaks (Figma never justifies a line
  // that ends with a break), so justified paragraphs always use a fixed-width wrapping box.
  if (multi && (block.mode === 'paragraph' || block.align === 'JUSTIFIED')) {
    const c = block.content;
    const fitsLeft = Math.abs(r.left - c.x) <= 2 || block.align !== 'LEFT';
    const inside = r.left >= c.x - 2 && r.right <= c.x + c.w + 2;
    if (fitsLeft && inside) {
      sizing = 'fixed';
      x = c.x;
      w = c.w + 1;
    }
  }

  let text = '';
  const runs: TextRun[] = [];
  const styles: RunStyle[] = [];
  segs.forEach((s, i) => {
    if (i > 0) {
      const sep = sizing === 'fixed' ? (segs[i - 1].trimmedSpace ? ' ' : '') : '\n';
      if (sep) {
        // separator inherits the previous run's style
        const last = runs[runs.length - 1];
        if (last) last.end += sep.length;
        text += sep;
      }
    }
    const offset = text.length;
    s.runs.forEach((run, k) => {
      runs.push({ ...run, start: run.start + offset, end: run.end + offset });
      styles.push(s.styles[k]);
    });
    text += s.text;
  });

  // Consistent line spacing: use the measured pitch for multi-line pieces.
  if (multi) {
    const pitch = centerOf(segs[1]) - centerOf(segs[0]);
    if (pitch > 0) for (const run of runs) run.lineHeight = Math.round(pitch * 100) / 100;
  }

  const first = segs[0];
  const firstStyle = styles[0];
  let fills: FillSpec[] | undefined;
  if (firstStyle?.clipEl) fills = clippedTextFill(firstStyle.clipEl, r, block);

  const align: TextSpec['align'] =
    block.align === 'JUSTIFIED' ? (sizing === 'fixed' ? 'JUSTIFIED' : 'LEFT') : block.align;

  let truncate = false;
  if (block.ellipsis && !multi && r.right > block.content.x + block.content.w + 0.5) {
    sizing = 'fixed';
    truncate = true;
    w = Math.max(1, block.content.x + block.content.w - r.left);
  }

  const spec: TextSpec = {
    kind: 'text',
    name: text.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Text',
    x,
    y: r.top,
    w,
    h: r.bottom - r.top,
    characters: text,
    runs,
    align,
    sizing,
    firstLineCenter: centerOf(first),
    lineCount: segs.length,
    shadows: firstStyle?.shadows.length ? firstStyle.shadows : undefined,
  };
  if (fills) spec.fills = fills;
  if (truncate) spec.truncate = true;
  return spec;
}

/**
 * Gradient for background-clip: text. An inline box that wraps paints its background as if all
 * line fragments were laid side by side (box-decoration-break: slice), so each piece shows only
 * its slice of the full gradient.
 */
function clippedTextFill(el: Element, r: Rect, block: BlockContext): FillSpec[] | undefined {
  const bg = splitTopLevel(getComputedStyle(el).backgroundImage)[0] ?? '';
  const frags = [...el.getClientRects()].filter((f) => f.width > 0);
  const w = Math.max(1, r.right - r.left);
  const h = Math.max(1, r.bottom - r.top);
  const sx = block.scrollX;
  const sy = block.scrollY;
  const cy = (r.top + r.bottom) / 2;
  let index = frags.findIndex((f) => f.top + sy <= cy && f.bottom + sy >= cy && f.left + sx <= r.right && f.right + sx >= r.left);
  if (index < 0) index = 0;
  const frag = frags[index];
  if (!frag) {
    const g = parseGradient(bg, w, h);
    return g ? [{ type: g.type, stops: g.stops, transform: g.transform }] : undefined;
  }
  const W = frags.reduce((a, f) => a + f.width, 0);
  const H = frag.height;
  const g = parseGradient(bg, W, H);
  if (!g) return undefined;
  const offset = frags.slice(0, index).reduce((a, f) => a + f.width, 0);
  // node unit space → slice unit space
  const A: Matrix = [
    [w / W, 0, (offset + r.left - (frag.left + sx)) / W],
    [0, h / H, (r.top - (frag.top + sy)) / H],
  ];
  const T = g.transform;
  const m: Matrix = [
    [T[0][0] * A[0][0] + T[0][1] * A[1][0], T[0][0] * A[0][1] + T[0][1] * A[1][1], T[0][0] * A[0][2] + T[0][1] * A[1][2] + T[0][2]],
    [T[1][0] * A[0][0] + T[1][1] * A[1][0], T[1][0] * A[0][1] + T[1][1] * A[1][1], T[1][0] * A[0][2] + T[1][1] * A[1][2] + T[1][2]],
  ];
  return [{ type: g.type, stops: g.stops, transform: m }];
}
