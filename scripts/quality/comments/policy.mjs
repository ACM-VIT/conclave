export const NO_COMMENTS_RULE = "conclave/no-comments";

const LANGUAGE_BY_EXTENSION = {
  ".ts": "script",
  ".tsx": "script",
  ".mts": "script",
  ".cts": "script",
  ".js": "script",
  ".jsx": "script",
  ".mjs": "script",
  ".cjs": "script",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".css": "css",
  ".sh": "shell",
  ".py": "python",
};

export const ESLINT_LANGUAGE = "script";

export const VENDORED_PREFIXES = [
  "apps/web/public/_/",
  "apps/web/public/mediapipe/",
  "apps/web/public/noise-suppressor/",
];

export const normalizeNewlines = (raw) => {
  const removed = [];
  for (let index = raw.indexOf("\r\n"); index !== -1; index = raw.indexOf("\r\n", index + 2)) removed.push(index);
  const text = raw.replace(/\r\n?/g, "\n");
  const toNormalized = (offset) => {
    let low = 0;
    let high = removed.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (removed[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return offset - low;
  };
  return { text, toNormalized };
};

export const languageOf = (file) => LANGUAGE_BY_EXTENSION[/\.[^./]+$/.exec(file)?.[0] ?? ""];

export const isFirstPartySource = (file) =>
  languageOf(file) !== undefined && !VENDORED_PREFIXES.some((prefix) => file.startsWith(prefix));

export const vendoredIgnores = (packageDir) =>
  VENDORED_PREFIXES.filter((prefix) => prefix.startsWith(packageDir)).map((prefix) => prefix.slice(packageDir.length));

const SPDX_LINE = /^SPDX-License-Identifier: [A-Za-z0-9.+()-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+()-]+)*$/;
const COPYRIGHT_LINE = /^Copyright (?:\(c\) |\(C\) |© )?\d{4}(?:\s*[-,]\s*\d{4})*,? \S.*$/;
const LICENSE_TITLE = /^(?:The )?(?:MIT|ISC|BSD [23]-Clause|Apache) License(?: \(MIT\))?\.?$|^Version 2\.0, January 2004$/;

const KNOWN_LICENSE_TEXTS = {
  MIT: [
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
    "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
  ],
  ISC: [
    "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.",
    'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.',
  ],
  BSD: [
    "Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:",
    "Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.",
    "Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.",
    'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.',
  ],
  "Apache-2.0": [
    'Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at',
    "http://www.apache.org/licenses/LICENSE-2.0",
    'Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.',
  ],
};

const canonical = (text) =>
  text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const CANONICAL_LICENSES = Object.values(KNOWN_LICENSE_TEXTS).map((sentences) => sentences.map(canonical));
const CANONICAL_LICENSE_BODIES = CANONICAL_LICENSES.map((sentences) => sentences.join(" "));
const BSD_THIRD_CLAUSE = /^(?:\d\.\s*)?neither the name of .+ nor the names of (?:its|their) contributors may be used to endorse or promote products derived from this software without specific prior written permission\.$/;

const commentContentLines = (text) =>
  text
    .replace(/^\/\/+|^\/\*+|^#+|\*+\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\*|\/\/+|#+)?\s?/, "").trim())
    .filter((line) => line !== "");

const isNoticeLine = (line) => SPDX_LINE.test(line) || COPYRIGHT_LINE.test(line);

const containsKnownLicense = (lines) => {
  const body = canonical(lines.join(" ").replace(/(^|\s)\d\.\s+/g, "$1"));
  return CANONICAL_LICENSES.some((sentences) => sentences.every((sentence) => body.includes(sentence)));
};

const isLicenseFragment = (line) => {
  if (isNoticeLine(line) || LICENSE_TITLE.test(line)) return true;
  const text = canonical(line.replace(/^\d\.\s+/, ""));
  return CANONICAL_LICENSE_BODIES.some((body) => body.includes(text)) || BSD_THIRD_CLAUSE.test(text);
};

export const isLicenseNotice = (text) => {
  const lines = commentContentLines(text);
  return lines.length > 0 && (lines.every(isNoticeLine) || containsKnownLicense(lines));
};


const ESLINT_DIRECTIVE = /^(?:\/\/|\/\*)\s*eslint-(disable|enable)(?:-next-line|-line)?(?=\s|\*\/|$)/;
const ESLINT_INLINE_CONFIG = /^\/\*\s*eslint(?:-env)?\s/;

const decodeInlineConfig = (text) =>
  text.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\(.)/g, (_, braced, unicode, hex, other) =>
    braced || unicode || hex ? String.fromCodePoint(parseInt(braced || unicode || hex, 16)) : other,
  );

const ENABLING_SEVERITY = /^\[?\s*(["']?)(?:error|warn|1|2)\1\s*(?:[,\]}]|\*\/|$)/;
const ESLINT_REASON = /\s-{2,}\s+\S/;
const TS_EXPECT_ERROR = /^(?:\/\/|\/\*)\s*@ts-expect-error\b([\s\S]*?)(?:\*\/)?$/;

const SOURCE_MAP_URL = /^(?:\/\/|\/\*)[#@]\s*sourceMappingURL=\S+\s*(?:\*\/)?$/;

const SKIP_DIAGNOSTIC_ID = "EXTENSION_MERGING";
const SKIP_KEYWORD = new RegExp(
  `^SKIP (?:@\\S|ATTRIBUTES:|INSERT:|REPLACE:|DECLARE:|NOWARN(?:\\(\\s*${SKIP_DIAGNOSTIC_ID}(?:\\s*,\\s*${SKIP_DIAGNOSTIC_ID})*\\s*\\))?$|EXTERN|SYMBOLFILE)`,
);
const SKIP_CONTINUES = /^SKIP (?:@\S|ATTRIBUTES:|INSERT:|REPLACE:|DECLARE:)/;

const skipDirectiveBody = (text) => {
  if (text.startsWith("// ")) return text.slice(3).trimEnd();
  if (text.startsWith("/* ") && text.endsWith("*/")) {
    const body = text.slice(3, -2);
    return body.includes("\n") ? body.split("\n")[0].trimEnd() : body.trim();
  }
  return undefined;
};

const ICON_PROVENANCE_HEADER = /^\/\/ Profile [a-z0-9-]+; manifest SHA256 [0-9a-f]{64}; generator SHA256 [0-9a-f]{64}\.$/;
const ICON_INPUT_HASH = /^\/\/ [a-z0-9_]+\.fill[01]; input SHA256 [0-9a-f]{64}\.$/;

const scriptDirectives = [
  ["prettier-ignore", /^(?:\/\/\s*prettier-ignore\s*|\/\*\s*prettier-ignore\s*\*\/)$/],
  ["triple-slash-reference", /^\/\/\/\s*<reference\s+(?:path|types|lib|no-default-lib)=\S.*\/>\s*$/],
  ["vitest-environment", /^(?:\/\/\s*@vitest-environment\s+[\w-]+\s*|\/\*\*?\s*@vitest-environment\s+[\w-]+\s*\*\/)$/],
  ["source-map-url", SOURCE_MAP_URL],
];

export const disablesNoComments = (text) => {
  const match = ESLINT_DIRECTIVE.exec(text);
  if (!match || match[1] === "enable") return false;
  const rules = text.slice(match[0].length).split(/\s-{2,}\s/)[0].replace(/\*\/$/, "").trim();
  return rules === "" || rules.split(/[\s,]+/).includes(NO_COMMENTS_RULE);
};

export const configuresNoComments = (text) => {
  if (!ESLINT_INLINE_CONFIG.test(text)) return false;
  const decoded = decodeInlineConfig(text);
  let from = decoded.indexOf(NO_COMMENTS_RULE);
  if (from === -1) return false;
  while (from !== -1) {
    const value = decoded.slice(from + NO_COMMENTS_RULE.length).replace(/^["']?\s*:\s*/, "");
    if (!ENABLING_SEVERITY.test(value)) return true;
    from = decoded.indexOf(NO_COMMENTS_RULE, from + 1);
  }
  return false;
};

export const switchesOffNoComments = (text) => disablesNoComments(text) || configuresNoComments(text);

const eslintDirectiveKind = (text) => {
  if (configuresNoComments(text)) return { problem: "selfDisable" };
  if (!ESLINT_DIRECTIVE.test(text)) return undefined;
  if (disablesNoComments(text)) return { problem: "selfDisable" };
  return ESLINT_REASON.test(text) ? { kind: "eslint-directive" } : { problem: "directiveReason" };
};

const tsExpectErrorKind = (text) => {
  const match = TS_EXPECT_ERROR.exec(text);
  if (!match) return undefined;
  const description = match[1].trim().replace(/^[:\-–—]+\s*/, "");
  return description.length >= 3 ? { kind: "ts-expect-error" } : { problem: "directiveReason" };
};

const directiveKind = (language, text, start, lineOfStart) => {
  if (start === 0 && text.startsWith("#!")) return { kind: "shebang" };
  if (language === "script") {
    const found = eslintDirectiveKind(text) ?? tsExpectErrorKind(text);
    if (found) return found;
    const match = scriptDirectives.find(([, pattern]) => pattern.test(text));
    return match ? { kind: match[0] } : undefined;
  }
  if (language === "swift" && start === 0 && /^\/\/\s*swift-tools-version:/.test(text)) {
    return { kind: "swift-tools-version" };
  }
  if (language === "css" && SOURCE_MAP_URL.test(text)) return { kind: "source-map-url" };
  if (language === "python" && /^#.*?coding[:=][ \t]*[-\w.]+/.test(text) && lineOfStart <= 2) return { kind: "encoding-declaration" };
  return undefined;
};

const ownsItsLines = (source, comment) => {
  const lineStart = source.lastIndexOf("\n", comment.start - 1) + 1;
  const lineEnd = source.indexOf("\n", comment.end);
  return source.slice(lineStart, comment.start).trim() === "" &&
    source.slice(comment.end, lineEnd === -1 ? source.length : lineEnd).trim() === "";
};

const singleNewlineBetween = (source, previous, comment) => /^[ \t]*\n[ \t]*$/.test(source.slice(previous.end, comment.start));

const skipDirectiveIndexes = (source, comments) => {
  const indexes = new Set();
  let continues = false;
  comments.forEach((comment, index) => {
    const own = ownsItsLines(source, comment);
    const adjacent = index > 0 && singleNewlineBetween(source, comments[index - 1], comment);
    const body = own ? skipDirectiveBody(comment.text) : undefined;
    if (body !== undefined && body.startsWith("SKIP")) {
      const valid = SKIP_KEYWORD.test(body);
      if (valid) indexes.add(index);
      continues = valid && comment.text.startsWith("// ") && SKIP_CONTINUES.test(body);
    } else if (continues && own && adjacent && comment.text.startsWith("// ")) {
      indexes.add(index);
    } else {
      continues = false;
    }
  });
  return indexes;
};

const iconProvenanceIndexes = (comments) => {
  const indexes = new Set();
  if (comments[0]?.start !== 0 || !ICON_PROVENANCE_HEADER.test(comments[0].text)) return indexes;
  indexes.add(0);
  comments.forEach((comment, index) => {
    if (ICON_INPUT_HASH.test(comment.text)) indexes.add(index);
  });
  return indexes;
};

const LEADING_GAP = /^(?:#![^\n]*\n)?\s*(?:(["'])use [a-z ]+\1;?\s*)*$/;

const licenseHeaderIndexes = (source, comments, isDirective) => {
  const run = [];
  let previousEnd = 0;
  for (let index = 0; index < comments.length; index += 1) {
    const gap = source.slice(previousEnd, comments[index].start);
    if (index === 0 ? !LEADING_GAP.test(gap) : gap.trim() !== "") break;
    previousEnd = comments[index].end;
    if (!isDirective(index)) run.push(index);
  }
  const indexes = new Set();
  for (let position = 0; position < run.length; ) {
    const lines = commentContentLines(comments[run[position]].text);
    if (lines.length > 0 && (lines.every(isNoticeLine) || containsKnownLicense(lines))) {
      indexes.add(run[position]);
      position += 1;
      continue;
    }
    let end = position;
    const fragmentLines = [];
    while (end < run.length) {
      const fragment = commentContentLines(comments[run[end]].text);
      if (!fragment.every(isLicenseFragment)) break;
      fragmentLines.push(...fragment);
      end += 1;
    }
    if (end === position || !containsKnownLicense(fragmentLines)) break;
    for (let index = position; index < end; index += 1) indexes.add(run[index]);
    position = end;
  }
  return indexes;
};

export const classifyComments = (source, comments, language, { generatedIconOutput = false } = {}) => {
  const skip = language === "swift" ? skipDirectiveIndexes(source, comments) : new Set();
  const provenance = generatedIconOutput ? iconProvenanceIndexes(comments) : new Set();
  const directives = comments.map((comment, index) => {
    if (skip.has(index)) return { kind: "skip-directive" };
    if (provenance.has(index)) return { kind: "provenance-hash" };
    return directiveKind(language, comment.text, comment.start, source.slice(0, comment.start).split("\n").length);
  });
  const license = licenseHeaderIndexes(source, comments, (index) => directives[index] !== undefined);
  return comments.map((_, index) => {
    if (directives[index]) return directives[index];
    if (license.has(index)) return { kind: "license-header" };
    return { problem: "comment" };
  });
};
