// Data contract between the capture script (runs inside the rendered page)
// and the Figma main thread (builds the layers).
// All coordinates are absolute document pixels (relative to the page's top-left).

export interface RGBA {
  r: number; // 0..1
  g: number;
  b: number;
  a: number;
}

export interface ColorStop extends RGBA {
  position: number; // 0..1
}

/** 2x3 affine matrix, same layout as Figma's Transform */
export type Matrix = [[number, number, number], [number, number, number]];

export type FillSpec =
  | { type: 'solid'; color: RGBA }
  | {
      type: 'linear' | 'radial' | 'angular';
      stops: ColorStop[];
      /** gradientTransform (node unit space -> gradient space) */
      transform: Matrix;
    }
  | {
      type: 'image';
      imageId: string;
      scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE';
      /** for CROP: imageTransform; for TILE scalingFactor is used */
      transform?: Matrix;
      scalingFactor?: number;
    };

export interface ShadowSpec {
  inset: boolean;
  color: RGBA;
  x: number;
  y: number;
  blur: number;
  spread: number;
}

export interface StrokeSpec {
  color: RGBA;
  top: number;
  right: number;
  bottom: number;
  left: number;
  dash?: number[];
  align: 'INSIDE' | 'OUTSIDE' | 'CENTER';
}

export type BlendMode =
  | 'NORMAL' | 'MULTIPLY' | 'SCREEN' | 'OVERLAY' | 'DARKEN' | 'LIGHTEN'
  | 'COLOR_DODGE' | 'COLOR_BURN' | 'HARD_LIGHT' | 'SOFT_LIGHT' | 'DIFFERENCE'
  | 'EXCLUSION' | 'HUE' | 'SATURATION' | 'COLOR' | 'LUMINOSITY';

interface Box {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity?: number;
  blendMode?: BlendMode;
}

export interface FlexLayoutSpec {
  direction: 'HORIZONTAL' | 'VERTICAL';
  wrap: boolean;
  gap: number;
  rowGap: number;
  padding: [number, number, number, number]; // top right bottom left (incl. border)
  justify: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  align: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
  reverse: boolean;
}

export interface FrameSpec extends Box {
  kind: 'frame';
  tag: string;
  fills: FillSpec[];
  stroke?: StrokeSpec;
  radius?: [number, number, number, number]; // tl tr br bl
  shadows?: ShadowSpec[];
  layerBlur?: number;
  backgroundBlur?: number;
  clip: boolean;
  /** Present when the element is a flex container that may map to Auto Layout */
  flex?: FlexLayoutSpec;
  /** true for children that are out of flow (absolute/fixed) */
  outOfFlow?: boolean;
  /** true when the element has nothing visual of its own (pure wrapper) */
  passive?: boolean;
  children: NodeSpec[];
}

export interface FontSpec {
  families: string[];
  weight: number;
  italic: boolean;
}

export interface TextRun {
  start: number;
  end: number;
  font: FontSpec;
  size: number;
  color: RGBA;
  /** line height in px, or null for "normal" */
  lineHeight: number | null;
  letterSpacing: number;
  decoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  href?: string;
}

export interface TextSpec extends Box {
  kind: 'text';
  characters: string;
  runs: TextRun[];
  align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  /**
   * 'auto'  - text node hugs its content, line breaks are explicit;
   *           (x,w) is the measured box, the node is anchored by `align`.
   * 'fixed' - fixed width text node that wraps by itself (editable paragraph).
   */
  sizing: 'auto' | 'fixed';
  /** Vertical center of the first line's glyphs (absolute), used for exact vertical placement */
  firstLineCenter: number;
  lineCount: number;
  /** text-overflow: ellipsis → Figma text truncation (single line, fixed width) */
  truncate?: boolean;
  /** Overrides run colors (e.g. gradient text via background-clip: text) */
  fills?: FillSpec[];
  shadows?: ShadowSpec[];
  outOfFlow?: boolean;
}

export interface SvgSpec extends Box {
  kind: 'svg';
  svg: string;
  /** raster fallback (PNG) if Figma can't parse the SVG */
  fallbackImageId?: string;
  outOfFlow?: boolean;
}

export type NodeSpec = FrameSpec | TextSpec | SvgSpec;

export interface CaptureOptions {
  viewportWidth: number;
  viewportHeight: number;
  /** Mode for multi-line text */
  textMode: 'exact' | 'paragraph';
  autoLayout: boolean;
  flattenWrappers: boolean;
  corsProxy: string;
}

export interface CaptureResult {
  title: string;
  width: number;
  height: number;
  root: FrameSpec;
  images: Record<string, Uint8Array>;
  warnings: string[];
}

// Messages UI -> main
export type UIToMain =
  | { type: 'import'; result: CaptureResult; options: CaptureOptions }
  | { type: 'resize'; width: number; height: number }
  | { type: 'save-settings'; settings: unknown }
  | { type: 'notify'; message: string; error?: boolean };

// Messages main -> UI
export type MainToUI =
  | { type: 'progress'; message: string; ratio?: number }
  | { type: 'done'; message: string; warnings: string[] }
  | { type: 'error'; message: string }
  | { type: 'settings'; settings: unknown };
