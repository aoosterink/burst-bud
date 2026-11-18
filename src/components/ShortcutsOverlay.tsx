import { memo, useEffect, useRef, useState } from 'react';
import './ShortcutsOverlay.css';

/* ============================================================================
 * Shortcuts overlay: the list on the left, a slowed-down demo of the hovered
 * shortcut on the right, played in a miniature timeline built from the shoot's
 * own thumbnails.
 * ========================================================================== */

interface Mini {
  frame: number;
  kept: number[];
  sweep: 'none' | 'sweeping' | 'gone';
  burst: number;
  dir: 1 | -1;
  view: 'timeline' | 'grid';
  key: string | null;
  keyDown: boolean;
  pointer: { x: number; down: boolean; fingers: 1 | 2 } | null;
  pill: string | null;
  tap: number | null; // Overview cell being clicked
  toast: string | null;
  /** Just reset for a new loop: jump there without animating. */
  fresh: boolean;
}

const BASE: Mini = { frame: 3, kept: [], sweep: 'none', burst: 0, dir: 1, view: 'timeline', key: null, keyDown: false, pointer: null, pill: null, tap: null, toast: null, fresh: true };

type Step = [at: number, patch: Partial<Mini>];

/** A key press: show the cap pressed, apply the effect, release a moment later. */
const press = (at: number, key: string, effect: Partial<Mini> = {}): Step[] => [
  [at, { key, keyDown: true, ...effect }],
  [at + 260, { keyDown: false }],
];

interface Shortcut {
  id: string;
  keys: string[];
  label: string;
  hint?: string;
  start?: Partial<Mini>;
  length: number;
  steps: Step[];
}

