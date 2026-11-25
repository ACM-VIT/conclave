import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";

const registered = [];
const test = (name, body) => registered.push({ name, body });
const SUITE = "SFU deploy state";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const sfuDir = fileURLToPath(new URL("../packages/sfu/", import.meta.url));
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
        script="\${script//\\$\\$/1}"
        [[ -n "$FAKE_FAIL_UNPACK" ]] && script="\${script//tar -xf /tar -xf \/dev\/null\/unpack-fails }"
        if [[ "$FAKE_KILL_AT_PUBLISH" == before ]]; then
          script="$(printf '%s' "$script" | perl -pe 's/(?:mv|ln) "\\$incoming\\/db" "\\$target"/kill -KILL \\$\\$/')"
        elif [[ "$FAKE_KILL_AT_PUBLISH" == after ]]; then
          script='publish_then_die() { "$@"; kill -KILL $$; }; '"$(printf '%s' "$script" | perl -pe 's/((?:mv|ln) "\\$incoming\\/db)/publish_then_die $1/')"
        fi
        cd "$FAKE_SFU_DIR" || exit 1
        export CONCLAVE_SQLITE_PATH="\${FAKE_NEW_SQLITE_PATH:-$FAKE_VOLUME/conclave.sqlite}"
        [[ "$script" == *payload.tar* ]] || exec sh -c "$script" "\${rest[@]}"
        if [[ "$script" == *"layerDatabase.ts consolidate"* && -n "$FAKE_LINK_FROM" ]]; then
          rm -rf "$FAKE_LINK_FROM" && ln -s "$FAKE_LINK_TO" "$FAKE_LINK_FROM"
        fi
        if [[ -z "$FAKE_KILL_TRANSFER$FAKE_CORRUPT" ]]; then
          payload="$PAYLOAD_DIR/$(ls "$PAYLOAD_DIR" | wc -l | tr -d ' ').tar"
          cat > "$payload"
          CONCLAVE_FALLBACK_IMPORT_DIR="$FAKE_IMAGE_IMPORT_DIR" sh -c "$script" "\${rest[@]}" < "$payload"
          code=$?
          [[ $code == 0 && "$script" == *"layerDatabase.ts consolidate"* ]] && : > "$FAKE_CARRIED"
          exit $code
        fi
        if [[ -n "$FAKE_KILL_TRANSFER" ]]; then
          fifo="$(dirname "$DOCKER_LOG")/transfer.fifo"
          mkfifo "$fifo"
          CONCLAVE_FALLBACK_IMPORT_DIR="$FAKE_IMAGE_IMPORT_DIR" sh -c "$script" "\${rest[@]}" < "$fifo" &
          receiver=$!
          exec 3> "$fifo"
          printf 'partial' >&3
          observed=""
          for _ in $(seq 1 400); do
            for received in "$FAKE_IMAGE_IMPORT_DIR"/.incoming-*/payload.tar; do
              if [[ -f "$received" && $(wc -c < "$received") -ge 7 ]] && grep -qF "/.incoming-" "$OWNERSHIP_LOG" 2>/dev/null; then observed="$received"; fi
            done
            [[ -n "$observed" ]] && break
            sleep 0.05
          done
          [[ -n "$observed" ]] || { echo "the receiver never took ownership of its staging folder and part of the payload" >&2; kill -9 "$receiver"; exit 99; }
          kill -9 "$receiver"
          wait "$receiver" 2>/dev/null
          exec 3>&-
          rm -f "$fifo"
          exit 137
        fi
        if [[ -n "$FAKE_CORRUPT" ]]; then
          received="$(dirname "$DOCKER_LOG")/received.tar"
          cat > "$received"
          before="$(sha256sum "$received" | cut -d' ' -f1)"
          node -e 'const fs = require("fs"); const [path, marker] = process.argv.slice(1); const bytes = fs.readFileSync(path); const at = bytes.indexOf(marker); if (at < 0) process.exit(3); bytes[at] ^= 0x20; fs.writeFileSync(path, bytes);' "$received" "$FAKE_CORRUPT" &&
          printf '%s %s\\n' "$before" "$(sha256sum "$received" | cut -d' ' -f1)" >> "$CORRUPTION_LOG"
          CONCLAVE_FALLBACK_IMPORT_DIR="$FAKE_IMAGE_IMPORT_DIR" sh -c "$script" "\${rest[@]}" < "$received"
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
    if [[ "$*" == *State.StartedAt* ]]; then
      if [[ -f "$FAKE_CARRIED" && -n "$FAKE_STARTED_AFTER_CARRY" ]]; then printf '%s\n' "$FAKE_STARTED_AFTER_CARRY"
      elif [[ -f "$FAKE_STOPPED" && -n "$FAKE_STARTED_AFTER_STOP" ]]; then printf '%s\n' "$FAKE_STARTED_AFTER_STOP"
      else printf '%s\n' "$FAKE_STARTED_AT"; fi
      exit 0
    fi
    if [[ "$*" == *State.Running* ]]; then
      if [[ -f "$FAKE_STOPPED" ]]; then echo "\${FAKE_RUNNING_AFTER_STOP:-false}"; else echo "\${FAKE_RUNNING:-false}"; fi
      exit 0
    fi
    exit 0 ;;
  diff)
    if [[ -f "$FAKE_STOPPED" && -n "$FAKE_DIFF_AFTER_STOP" ]]; then printf '%b' "$FAKE_DIFF_AFTER_STOP"; else printf '%b' "$FAKE_DIFF"; fi
    exit "\${FAKE_DIFF_STATUS:-0}" ;;
  cp)
    name="\${2##*/}"
    failing="$FAKE_CP_FAIL"
    [[ -f "$FAKE_STOPPED" ]] && failing="$failing $FAKE_CP_FAIL_AFTER_STOP"
    if [[ " $failing " == *" $name "* ]]; then echo "Error response from daemon: copy failed" >&2; exit 1; fi
    printf '%s' "\${3%/*}" > "$STAGING_PATH_FILE"
    source="$FAKE_FILES/$name"
    [[ -f "$FAKE_STOPPED" && -f "$FAKE_FILES_AFTER_STOP/$name" ]] && source="$FAKE_FILES_AFTER_STOP/$name"
    if [[ -f "$source" ]]; then cat "$source" > "$3"; else echo '[]' > "$3"; fi
    command -v xattr > /dev/null && xattr -w com.apple.provenance fake-docker-cp "$3" 2> /dev/null
    exit 0 ;;
