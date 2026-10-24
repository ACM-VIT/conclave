import { afterEach, expect, it, vi } from "vitest";
import { TranscriptRoom } from "../transcript-worker/src/room";
import type { Env, Viewer } from "../transcript-worker/src/types";
import type {
  TranscriptMinutesSnapshot,
  TranscriptSegment,
  TranscriptSessionState,
} from "@conclave/meeting-core/transcript-types";
const { generate, compact, stream } = vi.hoisted(() => ({
  generate: vi.fn(),
  compact: vi.fn(),
  stream: vi.fn(),
}));
vi.mock("../transcript-worker/src/ai", async (original) => ({
  ...(await original<typeof import("../transcript-worker/src/ai")>()),
  generateMinutes: generate,
  compactMinutes: compact,
  streamQuestionAnswer: stream,
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
type TestRoom = {
  loaded: Promise<void>;
  session: TranscriptSessionState;
  sessionRevision: number;
  responseAbort: AbortController;
  segments: TranscriptSegment[];
  minutes: TranscriptMinutesSnapshot;
  minutesGenerating: boolean;
  responseApiKey: string | null;
  responseEnvironment: Env | null;
  personalResponseKeys: Partial<Record<"openai" | "anthropic", string>>;
  hasAiMinutes: boolean;
  minutesRerunRequested: boolean;
  regenerateMinutes: () => Promise<void>;
  responseProfile: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
  scheduleMinutes: ReturnType<typeof vi.fn>;
  answerQuestion: (
    viewer: Viewer,
    message: { type: "qa.ask"; question: string },
  ) => Promise<void>;
  viewers: Map<WebSocket, Viewer>;
};
async function fixture() {
  const room = new TranscriptRoom(
    {
      storage: { get: async () => undefined },
      waitUntil: () => undefined,
    } as unknown as DurableObjectState,
    {} as Env,
  ) as unknown as TestRoom;
  await room.loaded;
  room.session = {
    roomId: "room",
    qaModel: "claude-haiku-5-5",
  } as TranscriptSessionState;
  room.segments = [
    {
      text: "We will ship tomorrow.",
      startMs: Date.now(),
      speakerDisplayName: "Ada",
    },
  ] as TranscriptSegment[];
  room.responseProfile = vi.fn().mockResolvedValue({
    env: {},
    model: "claude-haiku-5-5",
    apiKey: "sk-ant-fixture",
    enabled: true,
  });
  room.persist = vi.fn().mockResolvedValue(undefined);
  room.scheduleMinutes = vi.fn();
  return room;
}
it("does not let cancelled compaction overwrite or unlock the next session's minutes", async () => {
  const room = await fixture();
  const snapshot = {
    ...room.minutes,
    summary: "Old notes",
    topics: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    followUps: [],
  };
  generate.mockResolvedValue(snapshot);
  let complete!: (value: TranscriptMinutesSnapshot) => void;
  compact.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = room.regenerateMinutes();
  await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
  room.sessionRevision++;
  room.responseAbort.abort();
  room.responseAbort = new AbortController();
  room.minutes = { ...snapshot, summary: "New session" };
  room.minutesGenerating = true;
  room.minutesRerunRequested = true;
  complete(snapshot);
  await pending;
  expect(room.minutes.summary).toBe("New session");
  expect(room.minutesGenerating).toBe(true);
  expect(room.minutesRerunRequested).toBe(true);
  expect(room.persist).not.toHaveBeenCalled();
  expect(room.scheduleMinutes).not.toHaveBeenCalled();
});
it.each([false, true])(
  "does not emit stale Q&A completion after cancellation (provider failure: %s)",
  async (fails) => {
    const room = await fixture();
    const send = vi.fn();
    const viewer = {
      socket: { send },
      capabilities: { ask: true },
    } as unknown as Viewer;
    room.viewers.set(viewer.socket, viewer);
    let complete!: () => void;
    const wait = new Promise<void>((resolve) => {
      complete = resolve;
    });
    stream.mockImplementation(async function* () {
      await wait;
      if (fails) throw new Error("Cancelled provider");
      yield* [];
    });
    const pending = room.answerQuestion(viewer, {
      type: "qa.ask",
      question: "What did we decide?",
    });
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    room.sessionRevision++;
    room.responseAbort.abort();
    complete();
    await pending;
    const frames = send.mock.calls.map(
      ([value]) => JSON.parse(value as string) as { type: string },
    );
    expect(frames.some((value) => value.type === "qa.final")).toBe(false);
  },
);

it("schedules automatic minutes without a transcript questions provider key", async () => {
  vi.useFakeTimers();
  const room = await fixture();
  room.responseApiKey = null;
  room.hasAiMinutes = true;
  room.regenerateMinutes = vi.fn().mockResolvedValue(undefined);
  const schedule = (
    TranscriptRoom.prototype as unknown as { scheduleMinutes: () => void }
  ).scheduleMinutes;
  schedule.call(room);
  await vi.runOnlyPendingTimersAsync();
  expect(room.regenerateMinutes).toHaveBeenCalledTimes(1);
});

it("keeps an explicit response key ahead of the matching room key without crossing providers", async () => {
  const room = await fixture();
  room.responseEnvironment = {
    ANTHROPIC_API_KEY: "sk-ant-shared",
    OPENAI_API_KEY: "sk-openai-shared",
    CONCLAVE_AI_SETTINGS: JSON.stringify({
      minutes: { model: "claude-haiku-5-5" },
      questions: { model: "gpt-6.1-sol" },
    }),
  } as Env;
  room.personalResponseKeys = {anthropic: "sk-ant-personal"};
  const resolve = (
    TranscriptRoom.prototype as unknown as {
      responseProfile: (
        feature: "minutes" | "questions",
      ) => Promise<{ apiKey: string }>;
    }
  ).responseProfile;
  expect((await resolve.call(room, "minutes")).apiKey).toBe("sk-ant-personal");
  expect((await resolve.call(room, "questions")).apiKey).toBe(
    "sk-openai-shared",
  );
});
