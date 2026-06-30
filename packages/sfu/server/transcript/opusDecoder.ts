import OpusScript from "opusscript";
import { downsamplePcm16LeTo24kMono } from "./pcm.js";

const OPUS_SAMPLE_RATE = 48000;
const OPUS_OUTPUT_CHANNELS = 1;
const PCM16_BYTES_PER_SAMPLE = 2;
const OPUS_MAX_PACKET_BYTES = OpusScript.MAX_PACKET_SIZE;

const OPUS_ERROR_MESSAGES: Record<number, string> = {
  [-1]: "Bad argument",
  [-2]: "Buffer too small",
  [-3]: "Internal error",
  [-4]: "Invalid packet",
  [-5]: "Unimplemented",
  [-6]: "Invalid state",
  [-7]: "Memory allocation fail",
};

type OpusScriptInternal = OpusScript & {
  handler: {
    _decode: (
      inputPointer: number,
      inputLength: number,
      outputPointer: number,
    ) => number;
  };
  inOpus: Uint8Array;
  inOpusPointer: number;
  outPCM: Uint16Array;
  outPCMPointer: number;
};

export type TranscriptOpusDecoderLike = {
  decodeTo24kMono: (payload: Buffer) => Buffer | null;
  close: () => void;
};

export class TranscriptOpusDecoder implements TranscriptOpusDecoderLike {
  private decoder: OpusScriptInternal = this.createDecoder();
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

  private createDecoder(): OpusScriptInternal {
    return new OpusScript(
      OPUS_SAMPLE_RATE,
      OPUS_OUTPUT_CHANNELS,
      OpusScript.Application.AUDIO,
    ) as OpusScriptInternal;
  }

  private decodePayload(payload: Buffer): Buffer {
    if (payload.length > OPUS_MAX_PACKET_BYTES) {
      throw new Error(
        `Opus packet exceeds decoder packet limit (${payload.length} > ${OPUS_MAX_PACKET_BYTES}).`,
      );
    }

    // opusscript.decode() derives a PCM byteOffset from a Uint16Array view; after
    // WASM heap growth that can point outside the allocated output buffer.
    const decoder = this.decoder;
    decoder.inOpus.set(payload);
    const frameCount = decoder.handler._decode(
      decoder.inOpusPointer,
      payload.length,
      decoder.outPCMPointer,
    );
    if (frameCount < 0) {
      throw new Error(
        `Decode error: ${OPUS_ERROR_MESSAGES[frameCount] ?? `code ${frameCount}`}`,
      );
    }

    const byteLength =
      frameCount * OPUS_OUTPUT_CHANNELS * PCM16_BYTES_PER_SAMPLE;
    return Buffer.from(
      new Uint8Array(decoder.outPCM.buffer, decoder.outPCMPointer, byteLength),
    );
  }

  private resetDecoder(): void {
    const failedDecoder = this.decoder;
    this.decoder = this.createDecoder();
    this.disposeDecoder(failedDecoder);
  }

  private disposeDecoder(decoder: OpusScriptInternal): void {
    try {
      decoder.delete();
    } catch {}
  }
}
