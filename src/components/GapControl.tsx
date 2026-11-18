import { useEffect, useState } from 'react';
import { stepGap } from '../lib/format';

interface Props {
  valueMs: number;
  onChange: (ms: number) => void;
  label?: string;
  /** Show the "gap between two photo stacks" icon. */
  icon?: boolean;
  className?: string;
}

/** Two photo stacks with a double arrow between them: the gap that splits groups. */
export function GapIcon() {
  return (
    <svg className="gap-icon" viewBox="0 0 26 16" width="26" height="16" aria-hidden="true">
      <g fill="currentColor">
        <rect x="0.5" y="4.5" width="2" height="7" rx="0.6" opacity="0.55" />
        <rect x="3.5" y="2.5" width="3.5" height="11" rx="0.8" />
        <rect x="19" y="2.5" width="3.5" height="11" rx="0.8" />
        <rect x="23.5" y="4.5" width="2" height="7" rx="0.6" opacity="0.55" />
      </g>
      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.5 8h7" />
        <path d="M11.3 6.2 9.5 8l1.8 1.8M14.7 6.2 16.5 8l-1.8 1.8" />
      </g>
    </svg>
  );
}

const fmt = (ms: number) => String(Math.round(ms) / 1000);

/** "Gap between groups": type a value in seconds, or nudge it with − / +. */
export function GapControl({ valueMs, onChange, label, icon, className = '' }: Props) {
  const [text, setText] = useState(fmt(valueMs));
  useEffect(() => setText(fmt(valueMs)), [valueMs]);

  function commit() {
    const s = Number(text.replace(',', '.'));
    if (Number.isFinite(s) && s > 0) onChange(Math.round(Math.min(600, Math.max(0.01, s)) * 1000));
    else setText(fmt(valueMs));
  }

  return (
    <div
      className={`stepper ${className}`}
      role="group"
      aria-label="Gap between groups"
      title="A new group starts when the time between two photos is longer than this"
    >
      {icon && <GapIcon />}
      {label && <span className="stepper-label">{label}</span>}
      <button type="button" onClick={() => onChange(stepGap(valueMs, -1))} aria-label="Shorter gap">−</button>
      <label className="gap-field">
        <input
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setText(fmt(valueMs));
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              onChange(stepGap(valueMs, e.key === 'ArrowUp' ? 1 : -1));
            }
          }}
          aria-label="Gap between groups in seconds"
        />
        <span>s</span>
      </label>
      <button type="button" onClick={() => onChange(stepGap(valueMs, 1))} aria-label="Longer gap">+</button>
    </div>
  );
}
