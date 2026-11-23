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
const limits = await import(pathToFileURL(path.join(packageDir, "src", "sdk", "limits.ts")).href);
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

const makeRoom = (mod, context) => {
  const { Y } = mod;
  const room = new Y.Doc();
  const clients = [];
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const settle = async () => {
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      context.mock.timers.tick(1_000);
    }
  };
  context.after(() => {
    for (const client of clients) {
      client.session.close();
      client.session.doc.destroy();
    }
    room.destroy();
  });
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
  const pump = async () => {
    let moved = true;
    while (moved) {
      moved = false;
      await settle();
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
  const join = async (name, host = {}) => {
    const outbox = [];
    const client = {
      name,
      scope: { callSessionId: "call-1-contract", appSessionId: `app-${name}`, appId: "whiteboard" },
      host: { readOnly: false, connection: "live", reduceMotion: false, pencilOnly: false, userId: name, userName: name, ...host },
      outbox,
      received: [],
      acks: [],
      updatesPostedAt: [],
      updateSizes: [],
      requestNumber: 0,
      handler: () => "none",
    };
    const transport = {
      platform: "ios",
      post: (message) => {
        outbox.push(message);
        const posted = JSON.parse(message);
        if (posted.type === "update") {
          client.updatesPostedAt.push(Date.now());
          client.updateSizes.push(Buffer.from(posted.payload.update, "base64").length);
        }
      },
      onMessage: (next) => {
        client.handler = next;
      },
    };
    client.session = new mod.NativeEmbedSession(transport, client.scope, new Y.Doc());
    clients.push(client);
    client.session.start();
    await pump();
    return client;
  };
  return { Y, room, roomUpdates, join, pump, deliver };
};

const text = (Y, doc) => doc.getMap("whiteboard").toJSON();

test("two embeds converge: snapshot first, then only what the room lacks", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ada = await harness.join("ada");
  assert.ok(ada.session.isSynced);
  ada.session.doc.getMap("whiteboard").set("stroke-1", "ada");
  await harness.pump();
  assert.equal(harness.roomUpdates.length, 1);
  const ben = await harness.join("ben");
  assert.deepEqual(text(harness.Y, ben.session.doc), { "stroke-1": "ada" });
  ben.session.doc.getMap("whiteboard").set("stroke-2", "ben");
  await harness.pump();
  assert.deepEqual(text(harness.Y, ada.session.doc), { "stroke-1": "ada", "stroke-2": "ben" });
  assert.deepEqual(text(harness.Y, harness.room), { "stroke-1": "ada", "stroke-2": "ben" });
});

test("a reconnect resyncs and sends nothing twice", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ada = await harness.join("ada");
  const ben = await harness.join("ben");
  ada.host = { ...ada.host, connection: "reconnecting" };
  harness.deliver(ada, "status", ada.host);
  ada.session.doc.getMap("whiteboard").set("offline", "drawn while reconnecting");
  await harness.pump();
  assert.equal(harness.roomUpdates.length, 0, "nothing leaves while reconnecting");
  ada.host = { ...ada.host, connection: "live" };
  harness.deliver(ada, "status", ada.host);
  harness.deliver(ada, "resync", {});
  await harness.pump();
  assert.equal(harness.roomUpdates.length, 1, "the post-snapshot diff carries the offline edit exactly once");
  assert.deepEqual(text(harness.Y, ben.session.doc), { offline: "drawn while reconnecting" });
  harness.deliver(ada, "resync", {});
  await harness.pump();
  assert.equal(harness.roomUpdates.length, 1, "a second resync with nothing new sends nothing");
});

test("a fast stroke leaves the embed no faster than the server refills, and lands whole", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ada = await harness.join("ada");
  const ben = await harness.join("ben");
  for (let step = 1; step <= 375; step += 1) {
    ada.session.doc.getMap("whiteboard").set("stroke", step);
    await new Promise((resolve) => setImmediate(resolve));
    context.mock.timers.tick(8);
  }
  await harness.pump();

  const times = ada.updatesPostedAt;
  const busiest = Math.max(...times.map((start) => times.filter((time) => time >= start && time < start + 1_000).length));
  assert.ok(busiest <= limits.APP_DOCUMENT_UPLOADS_PER_SECOND, `${busiest} updates in one second`);
  assert.deepEqual(text(harness.Y, harness.room), { stroke: 375 });
  assert.deepEqual(text(harness.Y, ben.session.doc), { stroke: 375 });
});

