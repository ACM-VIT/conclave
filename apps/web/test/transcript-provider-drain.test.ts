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
  const switchTo = (language?: string | null) =>
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
  const broadcastPlaces = () => {
    const places = new Map<string, Set<number>>();
    for (const [raw] of (viewer.socket.send as ReturnType<typeof vi.fn>).mock.calls) {
      const message = JSON.parse(raw);
      const line = message.type === "segment.delta" ? message.delta : message.type === "segment.final" ? message.segment : null;
      if (!line) continue;
      places.set(line.itemId, (places.get(line.itemId) ?? new Set()).add(line.sequence));
    }
    return places;
  };
  const lastSnapshotSegment = (text: string) =>
    snapshots.at(-1)?.segments.find((segment) => segment.text === text);
  const snapshotCount = () => snapshots.length;
  const restartedTexts = async (snapshotIndex = snapshots.length - 1) => {
    const saved = structuredClone(snapshots[snapshotIndex]);
    const restarted = new TranscriptRoom(
      {
        storage: {
          get: async (key: string) => (key === "snapshot" ? saved : undefined),
          put: async () => {},
          delete: async () => true,
          setAlarm: async () => {},
        },
        waitUntil: () => undefined,
      } as unknown as DurableObjectState,
      { TRANSCRIPT_TRANSCRIPTION_LANGUAGE: "en", ...env } as Env,
    ) as unknown as TestRoom;
    await restarted.loaded;
    return restarted.segments.map(({ text }) => text);
  };
  const viewerSnapshot = async () => {
    await send({ type: "export.snapshot" });
    return (viewer.socket.send as ReturnType<typeof vi.fn>).mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((message) => message.type === "snapshot")
      .at(-1);
  };
  return {
    room,
    sockets,
    start,
    switchTo,
    stop,
    speak,
    commit,
    savedTexts,
    broadcastFinals,
    lastSnapshotTexts,
    lastSnapshotSegment,
    restartedTexts,
    snapshotCount,
    broadcastPlaces,
    viewerSnapshot,
  };
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
    await vi.advanceTimersByTimeAsync(10_100);
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
    await vi.advanceTimersByTimeAsync(9_100);
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

  it("saves words a replaced provider first shows after the switch, so a restart keeps them", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, lastSnapshotTexts, lastSnapshotSegment, restartedTexts } =
      await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    before.emit(openAiCommitted("late_partial"));
    await settle();

    await switchTo("hi");
    before.emit(openAiDelta("late_partial", "Shown after the switch"));
    await settle();

    expect(lastSnapshotTexts()).toContain("Shown after the switch");
    expect(lastSnapshotSegment("Shown after the switch")).toMatchObject({ isFinal: true });
    expect(await restartedTexts()).toEqual(["Shown after the switch"]);
  });

  it("saves each new word of a draining line as it is shown", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, restartedTexts } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    before.emit(openAiCommitted("item_1"));
    before.emit(openAiDelta("item_1", "Friday"));
    await settle();

    await switchTo("hi");
    before.emit(openAiDelta("item_1", " at noon"));
    await settle();

    expect(await restartedTexts()).toEqual(["Friday at noon"]);
  });

  it("keeps every drained line in the snapshot that finishes the drain", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, restartedTexts, snapshotCount } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    for (const [itemId, text] of [["item_1", "First line"], ["item_2", "Second line"]]) {
      await speak();
      await commit();
      before.emit(openAiCommitted(itemId));
      before.emit(openAiDelta(itemId, text));
      await settle();
    }

    await switchTo("hi");
    const finishing = snapshotCount();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(snapshotCount()).toBeGreaterThan(finishing);
    expect(await restartedTexts(finishing)).toEqual(["First line", "Second line"]);
    expect(before.closed).toBe(true);
  });

  it("keeps commit order when only the later commit had a partial before the switch", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, savedTexts, lastSnapshotTexts } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    before.emit(openAiCommitted("first"));
    await speak();
    await commit();
    before.emit(openAiCommitted("second"));
    before.emit(openAiDelta("second", "Second"));
    await settle();

    await switchTo("hi");
    before.emit(openAiDelta("first", "First"));
    await settle();
    expect(lastSnapshotTexts()).toEqual(["First", "Second"]);
    before.emit(openAiFinal("second", "Second."));
    before.emit(openAiFinal("first", "First."));
    await settle();

    expect(savedTexts()).toEqual(["First.", "Second."]);
  });

  it("orders reverse-arriving finals across three switches and closes every old socket", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, stop, savedTexts } = await fixture(OPENAI);
    await start("en");
    for (const [index, language] of ["en", "hi", "ta", "en"].entries()) {
      if (index > 0) await switchTo(language);
      await speak();
      await commit();
      sockets[index].emit(openAiCommitted(`item_${index}`));
      await settle();
      await vi.advanceTimersByTimeAsync(100);
    }
    for (const index of [3, 2, 0, 1]) {
      sockets[index].emit(openAiFinal(`item_${index}`, `spoken-${index}`));
      await settle();
    }

    expect(savedTexts()).toEqual(["spoken-0", "spoken-1", "spoken-2", "spoken-3"]);
    expect(sockets.map(({ closed }) => closed)).toEqual([true, true, true, false]);
    await stop();
    expect(sockets.every(({ closed }) => closed)).toBe(true);
  });

  it("Sarvam: keeps a tail when the turn before it finalized just before the switch", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, savedTexts } = await fixture(SARVAM);
    await start("hi");
    const before = sockets[0];
    await speak();
    await speak();
    before.emit(sarvamFinal("turn1", "Turn one."));
    await settle();

    await switchTo("ta");
    expect(before.closed).toBe(false);
    before.emit(sarvamFinal("turn2", "Turn two."));
    await settle();

    expect(savedTexts()).toEqual(["Turn one.", "Turn two."]);
  });

  it("Sarvam: ends three drains with unanswered flushes at their deadlines", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, stop } = await fixture(SARVAM);
    await start("hi");
    for (const language of ["ta", "bn", "en"]) {
      await speak();
      await switchTo(language);
    }
    expect(sockets.map(({ closed }) => closed)).toEqual([false, false, false, false]);

    await vi.advanceTimersByTimeAsync(10_001);
    expect(sockets.map(({ closed }) => closed)).toEqual([true, true, true, false]);
    await stop();
    expect(sockets.every(({ closed }) => closed)).toBe(true);
  });
});

