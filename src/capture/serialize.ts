import type {
  BlendMode, CaptureOptions, FillSpec, FlexLayoutSpec, FrameSpec, Matrix, NodeSpec, RGBA,
  ShadowSpec, StrokeSpec, SvgSpec, TextSpec,
} from '../shared/types';
import { isVisibleColor, parseColor } from './color';
import { extractUrl, lengthOrPercent, parseGradient, parseShadows, px, splitTopLevel } from './css';
import { ImageStore, rasterizeSvg } from './images';
import { PSEUDO_TAG } from './pseudo';
import { serializeSvg, svgImageToString } from './svg';
import { buildTextSpecs, fontFamilies, type BlockContext, type InlineItem } from './text';

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'SOURCE', 'TRACK', 'PARAM',
  'AREA', 'MAP', 'DATALIST', 'OPTION', 'OPTGROUP',
]);
const REPLACED = new Set(['IMG', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'VIDEO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'PROGRESS', 'METER', 'HR']);

interface Ctx {
  opts: CaptureOptions;
  images: ImageStore;
  warnings: Set<string>;
  svgTexts: Map<string, string>;
  /** Work to do once images are loaded (needs natural image sizes). */
  afterLoad: Array<() => void>;
  /** Async work started during serialization (SVG rasterization). */
  pending: Promise<void>[];
  /** Elements whose background was propagated to the page canvas. */
  skipBackground: Set<Element>;
  sx: number;
  sy: number;
}

interface Painted {
  node: NodeSpec;
  layer: number; // 0 negative z, 1 in-flow, 2 positioned z=0/auto, 3 positive z
  z: number;
  order: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

function nameOf(el: Element): string {
  if (el.tagName.toLowerCase() === PSEUDO_TAG) return `::${el.getAttribute('data-pseudo') || 'pseudo'}`;
  let n = el.tagName.toLowerCase();
  const label = el.getAttribute('aria-label') || el.getAttribute('data-name');
  if (el.id) n += `#${el.id}`;
  else if (el.classList.length) n += `.${[...el.classList].slice(0, 2).join('.')}`;
  if (label) n += ` "${label.slice(0, 30)}"`;
  return n;
}

function boxOf(el: Element, ctx: Ctx) {
  const r = el.getBoundingClientRect();
  return { x: round(r.left + ctx.sx), y: round(r.top + ctx.sy), w: round(r.width), h: round(r.height) };
}

function isInlineFlow(el: Element, cs: CSSStyleDeclaration): boolean {
  if (REPLACED.has(el.tagName) || el instanceof SVGElement) return false;
  if (cs.position === 'absolute' || cs.position === 'fixed' || cs.cssFloat !== 'none') return false;
  return cs.display === 'inline' || cs.display.startsWith('ruby');
}

function isOutOfFlow(cs: CSSStyleDeclaration): boolean {
  return cs.position === 'absolute' || cs.position === 'fixed';
}

const BLEND: Record<string, BlendMode> = {
  multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY', darken: 'DARKEN', lighten: 'LIGHTEN',
  'color-dodge': 'COLOR_DODGE', 'color-burn': 'COLOR_BURN', 'hard-light': 'HARD_LIGHT',
  'soft-light': 'SOFT_LIGHT', difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE',
  saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
};

// ---------- visual properties ----------

function radii(cs: CSSStyleDeclaration, w: number, h: number): [number, number, number, number] | undefined {
  const read = (v: string) => {
    const first = v.split(/\s+/)[0] || '0';
    return Math.max(0, lengthOrPercent(first, first.endsWith('%') ? Math.min(w, h) : w) ?? 0);
  };
  let r: [number, number, number, number] = [
    read(cs.borderTopLeftRadius), read(cs.borderTopRightRadius),
    read(cs.borderBottomRightRadius), read(cs.borderBottomLeftRadius),
  ];
  if (!r.some((x) => x > 0)) return undefined;
  // CSS scales all radii down when adjacent ones don't fit.
  const f = Math.min(
    1,
    w / (r[0] + r[1] || 1), w / (r[3] + r[2] || 1),
    h / (r[0] + r[3] || 1), h / (r[1] + r[2] || 1),
  );
  if (f < 1) r = r.map((x) => x * f) as typeof r;
  return r.map(round) as typeof r;
}

function dashFor(style: string, width: number): number[] | undefined {
  if (style === 'dashed') return [width * 3, width * 2];
  if (style === 'dotted') return [width, width];
  return undefined;
}

interface Borders {
  stroke?: StrokeSpec;
  sides?: { side: 'top' | 'right' | 'bottom' | 'left'; width: number; color: RGBA }[];
}

function borders(cs: CSSStyleDeclaration): Borders {
  const sides = (['top', 'right', 'bottom', 'left'] as const).map((side) => {
    const style = cs.getPropertyValue(`border-${side}-style`);
    const width = style === 'none' || style === 'hidden' ? 0 : px(cs.getPropertyValue(`border-${side}-width`));
    const color = parseColor(cs.getPropertyValue(`border-${side}-color`));
    return { side, style, width, color };
  });
  const visible = sides.filter((s) => s.width > 0 && isVisibleColor(s.color));
  if (!visible.length) {
    // Outline (only when there's no border, since Figma has a single stroke per node)
    const ow = cs.outlineStyle !== 'none' ? px(cs.outlineWidth) : 0;
    const oc = parseColor(cs.outlineColor);
    if (ow > 0 && isVisibleColor(oc)) {
      return {
        stroke: { color: oc, top: ow, right: ow, bottom: ow, left: ow, align: 'OUTSIDE', dash: dashFor(cs.outlineStyle, ow) },
      };
    }
    return {};
  }
  const c0 = visible[0].color!;
  const sameColor = visible.every(
    (s) => Math.abs(s.color!.r - c0.r) < 0.004 && Math.abs(s.color!.g - c0.g) < 0.004 &&
      Math.abs(s.color!.b - c0.b) < 0.004 && Math.abs(s.color!.a - c0.a) < 0.004,
  );
  if (sameColor) {
    const w = (side: string) => {
      const s = sides.find((x) => x.side === side)!;
      return s.width > 0 && isVisibleColor(s.color) ? s.width : 0;
    };
    return {
      stroke: {
        color: c0, top: w('top'), right: w('right'), bottom: w('bottom'), left: w('left'),
        align: 'INSIDE', dash: dashFor(visible[0].style, visible[0].width),
      },
    };
  }
  return { sides: visible.map((s) => ({ side: s.side, width: s.width, color: s.color! })) };
}

function effects(cs: CSSStyleDeclaration) {
  const shadows: ShadowSpec[] = parseShadows(cs.boxShadow);
  let layerBlur: number | undefined;
  let backgroundBlur: number | undefined;
  const filter = cs.filter;
  if (filter && filter !== 'none') {
    const blur = /blur\(\s*([\d.]+)px\s*\)/.exec(filter);
    if (blur) layerBlur = parseFloat(blur[1]);
    const ds = /drop-shadow\((.*?\))\s*([-\d.]+px\s+[-\d.]+px(?:\s+[-\d.]+px)?)\)/.exec(filter);
    if (ds) {
      const parsed = parseShadows(`${ds[1]} ${ds[2]}`);
      shadows.push(...parsed);
    }
  }
  const bf = cs.getPropertyValue('backdrop-filter') || cs.getPropertyValue('-webkit-backdrop-filter');
  if (bf && bf !== 'none') {
    const blur = /blur\(\s*([\d.]+)px\s*\)/.exec(bf);
    if (blur) backgroundBlur = parseFloat(blur[1]);
  }
  return { shadows, layerBlur, backgroundBlur };
}

/** Parses "x y" background/object-position into px offsets for a free area of (fw, fh). */
function positionOffset(value: string, fw: number, fh: number): { x: number; y: number } {
  const parts = value.trim().split(/\s+/);
  const kw: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
  const resolve = (t: string | undefined, free: number) => {
    if (!t) return free / 2;
    if (t in kw) return kw[t] * free;
    if (t.endsWith('%')) return (parseFloat(t) / 100) * free;
    return px(t);
  };
  let xs = parts[0];
  let ys = parts[1];
  if (xs === 'top' || xs === 'bottom') [xs, ys] = [ys ?? 'center', xs];
  return { x: resolve(xs, fw), y: resolve(ys, fh) };
}

/** imageTransform that shows the image region covering a node exactly (CROP mode). */
function cropTransform(nodeW: number, nodeH: number, ix: number, iy: number, iw: number, ih: number): Matrix {
  return [
    [nodeW / iw, 0, -ix / iw],
    [0, nodeH / ih, -iy / ih],
  ];
}

function backgroundFills(el: Element, cs: CSSStyleDeclaration, box: { x: number; y: number; w: number; h: number }, frame: FrameSpec, ctx: Ctx): FillSpec[] {
  const fills: FillSpec[] = [];
  const bg = parseColor(cs.backgroundColor);
  if (isVisibleColor(bg)) fills.push({ type: 'solid', color: bg });
  const image = cs.backgroundImage;
  if (!image || image === 'none') return fills;
  const clip = cs.getPropertyValue('background-clip') || cs.getPropertyValue('-webkit-background-clip');
  if (clip.includes('text')) return fills; // applied to the text instead
  const layers = splitTopLevel(image, ',');
  const sizes = splitTopLevel(cs.backgroundSize, ',');
  const positions = splitTopLevel(cs.backgroundPosition, ',');
  const repeats = splitTopLevel(cs.backgroundRepeat, ',');
  const origins = splitTopLevel(cs.backgroundOrigin, ',');
  const layerFills: FillSpec[] = [];
  layers.forEach((layer, i) => {
    const origin = origins[i % origins.length] ?? 'padding-box';
    // Offset of the background positioning area from the border box.
    const inset = {
      l: px(cs.borderLeftWidth) + (origin === 'content-box' ? px(cs.paddingLeft) : 0),
      t: px(cs.borderTopWidth) + (origin === 'content-box' ? px(cs.paddingTop) : 0),
      r: px(cs.borderRightWidth) + (origin === 'content-box' ? px(cs.paddingRight) : 0),
      b: px(cs.borderBottomWidth) + (origin === 'content-box' ? px(cs.paddingBottom) : 0),
    };
    if (origin === 'border-box') inset.l = inset.t = inset.r = inset.b = 0;
    const rad = radii(cs, box.w, box.h);
    const size = sizes[i % sizes.length] ?? 'auto';
    const pos = positions[i % positions.length] ?? '0% 0%';
    const repeat = repeats[i % repeats.length] ?? 'repeat';
    const url = extractUrl(layer);
    if (url) {
      const abs = new URL(url, el.ownerDocument.baseURI).href;
      const id = ctx.images.register(abs);
      const fill: FillSpec = { type: 'image', imageId: id, scaleMode: 'FILL' };
      layerFills.push(fill);
      ctx.afterLoad.push(() => {
        const info = ctx.images.info(id);
        if (!info) {
          Object.assign(fill, { type: 'solid', color: { r: 0.9, g: 0.9, b: 0.92, a: 1 } });
          ctx.warnings.add(`Не вдалося завантажити фонове зображення: ${abs.slice(0, 120)}`);
          return;
        }
        const nw = info.width || 1;
        const nh = info.height || 1;
        if (size === 'cover') return; // FILL
        let tw: number;
        let th: number;
        if (size === 'contain') {
          const s = Math.min(box.w / nw, box.h / nh);
          tw = nw * s;
          th = nh * s;
        } else {
          const [sw = 'auto', sh = 'auto'] = size.split(/\s+/);
          const w0 = sw === 'auto' ? null : lengthOrPercent(sw, box.w);
          const h0 = sh === 'auto' ? null : lengthOrPercent(sh, box.h);
          tw = w0 ?? (h0 !== null ? (h0 * nw) / nh : nw);
          th = h0 ?? (w0 !== null ? (w0 * nh) / nw : nh);
        }
        if (!(tw > 0 && th > 0)) return;
        const off = positionOffset(pos, box.w - tw, box.h - th);
        const noRepeat = repeat === 'no-repeat' || (repeat.includes('no-repeat') && !repeat.includes('repeat-'));
        if (!noRepeat && (tw < box.w - 0.5 || th < box.h - 0.5)) {
          Object.assign(fill, { scaleMode: 'TILE', scalingFactor: tw / nw });
          const shifted = inset.l || inset.t || Math.abs(off.x) > 0.5 || Math.abs(off.y) > 0.5;
          if (shifted) {
            // Figma tiles start at the node origin; CSS tiles start at the positioning area
            // (+ background-position). Draw the tiles on a child layer that starts there.
            Object.assign(fill, { type: 'solid', color: { r: 0, g: 0, b: 0, a: 0 } });
            const ox = inset.l + (((off.x % tw) + tw) % tw) - (off.x % tw === 0 ? 0 : tw);
            const oy = inset.t + (((off.y % th) + th) % th) - (off.y % th === 0 ? 0 : th);
            const childW = box.w - inset.r - ox;
            const childH = box.h - inset.b - oy;
            const tile: FrameSpec = {
              kind: 'frame', tag: 'bg', name: 'background-image', x: box.x + inset.l, y: box.y + inset.t,
              w: box.w - inset.l - inset.r, h: box.h - inset.t - inset.b, fills: [], clip: true, outOfFlow: true,
              children: [{
                kind: 'frame', tag: 'bg', name: 'tiles', x: box.x + ox, y: box.y + oy, w: childW, h: childH,
                fills: [{ type: 'image', imageId: id, scaleMode: 'TILE', scalingFactor: tw / nw }], clip: false, children: [],
              }],
            };
            if (rad) tile.radius = rad.map((r) => Math.max(0, r - Math.max(inset.l, inset.t))) as FrameSpec['radius'];
            frame.children.unshift(tile);
          }
          return;
        }
        // Single image: covers the whole box → crop; otherwise it's a smaller picture inside the box.
        const ix = Math.max(0, off.x);
        const iy = Math.max(0, off.y);
        const ex = Math.min(box.w, off.x + tw);
        const ey = Math.min(box.h, off.y + th);
        if (ex - ix <= 0 || ey - iy <= 0) {
          Object.assign(fill, { type: 'solid', color: { r: 0, g: 0, b: 0, a: 0 } });
          return;
        }
        if (ix <= 0.5 && iy <= 0.5 && ex >= box.w - 0.5 && ey >= box.h - 0.5) {
          Object.assign(fill, { scaleMode: 'CROP', transform: cropTransform(box.w, box.h, off.x, off.y, tw, th) });
          return;
        }
        // Emit a child rectangle for the visible part of the image.
        Object.assign(fill, { type: 'solid', color: { r: 0, g: 0, b: 0, a: 0 } });
        const w = ex - ix;
        const h = ey - iy;
        frame.children.unshift({
          kind: 'frame', tag: 'bg', name: 'background-image', x: box.x + ix, y: box.y + iy, w, h,
          fills: [{ type: 'image', imageId: id, scaleMode: 'CROP', transform: cropTransform(w, h, off.x - ix, off.y - iy, tw, th) }],
          clip: false, children: [], outOfFlow: true,
        });
      });
      return;
    }
    const g = parseGradient(layer, box.w, box.h);
    if (g) layerFills.push({ type: g.type, stops: g.stops, transform: g.transform });
  });
  // CSS: first layer is on top. Figma: last fill is on top.
  return fills.concat(layerFills.reverse());
}

function flexSpec(cs: CSSStyleDeclaration): FlexLayoutSpec | undefined {
  if (cs.display !== 'flex' && cs.display !== 'inline-flex') return undefined;
  const dir = cs.flexDirection;
  const horizontal = dir.startsWith('row');
  const justifyMap: Record<string, FlexLayoutSpec['justify']> = {
    normal: 'MIN', 'flex-start': 'MIN', start: 'MIN', left: 'MIN', center: 'CENTER',
    'flex-end': 'MAX', end: 'MAX', right: 'MAX', 'space-between': 'SPACE_BETWEEN',
  };
  const alignMap: Record<string, FlexLayoutSpec['align']> = {
    normal: 'MIN', stretch: 'MIN', 'flex-start': 'MIN', start: 'MIN', 'self-start': 'MIN',
    center: 'CENTER', 'flex-end': 'MAX', end: 'MAX', 'self-end': 'MAX', baseline: 'BASELINE',
    'first baseline': 'BASELINE',
  };
  const justify = justifyMap[cs.justifyContent];
  const align = alignMap[cs.alignItems];
  if (!justify || !align) return undefined;
  const colGap = cs.columnGap === 'normal' ? 0 : px(cs.columnGap);
  const rowGap = cs.rowGap === 'normal' ? 0 : px(cs.rowGap);
  return {
    direction: horizontal ? 'HORIZONTAL' : 'VERTICAL',
    wrap: cs.flexWrap !== 'nowrap',
    gap: horizontal ? colGap : rowGap,
    rowGap: horizontal ? rowGap : colGap,
    padding: [
      px(cs.paddingTop) + px(cs.borderTopWidth),
      px(cs.paddingRight) + px(cs.borderRightWidth),
      px(cs.paddingBottom) + px(cs.borderBottomWidth),
      px(cs.paddingLeft) + px(cs.borderLeftWidth),
    ],
    justify,
    align: horizontal ? align : align === 'BASELINE' ? 'MIN' : align,
    reverse: dir.endsWith('reverse'),
  };
}

function contentBox(el: Element, cs: CSSStyleDeclaration, box: { x: number; y: number; w: number; h: number }) {
  const l = px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const r = px(cs.borderRightWidth) + px(cs.paddingRight);
  const t = px(cs.borderTopWidth) + px(cs.paddingTop);
  const b = px(cs.borderBottomWidth) + px(cs.paddingBottom);
  // clientWidth excludes scrollbars
  const sw = el instanceof HTMLElement && el.clientWidth ? box.w - (el.offsetWidth - el.clientWidth) + (px(cs.borderLeftWidth) + px(cs.borderRightWidth)) : box.w;
  return { x: box.x + l, y: box.y + t, w: Math.max(0, Math.min(box.w, sw) - l - r), h: Math.max(0, box.h - t - b) };
}

function alignOf(cs: CSSStyleDeclaration): TextSpec['align'] {
  const a = cs.textAlign;
  const rtl = cs.direction === 'rtl';
  if (a === 'center' || a === '-webkit-center') return 'CENTER';
  if (a === 'right' || a === '-webkit-right' || (a === 'end' && !rtl) || (a === 'start' && rtl)) return 'RIGHT';
  if (a === 'justify') return 'JUSTIFIED';
  return 'LEFT';
}

// ---------- element → spec ----------

function makeFrame(el: Element, cs: CSSStyleDeclaration, ctx: Ctx): FrameSpec {
  const box = boxOf(el, ctx);
  const frame: FrameSpec = {
    kind: 'frame', tag: el.tagName.toLowerCase(), name: nameOf(el), ...box,
    fills: [], clip: false, children: [],
  };
  const hidden = cs.visibility !== 'visible';
  if (!hidden) {
    if (!ctx.skipBackground.has(el)) frame.fills = backgroundFills(el, cs, box, frame, ctx);
    const b = borders(cs);
    if (b.stroke) frame.stroke = b.stroke;
    if (b.sides) {
      for (const s of b.sides) {
        const rect =
          s.side === 'top' ? { x: box.x, y: box.y, w: box.w, h: s.width }
          : s.side === 'bottom' ? { x: box.x, y: box.y + box.h - s.width, w: box.w, h: s.width }
          : s.side === 'left' ? { x: box.x, y: box.y, w: s.width, h: box.h }
          : { x: box.x + box.w - s.width, y: box.y, w: s.width, h: box.h };
        frame.children.push({
          kind: 'frame', tag: 'border', name: `border-${s.side}`, ...rect,
          fills: [{ type: 'solid', color: s.color }], clip: false, children: [], outOfFlow: true,
        });
      }
    }
    const fx = effects(cs);
    if (fx.shadows.length) frame.shadows = fx.shadows;
    if (fx.layerBlur) frame.layerBlur = fx.layerBlur;
    if (fx.backgroundBlur) frame.backgroundBlur = fx.backgroundBlur;
  }
  frame.radius = radii(cs, box.w, box.h);
  const opacity = parseFloat(cs.opacity);
  if (opacity < 1) frame.opacity = opacity;
  const blend = BLEND[cs.mixBlendMode];
  if (blend) frame.blendMode = blend;
  const ov = (v: string) => v !== 'visible' && v !== '';
  frame.clip = ov(cs.overflowX) || ov(cs.overflowY) || (cs.contain || '').includes('paint');
  if (isOutOfFlow(cs)) frame.outOfFlow = true;
  frame.passive =
    !frame.fills.length && !frame.stroke && !frame.shadows && !frame.layerBlur && !frame.backgroundBlur &&
    !frame.clip && frame.opacity === undefined && !frame.blendMode;
  return frame;
}

function placeholderFill(): FillSpec {
  return { type: 'solid', color: { r: 0.88, g: 0.89, b: 0.91, a: 1 } };
}

function imageElement(el: HTMLImageElement, cs: CSSStyleDeclaration, ctx: Ctx): NodeSpec {
  const frame = makeFrame(el, cs, ctx);
  const src = el.currentSrc || el.src;
  if (!src) {
    frame.fills.push(placeholderFill());
    return frame;
  }
  const svgText = ctx.svgTexts.get(src);
  if (svgText && cs.objectFit !== 'cover') {
    const content = contentBox(el, cs, frame);
    const svg = svgImageToString(svgText, content.w, content.h);
    if (svg) {
      const spec: SvgSpec = { kind: 'svg', name: nameOf(el), svg, ...content };
      if (frame.passive && !frame.radius) {
        if (frame.opacity !== undefined) spec.opacity = frame.opacity;
        if (frame.outOfFlow) spec.outOfFlow = true;
        return spec;
      }
      frame.children.push(spec);
      frame.passive = false;
      return frame;
    }
  }
  const id = ctx.images.register(src);
  const fill: FillSpec = { type: 'image', imageId: id, scaleMode: 'FILL' };
  frame.fills.push(fill);
  frame.passive = false;
  const fit = cs.objectFit;
  const objPos = cs.objectPosition;
  const content = contentBox(el, cs, frame);
  ctx.afterLoad.push(() => {
    const info = ctx.images.info(id);
    if (!info) {
      Object.assign(fill, placeholderFill());
      ctx.warnings.add(`Не вдалося завантажити зображення: ${src.slice(0, 120)}`);
      return;
    }
    const nw = el.naturalWidth || info.width;
    const nh = el.naturalHeight || info.height;
    if (!nw || !nh || !content.w || !content.h) return;
    let iw = content.w;
    let ih = content.h;
    if (fit === 'cover' || fit === 'contain' || fit === 'none' || fit === 'scale-down') {
      let s = fit === 'cover' ? Math.max(content.w / nw, content.h / nh) : Math.min(content.w / nw, content.h / nh);
      if (fit === 'none') s = 1;
      if (fit === 'scale-down') s = Math.min(1, s);
      iw = nw * s;
      ih = nh * s;
    }
    const off = positionOffset(objPos, content.w - iw, content.h - ih);
    const covers = off.x <= 0.5 && off.y <= 0.5 && off.x + iw >= content.w - 0.5 && off.y + ih >= content.h - 0.5;
    const padded = content.w < frame.w - 0.5 || content.h < frame.h - 0.5;
    if (covers && !padded) {
      Object.assign(fill, { scaleMode: 'CROP', transform: cropTransform(content.w, content.h, off.x, off.y, iw, ih) });
      return;
    }
    // Image doesn't fill the element box: separate child layer for the picture.
    frame.fills.pop();
    const ix = Math.max(0, off.x);
    const iy = Math.max(0, off.y);
    const w = Math.min(content.w, off.x + iw) - ix;
    const h = Math.min(content.h, off.y + ih) - iy;
    if (w <= 0 || h <= 0) return;
    frame.children.push({
      kind: 'frame', tag: 'img', name: 'image', x: content.x + ix, y: content.y + iy, w, h,
      fills: [{ type: 'image', imageId: id, scaleMode: 'CROP', transform: cropTransform(w, h, off.x - ix, off.y - iy, iw, ih) }],
      clip: false, children: [], outOfFlow: true,
    });
  });
  return frame;
}

function canvasLike(el: Element, cs: CSSStyleDeclaration, ctx: Ctx): NodeSpec {
  const frame = makeFrame(el, cs, ctx);
  frame.passive = false;
  if (el instanceof HTMLCanvasElement) {
    try {
      const data = el.toDataURL('image/png');
      const bin = atob(data.split(',')[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const id = ctx.images.registerBytes(`canvas:${Math.random()}`, { bytes, width: el.width, height: el.height });
      frame.fills.push({ type: 'image', imageId: id, scaleMode: 'FILL' });
      return frame;
    } catch {
      ctx.warnings.add('Canvas з даними з іншого домену неможливо скопіювати.');
    }
  }
  if (el instanceof HTMLVideoElement && el.poster) {
    const id = ctx.images.register(el.poster);
    const fill: FillSpec = { type: 'image', imageId: id, scaleMode: 'FIT' };
    frame.fills.push({ type: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } }, fill);
    ctx.afterLoad.push(() => {
      if (!ctx.images.info(id)) Object.assign(fill, { type: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } });
    });
    return frame;
  }
  frame.fills.push(el instanceof HTMLVideoElement ? { type: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } } : placeholderFill());
  return frame;
}

/** Text inside form controls is not part of the DOM, so it is synthesised from value/placeholder. */
function controlText(el: Element, cs: CSSStyleDeclaration, frame: FrameSpec, text: string, color: RGBA | null, multiline: boolean): TextSpec | null {
  if (!text) return null;
  const content = contentBox(el, cs, frame);
  const size = px(cs.fontSize, 13);
  const lh = cs.lineHeight === 'normal' ? null : px(cs.lineHeight);
  const lineH = lh ?? size * 1.2;
  const align = alignOf(cs);
  const runs = [{
    start: 0, end: text.length,
    font: { families: fontFamilies(cs.fontFamily), weight: parseInt(cs.fontWeight, 10) || 400, italic: cs.fontStyle !== 'normal' },
    size, color: color ?? parseColor(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 },
    lineHeight: lh, letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
    decoration: 'NONE' as const, textCase: 'ORIGINAL' as const,
  }];
  return {
    kind: 'text', name: text.slice(0, 40), x: content.x, y: content.y, w: content.w, h: content.h,
    characters: text, runs, align: multiline ? align : align === 'JUSTIFIED' ? 'LEFT' : align,
    sizing: multiline ? 'fixed' : 'auto',
    firstLineCenter: multiline ? content.y + lineH / 2 : content.y + content.h / 2,
    lineCount: 1,
  };
}

function formControl(el: Element, cs: CSSStyleDeclaration, ctx: Ctx): NodeSpec {
  const frame = makeFrame(el, cs, ctx);
  frame.passive = false;
  const tag = el.tagName;
  if (el instanceof HTMLInputElement) {
    const type = el.type;
    if (type === 'checkbox' || type === 'radio') {
      const accent = parseColor(cs.accentColor) ?? { r: 0, g: 0.46, b: 1, a: 1 };
      const checked = el.checked;
      if (!frame.fills.length && !frame.stroke) {
        frame.fills = [{ type: 'solid', color: checked ? accent : { r: 1, g: 1, b: 1, a: 1 } }];
        if (!checked) frame.stroke = { color: { r: 0.46, g: 0.46, b: 0.46, a: 1 }, top: 1, right: 1, bottom: 1, left: 1, align: 'INSIDE' };
        const r = type === 'radio' ? frame.w / 2 : Math.min(3, frame.w / 4);
        frame.radius = [r, r, r, r];
        if (checked) {
          const s = Math.min(frame.w, frame.h);
          const svg = type === 'radio'
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.5" fill="white"/></svg>`
            : `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
          frame.children.push({ kind: 'svg', name: 'check', svg, x: frame.x + (frame.w - s) / 2, y: frame.y + (frame.h - s) / 2, w: s, h: s, outOfFlow: true });
        }
      }
      return frame;
    }
    if (type === 'hidden') return frame;
    const isButton = type === 'submit' || type === 'button' || type === 'reset';
    let text = el.value;
    let color: RGBA | null = null;
    if (!text && !isButton) {
      text = el.placeholder;
      color = parseColor(getComputedStyle(el, '::placeholder').color);
    }
    if (isButton && !text) text = type === 'reset' ? 'Reset' : type === 'submit' ? 'Submit' : '';
    if (type === 'password' && el.value) text = '•'.repeat(el.value.length);
    const t = controlText(el, cs, frame, text, color, false);
    if (t) {
      if (isButton) t.align = 'CENTER';
      frame.children.push(t);
    }
    return frame;
  }
  if (tag === 'TEXTAREA') {
    const ta = el as HTMLTextAreaElement;
    let text = ta.value;
    let color: RGBA | null = null;
    if (!text) {
      text = ta.placeholder;
      color = parseColor(getComputedStyle(el, '::placeholder').color);
    }
    const t = controlText(el, cs, frame, text, color, true);
    if (t) frame.children.push(t);
    frame.clip = true;
    return frame;
  }
  if (tag === 'SELECT') {
    const sel = el as HTMLSelectElement;
    const text = sel.selectedOptions[0]?.text ?? '';
    const t = controlText(el, cs, frame, text, null, false);
    if (t) frame.children.push(t);
    if (cs.appearance !== 'none' && (cs.getPropertyValue('-webkit-appearance') || cs.appearance) !== 'none') {
      const s = 10;
      const content = contentBox(el, cs, frame);
      const color = cs.color;
      frame.children.push({
        kind: 'svg', name: 'chevron', x: content.x + content.w - s, y: frame.y + (frame.h - s) / 2, w: s, h: s, outOfFlow: true,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`,
      });
    }
    return frame;
  }
  if (tag === 'PROGRESS' || tag === 'METER') {
    const p = el as HTMLProgressElement;
    const ratio = p.max ? Math.min(1, Math.max(0, p.value / p.max)) : 0;
    if (!frame.fills.length) frame.fills = [{ type: 'solid', color: { r: 0.9, g: 0.9, b: 0.9, a: 1 } }];
    frame.radius = frame.radius ?? [frame.h / 2, frame.h / 2, frame.h / 2, frame.h / 2];
    frame.clip = true;
    frame.children.push({
      kind: 'frame', tag: 'bar', name: 'value', x: frame.x, y: frame.y, w: frame.w * ratio, h: frame.h,
      fills: [{ type: 'solid', color: parseColor(cs.accentColor) ?? { r: 0, g: 0.46, b: 1, a: 1 } }], clip: false, children: [],
    });
    return frame;
  }
  return frame;
}

function svgElement(el: SVGSVGElement, cs: CSSStyleDeclaration, ctx: Ctx): NodeSpec | null {
  const box = boxOf(el, ctx);
  if (box.w <= 0 || box.h <= 0) return null;
  let svg: string;
  try {
    svg = serializeSvg(el, box.w, box.h);
  } catch (e) {
    ctx.warnings.add(`SVG не вдалося серіалізувати: ${(e as Error).message}`);
    return null;
  }
  const spec: SvgSpec = { kind: 'svg', name: nameOf(el), svg, ...box };
  const opacity = parseFloat(cs.opacity);
  if (opacity < 1) spec.opacity = opacity;
  if (isOutOfFlow(cs)) spec.outOfFlow = true;
  // Raster fallback in case Figma rejects the SVG markup.
  const id = ctx.images.reserve();
  spec.fallbackImageId = id;
  ctx.pending.push(
    rasterizeSvg(svg, box.w * 2, box.h * 2).then((r) => {
      if (r) ctx.images.setLoaded(id, r);
      else spec.fallbackImageId = undefined;
    }),
  );
  return spec;
}



interface Visit {
  nodes: NodeSpec[];
  /** negative z-index descendants that must be painted by an ancestor stacking context */
  hoisted: Painted[];
}

const EMPTY: Visit = { nodes: [], hoisted: [] };

function createsStackingContext(el: Element, cs: CSSStyleDeclaration, parentDisplay: string): boolean {
  if (el === el.ownerDocument.documentElement) return true;
  const zSet = cs.zIndex !== 'auto';
  if (zSet && (cs.position !== 'static' || /flex|grid/.test(parentDisplay))) return true;
  if (cs.position === 'fixed' || cs.position === 'sticky') return true;
  return (
    parseFloat(cs.opacity) < 1 || cs.transform !== 'none' || cs.filter !== 'none' ||
    cs.isolation === 'isolate' || cs.mixBlendMode !== 'normal' || (cs.contain || '').includes('paint') ||
    (cs.getPropertyValue('backdrop-filter') || 'none') !== 'none' || /transform|opacity|filter/.test(cs.willChange)
  );
}

/** Returns the visual nodes generated by an element (several for display: contents). */
function visitElement(el: Element, ctx: Ctx, parentDisplay: string): Visit {
  if (SKIP_TAGS.has(el.tagName) || el.hasAttribute('data-h2f-ignore')) return EMPTY;
  const cs = getComputedStyle(el);
  if (cs.display === 'none') return EMPTY;
  if (cs.display === 'contents') {
    const items = collectChildren(el, cs, ctx, parentDisplay);
    return { nodes: paintOrder(items.filter((p) => p.layer > 0)), hoisted: items.filter((p) => p.layer === 0) };
  }
  if (el.getClientRects().length === 0) return EMPTY;
  if (el instanceof SVGSVGElement) {
    if (cs.visibility !== 'visible') return EMPTY;
    const s = svgElement(el, cs, ctx);
    return { nodes: s ? [s] : [], hoisted: [] };
  }
  if (el instanceof SVGElement) return EMPTY; // stray SVG children outside an <svg>
  if (el instanceof HTMLImageElement) return { nodes: [imageElement(el, cs, ctx)], hoisted: [] };
  if (el instanceof HTMLCanvasElement || el instanceof HTMLVideoElement || el.tagName === 'IFRAME' || el.tagName === 'OBJECT' || el.tagName === 'EMBED') {
    return { nodes: [canvasLike(el, cs, ctx)], hoisted: [] };
  }
  if (el instanceof HTMLInputElement || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'PROGRESS' || el.tagName === 'METER') {
    return { nodes: [formControl(el, cs, ctx)], hoisted: [] };
  }
  const frame = makeFrame(el, cs, ctx);
  const flex = flexSpec(cs);
  if (flex) frame.flex = flex;
  const items = collectChildren(el, cs, ctx, cs.display);
  if (createsStackingContext(el, cs, parentDisplay)) {
    frame.children.push(...paintOrder(items));
    return { nodes: [frame], hoisted: [] };
  }
  // Not a stacking context: negative z-index descendants are painted *below* this element's
  // background by the nearest stacking context ancestor.
  frame.children.push(...paintOrder(items.filter((p) => p.layer > 0)));
  return { nodes: [frame], hoisted: items.filter((p) => p.layer === 0) };
}

function stackingKey(cs: CSSStyleDeclaration, parentDisplay: string): { layer: number; z: number } {
  const positioned = cs.position !== 'static';
  const zAuto = cs.zIndex === 'auto';
  const z = zAuto ? 0 : parseInt(cs.zIndex, 10) || 0;
  const flexItem = /flex|grid/.test(parentDisplay);
  if (positioned || (flexItem && !zAuto)) {
    if (z < 0) return { layer: 0, z };
    if (z > 0) return { layer: 3, z };
    return { layer: 2, z: 0 };
  }
  if (parseFloat(cs.opacity) < 1 || cs.transform !== 'none') return { layer: 2, z: 0 };
  return { layer: 1, z: 0 };
}

function paintOrder(items: Painted[]): NodeSpec[] {
  return items
    .slice()
    .sort((a, b) => a.layer - b.layer || a.z - b.z || a.order - b.order)
    .map((p) => p.node);
}

/** Inline elements with a visible box (background / border / shadow), e.g. <mark>, <code>, pill links. */
function inlineDecorations(el: Element, cs: CSSStyleDeclaration, ctx: Ctx): NodeSpec[] {
  const bg = parseColor(cs.backgroundColor);
  const hasBg = isVisibleColor(bg) || (cs.backgroundImage !== 'none' && !(cs.getPropertyValue('background-clip') || cs.getPropertyValue('-webkit-background-clip')).includes('text'));
  const b = borders(cs);
  const shadows = parseShadows(cs.boxShadow);
  if (!hasBg && !b.stroke && !b.sides && !shadows.length) return [];
  if (cs.visibility !== 'visible') return [];
  const out: NodeSpec[] = [];
  const rects = [...el.getClientRects()];
  rects.forEach((r, i) => {
    const box = { x: round(r.left + ctx.sx), y: round(r.top + ctx.sy), w: round(r.width), h: round(r.height) };
    if (box.w <= 0 || box.h <= 0) return;
    const frame: FrameSpec = {
      kind: 'frame', tag: el.tagName.toLowerCase(), name: `${nameOf(el)} (bg)`, ...box,
      fills: [], clip: false, children: [],
    };
    frame.fills = backgroundFills(el, cs, box, frame, ctx);
    if (b.stroke) {
      frame.stroke = { ...b.stroke };
      // Slices: no left border except on the first fragment, no right except on the last.
      if (i > 0) frame.stroke.left = 0;
      if (i < rects.length - 1) frame.stroke.right = 0;
    }
    const rad = radii(cs, box.w, box.h);
    if (rad) {
      if (i > 0) rad[0] = rad[3] = 0;
      if (i < rects.length - 1) rad[1] = rad[2] = 0;
      frame.radius = rad;
    }
    if (shadows.length) frame.shadows = shadows;
    out.push(frame);
  });
  return out;
}

/** Children in the flat tree: open shadow roots and <slot> assignments (web components). */
function flatChildren(el: Element): Iterable<Node> {
  if (el.shadowRoot) return el.shadowRoot.childNodes;
  if (el instanceof HTMLSlotElement) {
    const assigned = el.assignedNodes({ flatten: true });
    if (assigned.length) return assigned;
  }
  return el.childNodes;
}

function collectChildren(el: Element, cs: CSSStyleDeclaration, ctx: Ctx, outerDisplay = cs.display): Painted[] {
  const painted: Painted[] = [];
  let order = 0;
  const box = boxOf(el, ctx);
  const block: BlockContext = {
    align: alignOf(cs),
    content: contentBox(el, cs, box),
    mode: ctx.opts.textMode,
    ellipsis: cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible' && /nowrap|pre$/.test(cs.whiteSpace),
    scrollX: ctx.sx,
    scrollY: ctx.sy,
  };
  let run: InlineItem[] = [];
  let decor: NodeSpec[] = [];
  // display: contents elements lay their children out in the parent's formatting context.
  const parentDisplay = cs.display === 'contents' ? outerDisplay : cs.display;

  const flush = () => {
    for (const d of decor) painted.push({ node: d, layer: 1, z: 0, order: order++ });
    decor = [];
    if (run.some((i) => i.kind === 'text')) {
      for (const t of buildTextSpecs(run, block)) painted.push({ node: t, layer: 1, z: 0, order: order++ });
    }
    run = [];
  };

  const pushElement = (child: Element, childCs: CSSStyleDeclaration) => {
    const { nodes, hoisted } = visitElement(child, ctx, parentDisplay);
    for (const h of hoisted) painted.push({ ...h, order: order++ });
    const key = stackingKey(childCs, parentDisplay);
    for (const n of nodes) painted.push({ node: n, ...key, order: order++ });
  };

  const walkInline = (parent: Element) => {
    for (const child of flatChildren(parent)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child as Text;
        if (t.data.length) run.push({ kind: 'text', node: t, el: parent });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const c = child as Element;
      if (SKIP_TAGS.has(c.tagName) || c.hasAttribute('data-h2f-ignore')) continue;
      if (c.tagName === 'BR') {
        run.push({ kind: 'br' });
        continue;
      }
      const ccs = getComputedStyle(c);
      if (ccs.display === 'none') continue;
      if (ccs.display === 'contents') {
        // Children participate in this element's layout.
        flush();
        pushElement(c, ccs);
        continue;
      }
      if (isInlineFlow(c, ccs)) {
        decor.push(...inlineDecorations(c, ccs, ctx));
        walkInline(c);
        continue;
      }
      if (isOutOfFlow(ccs) || ccs.cssFloat !== 'none') {
        // Doesn't interrupt the line flow.
        pushElement(c, ccs);
        continue;
      }
      // Block or atomic inline: ends the current text run.
      flush();
      pushElement(c, ccs);
    }
  };

  walkInline(el);
  flush();
  return painted;
}

// ---------- entry ----------

export function createContext(base: Omit<Ctx, 'skipBackground' | 'afterLoad' | 'pending'>): Ctx {
  return { ...base, skipBackground: new Set(), afterLoad: [], pending: [] };
}

/** The element whose background is painted on the whole canvas (html, or body if html has none). */
function canvasElement(doc: Document): Element {
  const html = doc.documentElement;
  const htmlCs = getComputedStyle(html);
  if (!isVisibleColor(parseColor(htmlCs.backgroundColor)) && htmlCs.backgroundImage === 'none' && doc.body) return doc.body;
  return html;
}

export function serializeDocument(doc: Document, full: Ctx): FrameSpec {
  const html = doc.documentElement;
  const body = doc.body;
  const htmlCs = getComputedStyle(html);
  // Horizontal overflow is part of the page too (it's reachable by scrolling).
  const vw = Math.max(full.opts.viewportWidth, html.scrollWidth, body?.scrollWidth ?? 0);
  const height = Math.max(
    html.scrollHeight, body?.scrollHeight ?? 0, html.getBoundingClientRect().height, full.opts.viewportHeight,
  );
  const canvasEl = canvasElement(doc);
  const root: FrameSpec = {
    kind: 'frame', tag: 'html', name: doc.title || 'HTML page', x: 0, y: 0, w: vw, h: Math.ceil(height),
    fills: [], clip: true, children: [],
  };
  const canvasFills = backgroundFills(canvasEl, getComputedStyle(canvasEl), { x: 0, y: 0, w: vw, h: root.h }, root, full);
  root.fills = [{ type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }, ...canvasFills];
  full.skipBackground.add(canvasEl);

  // <html> itself: we render its children directly into the root frame.
  const htmlFrame = makeFrame(html, htmlCs, full);
  const kids = paintOrder(collectChildren(html, htmlCs, full));
  root.children.push(...htmlFrame.children, ...kids);
  return root;
}

/**
 * Serializes one element (a slide) as a standalone root frame. Its own background is kept;
 * where it is transparent the page canvas background shows through, as on screen.
 */
export function serializeSubtree(el: Element, full: Ctx, name: string): FrameSpec {
  const parentDisplay = el.parentElement ? getComputedStyle(el.parentElement).display : 'block';
  const box = boxOf(el, full);
  const visit = visitElement(el, full, parentDisplay);
  let root: FrameSpec;
  const first = visit.nodes[0];
  if (visit.nodes.length === 1 && first.kind === 'frame') {
    root = first;
  } else {
    root = { kind: 'frame', tag: el.tagName.toLowerCase(), name, ...box, fills: [], clip: true, children: visit.nodes };
  }
  root.name = name;
  root.clip = true;
  delete root.outOfFlow;
  delete root.opacity;
  // Negative z-index content of the slide sits right above the canvas background.
  root.children.unshift(...paintOrder(visit.hoisted));

  const opaque = root.fills.some((f) => f.type !== 'solid' || f.color.a >= 0.999);
  if (!opaque) {
    const canvasEl = canvasElement(el.ownerDocument);
    const underlay: FillSpec[] = [{ type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }];
    if (canvasEl !== el) {
      const holder: FrameSpec = { ...root, children: [] };
      underlay.push(...backgroundFills(canvasEl, getComputedStyle(canvasEl), { x: root.x, y: root.y, w: root.w, h: root.h }, holder, full));
    }
    root.fills = [...underlay, ...root.fills];
  }
  // Rounded / shadowed slides: the frame is the slide itself, so drop page-level effects.
  delete root.shadows;
  return root;
}

export type { Ctx };
