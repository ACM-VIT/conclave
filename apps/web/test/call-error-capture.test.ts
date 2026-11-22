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
  it("reports a logged call failure under its label, never the error's own text", () => {
    const { target, logged, reported } = setup();
    // A host's custom end-room message comes back from the SFU as the join error.
    const failure = new Error("Riya, continue in room lime-pear-plum");

    target.error("[Meets] Error joining room:", failure);

    expect(logged).toEqual([["[Meets] Error joining room:", failure]]);
    expect(reported).toHaveLength(1);
    const [{ error, props }] = reported;
    expect(props).toEqual({ source: "call_log", call_log: "[Meets] Error joining room" });
    expect(error.name).toBe("Error");
    expect(error.message).toBe("[Meets] Error joining room");
    expect(error.stack).toContain("call-error-capture.test.ts");
    expect(error.stack).not.toMatch(/Riya|lime-pear-plum/);
  });

  it("keeps the type of a browser error so failures stay grouped", () => {
    const { target, reported } = setup();
    const denied = new DOMException("Permission denied by system", "NotAllowedError");

    target.error("[Meets] Failed to produce video:", denied);

    expect(reported[0].error.name).toBe("NotAllowedError");
    expect(reported[0].error.message).toBe("[Meets] Failed to produce video");
  });

  it("drops server error strings and logged objects", () => {
    const { target, reported } = setup();

    target.error(
      "[Meets] Consume error:",
      "Producer not found",
      { error: "Riya, continue in room lime-pear-plum" },
      { displayName: "Alice", chat: "secret plans" },
    );

    expect(reported).toHaveLength(1);
    expect(reported[0].error.name).toBe("CallError");
    expect(reported[0].error.message).toBe("[Meets] Consume error");
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