esac
exit 0
`;

const FAKE_CHOWN = `#!/bin/sh
printf 'chown %s\\n' "$*" >> "$DOCKER_LOG"
scope=one
[ "$1" = "-R" ] && { scope=tree; shift; }
owner="$1"
shift
for path in "$@"; do
  printf '%s %s %s\\n' "$owner" "$scope" "$(cd "$(dirname "$path")" && pwd -P)/$(basename "$path")" >> "$OWNERSHIP_LOG"
done
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

const directoriesUnder = (root) =>
  existsSync(root)
    ? [root, ...readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => directoriesUnder(join(root, entry.name)))]
    : [];

const strayDirectories = (root, ownershipLog) => {
  const grants = existsSync(ownershipLog)
    ? readFileSync(ownershipLog, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split(" "))
    : [];
  const ownedByNode = (path) =>
    grants.some(([owner, scope, granted]) => owner === "node:node" && (granted === path || (scope === "tree" && path.startsWith(`${granted}/`))));
  return directoriesUnder(root)
    .map((path) => realpathSync(path))
    .filter((path) => !ownedByNode(path) || mode(path) !== "700")
    .map((path) => `${path.slice(realpathSync(root).length) || "/"} (mode ${mode(path)})`);
};

const listArchives = (serviceDir) =>
  (existsSync(serviceDir) ? readdirSync(serviceDir).sort() : []).map((name) => {
    const path = join(serviceDir, name);
    const files = readdirSync(path).sort();
    return { name, files, bytes: Object.fromEntries(files.map((file) => [file, readFileSync(join(path, file))])), modes: [mode(path), ...files.map((file) => mode(join(path, file)))] };
  });

const WRITE_DATABASE = `const { DatabaseSync } = require("node:sqlite");
const [path, mode, ids] = process.argv.slice(1);
const db = new DatabaseSync(path);
db.exec(mode === "wal" ? "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0" : "PRAGMA journal_mode = DELETE");
db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY)");
for (const id of JSON.parse(ids)) db.prepare("INSERT INTO meetings (id) VALUES (?)").run(id);
if (mode === "wal") process.kill(process.pid, "SIGKILL");
db.close();`;

