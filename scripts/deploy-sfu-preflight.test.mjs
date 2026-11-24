import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

test("deploy preflight and SFU startup agree on configured RTC ports", () => {
  const valid = [
    ["40000", "40999"],
    [" 00001 ", "65535"],
  ];
  const invalid = [
    ["typo", "40999"],
    ["40000", "typo"],
    ["", "40999"],
    ["40000", " "],
    ["0x9c40", "40999"],
    ["40000", "+40999"],
    ["40000.0", "40999"],
    ["0", "40999"],
    ["40000", "65536"],
    ["42000", "41000"],
  ];
  const cases = [...valid, ...invalid];
  const startup = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const results = [];
    for (const [index, [min, max]] of JSON.parse(process.argv[1]).entries()) {
      process.env.RTC_MIN_PORT = min;
      process.env.RTC_MAX_PORT = max;
      try {
        const { config } = await import("./config/config.ts?rtcCase=" + index);
        results.push([config.workerSettings.rtcMinPort, config.workerSettings.rtcMaxPort]);
      } catch (error) {
        results.push(error.message);
      }
    }
    console.log(JSON.stringify(results));
  `, JSON.stringify(cases)], {
    cwd: new URL("../packages/sfu/", import.meta.url),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", SFU_SECRET: "rtc-validation-fixture" },
    encoding: "utf8",
  });
  assert.equal(startup.status, 0, startup.error?.message ?? startup.stderr);
  const startupResults = JSON.parse(startup.stdout.trim().split("\n").at(-1));
  assert.deepEqual(startupResults.slice(0, valid.length), valid.map(([min, max]) => [Number(min), Number(max)]));
  for (const [index, [min, max]] of cases.entries()) {
    const compose = makeCompose();
    const service = "edge-dxb";
    Object.assign(compose.services[service].environment, { RTC_MIN_PORT: min, RTC_MAX_PORT: max });
    let preflightResult;
    try {
      const [{ rtcMinPort, rtcMaxPort }] = resolveSfuTargets({ compose, serviceNames: [service] });
      preflightResult = [rtcMinPort, rtcMaxPort];
    } catch (error) {
      assert.ok(error instanceof SfuDeployPreflightError);
      preflightResult = error.errors[0].slice(service.length + 2);
    }
    assert.deepEqual(startupResults[index], preflightResult, JSON.stringify([min, max]));
  }
  assert.ok(startupResults.slice(valid.length).every((result) => typeof result === "string"));
});

for (const name of ["SFU_WEBRTC_PORT_BUDGET", "SFU_WORKER_COUNT", "SFU_WORKER_HOST_INSTANCES"]) {
  for (const invalid of ["", " ", "0", "-1", "1.5", "1e0", "bad"]) {
    test(`config-only rejects ${name}=${JSON.stringify(invalid)}`, async () => {
      const compose = makeCompose();
      compose.services["edge-dxb"].environment[name] = invalid;

      await assert.rejects(
        runSfuDeployPreflight({ compose, configOnly: true }),
        new RegExp(`edge-dxb: ${name} must be a positive integer`),
      );
    });
  }
}

test("config-only rejects more workers than the public WebRTC budget", async () => {
  const compose = makeCompose();
  const env = compose.services["edge-dxb"].environment;
  env.SFU_WORKER_COUNT = "5";
  env.SFU_WEBRTC_PORT_BUDGET = "4";
  await assert.rejects(
    runSfuDeployPreflight({ compose, configOnly: true }),
    /edge-dxb: SFU_WORKER_COUNT=5 exceeds the WebRTC port budget of 4/,
  );
});

test("config-only preserves four ports for shared-browser RTP and RTCP", async () => {
  const compose = makeCompose();
  const env = compose.services["edge-dxb"].environment;
  env.RTC_MAX_PORT = "40004";
  env.SFU_WORKER_COUNT = "1";
  env.SFU_WEBRTC_PORT_BUDGET = "4";
  await runSfuDeployPreflight({ compose, configOnly: true });

  env.SFU_WORKER_COUNT = "2";
  await assert.rejects(
    runSfuDeployPreflight({ compose, configOnly: true }),
    /edge-dxb: SFU_WORKER_COUNT=2 exceeds the WebRTC port budget of 1/,
  );

  env.RTC_MAX_PORT = "40003";
  env.SFU_WORKER_COUNT = null;
  await assert.rejects(
    runSfuDeployPreflight({ compose, configOnly: true }),
    /edge-dxb: RTC_MIN_PORT.*4 plain RTP ports/,
  );
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

// The deploy scripts run this file directly; a checkout reached through a
// symlink must still run the checks rather than exit 0 having done nothing.
test("run through a symlinked path, the preflight still checks the config", () => {
  const root = mkdtempSync(path.join(tmpdir(), "conclave-preflight-"));
  try {
    const linked = path.join(root, "linked-scripts");
    symlinkSync(import.meta.dirname, linked);
    const run = (compose) =>
      spawnSync(process.execPath, [path.join(linked, "deploy-sfu-preflight.mjs"), "--compose-json", "-", "--config-only"], {
        input: JSON.stringify(compose),
        encoding: "utf8",
      });

    const good = run(makeCompose());
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /SFU deployment preflight passed/);

    const broken = makeCompose();
    broken.services["edge-fra"].environment.SFU_SECRET = "development-secret";
    const bad = run(broken);
    assert.equal(bad.status, 1, bad.stdout);
    assert.match(bad.stderr, /SFU_SECRET must be a non-default value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A compose file with its own Redis service, as staging's: the redis service
// listens on 127.0.0.1:6380, and the SFU's Redis variables are as given.
const withOwnRedis = (redisEnv) => {
  const compose = makeCompose();
  delete compose.services["edge-fra"];
  Object.assign(compose.services["edge-dxb"].environment, redisEnv);
  compose.services.redis = { image: "redis:7.2", environment: { REDIS_PORT: "6380" } };
  return compose;
};

test("an SFU beside its own Redis must reach that Redis with every Redis variable", () => {
  const own = "redis://:pw@127.0.0.1:6380/0";
  assert.equal(
    resolveSfuTargets({ compose: withOwnRedis({ REDIS_URL: own, SFU_REDIS_URL: own, SFU_PERSISTENCE_REDIS_URL: own }) }).length,
    1,
  );
  // Sol's case: the runbook's REDIS_URL on 6380, with an SFU_REDIS_URL on
  // production's 6379 inherited from the shell.
  assert.throws(
    () => resolveSfuTargets({ compose: withOwnRedis({ REDIS_URL: own, SFU_REDIS_URL: "redis://127.0.0.1:6379/0", SFU_PERSISTENCE_REDIS_URL: own }) }),
    /edge-dxb: SFU_REDIS_URL points at 127\.0\.0\.1:6379, not this compose file's own Redis on 127\.0\.0\.1:6380/,
  );
  assert.throws(
    () => resolveSfuTargets({ compose: withOwnRedis({ REDIS_URL: own, SFU_REDIS_URL: own }) }),
    /edge-dxb: SFU_PERSISTENCE_REDIS_URL must be set to this compose file's own Redis on 127\.0\.0\.1:6380/,
  );
});

const hasCompose = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

test(
  "staging's compose file gives its SFU staging's Redis whatever Redis URLs the shell holds",
  { skip: !hasCompose && "needs docker compose" },
  () => {
    const root = path.join(import.meta.dirname, "..");
    const render = (extra) =>
      spawnSync("docker", ["compose", "-f", path.join(root, "docker-compose.sfu-staging.yml"), "config", "--format", "json"], {
        cwd: mkdtempSync(path.join(tmpdir(), "staging-compose-")),
        encoding: "utf8",
        env: {
          ...process.env,
          COMPOSE_PROJECT_NAME: "conclave-staging",
          STAGING_REDIS_PASSWORD: "staging-pw",
          SFU_SECRET: "staging-secret",
          ANNOUNCED_IP: "127.0.0.1",
          SFU_STAGING_PUBLIC_URL: "http://localhost:3033",
          SFU_REQUIRE_REDIS_ADAPTER: "1",
          // Production's Redis, inherited from the shell.
          REDIS_URL: "redis://127.0.0.1:6379/0",
          SFU_REDIS_URL: "redis://127.0.0.1:6379/0",
          SFU_PERSISTENCE_REDIS_URL: "redis://127.0.0.1:6379/0",
          BROWSER_SERVICE_URL: "http://localhost:3040",
          TRANSCRIPT_WORKER_URL: "http://localhost:8788",
          ...extra,
        },
      });
    for (const missing of ["STAGING_BROWSER_SERVICE_URL", "STAGING_TRANSCRIPT_WORKER_URL"]) {
      const refused = render({ STAGING_BROWSER_SERVICE_URL: "https://browser.staging.example", STAGING_TRANSCRIPT_WORKER_URL: "https://transcripts.staging.example", [missing]: "" });
      assert.notEqual(refused.status, 0, `staging renders without ${missing}`);
      assert.match(refused.stderr, new RegExp(missing));
    }
    const rendered = render({ STAGING_BROWSER_SERVICE_URL: "https://browser.staging.example", STAGING_TRANSCRIPT_WORKER_URL: "https://transcripts.staging.example" });
    assert.equal(rendered.status, 0, rendered.stderr);
    const compose = JSON.parse(rendered.stdout);
    const env = compose.services["sfu-staging"].environment;
    for (const name of ["REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) {
      assert.equal(env[name], "redis://:staging-pw@127.0.0.1:6380/0", name);
    }
    assert.equal(resolveSfuTargets({ compose, serviceNames: ["sfu-staging"] }).length, 1);
    assert.notEqual(compose.services["sfu-staging"].image, "conclave-sfu-a", "staging never retags production's image");
    assert.equal(env.BROWSER_SERVICE_URL, "https://browser.staging.example");
    assert.equal(env.TRANSCRIPT_WORKER_URL, "https://transcripts.staging.example");
  },
);
