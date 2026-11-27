import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { specOf } from "../server/controlPlane/entities.js";
import { readLegacyFile } from "../server/controlPlane/legacy.js";
import type { LegacyDomain } from "../server/controlPlane/model.js";

export const STAGING_COMMIT = "3d2711d9a056f652ea19bedf74dec4edb192339e";
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

type Manifest = { stagingCommit: string; files: Record<string, string> };

const MANIFEST = "manifest.json";
const domains: Record<string, LegacyDomain> = {
  "scheduled-meetings": "meetings",
  "scheduled-webinars": "webinars",
  scheduling: "scheduling",
};

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

const readsBack = (name: string, content: string): string | null => {
  try {
    const records = readLegacyFile(domains[name], content, name);
    if (records.length === 0) return "holds no record this SFU imports";
    const drifted = records.filter((record) => {
      const spec = specOf(record.kind);
      const stored = spec.decode(JSON.parse(JSON.stringify(spec.encode(record.value))) as unknown);
      return !isDeepStrictEqual(stored, record.value);
    });
    return drifted.length === 0 ? null : `does not read back the same after this SFU imports it (${drifted.map((record) => record.key).join(", ")})`;
  } catch (error) {
    return `cannot be read by this SFU (${(error as Error).message})`;
  }
};

export const verifyStagingRollbackFixtures = (dir: string = outputDir): string[] => {
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) return [`${manifestPath} is missing. Run pnpm generate:json-store-fixtures.`];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const problems: string[] = [];
  if (manifest.stagingCommit !== STAGING_COMMIT) problems.push(`${manifestPath} records ${manifest.stagingCommit}, not ${STAGING_COMMIT}.`);
  const expected = stagingRollbackStores.map((store) => basename(stagingRollbackFixture(store.name))).sort();
  if (!isDeepStrictEqual(Object.keys(manifest.files).sort(), expected)) problems.push(`${manifestPath} lists ${Object.keys(manifest.files).join(", ")}, not ${expected.join(", ")}.`);
  const secret = process.env.SCHEDULING_TOKEN_SECRET;
  process.env.SCHEDULING_TOKEN_SECRET = STAGING_ROLLBACK_TOKEN_SECRET;
  try {
    for (const store of stagingRollbackStores) {
      const file = basename(stagingRollbackFixture(store.name));
      const path = join(dir, file);
      if (!existsSync(path)) {
        problems.push(`${path} is missing.`);
        continue;
      }
      const content = readFileSync(path, "utf8");
      if (sha256(content) !== manifest.files[file]) problems.push(`${path} is not the file staging's code wrote (its SHA-256 differs from ${manifestPath}).`);
      const readBack = readsBack(store.name, content);
      if (readBack) problems.push(`${path} ${readBack}.`);
    }
  } finally {
    if (secret === undefined) delete process.env.SCHEDULING_TOKEN_SECRET;
    else process.env.SCHEDULING_TOKEN_SECRET = secret;
  }
  return problems;
};

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

const stagingCommitPresent = () => spawnSync("git", ["cat-file", "-e", `${STAGING_COMMIT}^{commit}`], { cwd: packageDir }).status === 0;

const generate = () => {
  if (!stagingCommitPresent()) {
    console.error(
      `Regenerating these fixtures runs staging's own store code from ${STAGING_COMMIT}, and this clone does not have that commit. Fetch it, then run this again:\n  git fetch origin ${STAGING_COMMIT}`,
    );
    process.exit(1);
  }
  const written = writeWithStaging();
  const manifest: Manifest = { stagingCommit: STAGING_COMMIT, files: {} };
  mkdirSync(outputDir, { recursive: true });
  for (const [name, content] of written) {
    const path = stagingRollbackFixture(name);
    writeFileSync(path, content);
    manifest.files[basename(path)] = sha256(content);
  }
  writeFileSync(join(outputDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${written.size} files written by staging's store code, and their hashes to ${MANIFEST}.`);
};

const check = () => {
  const problems = verifyStagingRollbackFixtures();
  if (problems.length > 0) {
    console.error(`The staging rollback fixtures do not check out:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("The staging rollback fixtures match their recorded hashes and read back through this SFU's stores.");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) check();
  else generate();
}
