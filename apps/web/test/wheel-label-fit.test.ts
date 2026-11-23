import { describe, expect, it } from "vitest";
import {
  SINGLE_LABEL_SIZE,
  SINGLE_LABEL_WIDTH,
  pxPerUnitFor,
} from "../../../packages/apps-sdk/src/apps/wheel/web/geometry";
import {
  fitSingleLabel,
  fitWheelLabels,
  graphemes,
  splitGraphemesFallback,
  isLabelFlipped,
  wheelLabelGeometry,
  type LabelGeometry,
  type MeasureText,
} from "../../../packages/apps-sdk/src/apps/wheel/web/labelFit";

const WIDE = new Set(["M", "W", "H", "m", "w"]);
const measure: MeasureText = (text) =>
  Array.from(text).reduce((width, character) => width + (WIDE.has(character) ? 0.8 : 0.55), 0);

const geometry = (count: number, wheelPx = 700): LabelGeometry => wheelLabelGeometry(count, wheelPx);

const fitsInSlice = (text: string, fontSize: number, shape: LabelGeometry): boolean => {
  const innerEnd = shape.outerRadius - measure(text) * fontSize;
  const halfWidthAtInnerEnd = innerEnd * Math.tan(Math.PI / shape.count);
  return innerEnd >= shape.innerRadius - 1e-9 && halfWidthAtInnerEnd >= fontSize / 2;
};

const restingRotation = (winnerIndex: number, count: number, jitter = 0.5): number =>
  90 - (winnerIndex + jitter) * (360 / count);

const screenAngle = (index: number, count: number, rotation: number): number =>
  (((360 / count) * (index + 0.5) + rotation) % 360 + 360) % 360;

