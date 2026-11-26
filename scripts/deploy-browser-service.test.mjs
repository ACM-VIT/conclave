import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const RUNTIME_IMAGE = "conclave-browser:latest";

const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [[ "$1" == "compose" && " $* " == *" --check-config "* ]]; then
  [[ "\${FAKE_CHECK_STATUS:-0}" == "0" ]] && echo "BROWSER_SERVICE_HEALTH_URL=http://127.0.0.1:$BROWSER_SERVICE_PORT/health"
  exit "\${FAKE_CHECK_STATUS:-0}"
fi
if [[ "$1" == "compose" && " $* " == *" ps -q browser-service "* ]]; then
  [[ -n "$FAKE_PREVIOUS_CONTAINER" ]] && echo "$FAKE_PREVIOUS_CONTAINER"
  exit 0
fi
if [[ "$1" == "inspect" ]]; then
  case "$*" in
    *State.Running*) echo "\${FAKE_PREVIOUS_RUNNING:-true}" ;;
    *Config.Env*) printf '%b' "$FAKE_PREVIOUS_ENV" ;;
    *NetworkMode*) echo "\${FAKE_PREVIOUS_NETWORK:-host}" ;;
    *PortBindings*) printf '%s' "$FAKE_PREVIOUS_BINDINGS" ;;
  esac
  exit 0
fi
if [[ "$1" == "compose" && " $* " == *" up -d "* ]]; then
  printf '%s' "$BROWSER_SERVICE_DEPLOY_ID" > "$DEPLOY_ID_FILE"
