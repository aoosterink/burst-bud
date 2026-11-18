import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReview, type Shoot, type VisibleGroup } from '../lib/store';
import { clockTime, pad2, plural, shortDate } from '../lib/format';
import { Stage } from './Stage';
import { GapControl } from './GapControl';
import { Navigator } from './Navigator';
import { Overview } from './Overview';
import { ConfirmDialog } from './ConfirmDialog';
import { SaveDialog } from './SaveDialog';
import { canSavePicks } from '../lib/savePicks';

type View = 'timeline' | 'overview';
const VIEW_KEY = 'burst:view';
const readView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'overview' ? 'overview' : 'timeline';
  } catch {
    return 'timeline';
  }
};

interface Props {
  shoot: Shoot;
  /** Gap chosen on the import screen; undefined when resuming (the saved gap is used). */
  initialGapMs?: number;
  /** The imported folder, when picked with the folder picker (save dialog starts there). */
  folderHandle?: FileSystemDirectoryHandle;
  onImport: () => void;
}

export function ReviewScreen({ shoot, initialGapMs, folderHandle, onImport }: Props) {
  const { state, dispatch, groups, visibleGroups, focused, frameIndex, counts, statusOf } = useReview(shoot, initialGapMs);

  // Stable labels: photo bursts are numbered 01…, videos V1…, over the whole shoot.
  const labels = useMemo(() => {
    const m = new Map<string, string>();
    let b = 0;
    let v = 0;
    for (const g of groups) m.set(g.id, g.kind === 'video' ? `V${++v}` : pad2(++b));
    return { map: m, bursts: b, videos: v };
  }, [groups]);
  const burstLabel = useCallback(
    (g: VisibleGroup) => (g.kind === 'video' ? `VIDEO ${labels.map.get(g.id)}` : `BURST ${labels.map.get(g.id)} / ${pad2(labels.bursts)}`),
    [labels],
  );

  const current = focused?.visible[Math.min(frameIndex, focused.visible.length - 1)];
  const focusIdx = focused ? visibleGroups.findIndex((g) => g.id === focused.id) : -1;
  const keptInFocused = focused ? focused.items.filter((id) => statusOf(id) === 'keep').length : 0;
  const unkeptInFocused = useMemo(() => (focused ? focused.items.filter((id) => statusOf(id) === 'review') : []), [focused, statusOf]);
  const allUnkeptPhotos = useMemo(
    () => shoot.items.filter((i) => i.kind === 'photo' && statusOf(i.id) === 'review').map((i) => i.id),
    [shoot, statusOf],
  );

  const setFrame = useCallback(
    (i: number) => focused && dispatch({ type: 'cursor', groupId: focused.id, itemId: focused.visible[i].id }),
    [focused, dispatch],
  );
  const focusGroup = useCallback((id: string) => dispatch({ type: 'focus', groupId: id }), [dispatch]);
  const moveGroup = useCallback(
    (d: number) => {
      const g = visibleGroups[Math.max(0, Math.min(visibleGroups.length - 1, focusIdx + d))];
      if (g && g.id !== focused?.id) focusGroup(g.id);
    },
    [visibleGroups, focusIdx, focusGroup, focused],
  );
  /** From the shoot overview: focus a group, optionally at a position (0–1) inside it. */
  const seekShoot = useCallback(
    (groupId: string, fraction: number | null) => {
      dispatch({ type: 'focus', groupId });
      if (fraction === null) return;
      const g = visibleGroups.find((x) => x.id === groupId);
      if (!g) return;
      const i = Math.round(Math.max(0, Math.min(1, fraction)) * (g.visible.length - 1));
      dispatch({ type: 'cursor', groupId, itemId: g.visible[i].id });
    },
    [dispatch, visibleGroups],
  );

  const toggleKeep = useCallback(() => {
    if (!current) return;
    const kept = statusOf(current.id) === 'keep';
    dispatch({ type: 'setStatus', ids: [current.id], to: kept ? 'review' : 'keep', label: kept ? 'unkeep' : 'keep' });
  }, [current, statusOf, dispatch]);

  // Signature moment: the not-kept frames drop away, then the archive happens and the
  // next burst slides in. Skipped (instant) for reduced motion.
  const [sweeping, setSweeping] = useState(false);
  const sweepTimer = useRef<number | null>(null);
  useEffect(() => () => void (sweepTimer.current && clearTimeout(sweepTimer.current)), []);

  const archiveNow = useCallback(() => {
    if (!focused || !unkeptInFocused.length) return;
    const name = burstLabel(focused).split(' /')[0].toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
    const nextGroup = visibleGroups[focusIdx + 1];
    dispatch({
      type: 'setStatus',
      ids: unkeptInFocused,
      to: 'archived',
      label: `archive ${plural(unkeptInFocused.length, 'photo')} in ${name}`,
      toast: `Archived ${plural(unkeptInFocused.length, 'photo')} from ${name}${keptInFocused ? ` · kept ${keptInFocused}` : ''}`,
    });
    if (nextGroup) focusGroup(nextGroup.id);
  }, [focused, unkeptInFocused, keptInFocused, burstLabel, visibleGroups, focusIdx, dispatch, focusGroup]);

  const archiveRestOfGroup = useCallback(() => {
    if (!focused || !unkeptInFocused.length || sweeping) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return archiveNow();
    setSweeping(true);
    sweepTimer.current = window.setTimeout(() => {
      setSweeping(false);
      archiveNow();
    }, 210);
  }, [focused, unkeptInFocused, sweeping, archiveNow]);

  const archiveAll = useCallback(() => {
    if (!allUnkeptPhotos.length) return;
    dispatch({
      type: 'setStatus',
      ids: allUnkeptPhotos,
      to: 'archived',
      label: `archive ${plural(allUnkeptPhotos.length, 'photo')}`,
      toast: `Archived ${plural(allUnkeptPhotos.length, 'photo')} across the shoot${counts.keep ? ` · ${plural(counts.keep, 'keeper')} stay` : ''}`,
    });
  }, [allUnkeptPhotos, counts.keep, dispatch]);

  const restore = useCallback(
    (ids: string[]) =>
      ids.length && dispatch({ type: 'setStatus', ids, to: 'review', label: `restore ${plural(ids.length, 'item')}`, toast: `Restored ${plural(ids.length, 'item')}` }),
    [dispatch],
  );

  // "Archive all except kept" touches the whole shoot, so it asks first.
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const keptItems = useMemo(() => shoot.items.filter((i) => statusOf(i.id) === 'keep'), [shoot, statusOf]);
  const saveSupported = canSavePicks();

  // Timeline / Overview ------------------------------------------------------
  const [view, setViewState] = useState<View>(readView);
  const setView = useCallback((v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* not essential */
    }
  }, []);
  const openInTimeline = useCallback(
    (groupId: string, itemId: string) => {
      dispatch({ type: 'focus', groupId });
      dispatch({ type: 'cursor', groupId, itemId });
      setView('timeline');
    },
    [dispatch, setView],
  );
  const toggleKeepId = useCallback(
    (id: string) => {
      const kept = statusOf(id) === 'keep';
      dispatch({ type: 'setStatus', ids: [id], to: kept ? 'review' : 'keep', label: kept ? 'unkeep' : 'keep' });
    },
    [statusOf, dispatch],
  );

  // Keyboard ---------------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t?.closest('input, textarea, video, dialog')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        dispatch({ type: 'undo' });
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g' || e.key === 'G') {
        setView(view === 'overview' ? 'timeline' : 'overview');
        return;
      }
      if (view === 'overview') {
        if (e.key === 'Escape') setView('timeline');
        return; // the timeline's keys don't apply to the grid
      }
      if (!focused) return;
      const n = focused.visible.length;
      const stepN = e.shiftKey ? 5 : 1;
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          setFrame(Math.min(n - 1, frameIndex + stepN));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setFrame(Math.max(0, frameIndex - stepN));
          break;
        case 'ArrowDown':
        case ']':
          e.preventDefault();
          moveGroup(1);
          break;
        case 'ArrowUp':
        case '[':
          e.preventDefault();
          moveGroup(-1);
          break;
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          // A focused button would also "click" on Space; take focus off it first.
          if (t instanceof HTMLButtonElement) t.blur();
          toggleKeep();
          break;
        case 'a':
        case 'A':
          archiveRestOfGroup();
          break;
        case 'Home':
          setFrame(0);
          break;
        case 'End':
          setFrame(n - 1);
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, frameIndex, setFrame, moveGroup, toggleKeep, archiveRestOfGroup, dispatch, view, setView]);

  // Toast stays mounted briefly after it's dismissed so it can animate out.
  const [toastShown, setToastShown] = useState(state.toast);
  const [toastLeaving, setToastLeaving] = useState(false);
  if (state.toast && state.toast !== toastShown) {
    setToastShown(state.toast);
    setToastLeaving(false);
  } else if (!state.toast && toastShown && !toastLeaving) {
    setToastLeaving(true);
  }
  useEffect(() => {
    if (!toastLeaving) return;
    const t = setTimeout(() => {
      setToastShown(null);
      setToastLeaving(false);
    }, 150);
    return () => clearTimeout(t);
  }, [toastLeaving]);

  // Toast auto-dismiss
  useEffect(() => {
    if (!state.toast) return;
    const t = setTimeout(() => dispatch({ type: 'dismissToast' }), 8000);
    return () => clearTimeout(t);
  }, [state.toast, dispatch]);

  const keptOnly = state.filter === 'kept';
  const isKept = current ? statusOf(current.id) === 'keep' : false;
  const archivedInFocused = focused ? focused.items.filter((id) => statusOf(id) === 'archived') : [];

  return (
    <div className="review">
      <header className="appbar review-bar">
        <strong className="logo">BURST</strong>
        <div className="shoot">
          <h1 title={shoot.rootName}>{shoot.rootName}</h1>
          <span className="muted small">
            {shoot.items[0] && `${shortDate(shoot.items[0].time)} · `}
            {plural(counts.photos, 'photo')} · {plural(labels.bursts, 'burst')} · {plural(counts.videos, 'video')}
            {shoot.subfolders ? ` · ${plural(shoot.subfolders, 'folder')}` : ''}
          </span>
        </div>
        <div className="view-switch" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === 'timeline'} onClick={() => setView('timeline')} title="Timeline (G)">
            <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true" fill="currentColor">
              <rect x="0" y="4" width="2" height="6" rx="0.6" opacity="0.6" />
              <rect x="3" y="2" width="2.5" height="10" rx="0.7" opacity="0.8" />
              <rect x="6.5" y="0" width="4" height="14" rx="0.9" />
              <rect x="11.5" y="2" width="2.5" height="10" rx="0.7" opacity="0.8" />
              <rect x="15" y="4" width="1" height="6" rx="0.5" opacity="0.6" />
            </svg>
            <span className="vs-label">Timeline</span>
          </button>
          <button role="tab" aria-selected={view === 'overview'} onClick={() => setView('overview')} title="Overview (G)">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="currentColor">
              <rect x="0" y="0" width="4" height="4" rx="0.8" />
              <rect x="5" y="0" width="4" height="4" rx="0.8" />
              <rect x="10" y="0" width="4" height="4" rx="0.8" />
              <rect x="0" y="5" width="4" height="4" rx="0.8" />
              <rect x="5" y="5" width="4" height="4" rx="0.8" />
              <rect x="10" y="5" width="4" height="4" rx="0.8" />
              <rect x="0" y="10" width="4" height="4" rx="0.8" />
              <rect x="5" y="10" width="4" height="4" rx="0.8" />
            </svg>
            <span className="vs-label">Overview</span>
          </button>
        </div>
        <button
          className={`switch${keptOnly ? ' on' : ''}`}
          role="switch"
          aria-checked={keptOnly}
          title="Hide photos you haven't kept, to look over your picks"
          onClick={() => dispatch({ type: 'filter', filter: keptOnly ? 'active' : 'kept' })}
        >
          <span className="switch-track" aria-hidden><span className="switch-thumb" /></span>
          Kept only <span className="count">{counts.keep}</span>
        </button>
        <GapControl className="labelled" label="Gap between groups" icon valueMs={state.gapMs} onChange={(gapMs) => dispatch({ type: 'gap', gapMs })} />
        <div className="appbar-actions">
          <button
            className="btn"
            onClick={() => setConfirmArchiveAll(true)}
            disabled={!allUnkeptPhotos.length}
            aria-label={`Archive all ${allUnkeptPhotos.length} photos except kept`}
            title="Archives every photo that isn't kept. Videos are left alone. Undo with ⌘Z."
          >
            Archive all except kept
            {allUnkeptPhotos.length > 0 && <span className="badge">{allUnkeptPhotos.length}</span>}
          </button>
          <button
            className="btn save"
            onClick={() => setSaving(true)}
            disabled={!keptItems.length || !saveSupported}
            title={
              !saveSupported
                ? 'Saving copies needs Chrome, Edge or Arc'
                : keptItems.length
                  ? 'Copy your kept photos into a folder'
                  : 'Keep some photos first'
            }
          >
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2v8" />
              <path d="M4.8 6.8 8 10l3.2-3.2" />
              <path d="M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11" />
            </svg>
            Save selection
            {keptItems.length > 0 && <span className="badge">{keptItems.length}</span>}
          </button>
          <button className="btn subtle" onClick={onImport} title="Close this shoot and go back to the import screen">
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" />
              <path d="M10.5 11 13.5 8l-3-3" />
              <path d="M13.5 8H6" />
            </svg>
            Exit
          </button>
        </div>
      </header>

      {view === 'overview' ? (
        <Overview
          groups={visibleGroups}
          labels={labels.map}
          bursts={labels.bursts}
          focusedId={focused?.id}
          currentItemId={current?.id}
          statusOf={statusOf}
          keptOnly={keptOnly}
          onOpen={openInTimeline}
          onToggleKeep={toggleKeepId}
          onRestore={restore}
        />
      ) : (
      <>
      {focused && current ? (
        <Stage
          groups={visibleGroups}
          focused={focused}
          frameIndex={Math.min(frameIndex, focused.visible.length - 1)}
          burstLabel={burstLabel}
          statusOf={statusOf}
          onFrame={setFrame}
          onFocus={focusGroup}
          onHoldChange={() => {}}
          sweeping={sweeping}
          viewKey={state.filter}
        />
      ) : (
        <div className="stage empty">
          <div>
            <h2>{keptOnly ? 'No keepers yet.' : 'Everything is archived.'}</h2>
            <p className="muted">
              {keptOnly ? 'Turn off “Kept only” to see the rest of the shoot.' : `${plural(counts.keep, 'keeper')} · ${plural(counts.archived, 'archived item')} · ⌘Z undoes the last archive`}
            </p>
          </div>
        </div>
      )}

      <section className="controls">
        {current && focused ? (
          <>
            <div className="file">
              <strong title={current.id}>{current.name}</strong>
              <span className="muted small">
                {focused.kind === 'photo' ? `Frame ${frameIndex + 1} / ${focused.visible.length} · ` : ''}
                {clockTime(current.time, true)}
                {current.raw && ' · +RAW'}
                {!current.exifTime && ' · file date'}
              </span>
            </div>
            <div className="actions">
              <button className={`primary${isKept ? ' is-kept' : ''}`} onClick={toggleKeep} aria-pressed={isKept}>
                {isKept ? '✓ Kept' : `+ Keep ${current.kind}`} <kbd>Space</kbd>
              </button>
              <button className="btn" onClick={archiveRestOfGroup} disabled={!unkeptInFocused.length}>
                {focused.kind === 'video' ? 'Archive video' : unkeptInFocused.length ? `Archive ${unkeptInFocused.length} not kept` : 'Nothing to archive'} <kbd>A</kbd>
              </button>
              <span className="muted small">
                {focused.kind === 'video' ? 'Archiving hides it from the timeline.' : keptInFocused ? `Keeps your ${plural(keptInFocused, 'pick')}` : 'Nothing kept in this burst yet'}
              </span>
            </div>
            <div className="restore-slot">
              {archivedInFocused.length > 0 && (
                <button className="restore-link" onClick={() => restore(archivedInFocused)} title="Bring this burst's archived photos back into the timeline">
                  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5.5 3 2.5 6l3 3" />
                    <path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                  Restore {archivedInFocused.length} archived
                </button>
              )}
            </div>
          </>
        ) : (
          <div />
        )}
      </section>

      <Navigator
        groups={visibleGroups}
        focusedId={focused?.id}
        frameFraction={focused && focused.visible.length > 1 ? frameIndex / (focused.visible.length - 1) : null}
        labels={labels.map}
        statusOf={statusOf}
        onSeek={seekShoot}
        onStep={moveGroup}
        bursts={labels.bursts}
        videos={labels.videos}
      />
      </>
      )}

      {saving && <SaveDialog shootName={shoot.rootName} kept={keptItems} startIn={folderHandle} onClose={() => setSaving(false)} />}

      {confirmArchiveAll && (
        <ConfirmDialog
          title={`Archive ${plural(allUnkeptPhotos.length, 'photo')}?`}
          body={
            counts.keep
              ? `Every photo you haven't kept, across all ${plural(labels.bursts, 'burst')}, moves to the archive. Your ${plural(counts.keep, 'keeper')} and all videos stay. You can undo this right after with ⌘Z.`
              : `You haven't kept any photos yet, so every photo in all ${plural(labels.bursts, 'burst')} moves to the archive. Videos stay. You can undo this right after with ⌘Z.`
          }
          confirmLabel={`Archive ${plural(allUnkeptPhotos.length, 'photo')}`}
          cancelLabel="Cancel"
          onConfirm={() => {
            setConfirmArchiveAll(false);
            archiveAll();
          }}
          onCancel={() => setConfirmArchiveAll(false)}
        />
      )}

      {toastShown && (
        <div className={`toast${toastShown.undoable ? '' : ' quiet'}${toastLeaving ? ' leaving' : ''}`} key={toastShown.id} role="status">
          <span>{toastShown.text}</span>
          {toastShown.undoable && !toastLeaving && (
            <button className="toast-undo" onClick={() => dispatch({ type: 'undo' })}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5.5 3 2.5 6l3 3" />
                <path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6" />
              </svg>
              Undo <kbd>⌘Z</kbd>
            </button>
          )}
          <button className="ghost" aria-label="Dismiss" onClick={() => dispatch({ type: 'dismissToast' })}>×</button>
        </div>
      )}
    </div>
  );
}
