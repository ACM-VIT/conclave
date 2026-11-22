/** 20 ms frames of the 24 kHz PCM the worker receives. */
export const VOICE_FRAME_SAMPLES = 480;
/** Frame RMS, after a 150 Hz high-pass, that counts as voiced: -45 dBFS. */
export const VOICE_THRESHOLD_RMS = 10 ** (-45 / 20);
/**
 * Most zero crossings a voiced frame may have: vowels cross about 20 times
 * in 20 ms, breath, hiss and broadband noise 140 to 250 times.
 */
export const VOICE_MAX_CROSSINGS = 80;
/** Voiced frames in a row before a stretch counts as speech: 60 ms, longer than a key click. */
export const VOICE_MIN_RUN_FRAMES = 3;
/**
 * How long speech counts as still going after its last voiced chunk: two of
 * the relays' 250 ms chunks, so arrival jitter never splits one stretch.
 * A longer gap means no audio was sent, so the next chunk starts afresh.
 */
export const VOICE_HANGOVER_MS = 500;

const HIGH_PASS_COEFFICIENT = 1 / (1 + (2 * Math.PI * 150) / 24_000);

/**
 * A cheap energy check over the audio sent to a provider: frame RMS after a
 * high-pass that drops hum and rumble, a zero-crossing limit that tells a
 * voiced frame from noise as loud, a run of voiced frames to start a stretch
 * of speech, and a short hangover to bridge pauses between words.
 */
export class VoiceActivity {
  private previousInput = 0;
  private previousOutput = 0;
  private frameEnergy = 0;
  private frameLength = 0;
  private frameCrossings = 0;
  private run = 0;
  private voicedUntil = Number.NEGATIVE_INFINITY;
  private lastPushAt = Number.NEGATIVE_INFINITY;

  /** Feeds one chunk; returns "onset" when it starts a stretch of speech, "speech" when it continues one. */
  push(samples: Int16Array, now: number): "onset" | "speech" | "quiet" {
    if (now - this.lastPushAt > VOICE_HANGOVER_MS) this.restart();
    this.lastPushAt = now;
    let heard = false;
    for (const sample of samples) {
      const input = sample / 32_768;
      const output = HIGH_PASS_COEFFICIENT * (this.previousOutput + input - this.previousInput);
      if (output >= 0 !== this.previousOutput >= 0) this.frameCrossings += 1;
      this.previousInput = input;
      this.previousOutput = output;
      this.frameEnergy += output * output;
      this.frameLength += 1;
      if (this.frameLength < VOICE_FRAME_SAMPLES) continue;
      const rms = Math.sqrt(this.frameEnergy / this.frameLength);
      const voiced = rms >= VOICE_THRESHOLD_RMS && this.frameCrossings <= VOICE_MAX_CROSSINGS;
      this.frameEnergy = 0;
      this.frameLength = 0;
      this.frameCrossings = 0;
      this.run = voiced ? this.run + 1 : 0;
      if (this.run >= VOICE_MIN_RUN_FRAMES) heard = true;
    }
    if (!heard) return "quiet";
    const onset = !this.speakingAt(now);
    this.voicedUntil = now + VOICE_HANGOVER_MS;
    return onset ? "onset" : "speech";
  }

  speakingAt(now: number): boolean {
    return now <= this.voicedUntil;
  }

  /** A turn ended: the next chunk starts a new run, though speech still counts as recent. */
  restart(): void {
    this.previousInput = 0;
    this.previousOutput = 0;
    this.frameEnergy = 0;
    this.frameLength = 0;
    this.frameCrossings = 0;
    this.run = 0;
  }
}
