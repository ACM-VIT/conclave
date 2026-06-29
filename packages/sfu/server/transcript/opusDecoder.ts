import OpusScript from "opusscript";
import { downsamplePcm16LeTo24kMono } from "./pcm.js";

const OPUS_SAMPLE_RATE = 48000;
const OPUS_CHANNELS = 2;

export type TranscriptOpusDecoderLike = {
  decodeTo24kMono: (payload: Buffer) => Buffer | null;
  close: () => void;
};

export class TranscriptOpusDecoder implements TranscriptOpusDecoderLike {
  private readonly decoder = new OpusScript(
    OPUS_SAMPLE_RATE,
    OPUS_CHANNELS,
    OpusScript.Application.AUDIO,
  );
  private closed = false;

  decodeTo24kMono(payload: Buffer): Buffer | null {
    if (this.closed || payload.length === 0) return null;
    const decoded = this.decoder.decode(payload);
    return downsamplePcm16LeTo24kMono(decoded, OPUS_CHANNELS);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.decoder.delete();
  }
}
