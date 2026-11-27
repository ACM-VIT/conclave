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

test("the encoder turns the old half emoji envelope into the one the fixtures say iOS decodes", () => {
  const byName = (prefix) => fixtures.embedToNative.find((item) => item.name.startsWith(prefix));
  const sent = byName("wheel status holding half an emoji");
  const now = byName("wheel status with the half emoji dropped");
  assert.equal(sent.expect, "malformed");
  assert.equal(now.expect, "none");
  const old = JSON.parse(sent.raw);
  assert.match(old.payload.app.entries[0].label, /[\uD800-\uDFFF]/u);
  assert.equal(protocol.encodeEnvelope(old.type, fixtures.scope, old.requestId, old.payload), now.raw);
});

test("an ack may list the sent names it added, as whole numbers", () => {
  const decode = (payload) => {
    const result = protocol.decodeEmbedMessage(envelope("ack", payload), fixtures.scope, fixtures.expectedOrigin, fixtures.expectedOrigin, true);
    return result.ok ? "none" : result.reason;
  };
  assert.equal(decode({ ok: true, added: [0, 2] }), "none");
  assert.equal(decode({ ok: false, error: "full", added: [] }), "none");
  for (const added of ["0", [1.5], [-1], [0, "1"], Array.from({ length: 65 }, (_, index) => index)]) {
    assert.equal(decode({ ok: true, added }), "badPayload", JSON.stringify(added));
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
  assert.equal(Number(constant("commandTimeoutMillis")), protocol.COMMAND_TIMEOUT_MS);
  assert.equal(Number(constant("addOutcomeAsks")), protocol.WHEEL_ADD_RECOVERY.asks);
  assert.equal(Number(constant("addOutcomeWindowMillis")), protocol.WHEEL_ADD_RECOVERY.windowMs);
  assert.equal(constant("addOutcomeUnknown"), protocol.WHEEL_ADD_RECOVERY.unknown);
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
      contents: [
        'export * from "./session.ts";',
        'export * from "./protocol.ts";',
        'export * as Y from "yjs";',
        'export * as awarenessProtocol from "y-protocols/awareness";',
        'export { runWheelCommand } from "./wheel/commands.ts";',
        'export { createWheelDoc, getEntries } from "../apps/wheel/core/doc/index.ts";',
      ].join("\n"),
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

const makeRoom = (mod, context, acceptsUpdate = () => true) => {
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
          } else if (message.type === "verifySaved") {
            deliver(client, "savedSnapshot", {
              syncMessage: mod.base64FromBytes(Y.encodeStateAsUpdate(room)),
              stateVector: mod.base64FromBytes(Y.encodeStateVector(room)),
            }, message.requestId);
          } else if (message.type === "update") {
            if (client.host.readOnly || client.host.connection !== "live") continue;
            const bytes = mod.bytesFromBase64(message.payload.update, 262144).bytes;
            if (!acceptsUpdate()) continue;
            roomUpdates.push(bytes);
            Y.applyUpdate(room, bytes, "client");
            for (const other of clients) {
              if (other !== client || client.scope.appId === "wheel") {
                deliver(other, "update", { update: message.payload.update });
              }
            }
          } else if (message.type === "ack") {
            client.acks.push(message);
          } else if (message.type === "awareness") {
            client.awareness.push(message.payload);
          }
        }
      }
    }
  };
  const join = async (name, host = {}, wheel = false) => {
    const outbox = [];
    const client = {
      name,
      scope: { callSessionId: "call-1-contract", appSessionId: `app-${name}`, appId: wheel ? "wheel" : "whiteboard" },
      host: { readOnly: false, connection: "live", reduceMotion: false, pencilOnly: false, userId: name, userName: name, ...host },
      outbox,
      received: [],
      acks: [],
      awareness: [],
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
    client.session = new mod.NativeEmbedSession(transport, client.scope, wheel ? mod.createWheelDoc() : new Y.Doc());
    clients.push(client);
    client.session.start(wheel ? wheelRunner(mod, client) : () => ({ ok: true }));
    await pump();
    return client;
  };
  return { Y, room, roomUpdates, join, pump, deliver };
};

const wheelRunner = (mod, client) => (envelope, repeat, doc) =>
  mod.runWheelCommand(doc, envelope.type, envelope.payload, {
    synced: client.session.isSynced,
    canEdit: !client.session.hostStatus.readOnly,
    repeat,
    spinning: false,
    requestSpin: () => ({ ok: true }),
    setSounds: () => ({ ok: true }),
  });

