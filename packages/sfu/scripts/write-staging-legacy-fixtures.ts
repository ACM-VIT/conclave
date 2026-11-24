import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGING_COMMIT } from "./write-staging-rollback-fixtures.js";

export const STAGING_LEGACY_SECRET = "staging-legacy-fixture-secret";
export const STAGING_LEGACY_PREFIX = "staging";
export const STAGING_LEGACY_MODES = ["json", "sqlite", "redis"] as const;
export const STAGING_LEGACY_PHASES = ["phase-1", "phase-2"] as const;
export type StagingLegacyMode = (typeof STAGING_LEGACY_MODES)[number];
export type StagingLegacyPhase = (typeof STAGING_LEGACY_PHASES)[number];

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const stagingLegacyDir = join(packageDir, "test", "fixtures", "legacy-stores", `staging-${STAGING_COMMIT.slice(0, 8)}`);
const MANIFEST = "manifest.json";

export type SqliteDump = { tables: Record<string, { sql: string; rows: Array<Record<string, unknown>> }> };
export type RedisDump = SqliteDump & { redis: Record<string, { type: "hash"; value: Record<string, string> } | { type: "string"; value: string }> };

const RUNNER = String.raw`
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const mode = process.env.LEGACY_FIXTURE_MODE;
const out = process.env.LEGACY_FIXTURE_OUT;
const DAY = 86_400_000;
let next = 1;
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "access-" + next++, expires_in: 3600 });
  if (url.hostname.endsWith("googleapis.com")) {
    if (url.pathname.endsWith("/freeBusy")) return json({ calendars: { primary: { busy: [] } } });
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return json({ id: "event-" + next++ });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json({});
  }
  if (url.origin === process.env.SCHEDULING_EMAIL_WORKER_URL) return json({ ok: true });
  return original(input, init);
};

const { config } = await import("./config/config.js");
const { createSfuApp } = await import("./server/http/createApp.js");
const { initScheduledMeetings, initScheduledWebinars, initScheduling } = await import("./server/init.js");
const { LocalRoomRegistry } = await import("./server/roomRegistry.js");
const { createSfuState } = await import("./server/state.js");

const state = createSfuState({ roomRegistry: new LocalRoomRegistry({ instanceId: "staging", instanceUrl: "http://localhost", ttlMs: 45000 }) });
initScheduledWebinars(state);
await initScheduledMeetings(state);
await initScheduling(state);
const server = createServer(createSfuApp({ state, config, getIo: () => null }));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const HOST = { "x-user-id": "host-user", "x-user-email": "host@example.test", "x-user-name": "Host" };
const call = async (method, path, body, headers = HOST) => {
  const response = await fetch("http://127.0.0.1:" + port + path, {
    method,
    headers: { "x-sfu-secret": config.sfuSecret, "x-sfu-client": "conclave", "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (response.status >= 300) throw new Error(method + " " + path + " answered " + response.status + ": " + text);
  return parsed;
};

const sqliteDump = () => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(process.env.CONCLAVE_SQLITE_PATH);
  const tables = {};
  for (const name of ["scheduling_records", "scheduled_meetings", "scheduled_webinars"]) {
    const found = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (!found) continue;
    tables[name] = { sql: found.sql, rows: db.prepare("SELECT * FROM " + name + " ORDER BY rowid").all().map((row) => ({ ...row })) };
  }
  db.close();
  return { tables };
};

const dump = async (phase) => {
  mkdirSync(out, { recursive: true });
  if (mode === "json") {
    const folder = join(out, phase);
    mkdirSync(folder, { recursive: true });
    for (const [variable, name] of [["SCHEDULING_PATH", "scheduling.json"], ["SCHEDULED_MEETINGS_PATH", "scheduled-meetings.json"], ["SCHEDULED_WEBINARS_PATH", "scheduled-webinars.json"]]) {
      if (existsSync(process.env[variable])) writeFileSync(join(folder, name), readFileSync(process.env[variable], "utf8"));
    }
    return;
  }
  const result = sqliteDump();
  if (mode === "redis") {
    const { createClient } = await import("redis");
    const client = createClient({ url: process.env.SFU_PERSISTENCE_REDIS_URL });
    await client.connect();
    const prefix = process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX + ":";
    result.redis = {};
    for (const key of (await client.keys(prefix + "*")).sort()) {
      const suffix = key.slice(prefix.length);
      if (suffix.includes("lock")) continue;
      const type = await client.type(key);
      if (type === "hash") result.redis[suffix] = { type, value: await client.hGetAll(key) };
      else if (type === "string") result.redis[suffix] = { type, value: await client.get(key) };
    }
    await client.quit();
  }
  writeFileSync(join(out, phase + ".json"), JSON.stringify(result, null, 2) + "\n");
};

const profile = (await call("GET", "/scheduling/profile")).profile;
await call("PUT", "/scheduling/profile", { timeZone: "Asia/Kolkata" });
await call("PUT", "/scheduling/availability/default", {
  timeZone: "Asia/Kolkata",
  windows: [1, 2, 3, 4, 5].map((day) => ({ day, startMinutes: 540, endMinutes: 1020 })),
  overrides: [{ date: "2099-01-01", unavailable: true, windows: [] }],
});
const eventType = (await call("POST", "/scheduling/event-types", { title: "Intro", slug: "intro", isActive: true, minimumNoticeMinutes: 0, bufferAfterMinutes: 15 })).eventType;
await call("POST", "/scheduling/calendar/google", { refreshToken: "refresh-one", accessToken: "access-one", accessTokenExpiresAt: 4_000_000_000_000, scopes: ["calendar"] });
const weekly = (await call("POST", "/scheduled-meetings", { title: "Weekly", scheduledStartAt: 4_000_000_000_000, roomCode: "team-sync" })).scheduledMeeting;
const daily = (await call("POST", "/scheduled-meetings", { title: "Daily", scheduledStartAt: 4_100_000_000_000, roomCode: "daily-sync" })).scheduledMeeting;
const retro = (await call("POST", "/scheduled-meetings", { title: "Retro", scheduledStartAt: 4_200_000_000_000, roomCode: "retro-sync" })).scheduledMeeting;
await call("POST", "/scheduled-meetings/" + retro.id + "/cancel");
const launch = (await call("POST", "/scheduled-webinars", { title: "Launch", scheduledStartAt: 4_000_000_000_000, linkSlug: "launch-day", coHosts: [{ email: "co@example.test" }] })).scheduledWebinar;
await call("POST", "/scheduled-webinars", { title: "Town hall", scheduledStartAt: 4_100_000_000_000, linkSlug: "town-hall" });
const firstSlot = Math.ceil((Date.now() + 3 * DAY) / 1_800_000) * 1_800_000;
let booked = null;
for (let at = firstSlot; !booked && at < firstSlot + 10 * DAY; at += 1_800_000) {
  try {
    booked = await call("POST", "/scheduling/public/" + profile.username + "/intro/book", { startAt: at, attendeeName: "Guest", attendeeEmail: "guest@example.test" }, {});
  } catch {
    booked = null;
  }
}
if (!booked) throw new Error("staging booked no slot");
await dump("phase-1");

await call("PATCH", "/scheduled-meetings/" + weekly.id, { title: "Weekly, moved by the old SFU" });
await call("DELETE", "/scheduled-meetings/" + daily.id);
await call("PATCH", "/scheduled-webinars/" + launch.id, { title: "Launch, renamed by the old SFU" });
await call("PUT", "/scheduling/profile", { timeZone: "Europe/Berlin" });
await call("PATCH", "/scheduling/event-types/" + eventType.id, { durationMinutes: 45 });
await call("DELETE", "/scheduling/calendar/google");
await call("POST", "/scheduling/calendar/google", { refreshToken: "refresh-two", accessToken: "access-two", accessTokenExpiresAt: 4_000_000_000_000, scopes: ["calendar"] });
await call("POST", "/scheduled-meetings", { title: "Added by the old SFU during the deploy", scheduledStartAt: 4_300_000_000_000, roomCode: "late-sync" });
await dump("phase-2");

server.close();
server.closeAllConnections?.();
for (const persistence of [state.scheduledWebinarPersistence, state.scheduledMeetingPersistence, state.schedulingPersistence]) await persistence?.close?.();
process.exit(0);
`;

