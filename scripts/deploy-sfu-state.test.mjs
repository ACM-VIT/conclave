import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const OLD_CONTAINER = "old-sfu-a";
const DATA = "/app/packages/sfu/data";
const MINIMUM_POWERSHELL = [7, 4];

const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
args=("$@")
if [[ "$1" == "compose" ]]; then
  for ((i = 1; i < \${#args[@]}; i++)); do
    case "\${args[i]}" in
      ps) [[ -n "$FAKE_CONTAINER" ]] && echo "$FAKE_CONTAINER"; exit 0 ;;
      run)
        script="" rest=()
        for ((j = i + 1; j < \${#args[@]}; j++)); do
          case "\${args[j]}" in
            -c) script="\${args[j + 1]}"; rest=("\${args[@]:j + 2}"); break ;;
          esac
        done
        [[ -n "$script" ]] || exit 0
        if [[ -s "$STAGING_PATH_FILE" ]]; then
          staging="$(cat "$STAGING_PATH_FILE")"
          ls -ld "$staging" | cut -c1-10 >> "$STAGING_MODES"
          for file in "$staging"/*; do ls -l "$file" | cut -c1-10 >> "$STAGING_MODES"; done
        fi
        script="\${script//\\/var\\/lib\\/conclave\\/recordings/$FAKE_VOLUME}"
        if [[ -n "$FAKE_CORRUPT" ]]; then
          LC_ALL=C tr 'A' 'B' | CONCLAVE_FALLBACK_IMPORT_DIR="$FAKE_IMAGE_IMPORT_DIR" sh -c "$script" "\${rest[@]}"
          exit $?
        fi
        CONCLAVE_FALLBACK_IMPORT_DIR="$FAKE_IMAGE_IMPORT_DIR" exec sh -c "$script" "\${rest[@]}" ;;
      stop) : > "$FAKE_STOPPED"; exit 0 ;;
      build|up|start) exit 0 ;;
    esac
  done
  exit 0
fi
case "$1" in
  inspect)
    if [[ "$*" == *WorkingDir* ]]; then printf '%s\n' "\${FAKE_WORKDIR-/app/packages/sfu}"; exit 0; fi
    if [[ "$*" == *Config.Env* ]]; then printf '%b' "$FAKE_ENV"; exit 0; fi
    exit 0 ;;
  diff) printf '%b' "$FAKE_DIFF"; exit "\${FAKE_DIFF_STATUS:-0}" ;;
  cp)
    name="\${2##*/}"
    failing="$FAKE_CP_FAIL"
    [[ -f "$FAKE_STOPPED" ]] && failing="$failing $FAKE_CP_FAIL_AFTER_STOP"
    if [[ " $failing " == *" $name "* ]]; then echo "Error response from daemon: copy failed" >&2; exit 1; fi
    printf '%s' "\${3%/*}" > "$STAGING_PATH_FILE"
    source="$FAKE_FILES/$name"
    [[ -f "$FAKE_STOPPED" && -f "$FAKE_FILES_AFTER_STOP/$name" ]] && source="$FAKE_FILES_AFTER_STOP/$name"
    if [[ -f "$source" ]]; then cat "$source" > "$3"; else echo '[]' > "$3"; fi
    exit 0 ;;
esac
exit 0
`;

const FAKE_CHOWN = `#!/bin/sh
printf 'chown %s\\n' "$*" >> "$DOCKER_LOG"
exit 0
`;

const SHA256SUM_SHIM = `#!/bin/sh
exec shasum -a 256 "$@"
`;

const allDefinitions = (source, pattern) => source.match(pattern)?.join("\n") ?? "";
const deployShell = readFileSync(join(scriptsDir, "deploy-sfu.sh"), "utf8");
const deployPowerShell = readFileSync(join(scriptsDir, "deploy-sfu.ps1"), "utf8");
const shellFunctions = /^[A-Za-z_][A-Za-z0-9_]*\(\) [{(]\n[\s\S]*?^[})]\n/gm;
const powerShellFunctions = /^function [A-Za-z-]+ \{\n[\s\S]*?^\}\n/gm;

const versionOf = (binary) => {
  const probe = spawnSync(binary, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : null;
};

const atLeast = (version, [major, minor]) => {
  const [actualMajor, actualMinor] = version.split(".").map(Number);
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
};

const powerShells = (process.env.CONCLAVE_PWSH_BINARIES ?? "pwsh")
  .split(",")
  .map((binary) => binary.trim())
  .filter(Boolean)
  .map((binary) => ({ binary, version: versionOf(binary) }))
  .filter((shell) => shell.version);

const harnesses = [
  {
    name: "bash",
    deploys: true,
    command: "bash",
    args: [],
    file: "harness.sh",
    source: () =>
      [
        "set -euo pipefail",
        "COMPOSE=(docker compose -f docker-compose.sfu.yml)",
        allDefinitions(deployShell, shellFunctions),
        `if [[ -n "\${FIXED_STAMP:-}" ]]; then archive_stamp() { printf '%s' "$FIXED_STAMP"; }; fi`,
        'build_and_start sfu-a "$SFU_HEALTH_URL"',
      ].join("\n"),
  },
  ...powerShells.map(({ binary, version }) => ({
    name: `pwsh ${version}`,
    deploys: atLeast(version, MINIMUM_POWERSHELL),
    command: binary,
    args: ["-NoProfile", "-NonInteractive", "-File"],
    file: "harness.ps1",
    source: () =>
      [
        "Set-StrictMode -Version Latest",
        '$ErrorActionPreference = "Stop"',
        '$composeBaseArgs = @("compose", "-f", "docker-compose.sfu.yml")',
        allDefinitions(deployPowerShell, powerShellFunctions),
        "if ($env:FIXED_STAMP) { function Get-ArchiveStamp { return $env:FIXED_STAMP } }",
        "Start-SfuService -Service sfu-a -Url $env:SFU_HEALTH_URL",
      ].join("\n"),
  })),
];

const hostHasSha256sum = spawnSync("sh", ["-c", "command -v sha256sum"]).status === 0;

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

const writeFiles = (dir, files) => {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
};

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

const healthAnswers = {
  deployed: (service, deployId) => [200, { status: "healthy", instanceId: service, deployId, workers: { healthy: 1 } }],
  unavailable: (service, deployId) => [503, { status: "unhealthy", instanceId: service, deployId, workers: { healthy: 0 } }],
  "an earlier deploy": (service) => [200, { status: "healthy", instanceId: service, deployId: "sfu-an-earlier-deploy", workers: { healthy: 1 } }],
  "another SFU": (_service, deployId) => [200, { status: "healthy", instanceId: "sfu-z", deployId, workers: { healthy: 1 } }],
  "an older image": () => [200, { status: "healthy", workers: { healthy: 1 } }],
};

const listArchives = (serviceDir) =>
  (existsSync(serviceDir) ? readdirSync(serviceDir).sort() : []).map((name) => {
    const path = join(serviceDir, name);
    const files = readdirSync(path).sort();
    return { name, files, bytes: Object.fromEntries(files.map((file) => [file, readFileSync(join(path, file))])), modes: [mode(path), ...files.map((file) => mode(join(path, file)))] };
  });

const replaceService = async (
  harness,
  {
    health = "deployed",
    deployId = "sfu-test-deploy",
    fixedStamp = "",
    sharedImportDir = "",
    container = OLD_CONTAINER,
    diff = "",
    diffStatus = 0,
    cpFail = "",
    cpFailAfterStop = "",
    imageImportDir = true,
    files = {},
    filesAfterStop = {},
    corrupt = false,
    containerEnv = "",
    workdir = "/app/packages/sfu",
  } = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-sfu-state-"));
  const healthServer = createServer((req, res) => {
    const [code, body] = healthAnswers[health]("sfu-a", deployId);
    res.writeHead(req.url === "/health" ? code : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const healthUrl = await listen(healthServer);
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(dir, "tmp"));
    writeFileSync(join(bin, "docker"), FAKE_DOCKER);
    writeFileSync(join(bin, "chown"), FAKE_CHOWN);
    if (!hostHasSha256sum) writeFileSync(join(bin, "sha256sum"), SHA256SUM_SHIM);
    for (const name of readdirSync(bin)) chmodSync(join(bin, name), 0o755);
    writeFiles(join(dir, "files"), files);
    writeFiles(join(dir, "files-after-stop"), filesAfterStop);
    const log = join(dir, "docker.log");
    writeFileSync(log, "");
    const volume = join(dir, "volume");
    const importDir = sharedImportDir || join(dir, "image-import-dir");
    mkdirSync(volume);
    writeFileSync(join(dir, harness.file), harness.source());
    const result = await run(harness.command, [...harness.args, join(dir, harness.file)], {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      TMPDIR: join(dir, "tmp"),
      DOCKER_LOG: log,
      FAKE_CONTAINER: container,
      FAKE_DIFF: diff,
      FAKE_ENV: containerEnv,
      FAKE_WORKDIR: workdir,
      FAKE_DIFF_STATUS: String(diffStatus),
      FAKE_CP_FAIL: cpFail,
      FAKE_CP_FAIL_AFTER_STOP: cpFailAfterStop,
      FAKE_FILES: join(dir, "files"),
      FAKE_FILES_AFTER_STOP: join(dir, "files-after-stop"),
      FAKE_STOPPED: join(dir, "stopped"),
      FAKE_CORRUPT: corrupt ? "1" : "",
      FAKE_VOLUME: volume,
      FAKE_IMAGE_IMPORT_DIR: imageImportDir ? importDir : "",
      STAGING_PATH_FILE: join(dir, "staging-path"),
      STAGING_MODES: join(dir, "staging-modes"),
      SFU_HEALTH_URL: healthUrl,
      SFU_DEPLOY_ID: deployId,
      SFU_HEALTH_TIMEOUT_SECONDS: "3",
      SFU_HEALTH_POLL_SECONDS: "1",
      FIXED_STAMP: fixedStamp,
    });
    const listing = (path) => (existsSync(path) ? readdirSync(path).sort() : []);
    const containerDir = join(importDir, "sfu-a");
    const archives = listArchives(containerDir);
    const latest = archives.at(-1);
    return {
      ...result,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      archives,
      imported: latest?.files ?? [],
      importedBytes: (name) => latest?.bytes[name] ?? Buffer.alloc(0),
      importModes: latest ? [mode(importDir), mode(containerDir), ...latest.modes] : [],
      importLeftovers: listing(importDir).filter((name) => name !== "sfu-a"),
      stagingModes: existsSync(join(dir, "staging-modes")) ? readFileSync(join(dir, "staging-modes"), "utf8").trim().split("\n") : [],
      volumeEntries: listing(volume),
    };
  } finally {
    await close(healthServer);
    rmSync(dir, { recursive: true, force: true });
  }
};

const callIndex = (calls, pattern) => calls.findIndex((call) => pattern.test(call));
const receives = (calls) => calls.filter((call) => /^compose .* run .*--entrypoint sh sfu-a -c /.test(call));
const stopped = (calls) => callIndex(calls, /^compose .* stop sfu-a$/) >= 0;
const wrote = (name) => `A ${DATA}/${name}\\n`;

const BINARY = Buffer.concat([
  Buffer.from('{"id":"A","note":"'),
  Buffer.from(Array.from({ length: 512 }, (_, index) => index % 256)),
  Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0xfe, 0x0d, 0x0a, 0x0a, 0x0d, 0xc3, 0x28, 0xa0, 0xa1]),
  Buffer.from('"}\r\n'),
]);

for (const { binary, version } of powerShells) {
  test(`pwsh ${version}: the transfer helper hands a file to a command byte for byte`, () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-sfu-transfer-"));
    try {
      const helper = deployPowerShell.match(/^function Send-FileToCommand \{\n[\s\S]*?^\}\n/m)?.[0];
      assert.ok(helper, "deploy-sfu.ps1 defines Send-FileToCommand");
      writeFileSync(join(dir, "payload.bin"), BINARY);
      writeFileSync(
        join(dir, "send.ps1"),
        [
          "param([string]$Source, [string]$Target)",
          helper,
          '$code = Send-FileToCommand -Path $Source -Command "sh" -Arguments @("-c", \'cat > "$1"\', "sh", $Target)',
          "exit $code",
        ].join("\n"),
      );
      const sent = spawnSync(binary, ["-NoProfile", "-NonInteractive", "-File", join(dir, "send.ps1"), join(dir, "payload.bin"), join(dir, "received.bin")], { encoding: "utf8" });
      assert.equal(sent.status, 0, sent.stderr);
      assert.ok(readFileSync(join(dir, "received.bin")).equals(BINARY), "the payload changed in transit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const harness of harnesses) {
  const shell = harness.name;

  test(`${shell}: never stops the old SFU unless its fallback files arrived byte for byte`, async () => {
    const files = { "scheduling.json": BINARY, "scheduled-meetings.json": Buffer.from("[]\n") };
    const { status, calls, stderr, imported, importedBytes } = await replaceService(harness, {
      diff: wrote("scheduling.json") + wrote("scheduled-meetings.json"),
      files,
    });
    if (status === 0) {
      assert.deepEqual(imported, ["scheduled-meetings.json", "scheduling.json"]);
      for (const [name, content] of Object.entries(files)) assert.ok(importedBytes(name).equals(content), `${name} changed in transit`);
    } else {
      assert.equal(stopped(calls), false, `stopped the old SFU and then failed:\n${stderr}`);
    }
  });

  if (!harness.deploys) {
    test(`${shell}: refuses to run before touching Docker`, async () => {
      const { status, calls, stderr } = await replaceService(harness, { diff: wrote("scheduling.json") });
      assert.notEqual(status, 0);
      assert.deepEqual(calls, []);
      assert.match(stderr, /PowerShell 7\.4/);
    });
    continue;
  }

  test(`${shell}: copies and verifies the old SFU's fallback files before stopping it, and starts the new one only after`, async () => {
    const { status, calls, stderr } = await replaceService(harness, { diff: `C ${DATA}\\n${wrote("scheduling.json")}` });
    assert.equal(status, 0, stderr);
    const copy = callIndex(calls, new RegExp(`^cp ${OLD_CONTAINER}:${DATA}/scheduling\\.json `));
    const receive = calls.indexOf(receives(calls)[0]);
    const stop = callIndex(calls, /^compose .* stop sfu-a$/);
    const start = callIndex(calls, /^compose .* up -d sfu-a$/);
    assert.ok(copy >= 0 && receive > copy && stop > receive && start > stop, calls.join("\n"));
  });

  test(`${shell}: after the stop, sends the files again only when one changed`, async () => {
    const unchanged = await replaceService(harness, { diff: wrote("scheduling.json"), files: { "scheduling.json": "[1]" } });
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(receives(unchanged.calls).length, 1, unchanged.calls.join("\n"));

    const changed = await replaceService(harness, {
      diff: wrote("scheduling.json"),
      files: { "scheduling.json": "[1]" },
      filesAfterStop: { "scheduling.json": "[1,2]" },
    });
    assert.equal(changed.status, 0, changed.stderr);
    const sends = receives(changed.calls).map((call) => changed.calls.indexOf(call));
    assert.equal(sends.length, 2, changed.calls.join("\n"));
    assert.ok(sends[1] > callIndex(changed.calls, /^compose .* stop sfu-a$/), changed.calls.join("\n"));
    assert.deepEqual(changed.archives.map((archive) => archive.bytes["scheduling.json"].toString()), ["[1]", "[1,2]"]);
  });

  test(`${shell}: a later deploy keeps the copy an earlier deploy saved`, async () => {
    const shared = mkdtempSync(join(tmpdir(), "deploy-sfu-import-"));
    try {
      const first = await replaceService(harness, { sharedImportDir: shared, deployId: "sfu-first-deploy", diff: wrote("scheduling.json"), files: { "scheduling.json": '["first"]' } });
      assert.equal(first.status, 0, first.stderr);
      const second = await replaceService(harness, { sharedImportDir: shared, deployId: "sfu-second-deploy", diff: wrote("scheduling.json"), files: { "scheduling.json": '["second"]' } });
      assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(second.archives.map((archive) => archive.bytes["scheduling.json"].toString()), ['["first"]', '["second"]']);
      assert.match(second.archives[0].name, /^\d{8}T\d{9}Z-sfu-first-deploy$/);
      assert.match(second.archives[1].name, /^\d{8}T\d{9}Z-sfu-second-deploy$/);
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });

  test(`${shell}: never replaces a saved copy, and stops before anything is stopped`, async () => {
    const shared = mkdtempSync(join(tmpdir(), "deploy-sfu-import-"));
    try {
      const options = { sharedImportDir: shared, fixedStamp: "20261124T000000000Z", diff: wrote("scheduling.json") };
      const first = await replaceService(harness, { ...options, files: { "scheduling.json": '["first"]' } });
      assert.equal(first.status, 0, first.stderr);
      const second = await replaceService(harness, { ...options, files: { "scheduling.json": '["second"]' } });
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /never replaced/);
      assert.equal(stopped(second.calls), false, second.calls.join("\n"));
      assert.deepEqual(second.archives.map((archive) => archive.bytes["scheduling.json"].toString()), ['["first"]']);
      assert.deepEqual(second.importLeftovers, []);
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });

  test(`${shell}: stops a replacement that never answers healthy as this deploy`, async () => {
    for (const health of ["unavailable", "an earlier deploy", "another SFU", "an older image"]) {
      const { status, calls, stderr } = await replaceService(harness, { health });
      assert.notEqual(status, 0, `${health} was accepted`);
      const start = callIndex(calls, /^compose .* up -d sfu-a$/);
      const stop = calls.findLastIndex((call) => /^compose .* stop sfu-a$/.test(call));
      assert.ok(start >= 0 && stop > start, `${health}\n${calls.join("\n")}`);
      assert.match(stderr, /did not answer healthy/, health);
    }
  });

  test(`${shell}: a payload that arrives changed stops the deploy before anything is stopped`, async () => {
    const { status, calls, imported } = await replaceService(harness, {
      diff: wrote("scheduling.json"),
      files: { "scheduling.json": "[\"AAAA\"]" },
      corrupt: true,
    });
    assert.notEqual(status, 0);
    assert.equal(stopped(calls), false, calls.join("\n"));
    assert.equal(callIndex(calls, / up -d /), -1, calls.join("\n"));
    assert.deepEqual(imported, []);
  });

  test(`${shell}: copies into the import folder the SFU image names, not a path of its own`, async () => {
    const { status, stderr, imported, volumeEntries, importLeftovers } = await replaceService(harness, {
      diff: wrote("scheduling.json") + wrote("scheduled-webinars.json"),
    });
    assert.equal(status, 0, stderr);
    assert.deepEqual(imported, ["scheduled-webinars.json", "scheduling.json"]);
    assert.deepEqual(volumeEntries, []);
    assert.deepEqual(importLeftovers, []);
  });

  test(`${shell}: keeps the recovery copies readable only by their owner`, async () => {
    const { status, stderr, importModes, stagingModes, calls } = await replaceService(harness, {
      diff: wrote("scheduling.json") + wrote("scheduled-webinars.json"),
    });
    assert.equal(status, 0, stderr);
    assert.equal(stagingModes[0], "drwx------");
    assert.ok(stagingModes.slice(1).every((entry) => entry === "-rw-------"), stagingModes.join("\n"));
    assert.deepEqual(importModes, ["700", "700", "700", "600", "600"]);
    assert.ok(callIndex(calls, /^chown -R node:node /) >= 0, calls.join("\n"));
  });

  test(`${shell}: an image that does not name the import folder stops the deploy before anything is stopped`, async () => {
    const { status, calls, imported, volumeEntries } = await replaceService(harness, { diff: wrote("scheduling.json"), imageImportDir: false });
    assert.notEqual(status, 0);
    assert.equal(stopped(calls), false, calls.join("\n"));
    assert.equal(callIndex(calls, / up -d /), -1, calls.join("\n"));
    assert.deepEqual([...imported, ...volumeEntries], []);
  });

  test(`${shell}: copies only the fallback files the old SFU wrote`, async () => {
    const { status, calls, stderr } = await replaceService(harness, { diff: wrote("scheduled-webinars.json") });
    assert.equal(status, 0, stderr);
    assert.deepEqual([...new Set(calls.filter((call) => call.startsWith("cp ")).map((call) => call.split(" ")[1]))], [
      `${OLD_CONTAINER}:${DATA}/scheduled-webinars.json`,
    ]);
  });

  test(`${shell}: a failed copy stops the deploy before anything is stopped`, async () => {
    const { status, calls } = await replaceService(harness, {
      diff: wrote("scheduling.json") + wrote("scheduled-meetings.json"),
      cpFail: "scheduled-meetings.json",
    });
    assert.notEqual(status, 0);
    assert.equal(stopped(calls), false, calls.join("\n"));
    assert.equal(callIndex(calls, / up -d /), -1, calls.join("\n"));
  });

  test(`${shell}: a failed file listing stops the deploy before anything is stopped`, async () => {
    const { status, calls } = await replaceService(harness, { diffStatus: 1 });
    assert.notEqual(status, 0);
    assert.equal(stopped(calls), false, calls.join("\n"));
    assert.equal(callIndex(calls, / up -d /), -1, calls.join("\n"));
  });

  test(`${shell}: a copy that fails after the stop leaves the new SFU unstarted and says how to restart the old one`, async () => {
    const { status, calls, stderr } = await replaceService(harness, { diff: wrote("scheduling.json"), cpFailAfterStop: "scheduling.json" });
    assert.notEqual(status, 0);
    assert.equal(callIndex(calls, / up -d /), -1, calls.join("\n"));
    assert.match(stderr, /start sfu-a/);
  });

  test(`${shell}: copies each store from the path the old container was configured with`, async () => {
    const { status, calls, stderr, imported, importedBytes } = await replaceService(harness, {
      containerEnv: "SCHEDULED_MEETINGS_PATH=/srv/conclave/meetings.json\\nSCHEDULING_PATH= ./state//scheduling.json \\nSCHEDULED_WEBINARS_PATH=../shared/webinars.json\\n",
      diff:
        "A /srv/conclave/meetings.json\\nA /app/packages/sfu/state/scheduling.json\\nA /app/packages/shared/webinars.json\\n" +
        wrote("scheduled-meetings.json"),
      files: { "meetings.json": "[\"configured\"]", "scheduled-meetings.json": "[\"default\"]" },
    });
    assert.equal(status, 0, stderr);
    const sources = [...new Set(calls.filter((call) => call.startsWith("cp ")).map((call) => call.split(" ")[1]))].sort();
    assert.deepEqual(sources, [
      `${OLD_CONTAINER}:/app/packages/sfu/state/scheduling.json`,
      `${OLD_CONTAINER}:/app/packages/shared/webinars.json`,
      `${OLD_CONTAINER}:/srv/conclave/meetings.json`,
    ]);
    assert.deepEqual(imported, ["scheduled-meetings.json", "scheduled-webinars.json", "scheduling.json"]);
    assert.equal(importedBytes("scheduled-meetings.json").toString(), "[\"configured\"]");
  });

  test(`${shell}: with no old container, starts the new SFU without copying anything`, async () => {
    const { status, calls, stderr } = await replaceService(harness, { container: "" });
    assert.equal(status, 0, stderr);
    assert.equal(callIndex(calls, /^(cp|diff) /), -1, calls.join("\n"));
    assert.ok(callIndex(calls, /^compose .* up -d sfu-a$/) >= 0);
  });
}

