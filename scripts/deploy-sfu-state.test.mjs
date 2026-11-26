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
        if [[ -z "$script" ]]; then
          [[ "$FAKE_FAIL_AT" == ownership ]] && exit 1
          [[ "$FAKE_FAIL_AT" == signal ]] && kill -TERM "$PPID"
          if [[ "$FAKE_FAIL_AT" == int-ownership ]]; then kill -INT -- "-$(ps -o pgid= -p $$ | tr -d ' ')"; sleep 5; exit 0; fi
          exit 0
        fi
        [[ "$FAKE_FAIL_AT" == probe && -f "$FAKE_STOPPED" && "$script" == *"layerDatabase.ts probe"* ]] && exit 1
        [[ "$FAKE_FAIL_AT" == carry && "$script" == *"layerDatabase.ts consolidate"* ]] && exit 1
        [[ "$FAKE_FAIL_AT" == publish && "$script" == *"staged copy"* ]] && exit 1
        if [[ -s "$STAGING_PATH_FILE" && "$script" == *payload.tar* ]]; then
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
        if [[ "$script" != *payload.tar* ]]; then
          CONCLAVE_FALLBACK_IMPORT_DIR="$FAKE_IMAGE_IMPORT_DIR" sh -c "$script" "\${rest[@]}"
          code=$?
          [[ $code == 0 && "$FAKE_RESTART_AT" == probe && -f "$FAKE_STOPPED" && "$script" == *"layerDatabase.ts probe"* ]] && : > "$FAKE_RESTARTED"
          exit $code
        fi
        if [[ "$script" == *"layerDatabase.ts consolidate"* && -n "$FAKE_LINK_FROM" ]]; then
          rm -rf "$FAKE_LINK_FROM" && ln -s "$FAKE_LINK_TO" "$FAKE_LINK_FROM"
        fi
        if [[ -z "$FAKE_KILL_TRANSFER$FAKE_CORRUPT" ]]; then
          payload="$PAYLOAD_DIR/$(ls "$PAYLOAD_DIR" | wc -l | tr -d ' ').tar"
          cat > "$payload"
          CONCLAVE_FALLBACK_IMPORT_DIR="$FAKE_IMAGE_IMPORT_DIR" sh -c "$script" "\${rest[@]}" < "$payload"
          code=$?
          [[ $code == 0 && "$script" == *"layerDatabase.ts consolidate"* ]] && : > "$FAKE_CARRIED"
          [[ $code == 0 && "$FAKE_RESTART_AT" == carry && "$script" == *"layerDatabase.ts consolidate"* ]] && : > "$FAKE_RESTARTED"
          [[ $code == 0 && "$FAKE_RESTART_AT" == json-send && "$script" != *"layerDatabase.ts consolidate"* ]] && : > "$FAKE_RESTARTED"
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
      stop) [[ "$FAKE_FAIL_AT" == stop ]] && exit 1; : > "$FAKE_STOPPED"; exit 0 ;;
      up) printf '%s' "$SFU_DEPLOY_ID" > "$DOCKER_LOG.deploy-id"; exit 0 ;;
      build|start) exit 0 ;;
    esac
  done
  exit 0
fi
if [[ "$1" == stop ]]; then
  [[ "$FAKE_FAIL_AT" == stop ]] && exit 1
  : > "$FAKE_STOPPED"
  exit 0
fi
if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "$*" == *health-deploy-id* ]]; then echo deploy-id; else echo sha256:replacement; fi
  exit 0
fi
if [[ "$1" == update ]]; then
  case "$2:$FAKE_FAIL_AT" in
    --restart=no:freeze-fails) exit 1 ;;
    --restart=no:term-after-freeze) kill -TERM "$DEPLOY_PID" ;;
    --restart=no:hup-after-freeze) kill -HUP "$DEPLOY_PID" ;;
    --restart=no:int-after-freeze) kill -INT "$DEPLOY_PID" ;;
    --restart=no:quit-after-freeze) kill -QUIT "$DEPLOY_PID" ;;
    --restart=unless-stopped:term-during-restore|--restart=unless-stopped:int-during-restore)
      if [[ ! -e "$DOCKER_LOG.signal" ]]; then
        : > "$DOCKER_LOG.signal"
        if [[ "$FAKE_FAIL_AT" == int-during-restore ]]; then
          kill -INT -- "-$(ps -o pgid= -p $$ | tr -d ' ')"
        else
          kill -TERM "$DEPLOY_PID"
        fi
        sleep 0.2
      fi ;;
    --restart=unless-stopped:restore-fails)
      if [[ ! -e "$DOCKER_LOG.signal" ]]; then : > "$DOCKER_LOG.signal"; exit 1; fi ;;
  esac
  if [[ "$2" == --restart=unless-stopped && "$FAKE_RESTART_AT" == restore ]]; then : > "$FAKE_RESTARTED"; fi
