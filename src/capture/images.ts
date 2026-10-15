// Image loading inside the rendered page. Figma accepts PNG / JPEG / GIF up to 4096px,
// everything else (WebP, AVIF, SVG, BMP, ICO...) is converted to PNG via canvas.

const MAX_SIZE = 4096;

export interface LoadedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export class ImageStore {
  private ids = new Map<string, string>();
  private pending = new Map<string, Promise<LoadedImage | null>>();
  private loaded = new Map<string, LoadedImage>();
  readonly failed = new Set<string>();
  private counter = 0;

  constructor(private corsProxy: string) {}

  /** Registers a URL and returns a stable image id (loading happens later). */
  register(url: string): string {
    let id = this.ids.get(url);
    if (!id) {
      id = `img${++this.counter}`;
      this.ids.set(url, id);
    }
    return id;
  }

  /** Registers already-available bytes (e.g. canvas snapshot). */
  registerBytes(key: string, image: LoadedImage): string {
    const id = this.register(key);
    this.loaded.set(id, image);
    return id;
  }

  /** Reserves an id for bytes that will be produced later (see setLoaded). */
  reserve(): string {
    return `img${++this.counter}`;
  }

  setLoaded(id: string, image: LoadedImage): void {
    this.loaded.set(id, image);
  }

  info(id: string): LoadedImage | undefined {
    return this.loaded.get(id);
  }

  async loadAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const entries = [...this.ids.entries()].filter(([, id]) => !this.loaded.has(id));
    let done = 0;
    await Promise.all(
      entries.map(async ([url, id]) => {
        let p = this.pending.get(url);
        if (!p) {
          p = loadImage(url, this.corsProxy);
          this.pending.set(url, p);
        }
        const img = await p;
        if (img) this.loaded.set(id, img);
        else this.failed.add(id);
        onProgress?.(++done, entries.length);
      }),
    );
  }

  bytes(): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    for (const [id, img] of this.loaded) out[id] = img.bytes;
    return out;
  }
}

function sniff(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'svg' | 'other' {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return 'other';
}

export async function fetchBytes(url: string, corsProxy: string): Promise<Uint8Array | null> {
  const attempts = [url];
  if (corsProxy && /^https?:/i.test(url)) attempts.push(corsProxy + encodeURIComponent(url));
  for (const u of attempts) {
    try {
      const res = await fetch(u, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) continue;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function fetchText(url: string, corsProxy: string): Promise<string | null> {
  const bytes = await fetchBytes(url, corsProxy);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Decodes image bytes without relying on blob: URLs (they may be blocked by the plugin CSP).
 * Raster formats go through createImageBitmap; SVG needs an <img> with a data: URL.
 */
async function decode(bytes: Uint8Array, mime: string): Promise<CanvasImageSource & { width: number; height: number }> {
  if (mime !== 'image/svg+xml' && typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(new Blob([bytes as BlobPart], mime ? { type: mime } : undefined));
    } catch {
      /* fall back to <img> */
    }
  }
  const img = new Image();
  img.decoding = 'async';
  img.src = `data:${mime || 'application/octet-stream'};base64,${toBase64(bytes)}`;
  await img.decode();
  // naturalWidth is 0 for SVGs without intrinsic size
  return Object.assign(img, { width: img.naturalWidth, height: img.naturalHeight });
}

/** Rasterizes an SVG string (used as a fallback when Figma can't parse it). */
export async function rasterizeSvg(svg: string, width: number, height: number): Promise<LoadedImage | null> {
  try {
    const img = await decode(new TextEncoder().encode(svg), 'image/svg+xml');
    return await rasterize(img, width, height);
  } catch {
    return null;
  }
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return resolve(null);
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
}

export async function rasterize(
  source: CanvasImageSource,
  width: number,
  height: number,
): Promise<LoadedImage | null> {
  if (!width || !height) return null;
  const scale = Math.min(1, MAX_SIZE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, w, h);
    const bytes = await canvasToPng(canvas);
    return bytes ? { bytes, width, height } : null;
  } catch {
    return null; // tainted canvas
  }
}

async function loadImage(url: string, corsProxy: string): Promise<LoadedImage | null> {
  const bytes = await fetchBytes(url, corsProxy);
  if (!bytes || !bytes.length) return null;
  const kind = sniff(bytes);
  const mime =
    kind === 'svg' ? 'image/svg+xml' : kind === 'png' ? 'image/png' : kind === 'jpeg' ? 'image/jpeg' : kind === 'gif' ? 'image/gif' : '';
  let img: CanvasImageSource & { width: number; height: number };
  try {
    img = await decode(bytes, mime);
  } catch {
    return null;
  }
  let w = img.width;
  let h = img.height;
  if (kind === 'svg') {
    // Rasterize vectors at 2x for crispness (when used as bitmaps, e.g. backgrounds).
    if (!w || !h) {
      w = 300;
      h = 150;
    }
    const r = await rasterize(img, w * 2, h * 2);
    return r ? { ...r, width: w, height: h } : null;
  }
  if ((kind === 'png' || kind === 'jpeg' || kind === 'gif') && w <= MAX_SIZE && h <= MAX_SIZE) {
    return { bytes, width: w, height: h };
  }
  const r = await rasterize(img, w, h);
  return r ? { ...r, width: w, height: h } : null;
}
