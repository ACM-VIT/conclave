// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TranscriptPanel from "../src/app/components/TranscriptPanel";
import type { MeetingTranscriptController } from "../src/app/hooks/useMeetingTranscript";
import type { RoomAiController } from "../src/app/hooks/useRoomAi";
import type { TranscriptSessionState } from "../src/app/lib/types";
import { createEmptyTranscriptMinutes } from "../src/app/lib/transcript-reducer";

let container: HTMLDivElement;
let root: Root;

const controller = (
  session: Partial<TranscriptSessionState>,
  overrides: Partial<MeetingTranscriptController> = {},
) =>
  ({
    session: {
      roomId: "room",
      status: "idle",
      controller: null,
      transcriptModel: "gpt-live-transcribe",
      qaModel: "gpt-6.1-sol",
      transportMode: "sfu",
      startedAt: null,
      updatedAt: 0,
      ...session,
    },
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
    error: null,
    allSegments: [],
    qaMessages: [],
    minutes: createEmptyTranscriptMinutes(),
    start: vi.fn(async () => true),
    takeover: vi.fn(async () => true),
    stop: vi.fn(),
    exportMarkdown: () => "",
    ...overrides,
  }) as unknown as MeetingTranscriptController;

async function render(
  transcript: MeetingTranscriptController,
  roomAi?: RoomAiController,
) {
  await act(async () =>
    root.render(
      <TranscriptPanel transcript={transcript} roomAi={roomAi} onClose={() => {}} />,
    ),
  );
}

const roomUsing = (transcriptionModel: string) =>
  ({
    ready: true,
    state: { features: { transcription: { model: transcriptionModel } } },
  }) as unknown as RoomAiController;

const select = (id: string) =>
  container.querySelector<HTMLSelectElement>(`#${id}`);

const choose = async (id: string, value: string) => {
  const element = select(id);
  if (!element) throw new Error(`No select #${id}`);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const clickText = async (text: string) => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`No button ${text}`);
  await act(async () => button.click());
};

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
  vi.unstubAllGlobals();
});

describe("caption language picker", () => {
  it("starts notes in the remembered language and remembers a new pick", async () => {
    window.localStorage.setItem("conclave:captions-language", "ta");
    const transcript = controller({});
    await render(transcript);

    expect(select("captions-language-start")?.value).toBe("ta");
    await choose("captions-language-start", "hi");
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });

    expect(transcript.start).toHaveBeenCalledWith(
      expect.objectContaining({ language: "hi" }),
    );
    expect(window.localStorage.getItem("conclave:captions-language")).toBe("hi");
  });

  const submit = () =>
    act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
  const sentLanguage = (call: ReturnType<typeof vi.fn>) =>
    (call.mock.calls[0]?.[0] as { language?: string } | undefined)?.language;

  it("resumes notes in their own language without naming one, so the worker keeps it", async () => {
    window.localStorage.setItem("conclave:captions-language", "en");
    const transcript = controller({ status: "takeover_needed", language: "ta" });
    await render(transcript);

    expect(select("captions-language-start")?.value).toBe("ta");
    await submit();

    expect(transcript.takeover).toHaveBeenCalled();
    expect(sentLanguage(transcript.takeover as ReturnType<typeof vi.fn>)).toBeUndefined();
  });

  it("starts without naming a language when nobody picked one, so the deployment default applies", async () => {
    const transcript = controller({});
    await render(transcript);

    expect(select("captions-language-start")?.value).toBe("en");
    await submit();

    expect(transcript.start).toHaveBeenCalled();
    expect(sentLanguage(transcript.start as ReturnType<typeof vi.fn>)).toBeUndefined();
  });

  it("names English when someone picks it", async () => {
    window.localStorage.setItem("conclave:captions-language", "hi");
    const transcript = controller({});
    await render(transcript);

    await choose("captions-language-start", "en");
    await submit();

    expect(sentLanguage(transcript.start as ReturnType<typeof vi.fn>)).toBe("en");
  });

  it("hides the language choice until the transcript worker supports it", async () => {
    const transcript = controller({}, { supportsCaptionLanguage: false });
    await render(transcript);

    expect(select("captions-language-start")).toBeNull();
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });

    expect(transcript.start).toHaveBeenCalledWith(
      expect.objectContaining({ language: undefined }),
    );
  });

  it("only offers languages Sarvam can transcribe", async () => {
    window.localStorage.setItem("conclave:captions-language", "es");
    await render(controller({}));

    await clickText("Sarvam");

    const options = Array.from(select("captions-language-start")?.options ?? []).map(
      (option) => option.value,
    );
    expect(options).toContain("hi");
    expect(options).not.toContain("es");
    expect(select("captions-language-start")?.value).toBe("en");
  });

  it("lets the controller switch the language of live captions", async () => {
    const transcript = controller(
      { status: "live", language: "hi", keySource: "global" },
      { isController: true },
    );
    await render(transcript);

    expect(select("captions-language-live")?.value).toBe("hi");
    await choose("captions-language-live", "bn");

    expect(transcript.takeover).toHaveBeenCalledWith(
      expect.objectContaining({ language: "bn" }),
    );
  });

  it("hides the live switch when the session runs on a key typed for this session", async () => {
    await render(
      controller(
        { status: "live", language: "hi", keySource: "controller" },
        { isController: true },
      ),
    );

    expect(select("captions-language-live")).toBeNull();
    expect(container.textContent).toContain("Hindi");
  });

  it("hides the live switch when the room now runs a model with other languages", async () => {
    await render(
      controller(
        { status: "live", language: "fr", keySource: "global" },
        { isController: true },
      ),
      roomUsing("saaras:v3"),
    );

    expect(select("captions-language-live")).toBeNull();
    expect(container.textContent).toContain("French");
  });

  it("keeps the live switch when the room still runs the same model", async () => {
    await render(
      controller({ status: "live", language: "fr" }, { isController: true }),
      roomUsing("gpt-live-transcribe"),
    );

    expect(select("captions-language-live")?.value).toBe("fr");
  });

  it("shows no live switch or language on a worker without caption language support", async () => {
    await render(
      controller(
        { status: "live", language: "hi", keySource: "global" },
        { isController: true, supportsCaptionLanguage: false },
      ),
    );

    expect(select("captions-language-live")).toBeNull();
    expect(container.textContent).not.toContain("Hindi");
  });

  it("hides the live switch when the worker does not report a language", async () => {
    await render(
      controller({ status: "live", keySource: "global" }, { isController: true }),
    );

    expect(select("captions-language-live")).toBeNull();
  });

  it("shows other people the language captions are in", async () => {
    await render(controller({ status: "live", language: "hi" }));

    expect(select("captions-language-live")).toBeNull();
    expect(container.textContent).toContain("Hindi");
  });
});
