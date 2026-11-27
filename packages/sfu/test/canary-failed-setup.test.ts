import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Server } from "socket.io";
import { expect, test } from "vitest";

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
    await expect(result).rejects.toMatchObject({ code: 1, stdout: expect.stringMatching(/PASS Alice joined/) });
    await expect(disconnected).resolves.toBe("client namespace disconnect");
  } finally {
    await io.close();
  }
}, 8_000);
