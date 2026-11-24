import { readdirSync } from "node:fs";
import path from "node:path";

const WILDCARD = /[*?[\\]/;

export function cleanPattern(pattern) {
  const cleaned = path.posix.normalize(pattern).replace(/\/+$/, "");
  return cleaned.length > 1 && cleaned.startsWith("/") ? cleaned.slice(1) : cleaned;
}

export function patternRegExp(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      i += 1;
      if (pattern[i + 1] === "/") {
        i += 1;
        source += "(.*/)?";
      } else {
        source += ".*";
      }
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) throw new Error(`unterminated character class in pattern "${pattern}"`);
      source += pattern.slice(i, end + 1);
      i = end;
    } else if (ch === "\\" && i + 1 < pattern.length) {
      i += 1;
      source += `\\${pattern[i]}`;
    } else {
      source += ch.replace(/[.+()|{}$^\]]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

export function parseDockerIgnore(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const exclusion = line.startsWith("!");
      const pattern = cleanPattern(exclusion ? line.slice(1).trim() : line);
      const segments = pattern.split("/");
      const firstWildcard = segments.findIndex((segment) => WILDCARD.test(segment));
      return {
        exclusion,
        pattern,
        regExp: patternRegExp(pattern),
        literalSegments: firstWildcard === -1 ? segments : segments.slice(0, firstWildcard),
      };
    });
}

function selfAndAncestors(file) {
  const segments = file.split("/");
  return segments.map((_, i) => segments.slice(0, i + 1).join("/"));
}

export function dockerIgnoreMatcher(text) {
  const patterns = parseDockerIgnore(text);
  const excluded = (file) => {
    const paths = selfAndAncestors(file);
    let isExcluded = false;
    for (const { exclusion, regExp } of patterns) {
      if (exclusion !== isExcluded) continue;
      if (paths.some((item) => regExp.test(item))) isExcluded = !exclusion;
    }
    return isExcluded;
  };
  const mayIncludeUnder = (dir) => {
    const paths = selfAndAncestors(dir);
    const segments = dir.split("/");
    const lastCover = patterns.findLastIndex(({ exclusion, regExp }) => !exclusion && paths.some((item) => regExp.test(item)));
    return patterns.some(({ exclusion, literalSegments }, index) => {
      if (!exclusion || index < lastCover) return false;
      const overlap = Math.min(segments.length, literalSegments.length);
      return segments.slice(0, overlap).every((segment, i) => segment === literalSegments[i]);
    });
  };
  return { excluded, mayIncludeUnder };
}

export function walkContext(root, matcher) {
  const files = [];
  const visit = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!matcher.excluded(file) || matcher.mayIncludeUnder(file)) visit(file);
      } else if (!matcher.excluded(file)) {
        files.push(file);
      }
    }
  };
  visit("");
  return files.sort();
}

export function contextDirectories(files) {
  const dirs = new Set([""]);
  for (const file of files) {
    const segments = file.split("/").slice(0, -1);
    segments.forEach((_, i) => dirs.add(segments.slice(0, i + 1).join("/")));
  }
  return [...dirs].sort();
}
