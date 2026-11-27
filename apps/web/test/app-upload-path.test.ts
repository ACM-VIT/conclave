import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ROOTS = ["packages/apps-sdk/src", "packages/meeting-core/src", "apps/web/src"].map((root) => join(REPO, root));

const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : sourcesUnder(path);
    return /\.(ts|tsx|mts|mjs|js)$/.test(entry) && !/\.test\.[a-z]+$/.test(entry) ? [path] : [];
  });

const calleeName = (call: ts.CallExpression): string | null => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
};

const namesAnUpload = (call: ts.CallExpression): boolean => {
  const [event] = call.arguments;
  if (!event) return false;
  const name = calleeName(call);
  if (name === "emit") {
    if (ts.isStringLiteralLike(event)) return event.text === "apps:yjs:update";
    return ts.isPropertyAccessExpression(event) && event.name.text === "appsYjsUpdate";
  }
  return name === "send" && ts.isStringLiteralLike(event) && event.text === "update";
};

const insideTheQueue = (node: ts.Node): boolean => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current) && calleeName(current) === "createUploadQueue") return true;
  }
  return false;
};

export const findDirectUploads = (fileName: string, text: string): string[] => {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && namesAnUpload(node) && !insideTheQueue(node)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${relative(REPO, fileName)}:${line + 1}`);
    }
    node.forEachChild(visit);
  };
  visit(file);
  return found;
};

describe("app document uploads", () => {
  it("leave only through the upload queue", () => {
    const files = ROOTS.flatMap(sourcesUnder);
    expect(files.length).toBeGreaterThan(100);

    expect(files.flatMap((path) => findDirectUploads(path, readFileSync(path, "utf8")))).toEqual([]);
  });

  it("are caught when sent around the queue by name or by event constant, and allowed inside it", () => {
    const at = join(REPO, "fixture.ts");
    expect(findDirectUploads(at, `socket.emit("apps:yjs:update", { appId, update });`)).toEqual(["fixture.ts:1"]);
    expect(findDirectUploads(at, `socket.emit(SFU_CLIENT_EVENTS.appsYjsUpdate, payload);`)).toEqual(["fixture.ts:1"]);
    expect(findDirectUploads(at, `this.send("update", { update: encoded });`)).toEqual(["fixture.ts:1"]);
    expect(findDirectUploads(at, `const queue = createUploadQueue((appId, replicaId, update) => { socket.emit("apps:yjs:update", { appId, update, replicaId }); return true; });`)).toEqual([]);
    expect(findDirectUploads(at, `socket.on("apps:yjs:update", handle); socket.emit("apps:awareness", payload);`)).toEqual([]);
  });
});
