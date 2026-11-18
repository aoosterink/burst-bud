import { useEffect, useMemo, useRef, useState } from 'react';
import './SaveDialog.css';
import type { MediaItem } from '../lib/types';
import { formatBytes, pickDestination, planSave, savePicks, type SaveProgress } from '../lib/savePicks';
import { plural } from '../lib/format';

interface Props {
  shootName: string;
  kept: MediaItem[];
  /** The imported folder: the picker starts there, so its parent is one step up. */
  startIn?: FileSystemDirectoryHandle;
  onClose: () => void;
}

type Phase = { kind: 'setup'; error?: string } | { kind: 'saving'; progress: SaveProgress; dest: string } | { kind: 'done'; progress: SaveProgress; dest: string; stopped: boolean };

const cleanName = (s: string) => s.replace(/[/\\:*?"<>|]+/g, '-').replace(/^\.+/, '').trim();

export function SaveDialog({ shootName, kept, startIn, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [includeRaw, setIncludeRaw] = useState(true);
  const [newFolder, setNewFolder] = useState(true);
  const [folderName, setFolderName] = useState(`${shootName} picks`);
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const stop = useRef(false);

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

  async function start() {
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
    const destLabel = newFolder ? `${dest.name}` : dest.name;
    const result = await savePicks(
      dest,
      plan,
      (progress) => setPhase({ kind: 'saving', progress, dest: destLabel }),
      () => stop.current,
    );
    setPhase({ kind: 'done', progress: result, dest: destLabel, stopped: stop.current });
  }

  const busy = phase.kind === 'saving';

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
          <h2 id="save-title">Save a copy of your picks</h2>
          <p className="muted">
            Copies {plural(photos, 'kept photo')}
            {videos ? ` and ${plural(videos, 'video')}` : ''} into a folder. Your originals stay where they are.
          </p>

          <div className="save-summary">
            <strong>{plural(plan.length, 'file')}</strong>
            <span className="muted">{formatBytes(bytes)}</span>
          </div>

          {rawCount > 0 && (
            <label className="check">
              <input type="checkbox" checked={includeRaw} onChange={(e) => setIncludeRaw(e.target.checked)} />
              <span className="box" aria-hidden />
              Include RAW files ({rawCount})
            </label>
          )}

          <label className="check">
            <input type="checkbox" checked={newFolder} onChange={(e) => setNewFolder(e.target.checked)} />
            <span className="box" aria-hidden />
            Create a new folder
          </label>
          {newFolder && (
            <input
              className="save-name"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              aria-label="New folder name"
              spellCheck={false}
            />
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
          {phase.error && <p className="error">{phase.error}</p>}

          <div className="confirm-actions">
            <button className="btn subtle" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" onClick={start} disabled={!plan.length} autoFocus>
              Choose folder & save
            </button>
          </div>
        </>
      )}

      {phase.kind === 'saving' && (
        <>
          <h2 id="save-title">Saving to “{phase.dest}”</h2>
          <p className="muted">
            {phase.progress.done} of {plural(phase.progress.total, 'file')} · {formatBytes(phase.progress.bytesDone)} of {formatBytes(phase.progress.bytesTotal)}
          </p>
          <div className="save-bar" role="progressbar" aria-valuemin={0} aria-valuemax={phase.progress.total} aria-valuenow={phase.progress.done}>
            <span style={{ transform: `scaleX(${phase.progress.bytesTotal ? phase.progress.bytesDone / phase.progress.bytesTotal : 1})` }} />
          </div>
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
    </dialog>
  );
}
