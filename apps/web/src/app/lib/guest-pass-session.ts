const SEAT_TOKENS_STORAGE_KEY = "conclave:guest-seat-tokens";
const MAX_STORED_SEAT_TOKENS = 20;
const GUEST_PASS_REQUEST_TIMEOUT_MS = 5000;

type SeatTokens = Record<string, string>;

const readSeatTokens = (): SeatTokens => {
  try {
    const raw = window.sessionStorage.getItem(SEAT_TOKENS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SeatTokens)
      : {};
  } catch {
    return {};
  }
};

const storeSeatToken = (seat: string, token: string): void => {
  try {
    const { [seat]: _replaced, ...others } = readSeatTokens();
    const kept = Object.entries(others).slice(1 - MAX_STORED_SEAT_TOKENS);
    window.sessionStorage.setItem(
      SEAT_TOKENS_STORAGE_KEY,
      JSON.stringify({ ...Object.fromEntries(kept), [seat]: token }),
    );
  } catch {
    // Without session storage a reload starts the tab over as a new guest.
  }
};

export type GuestPassFields = {
  guestId: "";
  guestGrant?: string;
  guestSeatToken?: string;
};

type JoinAnswer = { token: string; guestId?: string; guestGrant?: string };

/**
 * How a page asks the server to give its browser a guest pass. A page that
 * was rendered for a signed-in account has no use for one and asks nothing.
 */
export const guestPassRequestFor =
  (user?: { id?: string; email?: string | null }) =>
  async (): Promise<void> => {
    if (user?.id || user?.email) return;
    await fetch("/api/guest-pass", {
      method: "POST",
      signal: AbortSignal.timeout(GUEST_PASS_REQUEST_TIMEOUT_MS),
    });
  };

/**
 * The guest side of one page's join calls.
 *
 * The page never names a pass. The join route picks it: the pass in the
 * browser's cookie, or a new one. Two things travel with each call:
 *
 * - the grant from the last answer, which stands in for the cookie in a
 *   browser that has not sent it back yet, or never will;
 * - the token of this tab's last join for the same room. Tabs keep it across
 *   a reload. It is how a tab that joined before the browser's pass settled
 *   keeps its seat, and what the seat held, once it moves to that pass.
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

  const join = <Answer extends JoinAnswer>(
    seat: string,
    send: (fields: GuestPassFields) => Promise<Answer>,
  ): Promise<Answer> => {
    askForPassOnce();
    const call = async () => {
      const guestSeatToken = readSeatTokens()[seat];
      const answer = await send({
        guestId: "",
        ...(grant ? { guestGrant: grant } : {}),
        ...(guestSeatToken ? { guestSeatToken } : {}),
      });
      if (answer.guestId) {
        grant = answer.guestGrant;
        storeSeatToken(seat, answer.token);
      }
      return answer;
    };
    const result = queue.then(call, call);
    queue = result.catch(() => undefined);
    return result;
  };

  /** `pageLoaded` asks for the pass early, well before a join is likely. */
  return { join, pageLoaded: askForPassOnce };
};
