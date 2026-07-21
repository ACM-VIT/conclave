import { describe, expect, it } from "vitest";
import {
  buildWebcamSimulcastEncodings,
  buildWebcamSingleLayerEncoding,
} from "../src/app/lib/video-encodings";

describe("web webcam video encodings", () => {
  it("matches the native standard simulcast bitrate and frame-rate ladder", () => {
    expect(buildWebcamSimulcastEncodings("standard")).toEqual([
      {
        rid: "q",
        scaleResolutionDownBy: 4,
        maxBitrate: 80_000,
        maxFramerate: 12,
        scalabilityMode: "L1T1",
      },
      {
        rid: "h",
        scaleResolutionDownBy: 2,
        maxBitrate: 220_000,
        maxFramerate: 20,
        scalabilityMode: "L1T1",
      },
      {
        rid: "f",
        scaleResolutionDownBy: 1,
        maxBitrate: 1_650_000,
        maxFramerate: 30,
        scalabilityMode: "L1T1",
      },
    ]);
  });

  it("keeps lower-layer overhead at 300 kbps while preserving the 1.65 Mbps full layer", () => {
    const [base, middle, full] = buildWebcamSimulcastEncodings("standard");

    expect((base?.maxBitrate ?? 0) + (middle?.maxBitrate ?? 0)).toBe(300_000);
    expect(full?.maxBitrate).toBe(1_650_000);
    expect(buildWebcamSingleLayerEncoding("standard").maxBitrate).toBe(
      1_650_000,
    );
    expect(buildWebcamSingleLayerEncoding("standard").scalabilityMode).toBe(
      "L1T1",
    );
  });
});