fi
case "$1" in
  inspect)
    if [[ "$*" == *'{{.Image}}'* ]]; then echo sha256:source; exit 0; fi
    if [[ "$*" == *WorkingDir* ]]; then printf '%s\n' "\${FAKE_WORKDIR-/app/packages/sfu}"; exit 0; fi
    if [[ "$*" == *Config.Env* ]]; then printf '%b' "$FAKE_ENV"; exit 0; fi
    if [[ "$*" == *RestartPolicy* ]]; then echo "\${FAKE_RESTART_POLICY:-unless-stopped}"; exit 0; fi
    if [[ -f "$FAKE_RESTARTED" ]]; then running=true; started="2026-11-25T09:30:00.000000000Z"
    else
      if [[ -f "$FAKE_STOPPED" ]]; then running="\${FAKE_RUNNING_AFTER_STOP:-false}"; else running="\${FAKE_RUNNING:-false}"; fi
      if [[ -f "$FAKE_CARRIED" && -n "$FAKE_STARTED_AFTER_CARRY" ]]; then started="$FAKE_STARTED_AFTER_CARRY"
      elif [[ -f "$FAKE_STOPPED" && -n "$FAKE_STARTED_AFTER_STOP" ]]; then started="$FAKE_STARTED_AFTER_STOP"
      else started="$FAKE_STARTED_AT"; fi
    fi
    if [[ "$*" == *State.FinishedAt* ]]; then echo "$running $started $FAKE_FINISHED_AT"; exit 0; fi
    if [[ "$*" == *State.Running* ]]; then echo "$running"; exit 0; fi
    if [[ "$*" == *State.Status* ]]; then if [[ "$running" == true ]]; then echo running; else echo exited; fi; exit 0; fi
    if [[ "$*" == *State.StartedAt* ]]; then echo "$started"; exit 0; fi
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
    if [[ -f "$FAKE_STOPPED" ]]; then
      [[ "$FAKE_RESTART_AT" == json-copy && "$name" == *.json ]] && : > "$FAKE_RESTARTED"
      [[ "$FAKE_RESTART_AT" == sqlite-copy && "$name" != *.json ]] && : > "$FAKE_RESTARTED"
    fi
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
const bash = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "bash"].find((binary) => spawnSync(binary, ["-c", "(( BASH_VERSINFO[0] >= 4 ))"]).status === 0) ?? "bash";
const shellFunctions = /^(?!journal_(?:get|set)\()[A-Za-z_][A-Za-z0-9_]*\(\) [{(]\n[\s\S]*?^[})]\n/gm;

const harnesses = [
  {
    name: "bash",
    command: bash,
    args: [],
    file: "harness.sh",
    source: () =>
      [
        "set -euo pipefail",
        'export DEPLOY_PID="$$"',
        "COMPOSE=(docker compose -f docker-compose.sfu.yml)",
        allDefinitions(deployShell, shellFunctions),
        `if [[ -n "\${FIXED_STAMP:-}" ]]; then archive_stamp() { printf '%s' "$FIXED_STAMP"; }; fi`,
        'declare -A RESTART_HOLDS=() EXPECTED_ID=([sfu-a]=sfu-a)',
        'STATUS_RETRY_SECONDS=0 CONTAINER_SETTLE_SECONDS=0.05 HEALTH_TIMEOUT_SECONDS="$SFU_HEALTH_TIMEOUT_SECONDS" POLL_SECONDS=0.05 STATE_TOOLS_TAG=state-tools',
        'SERVICE_URL=("$SFU_HEALTH_URL")',
        `instance_status() {
          if [[ "$FAKE_FAIL_AT" == exit-before-final-status && ! -f "$FAKE_STOPPED" ]]; then
            : > "$FAKE_STOPPED"
            return 1
          fi
          printf '%s' '{"draining":true,"rooms":0}'
        }`,
        'service_url() { printf "%s" "$SFU_HEALTH_URL"; }',
        'if [[ -n "$FIXED_STAMP" ]]; then',
        '  archive_stamp() { printf "%s" "$FIXED_STAMP"; }',
        '  od() { printf " 012345abcdef"; }',
        "fi",
        'install_deploy_traps',
        'up_service sfu-a replacement false sha256:replacement',
      ].join("\n"),
  },
];

const hostHasSha256sum = spawnSync("sh", ["-c", "command -v sha256sum"]).status === 0;

const run = (command, args, env) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { env, detached: true });
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
  (existsSync(serviceDir) ? readdirSync(serviceDir).filter((name) => !name.startsWith(".")).sort() : []).map((name) => {
    const path = join(serviceDir, name);
    const files = readdirSync(path).filter((file) => !file.startsWith(".")).sort();
    const source = existsSync(join(path, ".source")) ? readFileSync(join(path, ".source"), "utf8").trim() : null;
    return { name, files, source, bytes: Object.fromEntries(files.map((file) => [file, readFileSync(join(path, file))])), modes: [mode(path), ...files.map((file) => mode(join(path, file)))] };
  });

