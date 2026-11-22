import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

export class CommentParserError extends Error {}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const requireHere = createRequire(import.meta.url);

const fail = (file, reason) => {
  throw new CommentParserError(`cannot read the comments in ${file}: ${reason}`);
};

const cacheRoot = () =>
  process.env.CONCLAVE_CACHE_DIR ||
  process.env.XDG_CACHE_HOME ||
  (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches") : path.join(os.homedir(), ".cache"));

const toolCache = (...parts) => path.join(cacheRoot(), "conclave", ...parts);

const utf8IndexMapper = (text) => {
  const buffer = Buffer.from(text, "utf8");
  return (byteOffset) => buffer.subarray(0, byteOffset).toString("utf8").length;
};

export const toolWorks = (command, args = ["--version"]) => {
  const probe = spawnSync(command, args, { encoding: "utf8" });
  if (probe.error) return { ok: false, reason: `\`${command}\` is not on PATH` };
  if (probe.status !== 0) {
    const detail = (probe.stderr || probe.stdout || "").trim().split("\n")[0];
    return { ok: false, reason: `\`${command} ${args.join(" ")}\` exited with ${probe.status}${detail ? ` (${detail})` : ""}` };
  }
  return { ok: true };
};

const scanScript = (text, file) => {
  const source = text.replace(/^#!([^\n]*)/, "//$1");
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

let cssTokenizer;

const scanCss = (text, file) => {
  try {
    cssTokenizer ??= requireHere("@csstools/css-tokenizer");
  } catch (error) {
    fail(file, `the @csstools/css-tokenizer dev dependency is missing, run pnpm install (${error.message})`);
  }
  const { tokenize, TokenType } = cssTokenizer;
  return tokenize({ css: text })
    .filter((token) => token[0] === TokenType.Comment)
    .map((token) => [token[2], token[3] + 1]);
};

let shellParser;

const scanShell = (text, file) => {
  try {
    shellParser ??= requireHere("sh-syntax/sync").parse;
  } catch (error) {
    fail(file, `the sh-syntax dev dependency is missing, run pnpm install (${error.message})`);
  }
  let tree;
  try {
    tree = shellParser(text, { keepComments: true });
  } catch (error) {
    fail(file, `sh-syntax could not parse it: ${error instanceof Error ? error.message : String(error)}`);
  }
  const toIndex = utf8IndexMapper(text);
  const comments = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.type === "Comment") {
      const start = toIndex(node.hash.offset);
      comments.push([start, start + 1 + node.text.length]);
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(tree);
  return comments.sort((a, b) => a[0] - b[0]);
};

const PYTHON_TOKENIZE = `
import io, json, sys, tokenize
text = sys.stdin.read()
if sys.version_info < (3, 12):
    print(json.dumps({"error": "Python 3.12 or newer is required to read Python comments (PEP 701 f-strings); found " + sys.version.split()[0]}))
    sys.exit(0)
lines = io.StringIO(text, newline="").readlines()
starts = [0]
for line in lines:
    starts.append(starts[-1] + len(line.encode("utf-16-le")) // 2)
def offset(row, col):
    if row > len(lines):
        return starts[-1]
    return starts[row - 1] + len(lines[row - 1][:col].encode("utf-16-le")) // 2
try:
    found = [[offset(*t.start), offset(*t.end)] for t in tokenize.generate_tokens(io.StringIO(text, newline="").readline) if t.type == tokenize.COMMENT]
except (tokenize.TokenError, SyntaxError) as error:
    print(json.dumps({"error": "tokenize could not read it: " + str(error)}))
else:
    print(json.dumps({"comments": found}))
`;

const scanPython = (text, file) => {
  const result = spawnSync("python3", ["-I", "-c", PYTHON_TOKENIZE], { input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(file, "python3 3.12 or newer is required, and `python3` is not on PATH");
  if (result.status !== 0) fail(file, `python3 exited with ${result.status} (${(result.stderr ?? "").trim().split("\n").at(-1)})`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail(file, `python3 printed something other than the tokenizer result: ${result.stdout.slice(0, 120)}`);
  }
  if (parsed.error) fail(file, parsed.error);
  return parsed.comments;
};

const SWIFT_TRIVIA_PACKAGE = path.join(HERE, "swift-trivia");

const swiftSyntaxVersion = () =>
  JSON.parse(readFileSync(path.join(SWIFT_TRIVIA_PACKAGE, "Package.resolved"), "utf8")).pins.find(
    (pin) => pin.identity === "swift-syntax",
  ).state.version;

export const swiftTriviaScratchPath = () => toolCache("swift-trivia", `swift-syntax-${swiftSyntaxVersion()}`);

let swiftTriviaBinary;

const swiftTrivia = (file) => {
  if (swiftTriviaBinary) return swiftTriviaBinary;
  const swift = toolWorks("swift");
  if (!swift.ok) fail(file, `a working Swift toolchain is required to read Swift comments: ${swift.reason}`);
  const scratch = swiftTriviaScratchPath();
  const build = spawnSync("swift", ["build", "-c", "release", "--package-path", SWIFT_TRIVIA_PACKAGE, "--scratch-path", scratch], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  const binary = path.join(scratch, "release", "swift-comment-trivia");
  if (build.status !== 0 || !existsSync(binary)) {
    fail(file, `could not build scripts/quality/comments/swift-trivia (swift-syntax ${swiftSyntaxVersion()}):\n${build.stderr ?? ""}`);
  }
  swiftTriviaBinary = binary;
  return binary;
};

const scanSwift = (text, file) => {
  const result = spawnSync(swiftTrivia(file), [], { input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(file, (result.error?.message ?? result.stderr ?? "").trim());
  const toIndex = utf8IndexMapper(text);
  return JSON.parse(result.stdout).map(([start, end]) => [toIndex(start), toIndex(end)]);
};

const KOTLIN_VERSION = "2.4.21";
const KOTLIN_JARS = [
  { artifact: "kotlin-compiler-embeddable", sha256: "ef19419c765e7ac8404465fa026ca8fc4dbb8a822de0fc79aa53c8dce29f1d02" },
  { artifact: "kotlin-stdlib", sha256: "bd8250210584cb659847dce9cda660f8e9906e5def7fbebcea93dc6dcb6a88a3" },
];
const KOTLIN_HELPER = path.join(HERE, "kotlin-lexer", "KotlinComments.java");

const sha256Of = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const gradleCopyOf = (artifact) => {
  const root = path.join(os.homedir(), ".gradle", "caches", "modules-2", "files-2.1", "org.jetbrains.kotlin", artifact, KOTLIN_VERSION);
  if (!existsSync(root)) return undefined;
  for (const hash of readdirSync(root)) {
    const candidate = path.join(root, hash, `${artifact}-${KOTLIN_VERSION}.jar`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

const uniqueSuffix = () => `${process.pid}.${randomBytes(6).toString("hex")}`;

const publishFile = (temp, target) => {
  try {
    linkSync(temp, target);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    rmSync(temp, { force: true });
  }
};

const kotlinJar = (file, { artifact, sha256 }) => {
  const dir = toolCache("kotlin-lexer", `kotlin-${KOTLIN_VERSION}`, "jars");
  const target = path.join(dir, `${artifact}-${KOTLIN_VERSION}.jar`);
  if (existsSync(target) && sha256Of(target) === sha256) return target;
  if (existsSync(target)) fail(file, `${target} does not match the pinned SHA-256 for ${artifact} ${KOTLIN_VERSION}; delete it and retry`);
  mkdirSync(dir, { recursive: true });
  const temp = `${target}.${uniqueSuffix()}.partial`;
  const gradle = gradleCopyOf(artifact);
  if (gradle) copyFileSync(gradle, temp);
  else {
    const url = `https://repo1.maven.org/maven2/org/jetbrains/kotlin/${artifact}/${KOTLIN_VERSION}/${artifact}-${KOTLIN_VERSION}.jar`;
    const download = spawnSync("curl", ["-sSfL", "-o", temp, url], { encoding: "utf8" });
    if (download.error || download.status !== 0) {
      rmSync(temp, { force: true });
      fail(file, `the Kotlin lexer needs ${artifact} ${KOTLIN_VERSION}, which is not in the Gradle cache and could not be downloaded from ${url} (${(download.stderr ?? download.error?.message ?? "").trim()})`);
    }
  }
  if (sha256Of(temp) !== sha256) {
    rmSync(temp, { force: true });
    fail(file, `${artifact} ${KOTLIN_VERSION} does not match its pinned SHA-256`);
  }
  publishFile(temp, target);
  if (sha256Of(target) !== sha256) fail(file, `${target} does not match the pinned SHA-256 after publishing`);
  return target;
};

let kotlinCommand;

const kotlinLexer = (file) => {
  if (kotlinCommand) return kotlinCommand;
  for (const tool of ["java", "javac"]) {
    const probe = toolWorks(tool, ["-version"]);
    if (!probe.ok) fail(file, `a JDK 17 or newer is required to read Kotlin comments with the Kotlin compiler's lexer: ${probe.reason}`);
  }
  const classpath = KOTLIN_JARS.map((jar) => kotlinJar(file, jar)).join(path.delimiter);
  const helperHash = sha256Of(KOTLIN_HELPER).slice(0, 16);
  const classes = toolCache("kotlin-lexer", `kotlin-${KOTLIN_VERSION}`, `helper-${helperHash}`);
  const installed = path.join(classes, "KotlinComments.class");
  if (!existsSync(installed)) {
    const temp = `${classes}.${uniqueSuffix()}.partial`;
    const compile = spawnSync("javac", ["-d", temp, "-cp", classpath, KOTLIN_HELPER], { encoding: "utf8" });
    if (compile.status !== 0) {
      rmSync(temp, { recursive: true, force: true });
      fail(file, `could not compile the Kotlin lexer helper:\n${compile.stderr}`);
    }
    try {
      renameSync(temp, classes);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    if (!existsSync(installed)) fail(file, `the Kotlin lexer helper was not installed at ${classes}`);
  }
  kotlinCommand = ["java", ["-cp", [classes, classpath].join(path.delimiter), "KotlinComments"]];
  return kotlinCommand;
};

const kotlinRanges = new Map();

export const prepareKotlin = (entries) => {
  const pending = entries.filter(({ text }) => !kotlinRanges.has(text));
  if (pending.length === 0) return;
  const [command, args] = kotlinLexer(pending[0].file);
  const input = pending.map(({ text }) => `${text.length}\n${text}`).join("");
  const result = spawnSync(command, args, { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(pending[0].file, `the Kotlin lexer failed: ${(result.error?.message ?? result.stderr ?? "").trim()}`);
  const lines = result.stdout.split("\n");
  pending.forEach(({ text }, index) => kotlinRanges.set(text, JSON.parse(lines[index])));
};

const scanKotlin = (text, file) => {
  prepareKotlin([{ text, file }]);
  return kotlinRanges.get(text);
};

const SCANNERS = { script: scanScript, swift: scanSwift, kotlin: scanKotlin, css: scanCss, shell: scanShell, python: scanPython };

export const tokenizeComments = (text, file, language) => {
  const scan = SCANNERS[language];
  if (!scan) throw new Error(`No comment tokenizer for ${file}`);
  return scan(text, file);
};
