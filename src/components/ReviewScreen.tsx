import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReview, type Shoot, type VisibleGroup } from '../lib/store';
import { pad2, plural, shortDate } from '../lib/format';
import { Stage } from './Stage';
import { GapControl } from './GapControl';
import { Navigator } from './Navigator';
import { Overview } from './Overview';
import { ConfirmDialog } from './ConfirmDialog';
import { SaveDialog } from './SaveDialog';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { useShortcutsKey } from '../lib/useShortcutsKey';
import { canSavePicks } from '../lib/savePicks';

type View = 'timeline' | 'overview';
const VIEW_KEY = 'burst:view';
const FOCUS_KEY = 'burst:focus';
const readFocus = () => {
  try {
    return localStorage.getItem(FOCUS_KEY) === '1';
  } catch {
    return false;
  }
};
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
    (g: VisibleGroup) => (g.kind === 'video' ? `VIDEO ${labels.map.get(g.id)}` : `BURST ${labels.map.get(g.id)}`),
    [labels],
  );

  const current = focused?.visible[Math.min(frameIndex, focused.visible.length - 1)];
  const focusIdx = focused ? visibleGroups.findIndex((g) => g.id === focused.id) : -1;
  const keptInFocused = focused ? focused.items.filter((id) => statusOf(id) === 'keep').length : 0;
  const unkeptInFocused = useMemo(() => (focused ? focused.items.filter((id) => statusOf(id) === 'review') : []), [focused, statusOf]);
  // Everything not kept and not yet archived: photos and videos.
  const allUnkept = useMemo(() => shoot.items.filter((i) => statusOf(i.id) === 'review'), [shoot, statusOf]);
  const allUnkeptPhotos = useMemo(() => allUnkept.map((i) => i.id), [allUnkept]);
  const unkeptWhat = (() => {
    const v = allUnkept.filter((i) => i.kind === 'video').length;
    const ph = allUnkept.length - v;
    return [ph ? plural(ph, 'photo') : '', v ? plural(v, 'video') : ''].filter(Boolean).join(' and ') || '0 photos';
  })();

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
      focusItem: current?.id,
      label: `archive ${plural(unkeptInFocused.length, 'photo')} in ${name}`,
      toast: `Archived ${plural(unkeptInFocused.length, 'photo')} from ${name}${keptInFocused ? ` · kept ${keptInFocused}` : ''}`,
    });
    if (nextGroup) focusGroup(nextGroup.id);
  }, [focused, current, unkeptInFocused, keptInFocused, burstLabel, visibleGroups, focusIdx, dispatch, focusGroup]);

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
      focusItem: current?.id,
      label: `archive ${unkeptWhat}`,
      toast: `Archived ${unkeptWhat} across the shoot${counts.keep ? ` · ${plural(counts.keep, 'keeper')} ${counts.keep === 1 ? 'stays' : 'stay'}` : ''}`,
    });
  }, [allUnkeptPhotos, unkeptWhat, counts.keep, current, dispatch]);

  /** Archive the not-kept items of one group (from the Overview). */
  const archiveGroup = useCallback(
    (groupId: string, ids: string[]) => {
      const g = groups.find((x) => x.id === groupId);
      const name = g ? (g.kind === 'video' ? `Video ${labels.map.get(g.id)}` : `Burst ${labels.map.get(g.id)}`) : 'this burst';
      const keeper = g?.items.find((id) => statusOf(id) === 'keep');
      dispatch({
        type: 'setStatus',
        ids,
        to: 'archived',
        focusItem: keeper ?? ids[0],
        label: `archive ${plural(ids.length, 'item')} in ${name}`,
        toast: `Archived ${plural(ids.length, g?.kind === 'video' ? 'video' : 'photo')} from ${name}`,
      });
    },
    [groups, labels, statusOf, dispatch],
  );

  /** Undo, then bring back the burst and photo that were on screen when it happened. */
  const undo = useCallback(() => {
    const last = state.undo[state.undo.length - 1];
    dispatch({ type: 'undo' });
    const id = last?.focusItem;
    const g = id ? groups.find((x) => x.items.includes(id)) : undefined;
    if (id && g) {
      dispatch({ type: 'focus', groupId: g.id });
      dispatch({ type: 'cursor', groupId: g.id, itemId: id });
    }
  }, [state.undo, groups, dispatch]);

  const restore = useCallback(
    (ids: string[]) =>
      ids.length && dispatch({ type: 'setStatus', ids, to: 'review', label: `restore ${plural(ids.length, 'item')}`, toast: `Restored ${plural(ids.length, 'item')}` }),
    [dispatch],
  );

  // "Archive all except kept" touches the whole shoot, so it asks first.
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useShortcutsKey(shortcutsOpen, setShortcutsOpen);
  const keptItems = useMemo(() => shoot.items.filter((i) => statusOf(i.id) === 'keep'), [shoot, statusOf]);
  const saveSupported = canSavePicks();

  // Timeline / Overview ------------------------------------------------------
  const [view, setViewState] = useState<View>(readView);
  // Opened a photo from the Overview: Esc in the timeline goes back there.
  const [fromOverview, setFromOverview] = useState(false);
  const setView = useCallback((v: View) => {
    setViewState(v);
    setFromOverview(false);
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
      setFromOverview(true);
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

  // Focus mode (no top bar, no filmstrip) and browser fullscreen ------------
  const [focusMode, setFocusModeState] = useState(readFocus);
  const setFocusMode = useCallback((on: boolean) => {
    setFocusModeState(on);
    try {
      localStorage.setItem(FOCUS_KEY, on ? '1' : '0');
    } catch {
      /* not essential */
    }
  }, []);
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const fullscreenSupported = typeof document.documentElement.requestFullscreen === 'function';
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    // Chrome refuses when the tab isn't in front, inside some embedded browsers, or while a
    // debugging / automation extension controls the tab. Say so instead of doing nothing.
    document.documentElement.requestFullscreen?.().catch(() =>
      dispatch({ type: 'notice', text: 'The browser didn’t allow full screen here. Try ⌃⌘F (or the green window button), or a tab without automation extensions attached.' }),
    );
  }, [dispatch]);
  const [zoomed, setZoomed] = useState(false);

  // Keyboard ---------------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t?.closest('input, textarea, video, dialog')) return;
      if (shortcutsOpen || e.key === '/') return; // the overlay handles its own keys
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g' || e.key === 'G') {
        setView(view === 'overview' ? 'timeline' : 'overview');
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        if (e.shiftKey) toggleFullscreen();
        else setFocusMode(!focusMode);
        return;
      }
      if (view === 'overview') {
        if (e.key === 'Escape') setView('timeline');
        return; // the timeline's keys don't apply to the grid
      }
      if (e.key === 'Escape' && zoomed) return; // the stage leaves zoom first
      if (e.key === 'Escape' && fromOverview) {
        setView('overview');
        return;
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
  }, [focused, frameIndex, setFrame, moveGroup, toggleKeep, archiveRestOfGroup, dispatch, view, setView, shortcutsOpen, fromOverview, undo, focusMode, setFocusMode, toggleFullscreen, zoomed]);

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
    <div className={`review${focusMode ? ' focus' : ''}`}>
      {focusMode && (
        <div className="focus-bar" role="toolbar" aria-label="Focus mode">
          <button className="icon-btn" onClick={() => setShortcutsOpen(true)} title="Keyboard shortcuts (/)" aria-label="Keyboard shortcuts">
            <ShortcutsIcon />
          </button>
          <button className="icon-btn" onClick={() => setFocusMode(false)} title="Show the top bar and filmstrip (F)" aria-label="Leave focus mode" aria-pressed>
            <FocusIcon on />
          </button>
          {fullscreenSupported && (
            <button className="icon-btn" onClick={toggleFullscreen} title={fullscreen ? 'Leave full screen (⇧F)' : 'Full screen (⇧F)'} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} aria-pressed={fullscreen}>
              <FullscreenIcon on={fullscreen} />
            </button>
          )}
        </div>
      )}
      {!focusMode && (
      <header className="appbar review-bar">
        <strong className="logo">Burst Bud</strong>
        <div className="shoot">
          <h1 title={shoot.rootName}>{shoot.rootName}</h1>
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
            aria-label={`Archive all ${unkeptWhat} except kept`}
            title="Archives every photo and video that isn't kept. Undo with ⌘Z."
          >
            Archive all except kept
            {allUnkeptPhotos.length > 0 && <span className="badge">{allUnkeptPhotos.length}</span>}
          </button>
          <button
            className="btn save"
            onClick={() => setSaving(true)}
            disabled={!keptItems.length}
            title={!keptItems.length ? 'Keep some photos first' : saveSupported ? 'Copy your kept photos into a folder' : 'Download your kept photos as a ZIP'}
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
            <span className="exit-label">Exit</span>
          </button>
          <div className="icon-group">
            <button className="icon-btn" onClick={() => setShortcutsOpen(true)} title="Keyboard shortcuts (tap / to open, hold / to peek)" aria-label="Keyboard shortcuts">
              <ShortcutsIcon />
            </button>
            <button className="icon-btn" onClick={() => setFocusMode(true)} title="Focus mode: hide the top bar and filmstrip (F)" aria-label="Focus mode">
              <FocusIcon />
            </button>
            {fullscreenSupported && (
              <button className="icon-btn" onClick={toggleFullscreen} title={fullscreen ? 'Leave full screen (⇧F)' : 'Full screen (⇧F)'} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} aria-pressed={fullscreen}>
                <FullscreenIcon on={fullscreen} />
              </button>
            )}
          </div>
        </div>
      </header>
      )}

      {view === 'overview' ? (
        <Overview
          groups={visibleGroups}
          labels={labels.map}
          focusedId={focused?.id}
          currentItemId={current?.id}
          statusOf={statusOf}
          keptOnly={keptOnly}
          onOpen={openInTimeline}
          onToggleKeep={toggleKeepId}
          onRestore={restore}
          onArchive={archiveGroup}
          summary={[
            shoot.items[0] ? shortDate(shoot.items[0].time) : '',
            plural(counts.photos, 'photo'),
            plural(labels.bursts, 'burst'),
            plural(counts.videos, 'video'),
            shoot.subfolders ? plural(shoot.subfolders, 'folder') : '',
            counts.keep ? `${counts.keep} kept` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
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
          keysEnabled={!shortcutsOpen && !saving && !confirmArchiveAll}
          onZoomChange={setZoomed}
          actions={
            <>
              <button className={`primary${isKept ? ' is-kept' : ''}`} onClick={toggleKeep} aria-pressed={isKept}>
                {isKept ? '✓ Kept' : <>+ Keep<span className="lbl-long"> {current.kind}</span></>} <kbd>Space</kbd>
              </button>
              <button className="btn" onClick={archiveRestOfGroup} disabled={!unkeptInFocused.length}>
                {focused.kind === 'video' ? (
                  <>Archive<span className="lbl-long"> video</span></>
                ) : unkeptInFocused.length ? (
                  <>Archive {unkeptInFocused.length}<span className="lbl-long"> not kept</span></>
                ) : (
                  <>Nothing<span className="lbl-long"> to archive</span></>
                )}{' '}
                <kbd>A</kbd>
              </button>
              {archivedInFocused.length > 0 && (
                <button className="restore-link" onClick={() => restore(archivedInFocused)} title="Bring this burst's archived photos back into the timeline" aria-label={`Restore ${archivedInFocused.length} archived`}>
                  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5.5 3 2.5 6l3 3" />
                    <path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                  <span className="lbl-long">Restore </span>
                  {archivedInFocused.length}
                </button>
              )}
            </>
          }
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

      {!focusMode && (
      <Navigator
        groups={visibleGroups}
        focusedId={focused?.id}
        frameFraction={focused && focused.visible.length > 1 ? frameIndex / (focused.visible.length - 1) : null}
        labels={labels.map}
        statusOf={statusOf}
        onSeek={seekShoot}
        onStep={moveGroup}
      />
      )}
      </>
      )}

      {shortcutsOpen && (
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      )}

      {saving && <SaveDialog shootName={shoot.rootName} kept={keptItems} startIn={folderHandle} onClose={() => setSaving(false)} />}

      {confirmArchiveAll && (
        <ConfirmDialog
          title={`Archive ${unkeptWhat}?`}
          body={
            counts.keep
              ? `Every photo and video you haven't kept moves to the archive. Your ${plural(counts.keep, 'keeper')} ${counts.keep === 1 ? 'stays' : 'stay'}. You can undo this right after with ⌘Z.`
              : `You haven't kept anything yet, so every photo and video in the shoot moves to the archive. You can undo this right after with ⌘Z.`
          }
          confirmLabel={`Archive ${unkeptWhat}`}
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
            <button className="toast-undo" onClick={undo}>
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

function ShortcutsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
      <path d="M4.5 6.5h1M7.5 6.5h1M10.5 6.5h1M5 9.5h6" />
    </svg>
  );
}

function FocusIcon({ on = false }: { on?: boolean }) {
  // A window with its top and bottom bars: solid while they show, dashed once hidden.
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 5.5h13M1.5 10.5h13" strokeDasharray={on ? '1.5 2' : undefined} />
    </svg>
  );
}

function FullscreenIcon({ on = false }: { on?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {on ? <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" /> : <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />}
    </svg>
  );
}
