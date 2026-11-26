import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const embedDir = path.resolve(testDir, "..");
const repoDir = path.resolve(embedDir, "..", "..", "..", "..");
const swiftDir = path.join(repoDir, "apps", "conclave-skip", "Sources", "Conclave");

const protocol = await import(pathToFileURL(path.join(embedDir, "protocol.ts")).href);
const fixtures = JSON.parse(readFileSync(path.join(testDir, "wheel-watch-fixtures.json"), "utf8"));

const appFor = (item) => {
  if (item.generate === "wheelEntries") {
    return { kind: "wheel", entries: Array.from({ length: item.count }, (_, index) => ({ id: `i${index}`, label: `Name ${index}` })) };
  }
  if (item.generate === "watchQueue") {
    return {
      kind: "watch",
      queue: Array.from({ length: item.count }, (_, index) => ({ id: `i${index}`, videoId: "dQw4w9WgXcQ", title: "", byName: "" })),
    };
  }
  return item.app;
};

const statusEnvelope = (app) =>
  JSON.stringify({
    v: 1,
    type: "status",
    callSessionId: fixtures.scope.callSessionId,
    appSessionId: fixtures.scope.appSessionId,
    requestId: "e-1",
    payload: app === undefined ? {} : { app },
  });

test("status.app page data is accepted exactly as the fixtures say", () => {
  for (const item of fixtures.appStatus) {
    const app = item.absent ? undefined : appFor(item);
    assert.equal(protocol.isValidAppStatus(app), item.expect, item.name);
    const decoded = protocol.decodeEmbedMessage(
      statusEnvelope(app),
      fixtures.scope,
      protocol.NATIVE_EMBED_ORIGINS.ios,
      protocol.NATIVE_EMBED_ORIGINS.ios,
      true,
    );
    assert.equal(decoded.ok ? "none" : decoded.reason, item.expect ? "none" : "badPayload", `${item.name} (native rules)`);
  }
});

test("pasted links resolve like the SDK parseVideoId (the Swift WatchLinkPolicy reads the same cases)", async () => {
  const { parseVideoId } = await import(pathToFileURL(path.join(embedDir, "..", "apps", "watch", "core", "youtube", "id.ts")).href);
  assert.ok(fixtures.watchLinks.length >= 15);
  for (const item of fixtures.watchLinks) {
    assert.equal(parseVideoId(item.input) ?? "", item.expect, JSON.stringify(item.input));
  }
});

test("the host command list is the Whiteboard commands plus the Wheel and Watch commands", () => {
  const whiteboard = ["setTool", "setColor", "setStrokeWidth", "setFill", "undo", "redo", "setPage", "addPage", "renamePage", "deletePage", "zoomToFit", "export"];
  assert.deepEqual([...protocol.HOST_COMMAND_TYPES], [...whiteboard, ...fixtures.hostCommands]);
  assert.deepEqual([...protocol.NATIVE_TO_EMBED_TYPES], ["snapshot", "update", "awareness", "status", "resync", "close", ...protocol.HOST_COMMAND_TYPES]);
  for (const type of protocol.APP_EDIT_COMMANDS) assert.ok(protocol.HOST_COMMAND_TYPES.includes(type), type);
  assert.ok(!protocol.APP_EDIT_COMMANDS.includes("setSounds") && !protocol.APP_EDIT_COMMANDS.includes("request"));
  assert.ok(!protocol.APP_EDIT_COMMANDS.includes("cancelRequest"), "a locked participant may still ask and withdraw");
  for (const type of fixtures.hostCommands) {
    assert.ok(!/token|key|auth|url|open|eval|exec|navigate|load/i.test(type), `${type} names a capability`);
    const raw = JSON.stringify({ v: 1, type, callSessionId: fixtures.scope.callSessionId, appSessionId: fixtures.scope.appSessionId, requestId: "h-1", payload: {} });
    const decoded = protocol.decodeHostMessage(raw, fixtures.scope);
    assert.ok(decoded.ok, `${type} is a host command`);
  }
  assert.equal(protocol.isValidVideoId("dQw4w9WgXcQ"), true);
  assert.equal(protocol.isValidVideoId("dQw4w9WgXc"), false);
  assert.equal(protocol.isValidVideoId("../../../xx"), false);
});

