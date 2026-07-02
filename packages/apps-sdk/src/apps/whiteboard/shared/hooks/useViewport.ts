import { useCallback, useRef, useState, type MutableRefObject } from "react";

export type Viewport = {
  /** X translation in CSS pixels */
  translateX: number;
  /** Y translation in CSS pixels */
  translateY: number;
  /** Zoom scale factor (1 = 100%) */
  scale: number;
};

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 5;

export type ViewportControls = {
  viewport: Viewport;
  /** Convert a screen-space point to canvas-space (accounting for pan+zoom) */
  screenToCanvas: (screenX: number, screenY: number) => { x: number; y: number };
  /** Pan by a delta in screen pixels */
  panBy: (dx: number, dy: number) => void;
  /** Zoom centred on a screen-space point */
  zoomAt: (screenX: number, screenY: number, factor: number) => void;
  /** Reset to 1:1 with no pan */
  resetViewport: () => void;
  /** Pan and zoom so the given canvas-space bounds fill the viewport */
  fitBounds: (
    bounds: { x: number; y: number; width: number; height: number },
    size: { width: number; height: number }
  ) => void;
  /** Ref used to track pan drag state (internal) */
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
      // Keep the point under the cursor fixed in canvas space
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
      // Never zoom past 1:1 on fit; tiny sketches should not become billboards
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
