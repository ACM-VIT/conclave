import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
    NODE_ENV: "production",
    SFU_CORS_ORIGINS: "https://conclave.example",
    RTC_MAX_PORT: String(maxPort),
    RTC_MIN_PORT: String(minPort),
    SFU_INSTANCE_ID: instanceId,
    SFU_PORT: String(port),
    SFU_PUBLIC_URL: publicUrl,
    SFU_REDIS_URL: redisUrl,
    SFU_REGION: region,
    SFU_REQUIRE_REDIS_ADAPTER: "1",
    SFU_SECRET: "test-secret-not-for-production",
    CONCLAVE_SQLITE_PATH: "/var/lib/conclave/recordings/conclave.sqlite",
    RECORDING_STORAGE_PATH: "/var/lib/conclave/recordings",
  },
  volumes: [{ type: "bind", source: "/var/lib/conclave/recordings", target: "/var/lib/conclave/recordings" }],
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

test("a non-local SFU must announce a globally routable IP", () => {
  const announce = (ip) => {
    const compose = makeCompose();
    const dxb = compose.services["edge-dxb"].environment;
    dxb.SFU_PUBLIC_URL = "https://dxb.example.com";
    dxb.ANNOUNCED_IP = ip;
    try {
      resolveSfuTargets({ compose, serviceNames: ["edge-dxb"] });
      return true;
    } catch (error) {
      assert.match(error.message, /ANNOUNCED_IP must be a publicly routable IP/);
      return false;
    }
  };
  assert.equal(announce("2606:4700::1111"), true);
  assert.equal(announce("::ffff:8.8.8.8"), true);
  // 2::1 is 0002::1, outside the global unicast 2000::/3 block.
  assert.equal(announce("2::1"), false);
  assert.equal(announce("fd00::1"), false);
  assert.equal(announce("::ffff:10.0.0.1"), false);
});

