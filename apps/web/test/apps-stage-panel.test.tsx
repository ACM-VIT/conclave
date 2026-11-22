// @vitest-environment happy-dom
import { act, useContext, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import {
  AppsContext,
  AppsProvider,
} from "../../../packages/apps-sdk/src/sdk/runtime/AppsProvider";
import type { AppsContextValue } from "../../../packages/apps-sdk/src/sdk/types";
import { AppsPanel } from "../src/app/components/apps/AppsPanel";

type Listener = (...args: unknown[]) => void;
type Emitted = { event: string; args: unknown[] };

let root: Root;
let host: HTMLDivElement;
let ctx: AppsContextValue;
let setPanelOpen: (open: boolean) => void;
const listeners = new Map<string, Listener>();
const emitted: Emitted[] = [];
// What the SFU keeps for each app, and answers a sync with.
const serverDocs = new Map<string, Y.Doc>();
// What the SFU answers a stage command with.
let stageReply: Record<string, unknown> = { success: true };

const socket = {
  connected: true,
  on: (event: string, listener: Listener) => listeners.set(event, listener),
  off: (event: string) => listeners.delete(event),
  emit: (event: string, ...args: unknown[]) => {
    emitted.push({ event, args });
    const ack = args.at(-1);
    if (typeof ack !== "function") return;
    if (event === "apps:yjs:sync") {
      const { appId, syncMessage } = args[0] as { appId: string; syncMessage: Uint8Array };
      const doc = serverDocs.get(appId) ?? new Y.Doc();
      ack({
        syncMessage: Y.encodeStateAsUpdate(doc, syncMessage),
        stateVector: Y.encodeStateVector(doc),
      });
      return;
    }
    if (event.startsWith("apps:") && event !== "apps:getState") ack(stageReply);
  },
} as unknown as Socket;

const apps = [
  { id: "whiteboard", name: "Whiteboard", description: "Draw together", web: () => null },
  { id: "wheel", name: "Spin the wheel", description: "Pick someone", web: () => null },
];

function Probe() {
  ctx = useContext(AppsContext)!;
  return null;
}

function Harness() {
  const [panelOpen, setOpen] = useState(false);
  setPanelOpen = setOpen;
  return (
    <AppsProvider socket={socket} apps={apps as never} isAdmin>
      <Probe />
      {panelOpen && <AppsPanel onClose={() => setOpen(false)} />}
    </AppsProvider>
  );
}

const serverState = async (state: Record<string, unknown>) => {
  await act(async () => listeners.get("apps:state")!({ locked: false, ...state }));
};

const sent = (event: string) => emitted.filter((entry) => entry.event === event);

const button = (label: string): HTMLButtonElement => {
  const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
};

const click = async (label: string) => {
  await act(async () => {
    button(label).click();
  });
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listeners.clear();
  emitted.length = 0;
  serverDocs.clear();
  stageReply = { success: true };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the presented board", () => {
  it("comes back from the room when the host presents it again", async () => {
    const kept = new Y.Doc();
    kept.getMap("shapes").set("circle", 1);
    serverDocs.set("whiteboard", kept);

    await serverState({ activeAppId: "whiteboard", revision: 1, savedAppIds: [] });
    expect(ctx.getDoc("whiteboard").getMap("shapes").get("circle")).toBe(1);

    await serverState({ activeAppId: "wheel", revision: 2, savedAppIds: ["whiteboard"] });
    await serverState({ activeAppId: "whiteboard", revision: 3, savedAppIds: ["wheel"] });

    expect(ctx.getDoc("whiteboard").getMap("shapes").get("circle")).toBe(1);
  });

  it("never uploads a stray local copy of an app that is off the stage", async () => {
    await serverState({ activeAppId: "whiteboard", revision: 1, savedAppIds: ["wheel"] });
    ctx.getDoc("wheel").getMap("entries").set("stale", 1);

    await serverState({ activeAppId: "whiteboard", revision: 2, savedAppIds: [] });
    emitted.length = 0;
    await serverState({ activeAppId: "wheel", revision: 3, savedAppIds: ["whiteboard"] });

    expect(ctx.getDoc("wheel").getMap("entries").get("stale")).toBeUndefined();
    for (const upload of sent("apps:yjs:update")) {
      const received = new Y.Doc();
      Y.applyUpdate(received, (upload.args[0] as { update: Uint8Array }).update);
      expect(received.getMap("entries").get("stale")).toBeUndefined();
    }
  });

  it("starts an app entering the stage from the room's copy, not a stray local one", async () => {
    const kept = new Y.Doc();
    kept.getMap("entries").set("room", 1);
    serverDocs.set("wheel", kept);
    await serverState({ activeAppId: "whiteboard", revision: 1, savedAppIds: ["wheel"] });
    ctx.getDoc("wheel").getMap("entries").set("stale", 1);
    emitted.length = 0;

    await serverState({ activeAppId: "wheel", revision: 2, savedAppIds: ["whiteboard"] });

    const wheel = ctx.getDoc("wheel").getMap("entries");
    expect(wheel.get("room")).toBe(1);
    expect(wheel.get("stale")).toBeUndefined();
    for (const upload of sent("apps:yjs:update")) {
      const received = new Y.Doc();
      Y.applyUpdate(received, (upload.args[0] as { update: Uint8Array }).update);
      expect(received.getMap("entries").get("stale")).toBeUndefined();
    }
  });

  it("starts over from the room when the room starts the board over", async () => {
    const cleared = new Y.Doc();
    cleared.getMap("shapes").set("circle", 1);
    serverDocs.set("whiteboard", cleared);
    await serverState({ activeAppId: "whiteboard", revision: 1, savedAppIds: [], docGeneration: 1 });
    expect(ctx.getDoc("whiteboard").getMap("shapes").get("circle")).toBe(1);

    // The host cleared it and presented it again while this tab missed both.
    const fresh = new Y.Doc();
    fresh.getMap("shapes").set("square", 1);
    serverDocs.set("whiteboard", fresh);
    emitted.length = 0;
    await serverState({ activeAppId: "whiteboard", revision: 4, savedAppIds: [], docGeneration: 2 });

    const shapes = ctx.getDoc("whiteboard").getMap("shapes");
    expect(shapes.get("square")).toBe(1);
    expect(shapes.get("circle")).toBeUndefined();
    for (const upload of sent("apps:yjs:update")) {
      const received = new Y.Doc();
      Y.applyUpdate(received, (upload.args[0] as { update: Uint8Array }).update);
      expect(received.getMap("shapes").get("circle")).toBeUndefined();
    }
  });

  it("keeps drawing while anyone opens and closes the apps panel", async () => {
    await serverState({ activeAppId: "whiteboard", revision: 1, savedAppIds: [] });
    const board = ctx.getDoc("whiteboard");
    emitted.length = 0;

    await act(async () => setPanelOpen(true));
    expect(host.querySelector('aside[aria-label="Apps"]')).not.toBeNull();
    await click("Close apps");
    expect(host.querySelector('aside[aria-label="Apps"]')).toBeNull();
    board.getMap("shapes").set("arrow", 1);

    expect(ctx.getDoc("whiteboard")).toBe(board);
    expect(emitted.map((entry) => entry.event)).toEqual(["apps:yjs:update"]);
    expect(ctx.state.activeAppId).toBe("whiteboard");
  });
});

