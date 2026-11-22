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
  session: { language?: string; languageChosen?: boolean } | null;
  segments: { text: string; sequence: number; startMs: number }[];
  viewers: Map<WebSocket, Viewer>;
  startSession: (viewer: Viewer, message: object) => Promise<void>;
  handleMessage: (viewer: Viewer, raw: string) => Promise<void>;
};

const OPENAI = "gpt-live-transcribe";
const SARVAM = "saaras:v3";
const AUDIO = Buffer.alloc(9600).toString("base64");

async function fixture(transcriptModel: string, env: Partial<Env> = {}) {
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
  const snapshots: { segments: { text: string }[] }[] = [];
  const room = new TranscriptRoom(
    {
      storage: {
        get: async () => undefined,
        put: async (_key: string, value: { segments: { text: string }[] }) => {
          snapshots.push(structuredClone(value));
        },
        delete: async () => true,
        setAlarm: async () => {},
      },
      waitUntil: () => undefined,
    } as unknown as DurableObjectState,
    { TRANSCRIPT_TRANSCRIPTION_LANGUAGE: "en", ...env } as Env,
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
  const start = (language?: string) =>
    room.startSession(viewer, { ...session, type: "session.start", language });
  const switchTo = (language?: string) =>
    room.startSession(viewer, { ...session, type: "session.takeover", language });
  const send = (message: object) => room.handleMessage(viewer, JSON.stringify(message));
  const stop = () => send({ type: "session.stop" });
  const speak = () => send({ type: "audio.chunk", audio: AUDIO });
  const commit = () => send({ type: "audio.commit" });
  const savedTexts = () => room.segments.map(({ text }) => text);
  const broadcastFinals = () =>
    (viewer.socket.send as ReturnType<typeof vi.fn>).mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((message) => message.type === "segment.final")
      .map((message) => message.segment.text);
  const lastSnapshotTexts = () => snapshots.at(-1)?.segments.map(({ text }) => text) ?? [];
  return { room, sockets, start, switchTo, stop, speak, commit, savedTexts, broadcastFinals, lastSnapshotTexts };
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
    expect(before.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(3_100);
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

const sarvamFinal = (requestId: string, transcript: string) => ({
  type: "data",
  data: { transcript, request_id: requestId },
});
describe("drain cases reproduced across review rounds", () => {
  it("Sarvam: keeps the old socket open for a second buffered utterance after the first final", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, savedTexts } = await fixture(SARVAM);
    await start("hi");
    const before = sockets[0];
    await speak();

    await switchTo("ta");
    before.emit(sarvamFinal("first", "First utterance."));
    await settle();
    expect(before.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    before.emit(sarvamFinal("second", "Second utterance."));
    await settle();

    expect(savedTexts()).toEqual(["First utterance.", "Second utterance."]);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(before.closed).toBe(true);
  });

  it("drains each replaced provider on its own when the language changes twice", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, savedTexts } = await fixture(OPENAI);
    await start("en");
    const english = sockets[0];
    await speak();
    await commit();
    english.emit(openAiCommitted("en_1"));
    english.emit(openAiDelta("en_1", "English words"));
    await settle();

    await switchTo("hi");
    const hindi = sockets[1];
    await speak();
    await commit();
    hindi.emit(openAiCommitted("hi_1"));
    hindi.emit(openAiDelta("hi_1", "Hindi words"));
    await settle();
    await switchTo("ta");
    expect(english.closed).toBe(false);

    english.emit(openAiFinal("en_1", "English words, finished."));
    hindi.emit(openAiFinal("hi_1", "Hindi words, finished."));
    await settle();

    expect(savedTexts()).toEqual(["English words, finished.", "Hindi words, finished."]);
    expect([english.closed, hindi.closed]).toEqual([true, true]);
  });

  it("keeps earlier speech earlier when the old provider's text arrives after the new one's", async () => {
    vi.useFakeTimers();
    const { room, sockets, start, switchTo, speak, commit, savedTexts } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    before.emit(openAiCommitted("old_1"));
    await settle();

    await switchTo("hi");
    const after = sockets[1];
    await speak();
    await commit();
    after.emit(openAiCommitted("new_1"));
    after.emit(openAiFinal("new_1", "After the switch."));
    await vi.advanceTimersByTimeAsync(500);
    before.emit(openAiFinal("old_1", "Before the switch."));
    await settle();

    expect(savedTexts()).toEqual(["Before the switch.", "After the switch."]);
    const [earlier, later] = room.segments;
    expect(earlier.startMs).toBeLessThanOrEqual(later.startMs);
  });

  it("saves and broadcasts a repeated final only once", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, savedTexts, broadcastFinals } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    before.emit(openAiCommitted("a"));
    await speak();
    await commit();
    before.emit(openAiCommitted("b"));
    await settle();

    await switchTo("hi");
    before.emit(openAiFinal("a", "Line a."));
    before.emit(openAiFinal("a", "Line a."));
    before.emit(openAiFinal("b", "Line b."));
    await settle();

    expect(savedTexts()).toEqual(["Line a.", "Line b."]);
    expect(broadcastFinals()).toEqual(["Line a.", "Line b."]);
  });

  it("keeps draining words in the saved snapshot so a worker rollback does not lose them", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, lastSnapshotTexts } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    before.emit(openAiCommitted("item_1"));
    before.emit(openAiDelta("item_1", "Friday at noon"));
    await settle();

    await switchTo("hi");
    await settle();

    expect(lastSnapshotTexts()).toContain("Friday at noon");
  });
});

describe("drain lifetime", () => {
  it("Sarvam: a replaced provider that never answers closes at the deadline, not at the quiet window", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak } = await fixture(SARVAM);
    await start("hi");
    const before = sockets[0];
    await speak();

    await switchTo("ta");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(before.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(before.closed).toBe(true);
  });

  it("stopping notes ends every drain and ignores what the old provider sends after", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, stop, speak, commit, savedTexts } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    before.emit(openAiCommitted("item_1"));
    before.emit(openAiDelta("item_1", "Half a sentence"));
    await settle();

    await switchTo("hi");
    await stop();
    expect(before.closed).toBe(true);
    before.emit(openAiFinal("item_1", "Half a sentence, finished."));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(savedTexts()).toEqual([]);
  });
});

describe("the language a session reports", () => {
  it("reports the operator's Sarvam language for a client that names none, and keeps it on a web resume", async () => {
    vi.useFakeTimers();
    const { room, sockets, start, switchTo } = await fixture(SARVAM, {
      TRANSCRIPT_SARVAM_LANGUAGE_CODE: "hi-IN",
    });
    await start();
    expect(room.session).toMatchObject({ language: "hi", languageChosen: false });

    await switchTo();
    expect(room.session).toMatchObject({ language: "hi", languageChosen: false });
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) =>
      new URL(String(url)).searchParams.get("language-code"),
    );
    expect(urls).toEqual(["hi-IN", "hi-IN"]);
    void sockets;
  });

  it("reports no fixed language when the operator's Sarvam code is auto-detect", async () => {
    vi.useFakeTimers();
    const { room, start } = await fixture(SARVAM, { TRANSCRIPT_SARVAM_LANGUAGE_CODE: "unknown" });
    await start();

    expect(room.session?.language).toBeUndefined();
  });
});

