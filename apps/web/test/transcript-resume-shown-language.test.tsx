// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TranscriptPanel from "../src/app/components/TranscriptPanel";
import type { MeetingTranscriptController } from "../src/app/hooks/useMeetingTranscript";
import type { RoomAiController } from "../src/app/hooks/useRoomAi";
import { captionLanguageLabel } from "../src/app/lib/caption-languages";
import { createEmptyTranscriptMinutes } from "../src/app/lib/transcript-reducer";
import type { TranscriptSessionState } from "../src/app/lib/types";
import { TranscriptRoom } from "../transcript-worker/src/room";
import type { Env, PersistedSnapshot, Viewer } from "../transcript-worker/src/types";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@conclave/ai/room-server", async (original) => ({
  ...(await original<typeof import("@conclave/ai/room-server")>()),
  fetchRoomAiEnvironment: lookup,
}));

const MODELS = { openai: "gpt-live-transcribe", sarvam: "saaras:v3" } as const;
type Provider = keyof typeof MODELS;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

// The language each provider connection was really given, named as the
// picker names languages.
function providerConnections() {
  const used: string[] = [];
  const codes: (string | null)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const sarvamCode = new URL(String(url)).searchParams.get("language-code");
      if (sarvamCode !== null) {
        used.push(captionLanguageLabel(sarvamCode) ?? "Auto-detect");
        codes.push(sarvamCode);
      }
      return {
        status: 101,
        webSocket: {
          accept() {},
          close() {},
          addEventListener() {},
          send(raw: string) {
            const message = JSON.parse(raw);
            if (message.type !== "session.update" || sarvamCode !== null) return;
            const language = message.session?.audio?.input?.transcription?.language;
            used.push(captionLanguageLabel(language) ?? "Auto-detect");
            codes.push(language ?? null);
          },
        },
      };
    }),
  );
  return Object.assign(used, { codes });
}

