// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { useMeetHandRaise } from "../src/app/hooks/useMeetHandRaise";

type Ack = (error: Error | null, response?: unknown) => void;

let root: Root;
let acks: Ack[];
let raised = false;
let hook: ReturnType<typeof useMeetHandRaise>;

const socket = {
  timeout: () => ({
    emit: (_event: string, _payload: unknown, ack: Ack) => {
      acks.push(ack);
    },
  }),
} as unknown as Socket;

function Harness() {
  const [isHandRaised, setIsHandRaised] = useState(false);
  const isHandRaisedRef = useRef(false);
  const socketRef = useRef<Socket | null>(socket);
  raised = isHandRaised;
  hook = useMeetHandRaise({ isHandRaised, setIsHandRaised, isHandRaisedRef, socketRef });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  acks = [];
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("rolls back an optimistic raise the server never acknowledged", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => hook.toggleHandRaised());
  expect(raised).toBe(true);
  await act(async () => acks[0](new Error("operation has timed out")));
  expect(raised).toBe(false);
});

it("does not let an older request's late failure undo a newer toggle", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => hook.setHandRaisedState(true));
  await act(async () => hook.setHandRaisedState(false));
  await act(async () => hook.setHandRaisedState(true));
  expect(raised).toBe(true);
  // The first request (raise) fails late; the newest request is still raise.
  await act(async () => acks[0](null, { error: "rate limited" }));
  expect(raised).toBe(true);
  await act(async () => acks[2](null, { success: true }));
  expect(raised).toBe(true);
});
