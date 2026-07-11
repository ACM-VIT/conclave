import { describe, expect, it } from "vitest";
import {
  getConsumerResumeEffectiveAttempt,
  isConsumerResumeSettlementCurrent,
  type ConsumerResumeRetryState,
} from "../src/app/lib/consumer-resume-retry";

const retryState = (
  consumerId: string,
  attempt = 2,
): ConsumerResumeRetryState => ({
  consumerId,
  timeoutId: 1,
  attempt,
});

describe("consumer resume retry ownership", () => {
  it("does not carry retry attempts across a replacement consumer", () => {
    expect(
      getConsumerResumeEffectiveAttempt(
        retryState("old-consumer", 5),
        "new-consumer",
        0,
      ),
    ).toBe(0);
  });

  it("preserves progress for overlapping retries of the same consumer", () => {
    expect(
      getConsumerResumeEffectiveAttempt(
        retryState("consumer", 3),
        "consumer",
        1,
      ),
    ).toBe(3);
  });

  it("rejects a stale settlement after the producer gets a new consumer", () => {
    expect(
      isConsumerResumeSettlementCurrent(
        "new-consumer",
        retryState("new-consumer"),
        "old-consumer",
      ),
    ).toBe(false);
  });

  it("accepts a settlement only for the active retry owner", () => {
    expect(
      isConsumerResumeSettlementCurrent(
        "consumer",
        retryState("consumer"),
        "consumer",
      ),
    ).toBe(true);
  });
});
