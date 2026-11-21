import { describe, expect, it } from "vitest";
import { installCallErrorCapture } from "../src/app/lib/call-error-capture";

type Reported = { error: Error; props: Record<string, unknown> };

const setup = () => {
  const logged: unknown[][] = [];
  const reported: Reported[] = [];
  const target = { error: (...args: unknown[]) => logged.push(args) };
  let now = 0;
  const uninstall = installCallErrorCapture(
    (error, props) => reported.push({ error: error as Error, props }),
    { target, now: () => now },
  );
  return {
    target,
    logged,
    reported,
    uninstall,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe("installCallErrorCapture", () => {
  it("reports a logged call failure with its original error and label", () => {
    const { target, logged, reported } = setup();
    const failure = new Error("Producer not found");

    target.error("[Meets] Failed to produce video:", failure);

    expect(logged).toEqual([["[Meets] Failed to produce video:", failure]]);
    expect(reported).toEqual([
      {
        error: failure,
        props: { source: "call_log", call_log: "[Meets] Failed to produce video" },
      },
    ]);
  });

  it("builds an error from a server error string and drops logged objects", () => {
    const { target, reported } = setup();

    target.error(
      "[Meets] Consume error:",
      "Producer not found",
      { error: "rate limited" },
      { displayName: "Alice", chat: "secret plans" },
    );

    expect(reported).toHaveLength(1);
    expect(reported[0].error.name).toBe("CallError");
    expect(reported[0].error.message).toBe(
      "[Meets] Consume error Producer not found rate limited",
    );
  });

  it("ignores logs outside the call code", () => {
    const { target, reported } = setup();

    target.error("Sign out error:", new Error("network"));
    target.error(new Error("unlabelled"));

    expect(reported).toEqual([]);
  });

  it("caps repeats of one log line per minute", () => {
    const { target, reported, advance } = setup();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      target.error("[Meets] Consume error:", "Producer not found");
    }
    target.error("[Meets] Connection error:", new Error("xhr poll error"));
    expect(reported).toHaveLength(4);

    advance(60_000);
    target.error("[Meets] Consume error:", "Producer not found");
    expect(reported).toHaveLength(5);
  });

  it("restores console.error when uninstalled", () => {
    const { target, reported, uninstall } = setup();

    uninstall();
    target.error("[Meets] Failed to sync producers:", new Error("late"));

    expect(reported).toEqual([]);
  });
});
