import { describe, expect, it } from "vitest";
import type {
  TranscriptMinutesSnapshot,
  TranscriptSegment,
} from "@conclave/meeting-core/transcript-types";
import type { Env } from "../transcript-worker/src/types";
import {
  MINUTES_COMPACTION_SYSTEM_PROMPT,
  MINUTES_SYSTEM_PROMPT,
  QA_SYSTEM_PROMPT,
  buildMinutesCompactionInput,
  buildMinutesUpdateInput,
  buildQaTranscriptContext,
  buildRealtimeTranscriptionConfig,
  buildTranscriptionPrompt,
  realtimeEndpoint,
} from "../transcript-worker/src/openai";
import {
  applyMinutesUpdateFromText,
  boundMinutesSnapshot,
  COMPACT_MINUTES_SECTION_LIMITS,
  minutesNeedCompaction,
  WORKING_MINUTES_SECTION_LIMITS,
} from "../transcript-worker/src/minutes";

const segment = (
  sequence: number,
  text: string,
  options: { final?: boolean } = {},
): TranscriptSegment => ({
  id: `item-${sequence}`,
  itemId: `item-${sequence}`,
  sequence,
  speakerUserId: sequence % 2 === 0 ? "u1" : "u2",
  speakerDisplayName: sequence % 2 === 0 ? "Ada" : "Grace",
  source: "remote",
  text,
  startMs: Date.UTC(2026, 0, 1, 10, 0, sequence),
  endMs: options.final === false ? null : Date.UTC(2026, 0, 1, 10, 0, sequence + 1),
  isFinal: options.final !== false,
  updatedAt: Date.UTC(2026, 0, 1, 10, 0, sequence + 1),
});

const currentMinutes = (): TranscriptMinutesSnapshot => ({
  summary: "The team selected Postgres for the first release.",
  topics: [{ id: "topic-storage", text: "Storage architecture" }],
  decisions: [{ id: "decision-postgres", text: "Use Postgres for v1." }],
  actionItems: [
    {
      id: "action-schema",
      text: "Draft the initial schema.",
      owner: "Ada",
    },
  ],
  openQuestions: [
    { id: "question-backups", text: "Which backup policy should we use?" },
  ],
  followUps: [],
  updatedAt: 1,
  model: "gpt-5-mini",
});

