import { describe, expect, it } from "vitest";
import { getInitialConsumerPreferences } from "../src/app/hooks/useMeetSocket";
import type { ProducerInfo } from "../src/app/lib/types";

const producer = (
  kind: ProducerInfo["kind"],
  type: ProducerInfo["type"],
): ProducerInfo =>
  ({
    producerId: `${kind}-${type}`,
    producerUserId: "remote-user",
    kind,
    type,
  }) as ProducerInfo;

describe("getInitialConsumerPreferences", () => {
  it("uses only T0 for every webcam startup profile", () => {
    const webcam = producer("video", "webcam");
    const cases = [
      { preferHighWebcamLayer: true, networkProfile: "good" as const },
      { preferHighWebcamLayer: true, networkProfile: "fair" as const },
      { preferHighWebcamLayer: true, networkProfile: "poor" as const },
      { preferHighWebcamLayer: true, networkProfile: "emergency" as const },
      { preferHighWebcamLayer: false, networkProfile: "good" as const },
      { preferHighWebcamLayer: false, networkProfile: "fair" as const },
      {
        preferHighWebcamLayer: true,
        networkProfile: "good" as const,
        screenShareVideoActive: true,
      },
    ];

    for (const options of cases) {
      expect(
        getInitialConsumerPreferences(webcam, options).preferredLayers
          ?.temporalLayer,
      ).toBe(0);
    }
  });

  it("starts webcams outside the bounded high-layer budget on the base spatial layer", () => {
    expect(
      getInitialConsumerPreferences(producer("video", "webcam"), {
        preferHighWebcamLayer: false,
        networkProfile: "good",
      }).preferredLayers,
    ).toEqual({ spatialLayer: 0, temporalLayer: 0 });
  });

  it("keeps the independent screen-share temporal policy", () => {
    const screen = producer("video", "screen");
    expect(
      getInitialConsumerPreferences(screen, { networkProfile: "good" })
        .preferredLayers,
    ).toEqual({ spatialLayer: 0, temporalLayer: 2 });
    expect(
      getInitialConsumerPreferences(screen, { networkProfile: "emergency" })
        .preferredLayers,
    ).toEqual({ spatialLayer: 0, temporalLayer: 1 });
  });
});
