import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { HOST_ONLY_EVENTS } from "../server/admin/hostOnlyEvents.js";

const SFU_ROOT = join(import.meta.dirname, "..");
const SOURCE_DIRS = ["server", "config", "utilities"];
const hostOnly = new Set<string>(HOST_ONLY_EVENTS);
const FANOUT_METHODS = new Set(["to", "in", "except"]);

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });

const fansOut = (node: ts.Node): boolean => {
  if (ts.isPropertyAccessExpression(node) && node.name.text === "broadcast") return true;
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    FANOUT_METHODS.has(node.expression.name.text)
  ) {
    return true;
  }
  return ts.forEachChild(node, (child) => fansOut(child) || undefined) ?? false;
};

const roomWideHostOnlyEmits = (fileName: string, text: string): string[] => {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "emit"
    ) {
      const [event] = node.arguments;
      if (
        event &&
        ts.isStringLiteralLike(event) &&
        hostOnly.has(event.text) &&
        fansOut(node.expression.expression)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${fileName}:${line + 1} ${event.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe("host-only events", () => {
  it("are never fanned out to a room channel or broadcast", () => {
    const offenders = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(SFU_ROOT, dir)))
      .flatMap((path) => roomWideHostOnlyEmits(relative(SFU_ROOT, path), readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });

  it.each([
    ["io.to(room.channelId).emit(\"pendingUsersSnapshot\", {});", 1],
    ["io\n  .in(channelId)\n  .emit(\"userRequestedJoin\", {});", 1],
    ["socket.to(room.channelId).emit(\"pendingUserLeft\", {});", 1],
    ["socket.broadcast.emit(\"userAdmitted\", {});", 1],
    ["(peers ? io.to(roomChannelId) : socket).emit(\"admin:roomStateChanged\", {});", 1],
    ["io.except(socket.id).emit(\"webinar:handQueueChanged\", {});", 1],
    ["admin.socket.emit(\"pendingUsersSnapshot\", {});", 0],
    ["promoted.socket.emit(\"pendingUsersSnapshot\", {});", 0],
    ["io.to(room.channelId).emit(\"roomLockChanged\", {});", 0],
  ])("flags only room-wide host-only emits: %s", (snippet, count) => {
    expect(roomWideHostOnlyEmits("fixture.ts", snippet)).toHaveLength(count);
  });
});
