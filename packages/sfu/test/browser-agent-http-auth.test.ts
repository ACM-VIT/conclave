import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import { createSfuState } from "../server/state.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

const startApp = async () => {
  const state = createSfuState();
  const server = createServer(createSfuApp({ state, config }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Browser-agent authorization test server did not bind a port");
  }
  return { state, url: `http://127.0.0.1:${address.port}` };
};

const observe = (url: string, payload: Record<string, unknown>) =>
  fetch(`${url}/internal/browser/agent/observe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sfu-secret": config.sfuSecret,
    },
    body: JSON.stringify(payload),
  });

describe("browser-agent HTTP authorization", () => {
  it("rejects a signed request after its room or host is gone", async () => {
    const { url } = await startApp();

    const response = await observe(url, {
      roomId: "client:room",
      userId: "former-host",
    });

    expect(response.status).toBe(410);
  });

  it("rejects a participant who is not a current room admin", async () => {
    const { state, url } = await startApp();
    const participant = { id: "participant" } as Client;
    state.rooms.set(
      "client:room",
      {
        getClient: (userId: string) =>
          userId === participant.id ? participant : undefined,
        isAdminClient: () => false,
      } as unknown as Room,
    );

    const response = await observe(url, {
      roomId: "client:room",
      userId: participant.id,
    });

    expect(response.status).toBe(403);
  });
});
