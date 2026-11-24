import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { HOST_ONLY_EVENTS } from "../server/admin/hostOnlyEvents.js";

const SFU_ROOT = join(import.meta.dirname, "..");
const HELPERS_FILE = join(SFU_ROOT, "server", "admin", "hostOnlyEvents.ts");
const HELPER_NAMES = new Set(["emitToHost", "emitToHosts"]);
const hostOnly = new Set<string>(HOST_ONLY_EVENTS);

const FIXTURE_PRELUDE = [
  "import type { Server, Socket } from \"socket.io\";",
  "import type { Admin } from \"../config/classes/Admin.js\";",
  "import type { Room } from \"../config/classes/Room.js\";",
  "import { emitToHost, emitToHosts, HOST_ONLY_EVENTS, type HostOnlyEvent } from \"./admin/hostOnlyEvents.js\";",
  "declare const io: Server;",
  "declare const socket: Socket;",
  "declare const room: Room;",
  "declare const admin: Admin;",
  "declare const flag: boolean;",
  "declare const ch: string;",
  "declare const anyName: string;",
  "export {};",
].join("\n");

const LEAKS: Array<[string, string]> = [
  ["room channel", "io.to(room.channelId).emit(\"pendingUsersSnapshot\", {});"],
  ["multi-line in()", "io\n  .in(ch)\n  .emit(\"userRequestedJoin\", {});"],
  ["socket.to()", "socket.to(ch).emit(\"pendingUserLeft\", {});"],
  ["socket.broadcast", "socket.broadcast.emit(\"userAdmitted\", {});"],
  ["ternary receiver", "(flag ? io.to(ch) : socket).emit(\"admin:roomStateChanged\", {});"],
  ["bound room target", "const peers = io.to(ch);\npeers.emit(\"webinar:handQueueChanged\", {});"],
  ["room target default", "const handOff = (peers = io.to(ch)) => peers.emit(\"webinar:stageInviteUsed\", {});\nhandOff();"],
  ["io.emit", "io.emit(\"pendingUsersSnapshot\", {});"],
  ["io.local.emit", "io.local.emit(\"pendingUserLeft\", {});"],
  ["io.of().emit", "io.of(\"/\").emit(\"userRejected\", {});"],
  ["io.except()", "io.except(socket.id).emit(\"userAdmitted\", {});"],
  ["ternary event variable", "const event = flag ? \"userAdmitted\" : \"userRejected\";\nfor (const host of room.getAdmins()) host.socket.emit(event, {});"],
  ["typed event variable", "declare const event: HostOnlyEvent;\nsocket.emit(event, {});"],
  ["wrapper helper", "const send = (target: Socket, name: string, payload: unknown) => target.emit(name, payload);\nsend(socket, \"pendingUsersSnapshot\", {});"],
  ["loop over room clients", "for (const client of room.clients.values()) client.socket.emit(\"pendingUsersSnapshot\", {});"],
  ["unresolved name to room", "io.to(ch).emit(anyName, {});"],
  ["unresolved name to everyone", "io.emit(anyName, {});"],
  ["host-only list to room", "io.to(ch).emit(HOST_ONLY_EVENTS[0], {});"],
  ["look-alike helper", "const emitToHosts2 = (target: Server, name: string) => target.emit(name, {});\nemitToHosts2(io, \"pendingUsersSnapshot\");"],
  ["structural room target with an unresolved name", "const relay = (peers: { emit: (event: string, payload: unknown) => unknown }, name: string) => peers.emit(name, {});\nrelay(io.to(ch), anyName);"],
  ["shadowed helper name", "{\n  const emitToHosts = (_room: Room, name: string, payload: unknown) => io.to(ch).emit(name, payload);\n  emitToHosts(room, \"pendingUsersSnapshot\", {});\n}"],
];

const ALLOWED: Array<[string, string]> = [
  ["emitToHosts", "emitToHosts(room, \"pendingUsersSnapshot\", {});"],
  ["emitToHost with a ternary name", "emitToHost(admin, flag ? \"userAdmitted\" : \"pendingUserLeft\", {});"],
  ["public room event", "io.to(room.channelId).emit(\"roomLockChanged\", {});"],
  ["public ternary to room", "const event = flag ? \"chatLockChanged\" : \"roomLockChanged\";\nio.to(ch).emit(event, {});"],
  ["public bound room target", "const peers = io.to(ch);\npeers.emit(\"hostChanged\", {});"],
  ["callback that only shares the emit name", "declare const proof: { roomId: string; emit: (ownerId: string, payload: unknown) => void };\nproof.emit(anyName, {});"],
  ["per-socket public name", "socket.emit(anyName, {});"],
];

type Fixture = { name: string; fileName: string; text: string };

const fixtures = (kind: string, cases: Array<[string, string]>): Fixture[] =>
  cases.map(([name, body], index) => ({
    name,
    fileName: join(SFU_ROOT, "server", `__host_only_guard_${kind}_${index}.ts`),
    text: `${FIXTURE_PRELUDE}\n${body}\n`,
  }));

const LEAK_FIXTURES = fixtures("leak", LEAKS);
const ALLOWED_FIXTURES = fixtures("allowed", ALLOWED);

