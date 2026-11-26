// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
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
let lookups: string[] = [];

function Parent({ initial, pageClientId }: { initial: string; pageClientId: string }) {
  const [roomId, setRoomId] = useState(initial);
  setParentRoomId = setRoomId;
  parentRoomId = roomId;
  field = useCodeField(roomId, ORIGINS, pageClientId, true);
  const { settledLookup } = field;
  useEffect(() => {
    if (settledLookup) lookups.push(settledLookup);
  }, [settledLookup]);
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

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  lookups = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("the join code field's room lookup", () => {
  it("looks up only a settled, resolved room code without changing the meeting room", async () => {
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
      lookups = [];
      await typeText(text);
      expect({ text, typing: lookups }).toEqual({ text, typing: [] });
      await wait(CODE_FIELD_SETTLE_MS);
      expect(parentRoomId).toBe("");
      expect({ text, lookups }).toEqual({ text, lookups: room ? [room] : [] });
      for (const lookup of lookups) {
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
    expect(lookups).toEqual([]);
    await clear();
    await typeText("https://conclave.acmvit.in/review-room?clientId=default");
    await wait(CODE_FIELD_SETTLE_MS);
    expect(field.tenant).toEqual({ clientId: "conclave", onThisPage: true });
    expect(lookups).toEqual(["review-room"]);
    expect(parentRoomId).toBe("");
  });

  it("looks up a code at once on settle, as on paste or blur", async () => {
    await mount();
    await act(async () => {
      field.change("olive-eren-sokka");
      field.settle();
    });
    await wait(1);
    expect(lookups).toEqual(["olive-eren-sokka"]);
    expect(parentRoomId).toBe("");
  });

  it("keeps slow typing even as it looks up settled prefixes", async () => {
    await mount();
    for (const word of ["nullable-room", "undefined-x", "true", "0", "null-0", "able-room"]) {
      await clear();
      await typeText(word, CODE_FIELD_SETTLE_MS + 50);
      expect({ word, shown: field.text, lookup: field.settledLookup }).toEqual({ word, shown: word, lookup: word });
      expect(parentRoomId).toBe("");
    }
  });

  it("shows a room id the meeting sets from outside, and clears with it", async () => {
    await mount();
    await typeText("http://localhost:3715/olive-eren-sokka");
    await wait(CODE_FIELD_SETTLE_MS);
    expect(lookups).toEqual(["olive-eren-sokka"]);
    expect(parentRoomId).toBe("");
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
