import { expect, it } from "vitest";
import { SARVAM_SUPPORTED_LANGUAGE_CODES } from "../transcript-worker/src/transcription/sarvam";
import { captionLanguageCode, captionLanguagesFor } from "../src/app/lib/caption-languages";

it("gives every code the Sarvam worker accepts a Sarvam option in the shared table", () => {
  const options = new Set(captionLanguagesFor("sarvam").map(({ code }) => code));
  const missing = [...SARVAM_SUPPORTED_LANGUAGE_CODES]
    .filter((code) => code !== "unknown")
    .filter((code) => !options.has(captionLanguageCode(code) ?? ""));

  expect(missing).toEqual([]);
});
