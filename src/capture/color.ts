import type { RGBA } from '../shared/types';

const cache = new Map<string, RGBA | null>();
let ctx: CanvasRenderingContext2D | null = null;

const NUM = '\\s*([-+]?[\\d.]+(?:e[-+]?\\d+)?)(%?)\\s*';
const RGB_RE = new RegExp(`^rgba?\\(${NUM}[,\\s]${NUM}[,\\s]${NUM}(?:[,/]${NUM})?\\)$`, 'i');

function channel(v: string, pct: string): number {
  const n = parseFloat(v);
  return Math.min(1, Math.max(0, pct ? n / 100 : n / 255));
}

/**
 * Parses any CSS color the browser understands into sRGB 0..1.
 * Fast path for rgb()/rgba() (what getComputedStyle normally returns),
 * canvas-based fallback for everything else (oklch(), color(), lab(), named...).
 */
export function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  const str = input.trim();
  if (!str || str === 'none') return null;
  if (cache.has(str)) return cache.get(str)!;
  let result: RGBA | null = null;
  if (str === 'transparent') {
    result = { r: 0, g: 0, b: 0, a: 0 };
  } else {
    const m = RGB_RE.exec(str);
    if (m) {
      const a = m[7] !== undefined ? (m[8] ? parseFloat(m[7]) / 100 : parseFloat(m[7])) : 1;
      result = {
        r: channel(m[1], m[2]),
        g: channel(m[3], m[4]),
        b: channel(m[5], m[6]),
        a: Math.min(1, Math.max(0, a)),
      };
    } else {
      result = parseViaCanvas(str);
    }
  }
  cache.set(str, result);
  return result;
}

function parseViaCanvas(str: string): RGBA | null {
  if (!ctx) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
  }
  // Detect invalid colors: fillStyle ignores invalid assignments.
  ctx.fillStyle = '#010203';
  ctx.fillStyle = str;
  const normalized = String(ctx.fillStyle);
  if (normalized === '#010203' && str.toLowerCase() !== '#010203') return null;
  const m = RGB_RE.exec(normalized);
  if (m) return parseColor(normalized);
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return {
      r: parseInt(normalized.slice(1, 3), 16) / 255,
      g: parseInt(normalized.slice(3, 5), 16) / 255,
      b: parseInt(normalized.slice(5, 7), 16) / 255,
      a: 1,
    };
  }
  // Wide-gamut / exotic serialization: rasterize one pixel.
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  if (d[3] === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: d[3] / 255 };
}

export function isVisibleColor(c: RGBA | null): c is RGBA {
  return !!c && c.a > 0.001;
}
