// Contract test for the native embed bridge v1 (S60 0.8 C6-19, ACT-7). apps-sdk has no test runner, so this is a plain
// node:test script: `pnpm -C packages/apps-sdk run test:native-embed` (node --test). It pins three things:
//   1. src/native-embed/protocol.ts against the shared contract-fixtures.json (the Swift codec reads the same file in
//      apps/conclave-skip/Tests/ConclaveTests/ACT7AppHostTests.swift), including generated size-bound cases;
//   2. the Swift twin's constants and type lists (Core/Models/AppBridgeProtocol.swift) against protocol.ts;
//   3. bridge-level convergence of two embed sessions through a fake native relay and room document: snapshot then diff,
//      remote updates, a reconnect that sends nothing twice, read-only, hostile host messages, acks and close. This part
//      bundles session.ts with esbuild (hoisted in the workspace) and is skipped with a message when esbuild is absent.
// protocol.ts has no imports and only erasable TypeScript, so Node loads it directly (type stripping, Node 22.18+).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const embedDir = path.join(packageDir, "src", "native-embed");
const repoDir = path.resolve(packageDir, "..", "..");
const swiftProtocolPath = path.join(repoDir, "apps", "conclave-skip", "Sources", "Conclave", "Core", "Models", "AppBridgeProtocol.swift");

const protocol = await import(pathToFileURL(path.join(embedDir, "protocol.ts")).href);
const fixtures = JSON.parse(readFileSync(path.join(embedDir, "contract-fixtures.json"), "utf8"));

const envelope = (type, payload, overrides = {}) =>
  JSON.stringify({
    v: 1,
    type,
    callSessionId: fixtures.scope.callSessionId,
    appSessionId: fixtures.scope.appSessionId,
    requestId: "e-9",
    payload,
    ...overrides,
  });

const base64Of = (length) => Buffer.alloc(length, 7).toString("base64");

test("embed messages decode exactly as the fixtures say", () => {
  for (const item of fixtures.embedToNative) {
    const result = protocol.decodeEmbedMessage(item.raw, fixtures.scope, item.origin, fixtures.expectedOrigin, item.isMainFrame);
    const reason = result.ok ? "none" : result.reason;
    assert.equal(reason, item.expect, item.name);
  }
});

test("host messages decode exactly as the fixtures say", () => {
  for (const item of fixtures.hostToEmbed) {
    const result = protocol.decodeHostMessage(item.raw, fixtures.scope);
    const reason = result.ok ? "none" : result.reason;
    assert.equal(reason, item.expect, item.name);
  }
});

test("size bounds hold at and just over each limit", () => {
  for (const item of fixtures.generated) {
    let raw;
    if (item.type === "pad") {
      raw = envelope("status", { pad: "x".repeat(item.characters) });
    } else {
      raw = envelope(item.type, { update: base64Of(item.bytes) });
    }
    const result = protocol.decodeEmbedMessage(raw, fixtures.scope, fixtures.expectedOrigin, fixtures.expectedOrigin, true);
    assert.equal(result.ok ? "none" : result.reason, item.expect, item.name);
  }
  const png = protocol.decodeEmbedMessage(
    envelope("ack", { ok: true, pngBase64: "A".repeat(protocol.base64CharacterLimit(protocol.NATIVE_EMBED_LIMITS.exportBytes) + 4) }),
    fixtures.scope,
    fixtures.expectedOrigin,
    fixtures.expectedOrigin,
    true,
  );
  assert.equal(png.ok ? "none" : png.reason, "payloadTooLarge");
});

test("no message can carry a native method, a token or a URL load", () => {
  // The only embed-to-native types are data messages; nothing names a native method or carries credentials.
  assert.deepEqual([...protocol.EMBED_TO_NATIVE_TYPES], ["ready", "sync", "update", "awareness", "status", "ack", "resize"]);
  for (const type of protocol.EMBED_TO_NATIVE_TYPES) {
    assert.ok(!/token|key|auth|url|open|eval|exec/i.test(type), type);
  }
  const source = readFileSync(path.join(embedDir, "session.ts"), "utf8") + readFileSync(path.join(embedDir, "bridge.ts"), "utf8");
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|io\(|localStorage|document\.cookie/.test(source), "embed sources reach the network or storage");
});

