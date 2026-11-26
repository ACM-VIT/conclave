// @vitest-environment happy-dom
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODE_FIELD_SETTLE_MS, useCodeField } from "../src/app/hooks/useCodeField";
import { normalizeCodeField } from "../src/app/lib/utils";

const ORIGINS = ["https://conclave.acmvit.in", "http://localhost:3715"];
const ROOM_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let root: Root;
let container: HTMLDivElement;
let field: ReturnType<typeof useCodeField>;
let setParentRoomId: (id: string) => void;
let parentRoomId = "";
let published: string[] = [];

function Parent({ initial, pageClientId }: { initial: string; pageClientId: string }) {
  const [roomId, setRoomId] = useState(initial);
  setParentRoomId = setRoomId;
  parentRoomId = roomId;
  const onRoomIdChange = useCallback((id: string) => {
    published.push(id);
    setRoomId(id);
  }, []);
  return <Field roomId={roomId} onRoomIdChange={onRoomIdChange} pageClientId={pageClientId} />;
}

function Field({
  roomId,
  onRoomIdChange,
  pageClientId,
}: {
  roomId: string;
  onRoomIdChange: (id: string) => void;
  pageClientId: string;
}) {
  field = useCodeField(roomId, onRoomIdChange, ORIGINS, pageClientId);
  return null;
}

const mount = (initial = "", pageClientId = "conclave") =>
  act(async () => root.render(<Parent initial={initial} pageClientId={pageClientId} />));

const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

const typeText = async (text: string, pauseMs = 30) => {
  for (const character of text) {
    const value = normalizeCodeField(field.text + character);
    await act(async () => field.change(value));
    await wait(pauseMs);
  }
};

const clear = async () => {
  await act(async () => field.change(""));
  await wait(1);
};

const lookups = () => published.filter((id) => id.length > 0);

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  published = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("the join code field's room id", () => {
  it("hands the meeting only a settled, resolved room code, whatever is typed", async () => {
    await mount();
    const cases: [string, string][] = [
      ["https://internal.corp/doc?token=secret123", ""],
      ["confidential-project.internal.example/path?token=abc", ""],
      ["i".repeat(65), ""],
      ["http://localhost:3715/olive-eren-sokka", "olive-eren-sokka"],
      ["https://conclave.acmvit.in/olive-eren-sokka/?ref=chat#top", "olive-eren-sokka"],
      ["abc def ghi ", "abc-def-ghi"],
    ];
    for (const [text, room] of cases) {
      await clear();
      published = [];
      await typeText(text);
      expect({ text, typing: lookups() }).toEqual({ text, typing: [] });
      await wait(CODE_FIELD_SETTLE_MS);
      expect({ text, room: parentRoomId }).toEqual({ text, room });
      expect({ text, lookups: lookups() }).toEqual({ text, lookups: room ? [room] : [] });
      for (const lookup of lookups()) {
        expect(ROOM_CODE.test(lookup) && lookup.length <= 64).toBe(true);
      }
    }
  });

  it("never publishes another tenant's code to this page's lookups", async () => {
    await mount();
    await typeText("https://conclave.acmvit.in/review-room?clientId=review-alt");
    await wait(CODE_FIELD_SETTLE_MS * 2);
    expect(field.resolution.code).toBe("review-room");
    expect(field.tenant).toEqual({ clientId: "review-alt", onThisPage: false });
    expect(parentRoomId).toBe("");
    expect(lookups()).toEqual([]);
    await clear();
    await typeText("https://conclave.acmvit.in/review-room?clientId=default");
    await wait(CODE_FIELD_SETTLE_MS);
    expect(field.tenant).toEqual({ clientId: "conclave", onThisPage: true });
    expect(parentRoomId).toBe("review-room");
  });

  it("publishes at once on settle, as on paste, blur or Enter", async () => {
    await mount();
    await act(async () => {
      field.change("olive-eren-sokka");
      field.settle();
    });
    await wait(1);
    expect(parentRoomId).toBe("olive-eren-sokka");
  });

  it("never erases typing when a published prefix comes back from the meeting", async () => {
    await mount();
    for (const word of ["nullable-room", "undefined-x", "true", "0", "null-0", "able-room"]) {
      await clear();
      await typeText(word, CODE_FIELD_SETTLE_MS + 50);
      expect({ word, shown: field.text, room: parentRoomId }).toEqual({ word, shown: word, room: word });
    }
  });

  it("shows a room id the meeting sets from outside, and clears with it", async () => {
    await mount();
    await typeText("http://localhost:3715/olive-eren-sokka");
    await wait(CODE_FIELD_SETTLE_MS);
    expect(parentRoomId).toBe("olive-eren-sokka");
    expect(field.text).toBe("http://localhost:3715/olive-eren-sokka");
    await act(async () => setParentRoomId("next-room"));
    expect(field.text).toBe("next-room");
    expect(field.resolution.code).toBe("next-room");
    await act(async () => setParentRoomId(""));
    expect(field.text).toBe("");
  });

  it("starts from the meeting's room code and hides a legacy empty marker", async () => {
    await mount("routed-room");
    expect(field.text).toBe("routed-room");
    expect(field.resolution.code).toBe("routed-room");
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount("null");
    expect(field.text).toBe("");
  });
});
