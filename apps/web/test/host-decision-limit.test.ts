import { describe, expect, it } from "vitest";
import { hostDecisionLimitNotice } from "../src/app/lib/host-decision-limit";

describe("the notice for a host action the decision record refused", () => {
  const full = {
    success: false,
    code: "DECISION_RECORD_FULL",
    error: "Couldn't admit: this meeting has reached its limit of host decisions.",
  };

  it("names the action that could not be done", () => {
    expect(hostDecisionLimitNotice(full, "admit")).toBe(
      "Couldn’t admit: this meeting has reached its limit of host decisions.",
    );
    expect(hostDecisionLimitNotice(full, "invite")).toBe(
      "Couldn’t invite: this meeting has reached its limit of host decisions.",
    );
  });

  it("is nothing for any other answer", () => {
    for (const response of [
      { success: true },
      { error: "User not found in waiting room" },
      { code: "SOMETHING_ELSE" },
      null,
      "DECISION_RECORD_FULL",
    ]) {
      expect(hostDecisionLimitNotice(response, "admit")).toBeNull();
    }
  });
});
