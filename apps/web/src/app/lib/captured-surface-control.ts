export type CapturedDisplaySurface = "browser" | "window" | "monitor" | string;

export type CaptureFocusBehavior =
  | "focus-captured-surface"
  | "focus-capturing-application"
  | "no-focus-change";

export interface CaptureControllerLike extends EventTarget {
  readonly zoomLevel?: number | null;
  decreaseZoomLevel?: () => Promise<void>;
  forwardWheel?: (element: Element | null) => Promise<void>;
  getSupportedZoomLevels?: () => number[];
  increaseZoomLevel?: () => Promise<void>;
  resetZoomLevel?: () => Promise<void>;
  setFocusBehavior?: (behavior: CaptureFocusBehavior) => void;
}

type CaptureControllerConstructor = new () => CaptureControllerLike;

type WindowWithCaptureController = Window &
  typeof globalThis & {
    CaptureController?: CaptureControllerConstructor;
  };

export type CapturedSurfaceControlState = {
  supported: boolean;
  available: boolean;
  displaySurface: CapturedDisplaySurface | null;
};

export const getCaptureControllerConstructor =
  (): CaptureControllerConstructor | null => {
    if (typeof window === "undefined") return null;
    return (window as WindowWithCaptureController).CaptureController ?? null;
  };

export const supportsCapturedSurfaceControl = (
  controller?: CaptureControllerLike | null,
) => {
  const prototype = (getCaptureControllerConstructor()?.prototype ??
    controller ??
    null) as Record<string, unknown> | null;
  return Boolean(
    prototype &&
      typeof prototype.forwardWheel === "function" &&
      typeof prototype.increaseZoomLevel === "function" &&
      typeof prototype.decreaseZoomLevel === "function" &&
      typeof prototype.resetZoomLevel === "function",
  );
};

export const createCaptureController = (): CaptureControllerLike | null => {
  const CaptureController = getCaptureControllerConstructor();
  if (!CaptureController) return null;

  try {
    return new CaptureController();
  } catch {
    return null;
  }
};

export const getCapturedDisplaySurface = (
  track: MediaStreamTrack | null | undefined,
): CapturedDisplaySurface | null => {
  if (!track) return null;
  const settings = track.getSettings() as MediaTrackSettings & {
    displaySurface?: CapturedDisplaySurface;
  };
  return settings.displaySurface ?? null;
};

export const createCapturedSurfaceControlState = (
  controller: CaptureControllerLike | null,
  displaySurface: CapturedDisplaySurface | null,
): CapturedSurfaceControlState => {
  const supported = supportsCapturedSurfaceControl(controller);
  return {
    supported,
    available: supported && displaySurface === "browser",
    displaySurface,
  };
};

export const getDefaultCapturedSurfaceControlState =
  (): CapturedSurfaceControlState => ({
    supported: supportsCapturedSurfaceControl(),
    available: false,
    displaySurface: null,
  });

export const readCapturedSurfaceZoomLevels = (
  controller: CaptureControllerLike | null | undefined,
) => {
  if (!controller?.getSupportedZoomLevels) return [];
  try {
    return controller.getSupportedZoomLevels();
  } catch {
    return [];
  }
};

export const readCapturedSurfaceZoomLevel = (
  controller: CaptureControllerLike | null | undefined,
) => {
  const zoomLevel = controller?.zoomLevel;
  return typeof zoomLevel === "number" && Number.isFinite(zoomLevel)
    ? zoomLevel
    : null;
};
