import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addItem,
  createDevPlaygroundDoc,
  getCounter,
  getItems,
  getMeta,
  getNotes,
  setCounter,
  setNotes,
} from "../../../packages/apps-sdk/src/apps/dev-playground/core/doc/index";
import {
  createWatchDoc,
  enqueue,
  getPlayback,
  getQueue,
  getVideoId,
  getVideoTitle,
  getWatchRequestResolution,
  resolveWatchRequest,
  setVideo,
} from "../../../packages/apps-sdk/src/apps/watch/core/doc/index";
import {
  addElement,
  addPage,
  createWhiteboardDoc,
  DEFAULT_WHITEBOARD_PAGE_ID,
  getActivePageId,
  getMetaMap,
  getOrderedPageIds,
  getPage,
  getPageElements,
  getPageOrder,
  getPagesMap,
  setActivePageId,
} from "../../../packages/apps-sdk/src/apps/whiteboard/core/doc/index";

const EMPTY_UPDATE = [0, 0];

const expectEmptyDoc = (doc: Y.Doc): void => {
  expect(Array.from(Y.encodeStateAsUpdate(doc))).toEqual(EMPTY_UPDATE);
};

const syncJoiningDoc = (
  authoritative: Y.Doc,
  joining: Y.Doc,
  serverFirst: boolean,
): void => {
  const joiningUpdate = Y.encodeStateAsUpdate(joining);
  const serverUpdate = Y.encodeStateAsUpdate(authoritative);
  if (serverFirst) {
    Y.applyUpdate(joining, serverUpdate);
    Y.applyUpdate(authoritative, joiningUpdate);
  } else {
    Y.applyUpdate(authoritative, joiningUpdate);
    Y.applyUpdate(joining, serverUpdate);
  }
};

describe("meeting app Yjs initialization", () => {
  it("keeps factories and all initial reads mutation-free", () => {
    const playground = createDevPlaygroundDoc();
    expect(getCounter(playground)).toBe(0);
    expect(getNotes(playground)).toBe("");
    expect(getItems(playground)).toEqual([]);
    expect(getMeta(playground)).toEqual({ createdAt: null, updatedAt: null });
    expectEmptyDoc(playground);

    const watch = createWatchDoc();
    expect(getVideoId(watch)).toBeNull();
    expect(getVideoTitle(watch)).toBeNull();
    expect(getPlayback(watch)).toMatchObject({
      state: "paused",
      positionSeconds: 0,
      updatedAt: 0,
      rate: 1,
      liveEdge: false,
    });
    expect(getQueue(watch)).toEqual([]);
    expect(getWatchRequestResolution(watch, "missing")).toBeNull();
    expectEmptyDoc(watch);

    const whiteboard = createWhiteboardDoc();
    expect(getPagesMap(whiteboard)).toBeNull();
    expect(getPageOrder(whiteboard)).toBeNull();
    expect(getMetaMap(whiteboard)).toBeNull();
    expect(getOrderedPageIds(whiteboard)).toEqual([
      DEFAULT_WHITEBOARD_PAGE_ID,
    ]);
    expect(getActivePageId(whiteboard)).toBe(DEFAULT_WHITEBOARD_PAGE_ID);
    expect(getPage(whiteboard, DEFAULT_WHITEBOARD_PAGE_ID)).toBeNull();
    expect(getPageElements(whiteboard, DEFAULT_WHITEBOARD_PAGE_ID)).toEqual([]);
    expectEmptyDoc(whiteboard);
  });

  it("cannot reset seeded room state when pre-read joiners sync", () => {
    const playground = createDevPlaygroundDoc();
    setCounter(playground, 7, "host");
    setNotes(playground, "keep this note", "host");
    addItem(playground, "keep this item", "host");

    const watch = createWatchDoc();
    setVideo(watch, "abcdefghijk", {
      play: false,
      positionSeconds: 42,
      title: "Keep this video",
      liveEdge: false,
    });
    enqueue(watch, { videoId: "lmnopqrstuv", title: "Keep this queue item" });
    resolveWatchRequest(watch, "request-1", "added");

    const whiteboard = createWhiteboardDoc();
    addElement(whiteboard, DEFAULT_WHITEBOARD_PAGE_ID, {
      id: "element-1",
      type: "text",
      x: 10,
      y: 20,
      text: "keep this element",
      color: "#ffffff",
      fontSize: 16,
    });
    addPage(whiteboard, { id: "page-2", name: "Keep this page" });
    setActivePageId(whiteboard, "page-2");

    for (let index = 0; index < 100; index += 1) {
      const playgroundJoiner = createDevPlaygroundDoc();
      getCounter(playgroundJoiner);
      getNotes(playgroundJoiner);
      getItems(playgroundJoiner);
      getMeta(playgroundJoiner);
      syncJoiningDoc(playground, playgroundJoiner, index % 2 === 0);
      expect(getCounter(playgroundJoiner)).toBe(7);
      expect(getNotes(playgroundJoiner)).toBe("keep this note");
      expect(getItems(playgroundJoiner)).toEqual(["keep this item"]);

      const watchJoiner = createWatchDoc();
      getPlayback(watchJoiner);
      getQueue(watchJoiner);
      getWatchRequestResolution(watchJoiner, "request-1");
      syncJoiningDoc(watch, watchJoiner, index % 2 !== 0);
      expect(getVideoId(watchJoiner)).toBe("abcdefghijk");
      expect(getVideoTitle(watchJoiner)).toBe("Keep this video");
      expect(getPlayback(watchJoiner)).toMatchObject({
        state: "paused",
        positionSeconds: 42,
        liveEdge: false,
      });
      expect(getQueue(watchJoiner)).toHaveLength(1);
      expect(getWatchRequestResolution(watchJoiner, "request-1")).toBe(
        "added",
      );

      const whiteboardJoiner = createWhiteboardDoc();
      getPagesMap(whiteboardJoiner);
      getPageOrder(whiteboardJoiner);
      getMetaMap(whiteboardJoiner);
      getOrderedPageIds(whiteboardJoiner);
      getActivePageId(whiteboardJoiner);
      getPageElements(whiteboardJoiner, DEFAULT_WHITEBOARD_PAGE_ID);
      syncJoiningDoc(whiteboard, whiteboardJoiner, index % 2 === 0);
      expect(getOrderedPageIds(whiteboardJoiner)).toEqual([
        DEFAULT_WHITEBOARD_PAGE_ID,
        "page-2",
      ]);
      expect(getActivePageId(whiteboardJoiner)).toBe("page-2");
      expect(
        getPageElements(whiteboardJoiner, DEFAULT_WHITEBOARD_PAGE_ID),
      ).toMatchObject([{ id: "element-1", text: "keep this element" }]);
    }

    expect(getCounter(playground)).toBe(7);
    expect(getNotes(playground)).toBe("keep this note");
    expect(getItems(playground)).toEqual(["keep this item"]);
    expect(getVideoId(watch)).toBe("abcdefghijk");
    expect(getQueue(watch)).toHaveLength(1);
    expect(getActivePageId(whiteboard)).toBe("page-2");
    expect(getPageElements(whiteboard, DEFAULT_WHITEBOARD_PAGE_ID)).toHaveLength(
      1,
    );
  });
});