describe("wheel label fitting", () => {
  const twelve = ["Ada", "Grace", "Linus", "Margaret", "Alan", "Barbara", "Dennis", "Katherine", "Ken", "Radia", "Tim", "Frances"];

  it("shows every short name in full, at one shared size, inside its slice", () => {
    const shape = geometry(12);
    const fitted = fitWheelLabels(twelve, shape, measure);
    expect(fitted.labels.map((label) => label?.text)).toEqual(twelve);
    for (const label of fitted.labels) {
      expect(fitsInSlice(label!.text, fitted.fontSize, shape)).toBe(true);
    }
  });

  it("cuts a long name with an ellipsis instead of running it under the hub", () => {
    const names = ["Ada", "Grace", "Linus", "Margaret", "Alan", "Maximiliana Featherstonehaugh-Worthington"];
    const shape = geometry(names.length);
    const fitted = fitWheelLabels(names, shape, measure);
    const long = fitted.labels[5]!;
    expect(long.truncated).toBe(true);
    expect(long.text.endsWith("…")).toBe(true);
    expect(names[5].startsWith(long.text.slice(0, -1))).toBe(true);
    expect(fitsInSlice(long.text, fitted.fontSize, shape)).toBe(true);
    expect(fitted.labels.slice(0, 5).map((label) => label?.text)).toEqual(names.slice(0, 5));
  });

  it("does not shrink every name because of one long outlier", () => {
    const short = twelve.slice(0, 11);
    const alone = fitWheelLabels(short, geometry(11), measure);
    const withOutlier = fitWheelLabels([...short, "A name that is far too long for any slice"], geometry(12), measure);
    expect(withOutlier.fontSize).toBeGreaterThanOrEqual(alone.fontSize * 0.9);
    expect(withOutlier.labels.slice(0, 11).every((label) => label && !label.truncated)).toBe(true);
    expect(withOutlier.labels[11]?.truncated).toBe(true);
  });

  it("fits all 40 names without truncating the one that sets the size", () => {
    const base = ["Ava", "Ben", "Cleo", "Dev", "Eli", "Fay", "Gus", "Hana", "Ivo", "Jun", "Kai", "Lea", "Mo", "Nia", "Oto", "Pia", "Quin", "Rae", "Sol", "Tia"];
    const forty = [...base, ...base.map((name, i) => `${name} ${String.fromCharCode(65 + i)}.`)];
    const shape = geometry(40);
    const fitted = fitWheelLabels(forty, shape, measure);
    expect(fitted.labels.every((label) => label && !label.truncated)).toBe(true);
    expect(fitted.labels.map((label) => label?.text)).toEqual(forty);
    expect(fitted.fontSize * shape.pxPerUnit).toBeGreaterThanOrEqual(shape.minScreenPx);
    for (const label of fitted.labels) {
      expect(fitsInSlice(label!.text, fitted.fontSize, shape)).toBe(true);
    }
  });

  it("hides every label on a small wheel rather than showing stubs", () => {
    const names = ["Ava", "Ben", "Cleo", "Dev", "Eli", "Fay", "Gus", "Hana", "Ivo", "Jun", "Kai", "Lea", "Mo", "Nia", "Oto", "Pia", "Quin", "Rae", "Sol", "Tia"];
    const forty = [...names, ...names.map((name, i) => `${name} ${String.fromCharCode(65 + i)}.`)];
    const phoneWheel = fitWheelLabels(forty, geometry(40, 218), measure);
    expect(phoneWheel.labels.every((label) => label === null)).toBe(true);
  });

  it("cuts a lone long name to the width of the wheel, and hides it on a tiny wheel", () => {
    const name = "Maximiliana Featherstonehaugh-Worthington of Somewhere";
    const text = fitSingleLabel(name, 600, measure)!;
    expect(text.endsWith("…")).toBe(true);
    expect(measure(text) * SINGLE_LABEL_SIZE).toBeLessThanOrEqual(SINGLE_LABEL_WIDTH);
    expect(fitSingleLabel("Ada", 600, measure)).toBe("Ada");
    expect(fitSingleLabel("Ada", 120, measure)).toBeNull();
  });

  it("keeps 64 names readable at the smallest allowed size, or hides them when nothing fits", () => {
    const names = Array.from({ length: 64 }, (_, i) => `Person ${i + 1}`);
    const desktop = fitWheelLabels(names, geometry(64), measure);
    expect(desktop.labels.every((label) => label !== null)).toBe(true);
    for (const label of desktop.labels) {
      expect(fitsInSlice(label!.text, desktop.fontSize, geometry(64))).toBe(true);
    }

    const phone = fitWheelLabels(names, geometry(64, 280), measure);
    expect(phone.labels.every((label) => label === null)).toBe(true);
  });
});

describe("wheel label emoji", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";

  it("never cuts a joined emoji in half when it shortens a name", () => {
    const label = `Team ${family}${family}${family} Rockets`;
    const whole = graphemes(label);
    for (let wheelPx = 200; wheelPx <= 900; wheelPx += 10) {
      const fitted = fitWheelLabels([label, "Ada", "Bea", "Cal", "Dee", "Eve"], wheelLabelGeometry(6, wheelPx), measure);
      const text = fitted.labels[0]?.text;
      if (!text || !text.endsWith("…")) continue;
      const kept = text.slice(0, -1).trimEnd();
      expect(kept.endsWith("\u200D")).toBe(false);
      const parts = graphemes(kept);
      expect(parts).toEqual(whole.slice(0, parts.length).map((part, i) => (i === parts.length - 1 ? part.trimEnd() : part)));
    }
  });

  it("splits a family emoji into one grapheme", () => {
    expect(graphemes(family)).toEqual([family]);
  });

  it("keeps emoji whole even where the browser has no grapheme segmenter", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const samples = [
      `Team ${family}${family} Rockets`,
      "Ren\u0065\u0301e",
      "\u{1F1EE}\u{1F1F3}\u{1F1FA}\u{1F1F8} flags",
      "thumbs \u{1F44D}\u{1F3FD}",
      "love \u2764\uFE0F",
      "\u{1F3F3}\uFE0F\u200D\u{1F308} pride",
      "\u{1F1E6}\u0301\u{1F1E7}\u{1F1E8} split run",
      "A\u200DB letters",
      "\u{1F469}\u200D\u200D\u{1F469} doubled joiner",
      "\u{1F469}\u{1F3FD}\u200D\u{1F4BB} toned worker",
      "\u1112\u1161\u11AB\u1100\u1173\u11AF decomposed",
      "\uD55C\u11AB\u1100\u1161 mixed",
    ];
    for (const sample of samples) {
      const expected = Array.from(segmenter.segment(sample), (part) => part.segment);
      expect(splitGraphemesFallback(sample)).toEqual(expected);
    }
  });
});