test("overlapping RTC ranges are fatal on one address however it is spelled", () => {
  for (const [first, second] of [["8.8.8.8", "::ffff:8.8.8.8"], ["2606:4700::1111", "2606:4700:0:0::1111"]]) {
    const compose = makeCompose();
    const dxb = compose.services["edge-dxb"].environment;
    const fra = compose.services["edge-fra"].environment;
    dxb.SFU_PUBLIC_URL = "https://dxb.example.com";
    fra.SFU_PUBLIC_URL = "https://fra.example.com";
    dxb.ANNOUNCED_IP = first;
    fra.ANNOUNCED_IP = second;
    fra.RTC_MIN_PORT = dxb.RTC_MIN_PORT;
    fra.RTC_MAX_PORT = dxb.RTC_MAX_PORT;
    assert.throws(() => resolveSfuTargets({ compose }), /RTC port ranges overlap on 8\.8\.8\.8|RTC port ranges overlap on 2606:4700::1111/, `${first} vs ${second}`);
  }
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

const composeWithRedis = (redisUrl) => {
  const compose = makeCompose();
  for (const service of Object.values(compose.services)) {
    service.environment.SFU_REDIS_URL = redisUrl;
  }
  return compose;
};

const redisErrors = (redisUrl, options = {}) => {
  try {
    resolveSfuTargets({ compose: composeWithRedis(redisUrl), ...options });
    return [];
  } catch (error) {
    assert.ok(error instanceof SfuDeployPreflightError);
    return error.errors;
  }
};

test("Redis on this host's loopback passes with or without credentials", () => {
  for (const url of [
    "redis://:prod-password@127.0.0.1:6379",
    "redis://127.0.0.1:6379/0",
    "redis://localhost:6379",
    "redis://[::1]:6379",
  ]) {
    assert.deepEqual(redisErrors(url), [], url);
  }
});

test("Redis off loopback must use TLS and credentials", () => {
  assert.match(redisErrors("redis://user:secret@10.0.0.5:6379").join("\n"), /must use TLS/);
  assert.match(redisErrors("rediss://10.0.0.5:6380").join("\n"), /require credentials/);
  assert.match(redisErrors("redis://redis.internal:6379").join("\n"), /must use TLS[\s\S]*require credentials/);
  assert.deepEqual(redisErrors("rediss://user:secret@10.0.0.5:6380"), []);
  assert.deepEqual(redisErrors("rediss://:secret@redis.internal:6380"), []);
});

test("Redis at a public IP needs an explicit override", () => {
  assert.match(redisErrors("rediss://user:secret@57.159.28.54:6380").join("\n"), /public IP 57\.159\.28\.54 is refused/);
  assert.match(redisErrors("rediss://user:secret@[2606:4700::1111]:6380").join("\n"), /public IP/);
  for (const mapped of ["[::ffff:57.159.28.54]", "[::ffff:399f:1c36]", "[0:0:0:0:0:FFFF:57.159.28.54]"]) {
    assert.match(redisErrors(`rediss://user:secret@${mapped}:6380`).join("\n"), /public IP/, mapped);
  }
  assert.deepEqual(redisErrors("rediss://user:secret@[::ffff:10.0.0.5]:6380"), []);
  assert.deepEqual(redisErrors("redis://[::ffff:127.0.0.1]:6379"), []);
  assert.deepEqual(redisErrors("rediss://user:secret@57.159.28.54:6380", { allowPublicRedis: true }), []);
  assert.match(
    redisErrors("redis://57.159.28.54:6379", { allowPublicRedis: true }).join("\n"),
    /must use TLS[\s\S]*require credentials/,
  );
});

test("the CLI refuses a public Redis unless SFU_DEPLOY_ALLOW_PUBLIC_REDIS=1", () => {
  const script = fileURLToPath(new URL("./deploy-sfu-preflight.mjs", import.meta.url));
  const run = (redisUrl, env = {}) =>
    spawnSync(process.execPath, [script, "--compose-json", "-", "--config-only"], {
      input: JSON.stringify(composeWithRedis(redisUrl)),
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
    });

  const prodShape = run("redis://:prod-password@127.0.0.1:6379");
  assert.equal(prodShape.status, 0, prodShape.stderr);
  assert.ok(!`${prodShape.stdout}${prodShape.stderr}`.includes("prod-password"));

  const publicRedis = run("rediss://user:redis-pw-sentinel@57.159.28.54:6380");
  assert.equal(publicRedis.status, 1);
  assert.match(publicRedis.stderr, /public IP/);
  assert.ok(!publicRedis.stderr.includes("redis-pw-sentinel"));

  assert.equal(run("rediss://user:secret@57.159.28.54:6380", { SFU_DEPLOY_ALLOW_PUBLIC_REDIS: "1" }).status, 0);
});

const productionErrors = (environment) => {
  const compose = makeCompose();
  for (const service of Object.values(compose.services)) {
    Object.assign(service.environment, environment);
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete service.environment[key];
    }
  }
  try {
    resolveSfuTargets({ compose });
    return [];
  } catch (error) {
    assert.ok(error instanceof SfuDeployPreflightError);
    return error.errors;
  }
};

test("SFU_SECRET must be a non-default value with no surrounding whitespace", () => {
  for (const secret of [" development-secret ", "development-secret\n", "   "]) {
    assert.match(productionErrors({ SFU_SECRET: secret }).join("\n"), /SFU_SECRET must be a non-default value/, JSON.stringify(secret));
  }
  // Startup refuses padding, and calendar token encryption hashes the raw value,
  // so two SFUs that differ only by padding would encrypt with different keys.
  assert.match(productionErrors({ SFU_SECRET: " shared-secret-value " }).join("\n"), /SFU_SECRET has leading or trailing whitespace/);
  // Saved calendar tokens are encrypted with the padded value until SCHEDULING_TOKEN_SECRET holds it.
  assert.match(
    productionErrors({ SFU_SECRET: " shared-secret-value ", SCHEDULING_TOKEN_SECRET: undefined }).join("\n"),
    /set SCHEDULING_TOKEN_SECRET to the exact current SFU_SECRET, padding included, before you trim SFU_SECRET/,
  );
  assert.doesNotMatch(
    productionErrors({ SFU_SECRET: " shared-secret-value ", SCHEDULING_TOKEN_SECRET: " shared-secret-value " }).join("\n"),
    /set SCHEDULING_TOKEN_SECRET/,
  );
  const compose = makeCompose();
  compose.services["edge-dxb"].environment.SFU_SECRET = "shared-secret-value ";
  compose.services["edge-fra"].environment.SFU_SECRET = "shared-secret-value";
  assert.throws(() => resolveSfuTargets({ compose }), /edge-dxb: SFU_SECRET has leading or trailing whitespace/);
});

const composeMissing = spawnSync("docker", ["compose", "version"]).status !== 0;
const composeSkip = composeMissing && process.env.CONCLAVE_REQUIRE_DOCKER !== "1"
  ? "docker compose is not installed; pnpm test:deploy-compose renders the real compose file and fails without it"
  : false;

test("compose forwards SCHEDULING_TOKEN_SECRET to both SFUs, padding included", { skip: composeSkip }, () => {
  const rendered = spawnSync("docker", ["compose", "--env-file", "/dev/null", "-f", "docker-compose.sfu.yml", "config", "--format", "json"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ANNOUNCED_IP: "127.0.0.1", SFU_SECRET: "clean-secret-value", SCHEDULING_TOKEN_SECRET: "  padded-secret-value " },
    encoding: "utf8",
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  const { services } = JSON.parse(rendered.stdout);
  for (const name of ["sfu-a", "sfu-b"]) {
    assert.equal(services[name].environment.SCHEDULING_TOKEN_SECRET, "  padded-secret-value ", name);
  }
});

const storePathErrors = (environment, volumes) => {
  const compose = makeCompose();
  for (const service of Object.values(compose.services)) {
    Object.assign(service.environment, environment);
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete service.environment[key];
    }
    if (volumes) service.volumes = volumes;
  }
  try {
    resolveSfuTargets({ compose });
    return [];
  } catch (error) {
    return error.errors.filter((message) => /writable volume mount/.test(message));
  }
};

test("every store path must be on a writable volume mount", () => {
  assert.deepEqual(storePathErrors({}), []);
  // The image's read-only root: Sol's run exited 1 with this path.
  assert.match(storePathErrors({ CONCLAVE_SQLITE_PATH: "/var/lib/conclave/conclave.sqlite" }).join("\n"), /CONCLAVE_SQLITE_PATH resolves to \/var\/lib\/conclave\/conclave\.sqlite/);
  // Without CONCLAVE_SQLITE_PATH the image default applies, which is off the volume.
  assert.match(storePathErrors({ CONCLAVE_SQLITE_PATH: undefined }).join("\n"), /not on a writable volume mount/);
  assert.match(storePathErrors({ CONTROL_PLANE_PERSISTENCE: "json", CONTROL_PLANE_JSON_PATH: "/app/data/control-plane.json" }).join("\n"), /CONTROL_PLANE_JSON_PATH resolves to \/app\/data\/control-plane\.json/);
  assert.deepEqual(storePathErrors({ CONTROL_PLANE_PERSISTENCE: "json" }), []);
  assert.deepEqual(
    storePathErrors({ SCHEDULING_PERSISTENCE: "json", SCHEDULED_MEETINGS_PERSISTENCE: "json", SCHEDULED_WEBINARS_PERSISTENCE: "json", CONCLAVE_SQLITE_PATH: "/tmp/unused.sqlite" }),
    [],
  );
  assert.deepEqual(storePathErrors({ SCHEDULED_WEBINARS_SQLITE_PATH: "/tmp/webinars.sqlite" }), []);
  assert.match(
    storePathErrors({}, [{ type: "bind", source: "/srv/recordings", target: "/var/lib/conclave/recordings", read_only: true }]).join("\n"),
    /not on a writable volume mount/,
  );
  assert.equal(storePathErrors({ CONCLAVE_SQLITE_PATH: "/var/lib/conclave/conclave.sqlite" }).filter((message) => message.startsWith("edge-dxb")).length, 1);
});

test("SFU services must run in production mode", () => {
  assert.match(productionErrors({ NODE_ENV: undefined }).join("\n"), /NODE_ENV must be production/);
  assert.match(productionErrors({ NODE_ENV: "development" }).join("\n"), /NODE_ENV must be production/);
});

test("production mode needs the CORS allow-list the SFU checks at startup", () => {
  assert.match(productionErrors({ SFU_CORS_ORIGINS: undefined }).join("\n"), /SFU_CORS_ORIGINS must list/);
  assert.match(productionErrors({ SFU_CORS_ORIGINS: "*" }).join("\n"), /SFU_CORS_ORIGINS must list/);
  assert.match(productionErrors({ SFU_CORS_ORIGINS: "conclave.example" }).join("\n"), /not an http\(s\) origin/);
  assert.deepEqual(productionErrors({ SFU_CORS_ORIGINS: "https://conclave.example, https://admin.example" }), []);
  assert.deepEqual(productionErrors({ SFU_CORS_ORIGINS: "*", SFU_ALLOW_OPEN_CORS: "1" }), []);
  assert.deepEqual(productionErrors({ SFU_CORS_ORIGINS: undefined, SFU_ALLOW_OPEN_CORS: "1" }), []);
  // The override allows a wildcard; the SFU still parses explicit entries and refuses bad ones.
  assert.match(
    productionErrors({ SFU_CORS_ORIGINS: "conclave.example", SFU_ALLOW_OPEN_CORS: "1" }).join("\n"),
    /not an http\(s\) origin/,
  );
});
