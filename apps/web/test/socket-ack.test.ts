import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { emitWithAckTimeout } from "../src/app/lib/socket-ack";

type AckWithError = (error: Error | null, ...responses: unknown[]) => void;

const makeSocket = () => {
  let lastAck: AckWithError | null = null;
  const emit = vi.fn((_event: string, ...args: unknown[]) => {
    lastAck = args[args.length - 1] as AckWithError;
  });
  const timeout = vi.fn(() => ({ emit }));
  return {
    socket: { timeout } as unknown as Pick<Socket, "timeout">,
    timeout,
    emit,
    settle: (error: Error | null, ...responses: unknown[]) => lastAck?.(error, ...responses),
  };
};

describe("emitWithAckTimeout", () => {
  it("passes the payload through and delivers the server's answer", () => {
    const s = makeSocket();
    const onAck = vi.fn();
    const onLost = vi.fn();
    emitWithAckTimeout(s.socket, 15_000, onLost, "lockRoom", { locked: true }, onAck);

    expect(s.timeout).toHaveBeenCalledWith(15_000);
    expect(s.emit).toHaveBeenCalledWith("lockRoom", { locked: true }, expect.any(Function));
    s.settle(null, { success: true });
    expect(onAck).toHaveBeenCalledWith({ success: true });
    expect(onLost).not.toHaveBeenCalled();
  });

  it("supports events with no payload", () => {
    const s = makeSocket();
    const onAck = vi.fn();
    emitWithAckTimeout(s.socket, 15_000, vi.fn(), "meeting:getConfig", onAck);
    expect(s.emit).toHaveBeenCalledWith("meeting:getConfig", expect.any(Function));
    s.settle(null, { requiresInviteCode: false });
    expect(onAck).toHaveBeenCalledWith({ requiresInviteCode: false });
  });

  it("calls onLost, not the ack, when the request times out or the socket drops", () => {
    const s = makeSocket();
    const onAck = vi.fn();
    const onLost = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    emitWithAckTimeout(s.socket, 15_000, onLost, "updateDisplayName", { displayName: "A" }, onAck);
    s.settle(new Error("operation has timed out"));
    expect(onLost).toHaveBeenCalledOnce();
    expect(onAck).not.toHaveBeenCalled();
  });
});
