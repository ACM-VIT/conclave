// @vitest-environment happy-dom
import { act } from "react";
import type { Socket } from "socket.io-client";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TranscriptPanel from "../src/app/components/TranscriptPanel";
import RoomAiSettings from "../src/app/components/RoomAiSettings";
import { emptyRoomAiState } from "@conclave/ai/room";
import {
  useRoomAi,
  parseRoomAiState,
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

describe("AI setup UX", () => {
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
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "claude-haiku-5-5";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(configure).toHaveBeenCalledWith(
      "anthropic",
      undefined,
      "claude-haiku-5-5",
    );
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
      (button) => button.textContent === "Start notes",
    )!;
    expect(start.disabled).toBe(true);
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "gpt-5.6-terra";
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

  it("explains the sharing scope and restricts management of another participant's key", async () => {
    const state = emptyRoomAiState();
    state.openai = { source: "room", ownerId: "bob" };
    await act(async () =>
      root.render(
        <RoomAiSettings controller={roomAi({ state })} onClose={() => {}} />,
      ),
    );
    expect(container.querySelector("section")?.getAttribute("aria-label")).toBe(
      "Room AI settings",
    );
    const openai = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("OpenAI"),
    )!;
    expect(openai.disabled).toBe(true);
    expect(container.querySelector<HTMLOptionElement>('option[value="gpt-5.6-sol"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLOptionElement>('option[value="claude-sonnet-5-5"]')?.disabled).toBe(true);
    await act(async () =>
      root.render(
        <RoomAiSettings
          controller={roomAi({ state, isAdmin: true })}
          onClose={() => {}}
        />,
      ),
    );
    await act(async () => openai.click());
    expect(container.querySelector<HTMLOptionElement>('option[value="gpt-5.6-sol"]')?.disabled).toBe(false);
    expect(container.textContent).toContain("Your account is billed");
    expect(container.textContent).toContain("when the room ends");
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Remove",
      ),
    ).toBe(true);
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