const namesOn = (mod, client) => mod.getEntries(client.session.doc).map((entry) => entry.label);
const acksFor = (client, requestId) => client.acks.filter((ack) => ack.requestId === requestId).map((ack) => ack.payload);
const SENT_AT = 1_800_000_000_000;

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

test("a resync or a change bigger than one update never reaches the room in part, since the bridge cannot stage parts", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ada = await harness.join("ada");
  const ben = await harness.join("ben");
  ada.host = { ...ada.host, connection: "reconnecting" };
  harness.deliver(ada, "status", ada.host);
  const strokes = ada.session.doc.getArray("strokes");
  for (let index = 0; index < 40; index += 1) strokes.push([`${index}`.padEnd(10_000, "s")]);
  await harness.pump();
  ada.host = { ...ada.host, connection: "live" };
  harness.deliver(ada, "status", ada.host);
  harness.deliver(ada, "resync", {});
  await harness.pump();

  assert.deepEqual(ada.updateSizes, [], "the oversized resync is not sent");
  assert.equal(harness.room.getArray("strokes").length, 0);

  const small = await harness.join("cy");
  small.session.doc.transact(() => {
    for (let index = 0; index < 30; index += 1) small.session.doc.getArray("big").push([`${index}`.padEnd(10_000, "b")]);
  });
  small.session.doc.getMap("whiteboard").set("note", "fits");
  await harness.pump();

  assert.ok(small.updateSizes.every((size) => size <= limits.APP_DOCUMENT_UPDATE_MAX_BYTES));
  assert.equal(harness.room.getArray("big").length, 0, "no part of the oversized change lands");
  assert.deepEqual(ben.session.doc.getArray("big").toJSON(), []);
});

test("an embed takes a relayed change of 300 KiB, or one at the document limit, and ends equal to the room", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ben = await harness.join("ben");
  const { Y } = harness;
  const web = new Y.Doc();
  Y.applyUpdate(web, Y.encodeStateAsUpdate(harness.room));
  for (const size of [300 * 1024, limits.APP_DOCUMENT_UPDATE_MAX_BYTES * 4 - 64 * 1024]) {
    const before = Y.encodeStateVector(web);
    web.getText("notes").insert(0, "w".repeat(size));
    const change = Y.encodeStateAsUpdate(web, before);
    assert.ok(change.length > limits.APP_DOCUMENT_UPDATE_MAX_BYTES, `${change.length} bytes`);
    Y.applyUpdate(harness.room, change);
    assert.equal(harness.deliver(ben, "update", { update: Buffer.from(change).toString("base64") }), "none");
    await harness.pump();
    assert.equal(ben.session.doc.getText("notes").toString(), harness.room.getText("notes").toString());
  }
  assert.ok(ben.session.doc.getText("notes").length > 1_000_000);
  assert.deepEqual(ben.session.rejections, []);
});

test("an embed forwards only its own cursor when a peer's times out", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const { awarenessProtocol } = sessionModule;
  const ada = await harness.join("ada");
  const ben = new awarenessProtocol.Awareness(new harness.Y.Doc());
  context.after(() => ben.destroy());
  ben.setLocalState({ user: { id: "ben" } });
  harness.deliver(ada, "awareness", {
    update: sessionModule.base64FromBytes(awarenessProtocol.encodeAwarenessUpdate(ben, [ben.clientID])),
  });
  context.mock.timers.tick(80);
  await harness.pump();
  ada.awareness.length = 0;

  awarenessProtocol.removeAwarenessStates(ada.session.awareness, [ben.clientID], "timeout");
  ada.session.awareness.setLocalStateField("cursor", { x: 3, y: 4 });
  context.mock.timers.tick(80);
  await harness.pump();

  assert.ok(ada.awareness.length > 0, "the embed forwards its own cursor");
  for (const payload of ada.awareness) {
    const forwarded = new awarenessProtocol.Awareness(new harness.Y.Doc());
    awarenessProtocol.applyAwarenessUpdate(forwarded, sessionModule.bytesFromBase64(payload.update, 65536).bytes, "host");
    const ids = [...forwarded.meta.keys()].filter((id) => id !== forwarded.clientID);
    forwarded.destroy();
    assert.deepEqual(ids, [ada.session.awareness.clientID]);
  }
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
  ada.session.start((command) => ({ ok: command.type === "setTool" }));
  harness.deliver(ada, "setTool", { tool: "eraser" }, "h-1");
  harness.deliver(ada, "undo", {}, "h-2");
  await harness.pump();
  assert.deepEqual(ada.acks.map((ack) => [ack.requestId, ack.payload.ok]), [["h-1", true], ["h-2", false]]);
});