describe("Sarvam drains until 10 s after its last audio", () => {
  it.each([
    [0.75, "before"],
    [2.5, "before"],
    [3.001, "before"],
    [4.2, "before"],
    [6.5, "before"],
    [0.75, "after"],
    [2.5, "after"],
    [3.001, "after"],
    [4.2, "after"],
    [6.5, "after"],
  ])(
    "keeps a second utterance %s s after the first, which arrived %s the switch",
    async (gapSeconds, firstArrives) => {
      vi.useFakeTimers();
      const { sockets, start, switchTo, speak, savedTexts } = await fixture(SARVAM);
      await start("hi");
      const before = sockets[0];
      await speak();
      const spokeAt = Date.now();

      if (firstArrives === "before") {
        before.emit(sarvamFinal("first", "First utterance."));
        await settle();
      }
      await switchTo("ta");
      if (firstArrives === "after") {
        before.emit(sarvamFinal("first", "First utterance."));
        await settle();
      }
      await vi.advanceTimersByTimeAsync(gapSeconds * 1_000);
      expect(before.closed).toBe(false);
      before.emit(sarvamFinal("second", "Second utterance."));
      await settle();

      expect(savedTexts()).toEqual(["First utterance.", "Second utterance."]);
      await vi.advanceTimersByTimeAsync(spokeAt + 10_100 - Date.now());
      expect(before.closed).toBe(true);
    },
  );
});

