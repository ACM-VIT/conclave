import { UnsupportedShape } from "./unsupported.mjs";

const DIRECTIVE = /^#\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(.*?)\s*$/;
const HEREDOC = /^\d*<<(-?)([^<]*)$/;
const HEREDOC_KEYWORDS = new Set(["RUN", "COPY", "ADD"]);
const COPY_FLAGS = new Set(["from", "chown", "chmod", "link"]);
const CONTEXT_READERS = new Set(["ADD", "ONBUILD"]);
const UNKNOWN = Symbol("unknown");

export class DockerfileError extends Error {}

function splitDirectives(lines) {
  const directives = {};
  let index = 0;
  for (; index < lines.length; index += 1) {
    const match = DIRECTIVE.exec(lines[index]);
    if (!match || match[1].toLowerCase() in directives) break;
    directives[match[1].toLowerCase()] = match[2];
  }
  return { directives, body: lines.slice(index) };
}

export function heredocsIn(words, escape = "\\") {
  const found = [];
  for (let i = 0; i < words.length; i += 1) {
    const match = HEREDOC.exec(words[i]);
    if (!match) continue;
    const chomp = match[1] === "-";
    let name = match[2];
    const indices = [i];
    if (!name) {
      if (chomp || i + 1 >= words.length) continue;
      i += 1;
      name = words[i];
      indices.push(i);
      if (name.includes("<")) continue;
    }
    const names = splitWords(name, escape);
    if (names.length !== 1) continue;
    found.push({ indices, chomp, terminator: expandWord(names[0], {}, escape) });
  }
  return found;
}

function heredocsOf(text, escape) {
  const words = splitWords(text, escape);
  return HEREDOC_KEYWORDS.has(words[0].toUpperCase()) ? heredocsIn(words.slice(1), escape) : [];
}

function logicalInstructions(lines, escape) {
  const instructions = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const continues = raw.trimEnd().endsWith(escape);
    const text = continues ? raw.trimEnd().slice(0, -1) : raw;
    if (current) current.text += text;
    else current = { line: i + 1, text: text.trimStart() };
    if (continues) continue;
    const heredocs = heredocsOf(current.text, escape);
    for (const { terminator, chomp } of heredocs) {
      for (i += 1; i < lines.length && (chomp ? lines[i].replace(/^\t+/, "") : lines[i]) !== terminator; i += 1);
      if (i >= lines.length) throw new DockerfileError(`line ${current.line}: heredoc ${terminator} is never closed`);
    }
    instructions.push(current);
    current = null;
  }
  if (current) throw new DockerfileError(`line ${current.line}: the Dockerfile ends inside a line continuation`);
  return instructions;
}

function valueOf(vars, name, word) {
  if (!Object.hasOwn(vars, name) || vars[name] === UNKNOWN) {
    throw new UnsupportedShape(`$${name} in "${word}" has no value the guard can resolve`);
  }
  return vars[name];
}

export function expandWord(word, vars, escape = "\\", { removeQuotes = true } = {}) {
  let out = "";
  let quote = null;
  for (let i = 0; i < word.length; i += 1) {
    const ch = word[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else out += ch;
      continue;
    }
    if (ch === escape && i + 1 < word.length) {
      i += 1;
      out += word[i];
      continue;
    }
    if (removeQuotes && (ch === "'" || ch === '"') && quote === null) {
      quote = ch;
      continue;
    }
    if (removeQuotes && ch === '"' && quote === '"') {
      quote = null;
      continue;
    }
    if (ch !== "$") {
      out += ch;
      continue;
    }
    if (word[i + 1] === "{") {
      const end = word.indexOf("}", i + 2);
      if (end === -1) throw new DockerfileError(`unterminated variable in "${word}"`);
      const body = word.slice(i + 2, end);
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+])(.*))?$/.exec(body);
      if (!match) throw new UnsupportedShape(`variable expression \${${body}} in "${word}"`);
      const [, name, operator, operand = ""] = match;
      const value = valueOf(vars, name, word);
      const set = operator?.startsWith(":") ? Boolean(value) : value !== undefined;
      const fallback = () => expandWord(operand, vars, escape, { removeQuotes: false });
      if (operator?.endsWith("-")) out += set ? value : fallback();
      else if (operator?.endsWith("+")) out += set ? fallback() : "";
      else out += value ?? "";
      i = end;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(word.slice(i + 1));
    if (!match) {
      out += ch;
      continue;
    }
    out += valueOf(vars, match[0], word) ?? "";
    i += match[0].length;
  }
  if (quote) throw new DockerfileError(`unterminated quote in "${word}"`);
  return out;
}