test("a wheel add delivered twice under one request id adds once and is answered from the document both times", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ada = await harness.join("ada", {}, true);
  const payload = { labels: ["Ada", "", "Bo"], tokens: ["t-ada", "t-blank", "t-bo"], sentAt: SENT_AT };
  assert.equal(harness.deliver(ada, "addEntries", payload, "h-5"), "none");
  assert.equal(harness.deliver(ada, "addEntries", payload, "h-5"), "none");
  assert.deepEqual(acksFor(ada, "h-5"), []);
  await harness.pump();
  assert.deepEqual(acksFor(ada, "h-5"), [{ ok: true, added: [0, 2] }]);
  assert.equal(harness.deliver(ada, "addEntries", payload, "h-5"), "none");
  await harness.pump();
  assert.deepEqual(namesOn(sessionModule, ada), ["Ada", "Bo"]);
  assert.deepEqual(acksFor(ada, "h-5"), [{ ok: true, added: [0, 2] }, { ok: true, added: [0, 2] }]);
  assert.equal(ada.session.rejections.includes("duplicateRequest"), false);
  assert.equal(harness.deliver(ada, "shuffle", {}, "h-6"), "none");
  assert.equal(harness.deliver(ada, "shuffle", {}, "h-6"), "duplicateRequest");
});

test("a refusal is never remembered: the same request id is next answered from the document", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ada = await harness.join("ada", {}, true);
  harness.deliver(ada, "resync", {});
  assert.equal(ada.session.isSynced, false);
  const payload = { labels: ["Ada"], tokens: ["t-ada"], sentAt: SENT_AT };
  const question = { tokens: payload.tokens, sentAt: payload.sentAt };
  harness.deliver(ada, "addEntries", payload, "h-1");
  harness.deliver(ada, "addOutcome", question, "h-2");
  await harness.pump();
  assert.equal(ada.session.isSynced, true);
  assert.deepEqual(acksFor(ada, "h-1"), [{ ok: false, error: "notSynced", added: [] }]);
  assert.deepEqual(acksFor(ada, "h-2"), [{ ok: false, error: "notSynced" }]);
  harness.deliver(ada, "addEntries", payload, "h-1");
  harness.deliver(ada, "addOutcome", question, "h-3");
  await harness.pump();
  assert.deepEqual(acksFor(ada, "h-1")[1], { ok: false, error: "notApplied", added: [] });
  assert.deepEqual(acksFor(ada, "h-3"), [{ ok: false, error: "notApplied", added: [] }]);
  assert.deepEqual(namesOn(sessionModule, ada), []);
  harness.deliver(ada, "addEntries", { labels: ["Ada"], tokens: ["t-ada-again"], sentAt: SENT_AT + 1 }, "h-4");
  await harness.pump();
  assert.deepEqual(acksFor(ada, "h-4"), [{ ok: true, added: [0] }]);
  assert.deepEqual(namesOn(sessionModule, ada), ["Ada"]);
});

test("an add is answered from the document after the session forgot its request, and by an embed that reloaded", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ada = await harness.join("ada", {}, true);
  const payload = { labels: ["Ada", "Bo"], tokens: ["t-ada", "t-bo"], sentAt: SENT_AT };
  harness.deliver(ada, "addEntries", payload, "h-1");
  await harness.pump();
  for (let index = 0; index < protocol.NATIVE_EMBED_LIMITS.executedCommands + 8; index += 1) {
    harness.deliver(ada, "setSounds", { value: index % 2 === 0 }, `h-s${index}`);
  }
  assert.equal(harness.deliver(ada, "addEntries", payload, "h-1"), "none");
  await harness.pump();
  assert.deepEqual(acksFor(ada, "h-1"), [{ ok: true, added: [0, 1] }, { ok: true, added: [0, 1] }]);
  assert.deepEqual(namesOn(sessionModule, ada), ["Ada", "Bo"]);
  const reloaded = await harness.join("ada-reloaded", {}, true);
  harness.deliver(reloaded, "addOutcome", { tokens: payload.tokens, sentAt: payload.sentAt }, "h-9");
  harness.deliver(reloaded, "addOutcome", { tokens: ["t-never"], sentAt: SENT_AT + 1 }, "h-10");
  await harness.pump();
  assert.deepEqual(acksFor(reloaded, "h-9"), [{ ok: true, added: [0, 1] }]);
  assert.deepEqual(acksFor(reloaded, "h-10"), [{ ok: false, error: "notApplied", added: [] }]);
  assert.deepEqual(namesOn(sessionModule, reloaded), ["Ada", "Bo"]);
});

