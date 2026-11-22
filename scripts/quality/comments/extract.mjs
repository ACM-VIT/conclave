#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const scanCLike = (text, language) => {
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

  const swiftString = () => {
    let hashes = 0;
    while (text[i] === "#") {
      hashes += 1;
      i += 1;
    }
    const multiline = text.startsWith('"""', i);
    i += multiline ? 3 : 1;
    const close = (multiline ? '"""' : '"') + "#".repeat(hashes);
    const escape = "\\" + "#".repeat(hashes);
    while (i < text.length) {
      if (text.startsWith(escape, i)) {
        i += escape.length;
        if (text[i] === "(") {
          i += 1;
          code(")");
        } else i += 1;
      } else if (text.startsWith(close, i)) {
        i += close.length;
        return;
      } else if (!multiline && text[i] === "\n") return;
      else i += 1;
    }
  };

  const swiftExtendedRegex = () => {
    let hashes = 0;
    while (text[i] === "#") {
      hashes += 1;
      i += 1;
    }
    i += 1;
    const close = "/" + "#".repeat(hashes);
    while (i < text.length && !text.startsWith(close, i)) i += text[i] === "\\" ? 2 : 1;
    i += close.length;
  };

  const BARE_REGEX_PRECEDER = /(?:^|[(\[{,:;=!?&|^~+\-*%<>]|\b(?:return|case|in|where|try|await|throw|let|var|if|guard|while|else))\s*$/;

  const swiftBareRegex = () => {
    const start = i;
    const next = text[i + 1];
    if (next === undefined || /[\s/*]/.test(next)) return false;
    const lineStart = text.lastIndexOf("\n", i - 1) + 1;
    if (!BARE_REGEX_PRECEDER.test(text.slice(lineStart, i))) return false;
    i += 1;
    let inClass = false;
    while (i < text.length && text[i] !== "\n") {
      const c = text[i];
      if (c === "\\") i += 2;
      else if (c === "[") (inClass = true), (i += 1);
      else if (c === "]") (inClass = false), (i += 1);
      else if (c === "/" && !inClass) {
        i += 1;
        return true;
      } else i += 1;
    }
    i = start;
    return false;
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

  const hashesThen = (marker) => {
    let j = i;
    while (text[j] === "#") j += 1;
    return j > i && text[j] === marker;
  };

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
      else if (language === "swift" && (c === '"' || (c === "#" && hashesThen('"')))) swiftString();
      else if (language === "swift" && c === "#" && hashesThen("/")) swiftExtendedRegex();
      else if (language === "swift" && c === "/" && swiftBareRegex()) continue;
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

const skipQuoted = (text, i, quote, escapes) => {
  i += 1;
  while (i < text.length && text[i] !== quote) i += escapes && text[i] === "\\" ? 2 : 1;
  return i + 1;
};

const scanCss = (text) => {
  const comments = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"' || text[i] === "'") i = skipQuoted(text, i, text[i], true);
    else if (/^url\(\s*[^\s"')]/i.test(text.slice(i, i + 64)) && !/[\w-]/.test(text[i - 1] ?? "")) {
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

const scanShell = (text) => {
  const comments = [];
  const heredocs = [];
  let i = 0;

  const skipHeredocBodies = () => {
    for (const { delimiter, stripTabs } of heredocs.splice(0)) {
      while (i < text.length) {
        const lineEnd = text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i);
        const line = text.slice(i, lineEnd);
        i = lineEnd + 1;
        if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
      }
    }
  };

  const arithmetic = () => {
    let depth = 0;
    while (i < text.length) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          return;
        }
      }
      i += 1;
    }
  };

  const doubleQuoted = () => {
    i += 1;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i += 2;
      else if (text.startsWith("${", i)) parameterExpansion();
      else if (text.startsWith("$((", i)) {
        i += 1;
        arithmetic();
      } else if (text.startsWith("$(", i)) {
        i += 2;
        code(")");
      } else i += 1;
    }
    i += 1;
  };

  function parameterExpansion() {
    i += 2;
    let depth = 1;
    while (i < text.length) {
      if (text[i] === "\\") i += 2;
      else if (text[i] === "'") i = skipQuoted(text, i, "'", false);
      else if (text[i] === '"') doubleQuoted();
      else if (text.startsWith("${", i)) {
        depth += 1;
        i += 2;
      } else if (text.startsWith("$(", i)) {
        i += 2;
        code(")");
      } else if (text[i] === "}") {
        depth -= 1;
        i += 1;
        if (depth === 0) return;
      } else i += 1;
    }
  }

  const heredocWord = () => {
    let word = "";
    let quoted = false;
    while (i < text.length && !/[\s;&|<>()]/.test(text[i])) {
      if (text[i] === "\\") {
        quoted = true;
        word += text[i + 1] ?? "";
        i += 2;
      } else if (text[i] === "'" || text[i] === '"') {
        quoted = true;
        const close = text.indexOf(text[i], i + 1);
        const stop = close === -1 ? text.length : close;
        word += text.slice(i + 1, stop);
        i = stop + 1;
      } else {
        word += text[i];
        i += 1;
      }
    }
    return { word, quoted };
  };

  function code(closer) {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (closer && c === closer && depth === 0) {
        i += 1;
        return;
      }
      if (c === "\\") {
        const continuation = text[i + 1] === "\n";
        const before = text[i - 1];
        i += 2;
        if (text[i] === "#" && !(continuation && (before === undefined || /[\s;|&(]/.test(before)))) i += 1;
      } else if (c === "'") i = skipQuoted(text, i, "'", false);
      else if (text.startsWith("${", i)) parameterExpansion();
      else if (c === "$" && text[i + 1] === "'") i = skipQuoted(text, i + 1, "'", true);
      else if (c === '"') doubleQuoted();
      else if (text.startsWith("$((", i)) {
        i += 1;
        arithmetic();
      } else if (text.startsWith("((", i)) arithmetic();
      else if (text.startsWith("$(", i)) {
        i += 2;
        code(")");
      } else if (c === "#" && (i === 0 || /[\s;|&(]/.test(text[i - 1]))) {
        const start = i;
        while (i < text.length && text[i] !== "\n") i += 1;
        comments.push([start, i]);
      } else if (text.startsWith("<<<", i)) i += 3;
      else if (text.startsWith("<<", i)) {
        const stripTabs = text[i + 2] === "-";
        i += stripTabs ? 3 : 2;
        while (text[i] === " " || text[i] === "\t") i += 1;
        const { word } = heredocWord();
        if (word !== "") heredocs.push({ delimiter: word, stripTabs });
      } else if (c === "\n") {
        i += 1;
        skipHeredocBodies();
      } else {
        if (closer && c === "(") depth += 1;
        else if (closer && c === ")") depth -= 1;
        i += 1;
      }
    }
  }

  code(null);
  return comments;
};

const PYTHON_TOKENIZE = `
import io, json, sys, tokenize
text = sys.stdin.read()
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

let pythonFallbackReason;

export const pythonScannerFallback = () => pythonFallbackReason;

const tokenizePython = (text, file) => {
  const result = spawnSync("python3", ["-I", "-c", PYTHON_TOKENIZE], { input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    pythonFallbackReason = result.error?.code === "ENOENT" ? "python3 is not installed" : `python3 tokenize failed on ${file}`;
    return undefined;
  }
  const parsed = JSON.parse(result.stdout);
  if (parsed.error) {
    pythonFallbackReason = `python3 tokenize could not read ${file}: ${parsed.error}`;
    return undefined;
  }
  return parsed.comments;
};

const scanPython = (text, file) => {
  const tokenized = tokenizePython(text, file);
  if (tokenized) return tokenized;
  process.emitWarning(`comment extractor: ${pythonFallbackReason}; using the built-in Python scanner.`);
  return scanPythonByHand(text);
};

export const scanPythonByHand = (text) => {
  const comments = [];
  let i = 0;

  const lineComment = () => {
    const start = i;
    while (i < text.length && text[i] !== "\n") i += 1;
    comments.push([start, i]);
  };

  const stringPrefix = () => {
    let j = i;
    while (j > 0 && /[rRbBuUfFtT]/.test(text[j - 1]) && i - j < 2) j -= 1;
    if (j > 0 && /[\w]/.test(text[j - 1])) return "";
    return text.slice(j, i).toLowerCase();
  };

  function replacementField(triple) {
    i += 1;
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "#") lineComment();
      else if (c === '"' || c === "'") string();
      else if (c === "\n" && !triple && depth === 0) return;
      else if ("([{".includes(c)) (depth += 1), (i += 1);
      else if (depth > 0 && ")]}".includes(c)) (depth -= 1), (i += 1);
      else if (c === "}") {
        i += 1;
        return;
      } else if (c === ":" && depth === 0) {
        i += 1;
        formatSpec(triple);
        return;
      } else i += 1;
    }
  }

  function formatSpec(triple) {
    while (i < text.length) {
      if (text[i] === "{") replacementField(triple);
      else if (text[i] === "}") {
        i += 1;
        return;
      } else if (text[i] === "\n" && !triple) return;
      else i += 1;
    }
  }

  function string() {
    const formatted = /[ft]/.test(stringPrefix());
    const quote = text[i];
    const triple = text.startsWith(quote.repeat(3), i);
    const close = triple ? quote.repeat(3) : quote;
    i += close.length;
    while (i < text.length && !text.startsWith(close, i)) {
      if (text[i] === "\\") i += 2;
      else if (formatted && text.startsWith("{{", i)) i += 2;
      else if (formatted && text[i] === "{") replacementField(triple);
      else if (!triple && text[i] === "\n") return;
      else i += 1;
    }
    i += close.length;
  }

  while (i < text.length) {
    const c = text[i];
    if (c === "#") lineComment();
    else if (c === '"' || c === "'") string();
    else i += 1;
  }
  return comments;
};

export const scanComments = (text, file) => {
  const language = languageOf(file);
  if (language === "script") return scanScript(text, file);
  if (language === "swift" || language === "kotlin") return scanCLike(text, language);
  if (language === "css") return scanCss(text);
  if (language === "shell") return scanShell(text);
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
