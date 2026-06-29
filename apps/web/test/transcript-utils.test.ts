import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../transcript-worker/src/utils";

describe("redactSensitiveText", () => {
  it("redacts OpenAI-looking keys from propagated errors", () => {
    expect(
      redactSensitiveText(
        "Incorrect API key provided: sk-project_1234567890abcdef",
      ),
    ).toBe("Incorrect API key provided: sk-...[redacted]");
  });

  it("leaves ordinary text unchanged", () => {
    expect(redactSensitiveText("Realtime transcription failed.")).toBe(
      "Realtime transcription failed.",
    );
  });
});