describe("the apps panel", () => {
  it("presents an app against the stage the host saw", async () => {
    await serverState({ activeAppId: "whiteboard", revision: 4, savedAppIds: [] });
    await act(async () => setPanelOpen(true));

    await click("Present Spin the wheel");

    expect(sent("apps:open").map((entry) => entry.args[0])).toEqual([
      { appId: "wheel", expectedRevision: 4 },
    ]);
  });

  it("clears a saved board only after the host confirms", async () => {
    await serverState({ activeAppId: "wheel", revision: 7, savedAppIds: ["whiteboard"] });
    await act(async () => setPanelOpen(true));
    expect(host.textContent).toContain("Saved");

    await click("Clear Whiteboard");
    expect(sent("apps:discard")).toEqual([]);
    await click("Clear Whiteboard for everyone");

    expect(sent("apps:discard").map((entry) => entry.args[0])).toEqual([
      { appId: "whiteboard", expectedRevision: 7 },
    ]);
  });

  it("asks again when the room changes between the two clicks", async () => {
    await serverState({ activeAppId: "wheel", revision: 7, savedAppIds: ["whiteboard"] });
    await act(async () => setPanelOpen(true));

    await click("Clear Whiteboard");
    await serverState({ activeAppId: "watch", revision: 8, savedAppIds: ["whiteboard", "wheel"] });

    expect(host.querySelector('button[aria-label="Clear Whiteboard for everyone"]')).toBeNull();
    await click("Clear Whiteboard");
    expect(sent("apps:discard")).toEqual([]);
    await click("Clear Whiteboard for everyone");
    expect(sent("apps:discard").map((entry) => entry.args[0])).toEqual([
      { appId: "whiteboard", expectedRevision: 8 },
    ]);
  });

  it("asks again after a move to another room with the same revision", async () => {
    await serverState({ activeAppId: "wheel", revision: 7, savedAppIds: ["whiteboard"] });
    await act(async () => setPanelOpen(true));

    await click("Clear Whiteboard");
    await serverState({ activeAppId: "wheel", revision: 7, savedAppIds: ["whiteboard"], roomId: "other" });

    expect(host.querySelector('button[aria-label="Clear Whiteboard for everyone"]')).toBeNull();
    expect(sent("apps:discard")).toEqual([]);
  });

  it("tells the host to clear a saved app when the room keeps too many", async () => {
    await serverState({ activeAppId: "whiteboard", revision: 4, savedAppIds: [] });
    await act(async () => setPanelOpen(true));
    stageReply = { success: false, error: "Clear an app to present another.", code: "room_full" };

    await click("Present Spin the wheel");

    expect(host.textContent).toContain("Too many saved apps. Clear one to present another.");
    expect(host.textContent).not.toContain("Try again");
  });

  it("asks the host to try again when the stage changed first", async () => {
    await serverState({ activeAppId: "whiteboard", revision: 4, savedAppIds: [] });
    await act(async () => setPanelOpen(true));
    stageReply = { success: false, error: "The stage changed. Try again.", code: "stale_revision" };

    await click("Close Whiteboard");

    expect(host.textContent).toContain("That did not go through. Try again.");
  });

  it("sends a lock against the stage the host saw", async () => {
    await serverState({ activeAppId: "whiteboard", revision: 5, savedAppIds: [] });

    await act(async () => {
      await ctx.setLocked(true);
    });

    expect(sent("apps:lock").map((entry) => entry.args[0])).toEqual([
      { locked: true, expectedRevision: 5 },
    ]);
  });

  it("offers no clear on an older SFU, which sends no revision", async () => {
    await serverState({ activeAppId: "whiteboard" });
    await act(async () => setPanelOpen(true));

    expect(host.querySelector('button[aria-label^="Clear"]')).toBeNull();
    expect(await ctx.clearApp("whiteboard")).toEqual({ ok: false, reason: "failed" });
    expect(sent("apps:discard")).toEqual([]);
  });
});

describe("closing the stage", () => {
  it("sends an older SFU the bare ack it expects", async () => {
    await serverState({ activeAppId: "whiteboard" });
    await act(async () => setPanelOpen(true));

    await click("Close Whiteboard");

    const [close] = sent("apps:close");
    expect(close.args).toHaveLength(1);
    expect(typeof close.args[0]).toBe("function");
  });

  it("sends a newer SFU the revision it last saw", async () => {
    await serverState({ activeAppId: "whiteboard", revision: 9, savedAppIds: [] });
    await act(async () => setPanelOpen(true));

    await click("Close Whiteboard");

    expect(sent("apps:close").map((entry) => entry.args[0])).toEqual([
      { expectedRevision: 9 },
    ]);
  });
});
