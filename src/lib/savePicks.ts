import type { MediaItem } from './types';

/**
 * Copy the kept files into a folder the user picks (File System Access API: Chrome,
 * Edge, Arc). Files go into one flat folder; if two sources share a file name (two
 * camera bodies), the later one is prefixed with its subfolder. A file that already
 * exists with the same size is skipped, so saving again only copies new picks.
 */

export const canSavePicks = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export interface SavePlanEntry {
  name: string; // file name in the destination
  file: File;
}

export interface SaveProgress {
  done: number; // files handled
  total: number;
  bytesDone: number;
  bytesTotal: number;
  copied: number;
  skipped: number;
  failed: string[];
}

/** Destination names for the kept items (and their RAW twins when asked). */
export function planSave(items: MediaItem[], includeRaw: boolean): SavePlanEntry[] {
  const used = new Set<string>();
  const plan: SavePlanEntry[] = [];
  const add = (file: File, folder: string) => {
    let name = file.name;
    if (used.has(name.toLowerCase())) {
      const prefix = folder ? folder.split('/').join(' - ') : 'root';
      name = `${prefix} - ${file.name}`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${prefix} - ${n} - ${file.name}`;
    }
    used.add(name.toLowerCase());
    plan.push({ name, file });
  };
  for (const it of items) {
    add(it.file, it.folder);
    if (includeRaw && it.raw) add(it.raw, it.folder);
  }
  return plan;
}

type PickerWindow = Window & {
  showDirectoryPicker(o: { id?: string; mode?: 'read' | 'readwrite'; startIn?: FileSystemHandle | string }): Promise<FileSystemDirectoryHandle>;
};

/** Ask for a destination. Starts in the imported folder when we have it. */
export async function pickDestination(startIn?: FileSystemDirectoryHandle) {
  const w = window as unknown as PickerWindow;
  try {
    return await w.showDirectoryPicker({ id: 'burst-save', mode: 'readwrite', startIn: startIn ?? 'pictures' });
  } catch (e) {
    // Some browsers reject a startIn handle they can't use; retry without it.
    if ((e as DOMException)?.name === 'AbortError') throw e;
    return await w.showDirectoryPicker({ id: 'burst-save', mode: 'readwrite' });
  }
}

export async function savePicks(
  dest: FileSystemDirectoryHandle,
  plan: SavePlanEntry[],
  onProgress: (p: SaveProgress) => void,
  shouldStop: () => boolean,
): Promise<SaveProgress> {
  const p: SaveProgress = {
    done: 0,
    total: plan.length,
    bytesDone: 0,
    bytesTotal: plan.reduce((s, e) => s + e.file.size, 0),
    copied: 0,
    skipped: 0,
    failed: [],
  };
  onProgress({ ...p });
  for (const entry of plan) {
    if (shouldStop()) break;
    try {
      let exists = false;
      try {
        const existing = await (await dest.getFileHandle(entry.name)).getFile();
        exists = existing.size === entry.file.size;
      } catch {
        /* not there yet */
      }
      if (exists) p.skipped++;
      else {
        const fh = await dest.getFileHandle(entry.name, { create: true });
        const w = await fh.createWritable();
        await w.write(entry.file);
        await w.close();
        p.copied++;
      }
    } catch {
      p.failed.push(entry.name);
    }
    p.done++;
    p.bytesDone += entry.file.size;
    onProgress({ ...p });
  }
  return p;
}

export const formatBytes = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
