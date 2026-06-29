import { describe, expect, it } from "vitest";
import { resolveSnapshotViewerConnectionId } from "../src/app/lib/transcript-connection";

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
