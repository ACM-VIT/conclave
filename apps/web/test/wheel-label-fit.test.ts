import { describe, expect, it, vi } from "vitest";
import {
  SINGLE_LABEL_SIZE,
  SINGLE_LABEL_WIDTH,
  pxPerUnitFor,
} from "../../../packages/apps-sdk/src/apps/wheel/web/geometry";
import {
  fitSingleLabel,
  fitWheelLabels,
  isLabelFlipped,
  labelAngle,
  wheelLabelGeometry,
  type FittedLabel,
  type LabelGeometry,
  type MeasureText,
} from "../../../packages/apps-sdk/src/apps/wheel/web/labelFit";
import { graphemes, splitGraphemesFallback } from "../../../packages/apps-sdk/src/sdk/graphemes";

const WIDE = new Set(["M", "W", "H", "m", "w"]);
const measure: MeasureText = (text) =>
  Array.from(text).reduce((width, character) => width + (WIDE.has(character) ? 0.8 : 0.55), 0);

const geometry = (count: number, wheelPx = 700): LabelGeometry => wheelLabelGeometry(count, wheelPx);

const fitsInSlice = (text: string, fontSize: number, shape: LabelGeometry): boolean => {
  const innerEnd = shape.outerRadius - measure(text) * fontSize;
  const halfWidthAtInnerEnd = innerEnd * Math.tan(Math.PI / shape.count);
  return innerEnd >= shape.innerRadius - 1e-9 && halfWidthAtInnerEnd >= fontSize / 2;
};

const fitsUpright = (label: FittedLabel, fontSize: number, shape: LabelGeometry): boolean => {
  if (!label.numbered) return false;
  const reach = (fontSize * Math.hypot(measure(label.text), 1)) / 2;
  return (
    label.radius + reach <= shape.outerRadius + 1e-9 &&
    label.radius - reach >= shape.innerRadius - 1e-9 &&
    label.radius * Math.sin(Math.PI / shape.count) >= reach - 1e-9
  );
};

const numberFitsAt = (index: number, fontSize: number, shape: LabelGeometry): boolean => {
  const reach = (fontSize * Math.hypot(measure(String(index + 1)), 1.05)) / 2;
  const radius = shape.outerRadius - reach;
  return (
    fontSize <= shape.maxFontSize + 1e-9 &&
    radius - reach >= shape.innerRadius - 1e-9 &&
    radius * Math.sin(Math.PI / shape.count) - 0.6 >= reach - 1e-9
  );
};

const nameFitsAt = (name: string, fontSize: number, shape: LabelGeometry): boolean => {
  const wedge = shape.count <= 2 ? 0 : ((fontSize * 1.05) / 2 + 0.6) / Math.tan(Math.PI / shape.count);
  const width = measure(name) * fontSize;
  return width > 0 && width <= shape.outerRadius - Math.max(shape.innerRadius, wedge) + 1e-9;
};

const everyNameFits = (names: string[], shape: LabelGeometry): boolean =>
  names.every((name) => nameFitsAt(name, shape.minScreenPx / shape.pxPerUnit, shape));

const fallbackAllowance = (count: number): number => Math.max(1, Math.floor(count / 4));

