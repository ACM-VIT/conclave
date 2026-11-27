// @vitest-environment node
import { Window } from "happy-dom";
import { act, lazy, Suspense, useState, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scheduledLookup = vi.hoisted(() => vi.fn(async (
  _destination: { clientId: string; roomCode: string },
  _options: { allowLegacyBooking: boolean },
) => null as { clientId?: string; title: string } | null));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
vi.mock("@/lib/auth-client", () => ({ signOut: vi.fn(), useSession: () => ({ data: null }) }));
vi.mock("@/lib/scheduled-meetings", () => ({
  isMeetingJoinable: () => true,
  lookupScheduledMeetingForCode: async (destination: { clientId: string; roomCode: string }, options: { allowLegacyBooking: boolean }) => {
    const meeting = await scheduledLookup(destination, options);
    return meeting ? { kind: "scheduled", clientId: meeting.clientId ?? destination.clientId, meeting } : { kind: "unscheduled" };
  },
  lookupScheduledMeetingHostEmail: async () => null,
}));
vi.mock("@/lib/site-url", () => import("../src/lib/site-url"));
vi.mock("@/lib/meeting-links", () => import("../src/lib/meeting-links"));
vi.mock("@/lib/meeting-origin", () => import("../src/lib/meeting-origin"));
vi.mock("@/lib/sfu-client-id", () => import("../src/lib/sfu-client-id"));
vi.mock("@/app/lib/utils", () => import("../src/app/lib/utils"));
vi.mock("next/dynamic", () => ({ default: lazy }));
vi.mock("../src/app/lib/video-effects-lazy", () => ({
  prewarmVideoEffectsAssetsDeferred: () => Promise.resolve(),
}));
vi.mock("../src/app/meets-client-shell", () => ({ default: () => null }));
vi.mock("../src/app/components/ScheduledMeetingLanding", () => ({ default: () => null }));
vi.mock("../src/app/components/RouteLoadingState", () => ({ default: () => null }));

import MeetRoomPage from "../src/app/[code]/page";
import JoinScreen from "../src/app/components/JoinScreen";
import { ActivityDrawer } from "../src/app/sfu-admin/ActivityDrawer";
import WebinarLandingClient, { type PublicScheduledWebinar } from "../src/app/w/[code]/WebinarLandingClient";
import { APP_ROUTE_SEGMENTS } from "../src/app/lib/utils";
import { DEFAULT_VIDEO_EFFECTS } from "../src/app/lib/video-effects";
import { buildMeetingUrl } from "../src/lib/meeting-links";
import { canonicalizeSfuClientId, resolveBrowserSfuClientId } from "../src/lib/sfu-client-id";

const ORIGIN = "https://conclave.example";
const TENANT = "acme";
const webinarFixture = (): PublicScheduledWebinar => ({
  id: "webinar-1",
  linkSlug: "launch",
  title: "Acme launch",
  description: "A webinar",
  hostName: "Host",
  scheduledStartAt: Date.now() + 3_600_000,
  scheduledEndAt: Date.now() + 7_200_000,
  status: "scheduled",
  publicAccess: true,
  requiresInviteCode: false,
  waitingRoomEnabled: false,
  earlyEntryMinutes: 0,
  qaEnabled: false,
  webinarLink: `${ORIGIN}/w/launch`,
  roomId: "webinar-1",
  clientId: TENANT,
  totalJoinCount: 0,
  peakAttendeeCount: 0,
});

describe("webinar landing destinations", () => {
  it("uses the selected tenant when refreshing webinar status", async () => {
    const webinar = webinarFixture();
    const fetcher = vi.fn(async (url: string) => Response.json({
      scheduledWebinar: new URL(url, ORIGIN).searchParams.get("clientId") === TENANT
        ? { ...webinar, status: "cancelled" }
        : null,
    }));
    vi.stubGlobal("fetch", fetcher);
    const timer = vi.spyOn(window, "setInterval");
    try {
      await act(async () => root.render(
        <WebinarLandingClient webinarLinkCode="launch" clientId={TENANT} initialWebinar={webinar} />,
      ));
      const refresh = timer.mock.calls.find(([, delay]) => delay === 20_000)?.[0];
      if (typeof refresh !== "function") throw new Error("Webinar did not schedule a refresh");
      await act(async () => { refresh(); });
      expect(fetcher).toHaveBeenCalledWith("/api/webinars/by-slug/launch?clientId=acme", { cache: "no-store" });
      expect(container.textContent).toContain("Webinar cancelled");
    } finally {
      timer.mockRestore();
    }
  });

  it("uses the same tenant-scoped URL for clipboard and calendar", async () => {
    await act(async () => root.render(
      <WebinarLandingClient webinarLinkCode="launch" clientId={TENANT} initialWebinar={webinarFixture()} />,
    ));
    const copy = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Copy the link"));
    const calendar = Array.from(container.querySelectorAll("a")).find(link => link.textContent?.includes("Add to calendar"));
    if (!copy || !calendar) throw new Error("Webinar sharing controls are missing");
    await act(async () => copy.click());
    const expected = `${ORIGIN}/w/launch?clientId=acme`;
    const params = new URL(calendar.href).searchParams;
    expect(clipboard).toEqual([expected]);
    expect(params.get("location")).toBe(expected);
    expect(params.get("details")).toContain(`Join: ${expected}`);
  });
});
const LINKABLE = ["team-room", "abc-defg-hij", "a".repeat(64)];
const REWRITTEN_BY_THE_ROUTE = [
  "team_room",
  "Team-Room",
  "TEAM_ROOM",
  "team.room",
  "team room",
  "team--room",
  "-team-room",
  "équipe",
  "acme/standup",
  "schedule",
  "a".repeat(65),
];
const SFU_ROOM_ID = /^[^\u0000-\u001f\u007f]{1,256}$/;

type Landing = { roomId: string; clientId: string } | { page: string };
type ShellProps = { initialRoomId: string; sfuClientId?: string };

async function openLink(link: string): Promise<Landing> {
  const url = new URL(link);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1 || APP_ROUTE_SEGMENTS.some((route) => route === segments[0])) {
    return { page: url.pathname };
  }
  const searchParams: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    searchParams[key] = values.length === 1 ? values[0] : values;
  }
  const page = MeetRoomPage({
    params: Promise.resolve({ code: segments[0] }),
    searchParams: Promise.resolve(searchParams),
  }) as ReactElement<{ children: ReactElement }>;
  const content = page.props.children;
  const render = content.type as (props: unknown) => Promise<ReactElement<ShellProps>>;
  const shell = await render(content.props);
  return {
    roomId: shell.props.initialRoomId,
    clientId: canonicalizeSfuClientId(shell.props.sfuClientId) ?? resolveBrowserSfuClientId(),
  };
}

