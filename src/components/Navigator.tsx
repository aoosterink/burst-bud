import { memo, useEffect, useRef, type ReactNode } from 'react';
import { useThumb } from '../lib/hooks';
import type { VisibleGroup } from '../lib/store';
import type { Status } from '../lib/types';
import { clockTime, plural } from '../lib/format';

interface Props {
  groups: VisibleGroup[];
  focusedId?: string;
  /** Position of the current frame inside the focused group (0–1), null for single items. */
  frameFraction: number | null;
  labels: Map<string, string>;
  statusOf: (id: string) => Status;
  /** Focus a group; with a fraction, also jump to that position inside it. */
  onSeek: (groupId: string, fraction: number | null) => void;
  onStep: (steps: number) => void;
  /** Right side of the header line (totals, save state). */
  aside?: ReactNode;
}

/**
 * The whole shoot as one scrubbable bar. Click a burst to open it; press and drag
 * across the bar to seek through the shoot frame by frame, like a video timeline.
 * Scroll (wheel or trackpad) over it to step between bursts.
 */
export function Navigator({ groups, focusedId, frameFraction, labels, statusOf, onSeek, onStep, aside }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; moved: boolean } | null>(null);
  const wheelAcc = useRef(0);
  const onStepRef = useRef(onStep);
  useEffect(() => {
    onStepRef.current = onStep;
  }, [onStep]);

  // Which bar (and where in it) is under clientX. Past either end clamps to the first/last bar.
  function hit(clientX: number): { id: string; fraction: number } | null {
    const bars = scroller.current?.querySelectorAll<HTMLElement>('.bar');
    if (!bars?.length) return null;
    let best: HTMLElement = bars[0];
    for (const b of bars) {
      if (b.getBoundingClientRect().left <= clientX) best = b;
      else break;
    }
    const r = best.getBoundingClientRect();
    return { id: best.dataset.id!, fraction: Math.max(0, Math.min(1, (clientX - r.left) / r.width)) };
  }

  function autoScroll(clientX: number) {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    if (clientX < r.left + 24) el.scrollLeft -= (r.left + 24 - clientX) / 3 + 2;
    else if (clientX > r.right - 24) el.scrollLeft += (clientX - (r.right - 24)) / 3 + 2;
  }

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelAcc.current += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      // One burst per wheel notch; trackpads send many small deltas that add up.
      const STEP = 50;
      if (Math.abs(wheelAcc.current) >= STEP) {
        const dir = wheelAcc.current > 0 ? 1 : -1;
        wheelAcc.current = 0;
        onStepRef.current(dir);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Keep the focused burst in view when focus changes from elsewhere (keys, stage, archive).
  useEffect(() => {
    if (drag.current) return;
    const el = scroller.current?.querySelector<HTMLElement>('.bar.on');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [focusedId]);

  // Many groups: thinner bars and tighter gaps so the whole shoot fits, with a number
  // on every 10th (or 25th) bar. Scrolling only kicks in for very large shoots.
  const dense = groups.length > 40;
  const labelEvery = groups.length > 250 ? 25 : dense ? 10 : 1;

  return (
    <nav className="navigator" aria-label="Shoot overview">
      <div className="nav-head">
        <span>Shoot overview</span>
        {aside && <span className="nav-aside small">{aside}</span>}
      </div>
      <div
        className={`bars${dense ? ' dense' : ''}`}
        ref={scroller}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x0: e.clientX, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;
          if (!d.moved) {
            d.moved = true;
            e.currentTarget.classList.add('dragging');
          }
          autoScroll(e.clientX);
          const h = hit(e.clientX);
          if (h) onSeek(h.id, h.fraction);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          e.currentTarget.classList.remove('dragging');
          if (d && !d.moved) {
            // Plain click: open that burst where you left it.
            const h = hit(e.clientX);
            if (h) onSeek(h.id, null);
          }
        }}
        onPointerCancel={(e) => {
          drag.current = null;
          e.currentTarget.classList.remove('dragging');
        }}
      >
        {groups.map((g, i) => {
          const done = g.items.every((id) => statusOf(id) !== 'review');
          const allArchived = g.visible.every((i) => statusOf(i.id) === 'archived');
          const kept = g.items.some((id) => statusOf(id) === 'keep');
          const on = g.id === focusedId;
          return (
            <div
              key={g.id}
              data-id={g.id}
              className={`bar ${g.kind}${on ? ' on' : ''}${done ? ' done' : ''}${allArchived ? ' archived' : ''}${kept ? ' has-kept' : ''}`}
              style={{ flexGrow: g.kind === 'video' ? 0 : Math.sqrt(g.visible.length) }}
              title={`${labels.get(g.id)} · ${plural(g.visible.length, g.kind === 'video' ? 'video' : 'photo')} · ${clockTime(g.start)}`}
              role="button"
              aria-label={`${labels.get(g.id)}, ${plural(g.visible.length, 'item')}`}
              aria-current={on || undefined}
            >
              <BarFill group={g} statusOf={statusOf}>
                {kept && <i />}
                {on && frameFraction !== null && <b className="playhead" style={{ left: `${frameFraction * 100}%` }} />}
              </BarFill>
              <span className={`bar-label${on || i === 0 || (i + 1) % labelEvery === 0 ? '' : ' hidden'}`}>{labels.get(g.id)}</span>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/** A bar in the filmstrip: the burst's keeper (or middle frame) as a small cover image. */
const BarFill = memo(function BarFill({ group, statusOf, children }: { group: VisibleGroup; statusOf: (id: string) => Status; children?: ReactNode }) {
  const items = group.visible;
  const cover = group.kind === 'photo' ? items.find((i) => statusOf(i.id) === 'keep') ?? items[Math.floor(items.length / 2)] : undefined;
  const url = useThumb(cover);
  return (
    <span className="bar-fill" style={url ? { backgroundImage: `url(${url})` } : undefined}>
      {group.kind === 'video' && <span className="bar-play" aria-hidden>▶</span>}
      {children}
    </span>
  );
});
