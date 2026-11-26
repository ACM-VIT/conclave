import { describe, expect, it } from "vitest";
import { cutText } from "../../../packages/apps-sdk/src/sdk/text";
import { graphemes } from "../../../packages/apps-sdk/src/sdk/graphemes";
import { withoutLoneSurrogates } from "../../../packages/apps-sdk/src/native-embed/protocol";

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const PIECES = [
  "a",
  "Z",
  " ",
  "\u{1F389}",
  "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
  "\u{1F1EE}\u{1F1F3}",
  "\u{1F1EE}",
  "e\u0301",
  "\u0301",
  "\u{1F44D}\u{1F3FD}",
  "\u0915\u094D\u0937",
  "\u1100\u1161\u11A8",
  "\u200D",
  "\uD83C",
  "\uDF89",
];

describe("cutText", () => {
  it("never leaves a lone surrogate, never passes the limit and ends where a cluster ends", () => {
    let seed = 20261124;
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    for (let run = 0; run < 3000; run += 1) {
      const text = Array.from({ length: random(30) }, () => PIECES[random(PIECES.length)]).join("");
      const limit = 1 + random(24);
      const cut = cutText(text, limit);
      const whole = withoutLoneSurrogates(text);
      const where = `${JSON.stringify(text)} at ${limit}`;
      expect(LONE_SURROGATE.test(cut), where).toBe(false);
      expect(cut.length, where).toBeLessThanOrEqual(limit);
      if (whole.length <= limit) {
        expect(cut, where).toBe(whole);
        continue;
      }
      const ends = graphemes(whole).reduce<number[]>((list, cluster) => [...list, (list.at(-1) ?? 0) + cluster.length], []);
      const fitting = ends.filter((end) => end <= limit);
      if (fitting.length > 0) {
        expect(cut, where).toBe(whole.slice(0, fitting.at(-1)).trimEnd());
      } else {
        let points = "";
        for (const point of whole) {
          if (points.length + point.length > limit) break;
          points += point;
        }
        expect(cut, where).toBe(points.trimEnd());
      }
    }
  });

  it("keeps the first code points of one cluster longer than the limit", () => {
    expect(cutText("Z" + "\u0301".repeat(20), 8)).toBe("Z" + "\u0301".repeat(7));
    expect(cutText("\u{1F389}\u0301\u0301\u0301", 3)).toBe("\u{1F389}\u0301");
  });

  it("trims only the end it cut and leaves short text alone", () => {
    expect(cutText("ab  cd", 4)).toBe("ab");
    expect(cutText("  ab ", 10)).toBe("  ab ");
    expect(cutText("a\uD800b", 10)).toBe("ab");
    expect(cutText("Bo\uDF89", 2)).toBe("Bo");
  });
});
