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

type Room = {
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
async function withSavedBoard(run: (room: Room) => Promise<void>) {
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
        const update = Y.encodeStateAsUpdate(roomDoc, data.syncMessage);
        const stateVector = Y.encodeStateVector(roomDoc);
        pendingSync = () => ack!({ syncMessage: update, stateVector });
      }
      if (
        event === "apps:yjs:update" &&
        roomDoc &&
        room.acceptsContent(APP_ID, data.update) &&
        room.reserveUpdate(APP_ID, data.update)
      ) {
        Y.applyUpdate(roomDoc, data.update);
      }
    },
  } as unknown as Socket;

  let drawOnBoard: (() => void) | null = null;
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
    const { presentedDoc } = useContext(AppsContext)!;
    if (!presentedDoc?.ready) {
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
  vi.unstubAllGlobals();
});

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
