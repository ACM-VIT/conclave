import { afterEach, describe, expect, it, vi } from "vitest";
import { SINGLE_LABEL_SIZE, SINGLE_LABEL_WIDTH } from "../../../packages/apps-sdk/src/apps/wheel/web/geometry";
import { splitGraphemesFallback } from "../../../packages/apps-sdk/src/sdk/graphemes";

const DEVANAGARI_NAME = "AAAAA\u0915\u094D\u0937\u094D\u092EAAAAAAAAAA";
const MYANMAR_NAME = `A${"\u1001\u1014\u1039\u1013\u102C".repeat(4)}`;

const fitsCodePoints =
  (count: number) =>
  (text: string): number =>
    (Array.from(text).length * SINGLE_LABEL_WIDTH) / (SINGLE_LABEL_SIZE * (count + 0.5));

const fakeSegmenter = (split: (text: string) => string[]) => {
  const calls = { count: 0 };
  class FakeSegmenter {
    segment(text: string) {
      calls.count += 1;
      return split(text).map((segment) => ({ segment }));
    }
  }
  return { FakeSegmenter, calls };
};

const loadFitterWith = async (segmenter: PropertyDescriptor) => {
  vi.resetModules();
  vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { ...segmenter, configurable: true } }));
  return import("../../../packages/apps-sdk/src/apps/wheel/web/labelFit");
};

const loadFitter = (segmenter: unknown) => loadFitterWith({ value: segmenter });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("wheel label grapheme splitter choice", () => {
  it("shortens on whole clusters when the browser has no grapheme segmenter", async () => {
    const { fitSingleLabel } = await loadFitter(undefined);
    expect(fitSingleLabel(DEVANAGARI_NAME, 600, fitsCodePoints(9))?.text).toBe("AAAAA\u2026");
    expect(fitSingleLabel(MYANMAR_NAME, 600, fitsCodePoints(5))?.text).toBe("A\u1001\u2026");
  });

  it("does not trust a browser segmenter that splits Myanmar stacked consonants", async () => {
    const unicode16 = fakeSegmenter((text) =>
      splitGraphemesFallback(text).flatMap((cluster) => cluster.split(/(?<=\u1039)/u))
    );
    const { fitSingleLabel } = await loadFitter(unicode16.FakeSegmenter);
    unicode16.calls.count = 0;
    expect(fitSingleLabel(MYANMAR_NAME, 600, fitsCodePoints(5))?.text).toBe("A\u1001\u2026");
    expect(unicode16.calls.count).toBe(0);
  });

  it("does not trust a browser segmenter that cuts a Myanmar stack in the wrong place", async () => {
    const wrongCut = fakeSegmenter((text) =>
      splitGraphemesFallback(text)
        .join("\0")
        .replace(/\u1039\u1013\0\u102C/gu, "\u1039\0\u1013\u102C")
        .split("\0")
    );
    const { fitSingleLabel } = await loadFitter(wrongCut.FakeSegmenter);
    wrongCut.calls.count = 0;
    expect(fitSingleLabel(MYANMAR_NAME, 600, fitsCodePoints(5))?.text).toBe("A\u1001\u2026");
    expect(wrongCut.calls.count).toBe(0);
  });

  it("falls back when reading the browser segmenter throws", async () => {
    const { fitSingleLabel } = await loadFitterWith({
      get() {
        throw new Error("blocked");
      },
    });
    expect(fitSingleLabel(DEVANAGARI_NAME, 600, fitsCodePoints(9))?.text).toBe("AAAAA\u2026");
  });

  it("keeps using a browser segmenter that splits every probe correctly", async () => {
    const correct = fakeSegmenter(splitGraphemesFallback);
    const { fitSingleLabel } = await loadFitter(correct.FakeSegmenter);
    correct.calls.count = 0;
    expect(fitSingleLabel(DEVANAGARI_NAME, 600, fitsCodePoints(9))?.text).toBe("AAAAA\u2026");
    expect(correct.calls.count).toBeGreaterThan(0);
  });
});
