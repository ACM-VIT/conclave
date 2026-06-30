// One-shot "lock" sound for the meeting-entry takeover. A single reused
// <audio> element so retries can replay it; playback is best-effort (browsers
// may block it without a recent user gesture — the entry overlay is opened by a
// click, so it's within the activation window and plays).

// Bump the version when the asset changes so the browser refetches it instead
// of replaying a cached copy.
const SOUND_URL = "/conclave-lock.mp3?v=2";

let element: HTMLAudioElement | null = null;

function getElement(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!element) {
    element = new Audio(SOUND_URL);
    element.preload = "auto";
    element.volume = 0.55;
  }
  return element;
}

// Warm the file (and decode) while the lobby is idle so the click feels instant.
export function prefetchConclaveLock(): void {
  getElement();
}

export function playConclaveLock(): void {
  const audio = getElement();
  if (!audio) return;
  try {
    audio.currentTime = 0;
    void audio.play().catch(() => {});
  } catch {
    // Ignore — sound is a nice-to-have, never block the flow on it.
  }
}