const stagedArchives = (serviceDir) => (existsSync(serviceDir) ? readdirSync(serviceDir).filter((name) => name.startsWith(".staged-")).sort() : []);

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

const sqliteFixtures = new Map();
const sqliteFiles = (name, ids, { mode = "wal" } = {}) => {
  const key = JSON.stringify([name, ids, mode]);
  if (!sqliteFixtures.has(key)) sqliteFixtures.set(key, writeSqliteFixture(name, ids, mode));
  return sqliteFixtures.get(key);
};

const writeSqliteFixture = (name, ids, mode) => {
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

const databaseRows = async (path) => {
  const read = await run(process.execPath, ["--no-warnings", "-e", READ_DATABASE, path], process.env);
  return read.status === 0 ? JSON.parse(read.stdout) : `unreadable: ${read.stderr.trim().split("\n").at(-1)}`;
};

const READ_CARRY_STAMP = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const row = db.prepare("SELECT started_at FROM conclave_deploy_carry ORDER BY rowid DESC LIMIT 1").get();
process.stdout.write(row ? row.started_at : "");`;

const carryStamp = async (path) => {
  const read = await run(process.execPath, ["--no-warnings", "-e", READ_CARRY_STAMP, path], process.env);
  return read.status === 0 && read.stdout ? read.stdout : null;
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
    finishedAt = "2026-11-25T08:45:00.000000000Z",
    restartAt = "",
    failAt = "",
    running = false,
  } = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-sfu-state-"));
  let healthRequests = 0;
  const healthServer = createServer((req, res) => {
    if (req.url === "/health") healthRequests += 1;
    const idFile = join(dir, "docker.log.deploy-id");
    const [code, body] = healthAnswers[health]("sfu-a", existsSync(idFile) ? readFileSync(idFile, "utf8") : deployId);
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
      FAKE_FINISHED_AT: finishedAt,
      FAKE_RESTART_AT: restartAt,
      FAKE_FAIL_AT: failAt,
      FAKE_RUNNING: running ? "true" : "",
      FAKE_RESTARTED: join(dir, "restarted"),
      FAKE_LINK_TO: linkTo,
      FAKE_IMAGE_IMPORT_DIR: imageImportDir ? importDir : "",
      STAGING_PATH_FILE: join(dir, "staging-path"),
      STAGING_MODES: join(dir, "staging-modes"),
      SFU_HEALTH_URL: healthUrl,
      SFU_DEPLOY_ID: deployId,
      SFU_HEALTH_TIMEOUT_SECONDS: health === "deployed" ? "30" : "1",
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
    const staged = stagedArchives(containerDir);
    const latest = archives.at(-1);
    return {
      ...result,
      healthRequests,
      bootId: existsSync(join(dir, "docker.log.deploy-id")) ? readFileSync(join(dir, "docker.log.deploy-id"), "utf8") : "",
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      archives,
      staged,
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
      volumeRows: Object.fromEntries(await Promise.all(listing(volume).filter((name) => /\.(sqlite|db)$/.test(name)).map(async (name) => [name, await databaseRows(join(volume, name))]))),
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
const receives = (calls) => calls.filter((call) => /^compose .* run .*--entrypoint sh sfu-a -c .*payload\.tar/.test(call));
const stopped = (calls) => callIndex(calls, /^stop old-sfu-a$/) >= 0;
const wrote = (name) => `A ${DATA}/${name}\\n`;
const leftStoppedAndRestored = (calls) => {
  const froze = calls.indexOf(`update --restart=no ${OLD_CONTAINER}`);
  const stop = callIndex(calls, /^stop old-sfu-a$/);
  const restored = calls.lastIndexOf(`update --restart=unless-stopped ${OLD_CONTAINER}`);
  assert.ok(froze >= 0 && stop > froze && restored > stop && callIndex(calls, / up -d /) === -1, calls.join("\n"));
};

const BINARY = Buffer.concat([
  Buffer.from('{"id":"A","note":"'),
  Buffer.from(Array.from({ length: 512 }, (_, index) => index % 256)),
  Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0xfe, 0x0d, 0x0a, 0x0a, 0x0d, 0xc3, 0x28, 0xa0, 0xa1]),
  Buffer.from('"}\r\n'),
]);

for (const harness of harnesses) {
  const shell = harness.name;

  test(`${shell}: never starts the new SFU unless the old one's fallback files arrived byte for byte`, async () => {
    const files = { "scheduling.json": BINARY, "scheduled-meetings.json": Buffer.from("[]\n") };
    const { status, calls, stderr, imported, importedBytes } = await replaceService(harness, {
      diff: wrote("scheduling.json") + wrote("scheduled-meetings.json"),
      files,
    });
    if (status === 0) {
      assert.deepEqual(imported, ["scheduled-meetings.json", "scheduling.json"]);
      for (const [name, content] of Object.entries(files)) assert.ok(importedBytes(name).equals(content), `${name} changed in transit`);
    } else {
      assert.equal(callIndex(calls, / up -d /), -1, `started the new SFU after a failed copy:\n${stderr}`);
    }
  });

  test(`${shell}: keeps the old SFU from restarting, stops it, and only then copies its fallback files once, as they were when it stopped`, async () => {
    const { status, calls, stderr, archives } = await replaceService(harness, {
      diff: `C ${DATA}\\n${wrote("scheduling.json")}`,
      files: { "scheduling.json": "[1]" },
      filesAfterStop: { "scheduling.json": "[1,2]" },
    });
    assert.equal(status, 0, stderr);
    const froze = calls.indexOf(`update --restart=no ${OLD_CONTAINER}`);
    const stop = callIndex(calls, /^stop old-sfu-a$/);
    const copies = calls.filter((call) => call.startsWith(`cp ${OLD_CONTAINER}:`)).map((call) => calls.indexOf(call));
    const sends = receives(calls).map((call) => calls.indexOf(call));
    const restored = calls.indexOf(`update --restart=unless-stopped ${OLD_CONTAINER}`);
    const start = callIndex(calls, /^compose .* up -d .*sfu-a$/);
    assert.ok(froze >= 0 && stop > froze && copies.length === 1 && copies[0] > stop && sends.length === 1 && sends[0] > copies[0] && restored > sends[0] && start > restored, calls.join("\n"));
    assert.deepEqual(archives.map((archive) => archive.bytes["scheduling.json"].toString()), ["[1,2]"]);
  });

  test(`${shell}: publishes the JSON fallback files only once every check after the copy has passed, and a retry discards an earlier unpublished copy`, async () => {
    const shared = mkdtempSync(join(tmpdir(), "deploy-sfu-import-"));
    try {
      const options = { sharedImportDir: shared, diff: wrote("scheduling.json") };
      const aborted = await replaceService(harness, { ...options, files: { "scheduling.json": '["copied before the restart"]' }, restartAt: "json-send" });
      assert.notEqual(aborted.status, 0);
      assert.deepEqual(aborted.archives, [], "a copy from a deploy that refused was published");
      assert.equal(aborted.staged.length, 1, aborted.calls.join("\n"));
      const retried = await replaceService(harness, { ...options, files: { "scheduling.json": '["as it stopped"]' }, startedAt: "2026-11-25T09:30:00.000000000Z", finishedAt: "2026-11-25T10:00:00.000000000Z" });
      assert.equal(retried.status, 0, retried.stderr);
      assert.deepEqual(retried.archives.map((archive) => archive.bytes["scheduling.json"].toString()), ['["as it stopped"]']);
      assert.deepEqual(retried.staged, []);
      assert.equal(retried.archives[0].source, `${OLD_CONTAINER} 2026-11-25T09:30:00.000000000Z_2026-11-25T10:00:00.000000000Z`);
      const publish = callIndex(retried.calls, /^compose .* run .*--entrypoint sh sfu-a -c .*staged copy/);
      assert.ok(publish > callIndex(retried.calls, /^stop old-sfu-a$/) && callIndex(retried.calls, /^compose .* up -d .*sfu-a$/) > publish, retried.calls.join("\n"));
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });

  test(`${shell}: a later deploy keeps the copy an earlier deploy saved`, async () => {
    const shared = mkdtempSync(join(tmpdir(), "deploy-sfu-import-"));
    try {
      const first = await replaceService(harness, { sharedImportDir: shared, deployId: "sfu-first-deploy", diff: wrote("scheduling.json"), files: { "scheduling.json": '["first"]' } });
      assert.equal(first.status, 0, first.stderr);
      const second = await replaceService(harness, { sharedImportDir: shared, deployId: "sfu-second-deploy", diff: wrote("scheduling.json"), files: { "scheduling.json": '["second"]' } });
      assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(second.archives.map((archive) => archive.bytes["scheduling.json"].toString()), ['["first"]', '["second"]']);
      assert.ok(second.archives[0].name.endsWith(`-${first.bootId}`));
      assert.ok(second.archives[1].name.endsWith(`-${second.bootId}`));
      assert.notEqual(first.bootId, second.bootId);
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
      leftStoppedAndRestored(killed.calls);
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

  test(`${shell}: a transfer that fails while unpacking leaves no staging folder and never starts the new SFU`, async () => {
    const { status, calls, archives, importLeftovers, stderr } = await replaceService(harness, { diff: wrote("scheduling.json"), failUnpack: true });
    assert.notEqual(status, 0);
    assert.match(stderr, /unpack-fails/);
    leftStoppedAndRestored(calls);
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

  test(`${shell}: never replaces a saved copy, and never starts the new SFU`, async () => {
    const shared = mkdtempSync(join(tmpdir(), "deploy-sfu-import-"));
    try {
      const options = { sharedImportDir: shared, fixedStamp: "20261124T000000000Z", diff: wrote("scheduling.json") };
      const first = await replaceService(harness, { ...options, files: { "scheduling.json": '["first"]' } });
      assert.equal(first.status, 0, first.stderr);
      const second = await replaceService(harness, { ...options, files: { "scheduling.json": '["second"]' } });
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /never replaced/);
      leftStoppedAndRestored(second.calls);
      assert.deepEqual(second.archives.map((archive) => archive.bytes["scheduling.json"].toString()), ['["first"]']);
      assert.deepEqual(second.importLeftovers, []);
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });

  test(`${shell}: refuses a replacement that never answers healthy as this deploy`, async () => {
    const answers = ["unavailable", "an earlier deploy", "another SFU", "an older image"];
    const outcomes = await Promise.all(answers.map((health) => replaceService(harness, { health })));
    outcomes.forEach(({ status, calls, stderr, healthRequests }, at) => {
      const health = answers[at];
      assert.notEqual(status, 0, `${health} was accepted`);
      const start = callIndex(calls, /^compose .* up -d .*sfu-a$/);
      assert.ok(start >= 0, `${health}\n${calls.join("\n")}`);
      assert.match(stderr, /did not report healthy/, health);
      assert.ok(healthRequests >= 1, `${health}: the deploy never asked for health, so the answer was never checked`);
    });
  });

  test(`${shell}: a payload that arrives changed never starts the new SFU and leaves the old one stopped with its restart policy back`, async () => {
    const { status, calls, imported, corruptions } = await replaceService(harness, {
      diff: wrote("scheduling.json"),
      files: { "scheduling.json": "[\"kept\"]" },
      corrupt: true,
    });
    assertChangedInTransit(corruptions);
    assert.notEqual(status, 0);
    leftStoppedAndRestored(calls);
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

  test(`${shell}: an image that does not name the import folder never starts the new SFU and leaves the old one stopped with its restart policy back`, async () => {
    const { status, calls, imported, volumeEntries } = await replaceService(harness, { diff: wrote("scheduling.json"), imageImportDir: false });
    assert.notEqual(status, 0);
    leftStoppedAndRestored(calls);
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

  test(`${shell}: a failed copy never starts the new SFU and leaves the old one stopped with its restart policy back`, async () => {
    const { status, calls } = await replaceService(harness, {
      diff: wrote("scheduling.json") + wrote("scheduled-meetings.json"),
      cpFail: "scheduled-meetings.json",
    });
    assert.notEqual(status, 0);
    leftStoppedAndRestored(calls);
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
          copiedAfterStop: copied > callIndex(run.calls, /^stop old-sfu-a$/) && callIndex(run.calls, /^compose .* up -d .*sfu-a$/) > copied,
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
      assert.deepEqual(await databaseRows(join(volume, "state", "deeper", "conclave.sqlite")), ["kept"]);
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

  test(`${shell}: rechecks a held source that exits between the Docker state read and its final HTTP status`, async () => {
    const { status, calls, stderr, archives } = await replaceService(harness, {
      running: true,
      failAt: "exit-before-final-status",
      diff: wrote("scheduling.json"),
    });
    assert.equal(status, 0, stderr);
    assert.equal(archives.length, 1);
    const hold = callIndex(calls, /^update --restart=no old-sfu-a$/);
    const restore = callIndex(calls, /^update --restart=unless-stopped old-sfu-a$/);
    const up = callIndex(calls, /^compose .* up -d .*sfu-a$/);
    assert.ok(hold >= 0 && restore > hold && up > restore, calls.join("\n"));
  });

  test(`${shell}: every way a deploy can end after the old SFU's restarts are turned off gives it its restart policy back and says whether it is still running`, async () => {
    const base = {
      containerEnv: "CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite\\n",
      diff: `${wrote("scheduling.json")}A /var/lib/conclave/conclave.sqlite\\nA /var/lib/conclave/conclave.sqlite-wal\\n`,
      files: { "scheduling.json": "[1]", ...sqliteFiles("conclave.sqlite", ["kept"]) },
    };
    const steps = {
      "turning off restarts fails after the update was sent": { failAt: "freeze-fails", running: true, state: "still running" },
      "the stop fails": { failAt: "stop", running: true, state: "still running" },
      "the ownership helper fails": { failAt: "ownership" },
      "a TERM signal arrives during the ownership step": { failAt: "signal" },
      "TERM reaches the deploy PID right after restarts are turned off": { failAt: "term-after-freeze", running: true, state: "on signal" },
      "HUP reaches the deploy PID right after restarts are turned off": { failAt: "hup-after-freeze", running: true, state: "on signal" },
      "INT reaches the deploy PID right after restarts are turned off": { failAt: "int-after-freeze", running: true, state: "on signal" },
      "QUIT reaches the deploy PID right after restarts are turned off": { failAt: "quit-after-freeze", running: true, state: "on signal" },
      "TERM reaches the deploy PID during restore": { failAt: "term-during-restore" },
      "Ctrl+C reaches the deploy group during restore": { failAt: "int-during-restore" },
      "restoring the restart policy fails before replacement": { failAt: "restore-fails" },
      "the source restarts as its policy is restored": { restartAt: "restore", state: "still running" },
      "the staged copy cannot be published": { failAt: "publish" },
      "Ctrl+C (INT to the whole process group) during the ownership step": { failAt: "int-ownership" },
      "it is running again after the stop": { runningAfterStop: true, state: "still running" },
      "copying a JSON file fails": { cpFailAfterStop: "scheduling.json" },
      "the JSON files fail to unpack": { failUnpack: true },
      "the probe fails": { failAt: "probe" },
      "copying the database fails": { cpFailAfterStop: "conclave.sqlite" },
      "the database receiver fails": { failAt: "carry" },
      "it started again after the copy": { startedAfterCarry: "2026-11-25T09:30:00.000000000Z" },
    };
    const runs = await Promise.all(Object.values(steps).map(({ state, ...options }) => replaceService(harness, { ...base, ...options })));
    const outcomes = Object.fromEntries(
      Object.keys(steps).map((name, at) => {
        const { status, calls, stderr, archives } = runs[at];
        const froze = calls.indexOf(`update --restart=no ${OLD_CONTAINER}`);
        return [name, {
          failed: Number.isInteger(status) && status !== 0,
          startedNew: callIndex(calls, / up -d /) >= 0,
          restoredAfterFreeze: froze >= 0 && calls.lastIndexOf(`update --restart=unless-stopped ${OLD_CONTAINER}`) > froze,
          published: archives.length,
          said: stderr.match(/The old sfu-a container is (still running|left stopped)[^\n]*restart policy \(unless-stopped\) restored/)?.[1] ?? stderr.trim().split("\n").slice(-2).join(" | "),
        }];
      }),
    );
    const expected = Object.entries(steps).map(([name, { state = "left stopped" }], at) => {
      const said = state === "on signal" ? (stopped(runs[at].calls) ? "left stopped" : "still running") : state;
      return [name, { failed: true, startedNew: false, restoredAfterFreeze: true, published: 0, said }];
    });
    assert.deepEqual(outcomes, Object.fromEntries(expected));
  });

  test(`${shell}: a restart at any copy step never lets a copy stand for a later state of the old container, and the next deploy carries that later state`, async () => {
    const frozen = "2026-11-25T08:00:00.000000000Z_2026-11-25T08:45:00.000000000Z";
    const later = ["kept", "saved after the restart"];
    const steps = ["json-copy", "json-send", "probe", "sqlite-copy", "carry"];
    const runs = await Promise.all(
      steps.map(async (step) => {
        const volume = mkdtempSync(join(tmpdir(), "deploy-sfu-volume-"));
        const importDir = mkdtempSync(join(tmpdir(), "deploy-sfu-import-"));
        try {
          const base = {
            containerEnv: "CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite\\n",
            diff: `${wrote("scheduling.json")}A /var/lib/conclave/conclave.sqlite\\nA /var/lib/conclave/conclave.sqlite-wal\\n`,
            sharedVolume: volume,
            sharedImportDir: importDir,
          };
          const first = await replaceService(harness, { ...base, files: { "scheduling.json": "[1]", ...sqliteFiles("conclave.sqlite", ["kept"]) }, restartAt: step });
          const stamp = existsSync(join(volume, "conclave.sqlite")) ? await carryStamp(join(volume, "conclave.sqlite")) : null;
          const restoredAfterStop = first.calls.lastIndexOf(`update --restart=unless-stopped ${OLD_CONTAINER}`) > callIndex(first.calls, /^stop old-sfu-a$/);
          const retry = await replaceService(harness, {
            ...base,
            files: { "scheduling.json": "[1,2]", ...sqliteFiles("conclave.sqlite", later) },
            startedAt: "2026-11-25T09:30:00.000000000Z",
            finishedAt: "2026-11-25T10:00:00.000000000Z",
          });
          return {
            refused: first.status !== 0,
            saidWhy: /started again while its files were being copied|running again/.test(first.stderr),
            startedNew: callIndex(first.calls, / up -d /) >= 0,
            restoredAfterStop,
            stampIsFrozen: stamp === null || stamp === frozen,
            retried: retry.status,
            retriedError: retry.status === 0 ? "" : retry.stderr,
            rows: retry.volumeRows["conclave.sqlite"],
          };
        } finally {
          rmSync(volume, { recursive: true, force: true });
          rmSync(importDir, { recursive: true, force: true });
        }
      }),
    );
    const outcomes = Object.fromEntries(steps.map((step, at) => [step, runs[at]]));
    const expected = { refused: true, saidWhy: true, startedNew: false, restoredAfterStop: true, stampIsFrozen: true, retried: 0, retriedError: "", rows: later };
    assert.deepEqual(outcomes, Object.fromEntries(steps.map((step) => [step, expected])));
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
      assert.match(run.stderr, name === "still running after the stop" ? /is still running, with its restart policy \(unless-stopped\) restored/ : /left stopped, not removed, with its restart policy \(unless-stopped\) restored; start it again with: .* start sfu-a/, name);
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
    assert.ok(callIndex(calls, /^compose .* up -d .*sfu-a$/) >= 0);
  });
}

const pathHarnesses = [
  {
    name: "bash",
    command: bash,
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

test("every store path the deploy reads from an old container is the path the SFU's own store code uses", async () => {
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

describe(SUITE, { concurrency: Math.min(8, availableParallelism()) }, () => {
  for (const { name, body } of registered) nodeTest(name, body);
});
