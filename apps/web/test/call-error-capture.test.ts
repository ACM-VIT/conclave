import { afterEach, describe, expect, it, vi } from "vitest";
import { installCallErrorCapture, logCallError } from "../src/app/lib/call-error-capture";

type Reported = { error: Error; props: Record<string, unknown> };

const uninstalls: Array<() => void> = [];

afterEach(() => {
  uninstalls.splice(0).forEach((uninstall) => uninstall());
  vi.restoreAllMocks();
});

const setup = () => {
  const logged: unknown[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
  const reported: Reported[] = [];
  let now = 0;
  const uninstall = installCallErrorCapture(
    (error, props) => reported.push({ error, props }),
    { now: () => now },
  );
  uninstalls.push(uninstall);
  return {
    logged,
    reported,
    uninstall,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe("logCallError", () => {
  it("logs and reports a call failure under its label, never the error's own text", () => {
    const { logged, reported } = setup();
    // A host's custom end-room message comes back from the SFU as the join error.
    const failure = new Error("Riya, continue in room lime-pear-plum");

    logCallError("[Meets] Error joining room", failure);

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
    const { reported } = setup();

    logCallError(
      "[Meets] Failed to produce video",
      new DOMException("Permission denied by system", "NotAllowedError"),
    );

    expect(reported[0].error.name).toBe("NotAllowedError");
    expect(reported[0].error.message).toBe("[Meets] Failed to produce video");
  });

  it("drops server error strings and logged objects", () => {
    const { reported } = setup();

    logCallError(
      "[Meets] Consume error",
      "Producer not found",
      { error: "Riya, continue in room lime-pear-plum" },
      { displayName: "Alice", chat: "secret plans" },
    );

    expect(reported).toHaveLength(1);
    expect(reported[0].error.name).toBe("CallError");
    expect(JSON.stringify(reported)).not.toMatch(/Riya|Alice|secret|Producer not found/);
  });

  it("logs a label with nothing after it as it is", () => {
    const { logged } = setup();

    logCallError("[Meets] Raise hand got no acknowledgement");

    expect(logged).toEqual([["[Meets] Raise hand got no acknowledgement"]]);
  });

  it("caps repeats of one label per minute", () => {
    const { reported, advance } = setup();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      logCallError("[Meets] Consume error", "Producer not found");
    }
    logCallError("[Meets] Connection error", new Error("xhr poll error"));
    expect(reported).toHaveLength(4);

    advance(60_000);
    logCallError("[Meets] Consume error", "Producer not found");
    expect(reported).toHaveLength(5);
  });

  it("only logs once capture is removed", () => {
    const { logged, reported, uninstall } = setup();

    uninstall();
    logCallError("[Meets] Failed to sync producers", new Error("late"));

    expect(logged).toHaveLength(1);
    expect(reported).toEqual([]);
  });
});