fi
exit 0
`;

const powerShells = (process.env.CONCLAVE_PWSH_BINARIES ?? "pwsh")
  .split(",")
  .map((binary) => binary.trim())
  .filter(Boolean)
  .filter((binary) => spawnSync(binary, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0);

const registered = [];
const test = (name, body) => registered.push({ name, body });
const SUITE = "browser service deploy";

const shells = [
  { name: "bash", script: "deploy-browser-service.sh", command: "bash", args: [] },
  ...powerShells.map((binary) => ({ name: `pwsh ${binary}`, script: "deploy-browser-service.ps1", command: binary, args: ["-NoProfile", "-NonInteractive", "-File"] })),
];

const run = (command, args, env) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

const healthBodies = {
  deployed: (deployId) => ({ service: "conclave-shared-browser", deployId, status: "ok", sessions: 0 }),
  previous: () => ({ service: "conclave-shared-browser", deployId: "an-earlier-deploy", status: "ok", sessions: 0 }),
  empty: () => ({}),
  sfu: () => ({ status: "healthy", timestamp: new Date().toISOString(), uptime: 40, port: 3031 }),
};

const deploy = async (
  shell,
  flags = [],
  { checkStatus = 0, answers = "deployed", previousContainer = "", previousRunning = "true", previousEnv = "", previousNetwork = "host", previousBindings = "", serviceHost = "127.0.0.1" } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "deploy-browser-service-"));
  const deployIdFile = join(root, "deploy-id");
  let healthRequests = 0;
  const health = createServer((req, res) => {
    if (req.url === "/health") healthRequests += 1;
    const deployId = existsSync(deployIdFile) ? readFileSync(deployIdFile, "utf8") : null;
    res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(healthBodies[answers](deployId)));
  });
  await new Promise((resolve) => health.listen(0, "127.0.0.1", resolve));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "packages", "shared-browser", "docker"), { recursive: true });
    copyFileSync(join(scriptsDir, shell.script), join(root, "scripts", shell.script));
    writeFileSync(join(root, "docker-compose.browser.yml"), "services: {}\n");
    writeFileSync(join(root, "bin", "docker"), FAKE_DOCKER);
    chmodSync(join(root, "bin", "docker"), 0o755);
    const log = join(root, "docker.log");
    writeFileSync(log, "");
    const result = await run(shell.command, [...shell.args, join(root, "scripts", shell.script), ...flags], {
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      HOME: root,
      DOCKER_LOG: log,
      DEPLOY_ID_FILE: deployIdFile,
      BROWSER_SERVICE_HEALTH_TIMEOUT_SECONDS: "2",
      BROWSER_SERVICE_HEALTH_POLL_SECONDS: "0.2",
      FAKE_CHECK_STATUS: String(checkStatus),
      FAKE_PREVIOUS_CONTAINER: previousContainer,
      FAKE_PREVIOUS_RUNNING: previousRunning,
      FAKE_PREVIOUS_ENV: previousEnv,
      FAKE_PREVIOUS_NETWORK: previousNetwork,
      FAKE_PREVIOUS_BINDINGS: previousBindings,
      BROWSER_SERVICE_HOST: serviceHost,
      BROWSER_SERVICE_PORT: String(health.address().port),
    });
    return { ...result, healthRequests, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  } finally {
    await new Promise((resolve) => health.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
};

const index = (calls, pattern) => calls.findIndex((call) => pattern.test(call));
const candidateOf = (calls) => calls.map((call) => call.match(/^build -t (conclave-browser-candidate:\S+) /)?.[1]).find(Boolean);
const checkedImage = (calls) => calls.map((call) => call.match(/ -e BROWSER_IMAGE_NAME=(\S+) .*browser-service .*--check-config/)?.[1]).find(Boolean);

for (const shell of shells) {
  test(`${shell.name}: checks the runtime image it built before retagging it and deploying`, async () => {
    const { status, calls, stderr } = await deploy(shell);
    assert.equal(status, 0, stderr);
    const candidate = candidateOf(calls);
    assert.ok(candidate, calls.join("\n"));
    assert.equal(checkedImage(calls), candidate, calls.join("\n"));
    const built = index(calls, /^build -t conclave-browser-candidate:/);
    const checked = index(calls, /--check-config/);
    const tagged = calls.indexOf(`tag ${candidate} ${RUNTIME_IMAGE}`);
    const deployed = index(calls, /^compose .* up -d .*browser-service/);
    assert.ok(built >= 0 && checked > built && tagged > checked && deployed > tagged, calls.join("\n"));
    assert.ok(calls.includes(`image rm ${candidate}`), calls.join("\n"));
  });

  test(`${shell.name}: --check-config checks a fresh build and never retags the live image`, async () => {
    const { status, calls, stderr } = await deploy(shell, ["--check-config"]);
    assert.equal(status, 0, stderr);
    const candidate = candidateOf(calls);
    assert.ok(candidate, calls.join("\n"));
    assert.equal(checkedImage(calls), candidate);
    assert.equal(index(calls, /^tag /), -1, calls.join("\n"));
    assert.equal(index(calls, / up -d /), -1, calls.join("\n"));
    assert.ok(calls.includes(`image rm ${candidate}`), calls.join("\n"));
  });

  test(`${shell.name}: a failed check stops before the live image is retagged or the service replaced`, async () => {
    const { status, calls } = await deploy(shell, [], { checkStatus: 1 });
    assert.notEqual(status, 0);
    assert.equal(index(calls, /^tag /), -1, calls.join("\n"));
    assert.equal(index(calls, / up -d /), -1, calls.join("\n"));
  });

  test(`${shell.name}: only this deploy's browser service counts as healthy`, async () => {
    const kinds = ["empty", "sfu", "previous"];
    const outcomes = await Promise.all(kinds.map((answers) => deploy(shell, [], { answers })));
    outcomes.forEach(({ status, calls, stderr, healthRequests }, at) => {
      assert.notEqual(status, 0, `${kinds[at]} was accepted as healthy`);
      assert.ok(index(calls, / up -d /) >= 0, calls.join("\n"));
      assert.match(stderr, /did not answer healthy/, kinds[at]);
      assert.ok(healthRequests >= 1, `${kinds[at]}: the deploy never asked for health, so the answer was never checked`);
    });
  });

  test(`${shell.name}: tells the check which running container it is replacing, and only a running one`, async () => {
    const previous = (calls) => calls.map((call) => call.match(/-e BROWSER_SERVICE_PREVIOUS_CONTAINER=(\S*) /)?.[1]).find((value) => value !== undefined);
    const running = await deploy(shell, ["--check-config"], { previousContainer: "4f2c1d" });
    assert.equal(running.status, 0, running.stderr);
    assert.equal(previous(running.calls), "4f2c1d", running.calls.join("\n"));
    const stopped = await deploy(shell, ["--check-config"], { previousContainer: "4f2c1d", previousRunning: "false" });
    assert.equal(previous(stopped.calls), "", stopped.calls.join("\n"));
    const none = await deploy(shell, ["--check-config"]);
    assert.equal(previous(none.calls), "", none.calls.join("\n"));
  });

  test(`${shell.name}: tells the check the bindings and deploy id the replaced container holds, as written, not the ones this deploy configures`, async () => {
    const passed = (calls, name) => calls.map((call) => call.match(new RegExp(` -e ${name}=(\\S*) `))?.[1]).find((value) => value !== undefined);
    const hostNetwork = await deploy(shell, ["--check-config"], {
      previousContainer: "4f2c1d",
      previousEnv: "PATH=/usr/bin\\nBROWSER_SERVICE_HOST=127.0.0.1\\nBROWSER_SERVICE_PORT=3999\\nBROWSER_SERVICE_DEPLOY_ID=1a2b3c\\n",
    });
    assert.equal(hostNetwork.status, 0, hostNetwork.stderr);
    assert.equal(passed(hostNetwork.calls, "BROWSER_SERVICE_PREVIOUS_BINDINGS"), "127.0.0.1|3999", hostNetwork.calls.join("\n"));
    assert.equal(passed(hostNetwork.calls, "BROWSER_SERVICE_PREVIOUS_DEPLOY_ID"), "1a2b3c", hostNetwork.calls.join("\n"));
    const moved = await deploy(shell, ["--check-config"], {
      serviceHost: "10.0.4.7",
      previousContainer: "4f2c1d",
      previousEnv: "BROWSER_SERVICE_HOST=127.0.0.1\\nBROWSER_SERVICE_PORT=3040\\n",
    });
    assert.equal(passed(moved.calls, "BROWSER_SERVICE_PREVIOUS_BINDINGS"), "127.0.0.1|3040", moved.calls.join("\n"));
    const ipv6 = await deploy(shell, ["--check-config"], {
      serviceHost: "::1",
      previousContainer: "4f2c1d",
      previousEnv: "BROWSER_SERVICE_HOST=0:0:0:0:0:0:0:1\\nBROWSER_SERVICE_PORT=3040\\nBROWSER_SERVICE_DEPLOY_ID=\\n",
    });
    assert.equal(passed(ipv6.calls, "BROWSER_SERVICE_PREVIOUS_BINDINGS"), "0:0:0:0:0:0:0:1|3040", ipv6.calls.join("\n"));
    assert.equal(passed(ipv6.calls, "BROWSER_SERVICE_PREVIOUS_DEPLOY_ID"), "", ipv6.calls.join("\n"));
    const olderImage = await deploy(shell, ["--check-config"], { previousContainer: "4f2c1d", previousEnv: "PATH=/usr/bin\\n" });
    assert.equal(passed(olderImage.calls, "BROWSER_SERVICE_PREVIOUS_BINDINGS"), "|", olderImage.calls.join("\n"));
    const published = await deploy(shell, ["--check-config"], { previousContainer: "4f2c1d", previousNetwork: "bridge", previousBindings: "|4100,::ffff:10.0.0.5|4101," });
    assert.equal(passed(published.calls, "BROWSER_SERVICE_PREVIOUS_BINDINGS"), "|4100,::ffff:10.0.0.5|4101", published.calls.join("\n"));
    const none = await deploy(shell, ["--check-config"]);
    assert.equal(passed(none.calls, "BROWSER_SERVICE_PREVIOUS_BINDINGS"), "", none.calls.join("\n"));
  });

  test(`${shell.name}: --skip-runtime-image checks the image already on the host`, async () => {
    const { status, calls, stderr } = await deploy(shell, ["--skip-runtime-image"]);
    assert.equal(status, 0, stderr);
    assert.equal(index(calls, /^build -t /), -1, calls.join("\n"));
    assert.equal(checkedImage(calls), RUNTIME_IMAGE, calls.join("\n"));
    assert.equal(index(calls, /^tag /), -1, calls.join("\n"));
  });
}

