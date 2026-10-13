import type {
  CaptureOptions, CaptureResult, FillSpec, FrameSpec, NodeSpec, ShadowSpec, StrokeSpec, SvgSpec, TextSpec,
} from '../shared/types';
import { FontResolver, loadFonts } from './fonts';

type Container = FrameNode;
interface Origin {
  x: number;
  y: number;
}

const MIN = 0.01;

export class Builder {
  private hashes = new Map<string, string>();
  private fonts = new FontResolver();
  private fontByKey = new Map<string, FontName>();
  private count = 0;
  private total = 0;
  readonly warnings: string[] = [];

  constructor(
    private result: CaptureResult,
    private options: CaptureOptions,
    private progress: (message: string, ratio?: number) => void,
  ) {}

  async build(): Promise<FrameNode> {
    this.progress('Створення зображень…');
    for (const [id, bytes] of Object.entries(this.result.images)) {
      try {
        this.hashes.set(id, figma.createImage(bytes).hash);
      } catch (e) {
        this.warnings.push(`Figma не прийняла зображення ${id}: ${(e as Error).message}`);
      }
    }

    this.progress('Завантаження шрифтів…');
    await this.prepareFonts(this.result.root);

    this.total = countNodes(this.result.root);
    const root = figma.createFrame();
    root.name = this.result.title;
    root.resize(Math.max(1, this.result.root.w), Math.max(1, this.result.root.h));
    root.fills = this.paints(this.result.root.fills);
    root.clipsContent = true;
    this.placeOnCanvas(root);

    for (const child of this.result.root.children) await this.create(child, root, { x: 0, y: 0 }, false);

    for (const [wanted, used] of this.fonts.missing) {
      this.warnings.push(`Шрифт «${wanted}» недоступний у Figma — використано «${used}».`);
    }
    return root;
  }

  private placeOnCanvas(root: FrameNode) {
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

  private fontKey(f: TextSpec['runs'][number]['font']) {
    return `${f.families.join(',')}|${f.weight}|${f.italic}`;
  }

  private async prepareFonts(root: FrameSpec) {
    const specs = new Map<string, TextSpec['runs'][number]['font']>();
    const visit = (n: NodeSpec) => {
      if (n.kind === 'text') for (const r of n.runs) specs.set(this.fontKey(r.font), r.font);
      else if (n.kind === 'frame') n.children.forEach(visit);
    };
    visit(root);
    const names: FontName[] = [{ family: 'Inter', style: 'Regular' }];
    for (const [key, spec] of specs) {
      const name = await this.fonts.resolve(spec);
      this.fontByKey.set(key, name);
      names.push(name);
    }
    const failed = await loadFonts(names);
    for (const f of failed) {
      this.warnings.push(`Не вдалося завантажити шрифт ${f.family} ${f.style}.`);
      for (const [k, v] of this.fontByKey) if (v.family === f.family && v.style === f.style) this.fontByKey.set(k, { family: 'Inter', style: 'Regular' });
    }
  }

  // ---------- paints & effects ----------

  private paints(fills: FillSpec[] | undefined): Paint[] {
    const out: Paint[] = [];
    for (const f of fills ?? []) {
      if (f.type === 'solid') {
        if (f.color.a <= 0) continue;
        out.push({ type: 'SOLID', color: { r: f.color.r, g: f.color.g, b: f.color.b }, opacity: f.color.a });
      } else if (f.type === 'image') {
        const hash = this.hashes.get(f.imageId);
        if (!hash) continue;
        const p: ImagePaint = {
          type: 'IMAGE',
          imageHash: hash,
          scaleMode: f.scaleMode,
          ...(f.scaleMode === 'CROP' && f.transform ? { imageTransform: f.transform as Transform } : {}),
          ...(f.scaleMode === 'TILE' ? { scalingFactor: f.scalingFactor ?? 1 } : {}),
        };
        out.push(p);
      } else {
        const type = f.type === 'linear' ? 'GRADIENT_LINEAR' : f.type === 'radial' ? 'GRADIENT_RADIAL' : 'GRADIENT_ANGULAR';
        out.push({
          type,
          gradientTransform: f.transform as Transform,
          gradientStops: f.stops.map((s) => ({ position: s.position, color: { r: s.r, g: s.g, b: s.b, a: s.a } })),
        });
      }
    }
    return out;
  }

  private effects(shadows?: ShadowSpec[], layerBlur?: number, backgroundBlur?: number): Effect[] {
    const out: Effect[] = [];
    // CSS paints the first shadow on top; Figma paints later effects on top.
    for (const s of (shadows ?? []).slice().reverse()) {
      const base = {
        color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
        offset: { x: s.x, y: s.y },
        radius: Math.max(0, s.blur),
        spread: s.spread,
        visible: true,
        blendMode: 'NORMAL' as const,
      };
      out.push(s.inset ? { type: 'INNER_SHADOW', ...base } : { type: 'DROP_SHADOW', ...base, showShadowBehindNode: false });
    }
    // CSS blur() is a gaussian standard deviation; Figma's blur radius is roughly twice that.
    if (layerBlur) out.push({ type: 'LAYER_BLUR', blurType: 'NORMAL', radius: layerBlur * 2, visible: true });
    if (backgroundBlur) out.push({ type: 'BACKGROUND_BLUR', blurType: 'NORMAL', radius: backgroundBlur * 2, visible: true });
    return out;
  }

  private applyStroke(node: FrameNode | RectangleNode, s: StrokeSpec) {
    node.strokes = [{ type: 'SOLID', color: { r: s.color.r, g: s.color.g, b: s.color.b }, opacity: s.color.a }];
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
      if (s.dash[0] === s.dash[1]) node.strokeCap = 'ROUND';
    }
  }