async function notesWorker(env: Partial<Env>, snapshot?: PersistedSnapshot) {
  const runtimeEnv = { SARVAM_API_KEY: "sarvam-global", OPENAI_API_KEY: "sk-global", ...env } as Env;
  const snapshots: PersistedSnapshot[] = [];
  const pending: Promise<unknown>[] = [];
  const room = new TranscriptRoom(
    {
      storage: {
        get: async (key: string) => (key === "snapshot" ? structuredClone(snapshot) : undefined),
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
    runtimeEnv,
  ) as unknown as {
    loaded: Promise<void>;
    viewers: Map<WebSocket, Viewer>;
    session: TranscriptSessionState | null;
    captionLanguageDefaults: () => MeetingTranscriptController["captionLanguageDefaults"];
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
  const using = (provider: Provider) =>
    lookup.mockResolvedValue({
      SARVAM_API_KEY: "sarvam-room",
      OPENAI_API_KEY: "sk-room",
      CONCLAVE_AI_SETTINGS: JSON.stringify({ transcription: { model: MODELS[provider] } }),
    });
  const send = (
    provider: Provider,
    type: string,
    request: { language?: string | null; providerLanguage?: string } | string | undefined,
  ) => {
    using(provider);
    const fields = typeof request === "object" ? request : { language: request };
    const message = JSON.parse(
      JSON.stringify({ type, transcriptModel: MODELS[provider], qaModel: "gpt-6.1-sol", transportMode: "sfu", ...fields }),
    );
    return room.startSession(viewer, message);
  };
  const changeEnv = (next: Partial<Env>) => {
    for (const key of Object.keys(runtimeEnv) as (keyof Env)[]) delete runtimeEnv[key];
    Object.assign(runtimeEnv, next);
  };
  const saved = () => structuredClone(snapshots.at(-1)) as PersistedSnapshot;
  return { room, send, changeEnv, saved };
}

const controllerFor = (
  session: TranscriptSessionState,
  defaults: MeetingTranscriptController["captionLanguageDefaults"],
) =>
  ({
    session,
    globalProviderKeysAvailable: { openai: true, anthropic: true, sarvam: true },
    canStart: true,
    canTakeover: true,
    canStop: true,
    canPause: false,
    isController: false,
    isViewOnly: false,
    isPaused: false,
    isStreamingAudio: true,
    isServiceUpdateAvailable: false,
    supportsCaptionLanguage: true,
    captionLanguageDefaults: defaults,
    error: null,
    allSegments: [],
    qaMessages: [],
    minutes: createEmptyTranscriptMinutes(),
    start: vi.fn(async () => true),
    takeover: vi.fn(async () => true),
    stop: vi.fn(),
    exportMarkdown: () => "",
  }) as unknown as MeetingTranscriptController;

const roomUsing = (provider: Provider) =>
  ({
    ready: true,
    state: { features: { transcription: { model: MODELS[provider] } } },
  }) as unknown as RoomAiController;

const shownLanguage = () => {
  const select = container.querySelector<HTMLSelectElement>("#captions-language-start");
  const text = select?.options[select.selectedIndex]?.textContent ?? "";
  return text.replace(/^Default \((.*)\)$/, "$1");
};

const ENVS: Partial<Env>[] = [
  { TRANSCRIPT_TRANSCRIPTION_LANGUAGE: "en" },
  { TRANSCRIPT_TRANSCRIPTION_LANGUAGE: "en", TRANSCRIPT_SARVAM_LANGUAGE_CODE: "od-IN" },
  { TRANSCRIPT_TRANSCRIPTION_LANGUAGE: "ta-IN" },
];
const PICKS: Record<Provider, (string | undefined)[]> = {
  sarvam: [undefined, "hi", "od"],
  openai: [undefined, "hi", "fr"],
};
const cases = ENVS.flatMap((env) =>
  (["sarvam", "openai"] as const).flatMap((from) =>
    PICKS[from].flatMap((pick) =>
      (["sarvam", "openai"] as const).map((to) => ({ env, from, pick, to })),
    ),
  ),
);

describe("resuming notes, the language the setup shows is the language used", () => {
  it.each(cases)("$from notes picked $pick resumed on $to with $env", async ({ env, from, pick, to }) => {
    const used = providerConnections();
    const worker = await notesWorker(env);
    await worker.send(from, "session.start", pick);
    const session = { ...worker.room.session!, status: "takeover_needed" } as TranscriptSessionState;
    const transcript = controllerFor(session, worker.room.captionLanguageDefaults());

    await act(async () =>
      root.render(<TranscriptPanel transcript={transcript} roomAi={roomUsing(to)} onClose={() => {}} />),
    );
    const shown = shownLanguage();
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    const sent = (transcript.takeover as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    await worker.send(to, "session.takeover", sent);

    expect(used.at(-1), `shown ${shown}, sent ${JSON.stringify(sent)}`).toBe(shown);
  });
});

const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};
const anyOf = <T,>(items: readonly T[], random: () => number) =>
  items[Math.floor(random() * items.length)];
const randomEnv = (random: () => number): Partial<Env> => ({
  TRANSCRIPT_TRANSCRIPTION_LANGUAGE: anyOf([undefined, "en", "ta-IN", "zh-hk", "pt-BR", "es-MX", "od-IN"], random),
  TRANSCRIPT_TRANSCRIPTION_LOCALE: anyOf([undefined, "en-IN", "ta-IN", "hi-IN"], random),
  TRANSCRIPT_SARVAM_LANGUAGE_CODE: anyOf([undefined, "unknown", "ta-IN", "en-IN", "od-IN"], random),
});
const choose = async (value: string) => {
  const select = container.querySelector<HTMLSelectElement>("#captions-language-start")!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

describe("whatever the environment did since, resuming sends exactly what the setup shows", () => {
  it.each(Array.from({ length: 200 }, (_, index) => index + 1))("seed %i", async (seed) => {
    const random = seeded(seed);
    const from = anyOf(["sarvam", "openai"] as const, random);
    const to = anyOf(["sarvam", "openai"] as const, random);
    const pick = anyOf(PICKS[from], random);
    const before = randomEnv(random);
    const after = randomEnv(random);
    const action = anyOf(["untouched", "default", "listed"] as const, random);
    const used = providerConnections();
    const worker = await notesWorker(before);
    await worker.send(from, "session.start", pick);
    const resumed = worker.room.session!;
    worker.changeEnv(after);
    const defaults = worker.room.captionLanguageDefaults();
    const transcript = controllerFor({ ...resumed, status: "takeover_needed" } as TranscriptSessionState, defaults);

    await act(async () =>
      root.render(<TranscriptPanel transcript={transcript} roomAi={roomUsing(to)} onClose={() => {}} />),
    );
    if (action === "default") await choose("");
    if (action === "listed") await choose(anyOf(PICKS[to].filter(Boolean) as string[], random));
    const select = container.querySelector<HTMLSelectElement>("#captions-language-start")!;
    const shownValue = select.value;
    const shown = shownLanguage();
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    const sent = (transcript.takeover as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    await worker.send(to, "session.takeover", sent);

    const context = JSON.stringify({ from, to, pick, before, after, action, shownValue, sent });
    expect(sent?.providerLanguage, `an exact code is always sent ${context}`).toBeTruthy();
    expect(used.at(-1), `the language used is the one shown ${context}`).toBe(shown);
    if (shownValue === "") {
      expect(used.codes.at(-1), `the default is sent as its exact code ${context}`).toBe(defaults[to]);
    } else if (action === "untouched" && from === to) {
      expect(used.codes.at(-1), `a resume keeps its exact code ${context}`).toBe(resumed.providerLanguage);
    }
  });

  it("resends the exact OpenAI regional default when someone picks Default (Chinese)", async () => {
    const used = providerConnections();
    const worker = await notesWorker({ TRANSCRIPT_TRANSCRIPTION_LANGUAGE: "zh-hk" });
    await worker.send("openai", "session.start", undefined);
    await worker.send("openai", "session.takeover", "hi");
    const transcript = controllerFor(
      { ...worker.room.session!, status: "takeover_needed" } as TranscriptSessionState,
      worker.room.captionLanguageDefaults(),
    );
    await act(async () =>
      root.render(<TranscriptPanel transcript={transcript} roomAi={roomUsing("openai")} onClose={() => {}} />),
    );
    await choose("");
    expect(shownLanguage()).toBe("Chinese");
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    await worker.send("openai", "session.takeover", (transcript.takeover as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);

    expect(used.codes).toEqual(["zh-hk", "hi", "zh-hk"]);
  });

  it("keeps Odia on a same-provider takeover after the Sarvam default moved to auto-detect", async () => {
    const used = providerConnections();
    const worker = await notesWorker({ TRANSCRIPT_SARVAM_LANGUAGE_CODE: "od-IN" });
    await worker.send("sarvam", "session.start", undefined);
    worker.changeEnv({ TRANSCRIPT_SARVAM_LANGUAGE_CODE: "unknown" });
    const transcript = controllerFor(
      { ...worker.room.session!, status: "takeover_needed" } as TranscriptSessionState,
      worker.room.captionLanguageDefaults(),
    );
    await act(async () =>
      root.render(<TranscriptPanel transcript={transcript} roomAi={roomUsing("sarvam")} onClose={() => {}} />),
    );
    expect(shownLanguage()).toBe("Odia");
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    await worker.send("sarvam", "session.takeover", (transcript.takeover as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);

    expect(used.codes).toEqual(["od-IN", "od-IN"]);
  });

  it("keeps Tamil on a same-provider takeover after the Sarvam default moved to English", async () => {
    const used = providerConnections();
    const worker = await notesWorker({ TRANSCRIPT_SARVAM_LANGUAGE_CODE: "ta-IN" });
    await worker.send("sarvam", "session.start", undefined);
    worker.changeEnv({ TRANSCRIPT_SARVAM_LANGUAGE_CODE: "en-IN" });
    const transcript = controllerFor(
      { ...worker.room.session!, status: "takeover_needed" } as TranscriptSessionState,
      worker.room.captionLanguageDefaults(),
    );
    await act(async () =>
      root.render(<TranscriptPanel transcript={transcript} roomAi={roomUsing("sarvam")} onClose={() => {}} />),
    );
    expect(shownLanguage()).toBe("Tamil");
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    await worker.send("sarvam", "session.takeover", (transcript.takeover as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);

    expect(used.codes).toEqual(["ta-IN", "ta-IN"]);
  });
});

describe("a snapshot from any earlier build resumes with the code it was sent", () => {
  type Layout = "current" | "ebfacc3d" | "staging";
  // How each build stored the code: on the session and at the root (now), at
  // the root only (ebfacc3d), or not at all (staging, which saved its config).
  const inLayout = (snapshot: PersistedSnapshot, layout: Layout): PersistedSnapshot => {
    const copy = structuredClone(snapshot) as PersistedSnapshot & {
      session: TranscriptSessionState & { providerLanguage?: string; language?: string; languageChosen?: boolean };
    };
    if (layout === "current") return copy;
    delete copy.session.providerLanguage;
    if (layout === "ebfacc3d") return copy;
    delete copy.providerLanguage;
    delete copy.session.language;
    delete copy.session.languageChosen;
    copy.transcriptionConfig = { language: "en", delay: "medium", locale: "en-IN" };
    return copy;
  };
  const before = { TRANSCRIPT_SARVAM_LANGUAGE_CODE: "od-IN" };
  const after = { TRANSCRIPT_SARVAM_LANGUAGE_CODE: "unknown" };
  // Staging saved no code, so its sessions resume as staging resumes them:
  // from the saved connection, with the environment of the restart.
  const expectedCode = (layout: Layout) => (layout === "staging" ? "unknown" : "od-IN");

  it.each(["current", "ebfacc3d", "staging"] as const)("a %s snapshot restores the same code after the environment changed", async (layout) => {
    const used = providerConnections();
    const first = await notesWorker(before);
    await first.send("sarvam", "session.start", undefined);
    const snapshot = inLayout({ ...first.saved(), session: { ...first.saved().session, keySource: "global" } }, layout);
    used.codes.length = 0;

    const restarted = await notesWorker(after, snapshot);

    expect(used.codes).toEqual([expectedCode(layout)]);
    expect(restarted.room.session?.providerLanguage).toBe(expectedCode(layout));
    expect(captionLanguageLabel(restarted.room.session?.language) ?? "Auto-detect").toBe(
      captionLanguageLabel(expectedCode(layout)) ?? "Auto-detect",
    );
  });

  it.each(["current", "ebfacc3d", "staging"] as const)("a %s snapshot resumed with the picker untouched sends the code it shows", async (layout) => {
    const used = providerConnections();
    const first = await notesWorker(before);
    await first.send("sarvam", "session.start", undefined);
    const snapshot = inLayout(first.saved(), layout);
    used.codes.length = 0;

    const restarted = await notesWorker(after, snapshot);
    expect(restarted.room.session?.status).toBe("takeover_needed");
    const transcript = controllerFor(restarted.room.session!, restarted.room.captionLanguageDefaults());
    await act(async () =>
      root.render(<TranscriptPanel transcript={transcript} roomAi={roomUsing("sarvam")} onClose={() => {}} />),
    );
    const shown = shownLanguage();
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    await restarted.send("sarvam", "session.takeover", (transcript.takeover as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);

    expect(shown).toBe(captionLanguageLabel(expectedCode(layout)) ?? "Auto-detect");
    expect(used.codes).toEqual([expectedCode(layout)]);
  });
});