function expandOrUnknown(word, vars, escape) {
  try {
    return expandWord(word, vars, escape);
  } catch (error) {
    if (error instanceof UnsupportedShape) return UNKNOWN;
    throw error;
  }
}

function splitFlags(args) {
  const flags = [];
  let rest = args.trimStart();
  const pattern = /^--([A-Za-z][A-Za-z0-9-]*)(?:=(\S*))?(?:\s+|$)/;
  for (let match = pattern.exec(rest); match; match = pattern.exec(rest)) {
    flags.push({ name: match[1], value: match[2] ?? "" });
    rest = rest.slice(match[0].length);
  }
  return { flags, rest: rest.trim() };
}

function execForm(rest) {
  if (!rest.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(rest);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function splitWords(text, escape) {
  const words = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === escape && i + 1 < text.length && quote !== "'") {
      current += ch + text[i + 1];
      i += 1;
    } else if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (/\s/.test(ch)) {
      if (current) words.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) words.push(current);
  return words;
}

function assignments(rest, vars, escape, legacySeparator) {
  const words = splitWords(rest, escape);
  if (legacySeparator && words.length && !words[0].includes("=")) {
    return [[words[0], expandOrUnknown(rest.slice(rest.indexOf(words[0]) + words[0].length).trim(), vars, escape)]];
  }
  return words.map((word) => {
    const eq = word.indexOf("=");
    if (eq === -1) return [word, undefined];
    return [word.slice(0, eq), expandOrUnknown(word.slice(eq + 1), vars, escape)];
  });
}

export function contextCopies(text, buildArgs = {}) {
  const { directives, body } = splitDirectives(text.replace(/^\uFEFF/, "").split(/\r?\n/));
  const escape = directives.escape ?? "\\";
  if (escape !== "\\" && escape !== "`") throw new DockerfileError(`unsupported escape directive "${escape}"`);
  const copies = [];
  const globalArgs = {};
  let stage = null;
  for (const instruction of logicalInstructions(body, escape)) {
    const match = /^(\S+)\s*([\s\S]*)$/.exec(instruction.text);
    const keyword = match[1].toUpperCase();
    const args = match[2];
    const scope = stage ? { ...stage.args, ...stage.env } : globalArgs;
    if (keyword === "ARG") {
      for (const [name, fallback] of assignments(args, scope, escape, false)) {
        const value = Object.hasOwn(buildArgs, name) ? buildArgs[name] : (fallback ?? (stage ? globalArgs[name] : undefined));
        if (stage) stage.args[name] = value;
        else globalArgs[name] = value;
      }
    } else if (keyword === "FROM") {
      stage = { args: {}, env: {} };
    } else if (!stage) {
      throw new DockerfileError(`line ${instruction.line}: ${keyword} comes before the first FROM`);
    } else if (keyword === "ENV") {
      for (const [name, value] of assignments(args, scope, escape, true)) stage.env[name] = value;
    } else if (CONTEXT_READERS.has(keyword)) {
      throw new UnsupportedShape(`line ${instruction.line}: the ${keyword} instruction`);
    } else if (keyword === "RUN") {
      const bind = splitFlags(args).flags.find((flag) => flag.name === "mount" && !/(?:^|,)from=/.test(flag.value) && (/(?:^|,)type=bind(?:,|$)/.test(flag.value) || !/(?:^|,)type=/.test(flag.value)));
      if (bind) throw new UnsupportedShape(`line ${instruction.line}: RUN --mount=${bind.value} reads the build context`);
    } else if (keyword === "COPY") {
      const { flags, rest } = splitFlags(args);
      const unknown = flags.find((flag) => !COPY_FLAGS.has(flag.name));
      if (unknown) throw new UnsupportedShape(`line ${instruction.line}: COPY --${unknown.name}`);
      if (flags.some((flag) => flag.name === "from")) continue;
      const exec = execForm(rest);
      const raw = exec ?? splitWords(rest, escape);
      if (raw.length < 2) throw new DockerfileError(`line ${instruction.line}: COPY needs a source and a destination`);
      const inline = new Set(exec ? [] : heredocsIn(raw, escape).flatMap(({ indices }) => indices));
      const sources = raw
        .slice(0, -1)
        .filter((_, index) => !inline.has(index))
        .map((word) => expandWord(word, scope, escape, { removeQuotes: !exec }));
      if (sources.length) copies.push({ line: instruction.line, sources });
    }
  }
  return copies;
}
