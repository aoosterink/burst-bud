import type { Group, MediaItem } from './types';

/** Capture order: time, then folder, then file name (bursts often share a timestamp second). */
export function sortByCapture(items: MediaItem[]): MediaItem[] {
  return [...items].sort(
    (a, b) =>
      a.time - b.time ||
      a.folder.localeCompare(b.folder) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

/**
 * Split media into bursts. Each folder is treated as its own sequence (e.g. a second
 * camera body), so two cameras firing at the same moment don't chop each other's bursts
 * apart. Within a folder, a new burst starts when the gap to the previous photo is greater
 * than `gapMs`. Videos are never grouped: each video is its own entry and ends any open
 * burst in its folder. Groups come out ordered by start time.
 */
export function buildGroups(sorted: MediaItem[], gapMs: number): Group[] {
  const groups: Group[] = [];
  const open = new Map<string, Group>(); // folder -> burst still accepting frames

  for (const item of sorted) {
    if (item.kind === 'video') {
      groups.push({ id: `v:${item.id}`, kind: 'video', items: [item.id], start: item.time, end: item.time });
      open.delete(item.folder);
      continue;
    }
    let current = open.get(item.folder);
    if (!current || item.time - current.end > gapMs) {
      current = { id: `g:${item.id}`, kind: 'photo', items: [], start: item.time, end: item.time };
      groups.push(current);
      open.set(item.folder, current);
    }
    current.items.push(item.id);
    current.end = item.time;
  }
  return groups;
}
