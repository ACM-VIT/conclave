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
import type { Env, Viewer } from "../transcript-worker/src/types";

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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const sarvamCode = new URL(String(url)).searchParams.get("language-code");
      if (sarvamCode !== null) used.push(captionLanguageLabel(sarvamCode) ?? "Auto-detect");
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
          },
        },
      };
    }),
  );
  return used;
}

async function notesWorker(env: Partial<Env>) {
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
    { ...env } as Env,
  ) as unknown as {
    loaded: Promise<void>;
    viewers: Map<WebSocket, Viewer>;
    session: TranscriptSessionState | null;
    captionLanguageDefaults: () => MeetingTranscriptController["captionLanguageDefaults"];
    startSession: (viewer: Viewer, message: object) => Promise<void>;
  };
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
  const using = (provider: Provider) =>
    lookup.mockResolvedValue({
      SARVAM_API_KEY: "sarvam-room",
      OPENAI_API_KEY: "sk-room",
      CONCLAVE_AI_SETTINGS: JSON.stringify({ transcription: { model: MODELS[provider] } }),
    });
  const send = (provider: Provider, type: string, language: string | null | undefined) => {
    using(provider);
    const message = JSON.parse(
      JSON.stringify({ type, transcriptModel: MODELS[provider], qaModel: "gpt-6.1-sol", transportMode: "sfu", language }),
    );
    return room.startSession(viewer, message);
  };
  return { room, send };
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
    const sent = (transcript.takeover as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.language;
    await worker.send(to, "session.takeover", sent);

    expect(used.at(-1), `shown ${shown}, sent ${JSON.stringify(sent)}`).toBe(shown);
  });
});
