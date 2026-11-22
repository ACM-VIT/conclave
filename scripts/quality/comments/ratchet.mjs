#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countDisallowed, extractComments, extractFile, listSourceFiles } from "./extract.mjs";
import { ESLINT_LANGUAGE, configuresNoComments, isFirstPartySource, languageOf, switchesOffNoComments } from "./policy.mjs";

export const BASELINE_FILE = "scripts/quality/comments/baseline.json";
export const ESLINT_SUPPRESSION_FILES = ["eslint-suppressions.json", "apps/web/eslint-suppressions.json"];
const DEFAULT_BASE = "origin/staging";
const UPDATE_COMMAND = "node scripts/quality/comments/ratchet.mjs --update";

const git = (repo, args) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });

const tryGit = (repo, args) => {
  try {
    return git(repo, args);
  } catch {
    return undefined;
  }
};

const ratchetedRecords = (repo) =>
  listSourceFiles(repo)
    .filter((file) => languageOf(file) !== ESLINT_LANGUAGE)
    .flatMap((file) => extractFile(repo, file));

export const compareCounts = (baseline, current) => {
  const rises = [];
  const falls = [];
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const from = baseline[file] ?? 0;
    const to = current[file] ?? 0;
    if (to > from) rises.push({ file, from, to });
    else if (to < from) falls.push({ file, from, to });
  }
  const byFile = (a, b) => (a.file < b.file ? -1 : 1);
  return { rises: rises.sort(byFile), falls: falls.sort(byFile) };
};

const flattenSuppressions = (suppressions) =>
  Object.fromEntries(
    Object.entries(suppressions).flatMap(([file, rules]) =>
      Object.entries(rules).map(([rule, { count }]) => [`${file} ${rule}`, count]),
    ),
  );

const RATCHET_FILES = [
  { file: BASELINE_FILE, flatten: (counts) => counts },
  ...ESLINT_SUPPRESSION_FILES.map((file) => ({ file, flatten: flattenSuppressions })),
];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

const parentOfHead = (repo) => tryGit(repo, ["rev-parse", "--verify", "--quiet", "HEAD^1"])?.trim();

