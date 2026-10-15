import type { ColorStop, Matrix, RGBA, ShadowSpec } from '../shared/types';
import { parseColor } from './color';

/** Splits a CSS value on top-level separators (ignores ones inside parentheses/quotes). */
export function splitTopLevel(value: string, sep: ',' | ' ' = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      cur += ch;
      if (ch === quote && value[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    const isSep = sep === ' ' ? /\s/.test(ch) : ch === sep;
    if (isSep && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function px(v: string | null | undefined, fallback = 0): number {
  if (!v) return fallback;
  const n = parseFloat(v);
  return isFinite(n) ? n : fallback;
}

/** Resolves a length that may be px or % (of `basis`). */
export function lengthOrPercent(v: string, basis: number): number | null {
  v = v.trim();
  if (v.endsWith('%')) return (parseFloat(v) / 100) * basis;
  if (v.endsWith('px')) return parseFloat(v);
  if (v === '0') return 0;
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

const COLOR_START = /^(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\(|[a-z]+$)/i;

export function parseShadows(value: string): ShadowSpec[] {
  if (!value || value === 'none') return [];
  const result: ShadowSpec[] = [];
  for (const layer of splitTopLevel(value, ',')) {
    const parts = splitTopLevel(layer, ' ');
    let inset = false;
    let color: RGBA | null = null;
    const lengths: number[] = [];
    for (const p of parts) {
      if (p === 'inset') inset = true;
      else if (/^[-+]?[\d.]/.test(p)) lengths.push(parseFloat(p));
      else if (COLOR_START.test(p)) color = parseColor(p);
    }
    if (lengths.length < 2) continue;
    const c = color ?? { r: 0, g: 0, b: 0, a: 1 };
    if (c.a <= 0) continue;
    result.push({
      inset,
      color: c,
      x: lengths[0],
      y: lengths[1],
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
    });
  }
  return result;
}

// ---------- gradients ----------

function invert(m: Matrix): Matrix {
  const [[a, c, e], [b, d, f]] = m;
  const det = a * d - b * c || 1e-9;
  return [
    [d / det, -c / det, (c * f - d * e) / det],
    [-b / det, a / det, (b * e - a * f) / det],
  ];
}

function parseAngle(token: string): number | null {
  const m = /^([-+]?[\d.]+)(deg|rad|turn|grad)$/.exec(token.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'deg': return n;
    case 'rad': return (n * 180) / Math.PI;
    case 'turn': return n * 360;
    case 'grad': return n * 0.9;
  }
  return null;
}

const SIDE_ANGLES: Record<string, number> = {
  top: 0, right: 90, bottom: 180, left: 270,
  'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135,
  'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315,
};

/** Expands a repeating gradient's stops over the whole 0..1 range (Figma has no repeating gradients). */
function repeatStops(stops: ColorStop[]): ColorStop[] {
  const first = stops[0].position;
  const period = stops[stops.length - 1].position - first;
  if (period <= 0.001 || stops.length < 2) return stops;
  const out: ColorStop[] = [];
  const startK = Math.floor(-first / period);
  for (let k = startK; out.length < 400; k++) {
    for (const st of stops) {
      const pos = st.position + k * period;
      if (pos < -period) continue;
      out.push({ ...st, position: pos });
    }
    if (first + k * period > 1) break;
  }
  // Clip to [0,1] keeping hard edges.
  return out
    .filter((st, i) => st.position >= 0 && st.position <= 1 || (out[i + 1] && out[i + 1].position > 0 && st.position < 0) || (out[i - 1] && out[i - 1].position < 1 && st.position > 1))
    .map((st) => ({ ...st, position: Math.min(1, Math.max(0, st.position)) }));
}

/** Parses color stops; positions are resolved against `lineLength` px. */
function parseStops(parts: string[], lineLength: number, clamp = true): ColorStop[] {
  const raw: { color: RGBA; pos: number | null }[] = [];
  for (const part of parts) {
    const tokens = splitTopLevel(part, ' ');
    if (!tokens.length) continue;
    // Color hint (single length without color) - ignore.
    const color = parseColor(tokens[0]);
    if (!color) continue;
    const positions = tokens.slice(1).map((t) => {
      const l = lengthOrPercent(t, lineLength);
      return l === null ? null : lineLength ? l / lineLength : 0;
    });
    if (positions.length === 0) raw.push({ color, pos: null });
    for (const p of positions) raw.push({ color, pos: p });
  }
  if (!raw.length) return [];
  if (raw[0].pos === null) raw[0].pos = 0;
  if (raw[raw.length - 1].pos === null) raw[raw.length - 1].pos = 1;
  // Monotonic positions.
  let max = raw[0].pos!;
  for (const s of raw) {
    if (s.pos !== null) {
      if (s.pos < max) s.pos = max;
      max = s.pos;
    }
  }
  // Fill in missing positions evenly.
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].pos !== null) continue;
    let j = i;
    while (raw[j].pos === null) j++;
    const start = raw[i - 1].pos!;
    const end = raw[j].pos!;
    const n = j - i + 1;
    for (let k = i; k < j; k++) raw[k].pos = start + ((end - start) * (k - i + 1)) / n;
  }
  return raw.map((s) => ({ ...s.color, position: clamp ? Math.min(1, Math.max(0, s.pos!)) : s.pos! }));
}

export interface GradientResult {
  type: 'linear' | 'radial' | 'angular';
  stops: ColorStop[];
  transform: Matrix;
}

export function parseGradient(value: string, w: number, h: number): GradientResult | null {
  const m = /^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/s.exec(value.trim());
  if (!m || w <= 0 || h <= 0) return null;
  const kind = m[2];
  const repeating = !!m[1];
  const stopsOf = (parts: string[], len: number) => {
    if (!repeating) return parseStops(parts, len);
    const raw = parseStops(parts, len, false);
    return raw.length ? repeatStops(raw) : raw;
  };
  const args = splitTopLevel(m[3], ',');
  if (!args.length) return null;

  if (kind === 'linear') {
    let angle = 180;
    let first = args[0];
    const a = parseAngle(first);
    if (a !== null) {
      angle = a;
      args.shift();
    } else if (first.startsWith('to ')) {
      const side = first.slice(3).trim().replace(/\s+/g, ' ');
      if (side in SIDE_ANGLES) {
        angle = SIDE_ANGLES[side];
        // Corner angles depend on the box aspect ratio in CSS.
        if (side.includes(' ')) {
          // The gradient line is perpendicular to the diagonal between the two other corners.
          const deg = (Math.atan2(h, w) * 180) / Math.PI;
          if (side.includes('top') && side.includes('right')) angle = deg;
          else if (side.includes('bottom') && side.includes('right')) angle = 180 - deg;
          else if (side.includes('bottom') && side.includes('left')) angle = 180 + deg;
          else angle = 360 - deg;
        }
      }
      args.shift();
    }
    const rad = (angle * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const len = Math.abs(w * dx) + Math.abs(h * dy);
    const cx = w / 2;
    const cy = h / 2;
    const p0 = { x: cx - (dx * len) / 2, y: cy - (dy * len) / 2 };
    const u = { x: dx * len, y: dy * len };
    const v = { x: -u.y, y: u.x };
    const M: Matrix = [
      [u.x / w, v.x / w, (p0.x - 0.5 * v.x) / w],
      [u.y / h, v.y / h, (p0.y - 0.5 * v.y) / h],
    ];
    const stops = stopsOf(args, len);
    if (stops.length < 1) return null;
    return { type: 'linear', stops, transform: invert(M) };
  }

  // radial / conic share "at <position>" parsing.
  let shape = 'ellipse';
  let size = 'farthest-corner';
  let explicit: number[] | null = null;
  let cx = w / 2;
  let cy = h / 2;
  let fromAngle = 0;
  const head = args[0];
  const looksLikeHead =
    /\bat\b|circle|ellipse|closest|farthest|from\b/.test(head) ||
    (kind === 'radial' && /^[\d.]+(px|%)/.test(head) && !parseColor(splitTopLevel(head, ' ')[0]));
  if (looksLikeHead) {
    args.shift();
    let [shapePart, atPart] = head.split(/\bat\b/).map((s) => s.trim());
    if (kind === 'conic') {
      const fm = /from\s+(\S+)/.exec(shapePart || '');
      if (fm) fromAngle = parseAngle(fm[1]) ?? 0;
    } else if (shapePart) {
      const tokens = shapePart.split(/\s+/);
      const lens: number[] = [];
      tokens.forEach((t) => {
        if (t === 'circle' || t === 'ellipse') shape = t;
        else if (/^(closest|farthest)-(side|corner)$/.test(t)) size = t;
        else {
          const l = lengthOrPercent(t, lens.length === 0 ? w : h);
          if (l !== null) lens.push(l);
        }
      });
      if (lens.length) {
        explicit = lens;
        if (lens.length === 1) shape = 'circle';
      }
    }
    if (atPart) {
      const pos = atPart.split(/\s+/);
      const resolve = (t: string, basis: number) => {
        if (t === 'center') return basis / 2;
        if (t === 'left' || t === 'top') return 0;
        if (t === 'right' || t === 'bottom') return basis;
        return lengthOrPercent(t, basis) ?? basis / 2;
      };
      let xs = pos[0];
      let ys = pos[1] ?? 'center';
      if (xs === 'top' || xs === 'bottom') [xs, ys] = [ys === 'center' ? 'center' : ys, xs];
      cx = resolve(xs, w);
      cy = resolve(ys, h);
    }
  }

  if (kind === 'conic') {
    const stops = parseStops(args.map((a) => a.replace(/([-\d.]+)deg/g, (_, n) => `${(parseFloat(n) / 360) * 100}%`)), 1);
    // Figma angular gradient starts at 3 o'clock going clockwise; CSS starts at 12 o'clock.
    const rad = ((fromAngle - 90) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const r = Math.max(w, h) / 2;
    // gradient (s,t) -> pixel: center + R(rad) * ((s-0.5)*2r, (t-0.5)*2r)
    const M: Matrix = [
      [(cos * 2 * r) / w, (-sin * 2 * r) / w, (cx - cos * r + sin * r) / w],
      [(sin * 2 * r) / h, (cos * 2 * r) / h, (cy - sin * r - cos * r) / h],
    ];
    return stops.length ? { type: 'angular', stops, transform: invert(M) } : null;
  }

  // radial
  const dl = cx;
  const dr = w - cx;
  const dt = cy;
  const db = h - cy;
  let rx: number;
  let ry: number;
  if (explicit) {
    rx = explicit[0];
    ry = explicit[1] ?? explicit[0];
  } else if (shape === 'circle') {
    const sides = [dl, dr, dt, db].map(Math.abs);
    const corners = [
      Math.hypot(dl, dt), Math.hypot(dr, dt), Math.hypot(dl, db), Math.hypot(dr, db),
    ];
    const r =
      size === 'closest-side' ? Math.min(...sides)
      : size === 'farthest-side' ? Math.max(...sides)
      : size === 'closest-corner' ? Math.min(...corners)
      : Math.max(...corners);
    rx = ry = r;
  } else {
    const sx = size.endsWith('side') ? (size.startsWith('closest') ? Math.min(dl, dr) : Math.max(dl, dr)) : 0;
    const sy = size.endsWith('side') ? (size.startsWith('closest') ? Math.min(dt, db) : Math.max(dt, db)) : 0;
    if (size.endsWith('side')) {
      rx = sx;
      ry = sy;
    } else {
      const fx = size.startsWith('closest') ? Math.min(dl, dr) : Math.max(dl, dr);
      const fy = size.startsWith('closest') ? Math.min(dt, db) : Math.max(dt, db);
      rx = fx * Math.SQRT2;
      ry = fy * Math.SQRT2;
    }
  }
  rx = Math.max(rx, 0.01);
  ry = Math.max(ry, 0.01);
  const M: Matrix = [
    [(2 * rx) / w, 0, (cx - rx) / w],
    [0, (2 * ry) / h, (cy - ry) / h],
  ];
  const stops = stopsOf(args, rx);
  return stops.length ? { type: 'radial', stops, transform: invert(M) } : null;
}

export function extractUrl(value: string): string | null {
  const m = /^url\(\s*(['"]?)(.*?)\1\s*\)$/s.exec(value.trim());
  return m ? m[2] : null;
}
