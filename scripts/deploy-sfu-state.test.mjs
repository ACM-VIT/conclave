import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
      run)
        mount="" script="" rest=()
        for ((j = i + 1; j < \${#args[@]}; j++)); do
          case "\${args[j]}" in
            *:/fallback-json:ro) mount="\${args[j]%%:/fallback-json:ro}" ;;
            -c) script="\${args[j + 1]}"; rest=("\${args[@]:j + 2}"); break ;;
          esac
        done
        [[ -n "$script" ]] || exit 0
        if [[ -s "$STAGING_PATH_FILE" ]]; then
          staging="$(cat "$STAGING_PATH_FILE")"
          ls -ld "$staging" | cut -c1-10 >> "$STAGING_MODES"
          for file in "$staging"/*; do ls -l "$file" | cut -c1-10 >> "$STAGING_MODES"; done
        fi
        script="\${script//\\/fallback-json/$mount}"
        script="\${script//\\/var\\/lib\\/conclave\\/recordings/$FAKE_VOLUME}"
        CONCLAVE_FALLBACK_IMPORT_DIR="$FAKE_IMAGE_IMPORT_DIR" exec sh -c "$script" "\${rest[@]}" ;;
      stop|build|up|start) exit 0 ;;
    esac
  done
  exit 0
fi
case "$1" in
  diff) printf '%b' "$FAKE_DIFF"; exit "\${FAKE_DIFF_STATUS:-0}" ;;
  cp)
    name="\${2##*/}"
    if [[ " $FAKE_CP_FAIL " == *" $name "* ]]; then echo "Error response from daemon: copy failed" >&2; exit 1; fi
    printf '%s' "\${3%/*}" > "$STAGING_PATH_FILE"
    echo '[]' > "$3"; exit 0 ;;