const READ_DATABASE = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
process.stdout.write(JSON.stringify(db.prepare("SELECT id FROM meetings ORDER BY id").all().map((row) => row.id)));`;

const sqliteFiles = (name, ids, { mode = "wal" } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-sfu-db-"));
  try {
    const path = join(dir, "source.sqlite");
    spawnSync(process.execPath, ["--no-warnings", "-e", WRITE_DATABASE, path, mode, JSON.stringify(ids)], { stdio: "ignore" });
    const files = Object.fromEntries(["", "-wal"].filter((suffix) => existsSync(`${path}${suffix}`)).map((suffix) => [`${name}${suffix}`, readFileSync(`${path}${suffix}`)]));
    assert.ok(files[name], `the fixture database ${name} was not written`);
    if (mode === "wal") assert.ok(files[`${name}-wal`]?.length > 0, `the fixture ${name} kept no write-ahead log`);
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const databaseRows = (path) => {
  const read = spawnSync(process.execPath, ["--no-warnings", "-e", READ_DATABASE, path], { encoding: "utf8" });
  return read.status === 0 ? JSON.parse(read.stdout) : `unreadable: ${read.stderr.trim().split("\n").at(-1)}`;
};

const tarMembers = (archive) => {
  const names = [];
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(text(124, 12).trim() || "0", 8);
    const type = text(156, 1);
    if (type !== "x" && type !== "g") names.push([text(345, 155), text(0, 100)].filter(Boolean).join("/"));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
};

const replaceService = async (
  harness,
  {
    health = "deployed",
    deployId = "sfu-test-deploy",
    fixedStamp = "",
    sharedImportDir = "",
    killTransfer = false,
    failUnpack = false,
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
    volumeFiles = {},
    newSqlitePath = "",
    sharedVolume = "",
    killAtPublish = "",
    startedAt = "2026-11-25T08:00:00.000000000Z",
    startedAfterStop = "",
    startedAfterCarry = "",
    runningAfterStop = false,
    diffAfterStop = "",
    linkFrom = "",
    linkTo = "",
  } = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-sfu-state-"));
  let healthRequests = 0;
  const healthServer = createServer((req, res) => {
    if (req.url === "/health") healthRequests += 1;
    const [code, body] = healthAnswers[health]("sfu-a", deployId);
    res.writeHead(req.url === "/health" ? code : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const healthUrl = await listen(healthServer);
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(dir, "tmp"));
    mkdirSync(join(dir, "payloads"));
    writeFileSync(join(bin, "docker"), FAKE_DOCKER);
    writeFileSync(join(bin, "chown"), FAKE_CHOWN);
    if (!hostHasSha256sum) writeFileSync(join(bin, "sha256sum"), SHA256SUM_SHIM);
    for (const name of readdirSync(bin)) chmodSync(join(bin, name), 0o755);
    writeFiles(join(dir, "files"), files);
    writeFiles(join(dir, "files-after-stop"), filesAfterStop);
    const log = join(dir, "docker.log");
    writeFileSync(log, "");
    const volume = sharedVolume || join(dir, "volume");
    const importDir = sharedImportDir || join(dir, "image-import-dir");
    writeFiles(volume, volumeFiles);
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
      FAKE_CORRUPT: corrupt ? "kept" : "",
      FAKE_VOLUME: volume,
      FAKE_SFU_DIR: sfuDir,
      PAYLOAD_DIR: join(dir, "payloads"),
      FAKE_NEW_SQLITE_PATH: newSqlitePath,
      FAKE_KILL_AT_PUBLISH: killAtPublish,
      FAKE_STARTED_AT: startedAt,
      FAKE_STARTED_AFTER_STOP: startedAfterStop,
      FAKE_STARTED_AFTER_CARRY: startedAfterCarry,
      FAKE_RUNNING_AFTER_STOP: runningAfterStop ? "true" : "",
      FAKE_DIFF_AFTER_STOP: diffAfterStop,
      FAKE_CARRIED: join(dir, "carried"),
      FAKE_LINK_FROM: linkFrom,
      FAKE_LINK_TO: linkTo,
      FAKE_IMAGE_IMPORT_DIR: imageImportDir ? importDir : "",
      STAGING_PATH_FILE: join(dir, "staging-path"),
      STAGING_MODES: join(dir, "staging-modes"),
      SFU_HEALTH_URL: healthUrl,
      SFU_DEPLOY_ID: deployId,
      SFU_HEALTH_TIMEOUT_SECONDS: "1",
      SFU_HEALTH_POLL_SECONDS: "1",
      FIXED_STAMP: fixedStamp,
      FAKE_KILL_TRANSFER: killTransfer ? "1" : "",
      FAKE_FAIL_UNPACK: failUnpack ? "1" : "",
      OWNERSHIP_LOG: join(dir, "ownership.log"),
      CORRUPTION_LOG: join(dir, "corruption.log"),
    });
    const listing = (path) => (existsSync(path) ? readdirSync(path).sort() : []);
    const containerDir = join(importDir, "sfu-a");
    const archives = listArchives(containerDir);
    const latest = archives.at(-1);
    return {
      ...result,
      healthRequests,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      archives,
      imported: latest?.files ?? [],
      importedBytes: (name) => latest?.bytes[name] ?? Buffer.alloc(0),
      importModes: latest ? [mode(importDir), mode(containerDir), ...latest.modes] : [],
      importLeftovers: listing(importDir).filter((name) => name !== "sfu-a"),
      strays: strayDirectories(importDir, join(dir, "ownership.log")),
      corruptions: existsSync(join(dir, "corruption.log"))
        ? readFileSync(join(dir, "corruption.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => line.split(" "))
        : [],
      stagingModes: existsSync(join(dir, "staging-modes")) ? readFileSync(join(dir, "staging-modes"), "utf8").trim().split("\n") : [],
      volumeEntries: listing(volume),
      visibleVolumeEntries: listing(volume).filter((name) => !name.startsWith(".")),
      ownershipGrants: existsSync(join(dir, "ownership.log")) ? readFileSync(join(dir, "ownership.log"), "utf8").trim().split("\n").filter(Boolean) : [],
      volumeRows: Object.fromEntries(listing(volume).filter((name) => /\.(sqlite|db)$/.test(name)).map((name) => [name, databaseRows(join(volume, name))])),
      payloadMembers: listing(join(dir, "payloads")).map((name) => tarMembers(readFileSync(join(dir, "payloads", name)))),
      volumeFiles: Object.fromEntries(listing(volume).filter((name) => statSync(join(volume, name)).isFile()).map((name) => [name, { text: readFileSync(join(volume, name), "utf8"), mode: mode(join(volume, name)) }])),
    };
  } finally {
    await close(healthServer);
    rmSync(dir, { recursive: true, force: true });
  }
};

const assertChangedInTransit = (corruptions) =>
  assert.ok(
    corruptions.length > 0 && corruptions.every(([before, after]) => /^[0-9a-f]{64}$/.test(before) && /^[0-9a-f]{64}$/.test(after) && before !== after),
    `the fake did not change the payload: ${JSON.stringify(corruptions)}`,
  );

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

  test(`${shell}: a transfer killed part way never blocks the next deploy, and stale staging is cleared`, async () => {
    const shared = mkdtempSync(join(tmpdir(), "deploy-sfu-import-"));
    try {
      const stale = join(shared, ".incoming-sfu-a-left-by-an-old-deploy");
      mkdirSync(stale, { recursive: true });
      const hoursAgo = new Date(Date.now() - 2 * 3_600_000);
      utimesSync(stale, hoursAgo, hoursAgo);
      const options = { sharedImportDir: shared, diff: wrote("scheduling.json"), files: { "scheduling.json": '["kept"]' } };
      const killed = await replaceService(harness, { ...options, killTransfer: true });
      assert.notEqual(killed.status, 0);
      assert.equal(stopped(killed.calls), false, killed.calls.join("\n"));
      assert.deepEqual(killed.archives, []);
      const retried = await replaceService(harness, options);
      assert.equal(retried.status, 0, retried.stderr);
      assert.deepEqual(retried.archives.map((archive) => archive.bytes["scheduling.json"].toString()), ['["kept"]']);
      assert.equal(existsSync(stale), false, "a staging folder hours old was left in place");
      assert.ok(readdirSync(shared).every((name) => name === "sfu-a" || name.startsWith(".incoming-")), readdirSync(shared).join(", "));
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });

  test(`${shell}: a transfer that fails while unpacking leaves no staging folder and stops before anything is stopped`, async () => {
    const { status, calls, archives, importLeftovers, stderr } = await replaceService(harness, { diff: wrote("scheduling.json"), failUnpack: true });
    assert.notEqual(status, 0);
    assert.match(stderr, /unpack-fails/);
    assert.equal(stopped(calls), false, calls.join("\n"));
    assert.deepEqual(archives, []);
    assert.deepEqual(importLeftovers, []);
  });

  test(`${shell}: every folder the receiver makes belongs to the SFU user with mode 0700, whether the transfer succeeds or fails`, async () => {
    const outcomes = {};
    for (const [name, options] of Object.entries({
      saved: {},
      "arrived changed": { corrupt: true },
      "failed to unpack": { failUnpack: true },
      "killed part way": { killTransfer: true },
    })) {
      const shared = mkdtempSync(join(tmpdir(), "deploy-sfu-import-"));
      const importDir = join(shared, "json-fallback-import");
      try {
        const run = await replaceService(harness, { ...options, sharedImportDir: importDir, diff: wrote("scheduling.json"), files: { "scheduling.json": '["kept"]' } });
        if (options.corrupt) assertChangedInTransit(run.corruptions);
        outcomes[name] = { failed: run.status !== 0, strays: run.strays };
      } finally {
        rmSync(shared, { recursive: true, force: true });
      }
    }
    assert.deepEqual(outcomes, {
      saved: { failed: false, strays: [] },
      "arrived changed": { failed: true, strays: [] },
      "failed to unpack": { failed: true, strays: [] },
      "killed part way": { failed: true, strays: [] },
    });
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
    const answers = ["unavailable", "an earlier deploy", "another SFU", "an older image"];
    const outcomes = await Promise.all(answers.map((health) => replaceService(harness, { health })));
    outcomes.forEach(({ status, calls, stderr, healthRequests }, at) => {
      const health = answers[at];
      assert.notEqual(status, 0, `${health} was accepted`);
      const start = callIndex(calls, /^compose .* up -d sfu-a$/);
      const stop = calls.findLastIndex((call) => /^compose .* stop sfu-a$/.test(call));
      assert.ok(start >= 0 && stop > start, `${health}\n${calls.join("\n")}`);
      assert.match(stderr, /did not answer healthy/, health);
      assert.ok(healthRequests >= 1, `${health}: the deploy never asked for health, so the answer was never checked`);
    });
  });

  test(`${shell}: a payload that arrives changed stops the deploy before anything is stopped`, async () => {
    const { status, calls, imported, corruptions } = await replaceService(harness, {
      diff: wrote("scheduling.json"),
      files: { "scheduling.json": "[\"kept\"]" },
      corrupt: true,
    });
    assertChangedInTransit(corruptions);
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

  test(`${shell}: carries a database the old SFU kept inside its container onto the volume as one file, as it was when the old SFU stopped`, async () => {
    const legacy = "/var/lib/conclave/conclave.sqlite";
    const cases = {
      "the old image's own setting, with a write-ahead log": { containerEnv: `CONCLAVE_SQLITE_PATH=${legacy}\\n`, layerDir: "/var/lib/conclave", source: "conclave.sqlite", mode: "wal" },
      "no setting at all": { containerEnv: "", layerDir: DATA, source: "conclave.sqlite", mode: "delete" },
      "a relative recordings setting, with a leftover journal": { containerEnv: "RECORDING_STORAGE_PATH= ./recordings \\n", layerDir: "/app/packages/sfu/recordings", source: "conclave.sqlite", mode: "delete", journal: true },
      "one store's own setting": { containerEnv: "SCHEDULED_WEBINARS_SQLITE_PATH=../state/webinars.db\\nCONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/conclave.sqlite\\n", layerDir: "/app/packages/state", source: "webinars.db", mode: "wal" },
    };
    const runs = await Promise.all(
      Object.values(cases).map(({ containerEnv, layerDir, source, mode, journal = false }) => {
        const atStop = { ...sqliteFiles(source, ["early", "at stop"], { mode }), ...(journal ? { [`${source}-journal`]: Buffer.alloc(0) } : {}) };
        const diff = Object.keys(atStop).map((file) => `A ${layerDir}/${file}\\n`).join("");
        return replaceService(harness, { containerEnv, diff, files: sqliteFiles(source, ["early"], { mode }), filesAfterStop: atStop });
      }),
    );
    const outcomes = Object.fromEntries(
      Object.keys(cases).map((name, at) => {
        const run = runs[at];
        const copied = callIndex(run.calls, /^cp .*:\S*(conclave\.sqlite|webinars\.db) /);
        return [name, {
          status: run.status,
          stderr: run.status === 0 ? "" : run.stderr,
          volume: run.volumeEntries,
          mode: run.volumeFiles["conclave.sqlite"]?.mode,
          rows: run.volumeRows["conclave.sqlite"],
          copiedAfterStop: copied > callIndex(run.calls, /^compose .* stop sfu-a$/) && callIndex(run.calls, /^compose .* up -d sfu-a$/) > copied,
        }];
      }),
    );
    assert.deepEqual(outcomes, Object.fromEntries(Object.keys(cases).map((name) => [name, { status: 0, stderr: "", volume: ["conclave.sqlite"], mode: "600", rows: ["at stop", "early"], copiedAfterStop: true }])));
  });

  test(`${shell}: refuses before anything is stopped when a database inside the old container cannot be carried over`, async () => {
    const legacy = `CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite\\n`;
    const inLayer = "A /var/lib/conclave/conclave.sqlite\\n";
    const cases = {
      "the volume already holds one": { options: { containerEnv: legacy, diff: inLayer, volumeFiles: { "conclave.sqlite": "kept" } }, reason: /already holds a database/ },
      "the volume holds a write-ahead log": { options: { containerEnv: legacy, diff: inLayer, volumeFiles: { "conclave.sqlite-wal": "kept" } }, reason: /already holds a database/ },
      "the new place is off the recordings volume": { options: { containerEnv: legacy, diff: inLayer, newSqlitePath: "/nonexistent-conclave-folder/conclave.sqlite" }, reason: /does not resolve onto the recordings volume/ },
      "two databases would land in one place": {
        options: { containerEnv: "SCHEDULING_SQLITE_PATH=/srv/scheduling.sqlite\\n", diff: `A /srv/scheduling.sqlite\\n${wrote("conclave.sqlite")}` },
        reason: /more than one database/,
      },
    };
    const runs = await Promise.all(Object.values(cases).map(({ options }) => replaceService(harness, options)));
    Object.entries(cases).forEach(([name, { options, reason }], at) => {
      const run = runs[at];
      assert.notEqual(run.status, 0, name);
      assert.match(run.stderr, reason, name);
      assert.match(run.stderr, /nothing was stopped/, name);
      assert.equal(stopped(run.calls), false, `${name}\n${run.calls.join("\n")}`);
      assert.equal(callIndex(run.calls, /^cp /), -1, `${name}\n${run.calls.join("\n")}`);
      assert.deepEqual(run.archives, [], name);
      for (const [file, text] of Object.entries(options.volumeFiles ?? {})) assert.equal(run.volumeFiles[file]?.text, text, name);
    });
  });

  test(`${shell}: creates the folders a database path on the volume names, as the stores do, and refuses only a folder that cannot take files`, async () => {
    const volume = realpathSync(mkdtempSync(join(tmpdir(), "deploy-sfu-volume-")));
    try {
      const options = {
        containerEnv: "CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite\\n",
        diff: "A /var/lib/conclave/conclave.sqlite\\nA /var/lib/conclave/conclave.sqlite-wal\\n",
        files: sqliteFiles("conclave.sqlite", ["kept"]),
        sharedVolume: volume,
      };
      const nested = await replaceService(harness, { ...options, newSqlitePath: join(volume, "state", "deeper", "conclave.sqlite") });
      assert.equal(nested.status, 0, nested.stderr);
      assert.deepEqual(databaseRows(join(volume, "state", "deeper", "conclave.sqlite")), ["kept"]);
      assert.deepEqual([mode(join(volume, "state")), mode(join(volume, "state", "deeper"))], ["700", "700"]);
      for (const folder of [join(volume, "state"), join(volume, "state", "deeper")]) {
        assert.ok(nested.ownershipGrants.includes(`node:node one ${folder}`), `${folder} was not handed to node:\n${nested.ownershipGrants.join("\n")}`);
      }
      if (process.getuid?.() !== 0) {
        mkdirSync(join(volume, "locked"), { mode: 0o555 });
        const locked = await replaceService(harness, { ...options, newSqlitePath: join(volume, "locked", "inner", "conclave.sqlite") });
        assert.notEqual(locked.status, 0);
        assert.match(locked.stderr, /nearest folder that exists cannot take new files/);
        assert.equal(stopped(locked.calls), false, locked.calls.join("\n"));
        assert.deepEqual(readdirSync(join(volume, "locked")), []);
      }
    } finally {
      chmodSync(volume, 0o700);
      if (existsSync(join(volume, "locked"))) chmodSync(join(volume, "locked"), 0o700);
      rmSync(volume, { recursive: true, force: true });
    }
  });

  test(`${shell}: a database copy that fails, arrives changed, fails to unpack or is not a sound database leaves the new SFU unstarted and the volume untouched`, async () => {
    const options = { containerEnv: "CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite\\n", diff: "A /var/lib/conclave/conclave.sqlite\\nA /var/lib/conclave/conclave.sqlite-wal\\n", files: sqliteFiles("conclave.sqlite", ["kept"]) };
    const kinds = {
      "copy fails": { cpFailAfterStop: "conclave.sqlite" },
      "arrives changed": { corrupt: true },
      "fails to unpack": { failUnpack: true },
      "not a sound database": { files: { "conclave.sqlite": Buffer.from("SQLite format 3\0 but not really a database"), "conclave.sqlite-wal": Buffer.from("kept") } },
    };
    const runs = await Promise.all(Object.values(kinds).map((extra) => replaceService(harness, { ...options, ...extra })));
    assertChangedInTransit(runs[1].corruptions);
    Object.keys(kinds).forEach((name, at) => {
      const run = runs[at];
      assert.notEqual(run.status, 0, name);
      assert.ok(stopped(run.calls), name);
      assert.equal(callIndex(run.calls, / up -d /), -1, `${name}\n${run.calls.join("\n")}`);
      assert.match(run.stderr, /start sfu-a/, name);
      assert.deepEqual(run.visibleVolumeEntries, [], name);
    });
  });

  test(`${shell}: a copy killed just before or just after it lands on the volume never blocks the retry, which finishes the carry`, async () => {
    const options = {
      containerEnv: "CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite\\n",
      diff: "A /var/lib/conclave/conclave.sqlite\\nA /var/lib/conclave/conclave.sqlite-wal\\n",
      files: sqliteFiles("conclave.sqlite", ["kept", "only in the log"]),
    };
    const outcomes = {};
    for (const when of ["before", "after"]) {
      const volume = mkdtempSync(join(tmpdir(), "deploy-sfu-volume-"));
      try {
        const killed = await replaceService(harness, { ...options, sharedVolume: volume, killAtPublish: when });
        const retried = await replaceService(harness, { ...options, sharedVolume: volume });
        outcomes[when] = {
          killedFailed: killed.status !== 0,
          killedStartedNothing: callIndex(killed.calls, / up -d /) === -1,
          retried: retried.status,
          retriedError: retried.status === 0 ? "" : retried.stderr,
          volume: retried.visibleVolumeEntries,
          rows: retried.volumeRows["conclave.sqlite"],
          retryCopied: callIndex(retried.calls, /^cp .*conclave\.sqlite /) >= 0,
        };
      } finally {
        rmSync(volume, { recursive: true, force: true });
      }
    }
    const landed = { killedFailed: true, killedStartedNothing: true, retried: 0, retriedError: "", volume: ["conclave.sqlite"], rows: ["kept", "only in the log"] };
    assert.deepEqual(outcomes, { before: { ...landed, retryCopied: true }, after: { ...landed, retryCopied: false } });
  });

  test(`${shell}: checks the old container again after it stops, and carries what it holds then, whatever the check before the stop saw`, async () => {
    const legacy = "CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite\\n";
    const inLayer = "A /var/lib/conclave/conclave.sqlite\\nA /var/lib/conclave/conclave.sqlite-wal\\n";
    const first = ["kept"];
    const later = ["kept", "written after the first copy"];
    const scenarios = {
      "ran again before this deploy looked": { first: { killAtPublish: "after" }, retry: { startedAt: "2026-11-25T09:30:00.000000000Z", files: sqliteFiles("conclave.sqlite", later) } },
      "ran again between the check and the stop": { first: { killAtPublish: "after" }, retry: { startedAfterStop: "2026-11-25T09:30:00.000000000Z", filesAfterStop: sqliteFiles("conclave.sqlite", later) } },
      "first wrote its database between the check and the stop": { retry: { diff: "", diffAfterStop: inLayer, filesAfterStop: sqliteFiles("conclave.sqlite", later) } },
    };
    const outcomes = {};
    for (const [name, { first: firstRun, retry }] of Object.entries(scenarios)) {
      const volume = mkdtempSync(join(tmpdir(), "deploy-sfu-volume-"));
      try {
        const base = { containerEnv: legacy, diff: inLayer, files: sqliteFiles("conclave.sqlite", first), sharedVolume: volume };
        if (firstRun) assert.notEqual((await replaceService(harness, { ...base, ...firstRun })).status, 0, name);
        const run = await replaceService(harness, { ...base, ...retry });
        outcomes[name] = { status: run.status, stderr: run.status === 0 ? "" : run.stderr, rows: run.volumeRows["conclave.sqlite"], started: callIndex(run.calls, / up -d /) >= 0 };
      } finally {
        rmSync(volume, { recursive: true, force: true });
      }
    }
    assert.deepEqual(outcomes, Object.fromEntries(Object.keys(scenarios).map((name) => [name, { status: 0, stderr: "", rows: later, started: true }])));
  });

  test(`${shell}: never starts the new SFU while the old one is running again or started again after its database was copied`, async () => {
    const base = {
      containerEnv: "CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite\\n",
      diff: "A /var/lib/conclave/conclave.sqlite\\nA /var/lib/conclave/conclave.sqlite-wal\\n",
      files: sqliteFiles("conclave.sqlite", ["kept"]),
    };
    const runs = await Promise.all([
      replaceService(harness, { ...base, runningAfterStop: true }),
      replaceService(harness, { ...base, startedAfterCarry: "2026-11-25T09:30:00.000000000Z" }),
    ]);
    for (const [name, run] of [["still running after the stop", runs[0]], ["started again after the copy", runs[1]]]) {
      assert.notEqual(run.status, 0, name);
      assert.equal(callIndex(run.calls, / up -d /), -1, `${name}\n${run.calls.join("\n")}`);
      assert.match(run.stderr, /running again|started again/, name);
      assert.match(run.stderr, /start sfu-a/, name);
    }
  });

  test(`${shell}: never publishes a database through a symbolic link that leads off the volume, whether it is there before the check or appears just before the copy lands`, async () => {
    const outcomes = {};
    for (const when of ["before the check", "just before the copy lands"]) {
      const volume = realpathSync(mkdtempSync(join(tmpdir(), "deploy-sfu-volume-")));
      const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "deploy-sfu-elsewhere-")));
      try {
        mkdirSync(join(volume, "state"));
        if (when === "before the check") {
          rmSync(join(volume, "state"), { recursive: true });
          symlinkSync(elsewhere, join(volume, "state"));
        }
        const run = await replaceService(harness, {
          containerEnv: "CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite\\n",
          diff: "A /var/lib/conclave/conclave.sqlite\\nA /var/lib/conclave/conclave.sqlite-wal\\n",
          files: sqliteFiles("conclave.sqlite", ["kept"]),
          sharedVolume: volume,
          newSqlitePath: join(volume, "state", "conclave.sqlite"),
          ...(when === "just before the copy lands" ? { linkFrom: join(volume, "state"), linkTo: elsewhere } : {}),
        });
        outcomes[when] = {
          failed: run.status !== 0,
          stoppedOld: stopped(run.calls),
          startedNew: callIndex(run.calls, / up -d /) >= 0,
          elsewhere: readdirSync(elsewhere).filter((name) => !name.startsWith(".")),
          said: /does not resolve onto the recordings volume|not on the recordings volume|Refusing to publish/.test(run.stderr),
        };
      } finally {
        rmSync(volume, { recursive: true, force: true });
        rmSync(elsewhere, { recursive: true, force: true });
      }
    }
    assert.deepEqual(outcomes, {
      "before the check": { failed: true, stoppedOld: false, startedNew: false, elsewhere: [], said: true },
      "just before the copy lands": { failed: true, stoppedOld: true, startedNew: false, elsewhere: [], said: true },
    });
  });

  test(`${shell}: sends only the files it names, even when the host's tar would add metadata members for extended attributes`, async () => {
    const { status, stderr, payloadMembers, volumeEntries, imported } = await replaceService(harness, {
      containerEnv: "CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite\\n",
      diff: `${wrote("scheduling.json")}A /var/lib/conclave/conclave.sqlite\\nA /var/lib/conclave/conclave.sqlite-wal\\n`,
      files: { "scheduling.json": "[]", ...sqliteFiles("conclave.sqlite", ["kept"]) },
    });
    assert.equal(status, 0, stderr);
    assert.deepEqual(payloadMembers.map((members) => members.sort()), [["scheduling.json"], ["db", "db-wal"]]);
    assert.deepEqual(imported, ["scheduling.json"]);
    assert.deepEqual(volumeEntries, ["conclave.sqlite"]);
  });

  test(`${shell}: leaves a database on the volume where it is`, async () => {
    const { status, stderr, calls, volumeEntries } = await replaceService(harness, {
      containerEnv: "CONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/conclave.sqlite\\n",
      diff: "C /var/lib/conclave\\n",
    });
    assert.equal(status, 0, stderr);
    assert.equal(callIndex(calls, /^cp /), -1, calls.join("\n"));
    assert.deepEqual(receives(calls), []);
    assert.deepEqual(volumeEntries, []);
  });

  test(`${shell}: with no old container, starts the new SFU without copying anything`, async () => {
    const { status, calls, stderr } = await replaceService(harness, { container: "" });
    assert.equal(status, 0, stderr);
    assert.equal(callIndex(calls, /^(cp|diff) /), -1, calls.join("\n"));
    assert.ok(callIndex(calls, /^compose .* up -d sfu-a$/) >= 0);
  });
}