test("the Swift twin matches the limits, commands and entry files", () => {
  const presenter = readFileSync(path.join(swiftDir, "Features", "Meeting", "Activities", "AppHostPresenter.swift"), "utf8");
  const limits = (enumName) => {
    const block = presenter.match(new RegExp(`enum ${enumName} \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(block, `missing Swift enum ${enumName}`);
    return Object.fromEntries([...block[1].matchAll(/static let (\w+) = (\d+)/g)].map((match) => [match[1], Number(match[2])]));
  };
  const { entries, ...wheelLimits } = protocol.WHEEL_LIMITS;
  assert.deepEqual(limits("AppWheelLimits"), { maxEntries: entries, ...wheelLimits });
  assert.deepEqual(limits("AppWatchLimits"), { ...protocol.WATCH_LIMITS });
  const kinds = presenter.match(/enum AppPageCommandKind: String, CaseIterable, Equatable \{([\s\S]*?)\n\}/);
  assert.ok(kinds, "missing Swift enum AppPageCommandKind");
  const cases = [...kinds[1].matchAll(/case ([^\n]+)/g)].flatMap((line) => line[1].split(",").map((name) => name.trim()));
  assert.deepEqual(cases, fixtures.hostCommands);
  assert.ok(presenter.includes(`static let watchFrameOrigin = "${protocol.WATCH_FRAME_ORIGIN}"`), "AppEmbedFramePolicy.watchFrameOrigin");
  const bridge = readFileSync(path.join(swiftDir, "Core", "Models", "AppBridgeProtocol.swift"), "utf8");
  assert.ok(bridge.includes('return "wheel.html"') && bridge.includes('return "watch.html"'), "AppBridgeProtocol.entryFile serves Wheel and Watch");
  assert.ok(bridge.includes("AppEmbedAppCodec.parse("), "AppBridgeCodec.parseStatus reads status.app");
});

const loadSessionModule = async () => {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    return null;
  }
  const result = await esbuild.build({
    stdin: {
      contents: 'export * from "./session.ts"; export * from "./protocol.ts"; export * as Y from "yjs";',
      resolveDir: embedDir,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const dir = mkdtempSync(path.join(tmpdir(), "native-embed-apps-"));
  const file = path.join(dir, "session.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const sessionModule = await loadSessionModule();
const skipSession = sessionModule === null ? "esbuild is not installed in the workspace" : false;

test("Wheel and Watch commands reach the renderer and are acked under their request ids", { skip: skipSession }, (context) => {
  const { Y } = sessionModule;
  const outbox = [];
  let deliver = () => "none";
  const transport = { platform: "ios", post: (message) => outbox.push(message), onMessage: (next) => { deliver = next; } };
  const scope = { callSessionId: "call-1-contract", appSessionId: "app-wheel-contract", appId: "wheel" };
  const session = new sessionModule.NativeEmbedSession(transport, scope, new Y.Doc());
  context.after(() => {
    session.close();
    session.doc.destroy();
  });
  const seen = [];
  session.start((command) => {
    seen.push(command.type);
    return { ok: command.type !== "spin" };
  });
  let number = 0;
  const host = (type, payload) => {
    number += 1;
    return deliver(JSON.stringify({ v: 1, type, callSessionId: scope.callSessionId, appSessionId: scope.appSessionId, requestId: `h-${number}`, payload }));
  };
  for (const type of fixtures.hostCommands) assert.equal(host(type, {}), "none", type);
  assert.deepEqual(seen, fixtures.hostCommands);
  const acks = outbox.map((raw) => JSON.parse(raw)).filter((message) => message.type === "ack");
  assert.equal(acks.length, fixtures.hostCommands.length);
  assert.deepEqual(acks.map((ack) => ack.requestId), fixtures.hostCommands.map((_, index) => `h-${index + 1}`));
  assert.equal(acks.find((ack) => ack.requestId === `h-${fixtures.hostCommands.indexOf("spin") + 1}`).payload.ok, false);
  assert.equal(host("navigate", {}), "unknownType");
  session.sendStatus({ app: { kind: "wheel", entries: [{ id: "e1", label: "Ada" }], results: [], removeWinner: false, sounds: true, spinning: false, winnerSpinId: "", winnerLabel: "" } });
  const status = outbox[outbox.length - 1];
  const decoded = sessionModule.decodeEmbedMessage(status, scope, sessionModule.NATIVE_EMBED_ORIGINS.ios, sessionModule.NATIVE_EMBED_ORIGINS.ios, true);
  assert.ok(decoded.ok);
});
