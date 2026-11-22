import { describe, expect, it } from "vitest";
import { isRecoverableReconnectFailure } from "../src/app/hooks/useMeetSocket";

const refusedWith = (responseStatus: number) =>
  Object.assign(new Error("Join info request failed"), { responseStatus });

describe("whether a failed reconnect is worth another try", () => {
  it("keeps trying while the room is not back yet after a restart", () => {
    // What someone who was knocking gets until a member recreates the room.
    expect(isRecoverableReconnectFailure(new Error("No room found."))).toBe(true);
  });

  it("keeps trying when the server cannot be reached or is failing", () => {
    expect(isRecoverableReconnectFailure(new Error("websocket error"))).toBe(true);
    expect(isRecoverableReconnectFailure(new Error("Connection timeout"))).toBe(true);
    expect(isRecoverableReconnectFailure(refusedWith(503))).toBe(true);
  });

  it("stops for an answer that trying again will not change", () => {
    expect(
      isRecoverableReconnectFailure(new Error("You are not allowed to join this meeting.")),
    ).toBe(false);
    expect(isRecoverableReconnectFailure(refusedWith(403))).toBe(false);
  });
});
