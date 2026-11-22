import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CALL_LOG_LABELS } from "../src/app/lib/call-log-labels";

const srcDir = path.resolve(import.meta.dirname, "../src");

// Every `.error(...)` call whose first argument names a `[Meets]` label: the
// literal ones as call-error-capture reads them, and any built at runtime.
const labelsInSource = () => {
  const literal = new Set<string>();
  const built: string[] = [];
  const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((file) =>
    /\.tsx?$/.test(file),
  );
  for (const file of files) {
    const text = readFileSync(path.join(srcDir, file), "utf8");
    if (!text.includes("[Meets]")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "error"
      ) {
        const [first] = node.arguments;
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          if (first.text.startsWith("[Meets]")) literal.add(first.text.trim().replace(/:$/, ""));
        } else if (first?.getText(source).includes("[Meets]")) {
          built.push(`${file}: ${first.getText(source)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { literal, built };
};

describe("call-log labels", () => {
  it("registers exactly the labels the call code logs", () => {
    const { literal } = labelsInSource();

    expect([...literal].sort()).toEqual([...CALL_LOG_LABELS].sort());
  });

  it("finds no label built at runtime, which could never be registered", () => {
    expect(labelsInSource().built).toEqual([]);
  });
});
