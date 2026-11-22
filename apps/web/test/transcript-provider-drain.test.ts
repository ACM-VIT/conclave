import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptRoom } from "../transcript-worker/src/room";
import type { Env, Viewer } from "../transcript-worker/src/types";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@conclave/ai/room-server", async (original) => ({
  ...(await original<typeof import("@conclave/ai/room-server")>()),
  fetchRoomAiEnvironment: lookup,
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Listener = (event: { data?: unknown }) => void;

class FakeProviderSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();
  accept() {}
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(event: object) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(event) });
    }
  }
  sentTypes() {
    return this.sent.map((message) => message.type);
  }
}

type TestRoom = {
  loaded: Promise<void>;
  segments: { text: string }[];
  viewers: Map<WebSocket, Viewer>;
  startSession: (viewer: Viewer, message: object) => Promise<void>;
  handleMessage: (viewer: Viewer, raw: string) => Promise<void>;
};

const OPENAI = "gpt-live-transcribe";
const SARVAM = "saaras:v3";
const AUDIO = Buffer.alloc(9600).toString("base64");

async function fixture(transcriptModel: string) {
  const sockets: FakeProviderSocket[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const socket = new FakeProviderSocket();
      sockets.push(socket);
      return { webSocket: socket, status: 101 };
    }),
  );
  lookup.mockResolvedValue({
    OPENAI_API_KEY: "sk-room",
    SARVAM_API_KEY: "sarvam-room",
    CONCLAVE_AI_SETTINGS: JSON.stringify({ transcription: { model: transcriptModel } }),
  });
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
    { TRANSCRIPT_TRANSCRIPTION_LANGUAGE: "en" } as Env,
  ) as unknown as TestRoom;
  await room.loaded;
  const viewer = {
    id: "host",
    userId: "host",
    displayName: "Host",
    socket: { send: vi.fn() },
    sfuUrl: "https://sfu.example",
    clientId: "conclave",
    channelId: "room",
    capabilities: { start: true, stop: true, takeover: true },
    rateLimits: {},
  } as unknown as Viewer;
  room.viewers.set(viewer.socket, viewer);
  const session = { transcriptModel, qaModel: "gpt-6.1-sol", transportMode: "sfu" };
  const start = (language: string) =>
    room.startSession(viewer, { ...session, type: "session.start", language });
  const switchTo = (language: string) =>
    room.startSession(viewer, { ...session, type: "session.takeover", language });
  const send = (message: object) => room.handleMessage(viewer, JSON.stringify(message));
  const speak = () => send({ type: "audio.chunk", audio: AUDIO });
  const commit = () => send({ type: "audio.commit" });
  const savedTexts = () => room.segments.map(({ text }) => text);
  return { sockets, start, switchTo, speak, commit, savedTexts };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const openAiCommitted = (itemId: string) => ({ type: "input_audio_buffer.committed", item_id: itemId });
const openAiDelta = (itemId: string, delta: string) => ({
  type: "conversation.item.input_audio_transcription.delta",
  item_id: itemId,
  delta,
});
const openAiFinal = (itemId: string, transcript: string) => ({
  type: "conversation.item.input_audio_transcription.completed",
  item_id: itemId,
  transcript,
});

describe("switching the caption language keeps speech the old provider already has", () => {
  it("Sarvam: saves a final that arrives after the switch with no partial before it", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, savedTexts } = await fixture(SARVAM);
    await start("hi");
    const before = sockets[0];
    await speak();

    await switchTo("ta");
    expect(before.closed).toBe(false);
    expect(before.sentTypes().at(-1)).toBe("flush");
    before.emit({ type: "data", data: { transcript: "Friday at noon", request_id: "utterance" } });
    await settle();

    expect(savedTexts()).toEqual(["Friday at noon"]);
    expect(before.closed).toBe(true);
  });

  it("OpenAI: saves a sentence the provider acknowledged before sending any of its text", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, savedTexts } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    before.emit(openAiCommitted("item_1"));
    before.emit(openAiDelta("item_1", "First sentence"));
    await speak();
    await commit();
    before.emit(openAiCommitted("item_2"));
    await settle();

    await switchTo("hi");
    before.emit(openAiFinal("item_1", "First sentence."));
    before.emit(openAiDelta("item_2", "Second"));
    before.emit(openAiFinal("item_2", "Second sentence."));
    await settle();

    expect(savedTexts()).toEqual(["First sentence.", "Second sentence."]);
    expect(before.closed).toBe(true);
  });

  it("OpenAI: asks the old provider to transcribe audio it had not been asked about yet", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, savedTexts } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();

    await switchTo("hi");
    expect(before.sentTypes()).toContain("input_audio_buffer.commit");
    before.emit(openAiCommitted("item_tail"));
    before.emit(openAiFinal("item_tail", "The last few words."));
    await settle();

    expect(savedTexts()).toEqual(["The last few words."]);
  });

  it("never lets the drain timeout replace a later final with an older partial", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, savedTexts } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    before.emit(openAiCommitted("item_1"));
    before.emit(openAiDelta("item_1", "Friday"));
    await settle();

    await switchTo("hi");
    sockets[1].emit(openAiFinal("item_1", "Friday at noon"));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(savedTexts()).toEqual(["Friday at noon"]);
  });

  it("saves what was on screen when the old provider never finishes", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, savedTexts } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    before.emit(openAiCommitted("item_1"));
    before.emit(openAiDelta("item_1", "Friday"));
    await settle();

    await switchTo("hi");
    await vi.advanceTimersByTimeAsync(15_000);

    expect(savedTexts()).toEqual(["Friday"]);
    expect(before.closed).toBe(true);
  });
});
