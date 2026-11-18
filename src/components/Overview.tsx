import { memo, useEffect, useRef, useState } from 'react';
import './Overview.css';
import { loadThumb, peekThumb } from '../lib/images';
import type { VisibleGroup } from '../lib/store';
import type { MediaItem, Status } from '../lib/types';
import { clockTime, plural, seconds } from '../lib/format';

interface Props {
  groups: VisibleGroup[];
  labels: Map<string, string>;
  focusedId?: string;
  currentItemId?: string;
  statusOf: (id: string) => Status;
  keptOnly: boolean;
  /** Open this item in the timeline. */
  onOpen: (groupId: string, itemId: string) => void;
  onToggleKeep: (itemId: string) => void;
  onRestore: (ids: string[]) => void;
  /** Shoot summary line shown at the top. */
  summary: string;
}

/** The whole shoot at a glance: every burst as a row of frames. */
export function Overview({ groups, labels, focusedId, currentItemId, statusOf, keptOnly, onOpen, onToggleKeep, onRestore, summary }: Props) {
  const scroller = useRef<HTMLDivElement>(null);

  // Start where you were in the timeline.
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(focusedId ?? '')}"]`);
    el?.scrollIntoView({ block: 'start' });
    // only on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!groups.length) {
    return (
      <div className="overview empty">
        <div>
          <h2>{keptOnly ? 'No keepers yet.' : 'Everything is archived.'}</h2>
          <p className="muted">{keptOnly ? 'Turn off “Kept only” to see the whole shoot.' : '⌘Z undoes the last archive.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`overview${keptOnly ? ' picks' : ''}`} ref={scroller}>
      <p className="ov-summary muted small">{summary}</p>
      {groups.map((g) => {
        const kept = g.items.filter((id) => statusOf(id) === 'keep').length;
        const archived = g.items.filter((id) => statusOf(id) === 'archived');
        const label = labels.get(g.id) ?? '';
        const folder = g.visible[0]?.folder;
        return (
          <section key={g.id} className={`ov-group${g.id === focusedId ? ' on' : ''}${kept > 0 ? ' has-kept' : ''}`} data-group={g.id}>
            <header className="ov-head">
              <span className="eyebrow">{g.kind === 'video' ? `VIDEO ${label}` : `BURST ${label}`}</span>
              <strong>{clockTime(g.start)}</strong>
              {g.kind === 'photo' && g.items.length > 1 && <span className="muted">{seconds(g.end - g.start)}</span>}
              {folder && <span className="muted ov-folder">{folder.split('/').join(' / ')}</span>}
              {archived.length > 0 && !keptOnly && (
                <button
                  className="ov-restore"
                  onClick={() => onRestore(archived)}
                  title={`Restore ${plural(archived.length, 'archived photo')}`}
                  aria-label={`Restore ${plural(archived.length, 'archived photo')}`}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5.5 3 2.5 6l3 3" />
                    <path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                  Unarchive {archived.length}
                </button>
              )}
            </header>
            <div className="ov-grid">
              {g.visible.map((it) => (
                <Tile
                  key={it.id}
                  item={it}
                  index={g.items.indexOf(it.id) + 1}
                  status={statusOf(it.id)}
                  current={it.id === currentItemId}
                  onOpen={() => onOpen(g.id, it.id)}
                  onToggleKeep={() => onToggleKeep(it.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const Tile = memo(function Tile({ item, index, status, current, onOpen, onToggleKeep }: { item: MediaItem; index: number; status: Status; current: boolean; onOpen: () => void; onToggleKeep: () => void }) {
  const { src, attach } = useLazyThumb(item);
  const kept = status === 'keep';
  return (
    <div className={`ov-tile${kept ? ' kept' : ''}${current ? ' current' : ''}`}>
      <button className="ov-img" onClick={onOpen} title={`${item.name} · open in timeline`} ref={attach}>
        {src && <img src={src} alt="" draggable={false} />}
        {item.kind === 'video' && <span className="ov-play" aria-hidden>▶</span>}
        <span className="ov-n">{String(index).padStart(2, '0')}</span>
      </button>
      <button
        className="ov-keep"
        onClick={onToggleKeep}
        aria-pressed={kept}
        aria-label={kept ? `Unkeep ${item.name}` : `Keep ${item.name}`}
        title={kept ? 'Kept · click to unkeep' : 'Keep'}
      >
        {kept ? '✓' : '+'}
      </button>
    </div>
  );
});

/** Load a thumbnail only once its tile scrolls near the viewport. */
function useLazyThumb(item: MediaItem) {
  const [src, setSrc] = useState<string | null>(() => (item.kind === 'photo' ? peekThumb(item) ?? null : null));
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el || src || item.kind !== 'photo') return;
    let alive = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        loadThumb(item).then((u) => alive && setSrc(u));
      },
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [el, src, item]);
  return { src, attach: setEl };
}
