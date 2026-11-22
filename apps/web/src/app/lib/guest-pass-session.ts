import { z } from "zod";

const GUEST_PASS_REQUEST_TIMEOUT_MS = 5000;
const GUEST_PASS_LOCK_NAME = "conclave:guest-pass";
const GUEST_PASS_LOCK_TIMEOUT_MS = 10000;

/**
 * What a client adds to a join request so the server picks its guest
 * identity: an empty `guestId`, and the grant from the last answer.
 */
export type GuestPassFields = {
  guestId: "";
  guestGrant?: string;
};

/** The guest side of the join route's answer. An account's answer has none. */
const guestJoinAnswerSchema = z.object({
  guestId: z.string().min(1),
  guestGrant: z.string().min(1).optional(),
});

const requestGuestPass = async (): Promise<void> => {
  await fetch("/api/guest-pass", {
    method: "POST",
    signal: AbortSignal.timeout(GUEST_PASS_REQUEST_TIMEOUT_MS),
  });
};

/**
 * How a page asks the server to give its browser a guest pass. A page that
 * was rendered for a signed-in account has no use for one and asks nothing.
 *
 * Tabs of one browser take turns. Two tabs that load at once would otherwise
 * both ask before either has a cookie, and each be given a pass. With the
 * lock, the second request carries the cookie the first answer set. A tab
 * that cannot get the lock in time, or a browser without Web Locks, asks
 * anyway: the join route then settles which pass the browser goes by.
 */
export const guestPassRequestFor =
  (user?: { id?: string; email?: string | null }) =>
  async (): Promise<void> => {
    if (user?.id || user?.email) return;
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!locks) return requestGuestPass();
    let asked = false;
    try {
      await locks.request(
        GUEST_PASS_LOCK_NAME,
        { signal: AbortSignal.timeout(GUEST_PASS_LOCK_TIMEOUT_MS) },
        () => {
          asked = true;
          return requestGuestPass();
        },
      );
    } catch (error) {
      if (asked) throw error;
      await requestGuestPass();
    }
  };

/**
 * The guest side of one page's join calls.
 *
 * The page never names a pass. The join route picks it from the browser's
 * cookies. One thing travels with each call: the grant from the last answer,
 * which stands in for the cookie in a browser that has not sent it back yet,
 * or never will.
 *
 * Calls go one at a time within the page, so a second call always carries
 * what the first one was answered with. `askForPass` goes ahead of them all:
 * it has the server give the browser its pass, so the tabs of a browser are
 * on one pass before any of them joins. A join call does not need it to
 * have worked. The join route gives a pass to a caller that has none.
 */
export const createGuestPassSession = (askForPass: () => Promise<unknown>) => {
  let grant: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let askedForPass = false;

  const askForPassOnce = (): void => {
    if (askedForPass) return;
    askedForPass = true;
    queue = queue.then(askForPass).catch(() => undefined);
  };

  const join = <Answer>(
    send: (fields: GuestPassFields) => Promise<Answer>,
  ): Promise<Answer> => {
    askForPassOnce();
    const call = async () => {
      const answer = await send({
        guestId: "",
        ...(grant ? { guestGrant: grant } : {}),
      });
      const issued = guestJoinAnswerSchema.safeParse(answer).data;
      if (issued) grant = issued.guestGrant;
      return answer;
    };
    const result = queue.then(call, call);
    queue = result.catch(() => undefined);
    return result;
  };

  /** `pageLoaded` asks for the pass early, well before a join is likely. */
  return { join, pageLoaded: askForPassOnce };
};
