import { describe, expect, it } from "vitest";
import {
  COMPANION_RAIL,
  PARTICIPANT_RAIL,
  STAGE_GAP,
  STAGE_MAIN_MIN,
  chooseStageSplit,
  stageMainSize,
  stageSplitCandidates,
} from "../src/app/lib/stage-split";

const fitted = (size: { width: number; height: number }) => {
  const width = Math.min(size.width, (size.height * 16) / 9);
  return width * ((width * 9) / 16);
};

describe("chooseStageSplit", () => {
  it.each([
    ["640 x 800, chat open", 216, 664, "stack"],
    ["768 x 800, chat open", 344, 664, "stack"],
    ["768 x 300, chat open", 344, 164, "side"],
    ["768 x 275, chat open", 344, 139, "side"],
    ["640 x 275, chat open", 216, 139, "main-only"],
    ["1280 x 800, chat closed", 1216, 664, "side"],
    ["1024 x 600, chat closed", 960, 464, "side"],
  ] as const)("participant rail at %s", (_label, width, height, mode) => {
    expect(chooseStageSplit({ width, height }, PARTICIPANT_RAIL).mode).toBe(mode);
  });

  it("keeps the main surface at its minimum size whenever a rail is shown", () => {
    for (const rail of [PARTICIPANT_RAIL, COMPANION_RAIL]) {
      for (let width = 120; width <= 1600; width += 13) {
        for (let height = 60; height <= 1000; height += 11) {
          const split = chooseStageSplit({ width, height }, rail);
          const main = stageMainSize({ width, height }, split);
          if (split.mode === "main-only") {
            expect(main).toEqual({ width, height });
            continue;
          }
          expect(main.width).toBeGreaterThanOrEqual(STAGE_MAIN_MIN.width);
          expect(main.height).toBeGreaterThanOrEqual(STAGE_MAIN_MIN.height);
          const railSpan = split.mode === "side" ? width : height;
          expect(split.railSize + STAGE_GAP).toBeLessThanOrEqual(railSpan);
          if (split.mode === "side") {
            expect(split.railSize).toBeGreaterThanOrEqual(rail.sideMin);
            expect(split.railSize).toBeLessThanOrEqual(rail.sideMax);
          } else {
            expect(split.railSize).toBeGreaterThanOrEqual(rail.stackMin);
            expect(split.railSize).toBeLessThanOrEqual(rail.stackMax);
          }
        }
      }
    }
  });

  it("gives the main surface the largest 16:9 area of the arrangements that fit", () => {
    for (let width = 200; width <= 1600; width += 37) {
      for (let height = 100; height <= 1000; height += 31) {
        const size = { width, height };
        const split = chooseStageSplit(size, PARTICIPANT_RAIL);
        const candidates = stageSplitCandidates(size, PARTICIPANT_RAIL);
        if (candidates.length === 0) {
          expect(split.mode).toBe("main-only");
          continue;
        }
        const best = Math.max(
          ...candidates.map((candidate) => fitted(stageMainSize(size, candidate))),
        );
        expect(fitted(stageMainSize(size, split))).toBe(best);
      }
    }
  });

  it("keeps a side rail before the stage is measured", () => {
    expect(chooseStageSplit(null, PARTICIPANT_RAIL)).toEqual({
      mode: "side",
      railSize: PARTICIPANT_RAIL.sideMin,
    });
  });
});