describe("wheel label screen size", () => {
  const twelve = ["Ada", "Grace", "Linus", "Margaret", "Alan", "Barbara", "Dennis", "Katherine", "Ken", "Radia", "Tim", "Frances"];

  it("converts the wheel's on-screen size into pixels per SVG unit", () => {
    expect(pxPerUnitFor(218)).toBe(1);
    expect(pxPerUnitFor(120)).toBeCloseTo(0.55, 2);
    expect(pxPerUnitFor(654)).toBe(3);
  });

  it("shows nothing before the wheel has been measured", () => {
    for (const scale of [0, -0, Number.NaN]) {
      const fitted = fitWheelLabels(twelve, { ...geometry(12), pxPerUnit: scale }, measure);
      expect(fitted.labels.every((label) => label === null)).toBe(true);
    }
    expect(fitSingleLabel("Ada", 0, measure)).toBeNull();
  });

  it("hides labels on a 120px wheel, where they would render under 10px", () => {
    const fitted = fitWheelLabels(twelve, geometry(12, 120), measure);
    expect(fitted.labels.every((label) => label === null)).toBe(true);
  });

  it("never shows a label smaller than 10 screen pixels at any wheel size", () => {
    const names = Array.from({ length: 64 }, (_, i) => `Name ${i + 1}`);
    for (const count of [2, 6, 12, 40, 64]) {
      for (let wheelPx = 80; wheelPx <= 900; wheelPx += 20) {
        const fitted = fitWheelLabels(names.slice(0, count), geometry(count, wheelPx), measure);
        if (fitted.labels.some((label) => label !== null)) {
          expect(fitted.fontSize * pxPerUnitFor(wheelPx)).toBeGreaterThanOrEqual(10 - 1e-9);
        }
      }
    }
  });

  it("shows all twelve names on a desktop-sized wheel at 10px or more", () => {
    const fitted = fitWheelLabels(twelve, geometry(12, 600), measure);
    expect(fitted.labels.map((label) => label?.text)).toEqual(twelve);
    expect(fitted.fontSize * pxPerUnitFor(600)).toBeGreaterThanOrEqual(10);
  });
});

describe("wheel label orientation", () => {
  it("flips every name on the left half so all names read left to right at rest", () => {
    for (const count of [2, 3, 7, 12, 40]) {
      for (const winner of [0, Math.floor(count / 2), count - 1]) {
        const rotation = restingRotation(winner, count);
        for (let index = 0; index < count; index += 1) {
          const angle = screenAngle(index, count, rotation);
          expect(isLabelFlipped(index, count, rotation)).toBe(angle >= 180);
        }
      }
    }
  });

  it("turns a lone name upright at every rotation of an idle wheel", () => {
    for (let rotation = 0; rotation < 720; rotation += 5) {
      const flipped = isLabelFlipped(0, 1, rotation);
      const reading = ((rotation + (flipped ? 180 : 0)) * Math.PI) / 180;
      expect(Math.cos(reading)).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(isLabelFlipped(0, 1, 0)).toBe(false);
    expect(isLabelFlipped(0, 1, 180)).toBe(true);
  });

  it("leaves the winner at the pointer unflipped, so it reads level", () => {
    for (const count of [2, 5, 12, 40, 64]) {
      for (const jitter of [0.15, 0.5, 0.85]) {
        const winner = count - 1;
        const rotation = restingRotation(winner, count, jitter);
        expect(isLabelFlipped(winner, count, rotation)).toBe(false);
      }
    }
  });
});
