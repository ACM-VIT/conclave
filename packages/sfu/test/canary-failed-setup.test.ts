import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Router, Worker } from "mediasoup/types";
import { Server } from "socket.io";
import { expect, test } from "vitest";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import { createMemoryRoomRecoveryStore } from "../server/roomRecoveryLedger.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createSfuSocketServer } from "../server/socket/createSocketServer.js";
import { createSfuState } from "../server/state.js";

const run = promisify(execFile);
const canary = fileURLToPath(new URL("../scripts/canary-call.ts", import.meta.url));

test("a canary that cannot load the joined device disconnects its seat immediately", async () => {
  const http = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end('{"instanceId":"loopback"}');
  });
  const io = new Server(http);
  const disconnected = new Promise<string>((resolve) => {
    io.once("connection", (socket) => {
      socket.on("joinRoom", (_room: unknown, ack: (answer: unknown) => void) => {
        ack({ status: "joined", rtpCapabilities: null });
      });
      socket.once("disconnect", resolve);
    });
  });
  try {
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    const result = run(process.execPath, ["--import", "tsx", canary, "--url", `http://127.0.0.1:${port}`], {
      timeout: 6_000,
      env: { ...process.env, SFU_SECRET: "local-canary-test-secret" },
    });
    const error = await result.then(() => null, (cause: unknown) => cause);
    expect(error).toMatchObject({ code: 1 });
    if (!error || typeof error !== "object" || !("stdout" in error)) throw new Error("the canary did not report its join");
    expect(error.stdout).toMatch(/PASS Alice joined/);
    await expect(disconnected).resolves.toBe("client namespace disconnect");
  } finally {
    await io.close();
  }
}, 8_000);

test("the canary seats its second client through ordinary host admission", async () => {
  const secret = "local-canary-admission-secret";
  const localConfig = { ...config, sfuSecret: secret };
  const roomRegistry = new LocalRoomRegistry({
    instanceId: "canary-test",
    instanceUrl: "http://127.0.0.1",
    ttlMs: 45_000,
  });
  const state = createSfuState({
    config: localConfig,
    isDraining: true,
    roomRegistry,
    roomRecoveryStore: createMemoryRoomRecoveryStore(),
  });
  const router = {
    closed: false,
    close: () => {},
    rtpCapabilities: { codecs: [], headerExtensions: [] },
  } as unknown as Router;
  state.workers = [{ pid: 1, closed: false, createRouter: async () => router } as unknown as Worker];
  const http = createServer(createSfuApp({ state, config: localConfig }));
  const io = createSfuSocketServer(http, { state, config: localConfig });
  try {
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    const result = run(process.execPath, ["--import", "tsx", canary, "--url", `http://127.0.0.1:${port}`], {
      timeout: 6_000,
      env: { ...process.env, SFU_SECRET: secret },
    });
    const error = await result.then(() => null, (cause: unknown) => cause);
    expect(error).toMatchObject({ code: 1 });
    if (!error || typeof error !== "object" || !("stdout" in error)) throw new Error("the canary did not report its join");
    expect(error.stdout).toMatch(/PASS Alice joined[^\n]*\nPASS Alice admitted Bob\nPASS Bob joined/);
    expect(error.stdout).toContain("createProducerTransport: Room has no WebRTC server");
  } finally {
    await io.close();
    await state.appDocuments.close();
    await state.controlPlane.close();
    await roomRegistry.close();
  }
}, 8_000);
