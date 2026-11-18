import { useEffect, useMemo, useRef, useState } from 'react';
import './SaveDialog.css';
import type { MediaItem } from '../lib/types';
import { canSavePicks, formatBytes, pickDestination, planSave, savePicks, type SaveProgress } from '../lib/savePicks';
import { buildZip, downloadBlob, splitParts, zipSize } from '../lib/zipPicks';
import { plural } from '../lib/format';

interface Props {
  shootName: string;
  kept: MediaItem[];
  /** The imported folder: the picker starts there, so its parent is one step up. */
  startIn?: FileSystemDirectoryHandle;
  onClose: () => void;
}

type Phase =
  | { kind: 'setup'; error?: string }
  // Chrome / Edge / Arc: copy straight into a folder
  | { kind: 'saving'; progress: SaveProgress; dest: string }
  | { kind: 'done'; progress: SaveProgress; dest: string; stopped: boolean }
  // Safari / Firefox: download a ZIP (in parts when very large)
  | { kind: 'zipping'; part: number; done: number; total: number }
  | { kind: 'zipped'; downloaded: number[]; error?: string };

const cleanName = (s: string) => s.replace(/[/\\:*?"<>|]+/g, '-').replace(/^\.+/, '').trim();

export function SaveDialog({ shootName, kept, startIn, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [includeRaw, setIncludeRaw] = useState(true);
  const [newFolder, setNewFolder] = useState(true);
  const [folderName, setFolderName] = useState(`${shootName} picks`);
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const stop = useRef(false);
  const zipMode = !canSavePicks();

  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    return () => d.close();
  }, []);

  const rawCount = kept.filter((k) => k.raw).length;
  const plan = useMemo(() => planSave(kept, includeRaw), [kept, includeRaw]);
  const bytes = plan.reduce((s, e) => s + e.file.size, 0);
  const photos = kept.filter((k) => k.kind === 'photo').length;
  const videos = kept.length - photos;
  const parts = useMemo(() => (zipMode ? splitParts(plan) : [plan]), [zipMode, plan]);
  const zipFolder = cleanName(folderName) || `${cleanName(shootName)} picks`;
  const zipName = (i: number) => (parts.length > 1 ? `${zipFolder} (part ${i + 1} of ${parts.length}).zip` : `${zipFolder}.zip`);

  // ---------- Chrome: copy into a folder ----------
  async function startFolder() {
    const name = cleanName(folderName);
    if (newFolder && !name) return setPhase({ kind: 'setup', error: 'Give the new folder a name.' });
    let dest: FileSystemDirectoryHandle;
    try {
      const parent = await pickDestination(startIn);
      dest = newFolder ? await parent.getDirectoryHandle(name, { create: true }) : parent;
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return; // picker closed
      return setPhase({ kind: 'setup', error: `Couldn't use that folder: ${(e as Error).message}` });
    }
    stop.current = false;
    const result = await savePicks(
      dest,
      plan,
      (progress) => setPhase({ kind: 'saving', progress, dest: dest.name }),
      () => stop.current,
    );
    setPhase({ kind: 'done', progress: result, dest: dest.name, stopped: stop.current });
  }

  // ---------- Safari / Firefox: download a ZIP part ----------
  async function downloadPart(i: number) {
    const before = phase.kind === 'zipped' ? phase.downloaded : [];
    try {
      const blob = await buildZip(parts[i], zipFolder, (done, total) => setPhase({ kind: 'zipping', part: i, done, total }));
      downloadBlob(blob, zipName(i));
      setPhase({ kind: 'zipped', downloaded: [...new Set([...before, i])] });
    } catch (e) {
      setPhase({ kind: 'zipped', downloaded: before, error: `Couldn't build the ZIP: ${(e as Error).message}` });
    }
  }

  const busy = phase.kind === 'saving' || phase.kind === 'zipping';

  return (
    <dialog
      ref={ref}
      className="confirm save-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby="save-title"
    >
      {phase.kind === 'setup' && (
        <>
          <h2 id="save-title">{zipMode ? 'Download your picks' : 'Save a copy of your picks'}</h2>
          <p className="muted">
            {zipMode ? 'Downloads' : 'Copies'} {plural(photos, 'kept photo')}
            {videos ? ` and ${plural(videos, 'video')}` : ''} {zipMode ? 'as a ZIP' : 'into a folder'}. Your originals stay where they are.
          </p>

          <div className="save-summary">
            <strong>{plural(plan.length, 'file')}</strong>
            <span className="muted">
              {formatBytes(bytes)}
              {zipMode && parts.length > 1 && ` · ${parts.length} ZIP parts`}
            </span>
          </div>

          {rawCount > 0 && (
            <label className="check">
              <input type="checkbox" checked={includeRaw} onChange={(e) => setIncludeRaw(e.target.checked)} />
              <span className="box" aria-hidden />
              Include RAW files ({rawCount})
            </label>
          )}

          {zipMode ? (
            <>
              <label className="save-label" htmlFor="zip-folder">Folder inside the ZIP</label>
              <input id="zip-folder" className="save-name zip" value={folderName} onChange={(e) => setFolderName(e.target.value)} spellCheck={false} />
              <p className="save-hint muted small">
                Unzip it next to <b>{shootName}</b> to get a <b>{zipFolder}</b> folder beside your shoot. Photos aren't re-compressed: the copies are identical to your originals.
                {parts.length > 1 && ' This selection is large, so it comes in parts of up to 1.8 GB; unzip them all into the same place.'}
              </p>
            </>
          ) : (
            <>
              <label className="check">
                <input type="checkbox" checked={newFolder} onChange={(e) => setNewFolder(e.target.checked)} />
                <span className="box" aria-hidden />
                Create a new folder
              </label>
              {newFolder && (
                <input className="save-name" value={folderName} onChange={(e) => setFolderName(e.target.value)} aria-label="New folder name" spellCheck={false} />
              )}
              <p className="save-hint muted small">
                {newFolder ? (
                  <>
                    Next, pick where it goes. The picker opens in <b>{shootName}</b>; go up one level to put <b>{cleanName(folderName) || 'the new folder'}</b> right next to it.
                  </>
                ) : (
                  <>Next, pick the folder to copy into. Files already there with the same size are skipped.</>
                )}
              </p>
            </>
          )}
          {phase.error && <p className="error">{phase.error}</p>}

          <div className="confirm-actions">
            <button className="btn subtle" onClick={onClose}>
              Cancel
            </button>
            {zipMode ? (
              <button className="primary" onClick={() => downloadPart(0)} disabled={!plan.length} autoFocus>
                {parts.length > 1 ? `Download part 1 of ${parts.length}` : 'Download ZIP'}
              </button>
            ) : (
              <button className="primary" onClick={startFolder} disabled={!plan.length} autoFocus>
                Choose folder & save
              </button>
            )}
          </div>
        </>
      )}

      {phase.kind === 'saving' && (
        <>
          <h2 id="save-title">Saving to “{phase.dest}”</h2>
          <p className="muted">
            {phase.progress.done} of {plural(phase.progress.total, 'file')} · {formatBytes(phase.progress.bytesDone)} of {formatBytes(phase.progress.bytesTotal)}
          </p>
          <ProgressBar value={phase.progress.bytesTotal ? phase.progress.bytesDone / phase.progress.bytesTotal : 1} />
          <div className="confirm-actions">
            <button className="btn subtle" onClick={() => (stop.current = true)}>
              Stop
            </button>
          </div>
        </>
      )}

      {phase.kind === 'done' && (
        <>
          <h2 id="save-title">{phase.stopped ? 'Stopped' : phase.progress.failed.length ? 'Saved, with problems' : 'Saved'}</h2>
          <p className="muted">
            {plural(phase.progress.copied, 'file')} copied to “{phase.dest}”
            {phase.progress.skipped > 0 && ` · ${phase.progress.skipped} already there`}
            {phase.stopped && ` · ${phase.progress.total - phase.progress.done} not copied`}.
          </p>
          {phase.progress.failed.length > 0 && (
            <p className="error">
              Couldn't copy {plural(phase.progress.failed.length, 'file')}: {phase.progress.failed.slice(0, 4).join(', ')}
              {phase.progress.failed.length > 4 ? '…' : ''}
            </p>
          )}
          <div className="confirm-actions">
            <button className="primary" onClick={onClose} autoFocus>
              Done
            </button>
          </div>
        </>
      )}

      {phase.kind === 'zipping' && (
        <>
          <h2 id="save-title">Building {parts.length > 1 ? `part ${phase.part + 1} of ${parts.length}` : 'your ZIP'}</h2>
          <p className="muted">
            {formatBytes(phase.done)} of {formatBytes(phase.total)} · nothing leaves your computer
          </p>
          <ProgressBar value={phase.total ? phase.done / phase.total : 0} />
        </>
      )}

      {phase.kind === 'zipped' && (
        <>
          <h2 id="save-title">{phase.downloaded.length === parts.length ? 'Downloaded' : `Part ${phase.downloaded.length} of ${parts.length} downloaded`}</h2>
          <p className="muted">
            {parts.length > 1
              ? 'Download each part, then unzip them into the same place.'
              : `Look for “${zipName(0)}” in your downloads and unzip it next to ${shootName}.`}
          </p>
          {phase.error && <p className="error">{phase.error}</p>}
          <div className="zip-parts">
            {parts.map((p, i) => (
              <button key={i} className={phase.downloaded.includes(i) ? 'btn subtle' : 'primary'} onClick={() => downloadPart(i)}>
                {phase.downloaded.includes(i) ? '✓ ' : ''}
                {parts.length > 1 ? `Part ${i + 1}` : 'Download again'} · {formatBytes(zipSize(p, zipFolder))}
              </button>
            ))}
          </div>
          <div className="confirm-actions">
            <button className={phase.downloaded.length === parts.length ? 'primary' : 'btn subtle'} onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="save-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <span style={{ transform: `scaleX(${value})` }} />
    </div>
  );
}