describe("order inside a replaced provider", () => {
  it("keeps commit order when the old provider's finals arrive reversed", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, savedTexts } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    before.emit(openAiCommitted("first"));
    await speak();
    await commit();
    before.emit(openAiCommitted("second"));
    await settle();

    await switchTo("hi");
    before.emit(openAiFinal("second", "Second."));
    before.emit(openAiFinal("first", "First."));
    await settle();

    expect(savedTexts()).toEqual(["First.", "Second."]);
  });

  it("keeps commit order for commits acknowledged after the switch", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, savedTexts } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    await speak();
    await commit();

    await switchTo("hi");
    before.emit(openAiCommitted("first"));
    before.emit(openAiCommitted("second"));
    before.emit(openAiFinal("second", "Second."));
    before.emit(openAiFinal("first", "First."));
    await settle();

    expect(savedTexts()).toEqual(["First.", "Second."]);
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
  it("tells clients the exact code each provider is sent by default, unknown for auto-detect", async () => {
    const hindi = await fixture(OPENAI, { TRANSCRIPT_SARVAM_LANGUAGE_CODE: "hi-IN" });
    expect((await hindi.viewerSnapshot())?.captionLanguageDefaults).toEqual({
      openai: "en",
      sarvam: "hi-IN",
    });

    const auto = await fixture(OPENAI, { TRANSCRIPT_SARVAM_LANGUAGE_CODE: "unknown" });
    expect((await auto.viewerSnapshot())?.captionLanguageDefaults).toEqual({
      openai: "en",
      sarvam: "unknown",
    });
  });

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

  it("resumes in the deployment default, not chosen, when the client asks for the default", async () => {
    vi.useFakeTimers();
    const { room, start, switchTo } = await fixture(OPENAI);
    await start("hi");
    expect(room.session).toMatchObject({ language: "hi", languageChosen: true });

    await switchTo(null);
    expect(room.session).toMatchObject({ language: "en", languageChosen: false });
    await switchTo();
    expect(room.session).toMatchObject({ language: "en", languageChosen: false });
  });

  it("Sarvam: goes back to auto-detect when the client asks for the default", async () => {
    vi.useFakeTimers();
    const { room, start, switchTo } = await fixture(SARVAM, { TRANSCRIPT_SARVAM_LANGUAGE_CODE: "unknown" });
    await start("hi");
    expect(room.session).toMatchObject({ language: "hi", languageChosen: true });

    await switchTo(null);
    expect(room.session?.language).toBeUndefined();
    expect(room.session?.languageChosen).toBe(false);
    const codes = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) =>
      new URL(String(url)).searchParams.get("language-code"),
    );
    expect(codes).toEqual(["hi-IN", "unknown"]);
  });

  it("Sarvam: a client that names no language keeps the deployment locale, as before", async () => {
    vi.useFakeTimers();
    const { room, start, switchTo } = await fixture(SARVAM, { TRANSCRIPT_TRANSCRIPTION_LOCALE: "ta-IN" });
    await start();
    await switchTo();

    const codes = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) =>
      new URL(String(url)).searchParams.get("language-code"),
    );
    expect(codes).toEqual(["ta-IN", "ta-IN"]);
    expect(room.session).toMatchObject({ language: "ta", languageChosen: false });
  });

  it("reports no fixed language when the operator's Sarvam code is auto-detect", async () => {
    vi.useFakeTimers();
    const { room, start } = await fixture(SARVAM, { TRANSCRIPT_SARVAM_LANGUAGE_CODE: "unknown" });
    await start();

    expect(room.session?.language).toBeUndefined();
  });
});


const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};
const shuffled = <T,>(items: T[], random: () => number) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
};

