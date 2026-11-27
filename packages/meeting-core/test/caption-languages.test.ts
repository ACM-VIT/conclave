import { describe, expect, it } from "vitest";
import {
  captionLanguageCode,
  captionLanguageLabel,
  captionLanguagesFor,
  captionProviderCode,
} from "../src/caption-languages";

describe("caption language table", () => {
  it.each([
    ["ta-IN", "ta"],
    ["TA", "ta"],
    ["od-IN", "od"],
    ["kok-IN", "kok"],
    ["sw", "sw"],
    ["zh-hk", "zh"],
    ["pt-BR", "pt"],
    ["es-MX", "es"],
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

  it.each([
    ["zh-hk", "Chinese"],
    ["pt-BR", "Portuguese"],
    ["es-MX", "Spanish"],
    ["en-GB", "English"],
  ])("names the regional code %j as %j", (code, expected) => {
    expect(captionLanguageLabel(code)).toBe(expected);
  });

  it("keeps a picked language's provider code apart from its display code", () => {
    expect(captionProviderCode("sarvam", "hi")).toBe("hi-IN");
    expect(captionProviderCode("openai", "zh")).toBe("zh");
    expect(captionLanguageCode(captionProviderCode("sarvam", "od"))).toBe("od");
  });

  it("offers Sarvam's extra Indian languages to Sarvam only", () => {
    expect(captionLanguagesFor("sarvam").map(({ code }) => code)).toContain("od");
    expect(captionLanguagesFor("openai").map(({ code }) => code)).not.toContain("od");
    expect(captionLanguagesFor("openai").map(({ code }) => code)).toContain("fr");
  });
});
