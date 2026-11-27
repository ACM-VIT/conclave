// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { useSyncedPlayback } from "../../../packages/apps-sdk/src/apps/watch/web/hooks/useSyncedPlayback";
import { createWatchDoc, enqueue, getVideoId, setVideo, writePlayback } from "../../../packages/apps-sdk/src/apps/watch/core/doc/index";

let root: Root;
let player: ReturnType<typeof useSyncedPlayback>;

function Harness({ doc, claimed }: { doc: Y.Doc; claimed: Set<string> }) {
  const writeOnce = (key: string, write: (live: Y.Doc) => void) => {
    if (claimed.has(key)) return;
    claimed.add(key);
    write(doc);
  };
  player = useSyncedPlayback({ doc, videoId: getVideoId(doc), readOnly: false, writeOnce });
  return null;
}

const show = async (doc: Y.Doc, claimed: Set<string>) => {
  await act(async () => root.render(<Harness key={Math.random()} doc={doc} claimed={claimed} />));
};

const copyOf = (doc: Y.Doc) => {
  const copy = createWatchDoc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("advances the queue once per play even when a rebuild hands it the same ended video again", async () => {
  const server = createWatchDoc();
  setVideo(server, "first", { play: true });
  enqueue(server, { videoId: "second" }, { userId: "me", userName: "Me" });
  const claimed = new Set<string>();

  const refusedCopy = copyOf(server);
  await show(refusedCopy, claimed);
  await act(async () => player.onEnded());
  expect(getVideoId(refusedCopy)).toBe("second");

  const replacement = copyOf(server);
  await show(replacement, claimed);
  await act(async () => player.onEnded());
  expect(getVideoId(replacement)).toBe("first");

  vi.setSystemTime(Date.now() + 5_000);
  writePlayback(replacement, { state: "playing", positionSeconds: 0 });
  await act(async () => player.onEnded());
  expect(getVideoId(replacement)).toBe("second");
});
