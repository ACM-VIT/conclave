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
      /** The line this audio belongs to, so an utterance heard in it on replay is that line. */
      owner?: string;
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

type ReplayChunk = {
  audio: string;
  sampleCount: number;
  createdAt: number;
  /** The line this audio belongs to; ending that line drops it. */
  owner: string | null;
};

export type ReplayBatch = {
  owner: string | null;
  sequence: number;
  speaker: TranscriptSpeaker;
  chunks: ReplayChunk[];
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

/**
 * Audio sent to a provider that may need sending again after a reconnect,
 * each piece owned by the line it belongs to, committed or not. Ending a
 * line drops all of its audio and nothing of any other line's.
 */
export class TranscriptAudioReplayJournal {
  private current: {
    speaker: TranscriptSpeaker;
    chunks: ReplayChunk[];
    createdAt: number;
    bytes: number;
  } | null = null;
  private batches: ReplayBatch[] = [];
  private nextSequence = 0;
  private bytes = 0;

  append(
    audio: string,
    speaker: TranscriptSpeaker,
    sampleCount: number,
    now = Date.now(),
    owner: string | null = null,
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
    this.current.chunks.push({ audio, sampleCount, createdAt: now, owner });
    this.current.bytes += audio.length;
    this.bytes += audio.length;
    this.prune(now);
  }

  /** A line just accepted owns the audio no line owns yet from where its utterance began. */
  claim(owner: string, since: number): void {
    for (const chunk of this.current?.chunks ?? []) {
      if (chunk.owner === null && chunk.createdAt >= since) chunk.owner = owner;
    }
    this.batches = this.batches.flatMap((batch) => {
      if (batch.owner !== null || !batch.chunks.some(({ createdAt }) => createdAt >= since)) return [batch];
      const runs: ReplayChunk[][] = [];
      for (const chunk of batch.chunks) {
        const chunkOwner = chunk.createdAt >= since ? owner : null;
        const run = runs.at(-1);
        if (run && run[0]!.owner === chunkOwner) run.push({ ...chunk, owner: chunkOwner });
        else runs.push([{ ...chunk, owner: chunkOwner }]);
      }
      return runs.map((chunks) => ({
        ...batch,
        owner: chunks[0]!.owner,
        chunks,
        createdAt: chunks[0]!.createdAt,
        bytes: chunks.reduce((sum, chunk) => sum + chunk.audio.length, 0),
      }));
    });
  }

  /** Commits the pending audio, one batch per line it belongs to. */
  commit(
    speaker: TranscriptSpeaker,
    now = Date.now(),
    owner: string | null = null,
  ): ReplayBatch[] {
    if (
      !this.current ||
      !isSameTranscriptAudioSpeaker(this.current.speaker, speaker) ||
      this.current.chunks.length === 0
    ) {
      return [];
    }
    const committed = this.toBatches(this.current, now, owner);
    this.current = null;
    this.batches.push(...committed);
    this.prune(now);
    return committed;
  }

  /** An acknowledged commit's audio belongs to the line the ack named. */
  own(batches: readonly ReplayBatch[], owner: string): void {
    for (const batch of batches) {
      batch.owner = owner;
      for (const chunk of batch.chunks) chunk.owner = owner;
    }
  }

  /** Drops audio a provider has already finished with. */
  drop(batches: readonly ReplayBatch[]): void {
    for (const batch of batches) this.removeBatch(batch);
  }

  /** Drops all of one line's audio, committed or not, once that line has ended. */
  release(owner: string): void {
    for (const batch of this.batches.filter((candidate) => candidate.owner === owner)) {
      this.removeBatch(batch);
    }
    const current = this.current;
    if (!current) return;
    const kept = current.chunks.filter((chunk) => chunk.owner !== owner);
    const dropped = current.bytes - kept.reduce((sum, chunk) => sum + chunk.audio.length, 0);
    current.chunks = kept;
    current.bytes -= dropped;
    this.bytes -= dropped;
    if (kept.length === 0) this.current = null;
  }

  takeRecoveryEvents(now = Date.now()): BufferedTranscriptAudioEvent[] {
    const batches = [
      ...this.batches,
      ...(this.current?.chunks.length ? this.toBatches(this.current, now, null) : []),
    ];
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
        ...(batch.owner ? { owner: batch.owner } : {}),
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

  get isEmpty(): boolean {
    return this.current === null && this.batches.length === 0;
  }

  private toBatches(
    pending: NonNullable<TranscriptAudioReplayJournal["current"]>,
    now: number,
    owner: string | null,
  ): ReplayBatch[] {
    const runs: ReplayChunk[][] = [];
    for (const chunk of pending.chunks) {
      const chunkOwner = owner ?? chunk.owner;
      const run = runs.at(-1);
      if (run && (owner ?? run[0]!.owner) === chunkOwner) run.push(chunk);
      else runs.push([chunk]);
    }
    return runs.map((chunks) => {
      const batchOwner = owner ?? chunks[0]!.owner;
      this.nextSequence += 1;
      return {
        owner: batchOwner,
        sequence: this.nextSequence,
        speaker: pending.speaker,
        chunks: chunks.map((chunk) => ({ ...chunk, owner: batchOwner })),
        createdAt: chunks[0]!.createdAt,
        committedAt: now,
        bytes: chunks.reduce((sum, chunk) => sum + chunk.audio.length, 0),
      };
    });
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
