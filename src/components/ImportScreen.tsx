import { useMemo, useRef, useState } from 'react';
import { buildGroups, sortByCapture } from '../lib/group';
import {
  buildItems,
  isMediaName,
  scanDirectoryHandle,
  scanFileList,
  supportsDirectoryPicker,
  type ScanResult,
  type ScannedFile,
} from '../lib/scan';
import type { MediaItem } from '../lib/types';
import type { Shoot } from '../lib/store';
import { plural, shortDate } from '../lib/format';
import type { SavedSession } from '../lib/session';
import { GapControl, GapIcon } from './GapControl';
import './ImportScreen.css';
import { SOURCE_URL } from '../lib/links';

export interface ImportOrigin {
  scan: ScanResult;
  handle?: FileSystemDirectoryHandle;
  includeSub: boolean;
}

interface Props {
  onOpen: (shoot: Shoot, gapMs: number, origin: ImportOrigin) => void;
  /** Last shoot that needs a click to reopen (folder read permission). */
  resume?: { session: SavedSession; onResume: () => void; busy: string | null };
}

interface Loaded {
  scan: ScanResult;
  handle?: FileSystemDirectoryHandle;
  items: MediaItem[]; // all items, sorted
}

/** Walk a dropped folder (FileSystemEntry API, every browser), skipping hidden files. */
async function readEntryTree(root: FileSystemDirectoryEntry): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  const readAll = (dir: FileSystemDirectoryEntry) =>
    new Promise<FileSystemEntry[]>((resolve, reject) => {
      const reader = dir.createReader();
      const acc: FileSystemEntry[] = [];
      const next = () =>
        reader.readEntries((batch) => {
          if (!batch.length) return resolve(acc);
          acc.push(...batch);
          next(); // readEntries returns at most ~100 entries per call
        }, reject);
      next();
    });
  async function walk(dir: FileSystemDirectoryEntry, prefix: string) {
    for (const entry of await readAll(dir)) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory) await walk(entry as FileSystemDirectoryEntry, `${prefix}${entry.name}/`);
      else if (isMediaName(entry.name)) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        out.push({ path: prefix + entry.name, file });
      }
    }
  }
  await walk(root, '');
  return out;
}

const subfolderCount = (items: MediaItem[]) => new Set(items.map((i) => i.folder).filter(Boolean)).size;

