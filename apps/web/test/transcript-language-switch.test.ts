import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptRoom } from "../transcript-worker/src/room";
import { connectSarvamTranscription } from "../transcript-worker/src/transcription/sarvam";
import type {
  LiveTranscriptionConnectOptions,
  LiveTranscriptionSession,
} from "../transcript-worker/src/transcription/types";
import type { Env, Viewer } from "../transcript-worker/src/types";
import type { TranscriptSessionState } from "@conclave/meeting-core/transcript-types";
import { TRANSCRIPTION_ACKNOWLEDGED_DRAIN_MS } from "../transcript-worker/src/constants";


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
  handleMessage: (viewer: Viewer, raw: string) => Promise<void>;
};

const roomSession = {
  transcriptModel: "gpt-live-transcribe",
  qaModel: "gpt-6.1-sol",
  transportMode: "sfu",
};

async function fixture(env: Partial<Env> = {}) {
  const providers: (LiveTranscriptionConnectOptions & LiveTranscriptionSession)[] = [];
  connectProvider.mockImplementation(async (options: LiveTranscriptionConnectOptions) => {
    const provider = {
      ...options,
      provider: options.transcriptModel.startsWith("saaras") ? "sarvam" : "openai",
      appendAudio: vi.fn(),
      commitAudio: vi.fn(),
      clearAudio: vi.fn(),
      finishAudio: vi.fn(),
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
      ...env,
    } as Env,
  ) as unknown as TestRoom;
  await room.loaded;
  const sent: {
    type: string;
    message?: string;
    requestId?: string;
    session?: TranscriptSessionState;
  }[] = [];
  const viewer = {
    id: "host",
    userId: "host",
    displayName: "Host",
    socket: { send: (raw: string) => sent.push(JSON.parse(raw)) },
    sfuUrl: "https://sfu.example",
    clientId: "conclave",
    channelId: "room",
    capabilities: { start: true, stop: true, takeover: true },
    rateLimits: {},
  } as unknown as Viewer;
  room.viewers.set(viewer.socket, viewer);
  return { room, viewer, providers, sent };
}

const savedTexts = (room: TestRoom) => room.segments.map(({ text }) => text);

const moveRoomToSarvam = () =>
  lookup.mockResolvedValue({
    OPENAI_API_KEY: "sk-room",
    SARVAM_API_KEY: "sarvam-room",
    CONCLAVE_AI_SETTINGS: JSON.stringify({ transcription: { model: "saaras:v3" } }),
  });

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
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_ACKNOWLEDGED_DRAIN_MS + 100);

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

describe("caption languages the running provider can transcribe", () => {
  it("refuses a picked language the room's transcription model cannot caption", async () => {
    const { room, viewer, providers, sent } = await fixture();
    await room.startSession(viewer, { ...roomSession, type: "session.start", language: "en" });
    moveRoomToSarvam();

    await room.startSession(viewer, { ...roomSession, type: "session.takeover", language: "fr" });

    expect(sent.filter((message) => message.type === "error")).toHaveLength(1);
    expect(providers).toHaveLength(1);
    expect(room.session).toMatchObject({
      status: "live",
      language: "en",
      transcriptModel: "gpt-live-transcribe",
    });
  });

  it("falls back to the deployment language when a kept language cannot be captioned", async () => {
    const { room, viewer, providers } = await fixture();
    await room.startSession(viewer, { ...roomSession, type: "session.start", language: "fr" });
    moveRoomToSarvam();

    await room.startSession(viewer, { ...roomSession, type: "session.takeover" });

    expect(providers.map(({ provider, language }) => `${provider}:${language}`)).toEqual([
      "openai:fr",
      "sarvam:en",
    ]);
    expect(room.session?.language).toBe("en");
  });
});

describe("caption language support", () => {
  it("tells clients the worker can caption in a chosen language", async () => {
    const { room, viewer, sent } = await fixture();

    await room.handleMessage(viewer, JSON.stringify({ type: "export.snapshot" }));

    expect(sent.find(({ type }) => type === "snapshot")).toMatchObject({
      supportsCaptionLanguage: true,
    });
  });
});

describe("the language code Sarvam is asked for", () => {
  const sarvamSession = { ...roomSession, transcriptModel: "saaras:v3" };
  const requestedCode = async (options: LiveTranscriptionConnectOptions) => {
    const fetchMock = vi.fn(async (_url: string) => ({ webSocket: null, status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await connectSarvamTranscription(options).catch(() => {});
    vi.unstubAllGlobals();
    return new URL(fetchMock.mock.calls[0][0]).searchParams.get("language-code");
  };

  it("honors a picked language over the operator's Sarvam code", async () => {
    const { room, viewer, providers } = await fixture({ TRANSCRIPT_SARVAM_LANGUAGE_CODE: "hi-IN" });
    moveRoomToSarvam();

    await room.startSession(viewer, { ...sarvamSession, type: "session.start", language: "en" });

    expect(await requestedCode(providers[0])).toBe("en-IN");
  });

  it("keeps the operator's Sarvam code for clients that send no language", async () => {
    const { room, viewer, providers } = await fixture({ TRANSCRIPT_SARVAM_LANGUAGE_CODE: "hi-IN" });
    moveRoomToSarvam();

    await room.startSession(viewer, { ...sarvamSession, type: "session.start" });

    expect(await requestedCode(providers[0])).toBe("hi-IN");
  });

  it("keeps a picked language when a client that sends none takes over", async () => {
    const { room, viewer, providers } = await fixture({ TRANSCRIPT_SARVAM_LANGUAGE_CODE: "hi-IN" });
    moveRoomToSarvam();

    await room.startSession(viewer, { ...sarvamSession, type: "session.start", language: "ta" });
    await room.startSession(viewer, { ...sarvamSession, type: "session.takeover" });

    expect(await requestedCode(providers[1])).toBe("ta-IN");
  });
});

describe("telling a client which request the worker answered", () => {
  it("echoes the request id on the session it starts and on a refusal", async () => {
    const { room, viewer, sent } = await fixture();

    await room.startSession(viewer, {
      ...roomSession,
      type: "session.start",
      language: "en",
      requestId: "request-1",
    });
    moveRoomToSarvam();
    await room.startSession(viewer, {
      ...roomSession,
      type: "session.takeover",
      language: "fr",
      requestId: "request-2",
    });

    const states = sent.filter(({ type }) => type === "session.state");
    expect(states.map(({ session }) => [session?.status, session?.requestId])).toContainEqual([
      "starting",
      "request-1",
    ]);
    expect(room.session?.requestId).toBe("request-1");
    expect(sent.find(({ type }) => type === "error")?.requestId).toBe("request-2");
  });
});