const everyNumberFits = (shape: LabelGeometry): boolean =>
  Array.from({ length: shape.count }, (_, index) => index).every((index) =>
    numberFitsAt(index, shape.minScreenPx / shape.pxPerUnit, shape)
  );

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

  it("numbers a long name's slice instead of running it under the hub", () => {
    const names = ["Ada", "Grace", "Linus", "Margaret", "Alan", "Maximiliana Featherstonehaugh-Worthington"];
    const shape = geometry(names.length);
    const fitted = fitWheelLabels(names, shape, measure);
    expect(fitted.labels[5]).toMatchObject({ text: "6", numbered: true });
    expect(fitsUpright(fitted.labels[5]!, fitted.fontSize, shape)).toBe(true);
    expect(fitted.labels.slice(0, 5).map((label) => label?.text)).toEqual(names.slice(0, 5));
    expect(fitted.labels.slice(0, 5).every((label) => label?.numbered === false)).toBe(true);
  });

  it("does not shrink every name because of one long outlier", () => {
    const short = twelve.slice(0, 11);
    const alone = fitWheelLabels(short, geometry(11), measure);
    const withOutlier = fitWheelLabels([...short, "A name that is far too long for any slice"], geometry(12), measure);
    expect(withOutlier.fontSize).toBeGreaterThanOrEqual(alone.fontSize * 0.9);
    expect(withOutlier.labels.slice(0, 11).every((label) => label && !label.truncated)).toBe(true);
    expect(withOutlier.labels[11]).toMatchObject({ text: "12", numbered: true });
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
    const text = fitSingleLabel(name, 600, measure)!.text;
    expect(text.endsWith("…")).toBe(true);
    expect(measure(text) * SINGLE_LABEL_SIZE).toBeLessThanOrEqual(SINGLE_LABEL_WIDTH);
    expect(fitSingleLabel("Ada", 600, measure)).toEqual({ text: "Ada", numbered: false });
    expect(fitSingleLabel("Ada", 120, measure)).toBeNull();
  });

  it("trims trailing whitespace by whole clusters, never from inside one", () => {
    const fitsCodePoints = (count: number) => (text: string) =>
      (Array.from(text).length * SINGLE_LABEL_WIDTH) / (SINGLE_LABEL_SIZE * (count + 0.5));
    expect(fitSingleLabel("AAAAA\u0600 BBBBBBBBBBB", 600, fitsCodePoints(8))?.text).toBe("AAAAA\u0600 \u2026");
    expect(fitSingleLabel("AAAAA BBBBBBBBBBB", 600, fitsCodePoints(7))?.text).toBe("AAAAA\u2026");
    expect(fitSingleLabel(" \u0600 BBBBBBBBBBB", 600, fitsCodePoints(3))).toEqual({ text: "1", numbered: true });
  });

  it("numbers a slice whose name cannot fit even one cluster while the others show", () => {
    const names = [...twelve.slice(0, 11), `\u0915${"\u094D\u0915".repeat(23)}`];
    const fitted = fitWheelLabels(names, geometry(12), measure);
    expect(fitted.labels.slice(0, 11).map((label) => label?.text)).toEqual(names.slice(0, 11));
    expect(fitted.labels[11]).toMatchObject({ text: "12", truncated: true, numbered: true });
    expect(fitsUpright(fitted.labels[11]!, fitted.fontSize, geometry(12))).toBe(true);
    expect(fitted.labels.slice(0, 11).every((label) => label?.numbered === false)).toBe(true);
  });

  it("numbers a slice whose label measures zero width instead of drawing nothing", () => {
    const names = [...twelve.slice(0, 11), "\u2063"];
    const zeroWidth: MeasureText = (text) => (text === "\u2063" ? 0 : measure(text));
    const fitted = fitWheelLabels(names, geometry(12), zeroWidth);
    expect(fitted.labels[11]).toMatchObject({ text: "12", numbered: true });
  });

  it("numbers a lone name that cannot keep one cluster, instead of leaving the dial blank", () => {
    const fifteen = Array.from({ length: 15 }, () => "\u{1F468}").join("\u200D");
    expect(graphemes(fifteen)).toHaveLength(1);
    expect(fitSingleLabel(fifteen, 1018, measure)).toEqual({ text: "1", numbered: true });
    expect(fitSingleLabel("", 600, measure)).toEqual({ text: "1", numbered: true });
    expect(fitSingleLabel(fifteen, 120, measure)).toBeNull();
  });

  it("never shortens a label to a prefix with nothing visible in it", () => {
    const fitsCodePoints = (count: number) => (text: string) =>
      (Array.from(text).length * SINGLE_LABEL_WIDTH) / (SINGLE_LABEL_SIZE * (count + 0.5));
    expect(fitSingleLabel("\u200B\u200BAAAAAAAAAA", 600, fitsCodePoints(3))).toEqual({ text: "1", numbered: true });
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

describe("wheel label coverage", () => {
  const CONJUNCT = `\u0915${"\u094D\u0915".repeat(23)}`;
  const pool = [
    "A",
    "Ada",
    "Margaret Hamilton",
    "Maximiliana Featherstonehaugh-Worthington",
    "\u0932\u0915\u094D\u0937\u094D\u092E\u0940\u0928\u093E\u0930\u093E\u092F\u0923",
    "\u1001\u1014\u1039\u1013\u102C\u1001\u1014\u1039\u1013\u102C",
    "\u5C71\u7530\u592A\u90CE",
    "\u0E19\u0E49\u0E33",
    "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} Team",
  ];
  const extremes = [
    (size: number) => `\u0915${"\u094D\u0915".repeat(size)}`,
    (size: number) => `\u1000${"\u1039\u1000".repeat(size)}`,
    (size: number) => `\u{1F468}${"\u200D\u{1F469}".repeat(size)}`,
  ];

  it("numbers the last slice when 63 one letter names set a size its number cannot fit", () => {
    const names = [...Array.from({ length: 63 }, () => "A"), CONJUNCT];
    const fitted = fitWheelLabels(names, geometry(64, 700), measure);
    expect(fitted.labels.every((label) => label !== null)).toBe(true);
    expect(fitted.labels[63]).toMatchObject({ text: "64", truncated: true, numbered: true });
    expect(fitsUpright(fitted.labels[63]!, fitted.fontSize, geometry(64, 700))).toBe(true);
  });

  it("shows every name at the smallest size when one outlier sets a size slice 49's number cannot fit", () => {
    const names = [...Array.from({ length: 48 }, () => "A"), "aaaaaaaa"];
    const shape = geometry(49, 340);
    expect(everyNameFits(names, shape)).toBe(true);
    const fitted = fitWheelLabels(names, shape, measure);
    expect(fitted.labels.map((label) => label?.text)).toEqual(names);
    expect(fitted.fontSize * shape.pxPerUnit).toBeGreaterThanOrEqual(shape.minScreenPx - 1e-9);
    for (const name of new Set(names)) expect(fitsInSlice(name, fitted.fontSize, shape), name).toBe(true);
  });

  const coverageFailure = (names: string[], wheelPx: number): { failure: string | null; numbered: boolean } => {
    const count = names.length;
    const shape = geometry(count, wheelPx);
    const fitted = fitWheelLabels(names, shape, measure);
    const shown = fitted.labels.filter((label) => label !== null).length;
    const namesFit = everyNameFits(names, shape);
    if (shown !== 0 && shown !== count) return { failure: `${shown} of ${count} labelled`, numbered: false };
    if (shown === 0) {
      if (everyNumberFits(shape)) return { failure: "blank dial while its numbers fit", numbered: false };
      if (namesFit) return { failure: "blank dial while its names fit", numbered: false };
      return { failure: null, numbered: false };
    }
    if (fitted.fontSize * shape.pxPerUnit < shape.minScreenPx - 1e-9) return { failure: "under the size floor", numbered: false };
    let numberedCount = 0;
    for (let index = 0; index < count; index += 1) {
      const label = fitted.labels[index]!;
      if (label.numbered) numberedCount += 1;
      const fits = label.numbered ? fitsUpright(label, fitted.fontSize, shape) : fitsInSlice(label.text, fitted.fontSize, shape);
      if (!fits) return { failure: `slice ${index + 1} does not fit`, numbered: false };
      if (label.text !== (label.numbered ? String(index + 1) : names[index])) return { failure: `slice ${index + 1} reads ${label.text}`, numbered: false };
    }
    if (numberedCount > fallbackAllowance(count) && !(numberedCount === count && !namesFit)) {
      return { failure: `${numberedCount} of ${count} numbered`, numbered: true };
    }
    return { failure: null, numbered: numberedCount > 0 };
  };

  const FULL_SWEEP = process.env.WHEEL_LABEL_FULL_SWEEP === "1";
  const range = (from: number, to: number, step: number): number[] =>
    Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, index) => from + index * step);

  it("never leaves a slice blank while other slices are labelled, or numbers slices whose names all fit", () => {
    const failures: string[] = [];
    let numberedRuns = 0;
    let denseRuns = 0;
    const check = (names: string[], wheelPx: number, where: string): void => {
      const { failure, numbered } = coverageFailure(names, wheelPx);
      if (failure) failures.push(`${where} at ${wheelPx}px: ${failure}`);
      if (numbered) numberedRuns += 1;
    };

    check([...Array.from({ length: 48 }, () => "A"), "aaaaaaaa"], 340, "48 one letter names and one of 8");
    check(["A", extremes[0](23), "Y", extremes[1](15), extremes[1](21), "W", "Q", "A", "G"], 814, "9 names, 3 long stacks");

    let seed = 20261123;
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    for (let run = 0; run < (FULL_SWEEP ? 1500 : 500); run += 1) {
      const count = 2 + random(63);
      const letters = random(3) === 0;
      const names = Array.from({ length: count }, () =>
        letters
          ? String.fromCharCode(65 + random(26))
          : random(5) === 0
            ? extremes[random(extremes.length)](1 + random(23))
            : random(2) === 0
              ? String.fromCharCode(65 + random(26))
              : pool[random(pool.length)]
      );
      if (letters) names[random(count)] = extremes[random(extremes.length)](1 + random(23));
      check(names, 180 + random(721), `run ${run}`);
    }

    const counts = FULL_SWEEP ? range(24, 64, 1) : [24, 33, 41, 49, 57, 64];
    const sizes = FULL_SWEEP ? range(240, 480, 20) : [240, 300, 340, 360, 400, 480];
    const lengths = FULL_SWEEP ? range(2, 12, 2) : [2, 5, 8, 12];
    for (const count of counts) {
      for (const wheelPx of sizes) {
        for (const length of lengths) {
          const names = [...Array.from({ length: count - 1 }, () => "A"), "a".repeat(length)];
          if (everyNameFits(names, geometry(count, wheelPx))) denseRuns += 1;
          check(names, wheelPx, `dense ${count} with a ${length} letter outlier`);
        }
      }
    }

    expect(failures).toEqual([]);
    expect(numberedRuns).toBeGreaterThan(10);
    expect(denseRuns).toBeGreaterThan(30);
  });
});