esac
exit 0
`;

const definitions = (source, pattern, names) =>
  names.map((name) => source.match(pattern(name))?.[0]).filter(Boolean).join("\n");

const deployShell = readFileSync(join(scriptsDir, "deploy-sfu.sh"), "utf8");
const deployPowerShell = readFileSync(join(scriptsDir, "deploy-sfu.ps1"), "utf8");
const shellFunction = (name) => new RegExp(`^${name}\\(\\) [{(]\\n[\\s\\S]*?^[})]\\n`, "m");
const powerShellFunction = (name) => new RegExp(`^function ${name} \\{\\n[\\s\\S]*?^\\}\\n`, "m");

const harnesses = {
  bash: {
    command: "bash",
    file: "harness.sh",
    source: () => [
      "set -euo pipefail",
      "COMPOSE=(docker compose -f docker-compose.sfu.yml)",
      definitions(deployShell, shellFunction, ["copy_fallback_json", "ensure_state_ownership", "build_and_start"]),
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

const run = (command, args, env) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

const mode = (path) => (statSync(path).mode & 0o777).toString(8);

const replaceService = async (
  shell,
  { container = OLD_CONTAINER, diff = "", diffStatus = 0, cpFail = "", imageImportDir = true } = {},
) => {
  const harness = harnesses[shell];
  const dir = mkdtempSync(join(tmpdir(), "deploy-sfu-state-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), FAKE_DOCKER);
    chmodSync(join(bin, "docker"), 0o755);
    const log = join(dir, "docker.log");
    writeFileSync(log, "");
    const volume = join(dir, "volume");
    const importDir = join(dir, "image-import-dir");
    mkdirSync(volume);
    writeFileSync(join(dir, harness.file), harness.source());
    const result = await run(harness.command, [...(harness.args ?? []), join(dir, harness.file)], {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      DOCKER_LOG: log,
      FAKE_CONTAINER: container,
      FAKE_DIFF: diff,
      FAKE_DIFF_STATUS: String(diffStatus),
      FAKE_CP_FAIL: cpFail,
      FAKE_VOLUME: volume,
      FAKE_IMAGE_IMPORT_DIR: imageImportDir ? importDir : "",
      STAGING_PATH_FILE: join(dir, "staging-path"),
      STAGING_MODES: join(dir, "staging-modes"),
    });
    const listing = (path) => (existsSync(path) ? readdirSync(path).sort() : []);
    const containerDir = join(importDir, "sfu-a");
    return {
      ...result,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      imported: listing(containerDir),
      importModes: existsSync(containerDir)
        ? [mode(importDir), mode(containerDir), ...listing(containerDir).map((name) => mode(join(containerDir, name)))]
        : [],
      stagingModes: existsSync(join(dir, "staging-modes")) ? readFileSync(join(dir, "staging-modes"), "utf8").trim().split("\n") : [],
      volumeEntries: listing(volume),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const callIndex = (calls, pattern) => calls.findIndex((call) => pattern.test(call));
const wrote = (name) => `A ${DATA}/${name}\\n`;

for (const shell of Object.keys(harnesses)) {
  const skip = shell === "pwsh" && !hasPwsh ? "pwsh is not installed; deploy-sfu.ps1 is not exercised here" : false;

  test(`${shell}: stops the old SFU before copying its fallback files, and starts the new one only after`, { skip }, async () => {
    const { status, calls, stderr } = await replaceService(shell, { diff: `C ${DATA}\\n${wrote("scheduling.json")}` });
    assert.equal(status, 0, stderr);
    const stop = callIndex(calls, /^compose .* stop sfu-a$/);
    const copy = callIndex(calls, new RegExp(`^cp ${OLD_CONTAINER}:${DATA}/scheduling\\.json `));
    const start = callIndex(calls, /^compose .* up -d sfu-a$/);
    assert.ok(stop >= 0 && copy > stop && start > copy, calls.join("\n"));
  });

  test(`${shell}: copies into the import folder the SFU image names, not a path of its own`, { skip }, async () => {
    const { status, stderr, imported, volumeEntries } = await replaceService(shell, { diff: wrote("scheduling.json") + wrote("scheduled-webinars.json") });
    assert.equal(status, 0, stderr);
    assert.deepEqual(imported, ["scheduled-webinars.json", "scheduling.json"]);
    assert.deepEqual(volumeEntries, []);
  });

  test(`${shell}: keeps the recovery copies readable only by their owner`, { skip }, async () => {
    const { status, stderr, importModes, stagingModes } = await replaceService(shell, { diff: wrote("scheduling.json") + wrote("scheduled-webinars.json") });
    assert.equal(status, 0, stderr);
    assert.deepEqual(stagingModes, ["drwx------", "-rw-------", "-rw-------"]);
    assert.deepEqual(importModes, ["700", "700", "600", "600"]);
  });

  test(`${shell}: an image that does not name the import folder stops the deploy`, { skip }, async () => {
    const { status, calls, imported, volumeEntries } = await replaceService(shell, { diff: wrote("scheduling.json"), imageImportDir: false });
    assert.notEqual(status, 0);
    assert.equal(callIndex(calls, / up -d /), -1, calls.join("\n"));
    assert.deepEqual([...imported, ...volumeEntries], []);
  });

  test(`${shell}: copies only the fallback files the old SFU wrote`, { skip }, async () => {
    const { status, calls, stderr } = await replaceService(shell, { diff: wrote("scheduled-webinars.json") });
    assert.equal(status, 0, stderr);
    assert.deepEqual(calls.filter((call) => call.startsWith("cp ")).map((call) => call.split(" ")[1]), [
      `${OLD_CONTAINER}:${DATA}/scheduled-webinars.json`,
    ]);
  });

  test(`${shell}: a failed copy stops the deploy before the old SFU is replaced`, { skip }, async () => {
    const { status, calls, stderr } = await replaceService(shell, {
      diff: wrote("scheduling.json") + wrote("scheduled-meetings.json"),
      cpFail: "scheduled-meetings.json",
    });
    assert.notEqual(status, 0);
    assert.equal(callIndex(calls, / up -d /), -1, calls.join("\n"));
    assert.match(stderr, /start sfu-a/);
  });

  test(`${shell}: a failed file listing stops the deploy before the old SFU is replaced`, { skip }, async () => {
    const { status, calls } = await replaceService(shell, { diffStatus: 1 });
    assert.notEqual(status, 0);
    assert.equal(callIndex(calls, / up -d /), -1, calls.join("\n"));
  });

  test(`${shell}: with no old container, starts the new SFU without copying anything`, { skip }, async () => {
    const { status, calls, stderr } = await replaceService(shell, { container: "" });
    assert.equal(status, 0, stderr);
    assert.equal(callIndex(calls, /^(cp|diff) /), -1, calls.join("\n"));
    assert.ok(callIndex(calls, /^compose .* up -d sfu-a$/) >= 0);
  });
}
