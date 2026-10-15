"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));

  // src/main/fonts.ts
  var families = null;
  var GENERIC = {
    "sans-serif": ["Inter", "Roboto", "Arial", "Helvetica"],
    "ui-sans-serif": ["Inter", "Roboto", "Arial"],
    "system-ui": ["SF Pro Text", "SF Pro", "Segoe UI", "Inter", "Roboto"],
    "-apple-system": ["SF Pro Text", "SF Pro"],
    blinkmacsystemfont: ["SF Pro Text", "SF Pro"],
    serif: ["Times New Roman", "Georgia", "Noto Serif", "Roboto Serif", "PT Serif", "Merriweather"],
    "ui-serif": ["Georgia", "Times New Roman", "Noto Serif"],
    monospace: ["Roboto Mono", "JetBrains Mono", "Source Code Pro", "Courier New", "Menlo", "Fira Code"],
    "ui-monospace": ["SF Mono", "Menlo", "Roboto Mono", "JetBrains Mono", "Source Code Pro"],
    cursive: ["Comic Sans MS", "Caveat"],
    fantasy: ["Impact", "Bebas Neue"],
    emoji: [],
    math: []
  };
  function parseStyle(style) {
    const s = style.toLowerCase().replace(/[\s_-]/g, "");
    const italic = /italic|oblique/.test(s);
    let weight = 400;
    if (/thin|hairline/.test(s)) weight = 100;
    else if (/(extra|ultra)light/.test(s)) weight = 200;
    else if (/semilight|demilight/.test(s)) weight = 350;
    else if (/light/.test(s)) weight = 300;
    else if (/(semi|demi)bold/.test(s)) weight = 600;
    else if (/(extra|ultra)bold/.test(s)) weight = 800;
    else if (/extrablack|ultrablack/.test(s)) weight = 950;
    else if (/black|heavy/.test(s)) weight = 900;
    else if (/bold/.test(s)) weight = 700;
    else if (/medium/.test(s)) weight = 500;
    else if (/book/.test(s)) weight = 400;
    const num = /(\d{3})/.exec(s);
    if (num) weight = parseInt(num[1], 10);
    return { weight, italic };
  }
  async function ensureFamilies() {
    if (families) return families;
    families = /* @__PURE__ */ new Map();
    const list = await figma.listAvailableFontsAsync();
    for (const f of list) {
      const key = f.fontName.family.toLowerCase();
      let entry = families.get(key);
      if (!entry) {
        entry = { family: f.fontName.family, styles: [] };
        families.set(key, entry);
      }
      entry.styles.push(__spreadValues({ style: f.fontName.style }, parseStyle(f.fontName.style)));
    }
    return families;
  }
  function pickStyle(styles, weight, italic) {
    let best = styles[0];
    let bestScore = Infinity;
    for (const s of styles) {
      let score = Math.abs(s.weight - weight);
      if (s.italic !== italic) score += 1e3;
      if (weight >= 500 && s.weight < weight) score += 1;
      if (weight < 400 && s.weight > weight) score += 1;
      score += s.style.length * 1e-3;
      if (score < bestScore) {
        best = s;
        bestScore = score;
      }
    }
    return best;
  }
  var FontResolver = class {
    constructor() {
      this.cache = /* @__PURE__ */ new Map();
      this.missing = /* @__PURE__ */ new Map();
    }
    async resolve(spec) {
      var _a, _b, _c;
      const key = `${spec.families.join(",")}|${spec.weight}|${spec.italic}`;
      const hit = this.cache.get(key);
      if (hit) return hit;
      const fams = await ensureFamilies();
      let found;
      for (const raw of spec.families) {
        const name = raw.toLowerCase();
        found = fams.get(name);
        if (found) break;
        const generic = GENERIC[name];
        if (generic) {
          for (const g of generic) {
            found = fams.get(g.toLowerCase());
            if (found) break;
          }
          if (found) break;
        }
      }
      if (!found) {
        found = (_b = (_a = fams.get("inter")) != null ? _a : fams.get("roboto")) != null ? _b : fams.values().next().value;
        const wanted = (_c = spec.families[0]) != null ? _c : "(none)";
        if (!GENERIC[wanted.toLowerCase()]) this.missing.set(wanted, found.family);
      }
      const style = pickStyle(found.styles, spec.weight, spec.italic);
      const result = { family: found.family, style: style.style };
      this.cache.set(key, result);
      return result;
    }
  };
  var loaded = /* @__PURE__ */ new Set();
  async function loadFonts(fonts) {
    const failed = [];
    await Promise.all(
      fonts.map(async (f) => {
        const key = `${f.family}|${f.style}`;
        if (loaded.has(key)) return;
        try {
          await figma.loadFontAsync(f);
          loaded.add(key);
        } catch (e) {
          failed.push(f);
        }
      })
    );
    return failed;
  }

  // src/main/build.ts
  var MIN = 0.01;
  var Builder = class {
    constructor(result, options, progress) {
      this.result = result;
      this.options = options;
      this.progress = progress;
      this.hashes = /* @__PURE__ */ new Map();
      this.fonts = new FontResolver();
      this.fontByKey = /* @__PURE__ */ new Map();
      this.count = 0;
      this.total = 0;
      this.warnings = [];
    }
    /** Builds all frames; returns the top-level nodes to select. */
    async build() {
      this.progress("\u0421\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u044C\u2026");
      for (const [id, bytes] of Object.entries(this.result.images)) {
        try {
          this.hashes.set(id, figma.createImage(bytes).hash);
        } catch (e) {
          this.warnings.push(`Figma \u043D\u0435 \u043F\u0440\u0438\u0439\u043D\u044F\u043B\u0430 \u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u043D\u044F ${id}: ${e.message}`);
        }
      }
      this.progress("\u0417\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043D\u044F \u0448\u0440\u0438\u0444\u0442\u0456\u0432\u2026");
      for (const f of this.result.frames) await this.prepareFonts(f);
      this.total = this.result.frames.reduce((a, f) => a + countNodes(f), 0);
      const roots = [];
      for (const spec of this.result.frames) {
        const root = figma.createFrame();
        root.name = spec.name;
        root.resize(Math.max(1, spec.w), Math.max(1, spec.h));
        root.fills = this.paints(spec.fills);
        root.clipsContent = true;
        if (spec.radius) {
          const [tl, tr, br, bl] = spec.radius;
          Object.assign(root, { topLeftRadius: tl, topRightRadius: tr, bottomRightRadius: br, bottomLeftRadius: bl });
        }
        if (spec.stroke) this.applyStroke(root, spec.stroke);
        for (const child of spec.children) await this.create(child, root, { x: spec.x, y: spec.y }, false);
        roots.push(root);
      }
      for (const [wanted, used] of this.fonts.missing) {
        this.warnings.push(`\u0428\u0440\u0438\u0444\u0442 \xAB${wanted}\xBB \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0438\u0439 \u0443 Figma \u2014 \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u043D\u043E \xAB${used}\xBB.`);
      }
      if (this.result.kind === "page") {
        this.placeOnCanvas(roots[0]);
        return roots;
      }
      if (figma.editorType === "slides") return this.toFigmaSlides(roots);
      return [this.toSection(roots)];
    }
    /** Design files: slides laid out in a grid inside a section named after the deck. */
    toSection(frames) {
      const gap = 120;
      const pad = 120;
      const columns = Math.min(frames.length, frames.length <= 4 ? frames.length : 4);
      const cellW = Math.max(...frames.map((f) => f.width));
      const cellH = Math.max(...frames.map((f) => f.height));
      const rows = Math.ceil(frames.length / columns);
      const width = pad * 2 + columns * cellW + (columns - 1) * gap;
      const height = pad * 2 + rows * cellH + (rows - 1) * gap;
      let container;
      try {
        container = figma.createSection();
        container.resizeWithoutConstraints(width, height);
      } catch (e) {
        container = figma.createFrame();
        container.resize(width, height);
        container.fills = [];
      }
      container.name = this.result.title;
      frames.forEach((f, i) => {
        container.appendChild(f);
        f.x = pad + i % columns * (cellW + gap);
        f.y = pad + Math.floor(i / columns) * (cellH + gap);
      });
      this.placeOnCanvas(container);
      return container;
    }
    /** Figma Slides: one real slide per HTML slide, scaled to the 1920×1080 slide size. */
    toFigmaSlides(frames) {
      const out = [];
      for (const f of frames) {
        const slide = figma.createSlide();
        slide.name = f.name;
        const scale = Math.min(slide.width / f.width, slide.height / f.height);
        if (Math.abs(scale - 1) > 1e-3) f.rescale(scale);
        slide.appendChild(f);
        f.x = (slide.width - f.width) / 2;
        f.y = (slide.height - f.height) / 2;
        slide.fills = f.fills;
        out.push(slide);
      }
      return out;
    }
    placeOnCanvas(root) {
      let maxX = -Infinity;
      let minY = Infinity;
      for (const n of figma.currentPage.children) {
        if (n === root) continue;
        maxX = Math.max(maxX, n.x + n.width);
        minY = Math.min(minY, n.y);
      }
      if (maxX === -Infinity) {
        root.x = Math.round(figma.viewport.center.x - root.width / 2);
        root.y = Math.round(figma.viewport.center.y - Math.min(root.height, figma.viewport.bounds.height) / 2);
      } else {
        root.x = Math.round(maxX + 120);
        root.y = Math.round(minY);
      }
    }
    // ---------- fonts ----------
    fontKey(f) {
      return `${f.families.join(",")}|${f.weight}|${f.italic}`;
    }
    async prepareFonts(root) {
      const specs = /* @__PURE__ */ new Map();
      const visit = (n) => {
        if (n.kind === "text") for (const r of n.runs) specs.set(this.fontKey(r.font), r.font);
        else if (n.kind === "frame") n.children.forEach(visit);
      };
      visit(root);
      const names = [{ family: "Inter", style: "Regular" }];
      for (const [key, spec] of specs) {
        const name = await this.fonts.resolve(spec);
        this.fontByKey.set(key, name);
        names.push(name);
      }
      const failed = await loadFonts(names);
      for (const f of failed) {
        this.warnings.push(`\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0438\u0442\u0438 \u0448\u0440\u0438\u0444\u0442 ${f.family} ${f.style}.`);
        for (const [k, v] of this.fontByKey) if (v.family === f.family && v.style === f.style) this.fontByKey.set(k, { family: "Inter", style: "Regular" });
      }
    }
    // ---------- paints & effects ----------
    paints(fills) {
      var _a;
      const out = [];
      for (const f of fills != null ? fills : []) {
        if (f.type === "solid") {
          if (f.color.a <= 0) continue;
          out.push({ type: "SOLID", color: { r: f.color.r, g: f.color.g, b: f.color.b }, opacity: f.color.a });
        } else if (f.type === "image") {
          const hash = this.hashes.get(f.imageId);
          if (!hash) continue;
          const p = __spreadValues(__spreadValues({
            type: "IMAGE",
            imageHash: hash,
            scaleMode: f.scaleMode
          }, f.scaleMode === "CROP" && f.transform ? { imageTransform: f.transform } : {}), f.scaleMode === "TILE" ? { scalingFactor: (_a = f.scalingFactor) != null ? _a : 1 } : {});
          out.push(p);
        } else {
          const type = f.type === "linear" ? "GRADIENT_LINEAR" : f.type === "radial" ? "GRADIENT_RADIAL" : "GRADIENT_ANGULAR";
          out.push({
            type,
            gradientTransform: f.transform,
            gradientStops: f.stops.map((s) => ({ position: s.position, color: { r: s.r, g: s.g, b: s.b, a: s.a } }))
          });
        }
      }
      return out;
    }
    effects(shadows, layerBlur, backgroundBlur) {
      const out = [];
      for (const s of (shadows != null ? shadows : []).slice().reverse()) {
        const base = {
          color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
          offset: { x: s.x, y: s.y },
          radius: Math.max(0, s.blur),
          spread: s.spread,
          visible: true,
          blendMode: "NORMAL"
        };
        out.push(s.inset ? __spreadValues({ type: "INNER_SHADOW" }, base) : __spreadProps(__spreadValues({ type: "DROP_SHADOW" }, base), { showShadowBehindNode: false }));
      }
      if (layerBlur) out.push({ type: "LAYER_BLUR", blurType: "NORMAL", radius: layerBlur * 2, visible: true });
      if (backgroundBlur) out.push({ type: "BACKGROUND_BLUR", blurType: "NORMAL", radius: backgroundBlur * 2, visible: true });
      return out;
    }
    applyStroke(node, s) {
      node.strokes = [{ type: "SOLID", color: { r: s.color.r, g: s.color.g, b: s.color.b }, opacity: s.color.a }];
      node.strokeAlign = s.align;
      if (s.top === s.right && s.top === s.bottom && s.top === s.left) {
        node.strokeWeight = s.top;
      } else {
        node.strokeTopWeight = s.top;
        node.strokeRightWeight = s.right;
        node.strokeBottomWeight = s.bottom;
        node.strokeLeftWeight = s.left;
      }
      if (s.dash) {
        node.dashPattern = s.dash;
        if (s.dash[0] === s.dash[1]) node.strokeCap = "ROUND";
      }
    }
    // ---------- nodes ----------
    async tick() {
      this.count++;
      if (this.count % 150 === 0) {
        this.progress(`\u0421\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0448\u0430\u0440\u0456\u0432 ${this.count}/${this.total}`, this.count / this.total);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    async create(spec, parent, origin, inAutoLayout) {
      await this.tick();
      try {
        if (spec.kind === "text") return [this.createText(spec, parent, origin)];
        if (spec.kind === "svg") return [this.createSvg(spec, parent, origin)];
        return await this.createFrame(spec, parent, origin, inAutoLayout);
      } catch (e) {
        this.warnings.push(`\u041F\u043E\u043C\u0438\u043B\u043A\u0430 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \xAB${spec.name}\xBB: ${e.message}`);
        return [];
      }
    }
    async createFrame(spec, parent, origin, inAutoLayout) {
      const wantsAutoLayout = this.options.autoLayout && !!spec.flex && !spec.flex.reverse;
      if (this.options.flattenWrappers && spec.passive && !wantsAutoLayout && !inAutoLayout && !spec.radius) {
        const out = [];
        for (const c of spec.children) out.push(...await this.create(c, parent, origin, false));
        if (spec.children.length || !spec.w || !spec.h) return out;
        return out;
      }
      const leaf = spec.children.length === 0 && !spec.clip;
      const node = leaf ? figma.createRectangle() : figma.createFrame();
      parent.appendChild(node);
      node.name = spec.name;
      node.resize(Math.max(MIN, spec.w), Math.max(MIN, spec.h));
      node.x = spec.x - origin.x;
      node.y = spec.y - origin.y;
      node.fills = this.paints(spec.fills);
      if (spec.stroke) this.applyStroke(node, spec.stroke);
      if (spec.radius) {
        const [tl, tr, br, bl] = spec.radius;
        if (tl === tr && tl === br && tl === bl) node.cornerRadius = tl;
        else {
          node.topLeftRadius = tl;
          node.topRightRadius = tr;
          node.bottomRightRadius = br;
          node.bottomLeftRadius = bl;
        }
      }
      const fx = this.effects(spec.shadows, spec.layerBlur, spec.backgroundBlur);
      if (fx.length) node.effects = fx;
      if (spec.opacity !== void 0) node.opacity = spec.opacity;
      if (spec.blendMode) node.blendMode = spec.blendMode;
      if (node.type === "FRAME") {
        node.clipsContent = spec.clip;
        const children = [];
        for (const c of spec.children) {
          for (const n of await this.create(c, node, { x: spec.x, y: spec.y }, wantsAutoLayout)) children.push({ node: n, spec: c });
        }
        if (wantsAutoLayout) this.tryAutoLayout(node, spec, children);
      }
      return [node];
    }
    /**
     * Turns a flex container into an Auto Layout frame, then verifies that every child kept its
     * browser position. If anything moved (margins, order, z-index…), the change is reverted.
     */
    tryAutoLayout(frame, spec, children) {
      const flex = spec.flex;
      const expected = children.map((c) => ({ node: c.node, x: c.node.x, y: c.node.y, w: c.node.width, h: c.node.height, abs: !!c.spec.outOfFlow }));
      const inFlow = expected.filter((e) => !e.abs);
      if (!inFlow.length) return;
      try {
        frame.layoutMode = flex.direction;
        frame.primaryAxisSizingMode = "FIXED";
        frame.counterAxisSizingMode = "FIXED";
        frame.resize(Math.max(MIN, spec.w), Math.max(MIN, spec.h));
        [frame.paddingTop, frame.paddingRight, frame.paddingBottom, frame.paddingLeft] = flex.padding;
        frame.itemSpacing = flex.justify === "SPACE_BETWEEN" ? 0 : flex.gap;
        frame.primaryAxisAlignItems = flex.justify;
        frame.counterAxisAlignItems = flex.align === "BASELINE" && flex.direction === "VERTICAL" ? "MIN" : flex.align;
        if (flex.wrap && flex.direction === "HORIZONTAL") {
          frame.layoutWrap = "WRAP";
          frame.counterAxisSpacing = flex.rowGap;
        }
        for (const e of expected) {
          if (e.abs) {
            e.node.layoutPositioning = "ABSOLUTE";
            e.node.x = e.x;
            e.node.y = e.y;
          } else if ("layoutSizingHorizontal" in e.node && e.node.type !== "TEXT") {
            e.node.layoutSizingHorizontal = "FIXED";
            e.node.layoutSizingVertical = "FIXED";
          }
        }
        const ok = Math.abs(frame.width - spec.w) < 1 && Math.abs(frame.height - spec.h) < 1 && expected.every((e) => Math.abs(e.node.x - e.x) < 1 && Math.abs(e.node.y - e.y) < 1);
        if (ok) {
          frame.name = `${spec.name}`;
          return;
        }
      } catch (e) {
      }
      frame.layoutMode = "NONE";
      frame.resize(Math.max(MIN, spec.w), Math.max(MIN, spec.h));
      for (const e of expected) {
        e.node.x = e.x;
        e.node.y = e.y;
      }
    }
    createText(spec, parent, origin) {
      var _a, _b, _c;
      const t = figma.createText();
      parent.appendChild(t);
      t.name = spec.name;
      const font0 = (_a = this.fontByKey.get(this.fontKey(spec.runs[0].font))) != null ? _a : { family: "Inter", style: "Regular" };
      t.fontName = font0;
      t.characters = spec.characters;
      for (const run of spec.runs) {
        if (run.end <= run.start) continue;
        const font = (_b = this.fontByKey.get(this.fontKey(run.font))) != null ? _b : font0;
        t.setRangeFontName(run.start, run.end, font);
        t.setRangeFontSize(run.start, run.end, Math.max(1, run.size));
        if (!spec.fills) {
          t.setRangeFills(run.start, run.end, [
            { type: "SOLID", color: { r: run.color.r, g: run.color.g, b: run.color.b }, opacity: run.color.a }
          ]);
        }
        if (run.decoration !== "NONE") t.setRangeTextDecoration(run.start, run.end, run.decoration);
        if (run.letterSpacing) t.setRangeLetterSpacing(run.start, run.end, { unit: "PIXELS", value: run.letterSpacing });
        t.setRangeLineHeight(run.start, run.end, run.lineHeight ? { unit: "PIXELS", value: run.lineHeight } : { unit: "AUTO" });
        if (run.textCase !== "ORIGINAL") t.setRangeTextCase(run.start, run.end, run.textCase);
        if (run.href) {
          try {
            t.setRangeHyperlink(run.start, run.end, { type: "URL", value: run.href });
          } catch (e) {
          }
        }
      }
      if (spec.fills) t.fills = this.paints(spec.fills);
      t.textAlignHorizontal = spec.align;
      if (spec.truncate) {
        const h = t.height;
        t.textAutoResize = "NONE";
        t.resize(Math.max(1, spec.w), Math.max(1, h));
        t.textTruncation = "ENDING";
        t.maxLines = 1;
        t.x = spec.x - origin.x;
      } else if (spec.sizing === "fixed") {
        t.textAutoResize = "HEIGHT";
        t.resize(Math.max(1, spec.w), Math.max(1, t.height));
        t.x = spec.x - origin.x;
      } else {
        t.textAutoResize = "WIDTH_AND_HEIGHT";
        const left = spec.align === "CENTER" ? spec.x + spec.w / 2 - t.width / 2 : spec.align === "RIGHT" ? spec.x + spec.w - t.width : spec.x;
        t.x = left - origin.x;
      }
      const firstLh = (_c = spec.runs[0].lineHeight) != null ? _c : t.height / Math.max(1, spec.lineCount);
      t.y = spec.firstLineCenter - firstLh / 2 - origin.y;
      const fx = this.effects(spec.shadows);
      if (fx.length) t.effects = fx;
      if (spec.opacity !== void 0) t.opacity = spec.opacity;
      return t;
    }
    createSvg(spec, parent, origin) {
      let node;
      try {
        node = figma.createNodeFromSvg(spec.svg);
        parent.appendChild(node);
        node.resize(Math.max(MIN, spec.w), Math.max(MIN, spec.h));
      } catch (e) {
        const hash = spec.fallbackImageId ? this.hashes.get(spec.fallbackImageId) : void 0;
        node = figma.createRectangle();
        parent.appendChild(node);
        node.resize(Math.max(MIN, spec.w), Math.max(MIN, spec.h));
        node.fills = hash ? [{ type: "IMAGE", imageHash: hash, scaleMode: "FILL" }] : [];
        this.warnings.push(`SVG \xAB${spec.name}\xBB \u0432\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043E \u044F\u043A \u0440\u0430\u0441\u0442\u0440\u043E\u0432\u0435 \u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u043D\u044F.`);
      }
      node.name = spec.name;
      node.x = spec.x - origin.x;
      node.y = spec.y - origin.y;
      if (spec.opacity !== void 0) node.opacity = spec.opacity;
      return node;
    }
  };
  function countNodes(n) {
    return 1 + (n.kind === "frame" ? n.children.reduce((a, c) => a + countNodes(c), 0) : 0);
  }

  // src/main/code.ts
  var send = (msg) => figma.ui.postMessage(msg);
  figma.showUI(__html__, { width: 420, height: 720, themeColors: true });
  figma.clientStorage.getAsync("settings").then((settings) => {
    if (settings) send({ type: "settings", settings });
  });
  var busy = false;
  figma.ui.onmessage = async (msg) => {
    switch (msg.type) {
      case "resize":
        figma.ui.resize(Math.round(msg.width), Math.round(msg.height));
        return;
      case "save-settings":
        await figma.clientStorage.setAsync("settings", msg.settings);
        return;
      case "notify":
        figma.notify(msg.message, { error: !!msg.error });
        return;
      case "import": {
        if (busy) return;
        busy = true;
        const started = Date.now();
        try {
          const builder = new Builder(msg.result, msg.options, (message2, ratio) => send({ type: "progress", message: message2, ratio }));
          const nodes = await builder.build();
          if (figma.editorType !== "slides") figma.currentPage.selection = nodes;
          figma.viewport.scrollAndZoomIntoView(nodes);
          const warnings = [...msg.result.warnings, ...builder.warnings];
          const secs = ((Date.now() - started) / 1e3).toFixed(1);
          const n = msg.result.frames.length;
          const word = n % 10 === 1 && n % 100 !== 11 ? "\u0441\u043B\u0430\u0439\u0434" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "\u0441\u043B\u0430\u0439\u0434\u0438" : "\u0441\u043B\u0430\u0439\u0434\u0456\u0432";
          const what = msg.result.kind === "slides" ? `${n} ${word}` : `\xAB${msg.result.title}\xBB`;
          const message = `\u0413\u043E\u0442\u043E\u0432\u043E: ${what} \u0437\u0430 ${secs} \u0441`;
          figma.notify(message);
          send({ type: "done", message, warnings });
        } catch (e) {
          const message = (e == null ? void 0 : e.message) || String(e);
          figma.notify(`\u041F\u043E\u043C\u0438\u043B\u043A\u0430 \u0456\u043C\u043F\u043E\u0440\u0442\u0443: ${message}`, { error: true });
          send({ type: "error", message });
        } finally {
          busy = false;
        }
        return;
      }
    }
  };
})();
