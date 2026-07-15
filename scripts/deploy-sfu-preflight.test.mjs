import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SfuDeployPreflightError,
  resolveSfuTargets,
  runSfuDeployPreflight,
} from "./deploy-sfu-preflight.mjs";

const makeService = ({
  announcedIp = "127.0.0.1",
  instanceId,
  maxPort,
  minPort,
  port,
  publicUrl,
  redisUrl = "rediss://user:secret@redis.internal:6380/0",
  region,
}) => ({
  environment: {
    ANNOUNCED_IP: announcedIp,
    RTC_MAX_PORT: String(maxPort),
    RTC_MIN_PORT: String(minPort),
    SFU_INSTANCE_ID: instanceId,
    SFU_PORT: String(port),
    SFU_PUBLIC_URL: publicUrl,
    SFU_REDIS_URL: redisUrl,
    SFU_REGION: region,
    SFU_REQUIRE_REDIS_ADAPTER: "1",
    SFU_SECRET: "test-secret-not-for-production",
  },
});

const makeCompose = () => ({
  services: {
    "edge-dxb": makeService({
      instanceId: "edge-dxb-01",
      maxPort: 40_999,
      minPort: 40_000,
      port: 3_031,
      publicUrl: "http://localhost:3031",
      region: "me-central-1",
    }),
    "edge-fra": makeService({
      instanceId: "edge-fra-01",
      maxPort: 41_999,
      minPort: 41_000,
      port: 3_032,
      publicUrl: "http://localhost:3032",
      region: "eu-central-1",
    }),
  },
});

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });

const makeHealthyFetch = (calls) => async (input, init) => {
  const url = new URL(input);
  calls.push({ headers: new Headers(init.headers), method: init.method, url });
  const isDxb = url.port === "3031";
  if (url.pathname === "/health") {
    return jsonResponse({
      port: isDxb ? 3_031 : 3_032,
      status: "healthy",
      workers: { closed: 0, healthy: 1, total: 1 },
    });
  }
  return jsonResponse({
    draining: false,
    instanceId: isDxb ? "edge-dxb-01" : "edge-fra-01",
    region: isDxb ? "me-central-1" : "eu-central-1",
    rooms: 0,
  });
};

test("preflight supports arbitrary service names and performs only authenticated read probes", async () => {
  const calls = [];
  const result = await runSfuDeployPreflight({
    compose: makeCompose(),
    fetchImpl: makeHealthyFetch(calls),
  });

  assert.deepEqual(
    result.targets.map(({ service }) => service),
    ["edge-dxb", "edge-fra"],
  );
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ method }) => method === "GET"));
  for (const call of calls) {
    assert.equal(call.headers.get("x-sfu-secret"),
      call.url.pathname === "/status" ? "test-secret-not-for-production" : null);
  }
});

test("config-only validates without performing a network request", async () => {
  let fetched = false;
  const result = await runSfuDeployPreflight({
    compose: makeCompose(),
    configOnly: true,
    fetchImpl: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  });
  assert.equal(result.configOnly, true);
  assert.equal(fetched, false);
});

test("static validation rejects every regional deployment invariant before probing", () => {
  const compose = makeCompose();
  const dxb = compose.services["edge-dxb"].environment;
  const fra = compose.services["edge-fra"].environment;
  dxb.SFU_INSTANCE_ID = "duplicate";
  fra.SFU_INSTANCE_ID = "DUPLICATE";
  dxb.SFU_REGION = "";
  dxb.SFU_PUBLIC_URL = "https://shared.example.com/path";
  fra.SFU_PUBLIC_URL = "https://shared.example.com/path";
  dxb.ANNOUNCED_IP = "10.0.0.1";
  dxb.SFU_REQUIRE_REDIS_ADAPTER = "0";
  fra.SFU_REDIS_URL = "rediss://redis.other:6380/0";
  fra.RTC_MIN_PORT = "42000";
  fra.RTC_MAX_PORT = "41000";

  assert.throws(
    () => resolveSfuTargets({ compose }),
    (error) => {
      assert.ok(error instanceof SfuDeployPreflightError);
      const message = error.message;
      assert.match(message, /SFU_INSTANCE_ID duplicates/);
      assert.match(message, /SFU_REGION/);
      assert.match(message, /direct origin/);
      assert.match(message, /publicly routable IP/);
      assert.match(message, /SFU_REQUIRE_REDIS_ADAPTER/);
      assert.match(message, /same Redis registry/);
      assert.match(message, /RTC_MAX_PORT/);
      return true;
    },
  );
});