  // ---------- nodes ----------

  private async tick() {
    this.count++;
    if (this.count % 150 === 0) {
      this.progress(`Створення шарів ${this.count}/${this.total}`, this.count / this.total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  private async create(spec: NodeSpec, parent: Container, origin: Origin, inAutoLayout: boolean): Promise<SceneNode[]> {
    await this.tick();
    try {
      if (spec.kind === 'text') return [this.createText(spec, parent, origin)];
      if (spec.kind === 'svg') return [this.createSvg(spec, parent, origin)];
      return await this.createFrame(spec, parent, origin, inAutoLayout);
    } catch (e) {
      this.warnings.push(`Помилка створення «${spec.name}»: ${(e as Error).message}`);
      return [];
    }
  }

  private async createFrame(spec: FrameSpec, parent: Container, origin: Origin, inAutoLayout: boolean): Promise<SceneNode[]> {
    const wantsAutoLayout = this.options.autoLayout && !!spec.flex && !spec.flex.reverse;
    if (this.options.flattenWrappers && spec.passive && !wantsAutoLayout && !inAutoLayout && !spec.radius) {
      // Pure wrapper: lift the children into the parent.
      const out: SceneNode[] = [];
      for (const c of spec.children) out.push(...(await this.create(c, parent, origin, false)));
      if (spec.children.length || !spec.w || !spec.h) return out;
      // empty wrapper with no visuals → nothing to draw
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
    if (spec.opacity !== undefined) node.opacity = spec.opacity;
    if (spec.blendMode) node.blendMode = spec.blendMode;
    if (node.type === 'FRAME') {
      node.clipsContent = spec.clip;
      const children: { node: SceneNode; spec: NodeSpec }[] = [];
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
  private tryAutoLayout(frame: FrameNode, spec: FrameSpec, children: { node: SceneNode; spec: NodeSpec }[]) {
    const flex = spec.flex!;
    const expected = children.map((c) => ({ node: c.node, x: c.node.x, y: c.node.y, w: c.node.width, h: c.node.height, abs: !!(c.spec as { outOfFlow?: boolean }).outOfFlow }));
    const inFlow = expected.filter((e) => !e.abs);
    if (!inFlow.length) return;
    try {
      frame.layoutMode = flex.direction;
      frame.primaryAxisSizingMode = 'FIXED';
      frame.counterAxisSizingMode = 'FIXED';
      frame.resize(Math.max(MIN, spec.w), Math.max(MIN, spec.h));
      [frame.paddingTop, frame.paddingRight, frame.paddingBottom, frame.paddingLeft] = flex.padding;
      frame.itemSpacing = flex.justify === 'SPACE_BETWEEN' ? 0 : flex.gap;
      frame.primaryAxisAlignItems = flex.justify;
      frame.counterAxisAlignItems = flex.align === 'BASELINE' && flex.direction === 'VERTICAL' ? 'MIN' : flex.align;
      if (flex.wrap && flex.direction === 'HORIZONTAL') {
        frame.layoutWrap = 'WRAP';
        frame.counterAxisSpacing = flex.rowGap;
      }
      for (const e of expected) {
        if (e.abs) {
          (e.node as FrameNode).layoutPositioning = 'ABSOLUTE';
          e.node.x = e.x;
          e.node.y = e.y;
        } else if ('layoutSizingHorizontal' in e.node && e.node.type !== 'TEXT') {
          (e.node as FrameNode).layoutSizingHorizontal = 'FIXED';
          (e.node as FrameNode).layoutSizingVertical = 'FIXED';
        }
      }
      const ok =
        Math.abs(frame.width - spec.w) < 1 && Math.abs(frame.height - spec.h) < 1 &&
        expected.every((e) => Math.abs(e.node.x - e.x) < 1 && Math.abs(e.node.y - e.y) < 1);
      if (ok) {
        frame.name = `${spec.name}`;
        return;
      }
    } catch {
      /* fall through to revert */
    }
    // Revert to absolute positioning.
    frame.layoutMode = 'NONE';
    frame.resize(Math.max(MIN, spec.w), Math.max(MIN, spec.h));
    for (const e of expected) {
      e.node.x = e.x;
      e.node.y = e.y;
    }
  }

  private createText(spec: TextSpec, parent: Container, origin: Origin): TextNode {
    const t = figma.createText();
    parent.appendChild(t);
    t.name = spec.name;
    const font0 = this.fontByKey.get(this.fontKey(spec.runs[0].font)) ?? { family: 'Inter', style: 'Regular' };
    t.fontName = font0;
    t.characters = spec.characters;
    for (const run of spec.runs) {
      if (run.end <= run.start) continue;
      const font = this.fontByKey.get(this.fontKey(run.font)) ?? font0;
      t.setRangeFontName(run.start, run.end, font);
      t.setRangeFontSize(run.start, run.end, Math.max(1, run.size));
      if (!spec.fills) {
        t.setRangeFills(run.start, run.end, [
          { type: 'SOLID', color: { r: run.color.r, g: run.color.g, b: run.color.b }, opacity: run.color.a },
        ]);
      }
      if (run.decoration !== 'NONE') t.setRangeTextDecoration(run.start, run.end, run.decoration);
      if (run.letterSpacing) t.setRangeLetterSpacing(run.start, run.end, { unit: 'PIXELS', value: run.letterSpacing });
      t.setRangeLineHeight(run.start, run.end, run.lineHeight ? { unit: 'PIXELS', value: run.lineHeight } : { unit: 'AUTO' });
      if (run.textCase !== 'ORIGINAL') t.setRangeTextCase(run.start, run.end, run.textCase);
      if (run.href) {
        try {
          t.setRangeHyperlink(run.start, run.end, { type: 'URL', value: run.href });
        } catch {
          /* invalid URL */
        }
      }
    }
    if (spec.fills) t.fills = this.paints(spec.fills);
    t.textAlignHorizontal = spec.align;
    if (spec.truncate) {
      const h = t.height;
      t.textAutoResize = 'NONE';
      t.resize(Math.max(1, spec.w), Math.max(1, h));
      t.textTruncation = 'ENDING';
      t.maxLines = 1;
      t.x = spec.x - origin.x;
    } else if (spec.sizing === 'fixed') {
      t.textAutoResize = 'HEIGHT';
      t.resize(Math.max(1, spec.w), Math.max(1, t.height));
      t.x = spec.x - origin.x;
    } else {
      t.textAutoResize = 'WIDTH_AND_HEIGHT';
      const left =
        spec.align === 'CENTER' ? spec.x + spec.w / 2 - t.width / 2
        : spec.align === 'RIGHT' ? spec.x + spec.w - t.width
        : spec.x;
      t.x = left - origin.x;
    }
    // Vertical placement: centre of the first line box on the browser's glyph centre.
    const firstLh = spec.runs[0].lineHeight ?? t.height / Math.max(1, spec.lineCount);
    t.y = spec.firstLineCenter - firstLh / 2 - origin.y;
    const fx = this.effects(spec.shadows);
    if (fx.length) t.effects = fx;
    if (spec.opacity !== undefined) t.opacity = spec.opacity;
    return t;
  }

  private createSvg(spec: SvgSpec, parent: Container, origin: Origin): SceneNode {
    let node: FrameNode | RectangleNode;
    try {
      node = figma.createNodeFromSvg(spec.svg);
      parent.appendChild(node);
      node.resize(Math.max(MIN, spec.w), Math.max(MIN, spec.h));
    } catch {
      const hash = spec.fallbackImageId ? this.hashes.get(spec.fallbackImageId) : undefined;
      node = figma.createRectangle();
      parent.appendChild(node);
      node.resize(Math.max(MIN, spec.w), Math.max(MIN, spec.h));
      node.fills = hash ? [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }] : [];
      this.warnings.push(`SVG «${spec.name}» вставлено як растрове зображення.`);
    }
    node.name = spec.name;
    node.x = spec.x - origin.x;
    node.y = spec.y - origin.y;
    if (spec.opacity !== undefined) node.opacity = spec.opacity;
    return node;
  }
}

function countNodes(n: NodeSpec): number {
  return 1 + (n.kind === 'frame' ? n.children.reduce((a, c) => a + countNodes(c), 0) : 0);
}
