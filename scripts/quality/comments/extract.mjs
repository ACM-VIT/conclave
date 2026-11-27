#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyComments, isFirstPartySource, languageOf, normalizeNewlines } from "./policy.mjs";
import { prepareKotlin, tokenizeComments } from "./tokenizers.mjs";

export { CommentParserError, swiftTriviaScratchPath, toolWorks } from "./tokenizers.mjs";

export const scanComments = (text, file) => tokenizeComments(text, file, languageOf(file));

const lineStartsOf = (text) => {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return starts;
};

const lineIndexOf = (starts, offset) => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
};

const ICON_GENERATOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/ui-tokens/scripts/gen-native-icons.py");

let iconOutputs;

export const iconGeneratorOutputs = () => {
  if (iconOutputs) return iconOutputs;
  iconOutputs = new Set();
  if (!existsSync(ICON_GENERATOR)) return iconOutputs;
  const source = readFileSync(ICON_GENERATOR, "utf8");
  const roots = Object.fromEntries([...source.matchAll(/^([A-Z_]+) = Path\('([^']+)'\)$/gm)].map((match) => [match[1], match[2]]));
  for (const [, root, name] of source.matchAll(/\b([A-Z_]+) \/ '([^'\/]+\.(?:kt|swift))'/g)) {
    if (roots[root]) iconOutputs.add(`${roots[root]}/${name}`);
  }
  return iconOutputs;
};

const sourceText = (rawText) => normalizeNewlines(rawText.replace(/^\uFEFF/, "")).text;

export const prepareFiles = (entries) =>
  prepareKotlin(entries.filter(({ file }) => languageOf(file) === "kotlin").map(({ file, text }) => ({ file, text: sourceText(text) })));

export const extractComments = (rawText, file) => {
  const text = sourceText(rawText);
  const comments = scanComments(text, file).map(([start, end]) => ({ start, end, text: text.slice(start, end) }));
  const verdicts = classifyComments(text, comments, languageOf(file), {
    generatedIconOutput: iconGeneratorOutputs().has(file),
  });
  const starts = lineStartsOf(text);
  return comments.map((comment, index) => {
    const first = lineIndexOf(starts, comment.start);
    const last = lineIndexOf(starts, Math.max(comment.start, comment.end - 1));
    const lineEnd = last + 1 < starts.length ? starts[last + 1] - 1 : text.length;
    const ownLines =
      text.slice(starts[first], comment.start).trim() === "" && text.slice(comment.end, lineEnd).trim() === "";
    return {
      line: first + 1,
      endLine: last + 1,
      ownLines,
      linesShed: ownLines ? last - first + 1 : 0,
      allowed: verdicts[index].kind ?? null,
      text: comment.text,
    };
  });
};

export const listSourceFiles = (repo, paths = []) =>
  execFileSync("git", ["-C", repo, "ls-files", "-z", "--", ...paths], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((file) => file !== "" && isFirstPartySource(file) && existsSync(path.join(repo, file)));

export const extractFile = (repo, file) =>
  extractComments(readFileSync(path.join(repo, file), "utf8"), file).map((comment) => ({ file, ...comment }));

export const extractFiles = (repo, files) => {
  const entries = files.map((file) => ({ file, text: readFileSync(path.join(repo, file), "utf8") }));
  prepareFiles(entries);
  return entries.flatMap(({ file, text }) => extractComments(text, file).map((comment) => ({ file, ...comment })));
};

export const countDisallowed = (records) => {
  const counts = {};
  for (const record of records) {
    if (!record.allowed) counts[record.file] = (counts[record.file] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
};

const main = () => {
  const args = process.argv.slice(2);
  const counts = args.includes("--counts");
  const repoFlag = args.indexOf("--repo");
  const repo = path.resolve(repoFlag === -1 ? "." : args[repoFlag + 1]);
  const paths = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--repo");
  const records = extractFiles(repo, listSourceFiles(repo, paths));
  if (counts) process.stdout.write(`${JSON.stringify(countDisallowed(records), null, 2)}\n`);
  else for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