test("overlapping RTC ranges are fatal on one announced IP", () => {
  const compose = makeCompose();
  compose.services["edge-fra"].environment.RTC_MIN_PORT = "40500";
  assert.throws(
    () => resolveSfuTargets({ compose }),
    /RTC port ranges overlap/,
  );
});

test("matching RTC ranges are allowed on different public IPs", () => {
  const compose = makeCompose();
  const dxb = compose.services["edge-dxb"].environment;
  const fra = compose.services["edge-fra"].environment;
  dxb.SFU_PUBLIC_URL = "https://dxb.example.com";
  fra.SFU_PUBLIC_URL = "https://fra.example.com";
  dxb.ANNOUNCED_IP = "8.8.8.8";
  fra.ANNOUNCED_IP = "1.1.1.1";
  fra.RTC_MIN_PORT = dxb.RTC_MIN_PORT;
  fra.RTC_MAX_PORT = dxb.RTC_MAX_PORT;
  assert.equal(resolveSfuTargets({ compose }).length, 2);
});

test("equivalent Redis database-zero URLs pass but different SFU secrets fail", () => {
  const compose = makeCompose();
  compose.services["edge-dxb"].environment.SFU_REDIS_URL =
    "rediss://first:secret@redis.internal:6380";
  compose.services["edge-fra"].environment.SFU_REDIS_URL =
    "rediss://second:secret@redis.internal:6380/0";
  assert.equal(resolveSfuTargets({ compose }).length, 2);

  compose.services["edge-fra"].environment.SFU_SECRET = "a-different-secret";
  assert.throws(
    () => resolveSfuTargets({ compose }),
    /do not share the same SFU_SECRET/,
  );
});

test("an unhealthy worker pool is fatal", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/health") {
      return jsonResponse({
        port: url.port === "3031" ? 3_031 : 3_032,
        status: "unhealthy",
        workers: { closed: 1, healthy: 0, total: 1 },
      });
    }
    return makeHealthyFetch([])(input, { headers: {}, method: "GET" });
  };

  await assert.rejects(
    runSfuDeployPreflight({ compose: makeCompose(), fetchImpl }),
    /reported 'unhealthy'.*no healthy mediasoup workers/s,
  );
});

test("a public route resolving to the wrong instance or region is fatal", async () => {
  const calls = [];
  const healthyFetch = makeHealthyFetch(calls);
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.port === "3032" && url.pathname === "/status") {
      return jsonResponse({ instanceId: "edge-dxb-01", region: "wrong-region" });
    }
    return healthyFetch(input, init);
  };

  await assert.rejects(
    runSfuDeployPreflight({ compose: makeCompose(), fetchImpl }),
    /public route returned instance.*public route returned region/s,
  );
});

test("deployment wrappers run the preflight before local or live mutations", async () => {
  for (const file of ["scripts/deploy-sfu.sh", "scripts/deploy-sfu.ps1"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const preflight = source.indexOf("deploy-sfu-preflight.mjs");
    const pull = source.indexOf("Pulling latest code");
    const build = source.indexOf("--build");
    const drain = source.indexOf("/drain");
    assert.ok(preflight >= 0, `${file} invokes the preflight`);
    assert.ok(preflight < pull, `${file} preflights before git pull`);
    assert.ok(preflight < build, `${file} preflights before build`);
    assert.ok(preflight < drain, `${file} preflights before drain`);
    assert.match(source, /preflightConfigOnly|PREFLIGHT_CONFIG_ONLY/);
    assert.match(source, /preflightOnly|PREFLIGHT_ONLY/);
    assert.match(source, /--config-only/);
  }
});

test("compose preserves existing deployments with a neutral region default", async () => {
  const source = await readFile(
    new URL("../docker-compose.sfu.yml", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /SFU_REGION: \$\{SFU_A_REGION:-\$\{SFU_REGION:-local\}\}/,
  );
  assert.match(
    source,
    /SFU_REGION: \$\{SFU_B_REGION:-\$\{SFU_REGION:-local\}\}/,
  );
});
