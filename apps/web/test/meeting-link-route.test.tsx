// @vitest-environment node
import { Window } from "happy-dom";
import { act, lazy, Suspense, useState, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
vi.mock("@/lib/auth-client", () => ({ signOut: vi.fn(), useSession: () => ({ data: null }) }));
vi.mock("@/lib/scheduled-meetings", () => ({
  isMeetingJoinable: () => true,
  lookupPublicScheduledMeetingByRoomCode: async () => null,
  lookupScheduledMeetingHostEmail: async () => null,
}));
vi.mock("@/lib/site-url", () => import("../src/lib/site-url"));
vi.mock("@/lib/meeting-links", () => import("../src/lib/meeting-links"));
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
import { APP_ROUTE_SEGMENTS } from "../src/app/lib/utils";
import { DEFAULT_VIDEO_EFFECTS } from "../src/app/lib/video-effects";
import { buildMeetingUrl } from "../src/lib/meeting-links";
import { canonicalizeSfuClientId, resolveBrowserSfuClientId } from "../src/lib/sfu-client-id";

const ORIGIN = "https://conclave.example";
const TENANT = "acme";
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
  it("open the room and tenant they name, and are refused only when no link can", async () => {
    const failures: string[] = [];
    const ids = [...LINKABLE, ...REWRITTEN_BY_THE_ROUTE, ...seededIds(600)];
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