export function ImportScreen({ onOpen, resume }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeSub, setIncludeSub] = useState(true);
  const [gapMs, setGapMs] = useState(1000);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  async function ingest(scan: ScanResult, handle?: FileSystemDirectoryHandle) {
    if (!scan.files.length) {
      setError(`No photos or videos found in “${scan.rootName}”.`);
      setProgress(null);
      return;
    }
    setProgress(`Reading capture times… 0 / ${scan.files.length}`);
    const items = await buildItems(scan.files, (done, total) => setProgress(`Reading capture times… ${done} / ${total}`));
    setLoaded({ scan, handle, items: sortByCapture(items) });
    setProgress(null);
  }

  // ---------- drag & drop: a folder (or loose files) anywhere on the screen ----------
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  function onDragEnter(e: React.DragEvent) {
    if (!hasFiles(e) || progress) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (!hasFiles(e) || progress) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  }
  async function onDrop(e: React.DragEvent) {
    if (!hasFiles(e) || progress) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    setError(null);
    // Grab everything synchronously: the DataTransfer is emptied once this handler yields.
    const items = Array.from(e.dataTransfer.items).filter((i) => i.kind === 'file');
    const first = items[0] as (DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }) | undefined;
    const handlePromise = items.length === 1 && first?.getAsFileSystemHandle ? first.getAsFileSystemHandle() : null;
    const entries = items.map((i) => i.webkitGetAsEntry()).filter((x): x is FileSystemEntry => !!x);
    const looseFiles = Array.from(e.dataTransfer.files);
    try {
      setProgress('Scanning folder…');
      // Chromium: a real directory handle, so the shoot can be resumed later like a picked folder.
      const handle = handlePromise ? await handlePromise.catch(() => null) : null;
      if (handle?.kind === 'directory') {
        const dir = handle as FileSystemDirectoryHandle;
        await ingest(await scanDirectoryHandle(dir, true, (n) => setProgress(`Scanning folder… ${n} files`)), dir);
        return;
      }
      const dirEntry = entries.length === 1 && entries[0].isDirectory ? (entries[0] as FileSystemDirectoryEntry) : null;
      if (dirEntry) {
        await ingest({ rootName: dirEntry.name, files: await readEntryTree(dirEntry) });
        return;
      }
      const files = looseFiles.filter((f) => isMediaName(f.name) && !f.name.startsWith('.'));
      await ingest({ rootName: 'Dropped files', files: files.map((file) => ({ path: file.name, file })) });
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
      setProgress(null);
    }
  }

  async function pickFolder() {
    setError(null);
    if (!supportsDirectoryPicker()) {
      inputRef.current?.click();
      return;
    }
    const asked = performance.now();
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await (window as unknown as { showDirectoryPicker: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({
        id: 'burst-shoot',
        mode: 'read',
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      // Some browsers expose the folder picker but block it (embedded app browsers, iframes,
      // strict privacy settings): it fails, or "cancels" before a dialog could even show.
      // Fall back to the plain folder upload input, which works everywhere.
      const blocked = name === 'SecurityError' || name === 'NotAllowedError' || name === 'TypeError' || (name === 'AbortError' && performance.now() - asked < 400);
      if (blocked) {
        inputRef.current?.click();
        // If that is blocked too (e.g. an automation extension intercepts every file dialog on
        // this tab), the input opens nothing either: say so instead of doing nothing.
        setError('Your browser didn’t open the folder dialog. Drag the folder onto this page instead, or open Burst Bud in a new tab without browser-automation extensions attached.');
      } else if (name !== 'AbortError') setError(String((e as Error)?.message ?? e));
      return;
    }
    try {
      setProgress('Scanning folder…');
      const scan = await scanDirectoryHandle(handle, true, (n) => setProgress(`Scanning folder… ${n} files`));
      await ingest(scan, handle);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setProgress(null);
    }
  }

  const included = useMemo(
    () => (loaded ? (includeSub ? loaded.items : loaded.items.filter((i) => i.folder === '')) : []),
    [loaded, includeSub],
  );
  const photoCount = included.filter((i) => i.kind === 'photo').length;
  const videoCount = included.length - photoCount;
  const burstCount = useMemo(() => buildGroups(included, gapMs).filter((g) => g.kind === 'photo').length, [included, gapMs]);
  const noExif = included.filter((i) => i.kind === 'photo' && !i.exifTime).length;

  function open() {
    if (!loaded || !included.length) return;
    onOpen(
      {
        rootName: loaded.scan.rootName,
        items: included,
        byId: new Map(included.map((i) => [i.id, i])),
        subfolders: subfolderCount(included),
      },
      gapMs,
      { scan: loaded.scan, handle: loaded.handle, includeSub },
    );
  }

  return (
    <div
      className={dragging ? 'import is-dragging' : 'import'}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="drop-veil" aria-hidden>
        <span>Drop the folder to import</span>
      </div>

      <main className="import-main">
        <BurstShowcase />

        <div className="import-side">
        <section className="import-card">
          {resume && !loaded && (
            <div className="resume">
              <div>
                <span className="eyebrow">Last shoot</span>
                <h3>{resume.session.rootName}</h3>
                <span className="muted small">
                  {resume.busy ?? `Opened ${shortDate(resume.session.savedAt)} · your labels are saved`}
                </span>
              </div>
              <button className="primary" onClick={resume.onResume} disabled={!!resume.busy}>
                Resume →
              </button>
            </div>
          )}
          <h2>Import a folder</h2>
          <p className="muted">A whole shoot, including folders inside folders.</p>

          {loaded ? (
            <div className="folder-card">
              <span className="eyebrow">Folder</span>
              <h3>{loaded.scan.rootName}</h3>
              <div className="folder-meta">
                <span className="muted">
                  {plural(photoCount, 'photo')} · {plural(videoCount, 'video')} · {plural(subfolderCount(loaded.items), 'subfolder')}
                </span>
                <button className="link" onClick={pickFolder}>Change folder</button>
              </div>
            </div>
          ) : (
            <button className="dropzone" onClick={pickFolder} disabled={!!progress}>
              <span className="dz-title">
                {!progress && (
                  <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                    <path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.5 1.6h5.9a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
                  </svg>
                )}
                {progress ?? 'Choose or drop a folder'}
              </span>
              <span className="dz-formats small">JPG · PNG · HEIC · RAW (with or without JPG twin) · video</span>
            </button>
          )}
          {loaded && progress && <p className="muted small">{progress}</p>}
          {error && <p className="error">{error}</p>}

          <label className="check">
            <input type="checkbox" checked={includeSub} onChange={(e) => setIncludeSub(e.target.checked)} />
            <span className="box" aria-hidden />
            Include all subfolders
          </label>

          <hr />

          <h3 className="h-sub with-icon"><GapIcon /> Gap between groups</h3>
          <div className="gap-row">
            <p className="muted">Start a new group when the time between two photos is longer than:</p>
            <GapControl valueMs={gapMs} onChange={setGapMs} />
          </div>
          {loaded && <p className="accent small">{plural(burstCount, 'burst')} detected</p>}
          <p className="muted small">
            You can adjust this later.
            {noExif > 0 && ` ${plural(noExif, 'photo')} had no capture time in EXIF; using file dates for those.`}
          </p>

          <button className="primary wide" onClick={open} disabled={!loaded || !included.length}>
            Open timeline →
          </button>

          <input
            ref={inputRef}
            type="file"
            hidden
            multiple
            // @ts-expect-error non-standard but universally supported
            webkitdirectory=""
            onChange={async (e) => {
              if (!e.target.files?.length) return;
              setError(null);
              setProgress('Scanning folder…');
              await ingest(scanFileList(e.target.files, true));
              e.target.value = '';
            }}
          />
        </section>

        <ul className="import-trust">
          <li>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 1.8 2.8 3.9v3.7c0 3.2 2.2 5.6 5.2 6.6 3-1 5.2-3.4 5.2-6.6V3.9z" />
              <path d="m5.8 8 1.6 1.6 2.9-3.1" />
            </svg>
            Your originals stay put. Keep and archive only change review labels.
          </li>
          <li>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="12" height="8" rx="1.2" />
              <path d="M5.5 13.5h5M8 11v2.5" />
            </svg>
            <span>
              Runs entirely in your browser · nothing is uploaded ·{' '}
              <a href={SOURCE_URL} target="_blank" rel="noreferrer">
                source code ↗
              </a>
            </span>
          </li>
        </ul>
        </div>
      </main>
    </div>
  );
}

/* ---------- backdrop: the surf burst photo, one surfer framed as the keeper ---------- */

function BurstShowcase() {
  return (
    <section className="import-show" aria-label="Burst Bud: pick the keeper from each burst">
      <div className="show-photo" role="img" aria-label="A surfer's turn shot as a burst of five frames, with one frame marked as kept" />
      <div className="show-copy">
        <h1>Burst Bud</h1>
        <p>Sort out your shit.</p>
      </div>
    </section>
  );
}
