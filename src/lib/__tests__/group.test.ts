import { describe, expect, it } from 'vitest';
import { buildGroups, sortByCapture } from '../group';
import type { MediaItem } from '../types';

const item = (id: string, time: number, extra: Partial<MediaItem> = {}): MediaItem => ({
  id, name: id, folder: '', kind: 'photo', file: {} as File, time, exifTime: true, ...extra,
});

describe('buildGroups', () => {
  const shots = [item('a', 0), item('b', 100), item('c', 900), item('d', 2000), item('e', 2050)];

  it('starts a new burst when the gap is greater than the threshold', () => {
    expect(buildGroups(shots, 1000).map((g) => g.items)).toEqual([['a', 'b', 'c'], ['d', 'e']]);
  });
  it('a gap exactly equal to the threshold stays in the burst', () => {
    expect(buildGroups([item('a', 0), item('b', 1000)], 1000)).toHaveLength(1);
  });
  it('a shorter threshold splits more', () => {
    expect(buildGroups(shots, 500).map((g) => g.items)).toEqual([['a', 'b'], ['c'], ['d', 'e']]);
  });
  it('videos are never grouped and break the burst around them', () => {
    const g = buildGroups(sortByCapture([item('a', 0), item('v', 50, { kind: 'video' }), item('b', 100)]), 1000);
    expect(g.map((x) => [x.kind, x.items])).toEqual([['photo', ['a']], ['video', ['v']], ['photo', ['b']]]);
  });
  it('a folder change starts a new burst', () => {
    expect(buildGroups([item('a', 0), item('b', 10, { folder: 'cam2' })], 1000)).toHaveLength(2);
  });
  it('two cameras shooting at the same time keep their own bursts', () => {
    const shots = sortByCapture([
      item('a1', 0), item('b1', 50, { folder: 'cam2' }), item('a2', 100),
      item('b2', 150, { folder: 'cam2' }), item('a3', 200),
    ]);
    expect(buildGroups(shots, 1000).map((g) => g.items)).toEqual([['a1', 'a2', 'a3'], ['b1', 'b2']]);
  });
  it('sorts same-second frames by file name numerically', () => {
    expect(sortByCapture([item('IMG_10', 0), item('IMG_9', 0)]).map((i) => i.id)).toEqual(['IMG_9', 'IMG_10']);
  });
});
