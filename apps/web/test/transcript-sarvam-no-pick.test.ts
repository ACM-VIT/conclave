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

// Staging's resolution (72a53ccc), copied so this test can compare against it:
// transcript-worker/src/utils.ts, constants.ts and transcription/sarvam.ts.
const BASE_SARVAM_CODES = new Set([
  "unknown", "en-IN", "hi-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN",
  "ta-IN", "te-IN", "as-IN", "ur-IN", "ne-IN", "kok-IN", "ks-IN", "sd-IN", "sa-IN", "sat-IN",
  "mni-IN", "brx-IN", "mai-IN", "doi-IN",
]);
const baseString = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
const baseLanguage = (value: unknown) => {
  const candidate = baseString(value, "en").trim();
  return /^[a-zA-Z-]{2,12}$/.test(candidate) ? candidate : "en";
};
const baseLocale = (value: unknown) => {
  const candidate = baseString(value, "en-IN").trim();
  return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2}$/.test(candidate) ? candidate : "en-IN";
};
const baseSarvamCode = (env: Partial<Env>, config: { language: string; locale: string }) => {
  const candidate = (env.TRANSCRIPT_SARVAM_LANGUAGE_CODE ?? config.language).trim();
  if (BASE_SARVAM_CODES.has(candidate)) return candidate;
  const locale = (config.locale || "en-IN").trim();
  return BASE_SARVAM_CODES.has(locale) ? locale : "unknown";
};
const baseStartConfig = (env: Partial<Env>) => ({
  language: baseLanguage(env.TRANSCRIPT_TRANSCRIPTION_LANGUAGE),
  delay: "medium",
  locale: baseLocale(env.TRANSCRIPT_TRANSCRIPTION_LOCALE),
});

const SARVAM = "saaras:v3";
type Snapshot = PersistedSnapshot & { session: { language?: string; languageChosen?: boolean } };

async function worker(env: Partial<Env>, saved?: Snapshot) {
  const snapshots: Snapshot[] = [];
  const pending: Promise<unknown>[] = [];
  const room = new TranscriptRoom(
    {
      storage: {
        get: async (key: string) => (key === "snapshot" ? structuredClone(saved) : undefined),
        put: async (_key: string, value: Snapshot) => {
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
    captionLanguageDefaults: () => { sarvam?: string | null };
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
  const request = (type: string, language?: string) =>
    room.startSession(viewer, { type, transcriptModel: SARVAM, qaModel: "gpt-6.1-sol", transportMode: "sfu", language });
  return {
    start: (language?: string) => request("session.start", language),
    takeover: (language?: string) => request("session.takeover", language),
    lastSnapshot: () => structuredClone(snapshots.at(-1)) as Snapshot,
    shown: () => captionLanguageLabel(room.session?.language) ?? "Auto-detect",
    shownDefault: () => captionLanguageLabel(room.captionLanguageDefaults().sarvam) ?? "Auto-detect",
  };
}

// What a code sent to Sarvam means, named the way the picker names it.
const spoken = (code: string | null | undefined) => captionLanguageLabel(code) ?? "Auto-detect";

function providerCodes() {
  const codes: (string | null)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      codes.push(new URL(String(url)).searchParams.get("language-code"));
      return { webSocket: { accept() {}, send() {}, close() {}, addEventListener() {} }, status: 101 };
    }),
  );
  lookup.mockResolvedValue({
    SARVAM_API_KEY: "sarvam-room",
    OPENAI_API_KEY: "sk-room",
    CONCLAVE_AI_SETTINGS: JSON.stringify({ transcription: { model: SARVAM } }),
  });
  return codes;
}

const LANGUAGES = [undefined, "en", "ta", "ta-IN", "hi-IN", "od-IN", "es", "not a code"];
const LOCALES = [undefined, "en-IN", "ta-IN", "hi"];
const SARVAM_CODES = [undefined, "", "unknown", "hi-IN", "ta-IN", "od-IN", "xx"];
const SAVED_SESSION_LANGUAGES = [undefined, "en", "ta", "hi"];
const combinations = LANGUAGES.flatMap((language) =>
  LOCALES.flatMap((locale) =>
    SARVAM_CODES.map((sarvamCode) => ({
      TRANSCRIPT_TRANSCRIPTION_LANGUAGE: language,
      TRANSCRIPT_TRANSCRIPTION_LOCALE: locale,
      TRANSCRIPT_SARVAM_LANGUAGE_CODE: sarvamCode,
    })),
  ),
);

describe("Sarvam with no language picked resolves exactly as staging did", () => {
  it.each(combinations)("language %j", async (env) => {
    const codes = providerCodes();
    const expected = baseSarvamCode(env, baseStartConfig(env));
    const live = await worker(env);

    await live.start();
    expect(live.shown(), "shown on start").toBe(spoken(expected));
    expect(live.shownDefault(), "shown as the default").toBe(spoken(expected));
    await live.takeover();
    expect(codes).toEqual([expected, expected]);
    expect(live.shown(), "shown on takeover").toBe(spoken(expected));

    const saved = live.lastSnapshot();
    saved.session.keySource = "global";
    const restoreFrom = async (snapshot: Snapshot) => {
      codes.length = 0;
      const restored = await worker(env, snapshot);
      return { code: codes[0], shown: restored.shown() };
    };
    for (const savedLanguage of SAVED_SESSION_LANGUAGES) {
      const fromThisWorker = structuredClone(saved);
      fromThisWorker.session.language = savedLanguage;
      fromThisWorker.session.languageChosen = false;
      expect(await restoreFrom(fromThisWorker), `saved session language ${savedLanguage}`).toEqual({
        code: expected,
        shown: spoken(expected),
      });
    }
    const fromStaging = structuredClone(saved);
    delete fromStaging.session.language;
    delete fromStaging.session.languageChosen;
    fromStaging.transcriptionConfig = baseStartConfig(env);
    expect(await restoreFrom(fromStaging), "a staging snapshot").toEqual({
      code: expected,
      shown: spoken(expected),
    });
  });

  it.each(combinations)("only a pick differs: language %j", async (env) => {
    const codes = providerCodes();
    const live = await worker(env);

    await live.start("hi");
    await live.takeover();
    expect(codes).toEqual(["hi-IN", "hi-IN"]);
  });
});
