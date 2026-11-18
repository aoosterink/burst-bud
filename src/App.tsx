import { useCallback, useEffect, useRef, useState } from 'react';
import { ImportScreen, type ImportOrigin } from './components/ImportScreen';
import { ReviewScreen } from './components/ReviewScreen';
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog';
import { clearImageCaches } from './lib/images';
import { scanDirectoryHandle } from './lib/scan';
import {
  copyToLocal,
  handlePermission,
  loadSession,
  mtimesOf,
  prepareShoot,
  readLocal,
  saveSession,
  type SavedSession,
} from './lib/session';
import type { Shoot } from './lib/store';

type Phase = 'boot' | 'import' | 'review';

/** Where the open shoot is safe across a reload. */
export type SaveState = { kind: 'saved' } | { kind: 'copying'; done: number; total: number } | { kind: 'unsaved' };

export default function App() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [open, setOpen] = useState<{ shoot: Shoot; gapMs?: number; handle?: FileSystemDirectoryHandle } | null>(null);
  const [lastSession, setLastSession] = useState<SavedSession | null>(null);
  const [resumeBusy, setResumeBusy] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'unsaved' });
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const generation = useRef(0);

  const enterReview = useCallback((shoot: Shoot, gapMs?: number, handle?: FileSystemDirectoryHandle) => {
    setOpen({ shoot, gapMs, handle });
    setPhase('review');
    // An in-app history entry, so the browser Back button asks before leaving the shoot.
    history.pushState({ burst: 'review' }, '');
  }, []);

  const reopen = useCallback(
    async (s: SavedSession, requestPermission: boolean) => {
      setResumeBusy(`Opening ${s.rootName}…`);
      try {
        let scan;
        if (s.source === 'handle' && s.handle) {
          const perm = await handlePermission(s.handle, requestPermission);
          if (perm !== 'granted') return false;
          scan = await scanDirectoryHandle(s.handle, true, (n) => setResumeBusy(`Scanning… ${n} files`));
        } else {
          scan = await readLocal(s.rootName, s.mtimes);
        }
        const shoot = await prepareShoot(scan, s.includeSub, setResumeBusy);
        if (!shoot.items.length) return false;
        setSaveState({ kind: 'saved' });
        enterReview(shoot, undefined, s.source === 'handle' ? s.handle : undefined); // gap, position, labels and undo come back from localStorage
        return true;
      } catch {
        return false;
      } finally {
        setResumeBusy(null);
      }
    },
    [enterReview],
  );

  // Boot: reopen the last shoot straight away when we can do it without a click.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return; // StrictMode runs effects twice in dev
    booted.current = true;
    (async () => {
      const s = await loadSession();
      setLastSession(s);
      if (s && (s.source === 'opfs' || (s.handle && (await handlePermission(s.handle)) === 'granted'))) {
        if (await reopen(s, false)) return;
      }
      setPhase('import');
    })();
  }, [reopen]);

  async function onOpen(shoot: Shoot, gapMs: number, origin: ImportOrigin) {
    const gen = ++generation.current;
    enterReview(shoot, gapMs, origin.handle);
    const session: SavedSession = { rootName: shoot.rootName, source: 'handle', includeSub: origin.includeSub, savedAt: Date.now() };
    if (origin.handle) {
      const ok = await saveSession({ ...session, handle: origin.handle });
      setSaveState(ok ? { kind: 'saved' } : { kind: 'unsaved' });
      if (ok) setLastSession({ ...session, handle: origin.handle });
      return;
    }
    // No reusable folder handle: keep a private copy of the files in the browser.
    setSaveState({ kind: 'copying', done: 0, total: origin.scan.files.length });
    const copied = await copyToLocal(origin.scan.files, (done, total) => {
      if (gen === generation.current && (done % 10 === 0 || done === total)) setSaveState({ kind: 'copying', done, total });
    });
    if (gen !== generation.current) return;
    const saved: SavedSession = { ...session, source: 'opfs', mtimes: mtimesOf(origin.scan.files) };
    const ok = copied && (await saveSession(saved));
    setSaveState(ok ? { kind: 'saved' } : { kind: 'unsaved' });
    if (ok) setLastSession(saved);
  }

  const leave = useCallback(() => {
    generation.current++;
    clearImageCaches();
    setOpen(null);
    setPhase('import');
  }, []);

  const askToLeave = useCallback(
    (via: 'back' | 'import') => {
      const safe = saveState.kind === 'saved';
      setConfirm({
        title: `Exit ${open?.shoot.rootName ?? 'this shoot'}?`,
        body: safe
          ? 'Your kept and archived photos are saved in this browser. You can resume this shoot from the import screen.'
          : saveState.kind === 'copying'
            ? 'The local copy of this shoot is not finished yet. If you leave now you will have to import the folder again (your labels are saved).'
            : 'This browser could not save a copy of the files. You will have to import the folder again to continue (your labels are saved).',
        confirmLabel: 'Exit shoot',
        onConfirm: () => {
          setConfirm(null);
          leave();
        },
        onCancel: () => {
          setConfirm(null);
          if (via === 'back') history.pushState({ burst: 'review' }, ''); // put the entry back
        },
      });
    },
    [saveState.kind, open, leave],
  );

  // Browser Back while reviewing: ask first.
  useEffect(() => {
    if (phase !== 'review') return;
    const onPop = () => askToLeave('back');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [phase, askToLeave]);

  // Reload / close while the shoot can't be restored: let the browser warn.
  useEffect(() => {
    if (phase !== 'review' || saveState.kind === 'saved') return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [phase, saveState.kind]);

  if (phase === 'boot') {
    return (
      <div className="boot">
        <strong>BURST</strong>
        <span className="muted small">{resumeBusy ?? 'Loading…'}</span>
      </div>
    );
  }

  return (
    <>
      {phase === 'review' && open ? (
        <ReviewScreen
          key={open.shoot.rootName + open.shoot.items.length}
          shoot={open.shoot}
          initialGapMs={open.gapMs}
          folderHandle={open.handle}
          onImport={() => askToLeave('import')}
        />
      ) : (
        <ImportScreen
          onOpen={onOpen}
          resume={lastSession ? { session: lastSession, busy: resumeBusy, onResume: () => reopen(lastSession, true) } : undefined}
        />
      )}
      {confirm && <ConfirmDialog {...confirm} />}
    </>
  );
}
