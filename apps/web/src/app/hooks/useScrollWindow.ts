"use client";

import { useLayoutEffect, useState } from "react";

export interface ScrollWindow {
  first: number;
  last: number;
}

const EDGE = 1;

export function readScrollWindow(scroller: HTMLElement): ScrollWindow | null {
  if (scroller.clientWidth <= 0 || scroller.clientHeight <= 0) return null;
  const box = scroller.getBoundingClientRect();
  const left = box.left + scroller.clientLeft;
  const top = box.top + scroller.clientTop;
  const right = left + scroller.clientWidth;
  const bottom = top + scroller.clientHeight;
  const shown = Array.from(scroller.children).flatMap((child, index) => {
    const rect = child.getBoundingClientRect();
    return rect.left < right - EDGE &&
      rect.right > left + EDGE &&
      rect.top < bottom - EDGE &&
      rect.bottom > top + EDGE
      ? [index]
      : [];
  });
  return { first: shown[0] ?? -1, last: shown[shown.length - 1] ?? -1 };
}

export function useScrollWindow(scroller: HTMLElement | null, contentKey: string): ScrollWindow | null {
  const [scrollWindow, setScrollWindow] = useState<ScrollWindow | null>(null);

  useLayoutEffect(() => {
    if (!scroller) {
      setScrollWindow(null);
      return;
    }
    const measure = () => {
      const next = readScrollWindow(scroller);
      setScrollWindow((previous) =>
        previous?.first === next?.first && previous?.last === next?.last ? previous : next,
      );
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [contentKey, scroller]);

  return scrollWindow;
}
