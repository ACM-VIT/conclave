import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STAGING_COMMIT = "3d2711d9a056f652ea19bedf74dec4edb192339e";
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(packageDir, "test", "fixtures", "json-stores");
const outputDir = join(fixturesDir, "staging-rollback");

export const stagingRollbackStores = [
  { name: "scheduled-meetings", legacy: "scheduled-meetings.2026-05-21.json", modeVariable: "SCHEDULED_MEETINGS_PERSISTENCE", pathVariable: "SCHEDULED_MEETINGS_PATH" },
  { name: "scheduled-webinars", legacy: "scheduled-webinars.2026-05-21.json", modeVariable: "SCHEDULED_WEBINARS_PERSISTENCE", pathVariable: "SCHEDULED_WEBINARS_PATH" },
  { name: "scheduling", legacy: "scheduling.2026-06-27.json", modeVariable: "SCHEDULING_PERSISTENCE", pathVariable: "SCHEDULING_PATH" },
] as const;

export const STAGING_ROLLBACK_TOKEN_SECRET = "staging-rollback-fixture-secret";
export const stagingRollbackFixture = (name: string) => join(outputDir, `${name}.staging-${STAGING_COMMIT.slice(0, 8)}.json`);

const RUNNER = `import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const crypto = require("node:crypto");
let counter = 0;
crypto.randomBytes = (size) => Buffer.from(Array.from({ length: size }, () => (counter++ * 131 + 7) & 0xff));
crypto.randomUUID = () => "00000000-0000-4000-8000-" + String(++counter).padStart(12, "0");
syncBuiltinESMExports();
let seed = 1;
Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
Date.now = () => 1_790_000_000_000;

const HOST = { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test", defaultHostUserId: null };
const [store] = process.argv.slice(2);

if (store === "scheduled-meetings") {
  const meetings = await import("./server/scheduledMeetings.ts");
  const persistence = meetings.createScheduledMeetingPersistence();
  const live = meetings.createScheduledMeetingStore();
  await meetings.loadPersistedMeetings(live, persistence);
  const created = meetings.createScheduledMeeting(live, { title: "Booked during the rollback", scheduledStartAt: 1_790_100_000_000 }, HOST);
  await meetings.persistScheduledMeetingChanges(live, persistence, [created]);
  Date.now = () => 1_790_000_600_000;
  const edited = meetings.updateScheduledMeeting(live, created.id, { title: "Renamed during the rollback" });
  await meetings.persistScheduledMeetingChanges(live, persistence, [edited]);
  await persistence.close?.();
} else if (store === "scheduled-webinars") {
  const webinars = await import("./server/scheduledWebinars.ts");
  const persistence = webinars.createScheduledWebinarPersistence();
  const live = webinars.createScheduledWebinarStore();
  webinars.loadPersistedSchedules(live, persistence);
  const { webinar } = webinars.createScheduledWebinar(live, { title: "Booked during the rollback", scheduledStartAt: 1_790_100_000_000, linkSlug: "rollback-day" }, HOST);
  webinars.persistScheduledWebinarChanges(live, persistence, [webinar]);
  Date.now = () => 1_790_000_600_000;
  const edited = webinars.updateScheduledWebinar(live, webinar.id, { title: "Renamed during the rollback" }).webinar;
  webinars.persistScheduledWebinarChanges(live, persistence, [edited]);
} else if (store === "scheduling") {
  const scheduling = await import("./server/scheduling.ts");
  const persistence = scheduling.createSchedulingPersistence();
  const live = scheduling.createSchedulingStore();
  await scheduling.loadPersistedScheduling(live, persistence);
  const profile = scheduling.ensureSchedulingProfile(live, { clientId: "conclave", userId: "rollback-user", email: "rollback@example.test", name: "Booked during the rollback" });
  await scheduling.persistScheduling(live, persistence);
  Date.now = () => 1_790_000_600_000;
  scheduling.updateSchedulingProfile(live, profile.id, { name: "Renamed during the rollback" });
  await scheduling.persistScheduling(live, persistence);
  await persistence.close?.();
} else {
  throw new Error("unknown store " + store);
}
`;

const run = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}${result.stdout}`);
  return result.stdout;
};

const writeWithStaging = (): Map<string, string> => {
  const work = mkdtempSync(join(tmpdir(), "staging-rollback-"));
  try {
    const repoRoot = run("git", ["rev-parse", "--show-toplevel"], { cwd: packageDir }).trim();
    const archive = join(work, "staging.tar");
    run("git", ["archive", "--format=tar", "-o", archive, STAGING_COMMIT, "packages/sfu"], { cwd: repoRoot });
    run("tar", ["-xf", archive, "-C", work]);
    const stagingPackage = join(work, "packages", "sfu");
    symlinkSync(join(packageDir, "node_modules"), join(stagingPackage, "node_modules"), "dir");
    symlinkSync(join(repoRoot, "node_modules"), join(work, "node_modules"), "dir");
    writeFileSync(join(stagingPackage, "rollback-runner.ts"), RUNNER);
    const written = new Map<string, string>();
    for (const store of stagingRollbackStores) {
      const state = join(work, "state", store.name);
      mkdirSync(state, { recursive: true });
      const storePath = join(state, `${store.name}.json`);
      copyFileSync(join(fixturesDir, store.legacy), storePath);
      run(process.execPath, ["--import", import.meta.resolve("tsx"), "rollback-runner.ts", store.name], {
        cwd: stagingPackage,
        env: {
          PATH: process.env.PATH,
          HOME: work,
          TZ: "UTC",
          [store.modeVariable]: "json",
          [store.pathVariable]: storePath,
          CONCLAVE_SQLITE_PATH: join(state, "unused.sqlite"),
          CONCLAVE_FALLBACK_IMPORT_DIR: "",
          SCHEDULING_TOKEN_SECRET: STAGING_ROLLBACK_TOKEN_SECRET,
        },
      });
      written.set(store.name, readFileSync(storePath, "utf8"));
    }
    return written;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

const main = () => {
  const check = process.argv.includes("--check");
  const written = writeWithStaging();
  const drifted: string[] = [];
  for (const [name, content] of written) {
    const path = stagingRollbackFixture(name);
    if (check) {
      if (!existsSync(path) || readFileSync(path, "utf8") !== content) drifted.push(path);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  if (drifted.length > 0) {
    console.error(`These files are not what staging's store code writes. Rerun without --check:\n${drifted.join("\n")}`);
    process.exit(1);
  }
  console.log(check ? "The staging rollback fixtures match staging's store code." : `Wrote ${written.size} files written by staging's store code.`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
