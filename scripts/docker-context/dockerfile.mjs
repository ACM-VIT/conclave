const INSTRUCTIONS = new Set(["FROM", "ARG", "ENV", "WORKDIR", "RUN", "COPY", "USER", "EXPOSE", "CMD", "ENTRYPOINT", "LABEL", "HEALTHCHECK", "STOPSIGNAL", "SHELL", "VOLUME"]);
const PLAIN_TEXT = /^[\t\x20-\x7E]*$/;
const DIRECTIVE_LIKE = /^\s*#\s*[A-Za-z][A-Za-z0-9_-]*\s*=/;
const WORD = /^[A-Za-z0-9_.\/@+=:,-]+$/;
const FLAG = /^--([a-z][a-z-]*)(?:=(.*))?$/;
const VALUE_FLAGS = {
  COPY: new Set(["from", "chown", "chmod"]),
  FROM: new Set(["platform"]),
  HEALTHCHECK: new Set(["interval", "timeout", "start-period", "start-interval", "retries"]),
  RUN: new Set(["mount"]),
};
const MOUNT_PAIR = /^([a-z]+)=([A-Za-z0-9_.\/@+:-]+)$/;
const MOUNT_KEYS = new Map([
  ["cache", new Set(["target", "id", "sharing", "ro", "mode", "uid", "gid"])],
  ["tmpfs", new Set(["target", "size"])],
  ["secret", new Set(["target", "id", "env", "required", "mode", "uid", "gid"])],
  ["ssh", new Set(["target", "id", "required", "mode", "uid", "gid"])],
]);
const MOUNT_ALIASES = new Map([
  ["dst", "target"], ["destination", "target"],
  ["readonly", "ro"], ["rw", "ro"], ["readwrite", "ro"],
]);

export class DockerfileError extends Error {}

function unsupported(line, detail) {
  return new DockerfileError(`unsupported Dockerfile syntax on line ${line}: ${detail}; extend scripts/docker-context or rewrite the Dockerfile`);
}

function physicalLines(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!PLAIN_TEXT.test(line)) throw unsupported(index + 1, "a character outside printable ASCII and tab");
    if (DIRECTIVE_LIKE.test(line)) throw unsupported(index + 1, "a parser directive or a comment shaped like one");
  });
  return lines;
}

function logicalInstructions(lines) {
  const instructions = [];
  let current = null;
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const end = raw.replace(/[ \t]+$/, "");
    if (end.endsWith("\\\\")) throw unsupported(index + 1, "a line that ends in two backslashes");
    const continues = end.endsWith("\\");
    const text = continues ? end.slice(0, -1) : raw;
    if (current) current.text += text;
    else {
      const start = text.trimStart();
      if (!start) throw unsupported(index + 1, "a leading line continuation with no instruction");
      current = { line: index + 1, text: start };
    }
    if (continues) return;
    instructions.push(current);
    current = null;
  });
  if (current) throw new DockerfileError(`line ${current.line}: the Dockerfile ends inside a line continuation`);
  return instructions;
}

function instructionArgs(keyword, args, line) {
  const flags = [];
  const seen = new Set();
  for (const { 0: word, index } of args.matchAll(/[^ \t]+/g)) {
    if (!word.startsWith("--")) return { flags, rest: args.slice(index) };
    const match = FLAG.exec(word);
    if (!match || !WORD.test(word)) throw unsupported(line, `${keyword} ${word}`);
    const [, name, value] = match;
    const isSwitch = keyword === "COPY" && name === "link";
    if (isSwitch ? value !== undefined : !VALUE_FLAGS[keyword]?.has(name) || !value) throw unsupported(line, `${keyword} ${word}`);
    if (name !== "mount" && seen.has(name)) throw unsupported(line, `duplicate ${keyword} --${name}`);
    seen.add(name);
    flags.push({ name, value });
  }
  return { flags, rest: "" };
}

function copySources({ flags, rest }, line) {
  const items = rest.startsWith("[") ? execItems(rest, line) : rest.split(/[ \t]+/).filter(Boolean);
  const odd = items.find((word) => !WORD.test(word));
  if (odd !== undefined) throw unsupported(line, `the COPY word ${JSON.stringify(odd)}`);
  if (items.length < 2) throw new DockerfileError(`line ${line}: COPY needs a source and a destination`);
  return { fromStage: flags.some(({ name }) => name === "from"), sources: items.slice(0, -1) };
}

function execItems(text, line) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unsupported(line, "a COPY argument list that is not a JSON array of words");
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw unsupported(line, "a COPY argument list that is not a JSON array of words");
  return parsed;
}

function checkMount(value, line) {
  const options = new Map();
  for (const part of value.split(",")) {
    const match = MOUNT_PAIR.exec(part);
    if (!match) throw unsupported(line, `invalid RUN mount option ${JSON.stringify(part)}`);
    const [, name, setting] = match;
    const key = MOUNT_ALIASES.get(name) ?? name;
    if (options.has(key)) throw unsupported(line, `duplicate RUN mount option ${name}`);
    options.set(key, setting);
  }
  const type = options.get("type");
  const allowed = MOUNT_KEYS.get(type);
  if (!allowed) throw unsupported(line, `RUN mount type ${type ?? "(missing)"}`);
  for (const key of options.keys()) {
    if (key !== "type" && !allowed.has(key)) throw unsupported(line, `RUN mount option ${key} for type ${type}`);
  }
}

export function contextCopies(text) {
  const copies = [];
  let stage = false;
  for (const instruction of logicalInstructions(physicalLines(text))) {
    const { line } = instruction;
    if (instruction.text.includes("<<")) throw unsupported(line, "a heredoc or a << in an instruction");
    const [keyword] = instruction.text.split(/[ \t]+/, 1);
    if (!INSTRUCTIONS.has(keyword)) throw unsupported(line, `the instruction ${keyword}`);
    const args = instructionArgs(keyword, instruction.text.slice(keyword.length), line);
    if (keyword === "FROM") stage = true;
    else if (!stage && keyword !== "ARG") throw new DockerfileError(`line ${line}: ${keyword} comes before the first FROM`);
    else if (keyword === "RUN") {
      for (const { value } of args.flags) checkMount(value, line);
    } else if (keyword === "COPY") {
      const { fromStage, sources } = copySources(args, line);
      if (!fromStage) copies.push({ line, sources });
    }
  }
  return copies;
}
