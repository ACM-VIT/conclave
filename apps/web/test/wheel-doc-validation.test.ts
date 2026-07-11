import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  MAX_WHEEL_ENTRIES,
  createWheelDoc,
  getEntries,
  getSpin,
  type WheelSpin,
} from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";

const validSpin = (): WheelSpin => ({
  spinId: "spin-1",
  entries: [
    { id: "one", label: "One" },
    { id: "two", label: "Two" },
  ],
  winnerIndex: 0,
  startedAt: Date.now(),
  durationMs: 8_000,
  turns: 8,
  jitter: 0.5,
  spunById: "user-1",
  spunByName: "Host",
});

describe("wheel document validation", () => {
  it("rejects oversized spin snapshots", () => {
    const doc = createWheelDoc();
    doc.getMap("wheel").set("spin", {
      ...validSpin(),
      entries: Array.from({ length: MAX_WHEEL_ENTRIES + 1 }, (_, index) => ({
        id: `entry-${index}`,
        label: `Entry ${index}`,
      })),
    });

    expect(getSpin(doc)).toBeNull();
  });

  it.each([
    { durationMs: Number.POSITIVE_INFINITY },
    { durationMs: 60_000 },
    { turns: Number.POSITIVE_INFINITY },
    { turns: 100 },
    { jitter: -1 },
    { jitter: 2 },
  ])("rejects unsafe animation parameters: %o", (override) => {
    const doc = createWheelDoc();
    doc.getMap("wheel").set("spin", { ...validSpin(), ...override });

    expect(getSpin(doc)).toBeNull();
  });

  it("drops entries with oversized labels", () => {
    const doc = createWheelDoc();
    const wheelEntries = new Y.Array<unknown>();
    doc.getMap("wheel").set("entries", wheelEntries);
    wheelEntries.push([
      { id: "valid", label: "Valid" },
      { id: "long", label: "x".repeat(200) },
    ]);

    expect(getEntries(doc)).toEqual([{ id: "valid", label: "Valid" }]);
  });
});
