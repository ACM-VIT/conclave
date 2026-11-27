import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const sharedStoreSingletons = [
  "AppState",
  "MeetingViewModel",
  "SystemNotifications",
  "AppearancePreference",
  "LocalVideoMirrorPreference",
  "ConclaveFeedbackPlayer",
];

const testRules = [
  { pattern: /\bUserDefaults\s*\.\s*standard\b/, reason: "names UserDefaults.standard" },
  { pattern: /\bdefaults\s*:\s*\.standard\b/, reason: "passes .standard as a preferences store" },
  {
    pattern: new RegExp(`\\b(?:${sharedStoreSingletons.join("|")})\\s*\\.\\s*shared\\b`),
    reason: "uses a singleton that reads and writes UserDefaults.standard",
  },
];

const sourceRules = [
  {
    pattern: /:\s*UserDefaults\s*=\s*(?:UserDefaults)?\s*\.\s*standard\b/,
    reason: "defaults a preferences store to UserDefaults.standard, so a caller that omits it shares the app's store",
  },
];

export function swiftFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...swiftFiles(full));
    else if (entry.name.endsWith(".swift")) found.push(full);
  }
  return found;
}

function lineProblems(file, text, rules) {
  const problems = [];
  text.split("\n").forEach((line, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(line)) problems.push({ file, line: index + 1, reason: rule.reason });
    }
  });
  return problems;
}

export function testProblems(file, text) {
  return lineProblems(file, text, testRules);
}

export function sourceProblems(file, text) {
  return lineProblems(file, text, sourceRules);
}

export function singletonProblems(sources) {
  return sharedStoreSingletons
    .filter((name) => !sources.some(({ text }) =>
      new RegExp(`\\b(?:class|struct|enum)\\s+${name}\\b`).test(text)
      && /\bstatic\s+let\s+shared\b/.test(text)
      && /\bUserDefaults\.standard\b/.test(text)))
    .map((name) => ({ file: "scripts/check-native-test-stores.mjs", line: 0, reason: `${name}.shared is no longer built on UserDefaults.standard; update sharedStoreSingletons` }));
}

export function problems(root = repoRoot) {
  const read = (dir) => swiftFiles(path.join(root, dir)).map((full) => ({
    file: path.relative(root, full),
    text: readFileSync(full, "utf8"),
  }));
  const tests = read("apps/conclave-skip/Tests");
  const sources = read("apps/conclave-skip/Sources");
  return [
    ...tests.flatMap(({ file, text }) => testProblems(file, text)),
    ...sources.flatMap(({ file, text }) => sourceProblems(file, text)),
    ...singletonProblems(sources),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag === -1 ? repoRoot : path.resolve(process.argv[rootFlag + 1]);
  const found = problems(root);
  if (found.length) {
    for (const problem of found) console.error(`${problem.file}:${problem.line} ${problem.reason}`);
    console.error(`${found.length} native preference store problem(s). Tests pass a private store: IsolatedDefaults.make() or isolatedViewModel().`);
    process.exit(1);
  }
  console.log("native tests use private preference stores");
}
