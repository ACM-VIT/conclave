// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useCodeField } from "../src/app/hooks/useCodeField";
import { normalizeCodeField } from "../src/app/lib/utils";

const ORIGINS = ["https://conclave.acmvit.in", "http://localhost:3715"];
const ROOM_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let root: Root;
let container: HTMLDivElement;
let field: ReturnType<typeof useCodeField>;
let setParentRoomId: (id: string) => void;
let parentRoomId = "";
let lookups: string[] = [];

function Parent({ initial }: { initial: string }) {
  const [roomId, setRoomId] = useState(initial);
  setParentRoomId = setRoomId;
  parentRoomId = roomId;
  return <Field roomId={roomId} onRoomIdChange={setRoomId} />;
}

function Field({ roomId, onRoomIdChange }: { roomId: string; onRoomIdChange: (id: string) => void }) {
  field = useCodeField(roomId, onRoomIdChange, ORIGINS);
  return null;
}

const mount = (initial = "") => act(async () => root.render(<Parent initial={initial} />));

const typeText = async (text: string) => {
  for (const character of text) {
    const value = normalizeCodeField(field.text + character);
    await act(async () => field.change(value));
    if (parentRoomId.trim()) lookups.push(parentRoomId.trim());
  }
};

const clear = () => act(async () => field.change(""));

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  lookups = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the join code field's room id", () => {
  it("only ever hands a resolved room code to the meeting, whatever is typed", async () => {
    await mount();
    const cases: [string, string][] = [
      ["https://internal.corp/doc?token=secret123", ""],
      ["i".repeat(65), ""],
      ["http://localhost:3715/olive-eren-sokka", "olive-eren-sokka"],
      ["https://conclave.acmvit.in/olive-eren-sokka/?ref=chat#top", "olive-eren-sokka"],
      ["abc def ghi ", "abc-def-ghi"],
    ];
    for (const [text, room] of cases) {
      await clear();
      lookups = [];
      await typeText(text);
      expect({ text, shown: field.text, room: parentRoomId }).toEqual({ text, shown: field.text, room });
      for (const lookup of lookups) {
        expect({ text, lookup, code: ROOM_CODE.test(lookup) && lookup.length <= 64 }).toEqual({
          text,
          lookup,
          code: true,
        });
        expect(lookup).not.toMatch(/secret|token|internal|corp|[:/?#.=]/);
      }
    }
  });

  it("keeps the typed text while the meeting holds its code, and shows a code set from outside", async () => {
    await mount();
    await typeText("http://localhost:3715/olive-eren-sokka");
    expect(parentRoomId).toBe("olive-eren-sokka");
    await act(async () => setParentRoomId("olive-eren-sokka"));
    expect(field.text).toBe("http://localhost:3715/olive-eren-sokka");
    await act(async () => setParentRoomId("next-room"));
    expect(field.text).toBe("next-room");
    expect(field.resolution).toEqual({ code: "next-room", tooLong: false });
    await act(async () => setParentRoomId(""));
    expect(field.text).toBe("");
  });

  it("starts from the meeting's room code", async () => {
    await mount("routed-room");
    expect(field.text).toBe("routed-room");
    expect(field.resolution.code).toBe("routed-room");
  });
});
