#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";
import { classifyComments, isFirstPartySource, languageOf } from "./policy.mjs";

const scanScript = (text, file) => {
  const source = text.replace(/^#!([^\r\n]*)/, "//$1");
  const { ast } = tseslint.parser.parseForESLint(source, {
    filePath: file,
    comment: true,
    range: true,
    loc: false,
    tokens: false,
    ecmaVersion: "latest",
    sourceType: "module",
  });
  return ast.comments.map((comment) => [comment.range[0], comment.range[1]]);
};

const scanKotlin = (text) => {
  const language = "kotlin";
  const comments = [];
  let i = 0;

  const lineComment = () => {
    const start = i;
    while (i < text.length && text[i] !== "\n") i += 1;
    comments.push([start, i]);
  };

  const blockComment = () => {
    const start = i;
    let depth = 0;
    while (i < text.length) {
      if (text.startsWith("/*", i)) {
        depth += 1;
        i += 2;
      } else if (text.startsWith("*/", i)) {
        depth -= 1;
        i += 2;
        if (depth === 0) break;
      } else i += 1;
    }
    comments.push([start, i]);
  };

  const kotlinString = () => {
    let dollars = 0;
    while (text[i - 1 - dollars] === "$") dollars += 1;
    const interpolation = "$".repeat(Math.max(1, dollars)) + "{";
    const raw = text.startsWith('"""', i);
    i += raw ? 3 : 1;
    while (i < text.length) {
      if (!raw && text[i] === "\\") i += 2;
      else if (text.startsWith(interpolation, i)) {
        i += interpolation.length;
        code("}");
      } else if (raw && text.startsWith('"""', i)) {
        i += 3;
        while (text[i] === '"') i += 1;
        return;
      } else if (!raw && text[i] === '"') {
        i += 1;
        return;
      } else if (!raw && text[i] === "\n") return;
      else i += 1;
    }
  };

  const kotlinChar = () => {
    i += 1;
    while (i < text.length && text[i] !== "'" && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
    i += 1;
  };

  const opener = { ")": "(", "}": "{" };


  function code(closer) {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (closer && c === closer && depth === 0) {
        i += 1;
        return;
      }
      if (text.startsWith("//", i)) lineComment();
      else if (text.startsWith("/*", i)) blockComment();
      else if (c === "`") {
        const close = text.indexOf("`", i + 1);
        const lineEnd = text.indexOf("\n", i + 1);
        i = close !== -1 && (lineEnd === -1 || close < lineEnd) ? close + 1 : i + 1;
      }
      else if (language === "kotlin" && c === '"') kotlinString();
      else if (language === "kotlin" && c === "'") kotlinChar();
      else {
        if (closer && c === opener[closer]) depth += 1;
        else if (closer && c === closer) depth -= 1;
        i += 1;
      }
    }
  }

  code(null);
  return comments;
};

export class SwiftParseError extends Error {}

const SWIFT_TRIVIA_PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "swift-trivia");

const swiftSyntaxVersion = () =>
  JSON.parse(readFileSync(path.join(SWIFT_TRIVIA_PACKAGE, "Package.resolved"), "utf8")).pins.find(
    (pin) => pin.identity === "swift-syntax",
  ).state.version;