const sharedBrowserDir = fileURLToPath(new URL("../packages/shared-browser/", import.meta.url));
const fakeLocalhostDns = join(sharedBrowserDir, "test", "support", "fake-localhost-dns.mjs");

const REAL_CHECK_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
args=("$@")
if [[ "$1" == "compose" && " $* " == *" --check-config "* ]]; then
  envs=()
  for ((i = 0; i < \${#args[@]}; i++)); do [[ "\${args[i]}" == "-e" ]] && envs+=("\${args[i + 1]}"); done
  cd "$SHARED_BROWSER_DIR" && exec env "\${envs[@]}" DOCKER_HOST="$FAKE_ENGINE" BROWSER_SERVICE_TOKEN="$CHECK_TOKEN" node --import tsx --import "$FAKE_DNS" src/server.ts --check-config
fi
if [[ "$1" == "compose" && " $* " == *" ps -q browser-service "* ]]; then
  [[ -n "$FAKE_PREVIOUS_CONTAINER" ]] && echo "$FAKE_PREVIOUS_CONTAINER"
  exit 0
fi
if [[ "$1" == "inspect" ]]; then
  case "$*" in
    *State.Running*) echo true ;;
    *Config.Env*) printf '%b' "$FAKE_PREVIOUS_ENV" ;;
    *NetworkMode*) echo host ;;
  esac
  exit 0
