const OVERLAY_OPEN_EVENT = "conclave:meet-overlay-open";

export function announceOverlayOpen(overlayId: string): void {
  window.dispatchEvent(
    new CustomEvent(OVERLAY_OPEN_EVENT, { detail: overlayId }),
  );
}

export function subscribeOtherOverlayOpen(
  ownId: string,
  onOtherOpen: () => void,
): () => void {
  const handler = (event: Event) => {
    if ((event as CustomEvent<string>).detail !== ownId) onOtherOpen();
  };
  window.addEventListener(OVERLAY_OPEN_EVENT, handler);
  return () => window.removeEventListener(OVERLAY_OPEN_EVENT, handler);
}
