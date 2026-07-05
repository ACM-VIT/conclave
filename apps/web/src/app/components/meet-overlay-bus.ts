/**
 * Tiny window-event bus keeping the meeting's keyboard overlays (Mod+K quick
 * actions, Mod+/ shortcuts help) mutually exclusive without coupling their
 * components: whichever overlay opens announces itself, and every other
 * overlay closes in response.
 */
const OVERLAY_OPEN_EVENT = "conclave:meet-overlay-open";

export function announceOverlayOpen(overlayId: string): void {
  window.dispatchEvent(
    new CustomEvent(OVERLAY_OPEN_EVENT, { detail: overlayId }),
  );
}

/** Subscribes to other overlays opening; returns the unsubscribe function. */
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
