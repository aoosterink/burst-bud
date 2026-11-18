import { describe, expect, it } from 'vitest';
import { splitParts } from '../zipPicks';

const entry = (name: string, size: number) => ({ name, file: { size } as File });

describe('splitParts', () => {
  it('keeps everything in one ZIP when it fits', () => {
    expect(splitParts([entry('a', 10), entry('b', 10)], 100)).toHaveLength(1);
  });
  it('starts a new part before going over the limit, never splitting a file', () => {
    const parts = splitParts([entry('a', 60), entry('b', 50), entry('c', 40), entry('d', 120)], 100);
    expect(parts.map((p) => p.map((e) => e.name))).toEqual([['a'], ['b', 'c'], ['d']]);
  });
});
