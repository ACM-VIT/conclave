// @vitest-environment happy-dom
import { act, useContext, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import {
  AppsContext,
  AppsProvider,
} from "../../../packages/apps-sdk/src/sdk/runtime/AppsProvider";
import { useAppDoc } from "../../../packages/apps-sdk/src/sdk/hooks/useAppDoc";
import { useWhiteboardPages } from "../../../packages/apps-sdk/src/apps/whiteboard/shared/hooks/useWhiteboardPages";
import {
  addElement,
  createWhiteboardDoc,
  getPageElements,
} from "../../../packages/apps-sdk/src/apps/whiteboard/core/doc/index";
import { RoomApps } from "../../../packages/sfu/server/roomApps";

const APP_ID = "whiteboard";
const PAGE_ID = "page-1";
const stroke = (id: string) =>
  ({ id, type: "pen", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }) as never;

type SyncPolicy = {
  // How many sync requests the room refuses first, or all until allowSyncs().
  refuse?: number | "all";
  // Answer syncs at once instead of waiting for deliverSync().
  autoAnswer?: boolean;
};

type Room = {
  status: () => string | null;
  retry: () => void;
  allowSyncs: () => void;
  receive: () => void;
  room: RoomApps;
  deliverSync: () => void;
  syncRequests: () => number;
  // Draws on the mounted board, as the canvas would; false when no board is
  // mounted, so there is nothing to draw on.
  draw: () => boolean;
  roomStrokes: () => string[];
};

// A room whose whiteboard already holds one saved stroke, and a client that
// mounts the board the way the meeting stage does. Sync replies wait until
// the test delivers them, like a slow link.
async function withSavedBoard(run: (room: Room) => Promise<void>, policy: SyncPolicy = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const room = new RoomApps();
  const original = createWhiteboardDoc();
  addElement(original, PAGE_ID, stroke("kept"));
  room.present(APP_ID);
  const saved = Y.encodeStateAsUpdate(original);
  expect(room.reserveUpdate(APP_ID, saved)).toBe(true);
  Y.applyUpdate(room.liveDoc(APP_ID)!, saved);
  room.close();
  room.present(APP_ID);

  const listeners = new Map<string, (payload: unknown) => void>();
  let pendingSync = () => {};
  let syncs = 0;
  let syncsAllowed = false;
  const socket = {
    connected: true,
    on: (event: string, listener: (payload: unknown) => void) => listeners.set(event, listener),
    off: (event: string) => listeners.delete(event),
    emit: (
      event: string,
      data: { update: Uint8Array; syncMessage: Uint8Array },
      ack?: (response: unknown) => void,
    ) => {
      const roomDoc = room.liveDoc(APP_ID);
      if (event === "apps:yjs:sync" && roomDoc) {
        syncs += 1;
        const refused =
          policy.refuse === "all" ? !syncsAllowed : syncs <= (policy.refuse ?? 0);
        if (refused) {
          ack!({ error: "Too many app sync requests" });
          return;
        }
        const update = Y.encodeStateAsUpdate(roomDoc, data.syncMessage);
        const stateVector = Y.encodeStateVector(roomDoc);
        pendingSync = () => ack!({ syncMessage: update, stateVector });
        if (policy.autoAnswer) pendingSync();
      }
      if (
        event === "apps:yjs:update" &&
        roomDoc &&
        room.acceptsContent(APP_ID, "viewer#1", data.update) &&
        room.reserveUpdate(APP_ID, data.update)
      ) {
        Y.applyUpdate(roomDoc, data.update);
      }
    },
  } as unknown as Socket;

  let drawOnBoard: (() => void) | null = null;
  let lastStatus: string | null = null;
  let retryPresentedDoc = () => {};
  function Board() {
    const { doc } = useAppDoc(APP_ID);
    // The canvas binds its document once, as the whiteboard's tool engine does.
    const canvasDoc = useRef(doc).current;
    const { pages, activePageId } = useWhiteboardPages(doc);
    const page = pages.find((candidate) => candidate.id === activePageId);
    drawOnBoard = page ? () => addElement(canvasDoc, page.id, stroke("new")) : null;
    return null;
  }
  function Stage() {
    const context = useContext(AppsContext)!;
    const { presentedDoc } = context;
    lastStatus = presentedDoc?.status ?? null;
    retryPresentedDoc = context.retryPresentedDoc;
    if (presentedDoc?.status !== "ready") {
      drawOnBoard = null;
      return null;
    }
    return <Board key={presentedDoc.key} />;
  }

  const apps = [{ id: APP_ID, name: "Whiteboard", createDoc: createWhiteboardDoc, web: () => null }] as never;
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<AppsProvider socket={socket} apps={apps}><Stage /></AppsProvider>));
  const receive = () => listeners.get("apps:state")!(room.snapshot());
  const roomStrokes = () => {
    const cold = createWhiteboardDoc();
    Y.applyUpdate(cold, Y.encodeStateAsUpdate(room.liveDoc(APP_ID)!));
    const ids = getPageElements(cold, PAGE_ID).map((element) => element.id);
    cold.destroy();
    return ids;
  };
  try {
    await act(async () => receive());
    await run({
      status: () => lastStatus,
      retry: () => retryPresentedDoc(),
      allowSyncs: () => {
        syncsAllowed = true;
      },
      receive,
      room,
      deliverSync: () => pendingSync(),
      syncRequests: () => syncs,
      draw: () => {
        if (!drawOnBoard) return false;
        drawOnBoard();
        return true;
      },
      roomStrokes,
    });
  } finally {
    await act(async () => root.unmount());
    room.clear();
    original.destroy();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

it("keeps the saved board when someone tries to draw before a slow sync arrives", async () => {
  await withSavedBoard(async ({ deliverSync, draw, roomStrokes }) => {
    let drewEarly = false;
    await act(async () => {
      drewEarly = draw();
    });
    expect(drewEarly).toBe(false);

    await act(async () => deliverSync());
    let drewAfterSync = false;
    await act(async () => {
      drewAfterSync = draw();
    });

    expect(drewAfterSync).toBe(true);
    expect(roomStrokes()).toEqual(["kept", "new"]);
  });
});

it("hands the board a fresh document when Close and Present arrive in one batch", async () => {
  await withSavedBoard(async ({ receive, room, deliverSync, syncRequests, draw, roomStrokes }) => {
    await act(async () => deliverSync());
    await act(async () => {
      room.close();
      receive();
      room.present(APP_ID);
      receive();
    });
    await act(async () => deliverSync());
    await act(async () => {
      draw();
    });

    expect(syncRequests()).toBe(2);
    expect(roomStrokes()).toEqual(["kept", "new"]);
  });
});

it("retries a refused first sync and opens the board once a sync is answered", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await withSavedBoard(
    async ({ status, syncRequests, draw, roomStrokes }) => {
      expect(status()).toBe("loading");
      await advance(250);
      await advance(500);

      expect(syncRequests()).toBe(3);
      expect(status()).toBe("ready");
      await act(async () => {
        draw();
      });
      expect(roomStrokes()).toEqual(["kept", "new"]);
    },
    { refuse: 2, autoAnswer: true },
  );
});

it("offers a retry once every sync is refused, and the retry opens the board", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await withSavedBoard(
    async ({ status, syncRequests, retry, allowSyncs }) => {
      await advance(40_000);
      expect(status()).toBe("failed");
      const attempts = syncRequests();
      expect(attempts).toBeGreaterThan(5);
      await advance(40_000);
      expect(syncRequests()).toBe(attempts);

      allowSyncs();
      await act(async () => retry());

      expect(status()).toBe("ready");
    },
    { refuse: "all", autoAnswer: true },
  );
});
