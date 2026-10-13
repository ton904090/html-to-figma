import type { FontSpec } from '../shared/types';

interface StyleInfo {
  style: string;
  weight: number;
  italic: boolean;
}

let families: Map<string, { family: string; styles: StyleInfo[] }> | null = null;

const GENERIC: Record<string, string[]> = {
  'sans-serif': ['Inter', 'Roboto', 'Arial', 'Helvetica'],
  'ui-sans-serif': ['Inter', 'Roboto', 'Arial'],
  'system-ui': ['SF Pro Text', 'SF Pro', 'Segoe UI', 'Inter', 'Roboto'],
  '-apple-system': ['SF Pro Text', 'SF Pro'],
  blinkmacsystemfont: ['SF Pro Text', 'SF Pro'],
  serif: ['Times New Roman', 'Georgia', 'Noto Serif', 'Roboto Serif', 'PT Serif', 'Merriweather'],
  'ui-serif': ['Georgia', 'Times New Roman', 'Noto Serif'],
  monospace: ['Roboto Mono', 'JetBrains Mono', 'Source Code Pro', 'Courier New', 'Menlo', 'Fira Code'],
  'ui-monospace': ['SF Mono', 'Menlo', 'Roboto Mono', 'JetBrains Mono', 'Source Code Pro'],
  cursive: ['Comic Sans MS', 'Caveat'],
  fantasy: ['Impact', 'Bebas Neue'],
  emoji: [],
  math: [],
};

export function parseStyle(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase().replace(/[\s_-]/g, '');
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
  families = new Map();
  const list = await figma.listAvailableFontsAsync();
  for (const f of list) {
    const key = f.fontName.family.toLowerCase();
    let entry = families.get(key);
    if (!entry) {
      entry = { family: f.fontName.family, styles: [] };
      families.set(key, entry);
    }
    entry.styles.push({ style: f.fontName.style, ...parseStyle(f.fontName.style) });
  }
  return families;
}

function pickStyle(styles: StyleInfo[], weight: number, italic: boolean): StyleInfo {
  let best = styles[0];
  let bestScore = Infinity;
  for (const s of styles) {
    let score = Math.abs(s.weight - weight);
    if (s.italic !== italic) score += 1000;
    // CSS prefers heavier for bold targets and lighter for light ones on ties.
    if (weight >= 500 && s.weight < weight) score += 1;
    if (weight < 400 && s.weight > weight) score += 1;
    // Prefer canonical names ("Regular" over "Book", "Bold" over "Bold Display").
    score += s.style.length * 0.001;
    if (score < bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

export class FontResolver {
  private cache = new Map<string, FontName>();
  readonly missing = new Map<string, string>();

  async resolve(spec: FontSpec): Promise<FontName> {
    const key = `${spec.families.join(',')}|${spec.weight}|${spec.italic}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const fams = await ensureFamilies();
    let found: { family: string; styles: StyleInfo[] } | undefined;
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
      found = fams.get('inter') ?? fams.get('roboto') ?? fams.values().next().value!;
      const wanted = spec.families[0] ?? '(none)';
      if (!GENERIC[wanted.toLowerCase()]) this.missing.set(wanted, found.family);
    }
    const style = pickStyle(found.styles, spec.weight, spec.italic);
    const result = { family: found.family, style: style.style };
    this.cache.set(key, result);
    return result;
  }
}

const loaded = new Set<string>();

export async function loadFonts(fonts: FontName[]): Promise<FontName[]> {
  const failed: FontName[] = [];
  await Promise.all(
    fonts.map(async (f) => {
      const key = `${f.family}|${f.style}`;
      if (loaded.has(key)) return;
      try {
        await figma.loadFontAsync(f);
        loaded.add(key);
      } catch {
        failed.push(f);
      }
    }),
  );
  return failed;
}
