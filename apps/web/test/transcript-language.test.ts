import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptRoom } from "../transcript-worker/src/room";
import { connectSarvamTranscription } from "../transcript-worker/src/transcription/sarvam";
import type {
  Env,
  SessionStartEnvelope,
  Viewer,
} from "../transcript-worker/src/types";
import type { TranscriptSessionState } from "@conclave/meeting-core/transcript-types";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@conclave/ai/room-server", async (original) => ({
  ...(await original<typeof import("@conclave/ai/room-server")>()),
  fetchRoomAiEnvironment: lookup,
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

type TestRoom = {
  loaded: Promise<void>;
  session: TranscriptSessionState | null;
  viewers: Map<WebSocket, Viewer>;
  startSession: (viewer: Viewer, message: SessionStartEnvelope) => Promise<void>;
  stopSession: (viewer: Viewer) => Promise<void>;
  connectTranscriptionProvider: ReturnType<typeof vi.fn>;
  sendSfuRelayStartToken: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
  sendError: ReturnType<typeof vi.fn>;
};

async function fixture() {
  const room = new TranscriptRoom(
    {
      storage: { get: async () => undefined, delete: async () => true },
      waitUntil: () => undefined,
    } as unknown as DurableObjectState,
    { TRANSCRIPT_TRANSCRIPTION_LANGUAGE: "en" } as Env,
  ) as unknown as TestRoom;
  await room.loaded;
  room.connectTranscriptionProvider = vi.fn().mockResolvedValue(undefined);
  room.sendSfuRelayStartToken = vi.fn().mockResolvedValue(undefined);
  room.persist = vi.fn().mockResolvedValue(undefined);
  room.sendError = vi.fn();
  const viewer = {
    id: "host",
    userId: "host",
    displayName: "Host",
    socket: { send: vi.fn() },
    sfuUrl: "https://sfu.example",
    clientId: "client",
    channelId: "channel",
    capabilities: { start: true, stop: true, takeover: true },
  } as unknown as Viewer;
  room.viewers.set(viewer.socket, viewer);
  lookup.mockResolvedValue({ OPENAI_API_KEY: "sk-room" });
  return { room, viewer };
}

const start: SessionStartEnvelope = {
  type: "session.start",
  transcriptModel: "gpt-live-transcribe",
  qaModel: "gpt-6.1-sol",
  transportMode: "sfu",
};

const providerLanguages = (room: TestRoom) =>
  room.connectTranscriptionProvider.mock.calls.map(([options]) => options.language);

const broadcastLanguages = (viewer: Viewer) =>
  (viewer.socket.send as ReturnType<typeof vi.fn>).mock.calls
    .map(([raw]) => JSON.parse(raw))
    .filter((message) => message.type === "session.state")
    .map((message) => message.session?.language);

describe("caption language in the transcript worker", () => {
  it("transcribes in the language the controller picked and tells every viewer", async () => {
    const { room, viewer } = await fixture();

    await room.startSession(viewer, { ...start, language: "hi" });

    expect(providerLanguages(room)).toEqual(["hi"]);
    expect(room.session?.language).toBe("hi");
    expect(broadcastLanguages(viewer)).toContain("hi");
  });

  it("keeps the session language when a takeover does not name one", async () => {
    const { room, viewer } = await fixture();

    await room.startSession(viewer, { ...start, language: "ta" });
    await room.startSession(viewer, { ...start, type: "session.takeover" });

    expect(providerLanguages(room)).toEqual(["ta", "ta"]);
  });

  it("switches language when the controller takes over with a new one", async () => {
    const { room, viewer } = await fixture();

    await room.startSession(viewer, { ...start, language: "en" });
    await room.startSession(viewer, { ...start, type: "session.takeover", language: "es" });

    expect(providerLanguages(room)).toEqual(["en", "es"]);
    expect(room.session?.language).toBe("es");
  });

  it("falls back to the deployment language for clients that send none", async () => {
    const { room, viewer } = await fixture();

    await room.startSession(viewer, { ...start, language: "hi" });
    await room.stopSession(viewer);
    await room.startSession(viewer, start);

    expect(providerLanguages(room)).toEqual(["hi", "en"]);
  });
});

describe("Sarvam language routing", () => {
  const requestedLanguageCode = async (
    language: string,
    deploymentCode: string | undefined,
  ) => {
    const fetchMock = vi.fn(async () => ({ webSocket: null, status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await connectSarvamTranscription({
      env: { TRANSCRIPT_SARVAM_LANGUAGE_CODE: deploymentCode } as Env,
      apiKey: "sarvam-key",
      transcriptModel: "saaras:v3",
      language,
      delay: "medium",
      locale: "en-IN",
      callbacks: {
        onCommitted: () => {},
        onDelta: () => {},
        onFinal: () => {},
        onFailure: () => {},
      },
    }).catch(() => {});
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    return new URL(url).searchParams.get("language-code");
  };

  it("asks Sarvam for the picked Indian language", async () => {
    expect(await requestedLanguageCode("hi", "en-IN")).toBe("hi-IN");
    expect(await requestedLanguageCode("ta", "unknown")).toBe("ta-IN");
  });

  it("keeps the deployment default for English and unsupported languages", async () => {
    expect(await requestedLanguageCode("en", "unknown")).toBe("unknown");
    expect(await requestedLanguageCode("es", "en-IN")).toBe("en-IN");
  });
});
