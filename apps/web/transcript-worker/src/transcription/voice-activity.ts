export const VOICE_FRAME_SAMPLES = 480;
export const VOICE_THRESHOLD_RMS = 10 ** (-50 / 20);
export const VOICE_MAX_CROSSINGS = 80;
export const VOICE_MIN_RUN_FRAMES = 3;
export const VOICE_HANGOVER_MS = 500;

export type VoiceReading = "onset" | "speech" | "quiet";

const HIGH_PASS_COEFFICIENT = 1 / (1 + (2 * Math.PI * 150) / 24_000);

export class VoiceActivity {
  private previousInput = 0;
  private previousOutput = 0;
  private frameEnergy = 0;
  private frameLength = 0;
  private frameCrossings = 0;
  private run = 0;
  private voicedUntil = Number.NEGATIVE_INFINITY;
  private lastPushAt = Number.NEGATIVE_INFINITY;

  push(samples: Int16Array, now: number): VoiceReading {
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

  restart(): void {
    this.previousInput = 0;
    this.previousOutput = 0;
    this.frameEnergy = 0;
    this.frameLength = 0;
    this.frameCrossings = 0;
    this.run = 0;
  }
}