const run = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}${result.stdout}`);
  return result.stdout;
};

const freePort = (): Promise<number> =>
  new Promise((done, failed) => {
    const probe = createServer();
    probe.once("error", failed);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === "object" ? done(address.port) : failed(new Error("no port"))));
    });
  });

const startRedis = async (dir: string): Promise<{ url: string; child: ChildProcess }> => {
  const port = await freePort();
  const child = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", dir], { stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnSync("redis-cli", ["-p", String(port), "ping"], { encoding: "utf8" }).stdout.trim() === "PONG") {
      return { url: `redis://127.0.0.1:${port}`, child };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error("redis-server did not start");
};

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

const generate = async () => {
  if (spawnSync("git", ["cat-file", "-e", `${STAGING_COMMIT}^{commit}`], { cwd: packageDir }).status !== 0) {
    console.error(`These fixtures come from staging's own code at ${STAGING_COMMIT}, which this clone does not have. Run: git fetch origin ${STAGING_COMMIT}`);
    process.exit(1);
  }
  const work = mkdtempSync(join(tmpdir(), "staging-legacy-"));
  try {
    const repoRoot = run("git", ["rev-parse", "--show-toplevel"], { cwd: packageDir }).trim();
    const archive = join(work, "staging.tar");
    run("git", ["archive", "--format=tar", "-o", archive, STAGING_COMMIT, "packages/sfu"], { cwd: repoRoot });
    run("tar", ["-xf", archive, "-C", work]);
    const stagingPackage = join(work, "packages", "sfu");
    symlinkSync(join(packageDir, "node_modules"), join(stagingPackage, "node_modules"), "dir");
    symlinkSync(join(repoRoot, "node_modules"), join(work, "node_modules"), "dir");
    writeFileSync(join(stagingPackage, "legacy-runner.ts"), RUNNER);
    const output = join(work, "out");
    for (const mode of STAGING_LEGACY_MODES) {
      const state = join(work, "state", mode);
      mkdirSync(state, { recursive: true });
      const redis = mode === "redis" ? await startRedis(state) : null;
      try {
        run(process.execPath, ["--import", import.meta.resolve("tsx"), "legacy-runner.ts"], {
          cwd: stagingPackage,
          env: {
            PATH: process.env.PATH,
            HOME: work,
            TZ: "UTC",
            NODE_ENV: "test",
            LEGACY_FIXTURE_MODE: mode,
            LEGACY_FIXTURE_OUT: join(output, mode),
            SCHEDULING_PERSISTENCE: mode,
            SCHEDULED_MEETINGS_PERSISTENCE: mode,
            SCHEDULED_WEBINARS_PERSISTENCE: mode === "redis" ? "sqlite" : mode,
            SCHEDULING_PATH: join(state, "scheduling.json"),
            SCHEDULED_MEETINGS_PATH: join(state, "scheduled-meetings.json"),
            SCHEDULED_WEBINARS_PATH: join(state, "scheduled-webinars.json"),
            CONCLAVE_SQLITE_PATH: join(state, "conclave.sqlite"),
            SFU_PERSISTENCE_REDIS_URL: redis?.url ?? "",
            SFU_PERSISTENCE_REDIS_KEY_PREFIX: STAGING_LEGACY_PREFIX,
            SCHEDULING_TOKEN_SECRET: STAGING_LEGACY_SECRET,
            SCHEDULING_EMAIL_WORKER_URL: "http://email.fixture.test",
            SCHEDULING_EMAIL_WORKER_SECRET: "fixture",
            GOOGLE_CLIENT_ID: "fixture-client",
            GOOGLE_CLIENT_SECRET: "fixture-secret",
          },
        });
      } finally {
        redis?.child.kill();
      }
    }
    rmSync(stagingLegacyDir, { recursive: true, force: true });
    cpSync(output, stagingLegacyDir, { recursive: true });
    const files = Object.fromEntries(
      filesUnder(stagingLegacyDir)
        .map((path) => [relative(stagingLegacyDir, path), sha256(readFileSync(path, "utf8"))] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    writeFileSync(join(stagingLegacyDir, MANIFEST), `${JSON.stringify({ stagingCommit: STAGING_COMMIT, files }, null, 2)}\n`);
    console.log(`Wrote ${Object.keys(files).length} files staging's own code wrote to ${stagingLegacyDir}.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

export const verifyStagingLegacyFixtures = (dir: string = stagingLegacyDir): string[] => {
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) return [`${manifestPath} is missing. Run pnpm generate:legacy-store-fixtures.`];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { stagingCommit: string; files: Record<string, string> };
  const problems: string[] = [];
  if (manifest.stagingCommit !== STAGING_COMMIT) problems.push(`${manifestPath} records ${manifest.stagingCommit}, not ${STAGING_COMMIT}.`);
  const present = filesUnder(dir)
    .map((path) => relative(dir, path))
    .filter((path) => path !== MANIFEST)
    .sort();
  const listed = Object.keys(manifest.files).sort();
  if (present.join("\n") !== listed.join("\n")) problems.push(`${dir} holds ${present.join(", ")}, but ${manifestPath} lists ${listed.join(", ")}.`);
  for (const path of listed) {
    const full = join(dir, path);
    if (existsSync(full) && sha256(readFileSync(full, "utf8")) !== manifest.files[path]) {
      problems.push(`${full} is not the file staging's code wrote (its SHA-256 differs from ${manifestPath}).`);
    }
  }
  return problems;
};

export const stagingLegacyFile = (mode: StagingLegacyMode, phase: StagingLegacyPhase, name?: string): string =>
  mode === "json" ? join(stagingLegacyDir, mode, phase, name ?? "") : join(stagingLegacyDir, mode, `${phase}.json`);

const main = async () => {
  if (process.argv.includes("--check")) {
    const problems = verifyStagingLegacyFixtures();
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log("The staging legacy store fixtures match their recorded hashes.");
    return;
  }
  await generate();
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
