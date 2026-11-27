import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  DEFAULT_WHITEBOARD_PAGE_ID,
  createWhiteboardDoc,
  getPageElements,
} from "../../../packages/apps-sdk/src/apps/whiteboard/core/doc/index";
import { ToolEngine } from "../../../packages/apps-sdk/src/apps/whiteboard/core/tools/engine";

const settings = {
  strokeColor: "#e3e3e8",
  fillColor: "transparent",
  strokeWidth: 3,
  textColor: "#e3e3e8",
  fontSize: 16,
  stickyColor: "#fde68a",
};

const recordUpdates = (doc: Y.Doc): Uint8Array[] => {
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  return updates;
};

const replayEach = (updates: Uint8Array[], expectStep: (replica: Y.Doc, step: number) => void) => {
  const replica = createWhiteboardDoc();
  updates.forEach((update, step) => {
    Y.applyUpdate(replica, update);
    expectStep(replica, step);
  });
};

describe("whiteboard updates", () => {
  it.each(["pen", "highlighter"] as const)(
    "sends each %s step as one update that keeps the stroke whole",
    (tool) => {
      const doc = createWhiteboardDoc();
      const updates = recordUpdates(doc);
      const engine = new ToolEngine(doc, DEFAULT_WHITEBOARD_PAGE_ID, tool, settings);
      const moves = 30;

      engine.onPointerDown({ x: 0, y: 0 });
      for (let step = 1; step <= moves; step += 1) engine.onPointerMove({ x: step * 4, y: step });
      engine.onPointerUp();

      expect(updates).toHaveLength(moves + 2);
      const [stroke] = getPageElements(doc, DEFAULT_WHITEBOARD_PAGE_ID);
      replayEach(updates, (replica, step) => {
        const elements = getPageElements(replica, DEFAULT_WHITEBOARD_PAGE_ID);
        expect(elements.map((element) => element.id), `after update ${step}`).toEqual([stroke.id]);
      });
    },
  );

  it("keeps a moved shape whole after every update a drag sends", () => {
    const doc = createWhiteboardDoc();
    const engine = new ToolEngine(doc, DEFAULT_WHITEBOARD_PAGE_ID, "rect", settings);
    engine.onPointerDown({ x: 10, y: 10 });
    engine.onPointerMove({ x: 60, y: 60 });
    engine.onPointerUp();
    const [shape] = getPageElements(doc, DEFAULT_WHITEBOARD_PAGE_ID);
    const before = Y.encodeStateAsUpdate(doc);
    const updates = recordUpdates(doc);
    engine.setTool("select");

    engine.onPointerDown({ x: 30, y: 30 });
    for (let step = 1; step <= 10; step += 1) engine.onPointerMove({ x: 30 + step * 3, y: 30 });
    engine.onPointerUp();

    const replica = createWhiteboardDoc();
    Y.applyUpdate(replica, before);
    updates.forEach((update, step) => {
      Y.applyUpdate(replica, update);
      const ids = getPageElements(replica, DEFAULT_WHITEBOARD_PAGE_ID).map((element) => element.id);
      expect(ids, `after update ${step}`).toEqual([shape.id]);
    });
  });
});
