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

const LICENSE_MARKER =
  /SPDX-License-Identifier:|@license\b|\bcopyright\b|\bpermission is hereby granted\b|\blicensed under\b/i;

const ESLINT_DIRECTIVE = /^(?:\/\/|\/\*)\s*eslint-(disable|enable)(?:-next-line|-line)?(?=\s|\*\/|$)/;
const ESLINT_REASON = /\s-{2,}\s+\S/;
const TS_EXPECT_ERROR = /^(?:\/\/|\/\*)\s*@ts-expect-error\b([\s\S]*?)(?:\*\/)?$/;

const SOURCE_MAP_URL = /^(?:\/\/|\/\*)[#@]\s*sourceMappingURL=\S+\s*(?:\*\/)?$/;

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

const eslintDirectiveKind = (text) => {
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

const licenseHeaderIndexes = (source, comments) => {
  const indexes = new Set();
  let block = [];
  let previousEnd = 0;
  const flush = () => {
    if (block.some((index) => LICENSE_MARKER.test(comments[index].text))) {
      for (const index of block) indexes.add(index);
    }
    block = [];
  };
  for (let index = 0; index < comments.length; index += 1) {
    const gap = source.slice(previousEnd, comments[index].start);
    if (gap.trim() !== "") break;
    if ((gap.match(/\n/g) ?? []).length > 1) flush();
    block.push(index);
    previousEnd = comments[index].end;
  }
  flush();
  return indexes;
};

export const classifyComments = (source, comments, language) => {
  const license = licenseHeaderIndexes(source, comments);
  return comments.map((comment, index) => {
    const directive = directiveKind(language, comment.text, comment.start);
    if (directive?.kind) return directive;
    if (license.has(index)) return { kind: "license-header" };
    return directive ?? { problem: "comment" };
  });
};