const FLOW_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
service="\${@: -1}"
if [[ "$1" == "compose" ]]; then
  case " $* " in
    *" config --services "*) printf 'sfu-a\\nsfu-b\\n'; exit 0 ;;
    *" config --format json "*) echo '{}'; exit 0 ;;
    *" up -d "*) printf '%s' "$SFU_DEPLOY_ID" > "$FAKE_STATE/$service.up"; exit 0 ;;
    *" stop "*) rm -f "$FAKE_STATE/$service.up"; exit 0 ;;
  esac
fi
exit 0
`;

const fakeSfu = (service, { rooms, replacement, state, log }) => {
  let draining = false;
  let active = rooms;
  return createServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/drain") {
      draining = true;
      active = 0;
      appendFileSync(log, `drain ${service}\n`);
      req.resume();
      return reply(200, { draining: true });
    }
    if (req.url === "/status") return reply(200, { instanceId: service, rooms: active, draining, healthy: true });
    if (req.url === "/health") {
      const upFile = join(state, `${service}.up`);
      if (!existsSync(upFile)) return reply(200, { status: "healthy", workers: { healthy: 1 } });
      const [code, body] = healthAnswers[replacement](service, readFileSync(upFile, "utf8"));
      return reply(code, body);
    }
    return reply(404, {});
  });
};

const deployShells = [
  { name: "bash", script: "deploy-sfu.sh", command: "bash", args: [] },
  ...powerShells
    .filter(({ version }) => atLeast(version, MINIMUM_POWERSHELL))
    .map(({ binary, version }) => ({ name: `pwsh ${version}`, script: "deploy-sfu.ps1", command: binary, args: ["-NoProfile", "-NonInteractive", "-File"] })),
];

const deploySfus = async (shell, replacements) => {
  const root = mkdtempSync(join(tmpdir(), "deploy-sfu-flow-"));
  const state = join(root, "state");
  const log = join(root, "deploy.log");
  mkdirSync(state);
  writeFileSync(log, "");
  const servers = {
    "sfu-a": fakeSfu("sfu-a", { rooms: 1, replacement: replacements["sfu-a"], state, log }),
    "sfu-b": fakeSfu("sfu-b", { rooms: 0, replacement: replacements["sfu-b"], state, log }),
  };
  const urls = { "sfu-a": await listen(servers["sfu-a"]), "sfu-b": await listen(servers["sfu-b"]) };
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, "scripts"));
    copyFileSync(join(scriptsDir, shell.script), join(root, "scripts", shell.script));
    writeFileSync(join(root, "scripts", "deploy-sfu-preflight.mjs"), "process.stdin.resume();\n");
    writeFileSync(join(root, ".env"), "SFU_SECRET=test-secret\nREDIS_URL=redis://127.0.0.1:6399\n");
    writeFileSync(join(root, "docker-compose.sfu.yml"), "services: {}\n");
    writeFileSync(join(bin, "docker"), FLOW_DOCKER);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
    for (const name of readdirSync(bin)) chmodSync(join(bin, name), 0o755);
    const result = await run(shell.command, [...shell.args, join(root, "scripts", shell.script)], {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      TMPDIR: tmpdir(),
      DOCKER_LOG: log,
      FAKE_STATE: state,
      SFU_A_URL: urls["sfu-a"],
      SFU_B_URL: urls["sfu-b"],
      SFU_HEALTH_TIMEOUT_SECONDS: "3",
      SFU_HEALTH_POLL_SECONDS: "1",
      DRAIN_POLL_SECONDS: "1",
    });
    return { ...result, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  } finally {
    await Promise.all(Object.values(servers).map(close));
    rmSync(root, { recursive: true, force: true });
  }
};

for (const shell of deployShells) {
  test(`${shell.name}: drains the serving SFU only after its replacement answers healthy as this deploy`, async () => {
    const { status, calls, stdout, stderr } = await deploySfus(shell, { "sfu-a": "deployed", "sfu-b": "deployed" });
    assert.equal(status, 0, `${stdout}\n${stderr}`);
    const started = callIndex(calls, /^compose .* up -d sfu-b$/);
    const drained = calls.indexOf("drain sfu-a");
    const replaced = callIndex(calls, /^compose .* up -d sfu-a$/);
    assert.ok(started >= 0 && drained > started && replaced > drained, calls.join("\n"));
    assert.match(stdout, /SFU deploy complete/);
  });

  test(`${shell.name}: a replacement that answers 503 is stopped, the serving SFU is never drained, and the deploy fails`, async () => {
    const { status, calls, stdout, stderr } = await deploySfus(shell, { "sfu-a": "deployed", "sfu-b": "unavailable" });
    assert.notEqual(status, 0, stdout);
    assert.equal(calls.indexOf("drain sfu-a"), -1, calls.join("\n"));
    const started = callIndex(calls, /^compose .* up -d sfu-b$/);
    const stoppedReplacement = calls.findLastIndex((call) => /^compose .* stop sfu-b$/.test(call));
    assert.ok(started >= 0 && stoppedReplacement > started, calls.join("\n"));
    assert.equal(callIndex(calls, /^compose .* (build|stop|up -d) sfu-a$/), -1, calls.join("\n"));
    assert.doesNotMatch(stdout, /SFU deploy complete/);
    assert.match(stderr, /sfu-b did not answer healthy/);
  });

  test(`${shell.name}: a second replacement that never answers healthy is stopped and the deploy fails`, async () => {
    const { status, calls, stdout, stderr } = await deploySfus(shell, { "sfu-a": "unavailable", "sfu-b": "deployed" });
    assert.notEqual(status, 0, stdout);
    const started = callIndex(calls, /^compose .* up -d sfu-a$/);
    const stoppedReplacement = calls.findLastIndex((call) => /^compose .* stop sfu-a$/.test(call));
    assert.ok(started > calls.indexOf("drain sfu-a") && stoppedReplacement > started, calls.join("\n"));
    assert.equal(callIndex(calls.slice(callIndex(calls, /^compose .* up -d sfu-b$/) + 1), /^compose .* stop sfu-b$/), -1, calls.join("\n"));
    assert.doesNotMatch(stdout, /SFU deploy complete/);
    assert.match(stderr, /sfu-a did not answer healthy/);
  });
}