fi
if [[ "$1" == "compose" && " $* " == *" up -d "* ]]; then
  [[ -s "$OLD_SERVICE_PID" ]] && kill "$(cat "$OLD_SERVICE_PID")" && : > "$OLD_SERVICE_PID"
  node "$FAKE_SERVICE" "$BROWSER_SERVICE_DEPLOY_ID" "$NEW_SERVICE_HOST" "$BROWSER_SERVICE_PORT" > /dev/null 2>&1 < /dev/null &
  echo $! > "$NEW_SERVICE_PID"
fi
exit 0
`;

const FAKE_SERVICE = `import { createServer } from "node:http";
const [deployId, host, port] = process.argv.slice(2);
const body = JSON.stringify({ service: "conclave-shared-browser", deployId: deployId === "-" ? null : deployId, status: "ok", sessions: 0 });
createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
  res.end(body);
}).listen(Number(port), host);
`;

const handedOutPorts = new Set();
const freePort = () =>
  new Promise((resolve) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => (handedOutPorts.has(port) ? freePort().then(resolve) : (handedOutPorts.add(port), resolve(port))));
    });
  });

const ipv6Loopback = await new Promise((resolve) => {
  const probe = createNetServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

const fakeEngine = async () => {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace(/^\/v[\d.]+/, "").split("?")[0];
    if (path === "/_ping") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("OK");
    }
    if (/^\/images\/.+\/json$/.test(path)) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ Id: "sha256:checked", Config: { Labels: { "org.conclave.browser.vnc-auth": "per-session-password" } } }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { host: `tcp://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
};

const stopRecorded = (pidFile) => {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {}
};

