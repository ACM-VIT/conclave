// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestSession } from "../src/lib/guest-identity";
import WebinarLandingClient, {
  type PublicScheduledWebinar,
} from "../src/app/w/[code]/WebinarLandingClient";

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: null, isPending: false }),
}));
vi.mock("../src/app/components/RouteLoadingState", () => ({
  default: ({ title }: { title: string }) => <p>{title}</p>,
}));
// The audience view joins as whichever guest it is mounted with.
vi.mock("../src/app/meets-client-page", () => ({
  default: ({ guest }: { guest?: GuestSession }) => (
    <div data-testid="audience" data-guest={guest?.id} />
  ),
}));

const HOUR = 60 * 60 * 1000;
const OPENED_AT = Date.UTC(2026, 10, 22, 9, 0, 0);

const webinarStartingIn = (hours: number): PublicScheduledWebinar => ({
  id: "webinar-1",
  linkSlug: "launch",
  title: "Launch day",
  description: null,
  hostName: null,
  scheduledStartAt: OPENED_AT + hours * HOUR,
  scheduledEndAt: OPENED_AT + (hours + 1) * HOUR,
  status: "scheduled",
  publicAccess: true,
  requiresInviteCode: false,
  waitingRoomEnabled: false,
  earlyEntryMinutes: 0,
  qaEnabled: true,
  webinarLink: "http://localhost/w/launch",
  roomId: "room-1",
  clientId: "conclave",
  totalJoinCount: 0,
  peakAttendeeCount: 0,
});

const firstVisit: GuestSession = {
  id: "gp_AAAAAAAAAAAAAAAAAAAAAA",
  grant: "grant-from-the-first-render",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers({ now: OPENED_AT });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
  window.localStorage.setItem(
    "conclave:guest-user",
    JSON.stringify({ id: "guest-stored", name: "Asha" }),
  );
  router.refresh.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const openPage = (startsInHours: number, guest: GuestSession) =>
  act(async () =>
    root.render(
      <WebinarLandingClient
        webinarLinkCode="launch"
        initialWebinar={webinarStartingIn(startsInHours)}
        guest={guest}
      />,
    ),
  );

// The clock jumps, as it does for a tab that slept, and the countdown ticks.
const waitHours = (hours: number) =>
  act(async () => {
    vi.setSystemTime(Date.now() + hours * HOUR);
    vi.advanceTimersByTime(1000);
  });

const audience = () => container.querySelector<HTMLElement>('[data-testid="audience"]');

describe("a first-time visitor on the webinar countdown", () => {
  it("joins with a fresh guest once its day-long grant has gone stale", async () => {
    const webinar = webinarStartingIn(30);
    await openPage(30, firstVisit);
    expect(audience()).toBeNull();

    await waitHours(30);

    expect(audience()).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(1);

    const refreshed: GuestSession = {
      id: "gp_BBBBBBBBBBBBBBBBBBBBBB",
      grant: "grant-from-the-refreshed-render",
    };
    await act(async () =>
      root.render(
        <WebinarLandingClient
          webinarLinkCode="launch"
          initialWebinar={webinar}
          guest={refreshed}
        />,
      ),
    );

    expect(audience()?.dataset.guest).toBe(refreshed.id);
  });

  it("asks again when the fresh guest does not arrive", async () => {
    await openPage(30, firstVisit);
    await waitHours(30);
    expect(router.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(router.refresh.mock.calls.length).toBeGreaterThan(1);
    expect(audience()).toBeNull();
  });

  it("joins with the guest it was rendered with after a short wait", async () => {
    await openPage(1, firstVisit);

    await waitHours(1);

    expect(audience()?.dataset.guest).toBe(firstVisit.id);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("a returning visitor on the webinar countdown", () => {
  it("joins with its guest pass however long it waited", async () => {
    const passHolder: GuestSession = { id: "gp_CCCCCCCCCCCCCCCCCCCCCC" };
    await openPage(30, passHolder);

    await waitHours(30);

    expect(audience()?.dataset.guest).toBe(passHolder.id);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
