import { describe, expect, it } from 'vitest';
import { planSave } from '../savePicks';
import type { MediaItem } from '../types';

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);
const item = (name: string, folder: string, raw?: string): MediaItem => ({
  id: `${folder}/${name}`, name, folder, kind: 'photo', file: file(name), raw: raw ? file(raw, 30) : undefined, time: 0, exifTime: true,
});

describe('planSave', () => {
  it('copies RAW twins only when asked', () => {
    const items = [item('IMG_1.JPG', 'A', 'IMG_1.CR2'), item('IMG_2.JPG', 'A')];
    expect(planSave(items, true).map((e) => e.name)).toEqual(['IMG_1.JPG', 'IMG_1.CR2', 'IMG_2.JPG']);
    expect(planSave(items, false).map((e) => e.name)).toEqual(['IMG_1.JPG', 'IMG_2.JPG']);
  });
  it('prefixes clashing names with their folder instead of overwriting', () => {
    const items = [item('IMG_1.JPG', 'Cam A'), item('IMG_1.JPG', 'Cam B/Card 2'), item('img_1.jpg', '')];
    expect(planSave(items, true).map((e) => e.name)).toEqual(['IMG_1.JPG', 'Cam B - Card 2 - IMG_1.JPG', 'root - img_1.jpg']);
  });
});
