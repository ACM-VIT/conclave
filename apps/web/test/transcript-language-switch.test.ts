import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptRoom } from "../transcript-worker/src/room";
import type {
  LiveTranscriptionConnectOptions,
  LiveTranscriptionSession,
} from "../transcript-worker/src/transcription/types";
import type { Env, Viewer } from "../transcript-worker/src/types";
import type { TranscriptSessionState } from "@conclave/meeting-core/transcript-types";

const { connectProvider, lookup } = vi.hoisted(() => ({
  connectProvider: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("../transcript-worker/src/transcription", async (original) => ({
  ...(await original<typeof import("../transcript-worker/src/transcription")>()),
  connectLiveTranscriptionProvider: connectProvider,
}));
vi.mock("@conclave/ai/room-server", async (original) => ({
  ...(await original<typeof import("@conclave/ai/room-server")>()),
  fetchRoomAiEnvironment: lookup,
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

type TestRoom = {
  loaded: Promise<void>;
  session: TranscriptSessionState | null;
  segments: { itemId: string; text: string }[];
  viewers: Map<WebSocket, Viewer>;
  startSession: (viewer: Viewer, message: object) => Promise<void>;
};

const roomSession = {
  transcriptModel: "gpt-live-transcribe",
  qaModel: "gpt-6.1-sol",
  transportMode: "sfu",
};

async function fixture() {
  const providers: (LiveTranscriptionConnectOptions & LiveTranscriptionSession)[] = [];
  connectProvider.mockImplementation(async (options: LiveTranscriptionConnectOptions) => {
    const provider = {
      ...options,
      provider: options.transcriptModel.startsWith("saaras") ? "sarvam" : "openai",
      appendAudio: vi.fn(),
      commitAudio: vi.fn(),
      clearAudio: vi.fn(),
      close: vi.fn(),
    } as LiveTranscriptionConnectOptions & LiveTranscriptionSession;
    providers.push(provider);
    return provider;
  });
  lookup.mockResolvedValue({ OPENAI_API_KEY: "sk-room" });
  const room = new TranscriptRoom(
    {
      storage: {
        get: async () => undefined,
        put: async () => {},
        delete: async () => true,
        setAlarm: async () => {},
      },
      waitUntil: () => undefined,
    } as unknown as DurableObjectState,
    {
      TRANSCRIPT_TRANSCRIPTION_LANGUAGE: "en",
      TRANSCRIPT_SARVAM_LANGUAGE_CODE: "en-IN",
    } as Env,
  ) as unknown as TestRoom;
  await room.loaded;
  const sent: { type: string; message?: string }[] = [];
  const viewer = {
    id: "host",
    userId: "host",
    displayName: "Host",
    socket: { send: (raw: string) => sent.push(JSON.parse(raw)) },
    sfuUrl: "https://sfu.example",
    clientId: "conclave",
    channelId: "room",
    capabilities: { start: true, stop: true, takeover: true },
  } as unknown as Viewer;
  room.viewers.set(viewer.socket, viewer);
  return { room, viewer, providers, sent };
}

const savedTexts = (room: TestRoom) => room.segments.map(({ text }) => text);

describe("switching the caption language mid-sentence", () => {
  it("keeps the words already on screen once the old provider finishes them", async () => {
    const { room, viewer, providers } = await fixture();
    await room.startSession(viewer, { ...roomSession, type: "session.start", language: "en" });
    const before = providers[0];
    await before.callbacks.onFinal("earlier", "This line finished before switching.");
    before.callbacks.onDelta("utterance", "The release date is");

    await room.startSession(viewer, { ...roomSession, type: "session.takeover", language: "hi" });
    await before.callbacks.onFinal("utterance", "The release date is Friday.");

    expect(providers.map(({ language }) => language)).toEqual(["en", "hi"]);
    expect(savedTexts(room)).toEqual([
      "This line finished before switching.",
      "The release date is Friday.",
    ]);
    expect(before.close).toHaveBeenCalled();
  });

  it("saves the words on screen if the old provider never finishes them", async () => {
    vi.useFakeTimers();
    const { room, viewer, providers } = await fixture();
    await room.startSession(viewer, { ...roomSession, type: "session.start", language: "en" });
    const before = providers[0];
    before.callbacks.onDelta("utterance", "The release date is");

    await room.startSession(viewer, { ...roomSession, type: "session.takeover", language: "hi" });
    expect(savedTexts(room)).toEqual([]);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(savedTexts(room)).toEqual(["The release date is"]);
    expect(before.close).toHaveBeenCalled();
  });

  it("stops listening to the old provider once the switch is done", async () => {
    const { room, viewer, providers } = await fixture();
    await room.startSession(viewer, { ...roomSession, type: "session.start", language: "en" });
    const before = providers[0];
    before.callbacks.onDelta("utterance", "Hello");

    await room.startSession(viewer, { ...roomSession, type: "session.takeover", language: "hi" });
    await before.callbacks.onFinal("utterance", "Hello there.");
    await before.callbacks.onFinal("later", "Words after the switch.");

    expect(savedTexts(room)).toEqual(["Hello there."]);
  });
});
