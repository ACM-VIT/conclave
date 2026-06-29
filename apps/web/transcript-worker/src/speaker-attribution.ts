import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";

export class TranscriptSpeakerAttribution {
  private readonly pendingCommitSpeakers: TranscriptSpeaker[] = [];
  private readonly itemSpeakers = new Map<string, TranscriptSpeaker>();

  enqueueCommit(speaker: TranscriptSpeaker): void {
    this.pendingCommitSpeakers.push(speaker);
  }

  bindCommittedItem(itemId: string): TranscriptSpeaker | null {
    const speaker = this.pendingCommitSpeakers.shift() ?? null;
    if (!speaker) return null;
    this.itemSpeakers.set(itemId, speaker);
    return speaker;
  }

  getItemSpeaker(itemId: string): TranscriptSpeaker | null {
    return this.itemSpeakers.get(itemId) ?? null;
  }

  peekPendingSpeaker(): TranscriptSpeaker | null {
    return this.pendingCommitSpeakers[0] ?? null;
  }

  reset(): void {
    this.pendingCommitSpeakers.length = 0;
    this.itemSpeakers.clear();
  }
}
