import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureAuthorityScale } from "./scale.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number): void => {
  vi.advanceTimersByTime(ms);
};

describe("scale at 50 people and 100 actions a second", () => {
  it("does shared work per audience class, never per viewer", () => {
    const fifty = measureAuthorityScale(50, advance);
    const twoHundred = measureAuthorityScale(200, advance);

    expect(fifty.questions).toBeGreaterThan(280);
    expect(fifty.acceptedPerSecond).toBeGreaterThan(80);
    // Four times the viewers, the same number of projections.
    expect(twoHundred.sharedProjections).toBe(fifty.sharedProjections);
  });

  it("coalesces to at most one frame per recipient per flush", () => {
    const report = measureAuthorityScale(50, advance);

    // The runtime's own timer did the flushing: 50 ms apart, so 20 a second.
    expect(report.flushesPerSecond).toBeGreaterThan(15);
    expect(report.flushesPerSecond).toBeLessThanOrEqual(20.1);
    expect(report.maxFramesPerRecipientPerSecond).toBeLessThanOrEqual(
      report.flushesPerSecond,
    );
    expect(report.misdeliveredPersonalRows).toBe(0);
  });

  it("leaves most of a core free", () => {
    const report = measureAuthorityScale(50, advance);

    // Measured at about 1 to 3 percent of a core. The bound is loose so a
    // busy machine does not fail it; it catches an order-of-magnitude slip.
    expect(report.actCpuMsPerSecond + report.flushCpuMsPerSecond).toBeLessThan(250);
  });
});