test("an add whose receipt later adds pushed out is answered as unknown, with no added list, by the embed that ran it and by one that reloaded", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const ada = await harness.join("ada", {}, true);
  const names = (prefix) => Array.from({ length: protocol.WHEEL_LIMITS.entries }, (_, index) => `${prefix} ${index}`);
  const tokens = (prefix) => names(prefix).map((_, index) => `${prefix}-${index}-`.padEnd(36, "x"));
  const lost = { labels: names("lost"), tokens: tokens("lost"), sentAt: SENT_AT };
  harness.deliver(ada, "addEntries", lost, "h-1");
  harness.deliver(ada, "clearEntries", {}, "h-2");
  for (let paste = 0; paste < 13; paste += 1) {
    harness.deliver(ada, "addEntries", { labels: names(`p${paste}`), tokens: tokens(`p${paste}`), sentAt: SENT_AT + 1 + paste }, `h-a${paste}`);
    harness.deliver(ada, "clearEntries", {}, `h-c${paste}`);
  }
  await harness.pump();
  assert.equal(acksFor(ada, "h-1")[0].added.length, protocol.WHEEL_LIMITS.entries);
  const question = { tokens: lost.tokens, sentAt: lost.sentAt };
  const reloaded = await harness.join("ada-reloaded", {}, true);
  harness.deliver(ada, "addOutcome", question, "h-3");
  harness.deliver(ada, "addEntries", lost, "h-1");
  harness.deliver(reloaded, "addOutcome", question, "h-4");
  harness.deliver(reloaded, "addOutcome", { tokens: ["t-never"], sentAt: SENT_AT + 100 }, "h-5");
  await harness.pump();
  assert.deepEqual(acksFor(ada, "h-3"), [{ ok: false, error: "outcomeUnknown" }]);
  assert.deepEqual(acksFor(ada, "h-1")[1], { ok: false, error: "outcomeUnknown" });
  assert.deepEqual(acksFor(reloaded, "h-4"), [{ ok: false, error: "outcomeUnknown" }]);
  assert.deepEqual(acksFor(reloaded, "h-5"), [{ ok: false, error: "notApplied", added: [] }]);
  assert.deepEqual(namesOn(sessionModule, ada), []);
});

test("the embed says ready only once it can run commands, and runs any that came first", { skip: skipConvergence }, async (context) => {
  const mod = sessionModule;
  const outbox = [];
  let deliver = () => "none";
  const transport = { platform: "ios", post: (message) => outbox.push(JSON.parse(message)), onMessage: (next) => { deliver = next; } };
  const scope = { callSessionId: "call-1-contract", appSessionId: "app-early", appId: "wheel" };
  const client = { session: new mod.NativeEmbedSession(transport, scope, mod.createWheelDoc()) };
  context.after(() => {
    client.session.close();
    client.session.doc.destroy();
  });
  const host = (type, payload, requestId) =>
    deliver(JSON.stringify({ v: 1, type, callSessionId: scope.callSessionId, appSessionId: scope.appSessionId, requestId, payload }));
  assert.equal(host("status", { readOnly: false, connection: "live" }, "n-1"), "none");
  assert.equal(host("snapshot", { syncMessage: "", stateVector: "" }, "n-2"), "none");
  assert.equal(host("addEntries", { labels: ["Ada"], tokens: ["t-ada"], sentAt: SENT_AT }, "h-1"), "none");
  assert.equal(host("addOutcome", { tokens: ["t-ada"], sentAt: SENT_AT }, "h-2"), "none");
  assert.deepEqual(outbox.filter((message) => message.type === "ready" || message.type === "ack"), []);
  client.session.start(wheelRunner(mod, client));
  client.session.start(wheelRunner(mod, client));
  await Promise.resolve();
  const pendingUpdate = outbox.find((message) => message.type === "update");
  assert.equal(outbox.some((message) => message.type === "ack" && message.requestId === "h-1"), false);
  assert.deepEqual(outbox.find((message) => message.type === "ack" && message.requestId === "h-2")?.payload, {
    ok: false, error: "notSynced",
  });
  const room = new mod.Y.Doc();
  context.after(() => room.destroy());
  mod.Y.applyUpdate(room, mod.bytesFromBase64(pendingUpdate.payload.update, 262144).bytes);
  host("update", pendingUpdate.payload, "n-3");
  host("addOutcome", { tokens: ["t-ada"], sentAt: SENT_AT }, "h-3");
  const said = outbox.filter((message) => message.type === "ready" || message.type === "ack");
  assert.deepEqual(said.map((message) => [message.type, message.requestId, message.payload.ok]), [
    ["ready", said[0].requestId, undefined],
    ["ack", "h-2", false],
    ["ack", "h-1", true],
    ["ack", "h-3", true],
  ]);
  assert.deepEqual(namesOn(mod, client), ["Ada"]);
});

