const DIRECTIVE = /^#\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(.*?)\s*$/;
const HEREDOC = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
const SHELLS = new Set(["sh", "bash", "/bin/sh", "/bin/bash", "/usr/bin/sh", "/usr/bin/bash"]);

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

function logicalInstructions(lines, escape) {
  const instructions = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.startsWith("#") || (current && trimmed === "")) continue;
    if (!current && trimmed === "") continue;
    const continues = raw.trimEnd().endsWith(escape);
    const text = continues ? raw.trimEnd().slice(0, -1) : raw;
    if (current) current.text += text;
    else current = { line: i + 1, text: text.trimStart() };
    if (continues) continue;
    const heredocs = [...current.text.matchAll(HEREDOC)].map((match) => match[2]);
    const keyword = current.text.split(/\s+/, 1)[0].toUpperCase();
    current.heredocs = [];
    if (heredocs.length && ["RUN", "COPY", "ADD"].includes(keyword)) {
      for (const terminator of heredocs) {
        const body = [];
        for (i += 1; i < lines.length && lines[i].replace(/^\t+/, "") !== terminator; i += 1) body.push(lines[i]);
        if (i >= lines.length) throw new DockerfileError(`line ${current.line}: heredoc ${terminator} is never closed`);
        current.heredocs.push({ terminator, body: body.join("\n") });
      }
    }
    instructions.push(current);
    current = null;
  }
  if (current) throw new DockerfileError(`line ${current.line}: the Dockerfile ends inside a line continuation`);
  return instructions;
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
      if (!match) throw new DockerfileError(`unsupported variable expression \${${body}} in "${word}"`);
      const [, name, operator, operand = ""] = match;
      const value = vars[name];
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
    out += vars[match[0]] ?? "";
    i += match[0].length;
  }
  if (quote) throw new DockerfileError(`unterminated quote in "${word}"`);
  return out;
}

function splitFlags(args) {
  const flags = [];
  let rest = args.trimStart();
  for (let match = /^--([A-Za-z][A-Za-z0-9-]*)(?:=(\S*))?(?:\s+|$)/.exec(rest); match; match = /^--([A-Za-z][A-Za-z0-9-]*)(?:=(\S*))?(?:\s+|$)/.exec(rest)) {
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
    return [[words[0], expandWord(rest.slice(rest.indexOf(words[0]) + words[0].length).trim(), vars, escape)]];
  }
  return words.map((word) => {
    const eq = word.indexOf("=");
    if (eq === -1) return [word, undefined];
    return [word.slice(0, eq), expandWord(word.slice(eq + 1), vars, escape)];
  });
}

function mountSources(flags, vars, escape) {
  return flags
    .filter((flag) => flag.name === "mount")
    .map((flag) => Object.fromEntries(flag.value.split(",").map((part) => {
      const eq = part.indexOf("=");
      return eq === -1 ? [part, "true"] : [part.slice(0, eq), part.slice(eq + 1)];
    })))
    .filter((mount) => (mount.type ?? "bind") === "bind" && !mount.from)
    .map((mount) => expandWord(mount.source ?? mount.src ?? ".", vars, escape));
}

export function parseDockerfile(text, buildArgs = {}) {
  const { directives, body } = splitDirectives(text.replace(/^\uFEFF/, "").split(/\r?\n/));
  const escape = directives.escape ?? "\\";
  if (escape !== "\\" && escape !== "`") throw new DockerfileError(`unsupported escape directive "${escape}"`);
  const steps = [];
  const globalArgs = {};
  let stage = null;
  for (const instruction of logicalInstructions(body, escape)) {
    const match = /^(\S+)\s*([\s\S]*)$/.exec(instruction.text);
    const keyword = match[1].toUpperCase();
    const { flags, rest } = ["COPY", "ADD", "RUN"].includes(keyword) ? splitFlags(match[2]) : { flags: [], rest: match[2].trim() };
    const scope = stage ? { ...stage.args, ...stage.env } : globalArgs;
    if (keyword === "FROM") {
      stage = { args: {}, env: {} };
      continue;
    }
    if (keyword === "ARG") {
      for (const [name, fallback] of assignments(rest, scope, escape, false)) {
        const value = buildArgs[name] ?? (stage ? fallback ?? globalArgs[name] : fallback);
        if (stage) stage.args[name] = value;
        else globalArgs[name] = value;
      }
      continue;
    }
    if (!stage) throw new DockerfileError(`line ${instruction.line}: ${keyword} comes before the first FROM`);
    if (keyword === "ENV") {
      for (const [name, value] of assignments(rest, scope, escape, true)) stage.env[name] = value;
      continue;
    }
    if (keyword === "COPY" || keyword === "ADD") {
      if (flags.some((flag) => flag.name === "from")) continue;
      if (instruction.heredocs.length) continue;
      const exec = execForm(rest);
      const words = exec
        ? exec.map((word) => expandWord(word, scope, escape, { removeQuotes: false }))
        : splitWords(rest, escape).map((word) => expandWord(word, scope, escape));
      if (words.length < 2) throw new DockerfileError(`line ${instruction.line}: ${keyword} needs a source and a destination`);
      steps.push({ kind: "copy", line: instruction.line, sources: words.slice(0, -1) });
      continue;
    }
    if (keyword === "RUN" || keyword === "CMD" || keyword === "ENTRYPOINT") {
      const sources = keyword === "RUN" ? mountSources(flags, scope, escape) : [];
      if (sources.length) steps.push({ kind: "copy", line: instruction.line, sources });
      const exec = execForm(rest);
      const scripts = instruction.heredocs.map((heredoc) => heredoc.body);
      steps.push({ kind: "command", line: instruction.line, instruction: keyword, argv: exec, shell: exec ? null : rest, scripts });
    }
  }
  return { directives, steps };
}

export function shellCommands(script) {
  const commands = [];
  let words = [];
  let current = "";
  let quote = null;
  let started = false;
  const endWord = () => {
    if (started) words.push(current);
    current = "";
    started = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < script.length) current += script[++i];
      else current += ch;
    } else if (ch === "\\" && i + 1 < script.length) {
      if (script[i + 1] !== "\n") {
        current += script[i + 1];
        started = true;
      }
      i += 1;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "#" && !started) {
      while (i + 1 < script.length && script[i + 1] !== "\n") i += 1;
    } else if (/[;&|()\n]/.test(ch)) {
      endCommand();
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new DockerfileError(`unterminated quote in shell script "${script}"`);
  endCommand();
  return commands;
}

export function commandsOf(step) {
  if (step.kind !== "command") return [];
  const fromScripts = step.scripts.flatMap(shellCommands);
  if (step.shell !== null) return [...shellCommands(step.shell), ...fromScripts];
  const [program, ...args] = step.argv;
  const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
  if (SHELLS.has(program) && flag !== -1 && args[flag + 1] !== undefined) return [...shellCommands(args[flag + 1]), ...fromScripts];
  return [step.argv, ...fromScripts];
}

export function stripCommandPrefix(words) {
  let i = 0;
  while (i < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
    else if (words[i] === "exec" || words[i] === "env" || words[i].endsWith("/dumb-init") || words[i] === "dumb-init" || words[i] === "--") i += 1;
    else break;
  }
  return words.slice(i);
}
