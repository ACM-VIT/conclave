// @vitest-environment happy-dom
import { act } from "react";
import type { Socket } from "socket.io-client";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatPanel from "../src/app/components/ChatPanel";
import TranscriptPanel from "../src/app/components/TranscriptPanel";
import RoomAiSettings from "../src/app/components/RoomAiSettings";
import { emptyRoomAiState } from "@conclave/ai/room";
import { getTranscriptResponseModelConfig } from "@conclave/ai/models";
import {
  useRoomAi,
  parseRoomAiState,
  configureRoomAiForFeature,
  type RoomAiController,
} from "../src/app/hooks/useRoomAi";
import type { MeetingTranscriptController } from "../src/app/hooks/useMeetingTranscript";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const roomAi = (
  overrides: Partial<RoomAiController> = {},
): RoomAiController => ({
  state: emptyRoomAiState(),
  ready: true,
  connected: true,
  currentUserId: "alice",
  isAdmin: false,
  configure: vi.fn().mockResolvedValue(null),
  configureFeature: vi.fn().mockResolvedValue(null),
  ...overrides,
});
const transcript = (start = vi.fn().mockResolvedValue(true)) =>
  ({
    session: {
      status: "idle",
      transcriptModel: "gpt-live-transcribe",
      qaModel: "claude-sonnet-5-5",
    },
    globalProviderKeysAvailable: { openai: true },
    canStart: true,
    allSegments: [],
    minutes: {
      summary: "",
      topics: [],
      decisions: [],
      actionItems: [],
      openQuestions: [],
      followUps: [],
    },
    start,
  }) as unknown as MeetingTranscriptController;

const openKeys = async () => act(async () => container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected]')?.parentElement?.querySelectorAll<HTMLButtonElement>('button')[1].click());
const openFeature = async (name = "Chat assistant") => act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${name} settings"]`)!.click());
const saveFeature = async () => act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));

