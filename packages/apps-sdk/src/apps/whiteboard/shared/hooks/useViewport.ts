import { useCallback, useRef, useState, type MutableRefObject } from "react";

type Viewport = {
  translateX: number;
  translateY: number;
  scale: number;
};

const MIN_SCALE = 0.1;
const MAX_SCALE = 5;

export type ViewportControls = {
  viewport: Viewport;
  screenToCanvas: (screenX: number, screenY: number) => { x: number; y: number };
  panBy: (dx: number, dy: number) => void;
  zoomAt: (screenX: number, screenY: number, factor: number) => void;
  resetViewport: () => void;
  fitBounds: (
    bounds: { x: number; y: number; width: number; height: number },
    size: { width: number; height: number }
  ) => void;
  panStartRef: MutableRefObject<{ x: number; y: number; tx: number; ty: number } | null>;
};

const DEFAULT_VIEWPORT: Viewport = { translateX: 0, translateY: 0, scale: 1 };

export function useViewport(): ViewportControls {
  const [viewport, setViewport] = useState<Viewport>({ ...DEFAULT_VIEWPORT });
  const panStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const screenToCanvas = useCallback(
    (screenX: number, screenY: number) => ({
      x: (screenX - viewport.translateX) / viewport.scale,
      y: (screenY - viewport.translateY) / viewport.scale,
    }),
    [viewport]
  );

  const panBy = useCallback((dx: number, dy: number) => {
    setViewport((prev) => ({
      ...prev,
      translateX: prev.translateX + dx,
      translateY: prev.translateY + dy,
    }));
  }, []);

  const zoomAt = useCallback((screenX: number, screenY: number, factor: number) => {
    setViewport((prev) => {
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor));
      if (nextScale === prev.scale) return prev;
      const translateX = screenX - (screenX - prev.translateX) * (nextScale / prev.scale);
      const translateY = screenY - (screenY - prev.translateY) * (nextScale / prev.scale);
      return { translateX, translateY, scale: nextScale };
    });
  }, []);

  const resetViewport = useCallback(() => {
    setViewport({ ...DEFAULT_VIEWPORT });
  }, []);

  const fitBounds = useCallback(
    (
      bounds: { x: number; y: number; width: number; height: number },
      size: { width: number; height: number }
    ) => {
      if (size.width <= 0 || size.height <= 0) return;
      const padding = 48;
      const availableWidth = Math.max(1, size.width - padding * 2);
      const availableHeight = Math.max(1, size.height - padding * 2);
      const rawScale = Math.min(
        availableWidth / Math.max(1, bounds.width),
        availableHeight / Math.max(1, bounds.height)
      );
      const scale = Math.min(1, Math.max(MIN_SCALE, rawScale));
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      setViewport({
        scale,
        translateX: size.width / 2 - centerX * scale,
        translateY: size.height / 2 - centerY * scale,
      });
    },
    []
  );

  return { viewport, screenToCanvas, panBy, zoomAt, resetViewport, fitBounds, panStartRef };
}
