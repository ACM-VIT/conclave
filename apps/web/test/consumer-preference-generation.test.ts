import { describe, expect, it } from "vitest";
import {
  isConsumerGenerationDisplacedError,
  isConsumerPreferenceGenerationCurrent,
} from "../src/app/lib/consumer-preference-generation";

describe("consumer preference generation ownership", () => {
  it("accepts only the live current consumer generation", () => {
    const base = {
      enabled: true,
      socketConnected: true,
      updateConsumerClosed: false,
      updateConsumerId: "consumer-2",
      currentConsumerId: "consumer-2",
    };
    expect(isConsumerPreferenceGenerationCurrent(base)).toBe(true);
    expect(
      isConsumerPreferenceGenerationCurrent({
        ...base,
        currentConsumerId: "consumer-3",
      }),
    ).toBe(false);
    expect(
      isConsumerPreferenceGenerationCurrent({
        ...base,
        updateConsumerClosed: true,
      }),
    ).toBe(false);
    expect(
      isConsumerPreferenceGenerationCurrent({
        ...base,
        socketConnected: false,
      }),
    ).toBe(false);
  });

  it("recognizes authoritative displaced-generation control errors", () => {
    expect(
      isConsumerGenerationDisplacedError("Consumer generation displaced"),
    ).toBe(true);
    expect(isConsumerGenerationDisplacedError("Consumer displaced"))
      .toBe(true);
    expect(isConsumerGenerationDisplacedError("Unsupported spatial layer"))
      .toBe(false);
  });
});