describe("transcript OpenAI request helpers", () => {
  it("builds realtime transcription endpoint without a URL model parameter", () => {
    const endpoint = realtimeEndpoint(
      {
        OPENAI_REALTIME_URL: "wss://api.openai.com/v1/realtime",
      } as Partial<Env> as Env,
    );
    const url = new URL(endpoint);

    expect(url.protocol).toBe("https:");
    expect(url.searchParams.get("intent")).toBe("transcription");
    expect(url.searchParams.has("model")).toBe(false);
  });

  it("sends delay only for gpt-realtime-whisper", () => {
    expect(
      buildRealtimeTranscriptionConfig({
        model: "gpt-realtime-whisper",
        language: "en",
        delay: "medium",
        locale: "en-IN",
      }),
    ).toEqual({
      model: "gpt-realtime-whisper",
      language: "en",
      delay: "medium",
    });
  });

  it("normalizes non-Realtime transcription models to the live default", () => {
    expect(
      buildRealtimeTranscriptionConfig({
        model: "gpt-4o-transcribe",
        language: "en",
        delay: "medium",
        locale: "en-IN",
      }),
    ).toEqual({
      model: "gpt-realtime-whisper",
      language: "en",
      delay: "medium",
    });
  });

  it("builds India-focused localization prompts for prompt-capable models", () => {
    const prompt = buildTranscriptionPrompt({
      locale: "en-IN",
      localizationPrompt: "Expect ACM VIT and Hinglish project names.",
    });

    expect(prompt).toContain("Preferred locale: en-IN.");
    expect(prompt).toContain("Hinglish");
    expect(prompt).toContain("ACM VIT");
  });

  it("builds Ask context from the full available transcript", () => {
    const segments = Array.from({ length: 150 }, (_, index) =>
      segment(
        index,
        index === 0
          ? "FIRST_CONTEXT_MARKER"
          : index === 149
            ? "LAST_CONTEXT_MARKER"
            : `Segment ${index}`,
      ),
    );

    const context = buildQaTranscriptContext(segments);

    expect(context).toContain("FIRST_CONTEXT_MARKER");
    expect(context).toContain("LAST_CONTEXT_MARKER");
    expect(context.split("\n")).toHaveLength(150);
  });

  it("keeps full segment text in Ask context", () => {
    const longText = "x".repeat(1200);
    const context = buildQaTranscriptContext([segment(1, longText)]);

    expect(context).toContain(longText);
  });

  it("keeps Ask grounded in transcript evidence and speaker attribution", () => {
    expect(QA_SYSTEM_PROMPT).toContain("source of truth");
    expect(QA_SYSTEM_PROMPT).toContain("Do not reassign a statement");
    expect(QA_SYSTEM_PROMPT).toContain("If the user asks what someone said");
    expect(QA_SYSTEM_PROMPT).toContain("owner not stated");
    expect(QA_SYSTEM_PROMPT).toContain("partial");
  });

  it("includes accumulated minutes as memory for each minutes update", () => {
    const input = buildMinutesUpdateInput({
      current: currentMinutes(),
      transcript: "[10:15:00] Grace: We should review backup options next.",
    });

    expect(input).toContain("decision-postgres");
    expect(input).toContain("Use Postgres for v1.");
    expect(input).toContain("review backup options");
    expect(MINUTES_SYSTEM_PROMPT).toContain("Absence is not evidence of removal");
    expect(MINUTES_SYSTEM_PROMPT).toContain("incremental update");
  });

  it("retains prior minutes entries omitted by an incremental update", () => {
    const updated = applyMinutesUpdateFromText(
      JSON.stringify({
        summary:
          "The team selected Postgres and assigned Grace to review backups.",
        topics: { upsert: [], remove: [] },
        decisions: { upsert: [], remove: [] },
        actionItems: {
          upsert: [
            {
              id: "action-backups",
              text: "Review backup options.",
              owner: "Grace",
              due: null,
            },
          ],
          remove: [],
        },
        openQuestions: { upsert: [], remove: [] },
        followUps: { upsert: [], remove: [] },
      }),
      currentMinutes(),
    );

    expect(updated.decisions).toEqual([
      { id: "decision-postgres", text: "Use Postgres for v1." },
    ]);
    expect(updated.actionItems).toHaveLength(2);
    expect(updated.actionItems[1]).toMatchObject({
      id: "action-backups",
      owner: "Grace",
    });
  });

  it("only removes prior context when the update names its stable ID", () => {
    const updated = applyMinutesUpdateFromText(
      JSON.stringify({
        summary: "The team selected Postgres and settled the backup policy.",
        topics: { upsert: [], remove: [] },
        decisions: { upsert: [], remove: [] },
        actionItems: { upsert: [], remove: [] },
        openQuestions: { upsert: [], remove: ["question-backups"] },
        followUps: { upsert: [], remove: [] },
      }),
      currentMinutes(),
    );

    expect(updated.openQuestions).toEqual([]);
    expect(updated.decisions).toHaveLength(1);
  });

  it("preserves accumulated minutes when an update is malformed", () => {
    const current = currentMinutes();

    expect(applyMinutesUpdateFromText("not json", current)).toBe(current);
  });

  it("builds a Codex-style replacement-memory compaction request", () => {
    const input = buildMinutesCompactionInput(currentMinutes());

    expect(input).toContain("canonical long-term memory");
    expect(input).toContain("decision-postgres");
    expect(MINUTES_COMPACTION_SYSTEM_PROMPT).toContain("replacement snapshot");
    expect(MINUTES_COMPACTION_SYSTEM_PROMPT).toContain(
      "must not lose commitments",
    );
  });

  it("keeps incremental working memory bounded until semantic compaction", () => {
    const current = currentMinutes();
    current.actionItems = Array.from(
      { length: WORKING_MINUTES_SECTION_LIMITS.actionItems + 8 },
      (_, index) => ({
        id: `action-${index}`,
        text: `Action ${index}`,
      }),
    );

    const bounded = boundMinutesSnapshot(current);

    expect(bounded.actionItems).toHaveLength(
      WORKING_MINUTES_SECTION_LIMITS.actionItems,
    );
    expect(bounded.actionItems[0]?.id).toBe("action-0");
    expect(bounded.actionItems.at(-1)?.id).toBe(
      `action-${WORKING_MINUTES_SECTION_LIMITS.actionItems + 7}`,
    );
    expect(minutesNeedCompaction(bounded)).toBe(true);
    expect(COMPACT_MINUTES_SECTION_LIMITS.actionItems).toBeLessThan(
      WORKING_MINUTES_SECTION_LIMITS.actionItems,
    );
  });
});
