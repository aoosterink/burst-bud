import exifr from 'exifr';
import type { MediaItem } from './types';

/**
 * Two image tiers:
 *  - thumbs: small JPEG blob URLs (for slivers, the scrub strip, neighbouring bursts)
 *  - previews: screen-sized ImageBitmaps kept decoded in memory so scrubbing through a
 *    burst is just a canvas draw per frame, like scrubbing video.
 * Both load through a LIFO queue, so whatever was asked for last (what's on screen) wins.
 */

type Job = () => Promise<void>;

class LifoQueue {
  private jobs: Job[] = [];
  private running = 0;
  private limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  push(job: Job) {
    this.jobs.push(job);
    this.pump();
  }
  private pump() {
    while (this.running < this.limit && this.jobs.length) {
      const job = this.jobs.pop()!;
      this.running++;
      job().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }
}

const THUMB_W = 360;
const thumbQueue = new LifoQueue(4);
const previewQueue = new LifoQueue(3);

const thumbs = new Map<string, string | null>();

/** Width / height of each photo (as displayed, after EXIF rotation), learned from any decode. */
const aspects = new Map<string, number>();
/** Full pixel size, known once the photo was decoded at full resolution (for zoom). */
const naturals = new Map<string, { w: number; h: number }>();
const noteAspect = (id: string, bmp: ImageBitmap) => aspects.set(id, bmp.width / bmp.height);

export const aspectOf = (id: string): number | undefined => aspects.get(id);
export const naturalSizeOf = (id: string) => naturals.get(id);
const thumbWaiters = new Map<string, Promise<string | null>>();

async function decode(file: File, width?: number): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file, {
      imageOrientation: 'from-image',
      ...(width ? { resizeWidth: width, resizeQuality: 'medium' as const } : {}),
    });
  } catch {
    // RAW, or HEIC in a browser that can't decode it: use the preview embedded in EXIF.
    try {
      const buf = await exifr.thumbnail(file);
      if (!buf) return null;
      const blob = new Blob([buf as BlobPart], { type: 'image/jpeg' });
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      return null;
    }
  }
}

async function bitmapToUrl(bmp: ImageBitmap, width: number): Promise<string> {
  const scale = Math.min(1, width / bmp.width);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  return URL.createObjectURL(blob);
}

export function peekThumb(item: MediaItem): string | null | undefined {
  return thumbs.get(item.id);
}

export function loadThumb(item: MediaItem): Promise<string | null> {
  if (thumbs.has(item.id)) return Promise.resolve(thumbs.get(item.id)!);
  const pending = thumbWaiters.get(item.id);
  if (pending) return pending;
  const p = new Promise<string | null>((resolve) => {
    thumbQueue.push(async () => {
      // Reuse a decoded preview if we already have one: far cheaper than decoding again.
      const cached = previews.get(item.id);
      const bmp = cached ?? (await decode(item.file, THUMB_W));
      if (bmp) noteAspect(item.id, bmp);
      const url = bmp ? await bitmapToUrl(bmp, THUMB_W) : null;
      if (bmp && !cached) bmp.close();
      thumbs.set(item.id, url);
      thumbWaiters.delete(item.id);
      resolve(url);
    });
  });
  thumbWaiters.set(item.id, p);
  return p;
}

// ---- previews (LRU) ----

const MAX_PREVIEWS = 90;
const previews = new Map<string, ImageBitmap>();
const previewWaiters = new Map<string, Promise<ImageBitmap | null>>();
let previewWidth = 1600;

export function setPreviewWidth(px: number) {
  // Round up to a step so resizes don't invalidate everything.
  previewWidth = Math.max(800, Math.min(2400, Math.ceil(px / 400) * 400));
}

export function peekPreview(id: string): ImageBitmap | undefined {
  const bmp = previews.get(id);
  if (bmp) {
    previews.delete(id);
    previews.set(id, bmp); // mark as recently used
  }
  return bmp;
}

export function loadPreview(item: MediaItem): Promise<ImageBitmap | null> {
  const hit = peekPreview(item.id);
  if (hit) return Promise.resolve(hit);
  const pending = previewWaiters.get(item.id);
  if (pending) return pending;
  const p = new Promise<ImageBitmap | null>((resolve) => {
    previewQueue.push(async () => {
      const bmp = await decode(item.file, previewWidth);
      if (bmp) {
        noteAspect(item.id, bmp);
        previews.set(item.id, bmp);
        while (previews.size > MAX_PREVIEWS) {
          const [oldId, old] = previews.entries().next().value as [string, ImageBitmap];
          previews.delete(oldId);
          old.close();
        }
      }
      previewWaiters.delete(item.id);
      resolve(bmp);
    });
  });
  previewWaiters.set(item.id, p);
  return p;
}

/** Queue previews outward from the current frame so the nearest ones decode first. */
export function prefetchAround(items: MediaItem[], index: number, radius = 24) {
  const order: MediaItem[] = [];
  for (let d = radius; d >= 1; d--) {
    if (items[index + d]) order.push(items[index + d]);
    if (items[index - d]) order.push(items[index - d]);
  }
  if (items[index]) order.push(items[index]); // pushed last = runs first (LIFO)
  for (const it of order) if (!previews.has(it.id)) loadPreview(it);
}

// ---- full resolution (zoom) ----
// Only a few: a 24 MP photo is ~96 MB decoded. Current frame plus its neighbours.

const MAX_FULL = 3;
const fulls = new Map<string, ImageBitmap>();
const fullWaiters = new Map<string, Promise<ImageBitmap | null>>();
const fullQueue = new LifoQueue(1);

export function peekFull(id: string): ImageBitmap | undefined {
  const bmp = fulls.get(id);
  if (bmp) {
    fulls.delete(id);
    fulls.set(id, bmp);
  }
  return bmp;
}

export function loadFull(item: MediaItem): Promise<ImageBitmap | null> {
  const hit = peekFull(item.id);
  if (hit) return Promise.resolve(hit);
  const pending = fullWaiters.get(item.id);
  if (pending) return pending;
  const p = new Promise<ImageBitmap | null>((resolve) => {
    fullQueue.push(async () => {
      const bmp = await decode(item.file);
      if (bmp) {
        noteAspect(item.id, bmp);
        naturals.set(item.id, { w: bmp.width, h: bmp.height });
        fulls.set(item.id, bmp);
        while (fulls.size > MAX_FULL) {
          const [oldId, old] = fulls.entries().next().value as [string, ImageBitmap];
          fulls.delete(oldId);
          old.close();
        }
      }
      fullWaiters.delete(item.id);
      resolve(bmp);
    });
  });
  fullWaiters.set(item.id, p);
  return p;
}

export function clearImageCaches() {
  for (const bmp of fulls.values()) bmp.close();
  fulls.clear();
  aspects.clear();
  naturals.clear();
  for (const url of thumbs.values()) if (url) URL.revokeObjectURL(url);
  thumbs.clear();
  for (const bmp of previews.values()) bmp.close();
  previews.clear();
}
