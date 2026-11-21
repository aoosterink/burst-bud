import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { buildGroups } from './group';
import type { Filter, Group, MediaItem, Status } from './types';

export interface Shoot {
  rootName: string;
  items: MediaItem[]; // sorted by capture time
  byId: Map<string, MediaItem>;
  subfolders: number;
}

interface UndoEntry {
  label: string;
  changes: Array<[string, Status]>; // id -> previous status
  /** The photo on screen when the action happened; undo brings you back to it. */
  focusItem?: string;
}

interface State {
  status: Record<string, Status>;
  gapMs: number;
  filter: Filter;
  focusGroupId: string | null;
  /** Remembered position (item id) per group. */
  cursor: Record<string, string>;
  undo: UndoEntry[];
  toast: { id: number; text: string; undoable: boolean } | null;
}

type Action =
  | { type: 'load'; saved: Saved }
  | { type: 'setStatus'; ids: string[]; to: Status; label: string; toast?: string; focusItem?: string }
  | { type: 'undo' }
  | { type: 'gap'; gapMs: number }
  | { type: 'filter'; filter: Filter }
  | { type: 'focus'; groupId: string | null }
  | { type: 'cursor'; groupId: string; itemId: string }
  | { type: 'dismissToast' }
  | { type: 'notice'; text: string };

const initial: State = {
  status: {},
  gapMs: 1000,
  filter: 'active',
  focusGroupId: null,
  cursor: {},
  undo: [],
  toast: null,
};

let toastSeq = 0;

function reducer(state: State, a: Action): State {
  switch (a.type) {
    case 'load':
      return { ...initial, ...a.saved };
    case 'setStatus': {
      const changes: Array<[string, Status]> = [];
      const status = { ...state.status };
      for (const id of a.ids) {
        const prev = status[id] ?? 'review';
        if (prev === a.to) continue;
        changes.push([id, prev]);
        if (a.to === 'review') delete status[id];
        else status[id] = a.to;
      }
      if (!changes.length) return state;
      return {
        ...state,
        status,
        undo: [...state.undo.slice(-49), { label: a.label, changes, focusItem: a.focusItem }],
        toast: a.toast ? { id: ++toastSeq, text: a.toast, undoable: true } : state.toast,
      };
    }
    case 'undo': {
      const last = state.undo[state.undo.length - 1];
      if (!last) return state;
      const status = { ...state.status };
      for (const [id, prev] of last.changes) {
        if (prev === 'review') delete status[id];
        else status[id] = prev;
      }
      return {
        ...state,
        status,
        undo: state.undo.slice(0, -1),
        toast: { id: ++toastSeq, text: `Undid: ${last.label}`, undoable: false },
      };
    }
    case 'gap':
      return { ...state, gapMs: a.gapMs };
    case 'filter':
      return { ...state, filter: a.filter };
    case 'focus':
      return { ...state, focusGroupId: a.groupId };
    case 'cursor':
      return { ...state, cursor: { ...state.cursor, [a.groupId]: a.itemId } };
    case 'dismissToast':
      return { ...state, toast: null };
    case 'notice':
      return { ...state, toast: { id: ++toastSeq, text: a.text, undoable: false } };
  }
}

const storageKey = (s: Shoot) => `burst:v1:${s.rootName}:${s.items.length}`;

type Saved = Pick<State, 'status' | 'gapMs' | 'focusGroupId' | 'cursor' | 'undo'>;

function readSaved(shoot: Shoot): Saved {
  const empty: Saved = { status: {}, gapMs: 1000, focusGroupId: null, cursor: {}, undo: [] };
  try {
    const raw = localStorage.getItem(storageKey(shoot));
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    const status: Record<string, Status> = {};
    for (const [id, st] of Object.entries(parsed.status ?? {})) {
      if (shoot.byId.has(id) && (st === 'keep' || st === 'archived')) status[id] = st;
    }
    return {
      status,
      gapMs: typeof parsed.gapMs === 'number' ? parsed.gapMs : 1000,
      focusGroupId: typeof parsed.focusGroupId === 'string' ? parsed.focusGroupId : null,
      cursor: parsed.cursor && typeof parsed.cursor === 'object' ? parsed.cursor : {},
      undo: Array.isArray(parsed.undo) ? parsed.undo : [],
    };
  } catch {
    return empty;
  }
}

