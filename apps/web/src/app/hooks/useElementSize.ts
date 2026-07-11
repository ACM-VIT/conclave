"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Live border-box LAYOUT size of an element, in whole px. Measures
 * synchronously on mount (before first paint) and tracks later changes via
 * ResizeObserver. Returns null until the ref is attached.
 *
 * Reads offsetWidth/offsetHeight — NOT getBoundingClientRect — deliberately:
 * the meeting grid FLIP-animates tiles with a transform scale during reflows,
 * and a bounding rect taken mid-glide would bake that scale into the measured
 * size (and never correct, since the layout box doesn't change again).
 * Offset sizes are transform-immune.
 */
export function useElementSize(
  ref: RefObject<HTMLElement | null>,
): ElementSize | null {
  const [size, setSize] = useState<ElementSize | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      setSize(null);
      return;
    }
    const measure = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      setSize((prev) =>
        prev && prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
