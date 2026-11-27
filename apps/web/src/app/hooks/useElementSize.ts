"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

export function useElementSize(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): ElementSize | null {
  const [size, setSize] = useState<ElementSize | null>(null);
  const observed = useRef<{
    element: HTMLElement | null;
    observer: ResizeObserver | null;
  }>({ element: null, observer: null });

  useLayoutEffect(() => {
    const element = enabled ? ref.current : null;
    const current = observed.current;
    if (current.element === element) return;
    current.observer?.disconnect();
    current.element = element;
    current.observer = null;
    if (!element) {
      if (enabled) setSize(null);
      return;
    }
    const measure = () => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      setSize((prev) =>
        prev && prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
    };
    measure();
    current.observer = new ResizeObserver(measure);
    current.observer.observe(element);
  });

  useLayoutEffect(
    () => () => {
      observed.current.observer?.disconnect();
      observed.current = { element: null, observer: null };
    },
    [],
  );

  return size;
}
