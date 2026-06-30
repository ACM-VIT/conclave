// Shared loader for the Conclave brand Lottie shown in the meeting-entry overlay.
// The JSON is a video-to-lottie export (~6.6MB of embedded WebP frames), so we
// fetch it once at runtime, cache the promise module-wide, and reuse it for
// every overlay mount instead of bundling it or refetching on each entry.

const ANIMATION_URL = "/conclave-animation.json";

let cached: Promise<Record<string, unknown>> | null = null;

export function loadConclaveAnimation(): Promise<Record<string, unknown>> {
  if (!cached) {
    cached = fetch(ANIMATION_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`conclave animation ${res.status}`);
        return res.json() as Promise<Record<string, unknown>>;
      })
      .catch((err) => {
        // Drop the cache so a later mount can retry (offline, transient 5xx).
        cached = null;
        throw err;
      });
  }
  return cached;
}

// Warm the cache while the lobby is idle so the overlay can paint the animation
// the instant the user commits to a meeting.
export function prefetchConclaveAnimation(): void {
  void loadConclaveAnimation().catch(() => {});
}
