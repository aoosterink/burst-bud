import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { loadThumb, peekThumb } from './images';
import type { MediaItem } from './types';

export function useThumb(item: MediaItem | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() => (item ? peekThumb(item) ?? null : null));
  useEffect(() => {
    if (!item || item.kind === 'video') {
      setUrl(null);
      return;
    }
    const known = peekThumb(item);
    if (known !== undefined) {
      setUrl(known);
      return;
    }
    setUrl(null);
    let alive = true;
    loadThumb(item).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [item]);
  return url;
}

export function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Object URL for a file, revoked when the file changes or the component unmounts. */
export function useObjectUrl(file: File | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return setUrl(null);
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}
