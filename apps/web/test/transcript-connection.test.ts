import { describe, expect, it } from "vitest";
import {
  clearRecoveredTranscriptError,
  resolveSnapshotViewerConnectionId,
} from "../src/app/lib/transcript-connection";

describe("resolveSnapshotViewerConnectionId", () => {
  it("preserves the current viewer connection when a room-wide snapshot omits it", () => {
    expect(resolveSnapshotViewerConnectionId("viewer-a", {})).toBe("viewer-a");
  });

  it("updates the viewer connection when the snapshot includes it", () => {
    expect(
      resolveSnapshotViewerConnectionId("viewer-a", {
        viewerConnectionId: "viewer-b",
      }),
    ).toBe("viewer-b");
  });

  it("clears the viewer connection when the snapshot explicitly nulls it", () => {
    expect(
      resolveSnapshotViewerConnectionId("viewer-a", {
        viewerConnectionId: null,
      }),
    ).toBeNull();
  });
});

describe("clearRecoveredTranscriptError", () => {
  it("clears readiness and handoff errors after the relay is healthy", () => {
    expect(
      clearRecoveredTranscriptError(
        "Transcript is still reconnecting automatically.",
      ),
    ).toBeNull();
    expect(
      clearRecoveredTranscriptError("Transcript controller disconnected."),
    ).toBeNull();
    expect(
      clearRecoveredTranscriptError(
        "Transcript audio relay could not reconnect.",
      ),
    ).toBeNull();
  });

  it("preserves errors unrelated to connection recovery", () => {
    expect(clearRecoveredTranscriptError("Invalid OpenAI API key.")).toBe(
      "Invalid OpenAI API key.",
    );
  });
});
