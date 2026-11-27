import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "../src/app");
const HELPER = "lib/telemetry-fetch.ts";
const SERVER_RELAY = "lib/telemetry-ingest.ts";

const browserTelemetryModules = (): string[] => {
  const inDir = (dir: string, keep: (name: string) => boolean) =>
    readdirSync(path.join(SRC, dir))
      .filter((name) => /\.tsx?$/.test(name) && keep(name))
      .map((name) => `${dir}/${name}`);
  return [
    ...inDir("lib", (name) => name.startsWith("telemetry") || name.startsWith("call-")),
    ...inDir("components", (name) => name.includes("Telemetry") || name.includes("CallQuality")),
    ...inDir("hooks", (name) => name.includes("Telemetry") || name.includes("CallQuality")),
  ].filter((file) => file !== HELPER && file !== SERVER_RELAY);
};

const directNetworkCalls = (file: string): string[] => {
  const text = readFileSync(path.join(SRC, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (node: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
      found.push(`${at(node)} calls fetch`);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const owner = node.expression;
      if (node.name.text === "fetch" && ts.isIdentifier(owner) && ["window", "globalThis", "self"].includes(owner.text)) {
        found.push(`${at(node)} uses ${owner.text}.fetch`);
      }
      if (node.name.text === "sendBeacon") found.push(`${at(node)} uses sendBeacon`);
    }
    if (ts.isStringLiteralLike(node) && node.text === "sendBeacon") found.push(`${at(node)} names sendBeacon`);
    if (ts.isIdentifier(node) && node.text === "XMLHttpRequest") found.push(`${at(node)} uses XMLHttpRequest`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe("telemetry's network calls", () => {
  it("all go through lib/telemetry-fetch.ts: no browser telemetry module calls fetch or sendBeacon itself", () => {
    const modules = browserTelemetryModules();
    expect(modules).toEqual(expect.arrayContaining(["lib/telemetry.ts", "lib/telemetry-outbox.ts", "lib/call-quality-metrics.ts"]));
    expect(modules.flatMap(directNetworkCalls)).toEqual([]);
  });

  it("finds the one direct call, in the helper itself", () => {
    expect(directNetworkCalls(HELPER)).toEqual([expect.stringMatching(/^lib\/telemetry-fetch\.ts:\d+ calls fetch$/)]);
  });
});