function seededIds(count: number): string[] {
  let state = 0x2f6e2b1;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = "abcxyzABZ019--_. /%é";
  const ids: string[] = [];
  while (ids.length < count) {
    const length = 1 + Math.floor(next() * 70);
    let id = "";
    for (let i = 0; i < length; i += 1) id += alphabet[Math.floor(next() * alphabet.length)];
    id = id.trim();
    if (SFU_ROOM_ID.test(id)) ids.push(id);
  }
  return ids;
}

describe("meeting links", () => {
  it.each([false, true])("keeps an explicit tenant through a scheduled lookup (exists: %s)", async (exists) => {
    vi.stubEnv("SFU_CLIENT_ID", "review-scheduled");
    scheduledLookup.mockClear();
    scheduledLookup.mockImplementation(async ({ clientId: tenant }) =>
      tenant === "review-scheduled" || (tenant === TENANT && exists) ? { title: "Fixture" } : null,
    );
    try {
      expect(await openLink(`${ORIGIN}/review-cross-route?clientId=acme`)).toEqual({
        roomId: "review-cross-route",
        clientId: TENANT,
      });
      expect(scheduledLookup.mock.calls).toEqual([[{ clientId: TENANT, roomCode: "review-cross-route" }, { allowLegacyBooking: false }]]);
    } finally {
      scheduledLookup.mockImplementation(async () => null);
      vi.unstubAllEnvs();
    }
  });

  it("opens an untagged legacy booking in the tenant returned by the lookup", async () => {
    vi.stubEnv("SFU_CLIENT_ID", TENANT);
    vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", TENANT);
    scheduledLookup.mockClear();
    scheduledLookup.mockResolvedValueOnce({ clientId: "conclave", title: "Legacy booking" });

    try {
      expect(await openLink(`${ORIGIN}/legacy-booking`)).toEqual({ roomId: "legacy-booking", clientId: "conclave" });
      expect(scheduledLookup.mock.calls).toEqual([[{ clientId: TENANT, roomCode: "legacy-booking" }, { allowLegacyBooking: true }]]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("open the room and tenant they name, and are refused only when no link can", async () => {
    const failures: string[] = [];
    const ids = ["", "null", "undefined", ...LINKABLE, ...REWRITTEN_BY_THE_ROUTE, ...seededIds(600)];
    for (const roomCode of ids) {
      for (const clientId of [TENANT, "conclave", "default"]) {
        const wanted = { roomId: roomCode, clientId: canonicalizeSfuClientId(clientId) };
        const link = buildMeetingUrl(ORIGIN, { roomCode, clientId });
        if (link === null) {
          const direct = `${ORIGIN}/${encodeURIComponent(roomCode)}?clientId=${clientId}`;
          const landing = await openLink(direct);
          if (JSON.stringify(landing) === JSON.stringify(wanted)) {
            failures.push(`refused a working link for ${JSON.stringify(roomCode)}`);
          }
          continue;
        }
        const landing = await openLink(link);
        if (JSON.stringify(landing) !== JSON.stringify(wanted)) {
          failures.push(`${link} opened ${JSON.stringify(landing)}, not ${JSON.stringify(wanted)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    for (const roomCode of LINKABLE) {
      expect(buildMeetingUrl(ORIGIN, { roomCode, clientId: TENANT })).not.toBeNull();
    }
  });
});

let browser: Window;
let container: HTMLDivElement;
let root: Root;
let clipboard: string[];
const noop = () => {};

beforeEach(async () => {
  browser = new Window({ url: `${ORIGIN}/integration` });
  clipboard = [];
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", browser.document);
  vi.stubGlobal("navigator", {
    userAgent: browser.navigator.userAgent,
    mediaDevices: { getUserMedia: async () => new browser.MediaStream() },
    clipboard: {
      writeText: async (text: string) => {
        clipboard.push(text);
      },
    },
  });
  vi.stubGlobal("MediaStream", browser.MediaStream);
  vi.stubGlobal("Audio", browser.Audio);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  vi.unstubAllGlobals();
});

function IntegrationPage({ suppliedRoomId, onJoin }: { suppliedRoomId: string; onJoin: (id: string) => void }) {
  const [roomId, setRoomId] = useState(suppliedRoomId);
  const [joined, setJoined] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  if (joined) return <button onClick={() => setJoined(false)}>Leave call</button>;
  return (
    <Suspense fallback={null}>
      <JoinScreen
        roomId={roomId}
        onRoomIdChange={setRoomId}
        onJoinRoom={(id) => {
          onJoin(id);
          setJoined(true);
        }}
        isLoading={false}
        user={{ id: "member", name: "Guest" }}
        userEmail=""
        connectionState="idle"
        isAdmin={isAdmin}
        enableRoomRouting={false}
        forceJoinOnly={false}
        clientId={TENANT}
        showPermissionHint={false}
        rooms={[]}
        roomsStatus="idle"
        onRefreshRooms={noop}
        displayNameInput=""
        onDisplayNameInputChange={noop}
        onUserChange={noop}
        onIsAdminChange={setIsAdmin}
        videoEffects={DEFAULT_VIDEO_EFFECTS}
        onVideoEffectsChange={noop}
      />
    </Suspense>
  );
}

function button(label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (el) => (el.getAttribute("aria-label") ?? el.textContent?.trim()) === label,
  );
}

async function click(label: string) {
  const el = button(label);
  if (!el || el.disabled) throw new Error(`No enabled "${label}" button`);
  await act(async () => el.click());
}

describe("a room ID supplied to a non-routing page", () => {
  it.each([...LINKABLE, ...REWRITTEN_BY_THE_ROUTE])(
    "%j reaches one room through Join, the copied link and opening it",
    async (suppliedRoomId) => {
      const joins: string[] = [];
      await act(async () =>
        root.render(<IntegrationPage suppliedRoomId={suppliedRoomId} onJoin={(id) => joins.push(id)} />),
      );
      await click("Join");
      expect(joins).toEqual([suppliedRoomId]);
      await click("Leave call");

      const copy = button("Copy joining link");
      expect(copy).toBeDefined();
      if (copy!.disabled) {
        expect(LINKABLE).not.toContain(suppliedRoomId);
        const reason = document.getElementById(copy!.getAttribute("aria-describedby") ?? "");
        expect(reason?.textContent).toBe("No shareable link");
        expect(reason?.className).not.toContain("sr-only");
        expect(clipboard).toEqual([]);
        return;
      }
      await act(async () => copy!.click());
      expect(clipboard).toHaveLength(1);
      expect(await openLink(clipboard[0])).toEqual({ roomId: joins[0], clientId: TENANT });
    },
  );
});


describe("scheduled webinar links in the admin drawer", () => {
  it.each([
    ["acme", "review-acme-only", "/w/review-acme-only?clientId=acme"],
    ["conclave", "review-default", "/w/review-default?clientId=conclave"],
    ["acme", "NOT-a-routable-slug", null],
    ["acme", null, null],
  ])("copies the exact tenant destination for %s / %s when shareable", async (clientId, slug, path) => {
    const now = Date.now();
    await act(async () => root.render(
      <ActivityDrawer
        open
        onClose={noop}
        events={[]}
        audit={[]}
        scheduled={[{
          kind: "webinar", id: "w1", title: "Acme isolated webinar", roomId: "sched-abc",
          clientId, slug, status: "scheduled", startAt: now + 60_000, endAt: now + 3_600_000,
          host: "Review Fixture", instanceKey: "local",
        }]}
        rooms={[]}
        selected={null}
        instances={[]}
        onPickRoom={noop}
      />
    ));
    await click("Scheduled");
    if (path === null) {
      expect(button("No shareable link")?.disabled).toBe(true);
      expect(clipboard).toEqual([]);
    } else {
      await click("Copy link");
      expect(clipboard).toEqual([`${ORIGIN}${path}`]);
    }
  });
});
