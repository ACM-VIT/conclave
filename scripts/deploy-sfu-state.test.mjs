import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const OLD_CONTAINER = "old-sfu-a";
const DATA = "/app/packages/sfu/data";

const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
args=("$@")
if [[ "$1" == "compose" ]]; then
  for ((i = 1; i < \${#args[@]}; i++)); do
    case "\${args[i]}" in
      ps) [[ -n "$FAKE_CONTAINER" ]] && echo "$FAKE_CONTAINER"; exit 0 ;;
      stop|build|run|up|start) exit 0 ;;
    esac
  done
  exit 0
fi
case "$1" in
  diff) printf '%b' "$FAKE_DIFF"; exit "\${FAKE_DIFF_STATUS:-0}" ;;
  cp)
    name="\${2##*/}"
    if [[ " $FAKE_CP_FAIL " == *" $name "* ]]; then echo "Error response from daemon: copy failed" >&2; exit 1; fi
    echo '[]' > "$3"; exit 0 ;;
esac
exit 0
`;

const definitions = (source, pattern, names) =>
  names.map((name) => {
    const match = source.match(pattern(name));
    assert.ok(match, `the deploy script defines ${name}`);
    return match[0];
  }).join("\n");

const deployShell = readFileSync(join(scriptsDir, "deploy-sfu.sh"), "utf8");
const deployPowerShell = readFileSync(join(scriptsDir, "deploy-sfu.ps1"), "utf8");
const shellFunction = (name) => new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, "m");
const powerShellFunction = (name) => new RegExp(`^function ${name} \\{\\n[\\s\\S]*?^\\}\\n`, "m");
const definedShellFunctions = new Set([...deployShell.matchAll(/^([a-z_]+)\(\) \{$/gm)].map((match) => match[1]));

const harnesses = {
  bash: {
    command: "bash",
    file: "harness.sh",
    source: () => [
      "set -euo pipefail",
      "COMPOSE=(docker compose -f docker-compose.sfu.yml)",
      definitions(deployShell, shellFunction, ["copy_fallback_json", "ensure_state_ownership", "build_and_start"].filter((name) => definedShellFunctions.has(name))),
      "build_and_start sfu-a",
    ].join("\n"),
  },
  pwsh: {
    command: "pwsh",
    args: ["-NoProfile", "-NonInteractive", "-File"],
    file: "harness.ps1",
    source: () => [
      "Set-StrictMode -Version Latest",
      '$ErrorActionPreference = "Stop"',
      '$composeBaseArgs = @("compose", "-f", "docker-compose.sfu.yml")',
      definitions(deployPowerShell, powerShellFunction, ["Exit-WithError", "Invoke-Checked", "Copy-FallbackJson", "Start-SfuService"]),
      "Start-SfuService -Service sfu-a",
    ].join("\n"),
  },
};

const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

const replaceService = (shell, { container = OLD_CONTAINER, diff = "", diffStatus = 0, cpFail = "" } = {}) => {
  const harness = harnesses[shell];
  const dir = mkdtempSync(join(tmpdir(), "deploy-sfu-state-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), FAKE_DOCKER);
    chmodSync(join(bin, "docker"), 0o755);
    const log = join(dir, "docker.log");
    writeFileSync(log, "");
    writeFileSync(join(dir, harness.file), harness.source());
    const result = spawnSync(harness.command, [...(harness.args ?? []), join(dir, harness.file)], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        DOCKER_LOG: log,
        FAKE_CONTAINER: container,
        FAKE_DIFF: diff,
        FAKE_DIFF_STATUS: String(diffStatus),
        FAKE_CP_FAIL: cpFail,
      },
    });
    return { ...result, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const callIndex = (calls, pattern) => calls.findIndex((call) => pattern.test(call));
const wrote = (name) => `A ${DATA}/${name}\\n`;

for (const shell of Object.keys(harnesses)) {
  const skip = shell === "pwsh" && !hasPwsh ? "pwsh is not installed; deploy-sfu.ps1 is not exercised here" : false;

  test(`${shell}: stops the old SFU before copying its fallback files, and starts the new one only after`, { skip }, () => {
    const { status, calls, stderr } = replaceService(shell, { diff: `C ${DATA}\\n${wrote("scheduling.json")}` });
    assert.equal(status, 0, stderr);
    const stop = callIndex(calls, /^compose .* stop sfu-a$/);
    const copy = callIndex(calls, new RegExp(`^cp ${OLD_CONTAINER}:${DATA}/scheduling\\.json `));
    const start = callIndex(calls, /^compose .* up -d sfu-a$/);
    assert.ok(stop >= 0 && copy > stop && start > copy, calls.join("\n"));
  });

  test(`${shell}: copies only the fallback files the old SFU wrote`, { skip }, () => {
    const { status, calls, stderr } = replaceService(shell, { diff: wrote("scheduled-webinars.json") });
    assert.equal(status, 0, stderr);
    assert.deepEqual(calls.filter((call) => call.startsWith("cp ")).map((call) => call.split(" ")[1]), [
      `${OLD_CONTAINER}:${DATA}/scheduled-webinars.json`,
    ]);
  });

  test(`${shell}: a failed copy stops the deploy before the old SFU is replaced`, { skip }, () => {
    const { status, calls, stderr } = replaceService(shell, {
      diff: wrote("scheduling.json") + wrote("scheduled-meetings.json"),
      cpFail: "scheduled-meetings.json",
    });
    assert.notEqual(status, 0);
    assert.equal(callIndex(calls, / up -d /), -1, calls.join("\n"));
    assert.match(stderr, /start sfu-a/);
  });

  test(`${shell}: a failed file listing stops the deploy before the old SFU is replaced`, { skip }, () => {
    const { status, calls } = replaceService(shell, { diffStatus: 1 });
    assert.notEqual(status, 0);
    assert.equal(callIndex(calls, / up -d /), -1, calls.join("\n"));
  });

  test(`${shell}: with no old container, starts the new SFU without copying anything`, { skip }, () => {
    const { status, calls, stderr } = replaceService(shell, { container: "" });
    assert.equal(status, 0, stderr);
    assert.equal(callIndex(calls, /^(cp|diff) /), -1, calls.join("\n"));
    assert.ok(callIndex(calls, /^compose .* up -d sfu-a$/) >= 0);
  });
}
