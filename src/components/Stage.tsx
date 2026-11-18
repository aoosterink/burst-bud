import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadPreview, loadThumb, peekPreview, prefetchAround, setPreviewWidth } from '../lib/images';
import { useElementSize, useObjectUrl, useThumb } from '../lib/hooks';
import type { VisibleGroup } from '../lib/store';
import type { MediaItem, Status } from '../lib/types';
import { clockTime, plural, seconds } from '../lib/format';

interface Props {
  groups: VisibleGroup[];
  focused: VisibleGroup;
  frameIndex: number;
  burstLabel: (g: VisibleGroup) => string;
  statusOf: (id: string) => Status;
  onFrame: (index: number) => void;
  onFocus: (groupId: string) => void;
  onHoldChange: (holding: boolean) => void;
  /** Archive sweep in progress: not-kept frames drop away before focus moves on. */
  sweeping?: boolean;
  /** Changes when the visible set changes (e.g. Kept only), to cross-fade the burst. */
  viewKey?: string;
}

const SLIVERS = 9;

export function Stage({ groups, focused, frameIndex, burstLabel, statusOf, onFrame, onFocus, onHoldChange, sweeping = false, viewKey = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { width: W, height: H } = useElementSize(ref);
  const [holding, setHolding] = useState(false);
  const wheelAcc = useRef(0);

  const frames = focused.visible;
  const n = frames.length;
  const current = frames[Math.min(frameIndex, n - 1)];
  const gi = groups.findIndex((g) => g.id === focused.id);
  const prev = groups[gi - 1];
  const next = groups[gi + 1];

  // Direction of travel between bursts, so the new one slides in from where it lives.
  // (Derived-state pattern: React re-renders before commit when we set state here.)
  const [nav, setNav] = useState({ id: focused.id, gi, dir: 0 });
  if (nav.id !== focused.id) setNav({ id: focused.id, gi, dir: gi > nav.gi ? 1 : -1 });
  const enterClass = nav.dir > 0 ? 'from-right' : nav.dir < 0 ? 'from-left' : 'fade-in';

  // Brief ring when the current photo becomes kept (not when you scrub onto a kept one).
  const keptNow = statusOf(current.id) === 'keep';
  const [keep, setKeep] = useState({ id: current.id, kept: keptNow, flash: 0, flashId: '' });
  if (keep.id !== current.id) setKeep({ id: current.id, kept: keptNow, flash: keep.flash, flashId: '' });
  else if (keep.kept !== keptNow) setKeep({ ...keep, kept: keptNow, flash: keep.flash + (keptNow ? 1 : 0), flashId: keptNow ? current.id : '' });

  // Geometry --------------------------------------------------------------
  const STRIP_H = n > 1 ? 56 : 0;
  const HEAD_H = 56;
  const photoH = Math.max(160, Math.min(H - STRIP_H - HEAD_H - 28, (W * 0.46) / 1.5));
  const photoW = photoH * 1.5;
  const cx = W / 2;
  const photoTop = HEAD_H + Math.max(0, (H - STRIP_H - HEAD_H - photoH) / 2);
  const midY = photoTop + photoH / 2;
  const side = Math.max(0, (W - photoW) / 2);
  const neighbourW = side * 0.5;
  const step = Math.max(6, Math.min(34, (side - neighbourW) / (SLIVERS + 1)));

  useEffect(() => {
    if (photoW) setPreviewWidth(photoW * (window.devicePixelRatio || 1));
  }, [photoW]);

  useEffect(() => {
    if (focused.kind === 'photo') prefetchAround(frames, frameIndex);
    // Warm the neighbours too, so moving to them doesn't start on an empty frame.
    // (The slivers and strip of a burst use the first ~16 thumbnails.)
    for (const g of [prev, next]) {
      if (g?.kind !== 'photo') continue;
      g.visible.slice(0, 16).forEach((it) => loadThumb(it));
      loadPreview(g.visible[0]);
    }
  }, [frames, frameIndex, focused.kind, next, prev]);

  // Hold + slide to seek ---------------------------------------------------
  const drag = useRef<{ x0: number; c0: number; left: number; right: number } | null>(null);

  function seekStart(e: React.PointerEvent) {
    if (n < 2 || e.button !== 0) return;
    const rect = ref.current!.getBoundingClientRect();
    drag.current = { x0: e.clientX, c0: frameIndex, left: rect.left + 12, right: rect.right - 12 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setHolding(true);
    onHoldChange(true);
  }
  function seekMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    let idx: number;
    // Moving to an edge reaches the first/last frame, wherever the press started.
    if (dx >= 0) idx = d.c0 + (dx / Math.max(1, d.right - d.x0)) * (n - 1 - d.c0);
    else idx = d.c0 + (dx / Math.max(1, d.x0 - d.left)) * d.c0;
    idx = Math.max(0, Math.min(n - 1, Math.round(idx)));
    if (idx !== frameIndex) onFrame(idx);
  }
  function seekEnd() {
    if (!drag.current) return;
    drag.current = null;
    setHolding(false);
    onHoldChange(false);
  }

  // Trackpad / wheel scrubs frames. A non-passive listener so we can claim the gesture:
  // otherwise a two-finger horizontal swipe can also trigger the browser's "back".
  const wheelState = useRef({ n, frameIndex, onFrame });
  useEffect(() => {
    wheelState.current = { n, frameIndex, onFrame };
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { n, frameIndex, onFrame } = wheelState.current;
      if (n < 2) return;
      wheelAcc.current += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const stepPx = 28;
      const steps = Math.trunc(wheelAcc.current / stepPx);
      if (steps) {
        wheelAcc.current -= steps * stepPx;
        onFrame(Math.max(0, Math.min(n - 1, frameIndex + steps)));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);


  return (
    <div className={`stage${holding ? ' holding' : ''}${sweeping ? ' sweeping' : ''}`} ref={ref}>
      {W > 0 && (
        <>
          <div className="spine" style={{ top: midY }} />

          <div className="layer nb-layer" key={`nb:${focused.id}:${viewKey}`}>

          {prev && (
            <Neighbour group={prev} label={burstLabel(prev)} statusOf={statusOf} x={0} w={neighbourW} midY={midY} h={photoH * 0.62} onClick={() => onFocus(prev.id)} side="left" />
          )}
          {next && (
            <Neighbour group={next} label={burstLabel(next)} statusOf={statusOf} x={W - neighbourW} w={neighbourW} midY={midY} h={photoH * 0.62} onClick={() => onFocus(next.id)} side="right" />
          )}
          </div>

          <div className={`layer burst-layer ${enterClass}`} key={`b:${focused.id}:${viewKey}`}>

          {focused.kind === 'photo' &&
            Array.from({ length: SLIVERS }, (_, k) => k + 1).flatMap((k) => {
              const h = photoH * (1 - k / (SLIVERS + 2));
              const out = [];
              const l = frames[frameIndex - k];
              const r = frames[frameIndex + k];
              if (l)
                out.push(
                  <Sliver key={`l${k}`} item={l} status={statusOf(l.id)} style={{ left: cx - photoW / 2 - k * step, top: midY - h / 2, width: step + 1, height: h, zIndex: 20 - k }} onClick={() => onFrame(frameIndex - k)} />,
                );
              if (r)
                out.push(
                  <Sliver key={`r${k}`} item={r} status={statusOf(r.id)} style={{ left: cx + photoW / 2 + (k - 1) * step - 1, top: midY - h / 2, width: step + 1, height: h, zIndex: 20 - k }} onClick={() => onFrame(frameIndex + k)} />,
                );
              return out;
            })}

          <div className="crest-head" style={{ left: cx - photoW / 2, width: photoW, top: photoTop - HEAD_H + 6 }}>
            <div className="crest-title">
              <span className="eyebrow">{burstLabel(focused)}</span>
              {current.folder && (
                <span className="folder-path" title={current.folder}>
                  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                    <path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.5 1.6h5.9a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
                  </svg>
                  {current.folder.split('/').join(' / ')}
                </span>
              )}
            </div>
            <h2>
              {clockTime(focused.start)}
              {focused.kind === 'photo' && n > 1 && <span className="muted"> · {seconds(focused.end - focused.start)}</span>}
            </h2>
          </div>

          <div
            className={`crest${statusOf(current.id) === 'keep' ? ' kept' : ''}${statusOf(current.id) === 'archived' ? ' archived' : ''}`}
            style={{ left: cx - photoW / 2, top: photoTop, width: photoW, height: photoH }}
            onPointerDown={focused.kind === 'photo' ? seekStart : undefined}
            onPointerMove={seekMove}
            onPointerUp={seekEnd}
            onPointerCancel={seekEnd}
          >
            {focused.kind === 'video' ? (
              <VideoView item={current} />
            ) : (
              <>
                <ThumbBackdrop item={current} />
                <PreviewCanvas item={current} width={photoW} height={photoH} />
              </>
            )}
            {keptNow && keep.flashId === current.id && <span className="keep-flash" key={keep.flash} aria-hidden />}
            {(holding || statusOf(current.id) !== 'review') && (
              <span key={holding ? 'hold' : statusOf(current.id)} className={`pill pop ${holding || statusOf(current.id) === 'keep' ? 'pill-accent' : ''}`}>
                {holding ? 'Seeking…' : statusLabel(statusOf(current.id))}
              </span>
            )}
            {n > 1 && (
              <span className="pill pill-right">
                {frameIndex + 1} / {n}
              </span>
            )}
            {holding && (
              <div className="seekbar">
                <span>← Earlier</span>
                <strong>HOLD + SLIDE</strong>
                <span>Later →</span>
              </div>
            )}
          </div>

          {n > 1 && (
            <ScrubStrip frames={frames} index={frameIndex} statusOf={statusOf} width={Math.min(W - 48, Math.max(photoW + 160, 560))} left={cx} top={photoTop + photoH + 14} onFrame={onFrame} />
          )}
          </div>
        </>
      )}
    </div>
  );
}

const statusLabel = (s: Status) => (s === 'keep' ? '✓ Kept' : s === 'archived' ? 'Archived' : '');

// ---------------------------------------------------------------------------

const Sliver = memo(function Sliver({ item, status, style, onClick }: { item: MediaItem; status: Status; style: React.CSSProperties; onClick: () => void }) {
  const url = useThumb(item);
  return (
    <button
      className={`sliver${status === 'keep' ? ' kept' : status === 'archived' ? ' archived' : ''}`}
      style={{ ...style, backgroundImage: url ? `url(${url})` : undefined }}
      onClick={onClick}
      tabIndex={-1}
      aria-label={`Frame ${item.name}`}
    />
  );
});

function PreviewCanvas({ item, width, height }: { item: MediaItem; width: number; height: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [missing, setMissing] = useState(false);
  const shown = useRef<string | null>(null);

  useLayoutEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    shown.current = null;
  }, [width, height]);

  useLayoutEffect(() => {
    let alive = true;
    const draw = (bmp: ImageBitmap) => {
      const c = canvas.current;
      if (!c) return;
      const ctx = c.getContext('2d')!;
      const s = Math.min(c.width / bmp.width, c.height / bmp.height);
      const w = bmp.width * s;
      const h = bmp.height * s;
      try {
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(bmp, (c.width - w) / 2, (c.height - h) / 2, w, h);
        shown.current = item.id;
        setMissing(false);
      } catch {
        /* bitmap was evicted mid-draw; the next frame will redraw */
      }
    };
    const hit = peekPreview(item.id);
    if (hit) draw(hit);
    else
      // Keep the previous frame on screen until this one decodes: no flashing while scrubbing.
      loadPreview(item).then((bmp) => {
        if (!alive) return;
        if (bmp) draw(bmp);
        else setMissing(true);
      });
    return () => {
      alive = false;
    };
  }, [item, width, height]);

  return (
    <>
      <canvas ref={canvas} style={{ width, height }} />
      {missing && <div className="no-preview">No preview for {item.name}</div>}
    </>
  );
}

/** Small thumbnail under the canvas: something to show while the full preview decodes. */
function ThumbBackdrop({ item }: { item: MediaItem }) {
  const url = useThumb(item);
  return url ? <span className="thumb-backdrop" style={{ backgroundImage: `url(${url})` }} aria-hidden /> : null;
}

function VideoView({ item }: { item: MediaItem }) {
  const url = useObjectUrl(item.file);
  return url ? <video key={url} src={url} controls playsInline preload="metadata" /> : null;
}

function Neighbour({ group, label, statusOf, x, w, midY, h, onClick, side }: { group: VisibleGroup; label: string; statusOf: (id: string) => Status; x: number; w: number; midY: number; h: number; onClick: () => void; side: 'left' | 'right' }) {
  const items = group.visible;
  const cover = items.find((i) => statusOf(i.id) === 'keep') ?? items[Math.floor(items.length / 2)];
  const coverUrl = useThumb(cover);
  const coverW = Math.min(w * 0.72, h * 1.5);
  const ch = coverW / 1.5;
  const kept = group.items.filter((id) => statusOf(id) === 'keep').length;
  const shoulders = Math.min(5, Math.floor(items.length / 2));
  const st = Math.min(14, (w - coverW) / 2 / Math.max(1, shoulders));
  const coverLeft = x + (w - coverW) / 2;
  return (
    <button className={`neighbour ${side}`} style={{ left: x, width: w, top: 0, bottom: 0 }} onClick={onClick} aria-label={`Open ${label}`}>
      {Array.from({ length: shoulders }, (_, k) => {
        const hh = ch * (1 - (k + 1) / (shoulders + 2));
        return (
          <span key={k}>
            <NeighbourSliver item={items[Math.max(0, items.indexOf(cover) - k - 1)]} style={{ left: coverLeft - x - (k + 1) * st, top: midY - hh / 2, width: st + 1, height: hh }} />
            <NeighbourSliver item={items[Math.min(items.length - 1, items.indexOf(cover) + k + 1)]} style={{ left: coverLeft - x + coverW + k * st - 1, top: midY - hh / 2, width: st + 1, height: hh }} />
          </span>
        );
      })}
      <span className="n-cover" style={{ left: coverLeft - x, top: midY - ch / 2, width: coverW, height: ch, backgroundImage: coverUrl ? `url(${coverUrl})` : undefined }}>
        {group.kind === 'video' && <span className="play">▶</span>}
      </span>
      <span className="n-label" style={{ left: coverLeft - x, top: midY + ch / 2 + 16 }}>
        <span>{label} · {group.kind === 'video' ? 'video' : `${plural(group.items.length, 'photo')} · ${kept} kept`}</span>
        <span className="muted small">{clockTime(group.start)}</span>
      </span>
    </button>
  );
}

function NeighbourSliver({ item, style }: { item: MediaItem; style: React.CSSProperties }) {
  const url = useThumb(item);
  return <span className="sliver static" style={{ ...style, backgroundImage: url ? `url(${url})` : undefined }} />;
}

// ---------------------------------------------------------------------------

function ScrubStrip({ frames, index, statusOf, width, left, top, onFrame }: { frames: MediaItem[]; index: number; statusOf: (id: string) => Status; width: number; left: number; top: number; onFrame: (i: number) => void }) {
  const n = frames.length;
  const TW = 40;
  const GAP = 5;
  const usable = width - 64;
  const perPage = Math.max(3, Math.min(n, Math.floor((usable + GAP) / (TW + GAP))));
  const start = Math.max(0, Math.min(n - perPage, index - Math.floor(perPage / 2)));
  const visible = frames.slice(start, start + perPage);

  return (
    <div className="strip" style={{ left: left - width / 2, width, top }}>
      <div className="strip-row">
        <button className="ghost" onClick={() => onFrame(Math.max(0, index - perPage))} disabled={index === 0} aria-label="Earlier frames">‹</button>
        <div className="thumbs">
          {visible.map((f, i) => (
            <StripThumb key={f.id} item={f} n={start + i + 1} current={start + i === index} status={statusOf(f.id)} onClick={() => onFrame(start + i)} />
          ))}
        </div>
        <button className="ghost" onClick={() => onFrame(Math.min(n - 1, index + perPage))} disabled={index === n - 1} aria-label="Later frames">›</button>
      </div>
    </div>
  );
}

const StripThumb = memo(function StripThumb({ item, n, current, status, onClick }: { item: MediaItem; n: number; current: boolean; status: Status; onClick: () => void }) {
  const url = useThumb(item);
  return (
    <button className={`thumb${current ? ' current' : ''}${status === 'keep' ? ' kept' : status === 'archived' ? ' archived' : ''}`} onClick={onClick} title={item.name}>
      <span className="thumb-img" style={{ backgroundImage: url ? `url(${url})` : undefined }} />
      <span className="thumb-n">{String(n).padStart(2, '0')}</span>
    </button>
  );
});
