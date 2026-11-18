import { buildItems, scanDirectoryHandle, type ScanResult, type ScannedFile } from './scan';
import { sortByCapture } from './group';
import type { Shoot } from './store';

/**
 * Keeps the last opened shoot around so a reload or an accidental Back doesn't lose it.
 *  - Folder picked with the File System Access picker: we store the directory handle in
 *    IndexedDB. Nothing is copied; on reload the browser may ask for read permission again.
 *  - Folder picked with the upload input (or the sample): we copy the files into the
 *    browser's private storage (OPFS) and read them back from there.
 * Labels, gap, position and undo history live in localStorage (see store.ts).
 */

export interface SavedSession {
  rootName: string;
  source: 'handle' | 'opfs';
  handle?: FileSystemDirectoryHandle;
  includeSub: boolean;
  savedAt: number;
  /** OPFS copies get a new modified date; keep the originals (path -> ms) to restore them. */
  mtimes?: Record<string, number>;
}

const DB = 'burst';
const STORE = 'kv';
const KEY = 'session';
const OPFS_DIR = 'session-files';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export async function loadSession(): Promise<SavedSession | null> {
  try {
    return (await kv<SavedSession | undefined>('readonly', (s) => s.get(KEY))) ?? null;
  } catch {
    return null;
  }
}

export async function saveSession(s: SavedSession) {
  try {
    await kv('readwrite', (st) => st.put(s, KEY));
    navigator.storage?.persist?.().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function opfsDir(create: boolean) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create });
}

/** Copy files into OPFS. Resolves false when the browser can't (no OPFS or quota). */
export async function copyToLocal(files: ScannedFile[], onProgress?: (done: number, total: number) => void) {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(OPFS_DIR, { recursive: true }).catch(() => {});
    const base = await opfsDir(true);
    let done = 0;
    for (const f of files) {
      const parts = f.path.split('/');
      let dir = base;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(f.file);
      await w.close();
      onProgress?.(++done, files.length);
    }
    return true;
  } catch {
    return false;
  }
}

export async function readLocal(rootName: string, mtimes: Record<string, number> = {}): Promise<ScanResult> {
  const scan = await scanDirectoryHandle(await opfsDir(false), true);
  const files = scan.files.map((f) => {
    const t = mtimes[f.path];
    return t === undefined ? f : { path: f.path, file: new File([f.file], f.file.name, { type: f.file.type, lastModified: t }) };
  });
  return { rootName, files };
}

export const mtimesOf = (files: ScannedFile[]) => Object.fromEntries(files.map((f) => [f.path, f.file.lastModified]));

type PermHandle = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'read' }): Promise<PermissionState>;
};

/** 'granted' | 'prompt' | 'denied'. Call request=true only from a click. */
export async function handlePermission(h: FileSystemDirectoryHandle, request = false): Promise<PermissionState> {
  const ph = h as PermHandle;
  try {
    const q = await ph.queryPermission({ mode: 'read' });
    if (q === 'granted' || !request) return q;
    return await ph.requestPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

/** Turn a scan into a shoot: read capture times, drop subfolders if asked, sort. */
export async function prepareShoot(scan: ScanResult, includeSub: boolean, onProgress?: (msg: string) => void): Promise<Shoot> {
  const files = includeSub ? scan.files : scan.files.filter((f) => !f.path.includes('/'));
  onProgress?.(`Reading capture times… 0 / ${files.length}`);
  const items = sortByCapture(await buildItems(files, (d, t) => onProgress?.(`Reading capture times… ${d} / ${t}`)));
  return {
    rootName: scan.rootName,
    items,
    byId: new Map(items.map((i) => [i.id, i])),
    subfolders: new Set(items.map((i) => i.folder).filter(Boolean)).size,
  };
}
