// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeEnvelope } from "../../../packages/apps-sdk/src/native-embed/protocol";

vi.mock("../../../packages/apps-sdk/src/apps/wheel/web/components/WheelStage", () => ({
  WheelStage: () => null,
}));

const SCOPE = { callSessionId: "call-4-9c2e7b1a", appSessionId: "app-6f3a1d8e", appId: "wheel" };

type Posted = { type: string; requestId: string; payload: Record<string, unknown> };
type EmbedWindow = Window & {
  webkit?: { messageHandlers: { conclaveApp: { postMessage: (raw: string) => void } } };
  conclaveNativeEmbed?: { receive: (raw: string) => void };
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native wheel embed boot", () => {
  it("says ready only once it can answer, so what native asks at once is answered, not refused as not ready", async () => {
    const host = window as EmbedWindow;
    const posted: Posted[] = [];
    const send = (type: string, payload: Record<string, unknown>, requestId: string) =>
      host.conclaveNativeEmbed?.receive(encodeEnvelope(type as never, SCOPE, requestId, payload));
    host.webkit = {
      messageHandlers: {
        conclaveApp: {
          postMessage: (raw: string) => {
            const message = JSON.parse(raw) as Posted;
            posted.push(message);
            if (message.type !== "ready") return;
            send("status", { readOnly: false, connection: "live", userId: "me", userName: "Me" }, "n-1");
            send("snapshot", { syncMessage: "", stateVector: "" }, message.requestId);
            send("addOutcome", { requestId: "h-0" }, "h-1");
            send("setSounds", { value: false }, "h-2");
          },
        },
      },
    };
    window.location.hash = `#v=1&callSessionId=${SCOPE.callSessionId}&appSessionId=${SCOPE.appSessionId}&appId=wheel`;
    document.body.innerHTML = '<div id="root"></div>';

    await act(async () => {
      await import("../../../packages/apps-sdk/src/native-embed/wheel/entry");
    });

    expect(posted[0]?.type).toBe("ready");
    const acks = posted.filter((message) => message.type === "ack").map((message) => [message.requestId, message.payload]);
    expect(acks).toEqual([
      ["h-1", { ok: false, error: "notApplied" }],
      ["h-2", { ok: true }],
    ]);
  });
});
