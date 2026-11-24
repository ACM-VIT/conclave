import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const RUNTIME_IMAGE = "conclave-browser:latest";

const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [[ "$1" == "compose" && " $* " == *" --check-config "* ]]; then
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
  const health = createServer((req, res) => {
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
      BROWSER_SERVICE_HEALTH_TIMEOUT_SECONDS: "5",
      FAKE_CHECK_STATUS: String(checkStatus),
      FAKE_PREVIOUS_CONTAINER: previousContainer,
      FAKE_PREVIOUS_RUNNING: previousRunning,
      FAKE_PREVIOUS_ENV: previousEnv,
      FAKE_PREVIOUS_NETWORK: previousNetwork,
      FAKE_PREVIOUS_BINDINGS: previousBindings,
      BROWSER_SERVICE_HOST: serviceHost,
      BROWSER_SERVICE_PORT: String(health.address().port),
    });
    return { ...result, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
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
    for (const answers of ["empty", "sfu", "previous"]) {
      const { status, calls, stderr } = await deploy(shell, [], { answers });
      assert.notEqual(status, 0, `${answers} was accepted as healthy`);
      assert.ok(index(calls, / up -d /) >= 0, calls.join("\n"));
      assert.match(stderr, /did not answer healthy/, answers);
    }
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

  test(`${shell.name}: tells the check the address and deploy id the replaced container holds, not the ones this deploy configures`, async () => {
    const passed = (calls, name) => calls.map((call) => call.match(new RegExp(` -e ${name}=(\\S*) `))?.[1]).find((value) => value !== undefined);
    const hostNetwork = await deploy(shell, ["--check-config"], {
      previousContainer: "4f2c1d",
      previousEnv: "PATH=/usr/bin\\nBROWSER_SERVICE_HOST=127.0.0.1\\nBROWSER_SERVICE_PORT=3999\\nBROWSER_SERVICE_DEPLOY_ID=1a2b3c\\n",
    });
    assert.equal(hostNetwork.status, 0, hostNetwork.stderr);
    assert.equal(passed(hostNetwork.calls, "BROWSER_SERVICE_PREVIOUS_ADDRESSES"), "127.0.0.1:3999", hostNetwork.calls.join("\n"));
    assert.equal(passed(hostNetwork.calls, "BROWSER_SERVICE_PREVIOUS_DEPLOY_ID"), "1a2b3c", hostNetwork.calls.join("\n"));
    const moved = await deploy(shell, ["--check-config"], {
      serviceHost: "10.0.4.7",
      previousContainer: "4f2c1d",
      previousEnv: "BROWSER_SERVICE_HOST=127.0.0.1\\nBROWSER_SERVICE_PORT=3040\\n",
    });
    assert.equal(passed(moved.calls, "BROWSER_SERVICE_PREVIOUS_ADDRESSES"), "127.0.0.1:3040", moved.calls.join("\n"));
    const olderImage = await deploy(shell, ["--check-config"], { previousContainer: "4f2c1d", previousEnv: "PATH=/usr/bin\\n" });
    assert.equal(passed(olderImage.calls, "BROWSER_SERVICE_PREVIOUS_ADDRESSES"), "0.0.0.0:3040", olderImage.calls.join("\n"));
    assert.equal(passed(olderImage.calls, "BROWSER_SERVICE_PREVIOUS_DEPLOY_ID"), "", olderImage.calls.join("\n"));
    const published = await deploy(shell, ["--check-config"], { previousContainer: "4f2c1d", previousNetwork: "bridge", previousBindings: ":4100,10.0.0.5:4101," });
    assert.equal(passed(published.calls, "BROWSER_SERVICE_PREVIOUS_ADDRESSES"), ":4100,10.0.0.5:4101", published.calls.join("\n"));
    const none = await deploy(shell, ["--check-config"]);
    assert.equal(passed(none.calls, "BROWSER_SERVICE_PREVIOUS_ADDRESSES"), "", none.calls.join("\n"));
  });

  test(`${shell.name}: --skip-runtime-image checks the image already on the host`, async () => {
    const { status, calls, stderr } = await deploy(shell, ["--skip-runtime-image"]);
    assert.equal(status, 0, stderr);
    assert.equal(index(calls, /^build -t /), -1, calls.join("\n"));
    assert.equal(checkedImage(calls), RUNTIME_IMAGE, calls.join("\n"));
    assert.equal(index(calls, /^tag /), -1, calls.join("\n"));
  });
}
