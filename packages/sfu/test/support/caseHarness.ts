import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { vi } from "vitest";

export type CaseReply = { status: number; body: Record<string, unknown> };

export type CaseSfu = {
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<CaseReply>;
  tickWebinars: () => Promise<void>;
  scanReminders: () => Promise<void>;
  stop: () => Promise<void>;
};

const skew = new AsyncLocalStorage<number>();
const realNow = Date.now.bind(Date);
let clockInstalled = false;

export const installSkewedClock = (): void => {
  if (clockInstalled) return;
  clockInstalled = true;
  Date.now = () => realNow() + (skew.getStore() ?? 0);
};

const loadSfuModules = () =>
  Promise.all([
    import("../../config/config.js"),
    import("../../server/http/createApp.js"),
    import("../../server/init.js"),
    import("../../server/roomRegistry.js"),
    import("../../server/scheduledWebinarScheduler.js"),
    import("../../server/schedulingEmailReminders.js"),
    import("../../server/state.js"),
  ]);

export const warmCaseModules = async (): Promise<void> => {
  await loadSfuModules();
  vi.resetModules();
};

export const startCaseSfu = async (
  name: string,
  options: { skewMs?: number } = {},
): Promise<CaseSfu> => {
  installSkewedClock();
  vi.resetModules();
  const [
    { config },
    { createSfuApp },
    { initControlPlane },
    { LocalRoomRegistry },
    { advanceScheduledWebinars },
    { sendDueSchedulingEmailReminders },
    { createSfuState },
  ] = await loadSfuModules();
  const offset = options.skewMs ?? 0;
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: `case-${name}`, instanceUrl: "http://localhost", ttlMs: 45000 }),
  });
  await skew.run(offset, () => initControlPlane(state));
  const app = createSfuApp({ state, config, getIo: () => null });
  const server = createServer((req, res) => {
    skew.run(offset, () => {
      app(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    call: async (method, path, body, headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: {
          "x-sfu-secret": config.sfuSecret,
          "x-sfu-client": "conclave",
          "content-type": "application/json",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      try {
        return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
      } catch {
        return { status: response.status, body: {} };
      }
    },
    tickWebinars: () => skew.run(offset, async () => {
      await advanceScheduledWebinars(state, Date.now(), () => {});
    }),
    scanReminders: () => skew.run(offset, async () => {
      await sendDueSchedulingEmailReminders(state);
    }),
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await state.controlPlane.close();
    },
  };
};