describe("wheel label list rows", () => {
  const LONG = "Maximiliana Featherstonehaugh-Worthington";

  it("numbers a slice with the row its name holds in the names list, wherever the slice sits on the dial", () => {
    const names = ["Ada", LONG, "Grace", "Linus", "Alan", "Ken"];
    const shape = geometry(names.length);
    expect(fitWheelLabels(names, shape, measure).labels[1]).toMatchObject({ text: "2", numbered: true });
    const moved = fitWheelLabels(names, shape, measure, [3, 5, 1, 2, 4, 6]);
    expect(moved.labels[1]).toMatchObject({ text: "5", numbered: true });
    expect(fitsUpright(moved.labels[1]!, moved.fontSize, shape)).toBe(true);
    expect(moved.labels.map((label) => label?.text)).toEqual(["Ada", "5", "Grace", "Linus", "Alan", "Ken"]);
  });

  it("gives no number to a slice whose name left the list, and keeps every other slice labelled", () => {
    const names = ["Ada", LONG, "Grace", "Linus", "Alan", "Ken"];
    const fitted = fitWheelLabels(names, geometry(names.length), measure, [1, null, 2, 3, null, 4]);
    expect(fitted.labels.map((label) => label?.text)).toEqual(["Ada", undefined, "Grace", "Linus", "Alan", "Ken"]);
    const allGone = fitWheelLabels(names, geometry(names.length), measure, names.map(() => null));
    expect(allGone.labels.map((label) => label?.text)).toEqual(["Ada", undefined, "Grace", "Linus", "Alan", "Ken"]);
  });

  it("numbers a lone slice with its row, or leaves it bare when its name left the list", () => {
    const fifteen = Array.from({ length: 15 }, () => "\u{1F468}").join("\u200D");
    expect(fitSingleLabel(fifteen, 1018, measure, 7)).toEqual({ text: "7", numbered: true });
    expect(fitSingleLabel(fifteen, 1018, measure, null)).toBeNull();
    expect(fitSingleLabel("Ada", 1018, measure, null)).toEqual({ text: "Ada", numbered: false });
  });

  it("shows each listed slice its name or its own row number, and never a number on an unlisted slice, for any names, rows and wheel size", () => {
    let seed = 20261127;
    const random = (limit: number): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) % limit;
    };
    const pool = ["A", "Ada", "Margaret Hamilton", LONG, `\u0915${"\u094D\u0915".repeat(23)}`, "\u5C71\u7530\u592A\u90CE"];
    let numbered = 0;
    let bare = 0;
    for (let run = 0; run < 600; run += 1) {
      const count = 2 + random(63);
      const names = Array.from({ length: count }, () => pool[random(pool.length)]);
      const order = Array.from({ length: count + random(8) }, (_, index) => index + 1).sort(() => random(3) - 1);
      const rows = names.map((_, index) => (random(6) === 0 ? null : order[index]));
      const shape = geometry(count, 180 + random(721));
      const fitted = fitWheelLabels(names, shape, measure, rows);
      const where = `run ${run}`;
      const anyLabel = fitted.labels.some((label) => label !== null);
      fitted.labels.forEach((label, index) => {
        if (label === null) {
          if (rows[index] === null) bare += 1;
          else expect(anyLabel, `${where} slice ${index}`).toBe(false);
          return;
        }
        if (!label.numbered) {
          expect(label.text, `${where} slice ${index}`).toBe(names[index]);
          return;
        }
        numbered += 1;
        expect(label.text, `${where} slice ${index}`).toBe(String(rows[index]));
        expect(fitsUpright(label, fitted.fontSize, shape), `${where} slice ${index}`).toBe(true);
      });
      if (anyLabel) expect(fitted.fontSize * shape.pxPerUnit, where).toBeGreaterThanOrEqual(shape.minScreenPx - 1e-9);
    }
    expect(numbered).toBeGreaterThan(500);
    expect(bare).toBeGreaterThan(200);
  });
});

