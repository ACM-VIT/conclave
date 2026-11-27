import type { Socket } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import {
  ROOM_LEASE_UNCONFIRMED_ERROR,
  WAITING_REQUEST_GONE_ERROR,
} from "@conclave/meeting-core/host-commands";
import { admitPendingUser, denyPendingUser } from "../src/app/lib/admissions";

const answering = (response: unknown) =>
  ({
    emit: (_event: string, _payload: unknown, ack: (answer: unknown) => void) => ack(response),
  }) as unknown as Socket;

describe.each([
  ["admitting", admitPendingUser],
  ["denying", denyPendingUser],
] as const)("%s someone who knocks", (_name, decide) => {
  it("keeps their request and says why when the meeting is moving between servers", () => {
    const onStale = vi.fn();
    const onNotice = vi.fn();
    decide(answering({ error: ROOM_LEASE_UNCONFIRMED_ERROR }), "guest-knocker", { onStale, onNotice });
    expect(onStale).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith(ROOM_LEASE_UNCONFIRMED_ERROR);
  });

  it("keeps their request when the server turns the request down for any other reason", () => {
    const onStale = vi.fn();
    const onNotice = vi.fn();
    decide(answering({ error: "Too many admin requests; please retry shortly" }), "guest-knocker", {
      onStale,
      onNotice,
    });
    expect(onStale).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalled();
  });

  it("drops their request once the server says it is gone", () => {
    const onStale = vi.fn();
    decide(answering({ error: WAITING_REQUEST_GONE_ERROR }), "guest-knocker", { onStale });
    expect(onStale).toHaveBeenCalledWith("guest-knocker");
  });
});
