import assert from "node:assert/strict";
import test from "node:test";
import { CdpClient, evaluate } from "./cdp.mjs";

test("evaluate propagates its deadline through the CDP transport", async () => {
  const calls = [];
  const cdp = {
    async send(method, params, timeoutMs) {
      calls.push({ method, params, timeoutMs });
      return { result: { value: { ok: true } } };
    },
  };

  assert.deepEqual(await evaluate(cdp, "Promise.resolve({ ok: true })", 25_000), {
    ok: true,
  });
  assert.equal(calls[0].method, "Runtime.evaluate");
  assert.equal(calls[0].params.timeout, 25_000);
  assert.equal(calls[0].timeoutMs, 26_000);
});

test("flattened-session sends preserve both timeout and session identity", async () => {
  const client = new CdpClient("ws://unused");
  let payload = null;
  client.socket = {
    send(value) {
      payload = JSON.parse(value);
    },
    close() {},
  };

  const pending = client.sendToSession(
    "acknowledged-session",
    "Network.enable",
    {},
    25_000,
  );
  assert.equal(payload.sessionId, "acknowledged-session");
  assert.equal(payload.method, "Network.enable");
  client.close();
  await assert.rejects(pending, /closed/);
});