const pathHarnesses = [
  {
    name: "bash",
    command: "bash",
    args: [],
    file: "paths.sh",
    source: () =>
      [
        "set -euo pipefail",
        allDefinitions(deployShell, shellFunctions),
        'docker() { case "$*" in *WorkingDir*) cat "${@: -1}/workdir" ;; *Config.Env*) cat "${@: -1}/env" ;; esac; }',
        'for case_dir in "$CASES"/*; do while IFS= read -r line; do printf \'%s\\t%s\\n\' "${case_dir##*/}" "$line"; done < <(store_file_paths "$case_dir"); done',
      ].join("\n"),
  },
  ...powerShells
    .filter(({ version }) => atLeast(version, MINIMUM_POWERSHELL))
    .map(({ binary, version }) => ({
      name: `pwsh ${version}`,
      command: binary,
      args: ["-NoProfile", "-NonInteractive", "-File"],
      file: "paths.ps1",
      source: () =>
        [
          "Set-StrictMode -Version Latest",
          '$ErrorActionPreference = "Stop"',
          allDefinitions(deployPowerShell, powerShellFunctions),
          'function docker { $global:LASTEXITCODE = 0; $file = if ("$args" -like "*WorkingDir*") { "workdir" } else { "env" }; Get-Content -LiteralPath (Join-Path $args[-1] $file) }',
          'foreach ($dir in @(Get-ChildItem -LiteralPath $env:CASES -Directory | Sort-Object Name)) { foreach ($entry in @(Get-StoreFilePaths -Container $dir.FullName)) { [Console]::Out.WriteLine("$($dir.Name)`t$($entry.Kind) $($entry.Name) $($entry.Path)") } }',
        ].join("\n"),
    })),
];

