import { useEffect, useRef } from 'react';

/**
 * "/" opens the overlay. A quick tap leaves it open (tap again or Esc to close);
 * holding "/" past a short moment peeks, and releasing closes it.
 */
export function useShortcutsKey(open: boolean, setOpen: (o: boolean) => void) {
  const pressedAt = useRef<number | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const isTyping = (t: EventTarget | null) => !!(t as HTMLElement)?.closest?.('input, textarea, [contenteditable]');
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape' && openRef.current) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== '/') return;
      e.preventDefault();
      if (e.repeat) return;
      if (openRef.current) {
        pressedAt.current = null;
        setOpen(false);
      } else {
        pressedAt.current = performance.now();
        setOpen(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== '/' || pressedAt.current === null) return;
      const held = performance.now() - pressedAt.current;
      pressedAt.current = null;
      if (held > 350) setOpen(false); // it was a peek
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [setOpen]);
}
