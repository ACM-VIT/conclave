// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoomView } from "../src/app/sfu-admin/RoomView";
import type { RoomPolicies, RoomSnapshot } from "../src/app/sfu-admin/types";

let container: HTMLDivElement;
let root: Root;

const roomIn = (clientId: string): RoomSnapshot => ({
  id: "weekly-sync",
  channelId: `${clientId}:weekly-sync`,
  clientId,
  hostUserId: null,
  adminUserIds: [],
  screenShareProducerId: null,
  quality: "standard",
  appsState: { activeAppId: null, locked: false },
  policies: {} as RoomPolicies,
  access: { allowedUserKeys: [], lockedAllowedUserKeys: [], blockedUserKeys: [] },
  counts: {
    participants: 0,
    activeParticipants: 0,
    admins: 0,
    guests: 0,
    webinarAttendees: 0,
    pendingUsers: 0,
    blockedUsers: 0,
    producers: 0,
    consumers: 0,
  },
  participants: [],
  pendingUsers: [],
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each(["acme", "conclave"])("copies a %s room's link with its tenant named", async (clientId) => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await act(async () =>
    root.render(
      <RoomView
        room={roomIn(clientId)}
        chat={null}
        instanceUrl="http://sfu.test"
        isBusy={false}
        runAction={vi.fn(async () => true)}
        runBatch={vi.fn(async () => true)}
        onActionSettled={() => {}}
      />,
    ),
  );

  const copy = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Copy link",
  );
  await act(async () => copy?.click());

  expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/weekly-sync?clientId=${clientId}`);
});
