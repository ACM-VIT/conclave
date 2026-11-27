import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  ADMIT_ONE_KNOCK_EXPRESSION,
  JOINED_ROOM_STORAGE_KEY,
  buildOpensRoomScript,
} from "./room-access.mjs";

const appSource = (path) => readFileSync(new URL(`../../apps/web/src/app/${path}`, import.meta.url), "utf8");

test("the publisher's page is the tab that may open its room, as the web app reads it", () => {
  const stored = new Map();
  const window = { sessionStorage: { setItem: (key, value) => stored.set(key, value) } };
  vm.runInNewContext(buildOpensRoomScript("Quality-Room-1"), { window, JSON });
  assert.deepEqual(JSON.parse(stored.get(JOINED_ROOM_STORAGE_KEY)), {
    roomId: "quality-room-1",
    recoveryPass: null,
  });
  assert.match(
    appSource("lib/joined-room.ts"),
    new RegExp(`const STORAGE_KEY = "${JOINED_ROOM_STORAGE_KEY}";`),
  );
});

test("the publisher admits the one knock it is shown, not everyone", () => {
  const clicked = [];
  const button = (label) => ({
    disabled: false,
    getAttribute: (name) => (name === "aria-label" ? label : null),
    click: () => clicked.push(label),
  });
  const document = {
    querySelectorAll: () => [button("Deny Quality Viewer"), button("Admit all"), button("Admit Quality Viewer")],
  };
  assert.equal(vm.runInNewContext(ADMIT_ONE_KNOCK_EXPRESSION, { document, Array }).ok, true);
  assert.deepEqual(clicked, ["Admit Quality Viewer"]);
  assert.match(appSource("components/KnockPrompt.tsx"), /aria-label=\{`Admit \$\{single\.name\}`\}/);
});