const buildProgram = (): ts.Program => {
  const config = ts.readConfigFile(join(SFU_ROOT, "tsconfig.json"), (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, SFU_ROOT);
  const virtual = new Map([...LEAK_FIXTURES, ...ALLOWED_FIXTURES].map((fixture) => [fixture.fileName, fixture.text]));
  const host = ts.createCompilerHost(parsed.options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const text = virtual.get(fileName);
    return text === undefined
      ? getSourceFile(fileName, languageVersion, ...rest)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  host.fileExists = (fileName) => virtual.has(fileName) || fileExists(fileName);
  host.readFile = (fileName) => virtual.get(fileName) ?? readFile(fileName);
  return ts.createProgram([...parsed.fileNames, ...virtual.keys()], parsed.options, host);
};

const SOCKET_IO_DIR = `${sep}node_modules${sep}socket.io${sep}`;

const declaredInSocketIo = (symbol: ts.Symbol | undefined): boolean =>
  Boolean(symbol?.declarations?.some((declaration) =>
    declaration.getSourceFile().fileName.split("/").join(sep).includes(SOCKET_IO_DIR),
  ));

const isRoomWide = (
  checker: ts.TypeChecker,
  roomTarget: ts.Type,
  receiver: ts.Expression,
): boolean => {
  const type = checker.getTypeAtLocation(receiver);
  const members = type.isUnion() ? type.types : [type];
  return members.some((member) => {
    const symbol = member.getSymbol() ?? member.aliasSymbol;
    if (declaredInSocketIo(symbol)) return symbol!.getName() !== "Socket";
    return checker.isTypeAssignableTo(roomTarget, member);
  });
};

const eventNames = (checker: ts.TypeChecker, event: ts.Expression): string[] | null => {
  const type = checker.getTypeAtLocation(event);
  const members = type.isUnion() ? type.types : [type];
  const names: string[] = [];
  for (const member of members) {
    if (!member.isStringLiteral()) return null;
    names.push(member.value);
  }
  return names;
};

const isHelperCall = (checker: ts.TypeChecker, call: ts.CallExpression): boolean => {
  if (!ts.isIdentifier(call.expression) || !HELPER_NAMES.has(call.expression.text)) return false;
  let symbol = checker.getSymbolAtLocation(call.expression);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return Boolean(symbol?.declarations?.some((declaration) =>
    declaration.getSourceFile().fileName === HELPERS_FILE,
  ));
};

const isHelperEventArgument = (checker: ts.TypeChecker, literal: ts.Node): boolean => {
  let node = literal;
  while (
    ts.isParenthesizedExpression(node.parent) ||
    ts.isAsExpression(node.parent) ||
    ts.isSatisfiesExpression(node.parent) ||
    (ts.isConditionalExpression(node.parent) && node.parent.condition !== node)
  ) {
    node = node.parent;
  }
  return (
    ts.isCallExpression(node.parent) &&
    node.parent.arguments[1] === node &&
    isHelperCall(checker, node.parent)
  );
};

const offendersIn = (
  checker: ts.TypeChecker,
  roomTarget: ts.Type,
  source: ts.SourceFile,
): string[] => {
  const name = relative(SFU_ROOT, source.fileName);
  const at = (node: ts.Node, rule: string) =>
    `${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${rule}`;
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && hostOnly.has(node.text) && !isHelperEventArgument(checker, node)) {
      found.push(at(node, `host-only name "${node.text}" outside emitToHost/emitToHosts`));
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "emit" &&
      node.arguments[0]
    ) {
      const event = node.arguments[0];
      const names = eventNames(checker, event);
      if (!ts.isStringLiteralLike(event) && names?.some((value) => hostOnly.has(value))) {
        found.push(at(node, "emit with a host-only event type"));
      }
      if (isRoomWide(checker, roomTarget, node.expression.expression) && names === null) {
        found.push(at(node, "room-wide emit with an event name that does not resolve to public names"));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const program = buildProgram();
const checker = program.getTypeChecker();

const roomTargetType = (): ts.Type => {
  const source = program.getSourceFile(LEAK_FIXTURES[0].fileName)!;
  let target: ts.Type | undefined;
  const visit = (node: ts.Node) => {
    if (!target && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "to") {
      target = checker.getTypeAtLocation(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return target!;
};
const roomTarget = roomTargetType();
const offendersFor = (fileName: string) => offendersIn(checker, roomTarget, program.getSourceFile(fileName)!);

const isScanned = (fileName: string): boolean => {
  const path = relative(SFU_ROOT, fileName);
  if (path.startsWith("..") || path.includes("node_modules") || fileName === HELPERS_FILE) return false;
  if (path.includes("__host_only_guard_")) return false;
  const [top] = path.split(sep);
  return path === top ? top.endsWith(".ts") : ["server", "config", "utilities"].includes(top);
};

describe("host-only events", () => {
  it("are sent only through emitToHost and emitToHosts", () => {
    const offenders = program.getSourceFiles()
      .filter((source) => isScanned(source.fileName))
      .flatMap((source) => offendersIn(checker, roomTarget, source));
    expect(offenders).toEqual([]);
  });

  it("type-check every guard fixture", () => {
    const fixtureErrors = [...LEAK_FIXTURES, ...ALLOWED_FIXTURES]
      .flatMap((fixture) => ts.getPreEmitDiagnostics(program, program.getSourceFile(fixture.fileName)))
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(fixtureErrors).toEqual([]);
  });

  it.each(LEAK_FIXTURES.map((fixture) => [fixture.name, fixture.fileName]))(
    "flags a leak: %s",
    (_name, fileName) => {
      expect(offendersFor(fileName)).not.toEqual([]);
    },
  );

  it.each(ALLOWED_FIXTURES.map((fixture) => [fixture.name, fixture.fileName]))(
    "allows: %s",
    (_name, fileName) => {
      expect(offendersFor(fileName)).toEqual([]);
    },
  );
});