describe("wheel label fallback", () => {
  const LONG_NAMES = ["A".repeat(48), "Maximiliana Featherstonehaugh-Worthington Smythe"];

  it("shows Ada, 2 and Bo on a three name wheel with one 48 character name, at every size", () => {
    let checked = 0;
    for (const long of LONG_NAMES) {
      expect(long).toHaveLength(48);
      for (let wheelPx = 180; wheelPx <= 900; wheelPx += 10) {
        const shape = geometry(3, wheelPx);
        const fitted = fitWheelLabels(["Ada", long, "Bo"], shape, measure);
        const where = `${long.slice(0, 8)} at ${wheelPx}px`;
        if (!everyNumberFits(shape)) continue;
        checked += 1;
        expect(fitted.labels.map((label) => label?.text), where).toEqual(["Ada", "2", "Bo"]);
        expect(fitted.labels.map((label) => label?.numbered), where).toEqual([false, true, false]);
        expect(fitsUpright(fitted.labels[1]!, fitted.fontSize, shape), where).toBe(true);
        expect(fitsInSlice("Ada", fitted.fontSize, shape) && fitsInSlice("Bo", fitted.fontSize, shape), where).toBe(true);
        expect(fitted.fontSize * shape.pxPerUnit).toBeGreaterThanOrEqual(shape.minScreenPx - 1e-9);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("keeps names and numbers only the slices that do not fit, up to one slice or a quarter of them", () => {
    let kept = 0;
    let allNumbered = 0;
    for (let count = 2; count <= 12; count += 1) {
      for (let longCount = 0; longCount <= count; longCount += 1) {
        for (const wheelPx of [420, 700]) {
          const shape = geometry(count, wheelPx);
          if (!everyNumberFits(shape)) continue;
          const names = Array.from({ length: count }, (_, index) => (index < longCount ? LONG_NAMES[index % 2] : `N${index}`));
          const fitted = fitWheelLabels(names, shape, measure);
          const where = `${longCount} long of ${count} at ${wheelPx}px`;
          expect(fitted.labels.every((label) => label !== null), where).toBe(true);
          const numberedCount = fitted.labels.filter((label) => label!.numbered).length;
          if (longCount <= fallbackAllowance(count)) {
            kept += 1;
            expect(fitted.labels.slice(longCount).map((label) => label!.text), where).toEqual(names.slice(longCount));
            expect(numberedCount, where).toBeLessThanOrEqual(longCount);
          } else if (numberedCount === count) {
            allNumbered += 1;
          } else {
            expect(numberedCount, where).toBeLessThanOrEqual(fallbackAllowance(count));
          }
          fitted.labels.forEach((label, index) => {
            expect(label!.text, `${where}, slice ${index + 1}`).toBe(label!.numbered ? String(index + 1) : names[index]);
          });
        }
      }
    }
    expect(kept).toBeGreaterThan(20);
    expect(allNumbered).toBeGreaterThan(20);
  });

  it("numbers every slice when too few names fit in full, instead of leaving the dial blank", () => {
    let checked = 0;
    for (let count = 2; count <= 8; count += 1) {
      for (const wheelPx of [240, 420, 700, 900]) {
        const shape = geometry(count, wheelPx);
        const names = Array.from({ length: count }, (_, index) => (index === 0 ? LONG_NAMES[1] : `N${index}`));
        const fitted = fitWheelLabels(names, shape, measure);
        if (!everyNumberFits(shape)) continue;
        checked += 1;
        expect(fitted.labels.every((label) => label !== null), `${count} names at ${wheelPx}px`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("wheel label emoji", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";

  it("never cuts a joined emoji in half when it shortens a lone name", () => {
    const label = `Team ${family}${family}${family} Rockets`;
    const whole = graphemes(label);
    let shortened = 0;
    for (let scale = 0.5; scale <= 6; scale += 0.05) {
      const fitted = fitSingleLabel(label, 600, (value) => measure(value) * scale);
      const text = fitted && !fitted.numbered ? fitted.text : null;
      if (!text || !text.endsWith("\u2026")) continue;
      shortened += 1;
      const kept = text.slice(0, -1).trimEnd();
      expect(kept.endsWith("\u200D")).toBe(false);
      const parts = graphemes(kept);
      expect(parts).toEqual(whole.slice(0, parts.length).map((part, i) => (i === parts.length - 1 ? part.trimEnd() : part)));
    }
    expect(shortened).toBeGreaterThan(20);
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

describe("wheel label scripts without a grapheme segmenter", () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const segmented = (text: string): string[] => Array.from(segmenter.segment(text), (part) => part.segment);

  it("keeps an Indic conjunct whole when it shortens a name", () => {
    expect(splitGraphemesFallback("AAAAAलक्ष्मीनारायण").slice(0, 7)).toEqual(["A", "A", "A", "A", "A", "ल", "क्ष्मी"]);
  });

  it("keeps the stacked consonants that Unicode 17 joins in Myanmar, Khmer, Balinese and Javanese", () => {
    expect(splitGraphemesFallback("သတ္တ")).toEqual(["သ", "တ္တ"]);
    expect(splitGraphemesFallback("ခန္ဓာ")).toEqual(["ခ", "န္ဓ", "ာ"]);
    expect(splitGraphemesFallback("ខ្មែរ")).toEqual(["ខ្មែ", "រ"]);
    expect(splitGraphemesFallback("ᬅᬓ᭄ᬱᬭ")).toEqual(["ᬅ", "ᬓ᭄ᬱ", "ᬭ"]);
    expect(splitGraphemesFallback("ꦲꦏ꧀ꦱꦫ")).toEqual(["ꦲ", "ꦏ꧀ꦱ", "ꦫ"]);
  });

  it("keeps listed linkers attached when the browser's character data predates their script", () => {
    const test = RegExp.prototype.test;
    const newerThanBrowser = /^[\u{11380}-\u{113FF}\u{11F00}-\u{11F5F}]$/u;
    const olderData = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, input: string) {
      return this.source.includes("\\p{") && test.call(newerThanBrowser, input) ? false : test.call(this, input);
    });
    let split: string[][];
    try {
      split = [
        "AA\u{11392}\u{113D0}\u{113A5}\u{11392}",
        "AA\u{11F12}\u{11F42}\u{11F13}\u{11F12}",
        "\u{11392}\u{113B8}\u{113D0}\u{113A5}",
      ].map(splitGraphemesFallback);
    } finally {
      olderData.mockRestore();
    }
    expect(split).toEqual([
      ["A", "A", "\u{11392}\u{113D0}\u{113A5}", "\u{11392}"],
      ["A", "A", "\u{11F12}\u{11F42}\u{11F13}", "\u{11F12}"],
      ["\u{11392}\u{113B8}\u{113D0}\u{113A5}"],
    ]);
  });

  it("keeps a virama with no consonant before it apart from the next consonant, as Unicode 17 does", () => {
    expect(splitGraphemesFallback("\u0905\u094D\u0937")).toEqual(["\u0905\u094D", "\u0937"]);
    expect(splitGraphemesFallback("\u0915\u093E\u094D\u0937")).toEqual(["\u0915\u093E\u094D", "\u0937"]);
  });

  it("splits names the way the browser segmenter does, script by script", () => {
    const names = [
      "AAAAAलक्ष्मीनारायण लक्ष्मीनारायण",
      "क्षत्रिय श्रीमती हिन्दी स्त्री पृथ्वी अर्जुन",
      "ज़्यादा द्\u200Dवार क्\u200Cष",
      "ক্ষমা বাংলা রবীন্দ্রনাথ",
      "ગુજરાતી લક્ષ્મી",
      "ਪੰਜਾਬੀ ਸ੍ਰੀ",
      "ଓଡ଼ିଆ ଲକ୍ଷ୍ମୀ",
      "తెలుగు లక్ష్మి",
      "ಕನ್ನಡ ಲಕ್ಷ್ಮಿ",
      "മലയാളം ലക്ഷ്മി അവന്\u200D",
      "தமிழ் லக்ஷ்மி",
      "ශ්\u200Dරී ලංකා",
      "ภาษาไทย น้ำ ที่",
      "ພາສາລາວ ນ້ຳ",
      "မြန်မာ အောင်ဆန်းစုကြည်",
      "བོད་སྐད",
      "مَرْحَبًا محمد",
      "שָׁלוֹם",
      "Nguye\u0302\u0303n",
      "ｶﾞｷﾞ 山田太郎",
      "क्A क्ক क्ก",
      "क़्ष क््ष क\u200D्ष क्\uFE0Fष",
      "ক\u09CD\u09BEষ ক\u09BE\u09CDষ ക\u0D57\u0D4Dഷ",
      "\u{1F469}\u0E33\u200D\u{1F4BB} \u{1F469}\u200C\u200D\u{1F4BB}",
      "\u{16D43}\u{16D63}\u{16D67}\u{16D50}",
      "\u200F\u064E\u0645\u062D\u0645\u062F a\u00AD\u0301b x\u200B\u200Dy",
      "\u0600\u0661\u0662 \u0D4E\u0D15\u0D4D\u0D37 line\r\nnext",
    ];
    for (const name of names) {
      expect(splitGraphemesFallback(name)).toEqual(segmented(name));
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

  it("draws every name within 90 degrees of upright and every list number upright", () => {
    const fromUpright = (angle: number): number => ((((angle % 360) + 540) % 360) - 180);
    for (const count of [3, 4, 6, 12, 40, 64]) {
      for (let rotation = -360; rotation < 720; rotation += 7.3) {
        for (let index = 0; index < count; index += 1) {
          expect(Math.abs(fromUpright(rotation + labelAngle(index, count, rotation, false)))).toBeLessThanOrEqual(90);
          expect(Math.abs(fromUpright(rotation + labelAngle(index, count, rotation, true)))).toBeLessThan(1e-9);
        }
      }
    }
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
