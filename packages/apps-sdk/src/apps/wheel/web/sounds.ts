/**
 * Synthesized wheel sounds — no assets, one lazily created AudioContext.
 * Autoplay policies can keep the context suspended for participants who
 * haven't interacted yet; every play degrades to silence instead of throwing.
 */

const TICK_MIN_INTERVAL_MS = 34;

type AudioContextCtor = typeof AudioContext;

const getAudioContextCtor = (): AudioContextCtor | null => {
  if (typeof window === "undefined") return null;
  const scoped = window as typeof window & {
    webkitAudioContext?: AudioContextCtor;
  };
  return scoped.AudioContext ?? scoped.webkitAudioContext ?? null;
};

export class WheelSounds {
  private context: AudioContext | null = null;
  private lastTickAt = 0;

  enabled = true;

  private ensureContext(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.context) {
      const Ctor = getAudioContextCtor();
      if (!Ctor) return null;
      try {
        this.context = new Ctor();
      } catch {
        return null;
      }
    }
    if (this.context.state === "suspended") {
      void this.context.resume().catch(() => {});
    }
    return this.context.state === "running" ? this.context : null;
  }

  /** Flapper click; intensity 0..1 scales pitch and level with wheel speed. */
  tick(intensity: number): void {
    const now = performance.now();
    if (now - this.lastTickAt < TICK_MIN_INTERVAL_MS) return;
    const context = this.ensureContext();
    if (!context) return;
    this.lastTickAt = now;

    const clamped = Math.min(1, Math.max(0, intensity));
    const start = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(1350 + 650 * clamped, start);
    gain.gain.setValueAtTime(0.05 + 0.07 * clamped, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.045);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.05);
  }

  /** Soft filtered-noise whoosh as the wheel launches out of the pull-back. */
  launch(): void {
    const context = this.ensureContext();
    if (!context) return;

    const durationSeconds = 0.42;
    const sampleCount = Math.floor(context.sampleRate * durationSeconds);
    const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i += 1) {
      channel[i] = Math.random() * 2 - 1;
    }

    const start = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.setValueAtTime(1.1, start);
    filter.frequency.setValueAtTime(420, start);
    filter.frequency.exponentialRampToValueAtTime(2400, start + 0.16);
    filter.frequency.exponentialRampToValueAtTime(600, start + durationSeconds);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.07, start + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + durationSeconds);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(context.destination);
    source.start(start);
    source.stop(start + durationSeconds);
  }

  /** Short rising arpeggio when the wheel settles on a winner. */
  win(): void {
    const context = this.ensureContext();
    if (!context) return;

    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    const start = context.currentTime + 0.02;
    notes.forEach((frequency, index) => {
      const at = start + index * 0.085;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.09, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.36);
    });
  }

  dispose(): void {
    if (this.context) {
      void this.context.close().catch(() => {});
      this.context = null;
    }
  }
}