describe("caption lines across a switch keep commit order", () => {
  it.each(Array.from({ length: 300 }, (_, index) => index + 1))("seed %i", async (seed) => {
    vi.useFakeTimers();
    const random = seeded(seed);
    const { sockets, start, switchTo, speak, commit, savedTexts, broadcastPlaces } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    const oldIds = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, index) => `old_${index}`);
    const ackedBeforeSwitch = Math.floor(random() * (oldIds.length + 1));
    for (const _ of oldIds) {
      await speak();
      await commit();
    }
    const acked = new Set<string>();
    const finished = new Set<string>();
    for (const id of oldIds.slice(0, ackedBeforeSwitch)) {
      before.emit(openAiCommitted(id));
      acked.add(id);
    }
    for (const id of shuffled([...acked], random)) {
      const state = random();
      if (state < 0.75) before.emit(openAiDelta(id, `${id} so far`));
      if (state > 0.4) {
        before.emit(openAiFinal(id, `${id}.`));
        finished.add(id);
      }
    }
    await settle();

    await switchTo("hi");
    const after = sockets[1];
    const newIds = Array.from({ length: Math.floor(random() * 4) }, (_, index) => `new_${index}`);
    const oldAcks = oldIds.slice(ackedBeforeSwitch);
    const newCommits = [...newIds];
    const socketOf = (id: string) => (id.startsWith("old") ? before : after);
    for (;;) {
      const owed = [...acked].filter((id) => !finished.has(id));
      const moves = [
        ...(oldAcks.length ? ["oldAck"] : []),
        ...(newCommits.length ? ["newCommit"] : []),
        ...(owed.length ? ["final"] : []),
      ];
      if (!moves.length) break;
      const move = moves[Math.floor(random() * moves.length)];
      if (move === "oldAck") {
        const id = oldAcks.shift()!;
        before.emit(openAiCommitted(id));
        acked.add(id);
      } else if (move === "newCommit") {
        const id = newCommits.shift()!;
        await speak();
        await commit();
        after.emit(openAiCommitted(id));
        acked.add(id);
      } else {
        const id = owed[Math.floor(random() * owed.length)];
        if (random() < 0.5) socketOf(id).emit(openAiDelta(id, `${id} so far`));
        socketOf(id).emit(openAiFinal(id, `${id}.`));
        finished.add(id);
      }
      await settle();
    }

    const commitOrder = [...oldIds, ...newIds];
    expect(savedTexts()).toEqual(commitOrder.map((id) => `${id}.`));
    const places = broadcastPlaces();
    for (const id of commitOrder) expect([...(places.get(id) ?? [])], `${id} keeps one place`).toHaveLength(1);
    const placeOf = (id: string) => [...places.get(id)!][0];
    expect([...commitOrder].sort((left, right) => placeOf(left) - placeOf(right))).toEqual(commitOrder);
  });
});

describe("one place per line, fixed at commit", () => {
  it("keeps an earlier line with partial text ahead of a later line that finished before the switch", async () => {
    vi.useFakeTimers();
    const { sockets, start, switchTo, speak, commit, savedTexts, broadcastPlaces } = await fixture(OPENAI);
    await start("en");
    const before = sockets[0];
    await speak();
    await commit();
    before.emit(openAiCommitted("earlier"));
    before.emit(openAiDelta("earlier", "Earlier"));
    await speak();
    await commit();
    before.emit(openAiCommitted("later"));
    before.emit(openAiFinal("later", "Later."));
    await settle();

    await switchTo("hi");
    before.emit(openAiFinal("earlier", "Earlier."));
    await settle();

    expect(savedTexts()).toEqual(["Earlier.", "Later."]);
    expect([...broadcastPlaces().get("earlier")!]).toHaveLength(1);
  });

  it.each(Array.from({ length: 100 }, (_, index) => index + 1))("Sarvam keeps commit order, seed %i", async (seed) => {
    vi.useFakeTimers();
    const random = seeded(seed);
    const { sockets, start, switchTo, speak, savedTexts } = await fixture(SARVAM);
    await start("hi");
    const before = sockets[0];
    const oldIds = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, index) => `old_${index}`);
    const finishedBeforeSwitch = Math.floor(random() * (oldIds.length + 1));
    await speak();
    for (const id of oldIds.slice(0, finishedBeforeSwitch)) before.emit(sarvamFinal(id, `${id}.`));
    await settle();

    await switchTo("ta");
    const after = sockets[1];
    const oldLeft = oldIds.slice(finishedBeforeSwitch);
    const newLeft = Array.from({ length: Math.floor(random() * 3) }, (_, index) => `new_${index}`);
    const newIds = [...newLeft];
    while (oldLeft.length || newLeft.length) {
      const fromOld = oldLeft.length && (!newLeft.length || random() < 0.5);
      if (fromOld) {
        const id = oldLeft.shift()!;
        before.emit(sarvamFinal(id, `${id}.`));
      } else {
        const id = newLeft.shift()!;
        await speak();
        after.emit(sarvamFinal(id, `${id}.`));
      }
      await settle();
    }

    expect(savedTexts()).toEqual([...oldIds, ...newIds].map((id) => `${id}.`));
  });
});