const GROUPS: Array<{ title: string; items: Shortcut[] }> = [
  {
    title: 'Pick',
    items: [
      { id: 'keep', keys: ['Space'], label: 'Keep / unkeep this photo', hint: 'K works too', length: 3600, steps: [...press(600, 'Space', { kept: [3] }), ...press(2300, 'Space', { kept: [] })] },
      {
        id: 'archive',
        keys: ['A'],
        label: 'Archive the rest of the burst',
        hint: 'Everything not kept goes, keepers stay',
        start: { kept: [3] },
        length: 3800,
        steps: [...press(700, 'A', { sweep: 'sweeping' }), [1700, { sweep: 'gone' }]],
      },
      {
        id: 'undo',
        keys: ['⌘', 'Z'],
        label: 'Undo',
        hint: 'Every keep and archive',
        start: { kept: [3], sweep: 'gone' },
        length: 3800,
        steps: [...press(900, '⌘ Z', { sweep: 'none', toast: 'Undid: archive' }), [2900, { toast: null }]],
      },
    ],
  },
  {
    title: 'Move',
    items: [
      {
        id: 'frames',
        keys: ['←', '→'],
        label: 'Previous / next frame',
        hint: 'Hold Shift for 5 frames',
        length: 4600,
        steps: [...press(500, '→', { frame: 4 }), ...press(1100, '→', { frame: 5 }), ...press(1700, '→', { frame: 6 }), ...press(2700, '←', { frame: 5 }), ...press(3300, '←', { frame: 4 }), ...press(3900, '←', { frame: 3 })],
      },
      {
        id: 'bursts',
        keys: ['↑', '↓'],
        label: 'Previous / next burst',
        hint: '[ and ] work too',
        length: 3800,
        steps: [...press(600, '↓', { burst: 1, dir: 1 }), ...press(2200, '↑', { burst: 0, dir: -1 })],
      },
      { id: 'ends', keys: ['Home', 'End'], label: 'First / last frame', length: 3200, steps: [...press(600, 'End', { frame: 8 }), ...press(1900, 'Home', { frame: 0 })] },
      {
        id: 'seek',
        keys: ['Hold + slide', 'Swipe'],
        label: 'Seek through a burst',
        hint: 'Hold the photo and slide, or swipe with two fingers',
        length: 5200,
        steps: [
          // one finger: press and hold the photo, slide toward the edge
          [300, { pointer: { x: 0.5, down: false, fingers: 1 } }],
          [700, { pointer: { x: 0.5, down: true, fingers: 1 }, pill: 'Seeking…' }],
          [950, { pointer: { x: 0.6, down: true, fingers: 1 }, frame: 4 }],
          [1200, { pointer: { x: 0.7, down: true, fingers: 1 }, frame: 5 }],
          [1450, { pointer: { x: 0.8, down: true, fingers: 1 }, frame: 6 }],
          [1700, { pointer: { x: 0.9, down: true, fingers: 1 }, frame: 7 }],
          [2150, { pointer: { x: 0.9, down: false, fingers: 1 }, pill: null }],
          [2550, { pointer: null }],
          // two fingers on the trackpad: swipe back
          [2950, { pointer: { x: 0.72, down: true, fingers: 2 } }],
          [3300, { pointer: { x: 0.6, down: true, fingers: 2 }, frame: 6 }],
          [3650, { pointer: { x: 0.48, down: true, fingers: 2 }, frame: 5 }],
          [4000, { pointer: { x: 0.36, down: true, fingers: 2 }, frame: 4 }],
          [4500, { pointer: null }],
        ],
      },
    ],
  },
  {
    title: 'View',
    items: [
      { id: 'grid', keys: ['G'], label: 'Timeline / Overview', length: 3800, steps: [...press(700, 'G', { view: 'grid' }), ...press(2400, 'G', { view: 'timeline' })] },
      {
        id: 'esc',
        keys: ['Esc'],
        label: 'Back to the Overview',
        hint: 'After opening a photo from it',
        start: { view: 'grid' },
        length: 4200,
        steps: [[700, { tap: 5 }], [1100, { view: 'timeline', frame: 5, dir: 1, tap: null }], ...press(2700, 'Esc', { view: 'grid' })],
      },
      { id: 'help', keys: ['/'], label: 'Show these shortcuts', hint: 'Tap to open, hold to peek', length: 1, steps: [] },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.items);

/** Plays a shortcut's steps on a loop. */
function useDemo(s: Shortcut): Mini {
  const [mini, setMini] = useState<Mini>({ ...BASE, ...s.start });
  useEffect(() => {
    let timers: number[] = [];
    const run = () => {
      setMini({ ...BASE, ...s.start });
      timers = s.steps.map(([at, patch]) => window.setTimeout(() => setMini((m) => ({ ...m, ...patch, fresh: false })), at));
      if (s.steps.length) timers.push(window.setTimeout(run, s.length));
    };
    run();
    return () => timers.forEach(clearTimeout);
  }, [s]);
  return mini;
}

// ---------------------------------------------------------------------------

interface Props {
  onClose: () => void;
}

export function ShortcutsOverlay({ onClose }: Props) {
  const [active, setActive] = useState<Shortcut>(ALL[0]);
  const mini = useDemo(active);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <div className="sc-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sc-panel" role="dialog" aria-modal="true" aria-labelledby="sc-title" ref={panel} tabIndex={-1}>
        <header className="sc-head">
          <h2 id="sc-title">Shortcuts</h2>
          <span className="muted small">
            Hover one to see it · hold <kbd>/</kbd> to peek · <kbd>Esc</kbd> to close
          </span>
        </header>
        <div className="sc-body">
          <ul className="sc-list">
            {GROUPS.map((g) => (
              <li key={g.title}>
                <span className="sc-group">{g.title}</span>
                <ul>
                  {g.items.map((s) => (
                    <li key={s.id}>
                      <button
                        className={`sc-item${s.id === active.id ? ' on' : ''}`}
                        onMouseEnter={() => setActive(s)}
                        onFocus={() => setActive(s)}
                        onClick={() => setActive(s)}
                      >
                        <span className="sc-keys">
                          {s.keys.map((k) => (
                            <kbd key={k} className={s.id === active.id && mini.keyDown && mini.key?.split(' ').includes(k) ? 'down' : undefined}>
                              {k}
                            </kbd>
                          ))}
                        </span>
                        <span className="sc-label">
                          {s.label}
                          {s.hint && <span className="muted">{s.hint}</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className="sc-preview" aria-hidden>
            <MiniStage mini={mini} help={active.id === 'help'} showBurst={active.id === 'bursts'} />
            <p className="sc-caption">
              <strong>{active.label}</strong>
              <span className="muted">Shown slowed down</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Miniature timeline

const SLIVERS = 4;

function MiniStage({ mini, help, showBurst }: { mini: Mini; help: boolean; showBurst: boolean }) {
  const n = FRAMES;
  const frame = Math.min(mini.frame, n - 1);
  const kept = (i: number) => mini.kept.includes(i);

  return (
    <div className={`mini${mini.sweep !== 'none' ? ` sweep-${mini.sweep}` : ''}${mini.fresh ? ' fresh' : ''}`}>
      {mini.view === 'timeline' ? (
        <div className={`mini-burst ${mini.dir > 0 ? 'from-right' : 'from-left'}`} key={`b${mini.burst}`}>
          {showBurst && (
            <div className="mini-head">
              <span>BURST {String(mini.burst + 1).padStart(2, '0')}</span>
            </div>
          )}
          <div className="mini-wave">
            {Array.from({ length: SLIVERS }, (_, k) => k + 1).map((k) => (
              <span key={`l${k}`}>
                {frame - k >= 0 && <MiniTile frame={frame - k} burst={mini.burst} className={`mini-sliver left${kept(frame - k) ? ' kept' : ''}`} style={{ ['--k' as string]: k }} />}
                {frame + k < n && <MiniTile frame={frame + k} burst={mini.burst} className={`mini-sliver right${kept(frame + k) ? ' kept' : ''}`} style={{ ['--k' as string]: k }} />}
              </span>
            ))}
            <MiniTile frame={frame} burst={mini.burst} className={`mini-photo${kept(frame) ? ' kept' : ''}`}>
              {kept(frame) && <span className="mini-badge" key={`k${frame}`}>✓ Kept</span>}
              {mini.pill && <span className="mini-pill">{mini.pill}</span>}
              {mini.pointer && (
                <span className={`mini-pointer${mini.pointer.down ? ' down' : ''}${mini.pointer.fingers === 2 ? ' two' : ''}`} style={{ left: `${mini.pointer.x * 100}%` }}>
                  <i />
                  {mini.pointer.fingers === 2 && <i />}
                </span>
              )}
            </MiniTile>
          </div>
          <div className="mini-strip">
            {Array.from({ length: 9 }, (_, i) => i).map((i) => (
              <MiniTile key={i} frame={i} burst={mini.burst} className={`mini-thumb${i === frame ? ' current' : ''}${kept(i) ? ' kept' : ''}`} />
            ))}
          </div>
        </div>
      ) : (
        <div className="mini-grid">
          {Array.from({ length: 12 }, (_, i) => i).map((i) => (
            <MiniTile key={i} frame={i < 8 ? i : (i - 8) * 3} burst={i < 8 ? 0 : 1} className={`mini-cell${kept(i) ? ' kept' : ''}${mini.tap === i ? ' tapped' : ''}`} style={{ animationDelay: `${i * 40}ms` }}>
              {mini.tap === i && (
                <span className="mini-pointer down">
                  <i />
                </span>
              )}
            </MiniTile>
          ))}
        </div>
      )}

      {help && (
        <div className="mini-help">
          <kbd>/</kbd>
          <span>Opens this overlay. Hold it to peek, release to close.</span>
        </div>
      )}
      {mini.toast && <div className="mini-toast">{mini.toast}</div>}
    </div>
  );
}

/*
 * Demo frames are crops of one surf photo that pan left → right through a burst, so stepping
 * frames looks like motion. Each burst gets its own, very different tint; within a burst the
 * tint drifts slightly from frame to frame.
 */
const FRAMES = 12;
const BURST_HUE = [0, 150];

const MiniTile = memo(function MiniTile({ frame, burst, className, style, children }: { frame: number; burst: number; className: string; style?: React.CSSProperties; children?: React.ReactNode }) {
  const f = Math.max(0, Math.min(FRAMES - 1, frame));
  const hue = BURST_HUE[burst % BURST_HUE.length] + f * 3;
  return (
    <span
      className={`${className} demo-frame`}
      style={{
        ...style,
        ['--pos' as string]: `${(f / (FRAMES - 1)) * 100}% 62%`,
        ['--hue' as string]: `${hue}deg`,
        ['--sat' as string]: 1.05 + f * 0.015,
      }}
    >
      {children}
    </span>
  );
});
