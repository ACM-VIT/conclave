import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptRoom } from "../transcript-worker/src/room";
import type { Env, PersistedSnapshot, Viewer } from "../transcript-worker/src/types";
import { captionLanguageLabel } from "../src/app/lib/caption-languages";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@conclave/ai/room-server", async (original) => ({
  ...(await original<typeof import("@conclave/ai/room-server")>()),
  fetchRoomAiEnvironment: lookup,
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const MODELS = { openai: "gpt-live-transcribe", sarvam: "saaras:v3" } as const;
type Provider = keyof typeof MODELS;

function sentCodes() {
  const sent: (string | null)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const sarvamCode = new URL(String(url)).searchParams.get("language-code");
      if (sarvamCode !== null) sent.push(sarvamCode);
      return {
        status: 101,
        webSocket: {
          accept() {},
          close() {},
          addEventListener() {},
          send(raw: string) {
            const message = JSON.parse(raw);
            if (message.type === "session.update" && sarvamCode === null) {
              sent.push(message.session?.audio?.input?.transcription?.language ?? null);
            }
          },
        },
      };
    }),
  );
  return sent;
}

async function notesWorker(env: Partial<Env>, provider: Provider, saved?: PersistedSnapshot) {
  const snapshots: PersistedSnapshot[] = [];
  const pending: Promise<unknown>[] = [];
  lookup.mockResolvedValue({
    SARVAM_API_KEY: "sarvam-room",
    OPENAI_API_KEY: "sk-room",
    CONCLAVE_AI_SETTINGS: JSON.stringify({ transcription: { model: MODELS[provider] } }),
  });
  const room = new TranscriptRoom(
    {
      storage: {
        get: async (key: string) => (key === "snapshot" ? structuredClone(saved) : undefined),
        put: async (_key: string, value: PersistedSnapshot) => {
          snapshots.push(structuredClone(value));
        },
        delete: async () => true,
        setAlarm: async () => {},
      },
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    } as unknown as DurableObjectState,
    { SARVAM_API_KEY: "sarvam-global", OPENAI_API_KEY: "sk-global", ...env } as Env,
  ) as unknown as {
    loaded: Promise<void>;
    viewers: Map<WebSocket, Viewer>;
    session: { language?: string } | null;
    startSession: (viewer: Viewer, message: object) => Promise<void>;
  };
  await room.loaded;
  await Promise.all(pending);
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
  return {
    start: (language?: string) =>
      room.startSession(viewer, {
        type: "session.start",
        transcriptModel: MODELS[provider],
        qaModel: "gpt-6.1-sol",
        transportMode: "sfu",
        language,
      }),
    shown: () => captionLanguageLabel(room.session?.language) ?? "Auto-detect",
    lastSnapshot: () => structuredClone(snapshots.at(-1)) as PersistedSnapshot,
  };
}

const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};
const anyOf = <T,>(items: readonly T[], random: () => number) =>
  items[Math.floor(random() * items.length)];
const randomEnv = (random: () => number): Partial<Env> => ({
  TRANSCRIPT_TRANSCRIPTION_LANGUAGE: anyOf([undefined, "en", "ta", "ta-IN", "hi-IN", "od-IN", "fr"], random),
  TRANSCRIPT_TRANSCRIPTION_LOCALE: anyOf([undefined, "en-IN", "ta-IN", "hi-IN", "bn-IN"], random),
  TRANSCRIPT_SARVAM_LANGUAGE_CODE: anyOf([undefined, "unknown", "hi-IN", "ta-IN", "od-IN"], random),
});
const shownFor = (code: string | null | undefined) => captionLanguageLabel(code) ?? "Auto-detect";

describe("a restored session resends the code it sent, whatever the environment became", () => {
  it("keeps Tamil when the locale changes between save and restore of unpicked Sarvam notes", async () => {
    const sent = sentCodes();
    const live = await notesWorker(
      { TRANSCRIPT_TRANSCRIPTION_LANGUAGE: "en", TRANSCRIPT_TRANSCRIPTION_LOCALE: "ta-IN" },
      "sarvam",
    );
    await live.start();
    expect(sent).toEqual(["ta-IN"]);
    const snapshot = live.lastSnapshot();
    snapshot.session.keySource = "global";
    sent.length = 0;

    const restored = await notesWorker(
      { TRANSCRIPT_TRANSCRIPTION_LANGUAGE: "en", TRANSCRIPT_TRANSCRIPTION_LOCALE: "en-IN" },
      "sarvam",
      snapshot,
    );

    expect(sent).toEqual(["ta-IN"]);
    expect(restored.shown()).toBe("Tamil");
  });

  it.each(Array.from({ length: 300 }, (_, index) => index + 1))("seed %i", async (seed) => {
    const random = seeded(seed);
    const provider = anyOf(["sarvam", "openai"] as const, random);
    const pick = anyOf(
      provider === "sarvam" ? [undefined, "hi", "ta", "od", "en"] : [undefined, "hi", "fr", "en"],
      random,
    );
    const before = randomEnv(random);
    const after = randomEnv(random);
    const sent = sentCodes();

    const live = await notesWorker(before, provider);
    await live.start(pick);
    const original = sent.at(-1);
    expect(live.shown(), "shown when it started").toBe(shownFor(original));

    const snapshot = live.lastSnapshot();
    snapshot.session.keySource = "global";
    sent.length = 0;
    const restored = await notesWorker(after, provider, snapshot);

    const context = JSON.stringify({ provider, pick, before, after });
    expect(sent, `restored resends ${context}`).toEqual([original]);
    expect(restored.shown(), `restored shows ${context}`).toBe(shownFor(original));
  });
});
