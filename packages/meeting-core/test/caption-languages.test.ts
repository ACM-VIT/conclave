import { describe, expect, it } from "vitest";
import {
  captionLanguageCode,
  captionLanguageLabel,
  captionLanguagesFor,
} from "../src/caption-languages";

describe("caption language table", () => {
  it.each([
    ["ta-IN", "ta"],
    ["TA", "ta"],
    ["od-IN", "od"],
    ["kok-IN", "kok"],
    ["sw", "sw"],
    ["unknown", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("reads %j as the picker code %j", (code, expected) => {
    expect(captionLanguageCode(code)).toBe(expected);
  });

  it.each([
    ["od-IN", "Odia"],
    ["ta-IN", "Tamil"],
    ["sw", "sw"],
    ["unknown", undefined],
  ])("names %j as %j, never as another language", (code, expected) => {
    expect(captionLanguageLabel(code)).toBe(expected);
  });

  it("offers Sarvam's extra Indian languages to Sarvam only", () => {
    expect(captionLanguagesFor("sarvam").map(({ code }) => code)).toContain("od");
    expect(captionLanguagesFor("openai").map(({ code }) => code)).not.toContain("od");
    expect(captionLanguagesFor("openai").map(({ code }) => code)).toContain("fr");
  });
});
