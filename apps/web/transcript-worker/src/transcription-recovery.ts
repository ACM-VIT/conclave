import type {
  TranscriptSpeaker,
} from "@conclave/meeting-core/transcript-types";
import {
  TRANSCRIPTION_RECOVERY_DELAYS_MS,
  TRANSCRIPTION_RECOVERY_MAX_AUDIO_AGE_MS,
  TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES,
  TRANSCRIPTION_RECOVERY_MAX_EVENTS,
} from "./constants";
import { isSameTranscriptAudioSpeaker } from "./audio-speaker";

export type BufferedTranscriptAudioEvent =
  | {
      type: "chunk";
      audio: string;
      speaker: TranscriptSpeaker;
      sampleCount: number;
      createdAt: number;
    }
  | {
      type: "commit";
      speaker: TranscriptSpeaker;
      createdAt: number;
      /** The line this audio belongs to, so the replacement's ack claims that line. */
      owner?: string;
    }
  | {
      type: "clear";
      speaker: TranscriptSpeaker;
      createdAt: number;
    };

export type ReplayBatch = {
  /** The line whose audio this is; ending that line drops it. */
  owner: string | null;
  sequence: number;
  speaker: TranscriptSpeaker;
  chunks: Array<{
    audio: string;
    sampleCount: number;
    createdAt: number;
  }>;
  createdAt: number;
  committedAt: number;
  bytes: number;
};

const eventBytes = (event: BufferedTranscriptAudioEvent): number =>
  event.type === "chunk" ? event.audio.length : 0;

export const isRetryableTranscriptionFailure = (message: string): boolean => {
  if (
    /invalid (?:api )?key|unauthori[sz]ed|forbidden|authentication|permission denied|\b(?:400|401|403|404|422)\b/i.test(
      message,
    )
  ) {
    return false;
  }
  return /disconnect|connection|network|socket|stream failed|timed? out|timeout|temporar|unavailable|try again|rate limit|too many requests|maximum duration|session expired|\b429\b|\b5\d\d\b/i.test(
    message,
  );
};

export const transcriptionRecoveryDelayMs = (attempt: number): number =>
  TRANSCRIPTION_RECOVERY_DELAYS_MS[
    Math.min(
      Math.max(0, Math.floor(attempt)),
      TRANSCRIPTION_RECOVERY_DELAYS_MS.length - 1,
    )
  ] ?? 0;

export class TranscriptRecoveryAudioBuffer {
  private events: BufferedTranscriptAudioEvent[] = [];
  private bytes = 0;
  private droppedEvents = 0;

  enqueue(event: BufferedTranscriptAudioEvent, now = Date.now()): void {
    this.events.push(event);
    this.bytes += eventBytes(event);
    this.prune(now);
  }

  enqueueMany(events: BufferedTranscriptAudioEvent[], now = Date.now()): void {
    for (const event of events) {
      this.events.push(event);
      this.bytes += eventBytes(event);
    }
    this.prune(now);
  }

  drain(): BufferedTranscriptAudioEvent[] {
    const events = this.events;
    this.events = [];
    this.bytes = 0;
    return events;
  }

  reset(): void {
    this.events = [];
    this.bytes = 0;
    this.droppedEvents = 0;
  }

  consumeDroppedEventCount(): number {
    const count = this.droppedEvents;
    this.droppedEvents = 0;
    return count;
  }

  private prune(now: number): void {
    const cutoff = now - TRANSCRIPTION_RECOVERY_MAX_AUDIO_AGE_MS;
    while (
      this.events.length > 0 &&
      (this.events.length > TRANSCRIPTION_RECOVERY_MAX_EVENTS ||
        this.bytes > TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES ||
        (this.events[0]?.createdAt ?? now) < cutoff)
    ) {
      const removed = this.events.shift();
      if (!removed) break;
      this.bytes -= eventBytes(removed);
      this.droppedEvents += 1;
    }
  }
}