describe("AI setup UX", () => {
  it("reflects compact Chat setup in room settings and keeps failed shares retryable", async () => {
    const state = emptyRoomAiState();
    let rejectShare = true;
    const fake = {
      connected: true,
      on: vi.fn(),
      off: vi.fn(),
      timeout: () => fake,
      emit: (event: string, ...args: unknown[]) => {
        const ack = args.at(-1) as (
          error: Error | null,
          result: unknown,
        ) => void;
        if (event === "ai:settings") return ack(null, { state });
        if (event === "ai:configure") {
          if (rejectShare) return ack(null, { error: "Could not share key." });
          const data = args[0] as { provider: "anthropic"; model?: string };
          state[data.provider] = { source: "room", ownerId: "alice" };
          state.assistantModel = data.model ?? state.assistantModel;
          return ack(null, { state });
        }
      },
    };
    const submit = vi.fn();
    function Harness() {
      const controller = useRoomAi(
        fake as unknown as Socket,
        true,
        "alice",
        false,
        "room",
      );
      return (
        <ChatPanel
          roomAi={controller}
          messages={[]}
          chatInput=""
          currentUserId="alice"
          onInputChange={() => {}}
          onSend={() => {}}
          onSendGif={() => {}}
          onSendImage={async () => false}
          onClose={() => {}}
          assistantApiKeyPrompt={{
            visible: true,
            error: null,
            model: "claude-haiku-5-5",
          }}
          onSubmitAssistantApiKey={submit}
        />
      );
    }
    await act(async () => root.render(<Harness />));
    const input = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "sk-ant-room-fixture");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const connect = () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Share & connect")!
        .click();
    await act(async () => connect());
    expect(submit).not.toHaveBeenCalled();
    expect(input.value).toBe("sk-ant-room-fixture");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not share key.",
    );
    rejectShare = false;
    await act(async () => connect());
    expect(submit).toHaveBeenCalledWith("", "claude-haiku-5-5");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Room settings")!
        .click(),
    );
    await openKeys();
    expect(
      container.querySelector('[aria-label="Anthropic settings"]')?.textContent,
    ).toContain("Room key");
    expect(
      container.querySelector('[aria-label="Sarvam settings"]')?.textContent,
    ).toContain("Not set");
    expect(container.textContent).not.toContain("sk-ant-room-fixture");
  });

  it("stops compact setup when sharing fails, and never selects text for an audio-only key", async () => {
    const configure = vi.fn().mockResolvedValueOnce("Disconnected");
    const controller = roomAi({ configure });
    expect(
      await configureRoomAiForFeature(
        controller,
        { sarvam: "sarvam-fixture", anthropic: "sk-ant-fixture" },
        "claude-haiku-5-5",
      ),
    ).toBe("Disconnected");
    expect(configure).toHaveBeenCalledTimes(1);
    configure.mockReset().mockResolvedValue(null);
    expect(
      await configureRoomAiForFeature(
        controller,
        { sarvam: "sarvam-fixture" },
        "claude-haiku-5-5",
      ),
    ).toBeNull();
    expect(configure).toHaveBeenCalledExactlyOnceWith(
      "sarvam",
      "sarvam-fixture",
      null,
    );
  });
  it("clears a personal catalog and explains refresh when the draft key is invalid", async () => {
    const requestModels = vi.fn().mockResolvedValue([
      {
        provider: "anthropic",
        source: "live",
        models: [getTranscriptResponseModelConfig("claude-sonnet-5-6")],
      },
    ]);
    await act(async () =>
      root.render(
        <TranscriptPanel
          roomAi={roomAi({ requestModels })}
          transcript={transcript()}
          onClose={() => {}}
        />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    const fill = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await fill("sk-ant-personal-fixture");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(
      container.querySelector('option[value="claude-sonnet-5-6"]'),
    ).not.toBeNull();
    requestModels.mockClear();
    await fill("sk-ant-");
    expect(
      container.querySelector('option[value="claude-sonnet-5-6"]'),
    ).toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Refresh available models"]',
        )!
        .click(),
    );
    expect(container.textContent).toContain(
      "Enter a valid provider key to refresh models.",
    );
    expect(requestModels).not.toHaveBeenCalled();
  });

  it("keeps a notes key when selecting another model from the same provider", async () => {
    const start = vi.fn().mockResolvedValue(true);
    const notes = transcript(start);
    const configure = vi.fn().mockResolvedValue(null);
    await act(async () =>
      root.render(
        <TranscriptPanel
          roomAi={roomAi({ configure })}
          transcript={notes}
          onClose={() => {}}
        />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "sk-ant-personal-fixture");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "claude-haiku-5-5";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(input.value).toBe("sk-ant-personal-fixture");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantApiKey: undefined,
        qaModel: "claude-haiku-5-5",
      }),
    );
    expect(configure).toHaveBeenCalledWith(
      "anthropic",
      "sk-ant-personal-fixture",
      "claude-haiku-5-5",
    );
  });

  it("shares an audio-only OpenAI key without selecting an assistant model", async () => {
    const configure = vi.fn().mockResolvedValue(null);
    const requestModels = vi
      .fn()
      .mockResolvedValue([{ provider: "openai", source: "live", models: [] }]);
    await act(async () =>
      root.render(
        <RoomAiSettings
          controller={roomAi({ configure, requestModels })}
          onClose={() => {}}
        />,
      ),
    );
    await openKeys();
    const row = container.querySelector(
      '[role="group"][aria-label="OpenAI settings"]',
    )!;
    await act(async () =>
      row.querySelector<HTMLButtonElement>("button")!.click(),
    );
    const input = row.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "sk-audio-only-fixture");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      row
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(configure).toHaveBeenCalledWith(
      "openai",
      "sk-audio-only-fixture",
      null,
    );
    expect(row.querySelector('[role="status"]')?.textContent).toBe(
      "Key shared with room",
    );
  });

  it("discovers notes models with the audio key when OpenAI reuses that credential", async () => {
    const requestModels = vi.fn().mockResolvedValue([
      {
        provider: "openai",
        source: "live",
        models: [getTranscriptResponseModelConfig("gpt-6.2-sol")],
      },
    ]);
    const notes = transcript();
    notes.session.qaModel = "gpt-6.1-sol";
    notes.globalProviderKeysAvailable = {};
    await act(async () =>
      root.render(
        <TranscriptPanel
          roomAi={roomAi({ requestModels })}
          transcript={notes}
          onClose={() => {}}
        />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "sk-reused-audio-key-fixture");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(requestModels).toHaveBeenLastCalledWith({
      provider: "openai",
      apiKey: "sk-reused-audio-key-fixture",
      refresh: false,
    });
    expect(
      container.querySelector('option[value="gpt-6.2-sol"]'),
    ).not.toBeNull();
  });

  it("loads account models, selects a newly discovered model and explicitly refreshes availability", async () => {
    const requestModels = vi.fn().mockResolvedValue([
      {
        provider: "openai",
        source: "live",
        models: [getTranscriptResponseModelConfig("gpt-6.2-sol")],
      },
      { provider: "anthropic", source: "live", models: [] },
    ]);
    const configureFeature = vi.fn().mockResolvedValue(null);
    await act(async () =>
      root.render(
        <RoomAiSettings
          controller={roomAi({ isAdmin: true, requestModels, configureFeature })}
          onClose={() => {}}
        />,
      ),
    );
    await openFeature();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const select = container.querySelector("select")!;
    expect([...select.options].map((option) => option.value)).toEqual([
      "gpt-6.1-sol",
      "gpt-6.2-sol",
    ]);
    await act(async () => {
      select.value = "gpt-6.2-sol";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await saveFeature();
    expect(configureFeature).toHaveBeenCalledWith("assistant", expect.objectContaining({model: "gpt-6.2-sol", maxOutputTokens: 32768, researchTokens: 16384}));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Refresh available models"]',
        )!
        .click(),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(requestModels).toHaveBeenLastCalledWith({ refresh: true });
  });

  it("discards an old model response after room credentials change", async () => {
    let resolveOld!: (value: unknown) => void;
    const requestModels = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue([
        {
          provider: "anthropic",
          source: "live",
          models: [getTranscriptResponseModelConfig("claude-sonnet-5-6")],
        },
      ]);
    const first = roomAi({ requestModels, isAdmin: true });
    await act(async () =>
      root.render(<RoomAiSettings controller={first} onClose={() => {}} />),
    );
    await openFeature();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () =>
      root.render(
        <RoomAiSettings
          controller={{ ...first, state: { ...first.state } }}
          onClose={() => {}}
        />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () =>
      resolveOld([
        {
          provider: "openai",
          source: "live",
          models: [getTranscriptResponseModelConfig("gpt-6.2-sol")],
        },
      ]),
    );
    expect(
      container.querySelector('option[value="claude-sonnet-5-6"]'),
    ).not.toBeNull();
    expect(container.querySelector('option[value="gpt-6.2-sol"]')).toBeNull();
  });
  it("keeps key feedback in its provider row and exposes feature labels and model selection", async () => {
    const configure = vi.fn().mockResolvedValue(null);
    await act(async () =>
      root.render(
        <RoomAiSettings
          controller={roomAi({ configure, isAdmin: true })}
          onClose={() => {}}
        />,
      ),
    );
    await openKeys();
    const row = container.querySelector(
      '[role="group"][aria-label="Anthropic settings"]',
    )!;
    await act(async () =>
      row.querySelector<HTMLButtonElement>("button")!.click(),
    );
    const input = row.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "sk-ant-fixture");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      row
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(configure).toHaveBeenCalledWith("anthropic", "sk-ant-fixture");
    expect(row.querySelector('[role="status"]')?.textContent).toBe(
      "Key shared with room",
    );
    expect(
      container
        .querySelector('[aria-label="Sarvam settings"]')
        ?.querySelector('[role="status"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[role="img"][aria-label="Image safety"] [role="tooltip"]',
      )?.textContent,
    ).toBe("Image safety");
    expect(container.querySelector(".lucide-sparkles")).toBeNull();
  });

  it("shows independent feature defaults and keeps detailed controls collapsed", async () => {
    await act(async () => root.render(<RoomAiSettings controller={roomAi()} onClose={() => {}} />));
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector('[aria-label="Chat assistant settings"]')?.textContent).toContain("GPT-6.1 Sol");
    expect(container.querySelector('[aria-label="Games settings"]')?.textContent).toContain("GPT-6 Luna");
    await openFeature();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Output tokens"]')?.value).toBe("32768");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Research tokens"]')?.value).toBe("16384");
  });

  it("keeps an unsaved feature draft when unrelated room metadata rerenders", async () => {
    const controller = roomAi({isAdmin: true});
    const render = () => root.render(<RoomAiSettings controller={{...controller, state: {...controller.state}}} onClose={() => {}} />);
    await act(async () => render());
    await openFeature();
    const output = container.querySelector<HTMLInputElement>('[aria-label="Output tokens"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(output, "64000");
      output.dispatchEvent(new Event("input", {bubbles: true}));
    });
    await act(async () => render());
    expect(output.value).toBe("64000");
    await saveFeature();
    expect(controller.configureFeature).toHaveBeenCalledWith("assistant", expect.objectContaining({maxOutputTokens: 64000}));
  });

  it.each([false, true])("starts notes with questions disabled and enabled minutes %s", async minutesEnabled => {
    const state = emptyRoomAiState();
    state.sarvam = {source: "room", ownerId: "alice"};
    state.anthropic = {source: "room", ownerId: "alice"};
    state.features = {transcription: {model: "saaras:v3"}, questions: {enabled: false, model: "gpt-6.1-sol"}, minutes: {enabled: minutesEnabled, model: "claude-haiku-5-5"}};
    const start = vi.fn().mockResolvedValue(true);
    const notes = {...transcript(start), globalProviderKeysAvailable: {}};
    await act(async () => root.render(<TranscriptPanel transcript={notes} roomAi={roomAi({state})} onClose={() => {}} />));
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(false);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("requests the missing minutes provider key without changing independently configured models", async () => {
    const state = emptyRoomAiState();
    state.sarvam = {source: "room", ownerId: "alice"};
    state.anthropic = {source: "room", ownerId: "alice"};
    state.features = {transcription: {model: "saaras:v3"}, minutes: {model: "gpt-6.1-sol"}, questions: {model: "claude-haiku-5-5"}};
    const configure = vi.fn().mockResolvedValue(null), configureFeature = vi.fn().mockResolvedValue(null), start = vi.fn().mockResolvedValue(true);
    await act(async () => root.render(<TranscriptPanel transcript={{...transcript(start), globalProviderKeysAvailable: {}}} roomAi={roomAi({state, configure, configureFeature})} onClose={() => {}} />));
    const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(key.parentElement?.textContent).toContain("OpenAI");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(key, "sk-minutes-fixture");
      key.dispatchEvent(new Event("input", {bubbles: true}));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
    expect(configure).toHaveBeenCalledWith("openai", "sk-minutes-fixture", null);
    expect(configureFeature).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("preserves the audio draft when the shared assistant changes", async () => {
    const start = vi.fn().mockResolvedValue(true);
    const notes = transcript(start);
    const state = emptyRoomAiState();
    const render = () =>
      root.render(
        <TranscriptPanel
          transcript={notes}
          roomAi={roomAi({ state: { ...state } })}
          onClose={() => {}}
        />,
      );
    await act(async () => render());
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === "Sarvam")!
        .click(),
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "sarvam-draft-key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    state.assistantModel = "claude-haiku-5-5";
    state.anthropic = { source: "room", ownerId: "alice" };
    await act(async () => render());
    expect(
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === "Sarvam")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      container.querySelector<HTMLInputElement>('input[type="password"]')
        ?.value,
    ).toBe("sarvam-draft-key");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptModel: "saaras:v3",
        apiKey: undefined,
        qaModel: "claude-haiku-5-5",
      }),
    );
  });

  it("keeps a rejected personal key replaceable when a room key is also available", async () => {
    const state = emptyRoomAiState();
    state.anthropic = { source: "room", ownerId: "bob" };
    const submit = vi.fn();
    await act(async () =>
      root.render(
        <ChatPanel
          roomAi={roomAi({ state })}
          messages={[]}
          chatInput=""
          currentUserId="alice"
          onInputChange={() => {}}
          onSend={() => {}}
          onSendGif={() => {}}
          onSendImage={async () => false}
          onClose={() => {}}
          assistantApiKeyPrompt={{
            visible: true,
            error: "Replace your rejected key.",
            model: "claude-haiku-5-5",
            replacePersonalKey: true,
          }}
          onSubmitAssistantApiKey={submit}
        />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "sk-ant-replacement");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Share & connect")!
        .click(),
    );
    expect(submit).toHaveBeenCalledWith("", "claude-haiku-5-5");
  });

  it("uses the room assistant model for notes setup", async () => {
    const state = emptyRoomAiState();
    state.assistantModel = "claude-haiku-5-5";
    state.anthropic = { source: "room", ownerId: "alice" };
    await act(async () =>
      root.render(
        <TranscriptPanel
          transcript={transcript()}
          roomAi={roomAi({ state })}
          onClose={() => {}}
        />,
      ),
    );
    expect(container.querySelector("select")?.value).toBe("claude-haiku-5-5");
  });

  it("separates transcription coverage from the selected assistant's missing key", async () => {
    await act(async () =>
      root.render(
        <TranscriptPanel
          transcript={transcript()}
          roomAi={roomAi()}
          onClose={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain("Audio transcription");
    expect(container.textContent).toContain("Assistant");
    expect(container.textContent).toContain("Conclave key");
    const input = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    expect(input?.closest("label")?.textContent).toContain("Anthropic key");
    const start = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Share & start notes",
    )!;
    expect(start.disabled).toBe(true);
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "gpt-6.1-sol";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(start.disabled).toBe(false);
  });

  it("starts Claude notes with room credentials without asking for a duplicate key", async () => {
    const start = vi.fn().mockResolvedValue(true);
    const state = emptyRoomAiState();
    state.anthropic = { source: "room", ownerId: "bob" };
    await act(async () =>
      root.render(
        <TranscriptPanel
          transcript={transcript(start)}
          roomAi={roomAi({ state })}
          onClose={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain("Room key");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: undefined,
        assistantApiKey: undefined,
        qaModel: "claude-sonnet-5-5",
      }),
    );
  });

  it("restricts another participant's keys and feature controls, while hosts can manage them", async () => {
    const state = emptyRoomAiState(); state.openai = {source: "room", ownerId: "bob"};
    const render = (isAdmin: boolean) => root.render(<RoomAiSettings controller={roomAi({state, isAdmin})} onClose={() => {}} />);
    await act(async () => render(false));
    await openFeature();
    expect(container.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true);
    await openKeys();
    const row = () => container.querySelector('[role="group"][aria-label="OpenAI settings"]')!;
    expect(row().querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    await act(async () => render(true));
    await act(async () => row().querySelector<HTMLButtonElement>('button')!.click());
    expect(container.textContent).toContain("Your account is billed");
    expect(container.textContent).toContain("when the room ends");
    expect([...container.querySelectorAll('button')].some(button => button.textContent === "Remove")).toBe(true);
  });

  it("discards credentials and unexpected fields from incoming public metadata", () => {
    expect(
      parseRoomAiState({
        ...emptyRoomAiState(),
        openai: { source: "room", ownerId: "alice", apiKey: "sk-never-state" },
      }),
    ).toEqual({
      ...emptyRoomAiState(),
      openai: { source: "room", ownerId: "alice" },
    });
    expect(parseRoomAiState({ openai: { source: "room" } })).toBeNull();
  });
  it.each([false, true])(
    "loads after room rejoin even if the initial request was rejected: %s",
    async (rejectedBeforeJoin) => {
      const listeners = new Map<string, (value?: unknown) => void>();
      const requests: { event: string; args: unknown[] }[] = [];
      const fake = {
        connected: true,
        timeout: () => fake,
        on: (event: string, handler: (value?: unknown) => void) => {
          listeners.set(event, handler);
        },
        off: (event: string) => {
          listeners.delete(event);
        },
        emit: (event: string, ...args: unknown[]) => {
          requests.push({ event, args });
        },
      };
      let controller: RoomAiController;
      function Harness() {
        controller = useRoomAi(
          fake as unknown as Socket,
          true,
          "alice",
          false,
          "room",
        );
        return null;
      }
      const ack = (request: (typeof requests)[number], state: unknown) =>
        (request.args.at(-1) as (error: Error | null, result: unknown) => void)(
          null,
          { state },
        );
      await act(async () => root.render(<Harness />));
      const state = emptyRoomAiState();
      state.openai = { source: "room", ownerId: "alice" };
      if (rejectedBeforeJoin) {
        await act(async () => {
          (
            requests[0].args.at(-1) as (
              error: Error | null,
              result: unknown,
            ) => void
          )(null, { error: "Join the meeting first." });
        });
        expect(controller!.ready).toBe(false);
        await act(async () => {
          listeners.get("ai:changed")!(state);
        });
      } else {
        await act(async () => {
          ack(requests[0], state);
        });
      }
      expect(controller!.ready).toBe(true);
      let pending: Promise<string | null>;
      await act(async () => {
        pending = controller!.configure("anthropic", "sk-ant-fixture");
      });
      expect(requests[1].args[0]).toEqual({
        roomId: "room",
        provider: "anthropic",
        apiKey: "sk-ant-fixture",
      });
      await act(async () => {
        fake.connected = false;
        listeners.get("disconnect")!();
        ack(requests[1], state);
      });
      expect(await pending!).toContain("connection changed");
      expect(controller!.ready).toBe(false);
      expect(controller!.state.openai.source).toBeNull();
      await act(async () => {
        fake.connected = true;
        listeners.get("connect")!();
      });
      expect(requests).toHaveLength(2);
      expect(controller!.ready).toBe(false);
      await act(async () => {
        listeners.get("ai:changed")!(state);
      });
      expect(controller!.ready).toBe(true);
      expect(controller!.state.openai.source).toBe("room");
    },
  );
});