const deployWithRealCheck = async (shell, { setting, localhost = "", serviceHost, previous }) => {
  const root = mkdtempSync(join(tmpdir(), "deploy-browser-real-check-"));
  const engine = await fakeEngine();
  const port = await freePort();
  const pids = { old: join(root, "old.pid"), new: join(root, "new.pid") };
  writeFileSync(pids.old, "");
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "packages", "shared-browser", "docker"), { recursive: true });
    copyFileSync(join(scriptsDir, shell.script), join(root, "scripts", shell.script));
    writeFileSync(join(root, "docker-compose.browser.yml"), "services: {}\n");
    writeFileSync(join(root, "bin", "docker"), REAL_CHECK_DOCKER);
    chmodSync(join(root, "bin", "docker"), 0o755);
    writeFileSync(join(root, "fake-service.mjs"), FAKE_SERVICE);
    const log = join(root, "docker.log");
    writeFileSync(log, "");
    if (previous) {
      const old = spawn(process.execPath, [join(root, "fake-service.mjs"), "-", previous.listen, String(port)], { stdio: "ignore" });
      writeFileSync(pids.old, String(old.pid));
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const answered = await fetch(`http://${previous.listen.includes(":") ? `[${previous.listen}]` : previous.listen}:${port}/health`).then(() => true, () => false);
        if (answered) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const result = await run(shell.command, [...shell.args, join(root, "scripts", shell.script)], {
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      HOME: root,
      DOCKER_LOG: log,
      SHARED_BROWSER_DIR: sharedBrowserDir,
      FAKE_ENGINE: engine.host,
      FAKE_DNS: fakeLocalhostDns,
      FAKE_LOCALHOST_ADDRESSES: localhost,
      CHECK_TOKEN: randomBytes(32).toString("hex"),
      FAKE_SERVICE: join(root, "fake-service.mjs"),
      NEW_SERVICE_HOST: serviceHost,
      NEW_SERVICE_PID: pids.new,
      OLD_SERVICE_PID: pids.old,
      FAKE_PREVIOUS_CONTAINER: previous ? "4f2c1d" : "",
      FAKE_PREVIOUS_ENV: previous ? previous.env.replace("<port>", String(port)) : "",
      BROWSER_SERVICE_HOST: setting,
      BROWSER_SERVICE_PORT: String(port),
      BROWSER_SERVICE_HEALTH_TIMEOUT_SECONDS: "10",
      BROWSER_SERVICE_HEALTH_POLL_SECONDS: "0.2",
    });
    return { ...result, port, polled: result.stdout.match(/Waiting for (\S+)\.\.\./)?.[1] ?? null };
  } finally {
    stopRecorded(pids.new);
    stopRecorded(pids.old);
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
};

for (const shell of shells) {
  test(`${shell.name}: polls the health URL the real check reports, however BROWSER_SERVICE_HOST is written`, async () => {
    const cases = [
      { setting: "localhost", localhost: "127.0.0.1", serviceHost: "127.0.0.1", urlHost: "127.0.0.1" },
      ...(ipv6Loopback
        ? [
            { setting: "[::1]", serviceHost: "::1", urlHost: "[::1]" },
            { setting: "::1", serviceHost: "::1", urlHost: "[::1]" },
            { setting: "0:0:0:0:0:0:0:1", serviceHost: "::1", urlHost: "[::1]" },
            { setting: "localhost", localhost: "::1,127.0.0.1", serviceHost: "::1", urlHost: "[::1]" },
          ]
        : []),
    ];
    const outcomes = [];
    for (const { urlHost, ...options } of cases) {
      const { status, polled, port, stderr } = await deployWithRealCheck(shell, options);
      outcomes.push({ setting: options.setting, localhost: options.localhost ?? "", status, polled, expected: `http://${urlHost}:${port}/health`, stderr: status === 0 ? "" : stderr });
    }
    assert.deepEqual(
      outcomes.map(({ setting, localhost, status, polled, expected, stderr }) => ({ setting, localhost, status, polledExpected: polled === expected, stderr })),
      outcomes.map(({ setting, localhost }) => ({ setting, localhost, status: 0, polledExpected: true, stderr: "" })),
    );
  });

  test(`${shell.name}: upgrades a service set to localhost with no deploy id, end to end`, async () => {
    const cases = [
      { localhost: "127.0.0.1", serviceHost: "127.0.0.1", listen: "127.0.0.1" },
      ...(ipv6Loopback ? [{ localhost: "::1", serviceHost: "::1", listen: "::1" }] : []),
    ];
    const outcomes = [];
    for (const { localhost, serviceHost, listen } of cases) {
      const { status, stderr } = await deployWithRealCheck(shell, {
        setting: "localhost",
        localhost,
        serviceHost,
        previous: { listen, env: "BROWSER_SERVICE_HOST=localhost\\nBROWSER_SERVICE_PORT=<port>\\nBROWSER_SERVICE_DEPLOY_ID=\\n" },
      });
      outcomes.push({ localhost, status, stderr: status === 0 ? "" : stderr });
    }
    assert.deepEqual(outcomes, cases.map(({ localhost }) => ({ localhost, status: 0, stderr: "" })));
  });
}

describe(SUITE, { concurrency: Math.min(8, availableParallelism()) }, () => {
  for (const { name, body } of registered) nodeTest(name, body);
});
