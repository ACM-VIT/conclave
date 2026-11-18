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
  }
}
