import { expect, it } from "vitest";
import { SARVAM_SUPPORTED_LANGUAGE_CODES } from "../transcript-worker/src/transcription/sarvam";
import {
  captionLanguageCode,
  captionLanguagesFor,
  captionProviderCode,
} from "../src/app/lib/caption-languages";

it("gives every code the Sarvam worker accepts a Sarvam option in the shared table", () => {
  const options = new Set(captionLanguagesFor("sarvam").map(({ code }) => code));
  const missing = [...SARVAM_SUPPORTED_LANGUAGE_CODES]
    .filter((code) => code !== "unknown")
    .filter((code) => !options.has(captionLanguageCode(code) ?? ""));

  expect(missing).toEqual([]);
});

it("sends Sarvam a code it accepts for every Sarvam option in the shared table", () => {
  const refused = captionLanguagesFor("sarvam")
    .map(({ code }) => captionProviderCode("sarvam", code))
    .filter((code) => !SARVAM_SUPPORTED_LANGUAGE_CODES.has(code));

  expect(refused).toEqual([]);
});
