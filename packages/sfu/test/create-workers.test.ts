import { EventEmitter } from "node:events";
import { createWorker } from "mediasoup";
import type { WebRtcServer, Worker } from "mediasoup/types";
import { expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import createWorkers, { getWorkerWebRtcServer } from "../utilities/createWorkers.js";

vi.mock("mediasoup", () => ({ createWorker: vi.fn() }));
vi.mock("../config/config.js", () => ({
  config: {
    workerSettings: { workerCount: 1, rtcMinPort: 40000, rtcMaxPort: 41000, webRtcPortBase: 40000 },
    webRtcTransport: { enableUdp: true, enableTcp: true, listenIps: [{ ip: "127.0.0.1" }] },
  },
}));

const makeWorker = () => Object.assign(new EventEmitter(), {
  createWebRtcServer: vi.fn<Worker["createWebRtcServer"]>(),
  close: vi.fn(),
});

it.each([0, 39999, 40001.5, 41001, 65536, NaN])("rejects invalid WebRTC port %s", async (port) => {
  const settings = config.workerSettings;
  const originalBase = settings.webRtcPortBase;
  const worker = makeWorker();
  worker.createWebRtcServer.mockResolvedValue({} as WebRtcServer);
  vi.mocked(createWorker).mockClear().mockResolvedValueOnce(worker as unknown as Worker);
  settings.webRtcPortBase = port;
  try {
    await expect(createWorkers()).rejects.toThrow("RTC_MIN_PORT");
    expect(createWorker).not.toHaveBeenCalled();
  } finally {
    settings.webRtcPortBase = originalBase;
    vi.mocked(createWorker).mockReset();
  }
});

it("restores the worker slot on the same WebRTC port after a transient bind failure", async () => {
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
