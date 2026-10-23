// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Socket } from "socket.io-client";
import { expect, it, vi } from "vitest";
import { useMeetChat } from "../src/app/hooks/useMeetChat";
import { ConclaveAssistantApiKeyRequiredError } from "../src/app/lib/conclave-assistant";

const { stream } = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("../src/app/lib/conclave-assistant", async (original) => ({
  ...(await original<typeof import("../src/app/lib/conclave-assistant")>()),
  streamConclaveAssistant: stream,
}));

it("keeps the replacement key when another old request rejects", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  let chat!: ReturnType<typeof useMeetChat>;
  let nextMessage = 0;
  const socketRef = {
    current: {
      emit: (
        event: string,
        data: { content?: string },
        callback: (result: unknown) => void,
      ) => {
        if (event === "conclave:authorize")
          callback({ token: "fixture-token" });
        if (event === "sendChat")
          callback({
            success: true,
            message: {
              id: `message-${++nextMessage}`,
              content: data.content,
              userId: "local-user",
              displayName: "You",
              timestamp: Date.now(),
            },
          });
      },
    } as unknown as Socket,
  };
  function Harness() {
    chat = useMeetChat({ socketRef });
    return null;
  }
  const rejectors: ((error: Error) => void)[] = [];
  stream.mockImplementationOnce(
    () => new Promise((_resolve, reject) => rejectors.push(reject)),
  );
  stream.mockImplementationOnce(
    () => new Promise((_resolve, reject) => rejectors.push(reject)),
  );
  stream.mockResolvedValue({ status: "done", text: "Replied" });
  try {
    await act(async () => root.render(<Harness />));
    await act(async () =>
      chat.submitAssistantApiKey("sk-ant-old", "claude-haiku-5-5"),
    );
    await act(async () => {
      chat.sendChat("@Conclave first question");
      chat.sendChat("@Conclave second question");
    });
    expect(stream).toHaveBeenCalledTimes(2);
    await act(async () =>
      rejectors[0](
        new ConclaveAssistantApiKeyRequiredError(
          "Rejected",
          "claude-haiku-5-5",
        ),
      ),
    );
    expect(chat.assistantApiKeyPrompt.visible).toBe(true);
    await act(async () =>
      chat.submitAssistantApiKey("sk-ant-new", "claude-haiku-5-5"),
    );
    await act(async () =>
      rejectors[1](
        new ConclaveAssistantApiKeyRequiredError(
          "Rejected",
          "claude-haiku-5-5",
        ),
      ),
    );
    expect(chat.assistantApiKeyPrompt.visible).toBe(false);
    await act(async () => chat.sendChat("@Conclave third question"));
    expect(stream.mock.calls.at(-1)?.[0].apiKey).toBe("sk-ant-new");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  }
});
