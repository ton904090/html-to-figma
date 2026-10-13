// Minimal in-browser mock of the Figma plugin API. Every node is backed by a DOM element,
// so the result of dist/code.js can be screenshotted and compared with the original page.
(function () {
  const stage = document.createElement('div');
  stage.id = 'figma-stage';
  stage.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;';
  document.body.appendChild(stage);

  const images = new Map();
  let imageCounter = 0;
  const rgba = (c, o = 1) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${(c.a ?? 1) * o})`;

  function parseStyle(style) {
    const s = style.toLowerCase().replace(/[\s_-]/g, '');
    let w = 400;
    if (/thin/.test(s)) w = 100; else if (/extralight/.test(s)) w = 200; else if (/light/.test(s)) w = 300;
    else if (/semibold/.test(s)) w = 600; else if (/extrabold/.test(s)) w = 800; else if (/black/.test(s)) w = 900;
    else if (/bold/.test(s)) w = 700; else if (/medium/.test(s)) w = 500;
    return { weight: w, italic: /italic/.test(s) };
  }

  function invert(m) {
    const [[a, c, e], [b, d, f]] = m;
    const det = a * d - b * c;
    return [[d / det, -c / det, (c * f - d * e) / det], [-b / det, a / det, (b * e - a * f) / det]];
  }
  const apply = (m, x, y) => ({ x: m[0][0] * x + m[0][1] * y + m[0][2], y: m[1][0] * x + m[1][1] * y + m[1][2] });

  function paintToCss(p, w, h) {
    if (p.visible === false) return null;
    if (p.type === 'SOLID') {
      const c = rgba(p.color, p.opacity ?? 1);
      return { image: `linear-gradient(${c},${c})`, size: '100% 100%', pos: '0 0', repeat: 'no-repeat' };
    }
    if (p.type === 'GRADIENT_LINEAR') {
      const M = invert(p.gradientTransform);
      const a = apply(M, 0, 0.5), b = apply(M, 1, 0.5);
      const p0 = { x: a.x * w, y: a.y * h }, p1 = { x: b.x * w, y: b.y * h };
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      const dir = { x: dx / len, y: dy / len };
      const angle = Math.atan2(dir.x, -dir.y) * 180 / Math.PI;
      const L = Math.abs(w * dir.x) + Math.abs(h * dir.y);
      const cs = { x: w / 2 - dir.x * L / 2, y: h / 2 - dir.y * L / 2 };
      const stops = p.gradientStops.map((s) => {
        const pt = { x: p0.x + dx * s.position, y: p0.y + dy * s.position };
        const pos = ((pt.x - cs.x) * dir.x + (pt.y - cs.y) * dir.y) / L;
        return `${rgba(s.color)} ${(pos * 100).toFixed(3)}%`;
      });
      return { image: `linear-gradient(${angle}deg, ${stops.join(',')})`, size: '100% 100%', pos: '0 0', repeat: 'no-repeat' };
    }
    if (p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_ANGULAR') {
      const M = invert(p.gradientTransform);
      const c = apply(M, 0.5, 0.5);
      const ex = apply(M, 1, 0.5);
      const ey = apply(M, 0.5, 1);
      const rx = Math.hypot((ex.x - c.x) * w, (ex.y - c.y) * h);
      const ry = Math.hypot((ey.x - c.x) * w, (ey.y - c.y) * h);
      const stops = p.gradientStops.map((s) => `${rgba(s.color)} ${(s.position * 100).toFixed(3)}%`);
      if (p.type === 'GRADIENT_RADIAL')
        return { image: `radial-gradient(${rx}px ${ry}px at ${c.x * w}px ${c.y * h}px, ${stops.join(',')})`, size: '100% 100%', pos: '0 0', repeat: 'no-repeat' };
      const ang = Math.atan2((ex.y - c.y) * h, (ex.x - c.x) * w) * 180 / Math.PI + 90;
      return { image: `conic-gradient(from ${ang}deg at ${c.x * w}px ${c.y * h}px, ${stops.join(',')})`, size: '100% 100%', pos: '0 0', repeat: 'no-repeat' };
    }
    if (p.type === 'IMAGE') {
      const img = images.get(p.imageHash);
      if (!img) return null;
      const url = `url(${img.url})`;
      if (p.scaleMode === 'FILL') return { image: url, size: 'cover', pos: 'center', repeat: 'no-repeat' };
      if (p.scaleMode === 'FIT') return { image: url, size: 'contain', pos: 'center', repeat: 'no-repeat' };
      if (p.scaleMode === 'TILE') {
        const f = p.scalingFactor ?? 1;
        return { image: url, size: img.w ? `${img.w * f}px ${img.h * f}px` : 'auto', pos: '0 0', repeat: 'repeat' };
      }
      const T = p.imageTransform || [[1, 0, 0], [0, 1, 0]];
      const iw = w / T[0][0], ih = h / T[1][1];
      return { image: url, size: `${iw}px ${ih}px`, pos: `${-T[0][2] * iw}px ${-T[1][2] * ih}px`, repeat: 'no-repeat' };
    }
    return null;
  }

  let idCounter = 0;
  class Node {
    constructor(type) {
      this.id = `${++idCounter}:1`;
      this.type = type;
      this.el = document.createElement('div');
      this.el.dataset.type = type;
      this.el.style.position = 'absolute';
      this.el.style.boxSizing = 'border-box';
      this._x = 0; this._y = 0; this._w = 100; this._h = 100;
      this.children = [];
      this.parent = null;
      this._fills = [];
      this._strokes = [];
      this._effects = [];
      this.strokeAlign = 'INSIDE';
      this._sw = { t: 1, r: 1, b: 1, l: 1 };
      this._radius = [0, 0, 0, 0];
      this.opacity = 1;
      this.blendMode = 'PASS_THROUGH';
      this._name = type;
      this._layoutMode = 'NONE';
    }
    set layoutMode(v) { this._layoutMode = v; if (v !== 'NONE') this._relayout(); }
    get layoutMode() { return this._layoutMode; }
    set name(v) { this._name = v; this.el.dataset.name = v; }
    get name() { return this._name; }
    get x() { this._sync(); return this._x; } set x(v) { this._x = v; this.el.style.left = `${v}px`; }
    get y() { this._sync(); return this._y; } set y(v) { this._y = v; this.el.style.top = `${v}px`; }
    _sync() { const p = this.parent; if (p && p.layoutMode && p.layoutMode !== 'NONE' && this.layoutPositioning !== 'ABSOLUTE') p._relayout(); }
    // Simplified Auto Layout (no wrap): enough to exercise the plugin's apply/verify/revert logic.
    _relayout() {
      if (!this.layoutMode || this.layoutMode === 'NONE') return;
      const hz = this.layoutMode === 'HORIZONTAL';
      const kids = this.children.filter((c) => c.layoutPositioning !== 'ABSOLUTE');
      const pt = this.paddingTop || 0, pr = this.paddingRight || 0, pb = this.paddingBottom || 0, pl = this.paddingLeft || 0;
      const main = (c) => (hz ? c._w : c._h);
      const cross = (c) => (hz ? c._h : c._w);
      const avail = (hz ? this._w - pl - pr : this._h - pt - pb);
      const crossAvail = (hz ? this._h - pt - pb : this._w - pl - pr);
      const total = kids.reduce((a, c) => a + main(c), 0);
      let gap = this.itemSpacing || 0;
      let pos = 0;
      const free = avail - total - gap * Math.max(0, kids.length - 1);
      const pa = this.primaryAxisAlignItems || 'MIN';
      if (pa === 'CENTER') pos = free / 2;
      else if (pa === 'MAX') pos = free;
      else if (pa === 'SPACE_BETWEEN' && kids.length > 1) gap = (avail - total) / (kids.length - 1);
      const ca = this.counterAxisAlignItems || 'MIN';
      for (const c of kids) {
        const off = ca === 'CENTER' ? (crossAvail - cross(c)) / 2 : ca === 'MAX' ? crossAvail - cross(c) : 0;
        const mx = (hz ? pl : pt) + pos;
        const cx = (hz ? pt : pl) + off;
        c._x = hz ? mx : cx; c._y = hz ? cx : mx;
        c.el.style.left = `${c._x}px`; c.el.style.top = `${c._y}px`;
        pos += main(c) + gap;
      }
    }
    get width() { return this._w; }
    get height() { return this._h; }
    resize(w, h) { this._w = w; this._h = h; this.el.style.width = `${w}px`; this.el.style.height = `${h}px`; this._paint(); }
    set opacity(v) { this._op = v; this.el.style.opacity = v; } get opacity() { return this._op; }
    set blendMode(v) { this._blend = v; if (this.el) this.el.style.mixBlendMode = v === 'PASS_THROUGH' || v === 'NORMAL' ? '' : v.toLowerCase().replace('_', '-'); }
    get blendMode() { return this._blend; }
    get fills() { return this._fills; } set fills(v) { this._fills = v; this._paint(); }
    get strokes() { return this._strokes; } set strokes(v) { this._strokes = v; this._paint(); }
    get effects() { return this._effects; } set effects(v) { this._effects = v; this._paint(); }
    set strokeWeight(v) { this._sw = { t: v, r: v, b: v, l: v }; this._paint(); }
    set strokeTopWeight(v) { this._sw.t = v; this._paint(); }
    set strokeRightWeight(v) { this._sw.r = v; this._paint(); }
    set strokeBottomWeight(v) { this._sw.b = v; this._paint(); }
    set strokeLeftWeight(v) { this._sw.l = v; this._paint(); }
    set cornerRadius(v) { this._radius = [v, v, v, v]; this._paint(); }
    set topLeftRadius(v) { this._radius[0] = v; this._paint(); }
    set topRightRadius(v) { this._radius[1] = v; this._paint(); }
    set bottomRightRadius(v) { this._radius[2] = v; this._paint(); }
    set bottomLeftRadius(v) { this._radius[3] = v; this._paint(); }
    set clipsContent(v) { this._clip = v; this.el.style.overflow = v ? 'hidden' : 'visible'; } get clipsContent() { return this._clip; }
    set dashPattern(v) { this._dash = v; this._paint(); }
    appendChild(c) {
      if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1);
      c.parent = this; this.children.push(c); this.el.appendChild(c.el);
    }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); } this.el.remove(); }
    _paint() {
      const s = this.el.style;
      const layers = this._fills.map((p) => paintToCss(p, this._w, this._h)).filter(Boolean).reverse();
      if (this.type !== 'TEXT') {
        s.backgroundImage = layers.map((l) => l.image).join(',');
        s.backgroundSize = layers.map((l) => l.size).join(',');
        s.backgroundPosition = layers.map((l) => l.pos).join(',');
        s.backgroundRepeat = layers.map((l) => l.repeat).join(',');
      }
      s.borderRadius = this._radius.map((r) => `${r}px`).join(' ');
      const shadows = [];
      for (const e of this._effects) {
        if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
          const v = `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${e.offset.x}px ${e.offset.y}px ${e.radius}px ${e.spread || 0}px ${rgba(e.color)}`;
          shadows.unshift(v);
        }
      }
      if (this.type === 'TEXT') s.textShadow = shadows.map((x) => x.replace(/ [-\d.]+px rgba/, ' rgba')).join(',');
      else s.boxShadow = shadows.join(',');
      const blur = this._effects.find((e) => e.type === 'LAYER_BLUR');
      s.filter = blur ? `blur(${blur.radius / 2}px)` : '';
      const bblur = this._effects.find((e) => e.type === 'BACKGROUND_BLUR');
      s.backdropFilter = bblur ? `blur(${bblur.radius / 2}px)` : '';
      // strokes as an overlay
      let ov = this._strokeEl;
      if (this._strokes.length && this.type !== 'TEXT') {
        if (!ov) { ov = this._strokeEl = document.createElement('div'); ov.style.cssText = 'position:absolute;pointer-events:none;box-sizing:border-box;'; ov.dataset.stroke = '1'; }
        const c = rgba(this._strokes[0].color, this._strokes[0].opacity ?? 1);
        const sw = this._sw;
        const out = this.strokeAlign === 'OUTSIDE' ? 1 : 0;
        ov.style.left = `${-sw.l * out}px`; ov.style.top = `${-sw.t * out}px`;
        ov.style.right = `${-sw.r * out}px`; ov.style.bottom = `${-sw.b * out}px`;
        const style = this._dash ? (this._dash[0] === this._dash[1] ? 'dotted' : 'dashed') : 'solid';
        ov.style.borderStyle = style;
        ov.style.borderColor = c;
        ov.style.borderWidth = `${sw.t}px ${sw.r}px ${sw.b}px ${sw.l}px`;
        ov.style.borderRadius = s.borderRadius;
        if (ov.parentNode !== this.el) this.el.appendChild(ov);
      } else if (ov) ov.remove();
    }
  }

  class TextNode extends Node {
    constructor() {
      super('TEXT');
      this._chars = '';
      this._ranges = [];
      this._fontName = { family: 'Inter', style: 'Regular' };
      this._auto = 'WIDTH_AND_HEIGHT';
      this.textAlignHorizontal = 'LEFT';
      this._defaults = { size: 12, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], lh: { unit: 'AUTO' }, ls: 0, deco: 'NONE', tcase: 'ORIGINAL' };
    }
    set fontName(v) { this._fontName = v; this._layout(); } get fontName() { return this._fontName; }
    set characters(v) { this._chars = v; this._ranges = []; this._layout(); } get characters() { return this._chars; }
    _set(start, end, key, value) { this._ranges.push({ start, end, key, value }); this._layout(); }
    setRangeFontName(s, e, v) { this._set(s, e, 'font', v); }
    setRangeFontSize(s, e, v) { this._set(s, e, 'size', v); }
    setRangeFills(s, e, v) { this._set(s, e, 'fills', v); }
    setRangeTextDecoration(s, e, v) { this._set(s, e, 'deco', v); }
    setRangeLetterSpacing(s, e, v) { this._set(s, e, 'ls', v.value); }
    setRangeLineHeight(s, e, v) { this._set(s, e, 'lh', v); }
    setRangeTextCase(s, e, v) { this._set(s, e, 'tcase', v); }
    setRangeHyperlink() {}
    set textAutoResize(v) { this._auto = v; this._layout(); } get textAutoResize() { return this._auto; }
    set textTruncation(v) { this._trunc = v; this._layout(); } get textTruncation() { return this._trunc || 'DISABLED'; }
    set maxLines(v) { this._maxLines = v; }
    set textAlignHorizontal(v) { this._align = v; if (this.el) this._layout(); } get textAlignHorizontal() { return this._align; }
    get fills() { return this._fills; } set fills(v) { this._fills = v; this._layout(); }
    resize(w, h) { this._w = w; this._h = h; this._layout(); }
    _styleAt(i) {
      const st = { ...this._defaults, font: this._fontName };
      for (const r of this._ranges) if (i >= r.start && i < r.end) st[r.key] = r.value;
      return st;
    }
    _layout() {
      if (!this.el) return;
      const el = this.el;
      el.innerHTML = '';
      el.style.whiteSpace = this._auto === 'WIDTH_AND_HEIGHT' ? 'pre' : 'pre-wrap';
      el.style.textAlign = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[this._align] || 'left';
      el.style.width = this._auto === 'WIDTH_AND_HEIGHT' ? 'max-content' : `${this._w}px`;
      el.style.height = 'auto';
      const gradient = this._fills && this._fills.length && this._fills[0].type !== 'SOLID' ? paintToCss(this._fills[0], this._w, this._h) : null;
      let i = 0;
      while (i < this._chars.length) {
        const st = this._styleAt(i);
        const key = JSON.stringify(st);
        let j = i + 1;
        while (j < this._chars.length && JSON.stringify(this._styleAt(j)) === key) j++;
        const span = document.createElement('span');
        span.textContent = this._chars.slice(i, j);
        const f = parseStyle(st.font.style);
        span.style.fontFamily = `"${st.font.family}"`;
        span.style.fontWeight = f.weight;
        span.style.fontStyle = f.italic ? 'italic' : 'normal';
        span.style.fontSize = `${st.size}px`;
        span.style.lineHeight = st.lh.unit === 'PIXELS' ? `${st.lh.value}px` : 'normal';
        span.style.letterSpacing = `${st.ls}px`;
        span.style.textDecoration = st.deco === 'UNDERLINE' ? 'underline' : st.deco === 'STRIKETHROUGH' ? 'line-through' : 'none';
        span.style.textTransform = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[st.tcase] || 'none';
        const fill = st.fills[0];
        if (gradient) {
          span.style.color = 'transparent';
          el.style.backgroundImage = gradient.image;
          el.style.webkitBackgroundClip = 'text';
        } else if (fill) span.style.color = rgba(fill.color, fill.opacity ?? 1);
        el.appendChild(span);
        i = j;
      }
      // No CSS "strut": Figma has no parent font, so mirror the first run's font on the block.
      const st0 = this._styleAt(0);
      const f0 = parseStyle(st0.font.style);
      el.style.fontFamily = `"${st0.font.family}"`;
      el.style.fontSize = `${st0.size}px`;
      el.style.fontWeight = f0.weight;
      // line-height of the block = max of spans, as in Figma
      const lhs = [...el.children].map((s) => s.style.lineHeight);
      el.style.lineHeight = lhs.find((l) => l !== 'normal') || 'normal';
      if (this._auto === 'NONE') {
        el.style.width = `${this._w}px`;
        el.style.height = `${this._h}px`;
        if (this._trunc === 'ENDING') { el.style.whiteSpace = 'pre'; el.style.overflow = 'hidden'; el.style.textOverflow = 'ellipsis'; }
        return;
      }
      if (!el.isConnected) document.body.appendChild(el);
      const r = el.getBoundingClientRect();
      if (this._auto === 'WIDTH_AND_HEIGHT') this._w = r.width;
      this._h = r.height;
      el.style.width = `${this._w}px`;
      el.style.height = `${this._h}px`;
      if (el.parentNode === document.body) el.remove();
    }
  }

  const page = {
    children: [],
    selection: [],
    appendChild(n) { this.children.push(n); stage.appendChild(n.el); n.parent = this; },
  };

  function makeFrame() { const n = new Node('FRAME'); n._fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]; n._paint(); page.appendChild(n); return n; }

  globalThis.__html__ = '';
  globalThis.figma = {
    currentPage: page,
    viewport: { center: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 1000, height: 800 }, scrollAndZoomIntoView() {} },
    showUI() {},
    ui: {
      onmessage: null,
      postMessage(msg) { window.postMessage({ pluginMessage: msg, __fromMain: true }, '*'); },
      resize() {},
    },
    clientStorage: { async getAsync() { return undefined; }, async setAsync() {} },
    notify(m) { console.log('[figma.notify]', m); },
    createFrame: makeFrame,
    createSection() {
      const n = new Node('SECTION');
      n._fills = [];
      n.resizeWithoutConstraints = (w, h) => n.resize(w, h);
      page.appendChild(n);
      return n;
    },
    editorType: 'figma',
    createRectangle() { const n = new Node('RECTANGLE'); n._fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }]; n._paint(); page.appendChild(n); return n; },
    createText() { const n = new TextNode(); page.appendChild(n); return n; },
    createNodeFromSvg(svg) {
      if (!/^<svg[\s>]/.test(svg.trim()) && !/<svg/.test(svg)) throw new Error('bad svg');
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (doc.querySelector('parsererror')) throw new Error('Unable to parse SVG');
      const n = new Node('FRAME');
      n._fills = [];
      const w = parseFloat(doc.documentElement.getAttribute('width')) || 100;
      const h = parseFloat(doc.documentElement.getAttribute('height')) || 100;
      const img = document.createElement('img');
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      img.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
      n.el.appendChild(img);
      n.resize(w, h);
      page.appendChild(n);
      return n;
    },
    createImage(bytes) {
      const hash = `hash${++imageCounter}`;
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const entry = { url: `data:image/png;base64,${btoa(bin)}`, w: 0, h: 0 };
      const im = new Image();
      im.onload = () => { entry.w = im.naturalWidth; entry.h = im.naturalHeight; };
      im.src = entry.url;
      images.set(hash, entry);
      return { hash };
    },
    async listAvailableFontsAsync() {
      const fams = {
        Inter: ['Thin', 'Extra Light', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Black', 'Italic', 'Bold Italic'],
        'Liberation Serif': ['Regular', 'Bold', 'Italic', 'Bold Italic'],
        'Liberation Sans': ['Regular', 'Bold', 'Italic', 'Bold Italic'],
        'Liberation Mono': ['Regular', 'Bold'],
        'DejaVu Sans Mono': ['Book', 'Bold'],
      };
      const out = [];
      for (const [family, styles] of Object.entries(fams)) for (const style of styles) out.push({ fontName: { family, style } });
      return out;
    },
    async loadFontAsync() {},
  };

  // Route UI → main messages
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.pluginMessage && !d.__fromMain && typeof figma.ui.onmessage === 'function') {
      figma.ui.onmessage(d.pluginMessage, {});
    }
  });
})();
