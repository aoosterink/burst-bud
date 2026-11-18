import exifr from 'exifr';
import type { MediaItem } from './types';

const PHOTO_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'heic', 'heif', 'gif', 'tif', 'tiff']);
const RAW_EXT = new Set(['cr2', 'cr3', 'nef', 'nrw', 'arw', 'raf', 'orf', 'rw2', 'dng', 'pef', 'srw', 'x3f']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mts', 'm2ts']);

export interface ScannedFile {
  path: string; // relative to root, using '/'
  file: File;
}

export interface ScanResult {
  rootName: string;
  files: ScannedFile[];
}

const ext = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
const isHidden = (name: string) => name.startsWith('.');

export const supportsDirectoryPicker = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/** Walk a directory handle recursively (File System Access API: Chrome, Edge, Arc). */
export async function scanDirectoryHandle(
  root: FileSystemDirectoryHandle,
  recursive: boolean,
  onProgress?: (count: number) => void,
): Promise<ScanResult> {
  const files: ScannedFile[] = [];
  async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
    for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (isHidden(entry.name)) continue;
      if (entry.kind === 'directory') {
        if (recursive) await walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`);
      } else if (isMediaName(entry.name)) {
        files.push({ path: prefix + entry.name, file: await (entry as FileSystemFileHandle).getFile() });
        if (files.length % 50 === 0) onProgress?.(files.length);
      }
    }
  }
  await walk(root, '');
  onProgress?.(files.length);
  return { rootName: root.name, files };
}

/** Files from <input webkitdirectory> (works in every modern browser). */
export function scanFileList(list: FileList | File[], recursive: boolean): ScanResult {
  const all = Array.from(list);
  const rootName = (all[0] as File & { webkitRelativePath?: string })?.webkitRelativePath?.split('/')[0] ?? 'Shoot';
  const files: ScannedFile[] = [];
  for (const file of all) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = rel.split('/').slice(1); // drop the root folder name
    const path = parts.length ? parts.join('/') : file.name;
    if (path.split('/').some(isHidden)) continue;
    if (!recursive && path.includes('/')) continue;
    if (isMediaName(file.name)) files.push({ path, file });
  }
  return { rootName, files };
}

export function isMediaName(name: string) {
  if (isHidden(name)) return false;
  const e = ext(name);
  return PHOTO_EXT.has(e) || RAW_EXT.has(e) || VIDEO_EXT.has(e);
}

function splitPath(path: string) {
  const slash = path.lastIndexOf('/');
  const folder = slash === -1 ? '' : path.slice(0, slash);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return { folder, name, base: dot === -1 ? name : name.slice(0, dot) };
}

/** Read the capture time, with sub-second precision when the camera wrote it. */
async function captureTime(file: File): Promise<{ time: number; exif: boolean }> {
  try {
    const tags = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'SubSecTimeOriginal', 'CreateDate', 'SubSecTimeDigitized'],
      reviveValues: true,
    });
    const date: Date | undefined = tags?.DateTimeOriginal ?? tags?.CreateDate;
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      const sub = tags?.SubSecTimeOriginal ?? tags?.SubSecTimeDigitized;
      let ms = 0;
      if (sub !== undefined && sub !== null) {
        const digits = String(sub).trim().replace(/[^0-9]/g, '');
        if (digits) ms = Math.round(Number(`0.${digits}`) * 1000);
      }
      return { time: date.getTime() + ms, exif: true };
    }
  } catch {
    /* not parseable: fall through */
  }
  return { time: file.lastModified, exif: false };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>, onDone?: (n: number) => void) {
  const out = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
        if (++done % 25 === 0) onDone?.(done);
      }
    }),
  );
  onDone?.(done);
  return out;
}

/**
 * Turn scanned files into media items. A RAW file with a JPG/HEIC twin of the same name
 * in the same folder is attached to that twin instead of becoming a second frame.
 */
export async function buildItems(files: ScannedFile[], onProgress?: (done: number, total: number) => void) {
  const byKey = new Map<string, { display?: ScannedFile; raw?: ScannedFile; video?: ScannedFile }>();
  for (const f of files) {
    const { folder, base } = splitPath(f.path);
    const e = ext(f.path);
    if (VIDEO_EXT.has(e)) {
      byKey.set(`v:${f.path}`, { video: f });
      continue;
    }
    const key = `${folder}/${base}`;
    const slot = byKey.get(key) ?? {};
    if (RAW_EXT.has(e)) slot.raw = f;
    else slot.display = f;
    byKey.set(key, slot);
  }

  const entries = [...byKey.values()];
  const items = await mapLimit(
    entries,
    8,
    async (slot): Promise<MediaItem> => {
      if (slot.video) {
        const { folder, name } = splitPath(slot.video.path);
        return { id: slot.video.path, kind: 'video', name, folder, file: slot.video.file, time: slot.video.file.lastModified, exifTime: false };
      }
      const main = slot.display ?? slot.raw!;
      const { folder, name } = splitPath(main.path);
      const t = await captureTime(main.file);
      // RAW often carries better EXIF than an exported JPG; try it when the JPG has none.
      const time = !t.exif && slot.raw && slot.display ? await captureTime(slot.raw.file) : t;
      return {
        id: main.path,
        kind: 'photo',
        name,
        folder,
        file: main.file,
        raw: slot.display ? slot.raw?.file : undefined,
        time: time.time,
        exifTime: time.exif,
      };
    },
    (n) => onProgress?.(n, entries.length),
  );
  return items;
}