const STORE_VARIABLES = [
  "SCHEDULING_PATH",
  "SCHEDULED_MEETINGS_PATH",
  "SCHEDULED_WEBINARS_PATH",
  "SCHEDULING_SQLITE_PATH",
  "SCHEDULED_MEETINGS_SQLITE_PATH",
  "SCHEDULED_WEBINARS_SQLITE_PATH",
  "CONCLAVE_SQLITE_PATH",
  "RECORDING_STORAGE_PATH",
];
const SETTING_VALUES = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "", "   ", "\t", "/var/lib/conclave/conclave.sqlite", " /srv//state/../db.sqlite ", "relative/store.db", "./here", "../up/one", "with space/name file.sqlite", "/", ".", "..", "\t/padded/tab\t", "/trailing/"];
const WORKDIRS = ["/app/packages/sfu", "/app/packages/sfu", "/", "/srv/conclave/", ""];

const seededRandom = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

const storePathCases = (count, seed) => {
  const random = seededRandom(seed);
  const pick = (values) => values[Math.floor(random() * values.length)];
  return Array.from({ length: count }, () => ({
    workdir: pick(WORKDIRS),
    env: Object.fromEntries(STORE_VARIABLES.map((name) => [name, pick(SETTING_VALUES)]).filter(([, value]) => value !== undefined)),
  }));
};

