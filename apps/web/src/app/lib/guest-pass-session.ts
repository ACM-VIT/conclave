const LOCK_NAME = "conclave:guest-pass";
const LOCK_WAIT_MS = 5000;

let pageQueue: Promise<unknown> = Promise.resolve();

const runAfterPageQueue = <T>(task: () => Promise<T>): Promise<T> => {
  const result = pageQueue.then(task, task);
  pageQueue = result.catch(() => undefined);
  return result;
};

/**
 * Runs `task` while no other tab of this browser, and no other call in this
 * page, runs one. A tab never waits for long on another tab: after a few
 * seconds it runs `task` anyway.
 */
const oneAtATime = async <T>(task: () => Promise<T>): Promise<T> => {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return runAfterPageQueue(task);

  let started = false;
  const waiting = new AbortController();
  const giveUp = setTimeout(() => waiting.abort(), LOCK_WAIT_MS);
  try {
    return await locks.request(LOCK_NAME, { signal: waiting.signal }, () => {
      started = true;
      clearTimeout(giveUp);
      return task();
    });
  } catch (error) {
    if (started) throw error;
    return task();
  } finally {
    clearTimeout(giveUp);
  }
};

export type GuestPassFields = { guestId: string; guestGrant?: string };

/**
 * The guest pass side of one page's join calls.
 *
 * Until a join call has answered, the page names no pass and the join route
 * picks one: the pass in the browser's cookie, or a new one. So every tab of
 * a browser ends up on the cookie's pass. After that the page names the pass
 * it was issued, with the grant that stands in for the cookie until the
 * cookie comes back on a request.
 *
 * A browser's first join call plants its pass cookie. Two such calls in
 * flight at once would each plant a different pass, and the tab that lost
 * would come back as someone else after a reload. So the calls that can
 * plant a pass go one at a time, across tabs.
 */
export const createGuestPassSession = () => {
  let pass: GuestPassFields = { guestId: "" };
  let hasAnswer = false;

  return <Answer extends { guestId?: string; guestGrant?: string }>(
    send: (fields: GuestPassFields) => Promise<Answer>,
  ): Promise<Answer> => {
    const call = async () => {
      const answer = await send(pass);
      if (answer.guestId) {
        pass = { guestId: answer.guestId, guestGrant: answer.guestGrant };
      }
      hasAnswer = true;
      return answer;
    };
    return hasAnswer ? call() : oneAtATime(call);
  };
};
