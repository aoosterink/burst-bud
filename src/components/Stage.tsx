import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { aspectOf, loadFull, loadPreview, loadThumb, naturalSizeOf, peekFull, peekPreview, prefetchAround, setPreviewWidth } from '../lib/images';
import { useElementSize, useObjectUrl, useThumb } from '../lib/hooks';
import type { VisibleGroup } from '../lib/store';
import type { MediaItem, Status } from '../lib/types';
import { clockTime, seconds } from '../lib/format';

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
  /** Keep / Archive buttons, shown inside the photo. */
  actions?: ReactNode;
  /** Z and Esc are handled here (zoom); false while a dialog or overlay has the keyboard. */
  keysEnabled?: boolean;
  onZoomChange?: (zoomed: boolean) => void;
}

const SLIVERS = 9;

/** Zoom relative to "fit" (z = 1), centred on x / y (0–1 across the photo). */
export type Zoom = { z: number; x: number; y: number };

export function Stage({ groups, focused, frameIndex, burstLabel, statusOf, onFrame, onFocus, onHoldChange, sweeping = false, viewKey = '', actions, keysEnabled = true, onZoomChange }: Props) {
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
  // A new burst starts at fit: zoom stays only while you step through the same burst.
  const [zoom, setZoom] = useState<Zoom | null>(null);
  if (nav.id !== focused.id) {
    setNav({ id: focused.id, gi, dir: gi > nav.gi ? 1 : -1 });
    if (zoom) setZoom(null);
  }
  const enterClass = nav.dir > 0 ? 'from-right' : nav.dir < 0 ? 'from-left' : 'fade-in';

  // Brief ring when the current photo becomes kept (not when you scrub onto a kept one).
  const keptNow = statusOf(current.id) === 'keep';
  const [keep, setKeep] = useState({ id: current.id, kept: keptNow, flash: 0, flashId: '' });
  if (keep.id !== current.id) setKeep({ id: current.id, kept: keptNow, flash: keep.flash, flashId: '' });
  else if (keep.kept !== keptNow) setKeep({ ...keep, kept: keptNow, flash: keep.flash + (keptNow ? 1 : 0), flashId: keptNow ? current.id : '' });

  // Geometry --------------------------------------------------------------
  // The frame takes the photo's own shape (portrait photos get a tall frame). Until a
  // photo's shape is known, keep the last one so the frame doesn't jump while scrubbing.
  const [lastAspect, setLastAspect] = useState(() => aspectOf(current.id) ?? 1.5);
  const aspect = Math.max(0.4, Math.min(3, aspectOf(current.id) ?? lastAspect));
  const STRIP_H = n > 1 ? 56 : 0;
  const HEAD_H = 52;
  // Enough room either side for the frame slivers and the neighbouring bursts.
  const minSide = Math.max(130, Math.min(300, W * 0.12));
  const photoH = Math.max(160, Math.min(H - STRIP_H - HEAD_H - 20, (W - 2 * minSide) / aspect));
  const photoW = photoH * aspect;
  const cx = W / 2;
  const photoTop = HEAD_H + Math.max(0, (H - STRIP_H - HEAD_H - photoH) / 2);
  const midY = photoTop + photoH / 2;
  const side = Math.max(0, (W - photoW) / 2);
  const neighbourW = Math.min(side * 0.55, 280);
  const step = Math.max(6, Math.min(34, (side - neighbourW) / (SLIVERS + 1)));
  // A narrow (portrait) frame still gets a readable header.
  const headW = Math.min(W - 24, Math.max(photoW, 460));

  // Zoom ------------------------------------------------------------------
  const zoomable = focused.kind === 'photo';
  const natural = naturalSizeOf(current.id);
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  /** Zoom at which one photo pixel is one screen pixel (pixel-peeping). */
  const oneToOne = natural ? Math.max(1.5, natural.w / (photoW * dpr)) : null;
  const maxZoom = Math.max(4, (oneToOne ?? 2) * 2);
  const [zoomBusy, setZoomBusy] = useState(false);

  /** Keep the photo covering the frame: no panning past its edges. */
  const clampView = (v: Zoom): Zoom | null => {
    if (v.z <= 1.001) return null;
    const z = Math.min(maxZoom, v.z);
    const hx = 1 / (2 * z);
    return { z, x: Math.max(hx, Math.min(1 - hx, v.x)), y: Math.max(hx, Math.min(1 - hx, v.y)) };
  };
  /** Zoom to z, keeping the photo point under (px, py) (CSS px inside the frame) where it is. */
  const zoomAround = (from: Zoom | null, z: number, px: number, py: number): Zoom | null => {
    const f = from ?? { z: 1, x: 0.5, y: 0.5 };
    const nx = f.x + (px - photoW / 2) / (photoW * f.z);
    const ny = f.y + (py - photoH / 2) / (photoH * f.z);
    return clampView({ z, x: nx - (px - photoW / 2) / (photoW * z), y: ny - (py - photoH / 2) / (photoH * z) });
  };

  const zoomRef = useRef({ zoom, zoomAround, clampView, photoW, photoH, zoomable, current });
  useEffect(() => {
    zoomRef.current = { zoom, zoomAround, clampView, photoW, photoH, zoomable, current };
  });

  /** Z / double-click: fit ↔ 1:1 around a point (the frame's centre when none is given). */
  const toggleZoom = (px = photoW / 2, py = photoH / 2) => {
    if (!zoomable) return;
    if (zoom) return setZoom(null);
    const item = current;
    const go = () => {
      const r = zoomRef.current;
      if (r.current.id !== item.id) return;
      const nat = naturalSizeOf(item.id);
      const z = nat ? Math.max(1.5, nat.w / (r.photoW * dpr)) : 2;
      setZoom(r.zoomAround(null, z, px, py));
    };
    if (natural) return go();
    // The 1:1 level depends on the full-size decode; it takes a moment the first time.
    setZoomBusy(true);
    loadFull(item).then(() => {
      setZoomBusy(false);
      go();
    });
  };

  useEffect(() => onZoomChange?.(!!zoom), [zoom, onZoomChange]);

  // Z toggles zoom, Esc leaves it.
  const toggleRef = useRef(toggleZoom);
  useEffect(() => {
    toggleRef.current = toggleZoom;
  });
  useEffect(() => {
    if (!keysEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest('input, textarea, video, dialog')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'z' || e.key === 'Z') toggleRef.current();
      else if (e.key === 'Escape' && zoomRef.current.zoom) setZoom(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keysEnabled]);

  // While zoomed, decode the neighbouring frames at full size too, so stepping stays sharp.
  useEffect(() => {
    if (!zoom || !zoomable) return;
    for (const it of [frames[frameIndex + 1], frames[frameIndex - 1]]) if (it) loadFull(it);
    loadFull(current);
  }, [zoom, zoomable, frames, frameIndex, current]);

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
  const pan = useRef<{ x0: number; y0: number; v: Zoom } | null>(null);
  const [panning, setPanning] = useState(false);

  function pointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || !zoomable) return;
    if (zoom) {
      pan.current = { x0: e.clientX, y0: e.clientY, v: zoom };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setPanning(true);
      return;
    }
    seekStart(e);
  }
  function pointerMove(e: React.PointerEvent) {
    const p = pan.current;
    if (p) {
      const v = clampView({ z: p.v.z, x: p.v.x - (e.clientX - p.x0) / (photoW * p.v.z), y: p.v.y - (e.clientY - p.y0) / (photoH * p.v.z) });
      setZoom(v);
      return;
    }
    seekMove(e);
  }
  function pointerUp() {
    if (pan.current) {
      pan.current = null;
      setPanning(false);
      return;
    }
    seekEnd();
  }

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
      const zr = zoomRef.current;
      const crest = el.querySelector('.crest');
      const overPhoto = crest && (e.target as Node) instanceof Node && crest.contains(e.target as Node);
      // Pinch (or ⌘ / Ctrl + scroll) over the photo zooms around the pointer.
      if ((e.ctrlKey || e.metaKey) && zr.zoomable && overPhoto) {
        const r = crest.getBoundingClientRect();
        const from = zr.zoom;
        const z = (from?.z ?? 1) * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
        setZoom(zr.zoomAround(from, z, e.clientX - r.left, e.clientY - r.top));
        return;
      }
      // Zoomed in: scrolling pans the photo.
      if (zr.zoom) {
        const v = zr.zoom;
        setZoom(zr.clampView({ z: v.z, x: v.x + e.deltaX / (zr.photoW * v.z), y: v.y + e.deltaY / (zr.photoH * v.z) }));
        return;
      }
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
    <div className={`stage${holding ? ' holding' : ''}${sweeping ? ' sweeping' : ''}${zoom ? ' zoomed' : ''}${panning ? ' panning' : ''}`} ref={ref}>
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

          <div className="crest-head" style={{ left: cx - headW / 2, width: headW, top: photoTop - HEAD_H + 2 }}>
            <div className="crest-meta">
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
            <CopyName name={current.name} path={current.id} raw={!!current.raw} />
          </div>

          <div
            className={`crest${statusOf(current.id) === 'keep' ? ' kept' : ''}${statusOf(current.id) === 'archived' ? ' archived' : ''}`}
            style={{ left: cx - photoW / 2, top: photoTop, width: photoW, height: photoH }}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
            onDoubleClick={(e) => {
              if (!zoomable || (e.target as HTMLElement).closest('.crest-actions')) return;
              const r = e.currentTarget.getBoundingClientRect();
              toggleZoom(e.clientX - r.left, e.clientY - r.top);
            }}
          >
            {focused.kind === 'video' ? (
              <VideoView item={current} />
            ) : (
              <>
                <ThumbBackdrop item={current} />
                <PreviewCanvas item={current} width={photoW} height={photoH} view={zoom} onAspect={setLastAspect} />
              </>
            )}
            {keptNow && keep.flashId === current.id && <span className="keep-flash" key={keep.flash} aria-hidden />}
            {(holding || statusOf(current.id) !== 'review') && (
              <span key={holding ? 'hold' : statusOf(current.id)} className={`pill pop ${holding || statusOf(current.id) === 'keep' ? 'pill-accent' : ''}`}>
                {holding ? 'Seeking…' : statusLabel(statusOf(current.id))}
              </span>
            )}
            <span className="pills-right">
              {(zoom || zoomBusy) && (
                <button
                  className="pill pill-zoom"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setZoom(null)}
                  title="Back to the whole photo (Z or Esc)"
                >
                  {zoomBusy ? 'Zooming…' : natural ? `${Math.round((zoom!.z / (natural.w / (photoW * dpr))) * 100)}%` : `${zoom!.z.toFixed(1)}×`}
                  <span className="pill-x" aria-hidden>Fit</span>
                </button>
              )}
              {n > 1 && (
                <span className="pill">
                  {frameIndex + 1} / {n}
                </span>
              )}
            </span>
            {actions && !holding && (
              <div className={`crest-actions${focused.kind === 'video' ? ' over-video' : ''}`} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                {actions}
              </div>
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

/** The file name: one click copies it (e.g. to find the photo in Lightroom or Finder). */
function CopyName({ name, path, raw }: { name: string; path: string; raw: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(name);
    } catch {
      return;
    }
    setCopied(name);
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 1400);
  };
  const done = copied === name;
  return (
    <button className={`crest-file${done ? ' copied' : ''}`} onClick={copy} title={`${path} · click to copy the file name`} aria-label={`Copy file name ${name}`}>
      <span className="crest-file-name">{done ? 'Copied' : name}</span>
      {raw && !done && <i>RAW</i>}
      <span className="sr-only" role="status">{done ? 'File name copied' : ''}</span>
    </button>
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

function PreviewCanvas({ item, width, height, view, onAspect }: { item: MediaItem; width: number; height: number; view: Zoom | null; onAspect: (a: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [missing, setMissing] = useState(false);
  /** What's painted now: a full-size bitmap is never replaced by a smaller preview. */
  const painted = useRef<{ id: string; full: boolean } | null>(null);

  useLayoutEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    painted.current = null;
  }, [width, height]);

  useLayoutEffect(() => {
    let alive = true;
    const paint = (bmp: ImageBitmap, full: boolean) => {
      const c = canvas.current;
      if (!c) return;
      const p = painted.current;
      if (!full && p?.id === item.id && p.full && view) return;
      const ctx = c.getContext('2d')!;
      const a = bmp.width / bmp.height;
      // Fit inside the frame, then zoom around the view centre.
      const fw = Math.min(c.width, c.height * a);
      const fh = fw / a;
      const z = view?.z ?? 1;
      const zw = fw * z;
      const zh = fh * z;
      try {
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(bmp, c.width / 2 - (view?.x ?? 0.5) * zw, c.height / 2 - (view?.y ?? 0.5) * zh, zw, zh);
        painted.current = { id: item.id, full };
        setMissing(false);
        onAspect(a);
      } catch {
        /* bitmap was evicted mid-draw; the next frame will redraw */
      }
    };
    const full = view ? peekFull(item.id) : undefined;
    const prev = peekPreview(item.id);
    if (full) paint(full, true);
    else if (prev) paint(prev, false);
    else
      // Keep the previous frame on screen until this one decodes: no flashing while scrubbing.
      loadPreview(item).then((bmp) => {
        if (!alive) return;
        if (bmp) paint(bmp, false);
        else setMissing(true);
      });
    // Zoomed in: swap in the full-size decode when it's ready.
    if (view && !full)
      loadFull(item).then((bmp) => {
        if (alive && bmp) paint(bmp, true);
      });
    return () => {
      alive = false;
    };
  }, [item, width, height, view, onAspect]);

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
        <span>{label}</span>
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
