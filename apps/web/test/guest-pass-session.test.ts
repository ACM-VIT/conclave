import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGuestPassSession,
  type GuestPassFields,
} from "../src/app/lib/guest-pass-session";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a page's guest pass", () => {
  it("is left for the join route to pick on the first join, and named on the next", async () => {
    const withGuestPass = createGuestPassSession();
    const sent: GuestPassFields[] = [];
    const answers = [
      { guestId: "gp_issued", guestGrant: "grant-1" },
      { guestId: "gp_issued" },
      { guestId: "gp_issued" },
    ];
    const send = async (fields: GuestPassFields) => {
      sent.push({ ...fields });
      return answers[sent.length - 1];
    };

    await withGuestPass(send);
    await withGuestPass(send);
    await withGuestPass(send);

    expect(sent).toEqual([
      { guestId: "" },
      { guestId: "gp_issued", guestGrant: "grant-1" },
      { guestId: "gp_issued", guestGrant: undefined },
    ]);
  });

  it("stays unnamed after a join call that failed", async () => {
    const withGuestPass = createGuestPassSession();
    const sent: GuestPassFields[] = [];

    await expect(
      withGuestPass(async (fields) => {
        sent.push({ ...fields });
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    await withGuestPass(async (fields) => {
      sent.push({ ...fields });
      return { guestId: "gp_issued" };
    });

    expect(sent).toEqual([{ guestId: "" }, { guestId: "" }]);
  });

  it("does not make a tab wait more than a few seconds for another tab's call", async () => {
    vi.useFakeTimers();
    // Another tab holds the lock and never lets go.
    vi.stubGlobal("navigator", {
      locks: {
        request: (_name: string, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () =>
              reject(new DOMException("The request was aborted.", "AbortError")),
            );
          }),
      },
    });
    const withGuestPass = createGuestPassSession();
    const send = vi.fn(async () => ({ guestId: "gp_issued" }));

    const joining = withGuestPass(send);
    await vi.advanceTimersByTimeAsync(4000);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);

    await expect(joining).resolves.toEqual({ guestId: "gp_issued" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a join call that failed while it had its turn", async () => {
    vi.stubGlobal("navigator", {
      locks: {
        request: (_name: string, _options: unknown, task: () => Promise<unknown>) =>
          task(),
      },
    });
    const withGuestPass = createGuestPassSession();
    const send = vi.fn(async () => {
      throw new Error("refused");
    });

    await expect(withGuestPass(send)).rejects.toThrow("refused");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