test("a session closed before its page started runs none of the commands it held and never says ready", { skip: skipConvergence }, (context) => {
  const mod = sessionModule;
  const outbox = [];
  let deliver = () => "none";
  const transport = { platform: "ios", post: (message) => outbox.push(JSON.parse(message)), onMessage: (next) => { deliver = next; } };
  const scope = { callSessionId: "call-1-contract", appSessionId: "app-closed-early", appId: "wheel" };
  const client = { session: new mod.NativeEmbedSession(transport, scope, mod.createWheelDoc()) };
  context.after(() => client.session.doc.destroy());
  const host = (type, payload, requestId) =>
    deliver(JSON.stringify({ v: 1, type, callSessionId: scope.callSessionId, appSessionId: scope.appSessionId, requestId, payload }));
  assert.equal(host("status", { readOnly: false, connection: "live" }, "n-1"), "none");
  assert.equal(host("snapshot", { syncMessage: "", stateVector: "" }, "n-2"), "none");
  assert.equal(host("addEntries", { labels: ["Ada"], tokens: ["t-ada"], sentAt: SENT_AT }, "h-1"), "none");
  assert.equal(host("close", {}, "n-3"), "none");
  let ran = 0;
  const runner = wheelRunner(mod, client);
  client.session.start((envelope, repeat, doc) => {
    ran += 1;
    return runner(envelope, repeat, doc);
  });
  assert.equal(ran, 0, "a held command never runs after close");
  assert.deepEqual(outbox.filter((message) => message.type === "ready" || message.type === "ack"), []);
  assert.deepEqual(namesOn(mod, client), []);
  assert.equal(host("addEntries", { labels: ["Bo"], tokens: ["t-bo"], sentAt: SENT_AT }, "h-2"), "staleAppSession");
  assert.equal(ran, 0);
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

test("native Close waits for paced additions and deletions and a cold reopen sees both", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const author = await harness.join("native-host");
  const shapes = author.session.doc.getMap("whiteboard");
  shapes.set("first", "stroke");
  await Promise.resolve();
  assert.equal(author.updatesPostedAt.length, 1);
  shapes.set("paced", "stroke");
  shapes.delete("first");
  await Promise.resolve();
  assert.equal(author.updatesPostedAt.length, 1);
  harness.deliver(author, "prepareToLeave", {}, "native-close");
  assert.deepEqual(acksFor(author, "native-close"), []);
  await harness.pump();
  assert.deepEqual(acksFor(author, "native-close"), [{ ok: true }]);
  harness.deliver(author, "close", {});
  const cold = await harness.join("cold-copy");
  assert.deepEqual(cold.session.doc.getMap("whiteboard").toJSON(), { paced: "stroke" });
});

test("native switch fails if the room does not have the edit, and the embed keeps it", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context, () => false);
  const author = await harness.join("native-host");
  const shapes = author.session.doc.getMap("whiteboard");
  shapes.set("unaccepted", "stroke");
  harness.deliver(author, "prepareToLeave", {}, "native-switch");
  await harness.pump();
  assert.deepEqual(acksFor(author, "native-switch"), [{ ok: false, error: "notSaved" }]);
  assert.deepEqual(shapes.toJSON(), { unaccepted: "stroke" });
  assert.equal(author.session.isClosed, false);
});

test("a native connection interruption invalidates the pending leave snapshot", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const author = await harness.join("native-host");
  author.session.doc.getMap("whiteboard").set("kept", "stroke");
  await Promise.resolve();
  harness.deliver(author, "prepareToLeave", {}, "native-interrupted");
  harness.deliver(author, "status", { ...author.host, connection: "reconnecting" });
  await harness.pump();
  assert.deepEqual(acksFor(author, "native-interrupted"), [{ ok: false, error: "notSaved" }]);
  assert.equal(author.session.isClosed, false);
});

test("native Close with no edits answers without a room snapshot", { skip: skipConvergence }, async (context) => {
  const harness = makeRoom(sessionModule, context);
  const author = await harness.join("native-host");
  harness.deliver(author, "prepareToLeave", {}, "native-idle");
  assert.deepEqual(author.outbox.map((raw) => JSON.parse(raw).type), ["ack"]);
  await harness.pump();
  assert.deepEqual(acksFor(author, "native-idle"), [{ ok: true }]);
});
