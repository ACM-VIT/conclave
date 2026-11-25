const INSTRUCTIONS = new Set(["FROM", "ARG", "ENV", "WORKDIR", "RUN", "COPY", "USER", "EXPOSE", "CMD", "ENTRYPOINT", "LABEL", "HEALTHCHECK", "STOPSIGNAL", "SHELL", "VOLUME"]);
const PLAIN_TEXT = /^[\t\x20-\x7E]*$/;
const DIRECTIVE_LIKE = /^\s*#\s*[A-Za-z][A-Za-z0-9_-]*\s*=/;
const WORD = /^[A-Za-z0-9_.\/@+=:,-]+$/;
const FLAG = /^--([a-z]+)(?:=(\S*))?$/;
const COPY_FLAGS = new Set(["from", "chown", "chmod", "link"]);
const VALUE_FLAGS = new Set(["from", "chown", "chmod"]);

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
    else current = { line: index + 1, text: text.trimStart() };
    if (continues) return;
    instructions.push(current);
    current = null;
  });
  if (current) throw new DockerfileError(`line ${current.line}: the Dockerfile ends inside a line continuation`);
  return instructions;
}

function splitFlags(words, line) {
  const flags = [];
  let index = 0;
  for (; index < words.length && words[index].startsWith("--"); index += 1) {
    const match = FLAG.exec(words[index]);
    if (!match) throw unsupported(line, `the flag ${words[index]}`);
    flags.push({ name: match[1], value: match[2] });
  }
  return { flags, rest: words.slice(index) };
}

function copySources(instruction) {
  const { line, text } = instruction;
  const args = text.slice("COPY".length).trim();
  const words = args.split(/[ \t]+/).filter(Boolean);
  const { flags, rest } = splitFlags(words, line);
  for (const { name, value } of flags) {
    if (!COPY_FLAGS.has(name)) throw unsupported(line, `COPY --${name}`);
    if (VALUE_FLAGS.has(name) ? !value || !WORD.test(value) : value !== undefined) throw unsupported(line, `COPY --${name}${value === undefined ? "" : `=${value}`}`);
  }
  const exec = rest[0]?.startsWith("[");
  const items = exec ? execItems(rest.join(" "), line) : rest;
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

function checkRun({ line, text }) {
  const words = text.slice("RUN".length).trim().split(/[ \t]+/).filter(Boolean);
  for (const word of words) {
    if (!word.startsWith("--")) break;
    const match = /^--mount=(\S+)$/.exec(word);
    if (!match) throw unsupported(line, `the RUN flag ${word}`);
    const options = Object.fromEntries(match[1].split(",").map((part) => part.split("=")));
    if (!["cache", "secret", "tmpfs", "ssh"].includes(options.type) || "from" in options) throw unsupported(line, `RUN --mount=${match[1]}`);
  }
}

export function contextCopies(text) {
  const copies = [];
  let stage = false;
  for (const instruction of logicalInstructions(physicalLines(text))) {
    const { line } = instruction;
    if (instruction.text.includes("<<")) throw unsupported(line, "a heredoc or a << in an instruction");
    const keyword = /^\S+/.exec(instruction.text)[0];
    if (!INSTRUCTIONS.has(keyword)) throw unsupported(line, `the instruction ${keyword}`);
    if (keyword === "FROM") stage = true;
    else if (!stage && keyword !== "ARG") throw new DockerfileError(`line ${line}: ${keyword} comes before the first FROM`);
    else if (keyword === "RUN") checkRun(instruction);
    else if (keyword === "COPY") {
      const { fromStage, sources } = copySources(instruction);
      if (!fromStage) copies.push({ line, sources });
    }
  }
  return copies;
}