const cacheRoot = () =>
  process.env.CONCLAVE_CACHE_DIR ||
  process.env.XDG_CACHE_HOME ||
  (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches") : path.join(os.homedir(), ".cache"));

export const swiftTriviaScratchPath = () =>
  path.join(cacheRoot(), "conclave", "swift-trivia", `swift-syntax-${swiftSyntaxVersion()}`);

let swiftTriviaBinary;

const swiftTrivia = () => {
  if (swiftTriviaBinary) return swiftTriviaBinary;
  const scratch = swiftTriviaScratchPath();
  const build = spawnSync("swift", ["build", "-c", "release", "--package-path", SWIFT_TRIVIA_PACKAGE, "--scratch-path", scratch], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (build.error?.code === "ENOENT") {
    throw new SwiftParseError(
      `a Swift toolchain is required to read Swift comments, and \`swift\` is not on PATH (scripts/quality/comments/swift-trivia builds on swift-syntax ${swiftSyntaxVersion()} into ${scratch}).`,
    );
  }
  const binary = path.join(scratch, "release", "swift-comment-trivia");
  if (build.status !== 0 || !existsSync(binary)) {
    throw new SwiftParseError(`could not build scripts/quality/comments/swift-trivia:\n${build.stderr ?? ""}`);
  }
  swiftTriviaBinary = binary;
  return binary;
};

const scanSwift = (text, file) => {
  let binary;
  try {
    binary = swiftTrivia();
  } catch (error) {
    throw new SwiftParseError(`cannot read the comments in ${file}: ${error.message}`);
  }
  const result = spawnSync(binary, [], { input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new SwiftParseError(`swift-comment-trivia could not read ${file}: ${result.error?.message ?? result.stderr}`);
  }
  const toIndex = utf8IndexMapper(text);
  return JSON.parse(result.stdout).map(([start, end]) => [toIndex(start), toIndex(end)]);
};

const skipQuoted = (text, i, quote, escapes) => {
  i += 1;
  while (i < text.length && text[i] !== quote) i += escapes && text[i] === "\\" ? 2 : 1;
  return i + 1;
};

const unquotedUrlAt = (text, i) => {
  if (text.slice(i, i + 4).toLowerCase() !== "url(" || /[\w-]/.test(text[i - 1] ?? "")) return false;
  let j = i + 4;
  while (/\s/.test(text[j] ?? "")) j += 1;
  return j < text.length && !"\"')".includes(text[j]);
};

const scanCss = (text) => {
  const comments = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"' || text[i] === "'") i = skipQuoted(text, i, text[i], true);
    else if (unquotedUrlAt(text, i)) {
      i += 4;
      while (i < text.length && text[i] !== ")") i += text[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      comments.push([i, stop]);
      i = stop;
    } else i += 1;
  }
  return comments;
};

export class ShellParseError extends Error {}

const utf8IndexMapper = (text) => {
  const buffer = Buffer.from(text, "utf8");
  return (byteOffset) => buffer.subarray(0, byteOffset).toString("utf8").length;
};

let shellParser;

const loadShellParser = (file) => {
  if (shellParser) return shellParser;
  try {
    shellParser = createRequire(import.meta.url)("sh-syntax/sync").parse;
  } catch (error) {
    throw new ShellParseError(`cannot read the comments in ${file}: the sh-syntax dev dependency is missing, run pnpm install (${error.message}).`);
  }
  return shellParser;
};

const scanShell = (text, file) => {
  const parseShell = loadShellParser(file);
  let tree;
  try {
    tree = parseShell(text, { keepComments: true });
  } catch (error) {
    throw new ShellParseError(`sh-syntax could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const toIndex = utf8IndexMapper(text);
  const comments = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.type === "Comment") {
      const start = toIndex(node.hash.offset);
      comments.push([start, start + 1 + node.text.length]);
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(tree);
  return comments.sort((a, b) => a[0] - b[0]);
};

const PYTHON_TOKENIZE = `
import io, json, sys, tokenize
text = sys.stdin.read()
if sys.version_info < (3, 12):
    print(json.dumps({"error": "Python 3.12 or newer is required to read Python comments (PEP 701 f-strings); found " + sys.version.split()[0]}))
    sys.exit(0)
lines = io.StringIO(text).readlines()
starts = [0]
for line in lines:
    starts.append(starts[-1] + len(line.encode("utf-16-le")) // 2)
def offset(row, col):
    if row > len(lines):
        return starts[-1]
    return starts[row - 1] + len(lines[row - 1][:col].encode("utf-16-le")) // 2
try:
    found = [[offset(*t.start), offset(*t.end)] for t in tokenize.generate_tokens(io.StringIO(text).readline) if t.type == tokenize.COMMENT]
except (tokenize.TokenError, SyntaxError) as error:
    print(json.dumps({"error": str(error)}))
else:
    print(json.dumps({"comments": found}))
`;

export class PythonTokenizeError extends Error {}

const scanPython = (text, file) => {
  const result = spawnSync("python3", ["-I", "-c", PYTHON_TOKENIZE], { input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code === "ENOENT" ? "python3 was not found" : `python3 exited with ${result.status}`;
    throw new PythonTokenizeError(`python3 is required to read Python comments (${reason} while reading ${file}).`);
  }
  const parsed = JSON.parse(result.stdout);
  if (parsed.error) throw new PythonTokenizeError(`${parsed.error.startsWith("Python 3.12") ? parsed.error : `python3 tokenize could not read ${file}: ${parsed.error}`}`);
  return parsed.comments;
};

export const scanComments = (text, file) => {
  const language = languageOf(file);
  if (language === "script") return scanScript(text, file);
  if (language === "swift") return scanSwift(text, file);
  if (language === "kotlin") return scanKotlin(text);
  if (language === "css") return scanCss(text);
  if (language === "shell") return scanShell(text, file);
  if (language === "python") return scanPython(text, file);
  throw new Error(`No comment scanner for ${file}`);
};

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

export const extractComments = (rawText, file) => {
  const text = rawText.replace(/^﻿/, "");
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
    .filter((file) => file !== "" && isFirstPartySource(file));

export const extractFile = (repo, file) =>
  extractComments(readFileSync(path.join(repo, file), "utf8"), file).map((comment) => ({ file, ...comment }));

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
  const records = listSourceFiles(repo, paths).flatMap((file) => extractFile(repo, file));
  if (counts) process.stdout.write(`${JSON.stringify(countDisallowed(records), null, 2)}\n`);
  else for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