test("a resync bigger than one update reaches the room in pieces that each fit", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ada = await harness.join("ada");
  const ben = await harness.join("ben");
  ada.host = { ...ada.host, connection: "reconnecting" };
  harness.deliver(ada, "status", ada.host);
  const strokes = ada.session.doc.getArray("strokes");
  for (let index = 0; index < 40; index += 1) strokes.push([`${index}`.padEnd(10_000, "s")]);
  await harness.pump();
  assert.equal(harness.roomUpdates.length, 0, "nothing leaves while reconnecting");
  ada.host = { ...ada.host, connection: "live" };
  harness.deliver(ada, "status", ada.host);
  harness.deliver(ada, "resync", {});
  await harness.pump();

  assert.ok(ada.updateSizes.length > 1, `${ada.updateSizes.length} updates`);
  assert.ok(Math.max(...ada.updateSizes) <= limits.APP_DOCUMENT_UPDATE_MAX_BYTES, `largest ${Math.max(...ada.updateSizes)} bytes`);
  assert.equal(harness.room.getArray("strokes").length, 40);
  assert.deepEqual(ben.session.doc.getArray("strokes").toJSON(), strokes.toJSON());

  const sentBefore = ada.updateSizes.length;
  ada.session.doc.transact(() => {
    for (let index = 0; index < 30; index += 1) strokes.push([`live ${index}`.padEnd(10_000, "l")]);
  });
  await harness.pump();
  assert.ok(ada.updateSizes.length - sentBefore > 1, "one big change leaves in pieces");
  assert.ok(Math.max(...ada.updateSizes) <= limits.APP_DOCUMENT_UPDATE_MAX_BYTES);
  assert.equal(harness.room.getArray("strokes").length, 70);
});

test("read-only embeds draw nothing into the room", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const viewer = await harness.join("viewer", { readOnly: true });
  viewer.session.doc.getMap("whiteboard").set("blocked", "x");
  await harness.pump();
  assert.equal(harness.roomUpdates.length, 0);
});

test("hostile host messages are dropped and counted by reason", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ada = await harness.join("ada");
  const stale = JSON.stringify({ v: 1, type: "update", callSessionId: ada.scope.callSessionId, appSessionId: "app-old", requestId: "n-90", payload: { update: "AQID" } });
  assert.equal(ada.handler(stale), "staleAppSession");
  const unknown = JSON.stringify({ v: 1, type: "navigate", callSessionId: ada.scope.callSessionId, appSessionId: ada.scope.appSessionId, requestId: "n-91", payload: {} });
  assert.equal(ada.handler(unknown), "unknownType");
  assert.equal(harness.deliver(ada, "zoomToFit", {}, "h-7"), "none");
  assert.equal(harness.deliver(ada, "zoomToFit", {}, "h-7"), "duplicateRequest");
  assert.ok(ada.session.rejections.includes("staleAppSession"));
});

test("commands answer with an ack carrying their request id", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ada = await harness.join("ada");
  ada.session.setCommandHandler((command) => ({ ok: command.type === "setTool" }));
  harness.deliver(ada, "setTool", { tool: "eraser" }, "h-1");
  harness.deliver(ada, "undo", {}, "h-2");
  await harness.pump();
  assert.deepEqual(ada.acks.map((ack) => [ack.requestId, ack.payload.ok]), [["h-1", true], ["h-2", false]]);
});

test("close invalidates the session for good", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ada = await harness.join("ada");
  harness.deliver(ada, "close", {});
  assert.ok(ada.session.isClosed);
  ada.session.doc.getMap("whiteboard").set("after-close", "x");
  await harness.pump();
  assert.equal(harness.roomUpdates.length, 0);
  assert.equal(harness.deliver(ada, "update", { update: "AQID" }), "staleAppSession");
});