const sqliteBranch = (env, prefix) => {
  const set = (name) => (env[name] ?? "").trim() !== "";
  if (set(`${prefix}_SQLITE_PATH`)) return "own";
  if (set("CONCLAVE_SQLITE_PATH")) return "shared";
  if (set("RECORDING_STORAGE_PATH")) return "recordings";
  return "default";
};

test("every store path both deploy scripts read from an old container is the path the SFU's own store code uses", async () => {
  const cases = storePathCases(150, 272);
  const counts = {};
  for (const { env } of cases) {
    for (const prefix of ["SCHEDULING", "SCHEDULED_MEETINGS", "SCHEDULED_WEBINARS"]) {
      const branch = sqliteBranch(env, prefix);
      counts[branch] = (counts[branch] ?? 0) + 1;
    }
  }
  assert.ok(["own", "shared", "recordings", "default"].every((branch) => counts[branch] >= 20), JSON.stringify(counts));
  const oracle = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", 'const { storeFileLines } = await import("./server/storePaths.ts"); const cases = JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify(cases.map(({ env, workdir }) => storeFileLines(env, workdir || "/"))));', JSON.stringify(cases)],
    { cwd: sfuDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(oracle.status, 0, oracle.stderr);
  const expected = JSON.parse(oracle.stdout).flatMap((lines, index) => lines.map((line) => `${String(index).padStart(4, "0")}\t${line}`));
  const dir = mkdtempSync(join(tmpdir(), "deploy-sfu-paths-"));
  try {
    const casesDir = join(dir, "cases");
    cases.forEach(({ env, workdir }, index) => {
      const caseDir = join(casesDir, String(index).padStart(4, "0"));
      mkdirSync(caseDir, { recursive: true });
      writeFileSync(join(caseDir, "workdir"), `${workdir}\n`);
      writeFileSync(join(caseDir, "env"), Object.entries(env).map(([name, value]) => `${name}=${value}\n`).join(""));
    });
    for (const harness of pathHarnesses) {
      writeFileSync(join(dir, harness.file), harness.source());
      const result = await run(harness.command, [...harness.args, join(dir, harness.file)], { PATH: process.env.PATH, HOME: dir, CASES: casesDir });
      assert.equal(result.status, 0, `${harness.name}: ${result.stderr}`);
      const actual = result.stdout.split("\n").filter(Boolean);
      const differences = expected.filter((line, index) => actual[index] !== line).slice(0, 5).map((line) => `${harness.name}\n  store code: ${line}\n  deploy:     ${actual[expected.indexOf(line)]}`);
      assert.deepEqual(differences, []);
      assert.equal(actual.length, expected.length, harness.name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const FLOW_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
args=("$@")
service="\${@: -1}"
holds() { [[ " $FAKE_LAYER_HOLDERS " == *" \${1#old-} "* ]]; }
if [[ "$1" == "compose" ]]; then
  for ((i = 1; i < \${#args[@]}; i++)); do
    if [[ "\${args[i]}" == run ]]; then
      script="" rest=()
      for ((j = i + 1; j < \${#args[@]}; j++)); do
        [[ "\${args[j]}" == -c ]] && { script="\${args[j + 1]}"; rest=("\${args[@]:j + 2}"); break; }
      done
      [[ -n "$script" ]] || exit 0
      script="\${script//\\/var\\/lib\\/conclave\\/recordings/$FAKE_VOLUME}"
      cd "$FAKE_SFU_DIR" || exit 1
      CONCLAVE_SQLITE_PATH="$FAKE_VOLUME/conclave.sqlite" CONCLAVE_FALLBACK_IMPORT_DIR="$FAKE_VOLUME/json-fallback-import" exec sh -c "$script" "\${rest[@]}"
    fi
  done
  case " $* " in
    *" config --services "*) printf 'sfu-a\\nsfu-b\\n'; exit 0 ;;
    *" config --format json "*) echo '{}'; exit 0 ;;
    *" up -d "*) printf '%s' "$SFU_DEPLOY_ID" > "$FAKE_STATE/$service.up"; exit 0 ;;
    *" stop "*) rm -f "$FAKE_STATE/$service.up"; : > "$FAKE_STATE/old-$service.stopped"; exit 0 ;;
    *" ps -a -q "*) [[ " $FAKE_CONTAINERS " == *" $service "* ]] && echo "old-$service"; exit 0 ;;
  esac
  exit 0
fi
case "$1" in
  inspect)
    case "$*" in
      *WorkingDir*) echo /app/packages/sfu ;;
      *Config.Env*) holds "$service" && echo "CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite" ;;
      *State.StartedAt*) echo "2026-11-25T08:00:00.000000000Z" ;;
      *State.Running*) if [[ " $FAKE_RUNNING " == *" \${service#old-} "* && ! -f "$FAKE_STATE/$service.stopped" ]]; then echo true; else echo false; fi ;;
    esac ;;
  diff) holds "$2" && printf 'A /var/lib/conclave/conclave.sqlite\\nA /var/lib/conclave/conclave.sqlite-wal\\n' ;;
  cp) cat "$FAKE_FILES/\${2##*/}" > "$3" ;;