test("the scope comes only from a well-formed fragment", () => {
  const good = protocol.parseScope(`#v=1&callSessionId=${fixtures.scope.callSessionId}&appSessionId=${fixtures.scope.appSessionId}&appId=whiteboard`);
  assert.deepEqual(good, fixtures.scope);
  assert.equal(protocol.parseScope("#v=2&callSessionId=a&appSessionId=b&appId=whiteboard"), null);
  assert.equal(protocol.parseScope("#v=1&callSessionId=a b&appSessionId=b&appId=whiteboard"), null);
  assert.equal(protocol.parseScope(""), null);
  assert.equal(protocol.bundleMajor(protocol.NATIVE_EMBED_BUNDLE_VERSION), 1);
  assert.equal(protocol.bundleMajor("x.1"), -1);
});

test("the Swift twin matches protocol.ts", () => {
  const swift = readFileSync(swiftProtocolPath, "utf8");
  const constant = (name) => {
    const match = swift.match(new RegExp(`static let ${name} = ([^\\n]+)`));
    assert.ok(match, `missing Swift constant ${name}`);
    return match[1].trim().replace(/_/g, "").replace(/^"|"$/g, "");
  };
  const limits = protocol.NATIVE_EMBED_LIMITS;
  assert.equal(Number(constant("version")), protocol.NATIVE_EMBED_PROTOCOL_VERSION);
  assert.equal(Number(constant("bundleMajor")), protocol.bundleMajor(protocol.NATIVE_EMBED_BUNDLE_VERSION));
  assert.equal(constant("handlerName"), protocol.NATIVE_EMBED_HANDLER_NAME);
  assert.equal(constant("iosOrigin"), protocol.NATIVE_EMBED_ORIGINS.ios);
  assert.equal(constant("androidOrigin"), protocol.NATIVE_EMBED_ORIGINS.android);
  assert.equal(Number(constant("envelopeCharacterLimit")), limits.envelopeCharacters);
  assert.equal(Number(constant("updateByteLimit")), limits.updateBytes);
  assert.equal(Number(constant("awarenessByteLimit")), limits.awarenessBytes);
  assert.equal(Number(constant("stateVectorByteLimit")), limits.stateVectorBytes);
  assert.equal(Number(constant("snapshotByteLimit")), limits.snapshotBytes);
  assert.equal(Number(constant("exportByteLimit")), limits.exportBytes);
  assert.equal(Number(constant("identifierLimit")), limits.identifier);
  assert.equal(Number(constant("pageLimit")), limits.pages);
  assert.equal(Number(constant("pageNameLimit")), limits.pageName);
  assert.equal(Number(constant("requestMemory")), limits.requestMemory);
  const cases = (enumName) => {
    const block = swift.match(new RegExp(`enum ${enumName}: String, CaseIterable, Equatable \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(block, `missing Swift enum ${enumName}`);
    return [...block[1].matchAll(/case ([^\n]+)/g)].flatMap((line) => line[1].split(",").map((name) => name.trim()));
  };
  assert.deepEqual(cases("AppBridgeInboundType"), [...protocol.EMBED_TO_NATIVE_TYPES]);
  assert.deepEqual(cases("AppBridgeOutboundType"), [...protocol.NATIVE_TO_EMBED_TYPES]);
  assert.deepEqual(cases("AppWhiteboardTool").filter((name) => !name.startsWith("var")), [...protocol.WHITEBOARD_TOOLS]);
  const rejections = new Set(cases("AppBridgeRejection"));
  for (const item of [...fixtures.embedToNative, ...fixtures.hostToEmbed, ...fixtures.generated]) {
    assert.ok(rejections.has(item.expect), `Swift lacks ${item.expect}`);
  }
  const inkCases = [...swift.matchAll(/case [a-zA-Z]+ = "(#[0-9a-f]{6})"/g)].map((match) => match[1]);
  if (inkCases.length > 0) assert.deepEqual(inkCases, [...protocol.INK_COLORS]);
});

// MARK: Bridge-level convergence (session.ts through a fake native relay)

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
  const dir = mkdtempSync(path.join(tmpdir(), "native-embed-contract-"));
  const file = path.join(dir, "session.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const sessionModule = await loadSessionModule();
const skipConvergence = sessionModule === null ? "esbuild is not installed in the workspace" : false;

/** The fake native host and room: validates every embed message like native does, keeps the room's Y.Doc. */
const makeRoom = (mod) => {
  const { Y } = mod;
  const room = new Y.Doc();
  const clients = [];
  const roomUpdates = [];
  const deliver = (client, type, payload, requestId) => {
    client.requestNumber += 1;
    const raw = JSON.stringify({
      v: 1,
      type,
      callSessionId: client.scope.callSessionId,
      appSessionId: client.scope.appSessionId,
      requestId: requestId ?? `n-${client.requestNumber}`,
      payload,
    });
    return client.handler(raw);
  };
  const snapshot = (client, vector, requestId) => {
    deliver(client, "snapshot", {
      syncMessage: mod.base64FromBytes(Y.encodeStateAsUpdate(room, vector)),
      stateVector: mod.base64FromBytes(Y.encodeStateVector(room)),
    }, requestId);
  };
  const pump = () => {
    let moved = true;
    while (moved) {
      moved = false;
      for (const client of clients) {
        while (client.outbox.length > 0) {
          moved = true;
          const raw = client.outbox.shift();
          const decoded = mod.decodeEmbedMessage(raw, client.scope, mod.NATIVE_EMBED_ORIGINS.ios, mod.NATIVE_EMBED_ORIGINS.ios, true);
          assert.ok(decoded.ok, `native rejected an embed message: ${decoded.ok ? "" : decoded.reason}`);
          const message = decoded.envelope;
          client.received.push(message.type);
          if (message.type === "ready") {
            deliver(client, "status", client.host);
            if (client.host.connection === "live") {
              snapshot(client, mod.bytesFromBase64(message.payload.stateVector, 65536).bytes, message.requestId);
            }
          } else if (message.type === "sync") {
            snapshot(client, mod.bytesFromBase64(message.payload.stateVector, 65536).bytes, message.requestId);
          } else if (message.type === "update") {
            if (client.host.readOnly || client.host.connection !== "live") continue;
            const bytes = mod.bytesFromBase64(message.payload.update, 262144).bytes;
            roomUpdates.push(bytes);
            Y.applyUpdate(room, bytes, "client");
            for (const other of clients) {
              if (other !== client) deliver(other, "update", { update: message.payload.update });
            }
          } else if (message.type === "ack") {
            client.acks.push(message);
          }
        }
      }
    }
  };
  const join = (name, host = {}) => {
    const outbox = [];
    const client = {
      name,
      scope: { callSessionId: "call-1-contract", appSessionId: `app-${name}`, appId: "whiteboard" },
      host: { readOnly: false, connection: "live", reduceMotion: false, pencilOnly: false, userId: name, userName: name, ...host },
      outbox,
      received: [],
      acks: [],
      requestNumber: 0,
      handler: () => "none",
    };
    const transport = {
      platform: "ios",
      post: (message) => outbox.push(message),
      onMessage: (next) => {
        client.handler = next;
      },
    };
    client.session = new mod.NativeEmbedSession(transport, client.scope, new Y.Doc());
    clients.push(client);
    client.session.start();
    pump();
    return client;
  };
  return { Y, room, roomUpdates, join, pump, deliver };
};

const text = (Y, doc) => doc.getMap("whiteboard").toJSON();

test("two embeds converge: snapshot first, then only what the room lacks", { skip: skipConvergence }, () => {
  const harness = makeRoom(sessionModule);
  const ada = harness.join("ada");
  assert.ok(ada.session.isSynced);
  ada.session.doc.getMap("whiteboard").set("stroke-1", "ada");
  harness.pump();
  assert.equal(harness.roomUpdates.length, 1);
  const ben = harness.join("ben");
  assert.deepEqual(text(harness.Y, ben.session.doc), { "stroke-1": "ada" });
  ben.session.doc.getMap("whiteboard").set("stroke-2", "ben");
  harness.pump();
  assert.deepEqual(text(harness.Y, ada.session.doc), { "stroke-1": "ada", "stroke-2": "ben" });
  assert.deepEqual(text(harness.Y, harness.room), { "stroke-1": "ada", "stroke-2": "ben" });
});

test("a reconnect resyncs and sends nothing twice", { skip: skipConvergence }, () => {
  const harness = makeRoom(sessionModule);
  const ada = harness.join("ada");
  const ben = harness.join("ben");
  ada.host = { ...ada.host, connection: "reconnecting" };
  harness.deliver(ada, "status", ada.host);
  ada.session.doc.getMap("whiteboard").set("offline", "drawn while reconnecting");
  harness.pump();
  assert.equal(harness.roomUpdates.length, 0, "nothing leaves while reconnecting");
  ada.host = { ...ada.host, connection: "live" };
  harness.deliver(ada, "status", ada.host);
  harness.deliver(ada, "resync", {});
  harness.pump();
  assert.equal(harness.roomUpdates.length, 1, "the post-snapshot diff carries the offline edit exactly once");
  assert.deepEqual(text(harness.Y, ben.session.doc), { offline: "drawn while reconnecting" });
  harness.deliver(ada, "resync", {});
  harness.pump();
  assert.equal(harness.roomUpdates.length, 1, "a second resync with nothing new sends nothing");
});

test("read-only embeds draw nothing into the room", { skip: skipConvergence }, () => {
  const harness = makeRoom(sessionModule);
  const viewer = harness.join("viewer", { readOnly: true });
  viewer.session.doc.getMap("whiteboard").set("blocked", "x");
  harness.pump();
  assert.equal(harness.roomUpdates.length, 0);
});

test("hostile host messages are dropped and counted by reason", { skip: skipConvergence }, () => {
  const harness = makeRoom(sessionModule);
  const ada = harness.join("ada");
  const stale = JSON.stringify({ v: 1, type: "update", callSessionId: ada.scope.callSessionId, appSessionId: "app-old", requestId: "n-90", payload: { update: "AQID" } });
  assert.equal(ada.handler(stale), "staleAppSession");
  const unknown = JSON.stringify({ v: 1, type: "navigate", callSessionId: ada.scope.callSessionId, appSessionId: ada.scope.appSessionId, requestId: "n-91", payload: {} });
  assert.equal(ada.handler(unknown), "unknownType");
  assert.equal(harness.deliver(ada, "zoomToFit", {}, "h-7"), "none");
  assert.equal(harness.deliver(ada, "zoomToFit", {}, "h-7"), "duplicateRequest");
  assert.ok(ada.session.rejections.includes("staleAppSession"));
});

test("commands answer with an ack carrying their request id", { skip: skipConvergence }, () => {
  const harness = makeRoom(sessionModule);
  const ada = harness.join("ada");
  ada.session.setCommandHandler((command) => ({ ok: command.type === "setTool" }));
  harness.deliver(ada, "setTool", { tool: "eraser" }, "h-1");
  harness.deliver(ada, "undo", {}, "h-2");
  harness.pump();
  assert.deepEqual(ada.acks.map((ack) => [ack.requestId, ack.payload.ok]), [["h-1", true], ["h-2", false]]);
});

test("close invalidates the session for good", { skip: skipConvergence }, () => {
  const harness = makeRoom(sessionModule);
  const ada = harness.join("ada");
  harness.deliver(ada, "close", {});
  assert.ok(ada.session.isClosed);
  ada.session.doc.getMap("whiteboard").set("after-close", "x");
  harness.pump();
  assert.equal(harness.roomUpdates.length, 0);
  assert.equal(harness.deliver(ada, "update", { update: "AQID" }), "staleAppSession");
});
