import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ownerSdk = 28;
export const ruleFile = "apps/conclave-skip/Tests/ConclaveTests/Skip/SharedUrlHandlerSandbox.kt";

const robolectric = /@RunWith\(\s*RobolectricTestRunner::class\s*\)/;
const ruleUse = /@get:Rule\s+(?:val|var)\s+\w+\s*(?::\s*SharedUrlHandlerSandbox\s*)?=\s*SharedUrlHandlerSandbox\(\)/;
const handlerReset = /getDeclaredField\(\s*"registered"\s*\)/;

export function kotlinFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...kotlinFiles(full));
    else if (entry.name.endsWith(".kt")) found.push(full);
  }
  return found;
}

function configs(text) {
  const found = [];
  const pattern = /^([ \t]*)(?:@Test\s+)?@Config\(([^)]*)\)/gm;
  for (const match of text.matchAll(pattern)) {
    const sdk = /\bsdk\s*=\s*\[([^\]]*)\]/.exec(match[2]);
    found.push({
      classLevel: match[1].length === 0,
      sdks: sdk ? sdk[1].split(",").map((value) => value.trim()).filter(Boolean) : null,
    });
  }
  return found;
}

export function sandboxSdks(text) {
  const all = configs(text);
  const classConfig = all.find(({ classLevel, sdks }) => classLevel && sdks);
  const sdks = new Set(classConfig ? classConfig.sdks : ["default"]);
  for (const { classLevel, sdks: methodSdks } of all) {
    if (!classLevel && methodSdks) for (const sdk of methodSdks) sdks.add(sdk);
  }
  return [...sdks];
}

export function fileProblems(file, text) {
  if (file === ruleFile) return [];
  const problems = [];
  text.split("\n").forEach((line, index) => {
    if (handlerReset.test(line)) {
      problems.push({ file, line: index + 1, reason: "resets the URL handler by hand; use the SharedUrlHandlerSandbox rule" });
    }
  });
  if (!robolectric.test(text)) return problems;
  const offOwner = sandboxSdks(text).filter((sdk) => sdk !== String(ownerSdk));
  if (offOwner.length && !ruleUse.test(text)) {
    problems.push({
      file,
      line: 0,
      reason: `runs on sdk ${offOwner.join(", ")} without @get:Rule val urlHandlerSandbox = SharedUrlHandlerSandbox(), so its sandbox can take the JVM-wide URL handler from the sdk ${ownerSdk} sandbox`,
    });
  }
  return problems;
}

export function problems(root = repoRoot) {
  return kotlinFiles(path.join(root, "apps/conclave-skip/Tests")).flatMap((full) =>
    fileProblems(path.relative(root, full), readFileSync(full, "utf8")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag === -1 ? repoRoot : path.resolve(process.argv[rootFlag + 1]);
  const found = problems(root);
  if (found.length) {
    for (const problem of found) console.error(`${problem.file}:${problem.line} ${problem.reason}`);
    console.error(`${found.length} native test sandbox problem(s).`);
    process.exit(1);
  }
  console.log("native Robolectric tests off sdk 28 leave the URL handler to the sdk 28 sandbox");
}
