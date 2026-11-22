import { vi, type Mock } from "vitest";
import { TranscriptRoom } from "../transcript-worker/src/room";
import type { Env, Viewer } from "../transcript-worker/src/types";

type Listener = (event: { data?: unknown }) => void;

export class FakeProviderSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {}
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
  /** The provider drops the connection on its own. */
  disconnect() {
    for (const listener of this.listeners.get("close") ?? []) listener({});
  }
}

export type TestSegment = {
  itemId: string;
  text: string;
  sequence: number;
  startMs: number;
  isFinal?: boolean;
};

type TestRoom = {
  loaded: Promise<void>;
  session: { language?: string; languageChosen?: boolean; status?: string } | null;
  segments: TestSegment[];
  viewers: Map<WebSocket, Viewer>;
  startSession: (viewer: Viewer, message: object) => Promise<void>;
  handleMessage: (viewer: Viewer, raw: string) => Promise<void>;
  failTranscriptionPermanently: (message: string) => Promise<void>;
};

export const OPENAI = "gpt-live-transcribe";
export const SARVAM = "saaras:v3";
const AUDIO = Buffer.alloc(9600).toString("base64");

const roomSettings = (transcriptModel: string) => ({
  OPENAI_API_KEY: "sk-room",
  SARVAM_API_KEY: "sarvam-room",
  CONCLAVE_AI_SETTINGS: JSON.stringify({ transcription: { model: transcriptModel } }),
});

/**
 * A transcript room wired to fake provider sockets, with the room AI lookup
 * the test file mocks, so tests drive both providers through the real worker.
 */
export async function transcriptRoomRig(
  lookup: Mock,
  transcriptModel: string,
  env: Partial<Env> = {},
) {
  const sockets: FakeProviderSocket[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const socket = new FakeProviderSocket(String(url));
      sockets.push(socket);
      return { webSocket: socket, status: 101 };
    }),
  );
  lookup.mockResolvedValue(roomSettings(transcriptModel));
  const snapshots: { segments: TestSegment[] }[] = [];
  const room = new TranscriptRoom(
    {
      storage: {
        get: async () => undefined,
        put: async (_key: string, value: { segments: TestSegment[] }) => {
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
  let model = transcriptModel;
  const session = () => ({ transcriptModel: model, qaModel: "gpt-6.1-sol", transportMode: "sfu" });
  const start = (language?: string) =>
    room.startSession(viewer, { ...session(), type: "session.start", language });
  const switchTo = (language?: string | null) =>
    room.startSession(viewer, { ...session(), type: "session.takeover", language });
  const useModel = (next: string) => {
    model = next;
    lookup.mockResolvedValue(roomSettings(next));
  };
  const send = (message: object) => room.handleMessage(viewer, JSON.stringify(message));
  const stop = () => send({ type: "session.stop" });
  const speak = () => send({ type: "audio.chunk", audio: AUDIO });
  const commit = () => send({ type: "audio.commit" });
  const clear = () => send({ type: "audio.clear" });
  /** A turn ends as both relays end one: the last audio is committed, then cleared. */
  const endTurn = async () => {
    await commit();
    await clear();
  };
  const providerSockets = () => sockets.filter(({ url }) => /\/v1\/realtime|speech-to-text/.test(url));
  const savedTexts = () => room.segments.map(({ text }) => text);
  const sentMessages = () =>
    (viewer.socket.send as ReturnType<typeof vi.fn>).mock.calls.map(([raw]) => JSON.parse(raw));
  const broadcastFinals = () =>
    sentMessages()
      .filter((message) => message.type === "segment.final")
      .map((message) => message.segment.text);
  const lastSnapshotTexts = () => snapshots.at(-1)?.segments.map(({ text }) => text) ?? [];
  const broadcastPlaces = () => {
    const places = new Map<string, Set<number>>();
    for (const message of sentMessages()) {
      const line = message.type === "segment.delta" ? message.delta : message.type === "segment.final" ? message.segment : null;
      if (!line) continue;
      places.set(line.itemId, (places.get(line.itemId) ?? new Set()).add(line.sequence));
    }
    return places;
  };
  const lastSnapshotSegment = (text: string) =>
    snapshots.at(-1)?.segments.find((segment) => segment.text === text);
  const snapshotCount = () => snapshots.length;
  const restartedSegments = async (snapshotIndex = snapshots.length - 1) => {
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
    return restarted.segments;
  };
  const restartedTexts = async (snapshotIndex = snapshots.length - 1) =>
    (await restartedSegments(snapshotIndex)).map(({ text }) => text);
  const viewerSnapshot = async () => {
    await send({ type: "export.snapshot" });
    return sentMessages()
      .filter((message) => message.type === "snapshot")
      .at(-1);
  };
  return {
    room,
    sockets,
    providerSockets,
    start,
    switchTo,
    useModel,
    stop,
    speak,
    commit,
    clear,
    endTurn,
    savedTexts,
    broadcastFinals,
    lastSnapshotTexts,
    lastSnapshotSegment,
    restartedSegments,
    restartedTexts,
    snapshotCount,
    broadcastPlaces,
    viewerSnapshot,
  };
}

export const settle = () => vi.advanceTimersByTimeAsync(0);
export const openAiCommitted = (itemId: string) => ({ type: "input_audio_buffer.committed", item_id: itemId });
export const openAiDelta = (itemId: string, delta: string) => ({
  type: "conversation.item.input_audio_transcription.delta",
  item_id: itemId,
  delta,
});
export const openAiFinal = (itemId: string, transcript: string) => ({
  type: "conversation.item.input_audio_transcription.completed",
  item_id: itemId,
  transcript,
});
export const sarvamFinal = (requestId: string, transcript: string) => ({
  type: "data",
  data: { transcript, request_id: requestId },
});
/** Sarvam's VAD signal, as sent when the connection asks for vad_signals. */
export const sarvamSpeechStart = () => ({
  type: "events",
  data: { signal_type: "START_SPEECH", occured_at: Date.now() / 1000 },
});
export const sarvamSpeechEnd = () => ({
  type: "events",
  data: { signal_type: "END_SPEECH", occured_at: Date.now() / 1000 },
});

/** A small seeded generator, so a failing property case replays exactly. */
export const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};