export const resolveBase = (repo, baseRef, mode = "merge-base") => {
  const commit = tryGit(repo, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`])?.trim();
  if (mode === "exact") {
    if (commit) return { base: commit };
    const parent = parentOfHead(repo);
    return parent
      ? { base: parent, note: `${baseRef} is not available, so comparing with HEAD^1` }
      : { skipped: `${baseRef} is not available and HEAD has no parent` };
  }
  if (!commit) return { skipped: `${baseRef} is not available` };
  const base = tryGit(repo, ["merge-base", "HEAD", baseRef])?.trim();
  if (!base) return { skipped: `HEAD shares no history with ${baseRef}` };
  if (base !== tryGit(repo, ["rev-parse", "HEAD"])?.trim()) return { base };
  if (tryGit(repo, ["status", "--porcelain", "--untracked-files=no"])?.trim()) return { base };
  const parent = parentOfHead(repo);
  return parent ? { base: parent } : { skipped: "HEAD has no parent to compare with" };
};

const disallowedIn = (text, file) =>
  text === undefined ? 0 : extractComments(text, file).filter((comment) => !comment.allowed).length;

const readIfPresent = (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);

export const countRisesSinceBase = (repo, base) =>
  (tryGit(repo, ["diff", "--name-only", "-z", base, "--"]) ?? "")
    .split("\0")
    .filter((file) => file !== "" && isFirstPartySource(file))
    .map((file) => ({
      file,
      from: disallowedIn(tryGit(repo, ["show", `${base}:${file}`]), file),
      to: disallowedIn(readIfPresent(path.join(repo, file)), file),
    }))
    .filter(({ from, to }) => to > from);

export const growthSinceBase = (repo, baseRef, mode) => {
  const resolved = resolveBase(repo, baseRef, mode);
  if (resolved.skipped) return resolved;
  const { base, note } = resolved;
  const rises = RATCHET_FILES.flatMap(({ file, flatten }) => {
    const before = tryGit(repo, ["show", `${base}:${file}`]);
    const local = path.join(repo, file);
    if (before === undefined || !existsSync(local)) return [];
    return compareCounts(flatten(JSON.parse(before)), flatten(readJson(local))).rises.map((rise) => ({
      ...rise,
      baseline: file,
    }));
  });
  return { base, note, rises, countRises: countRisesSinceBase(repo, base) };
};

export const inlineNoCommentsDisables = (repo) => {
  const candidates = tryGit(repo, ["grep", "-l", "-z", "-E", "eslint", "--", "*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"]);
  if (!candidates) return [];
  const files = new Set(listSourceFiles(repo));
  return candidates
    .split("\0")
    .filter((file) => files.has(file))
    .flatMap((file) => extractFile(repo, file))
    .filter((record) => switchesOffNoComments(record.text));
};

const describe = (records, file) =>
  records
    .filter((record) => record.file === file && !record.allowed)
    .map((record) => `    ${record.file}:${record.line}  ${record.text.split("\n")[0].slice(0, 100)}`)
    .join("\n");

const check = (repo, baseline, baseRef, mode) => {
  const records = ratchetedRecords(repo);
  const { rises, falls } = compareCounts(baseline, countDisallowed(records));
  const growth = growthSinceBase(repo, baseRef, mode);
  if (growth.note) console.log(`comment ratchet: ${growth.note}.`);
  const disables = inlineNoCommentsDisables(repo);
  const failures = [];
  for (const { file, from, to } of rises) {
    failures.push(`${file}: ${from === 0 ? `new comments (${to})` : `comments rose from ${from} to ${to}`}\n${describe(records, file)}`);
  }
  for (const record of disables) {
    failures.push(
      configuresNoComments(record.text)
        ? `${record.file}:${record.line}: this inline config switches off conclave/no-comments. Delete it.`
        : `${record.file}:${record.line}: this directive switches off conclave/no-comments. Name the rules it disables.`,
    );
  }
  const reported = new Set(rises.map(({ file }) => file));
  for (const { file, from, to } of (growth.countRises ?? []).filter(({ file }) => !reported.has(file))) {
    failures.push(`${file}: comments rose from ${from} to ${to} since ${growth.base.slice(0, 8)}.`);
  }
  for (const { baseline: file, file: key, from, to } of growth.rises ?? []) {
    failures.push(`${file}: ${key} rose from ${from} to ${to} since ${growth.base.slice(0, 8)}. Baselines only go down.`);
  }
  if (growth.skipped) console.log(`comment ratchet: baseline growth check skipped (${growth.skipped}).`);
  if (falls.length > 0) {
    console.log(`comment ratchet: ${falls.length} file(s) have fewer comments than the baseline. Run \`${UPDATE_COMMAND}\` to lower it.`);
  }
  if (failures.length === 0) {
    console.log("comment ratchet: no new comments in Swift, Kotlin, CSS, shell or Python.");
    return 0;
  }
  console.error(
    [
      "comment ratchet failed. Delete the new comments: say it with names, types or tests, or record the decision in docs/adr.",
      ...failures,
    ].join("\n"),
  );
  return 1;
};

const writeBaseline = (file, counts) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(counts, null, 2)}\n`);
};

const update = (repo, baselineFile, baseline) => {
  const current = countDisallowed(ratchetedRecords(repo));
  const { rises, falls } = compareCounts(baseline, current);
  if (rises.length > 0) {
    console.error(
      [
        "comment ratchet: --update only lowers counts. These files would rise:",
        ...rises.map(({ file, from, to }) => `  ${file}: ${from} -> ${to}`),
      ].join("\n"),
    );
    return 1;
  }
  writeBaseline(baselineFile, current);
  console.log(`comment ratchet: lowered ${falls.length} file(s); ${Object.values(current).reduce((sum, count) => sum + count, 0)} comment(s) remain.`);
  return 0;
};

const init = (repo, baselineFile) => {
  if (existsSync(baselineFile)) {
    console.error(`comment ratchet: ${BASELINE_FILE} already exists. Use --update, which only lowers counts.`);
    return 1;
  }
  writeBaseline(baselineFile, countDisallowed(ratchetedRecords(repo)));
  console.log(`comment ratchet: wrote ${BASELINE_FILE}.`);
  return 0;
};

const main = () => {
  const args = process.argv.slice(2);
  const repoFlag = args.indexOf("--repo");
  const repo = path.resolve(repoFlag === -1 ? git(".", ["rev-parse", "--show-toplevel"]).trim() : args[repoFlag + 1]);
  const baselineFile = path.join(repo, BASELINE_FILE);
  if (args.includes("--init")) return init(repo, baselineFile);
  const baseline = existsSync(baselineFile) ? readJson(baselineFile) : {};
  if (args.includes("--update")) return update(repo, baselineFile, baseline);
  return check(repo, baseline, process.env.COMMENT_RATCHET_BASE || DEFAULT_BASE, process.env.COMMENT_RATCHET_MODE || "merge-base");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
