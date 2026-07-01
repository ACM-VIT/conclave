import OpusScript from "opusscript";
import { downsamplePcm16LeTo24kMono } from "./pcm.js";

const OPUS_SAMPLE_RATE = 48000;
const OPUS_OUTPUT_CHANNELS = 1;
const OPUS_MAX_PACKET_BYTES = OpusScript.MAX_PACKET_SIZE;

export type TranscriptOpusDecoderLike = {
  decodeTo24kMono: (payload: Buffer) => Buffer | null;
  close: () => void;
};

export class TranscriptOpusDecoder implements TranscriptOpusDecoderLike {
  private decoder: OpusScript = this.createDecoder();
  private closed = false;

  decodeTo24kMono(payload: Buffer): Buffer | null {
    if (this.closed || payload.length === 0) return null;
    try {
      const decoded = this.decodePayload(payload);
      return downsamplePcm16LeTo24kMono(decoded, OPUS_OUTPUT_CHANNELS);
    } catch (error) {
      this.resetDecoder();
      try {
        const decoded = this.decodePayload(payload);
        return downsamplePcm16LeTo24kMono(decoded, OPUS_OUTPUT_CHANNELS);
      } catch {
        this.resetDecoder();
        throw error;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disposeDecoder(this.decoder);
  }

  private createDecoder(): OpusScript {
    return new OpusScript(
      OPUS_SAMPLE_RATE,
      OPUS_OUTPUT_CHANNELS,
      OpusScript.Application.AUDIO,
    );
  }

  private decodePayload(payload: Buffer): Buffer {
    if (payload.length > OPUS_MAX_PACKET_BYTES) {
      throw new Error(
        `Opus packet exceeds decoder packet limit (${payload.length} > ${OPUS_MAX_PACKET_BYTES}).`,
      );
    }

    return Buffer.from(this.decoder.decode(payload));
  }

  private resetDecoder(): void {
    const failedDecoder = this.decoder;
    this.decoder = this.createDecoder();
    this.disposeDecoder(failedDecoder);
  }

  private disposeDecoder(decoder: OpusScript): void {
    try {
      decoder.delete();
    } catch {}
  }
}
