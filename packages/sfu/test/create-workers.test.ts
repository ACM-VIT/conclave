import { EventEmitter } from "node:events";
import { createWorker } from "mediasoup";
import type { WebRtcServer, Worker } from "mediasoup/types";
import { expect, it, vi } from "vitest";
import createWorkers, { getWorkerWebRtcServer } from "../utilities/createWorkers.js";

vi.mock("mediasoup", () => ({ createWorker: vi.fn() }));
vi.mock("../config/config.js", () => ({
  config: {
    workerSettings: { workerCount: 1, rtcMinPort: 40000, rtcMaxPort: 41000, webRtcPortBase: 40000 },
    webRtcTransport: { enableUdp: true, enableTcp: true, listenIps: [{ ip: "127.0.0.1" }] },
  },
}));

it("restores the worker slot on the same WebRTC port after a transient bind failure", async () => {
  const makeWorker = () => Object.assign(new EventEmitter(), {
    createWebRtcServer: vi.fn<Worker["createWebRtcServer"]>(),
    close: vi.fn(),
  });
  const original = makeWorker();
  const failed = makeWorker();
  const replacement = makeWorker();
  const server = {} as WebRtcServer;
  original.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
  failed.createWebRtcServer.mockRejectedValue(new Error("address already in use"));
  replacement.createWebRtcServer.mockResolvedValue(server);
  vi.mocked(createWorker)
    .mockResolvedValueOnce(original as unknown as Worker)
    .mockResolvedValueOnce(failed as unknown as Worker)
    .mockResolvedValueOnce(replacement as unknown as Worker);

  const onWorkerDied = vi.fn();
  const workers = await createWorkers({ onWorkerDied });
  original.emit("died");

  await vi.waitFor(() => expect(workers).toEqual([replacement]));
  expect(failed.close).toHaveBeenCalledOnce();
  expect(onWorkerDied).toHaveBeenCalledOnce();
  expect(getWorkerWebRtcServer(workers[0])).toBe(server);
  expect(replacement.createWebRtcServer.mock.calls).toEqual(
    original.createWebRtcServer.mock.calls,
  );
});
