import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { requestJoinInfo } from "../src/app/lib/join-info-request";
import { ASSUMED_RELAY_LIFETIME_MS } from "../src/app/lib/relay-credentials";

let server: Server | null = null;

const serve = (
  handler: Parameters<typeof createServer>[1],
): Promise<string> =>
  new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/`);
    });
  });

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  server = null;
});

it("times out a join answer whose body stops after the headers", async () => {
  const url = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"token":"');
  });

  const startedAt = Date.now();
  const outcome = await Promise.race([
    requestJoinInfo(url, { method: "POST" }, { timeoutMs: 300 }).then(
      () => "answered",
      (error: Error) => error.message,
    ),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3000)),
  ]);

  expect(outcome).toBe("Join info request timeout");
  expect(Date.now() - startedAt).toBeLessThan(2000);
});

it("cancels a body read when the caller aborts", async () => {
  const url = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"token":"');
  });
  const cancel = new AbortController();
  const request = requestJoinInfo(url, { method: "POST" }, { signal: cancel.signal });
  setTimeout(() => cancel.abort(), 100);

  await expect(request).rejects.toThrow("Join info request was cancelled");
});

it("returns a complete answer", async () => {
  const url = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ token: "t", sfuUrl: "https://sfu.example" }));
  });

  await expect(requestJoinInfo(url, { method: "POST" })).resolves.toEqual({
    token: "t",
    sfuUrl: "https://sfu.example",
    relayIssuedAt: expect.any(Number),
  });
});

it("keeps the route's error and status on a refusal", async () => {
  const url = await serve((_request, response) => {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Guests are not allowed in this meeting." }));
  });

  await expect(requestJoinInfo(url, { method: "POST" })).rejects.toMatchObject({
    message: "Guests are not allowed in this meeting.",
    responseStatus: 403,
  });
});

it("counts the TURN lifetime from when the request was sent", async () => {
  const url = await serve((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          token: "t",
          sfuUrl: "https://sfu.example",
          iceServers: [{ urls: "turn:turn.example", username: "u", credential: "c" }],
          iceServersTtlSeconds: 60,
        }),
      );
    }, 400);
  });

  const sentAt = Date.now();
  const answer = await requestJoinInfo(url, { method: "POST" });

  expect(answer.relayExpiresAt).toBeGreaterThanOrEqual(sentAt + 60_000);
  expect(answer.relayExpiresAt).toBeLessThan(sentAt + 60_000 + 200);
  expect(answer.relayIssuedAt).toBe((answer.relayExpiresAt ?? 0) - 60_000);
});

it("assumes a short lifetime for TURN credentials the route sends without one", async () => {
  const url = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        token: "t",
        sfuUrl: "https://sfu.example",
        iceServers: [{ urls: "turn:turn.example", username: "u", credential: "c" }],
      }),
    );
  });

  const answer = await requestJoinInfo(url, { method: "POST" });

  expect(answer.relayExpiresAt).toBe((answer.relayIssuedAt ?? 0) + ASSUMED_RELAY_LIFETIME_MS);
});

it("gives an answer without a TURN lifetime no relay deadline", async () => {
  const url = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ token: "t", sfuUrl: "https://sfu.example" }));
  });

  expect((await requestJoinInfo(url, { method: "POST" })).relayExpiresAt).toBeUndefined();
});
