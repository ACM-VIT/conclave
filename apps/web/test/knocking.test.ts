import { describe, expect, it } from "vitest";
import { isKnocking, settledConnectionState } from "../src/app/lib/knocking";
import type { ConnectionState } from "../src/app/lib/types";

// The screen a tab shows as its connection moves through `states`.
const knockingThrough = (states: ConnectionState[]): boolean[] => {
  let settled: ConnectionState = "disconnected";
  return states.map((state) => {
    settled = settledConnectionState(settled, state);
    return isKnocking(state, settled);
  });
};

describe("whether a tab shows the waiting room", () => {
  it("keeps showing it while a knocking tab reconnects after a server restart", () => {
    expect(
      knockingThrough(["waiting", "reconnecting", "connecting", "connected", "joining", "waiting"]),
    ).toEqual([true, true, true, true, true, true]);
  });

  it("stops once the tab is let in, gives up, or leaves", () => {
    expect(knockingThrough(["waiting", "joining", "joined"]).at(-1)).toBe(false);
    expect(knockingThrough(["waiting", "reconnecting", "error"]).at(-1)).toBe(false);
    expect(knockingThrough(["waiting", "disconnected"]).at(-1)).toBe(false);
  });

  it("does not show it to someone on their way into a meeting for the first time", () => {
    expect(knockingThrough(["connecting", "connected", "joining"])).toEqual([false, false, false]);
  });

  it("does not show it to someone in the call who is reconnecting", () => {
    expect(knockingThrough(["joined", "reconnecting", "connecting", "joining", "joined"])).toEqual(
      [false, false, false, false, false],
    );
  });
});