esac
exit 0
`;

const fakeSfu = (service, { rooms, replacement, state, log, down = false }) => {
  let draining = false;
  let active = rooms;
  return createServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/drain" && down) return reply(503, {});
    if (req.method === "POST" && req.url === "/drain") {
      draining = true;
      active = 0;
      appendFileSync(log, `drain ${service}\n`);
      req.resume();
      return reply(200, { draining: true });
    }
    if (req.url === "/status") return down ? reply(503, {}) : reply(200, { instanceId: service, rooms: active, draining, healthy: true });
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

const deploySfus = async (shell, replacements, { containers = "", layerHolders = "", running = "", down = [] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "deploy-sfu-flow-"));
  const state = join(root, "state");
  const volume = realpathSync(mkdtempSync(join(tmpdir(), "deploy-sfu-flow-volume-")));
  const log = join(root, "deploy.log");
  mkdirSync(state);
  writeFileSync(log, "");
  writeFiles(join(root, "files"), sqliteFiles("conclave.sqlite", ["kept", "only in the log"]));
  const servers = {
    "sfu-a": fakeSfu("sfu-a", { rooms: 1, replacement: replacements["sfu-a"], state, log, down: down.includes("sfu-a") }),
    "sfu-b": fakeSfu("sfu-b", { rooms: 0, replacement: replacements["sfu-b"], state, log, down: down.includes("sfu-b") }),
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
    writeFileSync(join(bin, "chown"), "#!/bin/sh\nexit 0\n");
    if (!hostHasSha256sum) writeFileSync(join(bin, "sha256sum"), SHA256SUM_SHIM);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
    for (const name of readdirSync(bin)) chmodSync(join(bin, name), 0o755);
    const result = await run(shell.command, [...shell.args, join(root, "scripts", shell.script)], {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      TMPDIR: tmpdir(),
      DOCKER_LOG: log,
      FAKE_STATE: state,
      FAKE_VOLUME: volume,
      FAKE_FILES: join(root, "files"),
      FAKE_SFU_DIR: sfuDir,
      FAKE_CONTAINERS: `${containers} ${layerHolders}`,
      FAKE_LAYER_HOLDERS: layerHolders,
      FAKE_RUNNING: running,
      SFU_A_URL: urls["sfu-a"],
      SFU_B_URL: urls["sfu-b"],
      SFU_DEPLOY_ID: "sfu-flow-deploy",
      SFU_HEALTH_TIMEOUT_SECONDS: "1",
      SFU_HEALTH_POLL_SECONDS: "1",
      DRAIN_POLL_SECONDS: "1",
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    return { ...result, calls, rows: existsSync(join(volume, "conclave.sqlite")) ? databaseRows(join(volume, "conclave.sqlite")) : null };
  } finally {
    await Promise.all(Object.values(servers).map(close));
    rmSync(root, { recursive: true, force: true });
    rmSync(volume, { recursive: true, force: true });
  }
};

const touched = (calls) =>
  calls
    .filter((call) => /^compose .* (build|stop|up -d) sfu-[ab]$/.test(call) || call.startsWith("drain "))
    .map((call) => call.replace(/^compose .* (build|stop|up -d) (sfu-[ab])$/, "$1 $2"));

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

  test(`${shell.name}: a database inside an old SFU container is carried only from the slot replaced first, and a stopped SFU holding one is replaced first`, async () => {
    const deployed = { "sfu-a": "deployed", "sfu-b": "deployed" };
    const cases = {
      "serving sfu-a running with it, sfu-b without a container": { layerHolders: "sfu-a", running: "sfu-a", down: ["sfu-b"] },
      "both old containers keep one": { layerHolders: "sfu-a sfu-b", running: "sfu-a", down: ["sfu-b"] },
      "inactive sfu-b stopped with it, sfu-a serving from the volume": { containers: "sfu-a", layerHolders: "sfu-b", running: "sfu-a", down: ["sfu-b"] },
      "both down, stopped sfu-a keeps it, sfu-b without a container": { layerHolders: "sfu-a", down: ["sfu-a", "sfu-b"] },
      "both down, stopped sfu-a keeps it, sfu-b stopped on the volume": { containers: "sfu-b", layerHolders: "sfu-a", down: ["sfu-a", "sfu-b"] },
    };
    const runs = await Promise.all(Object.values(cases).map((options) => deploySfus(shell, deployed, options)));
    const outcomes = Object.fromEntries(
      Object.keys(cases).map((name, at) => {
        const { status, calls, stdout, stderr, rows } = runs[at];
        return [name, { status: status === 0 ? "deployed" : stderr.match(/The serving \S+|each keep their own database/)?.[0] ?? stderr.trim().split("\n").at(-1), touched: touched(calls), rows, completed: /SFU deploy complete/.test(stdout) }];
      }),
    );
    const carried = ["kept", "only in the log"];
    assert.deepEqual(outcomes, {
      "serving sfu-a running with it, sfu-b without a container": { status: "The serving sfu-a", touched: [], rows: null, completed: false },
      "both old containers keep one": { status: "each keep their own database", touched: [], rows: null, completed: false },
      "inactive sfu-b stopped with it, sfu-a serving from the volume": { status: "deployed", touched: ["build sfu-b", "stop sfu-b", "up -d sfu-b", "drain sfu-a", "build sfu-a", "stop sfu-a", "up -d sfu-a"], rows: carried, completed: true },
      "both down, stopped sfu-a keeps it, sfu-b without a container": { status: "deployed", touched: ["build sfu-a", "stop sfu-a", "up -d sfu-a", "build sfu-b", "stop sfu-b", "up -d sfu-b"], rows: carried, completed: true },
      "both down, stopped sfu-a keeps it, sfu-b stopped on the volume": { status: "deployed", touched: ["build sfu-a", "stop sfu-a", "up -d sfu-a", "build sfu-b", "stop sfu-b", "up -d sfu-b"], rows: carried, completed: true },
    });
  });

  test(`${shell.name}: following the refusal's advice (stop the serving SFU) carries its database on the next deploy`, async () => {
    const deployed = { "sfu-a": "deployed", "sfu-b": "deployed" };
    const refused = await deploySfus(shell, deployed, { layerHolders: "sfu-a", running: "sfu-a", down: ["sfu-b"] });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /stop sfu-a\) and deploy again/);
    const followed = await deploySfus(shell, deployed, { layerHolders: "sfu-a", down: ["sfu-a", "sfu-b"] });
    assert.equal(followed.status, 0, followed.stderr);
    assert.deepEqual(followed.rows, ["kept", "only in the log"]);
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

describe(SUITE, { concurrency: Math.min(16, availableParallelism() * 2) }, () => {
  for (const { name, body } of registered) nodeTest(name, body);
});