export const visibleUnder = (filter: Filter, st: Status) => (filter === 'kept' ? st === 'keep' : st !== 'archived');

export interface VisibleGroup extends Group {
  index: number; // position among all groups (stable numbering)
  visible: MediaItem[];
}

export function useReview(shoot: Shoot | null, initialGapMs?: number) {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    if (!shoot) return;
    const saved = readSaved(shoot);
    dispatch({ type: 'load', saved: { ...saved, gapMs: initialGapMs ?? saved.gapMs } });
  }, [shoot, initialGapMs]);

  // Save (debounced: scrubbing changes the cursor every frame). Never save the pre-load
  // initial state, or it would overwrite what's stored before it is read back.
  useEffect(() => {
    if (!shoot || state === initial) return;
    const save = () => {
      try {
        const { status, gapMs, focusGroupId, cursor, undo } = state;
        localStorage.setItem(storageKey(shoot), JSON.stringify({ status, gapMs, focusGroupId, cursor, undo }));
      } catch {
        /* storage unavailable or full: labels just won't survive a reload */
      }
    };
    const t = setTimeout(save, 250);
    window.addEventListener('pagehide', save);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pagehide', save);
    };
  }, [shoot, state]);

  const statusOf = useCallback((id: string): Status => state.status[id] ?? 'review', [state.status]);

  const groups = useMemo(() => (shoot ? buildGroups(shoot.items, state.gapMs) : []), [shoot, state.gapMs]);

  const visibleGroups: VisibleGroup[] = useMemo(() => {
    if (!shoot) return [];
    const out: VisibleGroup[] = [];
    groups.forEach((g, index) => {
      const visible = g.items
        .filter((id) => visibleUnder(state.filter, statusOf(id)))
        .map((id) => shoot.byId.get(id)!);
      if (visible.length) out.push({ ...g, index, visible });
    });
    return out;
  }, [shoot, groups, state.filter, statusOf]);

  const counts = useMemo(() => {
    const c = { review: 0, keep: 0, archived: 0, photos: 0, videos: 0 };
    for (const it of shoot?.items ?? []) {
      c[statusOf(it.id)]++;
      if (it.kind === 'photo') c.photos++;
      else c.videos++;
    }
    return c;
  }, [shoot, statusOf]);

  // Keep focus on a group that is still visible. When the focused group disappears
  // (filtered out, archived, or re-split by a new gap), move to the nearest one by time.
  const focused = useMemo(() => {
    if (!visibleGroups.length) return null;
    const hit = visibleGroups.find((g) => g.id === state.focusGroupId);
    if (hit) return hit;
    if (shoot && state.focusGroupId) {
      // The focus id is the first item of the old group; find the group containing it now.
      const anchorId = state.focusGroupId.slice(2);
      const anchor = shoot.byId.get(anchorId);
      if (anchor) {
        const containing = visibleGroups.find((g) => g.items.includes(anchorId));
        if (containing) return containing;
        return visibleGroups.find((g) => g.end >= anchor.time) ?? visibleGroups[visibleGroups.length - 1];
      }
    }
    return visibleGroups[0];
  }, [visibleGroups, state.focusGroupId, shoot]);

  const frameIndex = useMemo(() => {
    if (!focused) return 0;
    const cur = state.cursor[focused.id];
    const i = cur ? focused.visible.findIndex((it) => it.id === cur) : -1;
    if (i >= 0) return i;
    if (cur && shoot) {
      // Remembered frame got hidden: land on the nearest visible frame by time.
      const t = shoot.byId.get(cur)?.time ?? 0;
      const j = focused.visible.findIndex((it) => it.time >= t);
      return j === -1 ? focused.visible.length - 1 : j;
    }
    return 0;
  }, [focused, state.cursor, shoot]);

  return { state, dispatch, groups, visibleGroups, focused, frameIndex, counts, statusOf };
}
