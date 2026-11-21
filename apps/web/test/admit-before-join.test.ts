import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { admitBeforeJoin, revokeAdmission } from "../src/app/lib/admissions";

type AckWithError = (error: Error | null, response?: unknown) => void;

const makeHostSocket = () => {
  let ack: AckWithError | null = null;
  const sent: Array<{ event: string; payload: unknown }> = [];
  const record = (event: string, payload: unknown, callback?: AckWithError) => {
    sent.push({ event, payload });
    ack = callback ?? null;
  };
  return {
    socket: {
      emit: vi.fn(record),
      timeout: vi.fn(() => ({ emit: record })),
    } as unknown as Socket,
    sent,
    answer: (error: Error | null, response?: unknown) => ack?.(error, response),
  };
};

describe("admitting a participant the host brings in", () => {
  it("asks the SFU to let that one key in and waits for its answer", async () => {
    const host = makeHostSocket();
    const admitted = admitBeforeJoin(host.socket, "guest-agent-session-1");

    expect(host.sent).toEqual([
      { event: "admin:allowUsers", payload: { userKeys: ["guest-agent-session-1"] } },
    ]);
    host.answer(null, { success: true });
    await expect(admitted).resolves.toBeUndefined();
  });

  it("fails when the SFU refuses, as it does for someone who is not a host", async () => {
    const host = makeHostSocket();
    const admitted = admitBeforeJoin(host.socket, "guest-agent-session-1");
    host.answer(null, { error: "Admin privileges required" });

    await expect(admitted).rejects.toThrow("Admin privileges required");
  });

  it("fails when the SFU does not answer", async () => {
    const host = makeHostSocket();
    const admitted = admitBeforeJoin(host.socket, "guest-agent-session-1");
    host.answer(new Error("operation has timed out"));

    await expect(admitted).rejects.toThrow();
  });

  it("takes the admission back when the participant is gone", async () => {
    const host = makeHostSocket();
    const revoked = revokeAdmission(host.socket, "guest-agent-session-1");

    expect(host.sent).toEqual([
      {
        event: "admin:revokeAllowedUsers",
        payload: { userKeys: ["guest-agent-session-1"] },
      },
    ]);
    host.answer(null, { success: true });
    await expect(revoked).resolves.toBeUndefined();
  });

  it("reports a revoke the SFU did not take, so it can be sent again", async () => {
    const host = makeHostSocket();
    const revoked = revokeAdmission(host.socket, "guest-agent-session-1");
    host.answer(null, { error: "Room not found" });

    await expect(revoked).rejects.toThrow("Room not found");
  });
});
