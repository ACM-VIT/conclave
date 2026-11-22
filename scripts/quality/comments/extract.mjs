#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

  const kotlinString = () => {
    const raw = text.startsWith('"""', i);
    i += raw ? 3 : 1;
    while (i < text.length) {
      if (!raw && text[i] === "\\") i += 2;
      else if (text.startsWith("${", i)) {
        i += 2;
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
      else if (language === "swift" && (c === '"' || (c === "#" && /^#+"/.test(text.slice(i, i + 8))))) swiftString();
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
    if (text[i] === '"' || text[i] === "'") i = skipQuoted(text, i, text[i], true);
    else if (text.startsWith("/*", i)) {
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

  const doubleQuoted = () => {
    i += 1;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i += 2;
      else if (text.startsWith("$(", i)) {
        i += 2;
        code(")");
      } else i += 1;
    }
    i += 1;
  };

  function code(closer) {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (closer && c === closer && depth === 0) {
        i += 1;
        return;
      }
      if (c === "\\") i += 2;
      else if (c === "'") i = skipQuoted(text, i, "'", false);
      else if (c === "$" && text[i + 1] === "'") i = skipQuoted(text, i + 1, "'", true);
      else if (c === '"') doubleQuoted();
      else if (text.startsWith("$(", i)) {
        i += 2;
        code(")");
      } else if (c === "#" && (i === 0 || /[\s;|&(]/.test(text[i - 1]))) {
        const start = i;
        while (i < text.length && text[i] !== "\n") i += 1;
        comments.push([start, i]);
      } else if (text.startsWith("<<", i) && text[i + 2] !== "<") {
        const match = /^<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(text.slice(i));
        if (match) {
          heredocs.push({ delimiter: match[3], stripTabs: match[1] === "-" });
          i += match[0].length;
        } else i += 2;
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

const scanPython = (text) => {
  const comments = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      const start = i;
      while (i < text.length && text[i] !== "\n") i += 1;
      comments.push([start, i]);
    } else if (c === '"' || c === "'") {
      const triple = c.repeat(3);
      if (text.startsWith(triple, i)) {
        i += 3;
        while (i < text.length && !text.startsWith(triple, i)) i += text[i] === "\\" ? 2 : 1;
        i += 3;
      } else {
        i += 1;
        while (i < text.length && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
        i += 1;
      }
    } else i += 1;
  }
  return comments;
};

export const scanComments = (text, file) => {
  const language = languageOf(file);
  if (language === "script") return scanScript(text, file);
  if (language === "swift" || language === "kotlin") return scanCLike(text, language);
  if (language === "css") return scanCss(text);
  if (language === "shell") return scanShell(text);
  if (language === "python") return scanPython(text);
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

export const extractComments = (rawText, file) => {
  const text = rawText.replace(/^﻿/, "");
  const comments = scanComments(text, file).map(([start, end]) => ({ start, end, text: text.slice(start, end) }));
  const verdicts = classifyComments(text, comments, languageOf(file));
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
