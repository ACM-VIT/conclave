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

export const languageOf = (file) => LANGUAGE_BY_EXTENSION[/\.[^./]+$/.exec(file)?.[0] ?? ""];

export const isFirstPartySource = (file) =>
  languageOf(file) !== undefined && !VENDORED_PREFIXES.some((prefix) => file.startsWith(prefix));

export const vendoredIgnores = (packageDir) =>
  VENDORED_PREFIXES.filter((prefix) => prefix.startsWith(packageDir)).map((prefix) => prefix.slice(packageDir.length));

const LICENSE_MARKERS = [
  /SPDX-License-Identifier:\s*\S/,
  /@license\b/,
  /\bCopyright\s+(?:\(c\)|\(C\)|©)\s*\S/,
  /\bCopyright\s+(?:\d{4}|[A-Z][\w&.,-]+)/,
  /©\s*\d{4}/,
  /\bPermission is hereby granted\b/i,
  /\bLicensed under the (?:Apache|MIT|BSD|GNU|Mozilla|ISC)\b/,
  /\b(?:Apache-2\.0|Apache License|MIT License|BSD-[0-4]-Clause|(?:L|A)?GPL-[23]\.0|MPL-2\.0|ISC License|CC-BY-[\d.]+)\b/,
  /^\/\/ Ported (?:verbatim |\(and trimmed\) )?from \S/,
];

const hasLicenseMarker = (text) => LICENSE_MARKERS.some((marker) => marker.test(text));

const DIRECTIVE_PROLOGUE = /^\s*(?:(["'])use [a-z ]+\1;?\s*)*$/;

const ESLINT_DIRECTIVE = /^(?:\/\/|\/\*)\s*eslint-(disable|enable)(?:-next-line|-line)?(?=\s|\*\/|$)/;
const ESLINT_INLINE_CONFIG = /^\/\*\s*eslint(?:-env)?\s/;
const ESLINT_REASON = /\s-{2,}\s+\S/;
const TS_EXPECT_ERROR = /^(?:\/\/|\/\*)\s*@ts-expect-error\b([\s\S]*?)(?:\*\/)?$/;

const SOURCE_MAP_URL = /^(?:\/\/|\/\*)[#@]\s*sourceMappingURL=\S+\s*(?:\*\/)?$/;

const SKIP_KEYWORD = /^SKIP (?:@\S|ATTRIBUTES:|INSERT:|REPLACE:|DECLARE:|NOWARN(?:\([^)\n]*\))?$|EXTERN|SYMBOLFILE)/;
const SKIP_CONTINUES = /^SKIP (?:@\S|ATTRIBUTES:|INSERT:|REPLACE:|DECLARE:)/;

const skipDirectiveBody = (text) => {
  if (text.startsWith("// ")) return text.slice(3);
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

export const configuresNoComments = (text) =>
  ESLINT_INLINE_CONFIG.test(text) && text.includes(NO_COMMENTS_RULE);

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

const directiveKind = (language, text, start) => {
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

const licenseHeaderIndexes = (source, comments, isDirective) => {
  const block = [];
  let previousEnd = 0;
  for (let index = 0; index < comments.length; index += 1) {
    const gap = source.slice(previousEnd, comments[index].start);
    if (index === 0 ? !DIRECTIVE_PROLOGUE.test(gap) : !/^[ \t]*\n[ \t]*$/.test(gap)) break;
    block.push(index);
    previousEnd = comments[index].end;
  }
  const hasMarker = block.some((index) => !isDirective(index) && hasLicenseMarker(comments[index].text));
  return new Set(hasMarker ? block : []);
};

export const classifyComments = (source, comments, language) => {
  const skip = language === "swift" ? skipDirectiveIndexes(source, comments) : new Set();
  const provenance = language === "swift" || language === "kotlin" ? iconProvenanceIndexes(comments) : new Set();
  const directives = comments.map((comment, index) => {
    if (skip.has(index)) return { kind: "skip-directive" };
    if (provenance.has(index)) return { kind: "provenance-hash" };
    return directiveKind(language, comment.text, comment.start);
  });
  const license = licenseHeaderIndexes(source, comments, (index) => directives[index] !== undefined);
  return comments.map((_, index) => {
    if (directives[index]) return directives[index];
    if (license.has(index)) return { kind: "license-header" };
    return { problem: "comment" };
  });
};