export class TranscriptAudioReplayJournal {
  private current:
    | Omit<ReplayBatch, "sequence" | "committedAt" | "owner">
    | null = null;
  private batches: ReplayBatch[] = [];
  private nextSequence = 0;
  private bytes = 0;

  append(
    audio: string,
    speaker: TranscriptSpeaker,
    sampleCount: number,
    now = Date.now(),
  ): void {
    if (
      !this.current ||
      !isSameTranscriptAudioSpeaker(this.current.speaker, speaker)
    ) {
      this.current = {
        speaker,
        chunks: [],
        createdAt: now,
        bytes: 0,
      };
    }
    this.current.chunks.push({ audio, sampleCount, createdAt: now });
    this.current.bytes += audio.length;
    this.bytes += audio.length;
    this.prune(now);
  }

  commit(
    speaker: TranscriptSpeaker,
    now = Date.now(),
    owner: string | null = null,
  ): ReplayBatch | null {
    if (
      !this.current ||
      !isSameTranscriptAudioSpeaker(this.current.speaker, speaker) ||
      this.current.chunks.length === 0
    ) {
      return null;
    }
    const batch: ReplayBatch = {
      ...this.current,
      owner,
      sequence: this.nextSequence,
      committedAt: now,
    };
    this.nextSequence += 1;
    this.current = null;
    this.batches.push(batch);
    this.prune(now);
    return batch;
  }

  /** Drops one line's audio once that line has ended; every other line keeps its own. */
  release(batches: readonly ReplayBatch[]): void {
    for (const batch of batches) this.removeBatch(batch);
  }

  takeRecoveryEvents(
    now = Date.now(),
    currentOwner: string | null = null,
  ): BufferedTranscriptAudioEvent[] {
    const batches = [...this.batches];
    if (this.current?.chunks.length) {
      batches.push({
        ...this.current,
        owner: currentOwner,
        sequence: this.nextSequence,
        committedAt: now,
      });
    }
    batches.sort((left, right) => left.sequence - right.sequence);
    // Each line's audio is replayed as a turn of its own, so a provider that
    // segments by turn answers it apart from the audio around it.
    const events = batches.flatMap<BufferedTranscriptAudioEvent>((batch, index) => [
      ...batch.chunks.map<BufferedTranscriptAudioEvent>((chunk) => ({
        type: "chunk",
        audio: chunk.audio,
        speaker: batch.speaker,
        sampleCount: chunk.sampleCount,
        createdAt: chunk.createdAt,
      })),
      {
        type: "commit",
        speaker: batch.speaker,
        createdAt: batch.committedAt,
        ...(batch.owner ? { owner: batch.owner } : {}),
      },
      ...(batches[index + 1]?.owner === batch.owner && batch.owner !== null
        ? []
        : [{ type: "clear" as const, speaker: batch.speaker, createdAt: batch.committedAt }]),
    ]);
    this.reset();
    return events;
  }

  reset(): void {
    this.current = null;
    this.batches = [];
    this.bytes = 0;
  }

  private prune(now: number): void {
    const cutoff = now - TRANSCRIPTION_RECOVERY_MAX_AUDIO_AGE_MS;
    while (
      this.batches.length > 0 &&
      (this.bytes > TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES ||
        (this.batches[0]?.createdAt ?? now) < cutoff)
    ) {
      const batch = this.batches[0];
      if (!batch) break;
      this.removeBatch(batch);
    }

    if (this.current && this.bytes > TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES) {
      while (
        this.current.chunks.length > 0 &&
        this.bytes > TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES
      ) {
        const chunk = this.current.chunks.shift();
        if (!chunk) break;
        this.current.bytes -= chunk.audio.length;
        this.bytes -= chunk.audio.length;
      }
      if (this.current.chunks.length === 0) this.current = null;
    }
  }

  private removeBatch(batch: ReplayBatch): void {
    const index = this.batches.indexOf(batch);
    if (index < 0) return;
    this.batches.splice(index, 1);
    this.bytes -= batch.bytes;
  }
}
