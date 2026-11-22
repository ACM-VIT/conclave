import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import conclave from "./eslint-plugin.mjs";
import { extractComments } from "./extract.mjs";

const linter = new Linter({ configType: "flat" });
const config = [
  {
    files: ["**/*.{ts,tsx,mjs}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { conclave },
    rules: { "conclave/no-comments": "error" },
  },
];

const lint = (code, filename) =>
  linter
    .verify(code, config, { filename })
    .filter((message) => message.ruleId === "conclave/no-comments")
    .map((message) => ({ line: message.line, messageId: message.messageId }));

const fixture = [
  "#!/usr/bin/env node",
  "// Copyright 2025 Example Inc. SPDX-License-Identifier: MIT",
  "",
  "/// <reference types=\"node\" />",
  "// @vitest-environment happy-dom",
  "import x from \"./x\";",
  "const url = \"https://example.com/*\"; // trailing",
  "/* eslint-disable no-console -- prints the report */",
  "// eslint-disable-next-line no-console",
  "console.log(x); /* inline */",
  "// @ts-expect-error",
  "const y: string = 1;",
  "// @ts-expect-error the vendor type omits numbers",
  "const z: string = 2;",
  "// prettier-ignore",
  "const view = <div>// text {/* jsx */}</div>;",
  "// eslint-disable-next-line -- blanket",
  "//# sourceMappingURL=a.js.map",
].join("\n");

test("reports every comment outside the allowlist", () => {
  assert.deepEqual(lint(fixture, "fixture.tsx"), [
    { line: 7, messageId: "comment" },
    { line: 9, messageId: "directiveReason" },
    { line: 10, messageId: "comment" },
    { line: 11, messageId: "directiveReason" },
    { line: 16, messageId: "comment" },
    { line: 17, messageId: "selfDisable" },
  ]);
});

test("the rule and the extractor flag the same comments", () => {
  const extracted = extractComments(fixture, "fixture.tsx")
    .filter((comment) => !comment.allowed)
    .map((comment) => comment.line);
  assert.deepEqual(
    lint(fixture, "fixture.tsx").map((problem) => problem.line),
    extracted,
  );
});

test("a file with only allowed comments passes", () => {
  assert.deepEqual(lint("#!/usr/bin/env node\n/// <reference types=\"node\" />\nexport {};\n", "cli.mjs"), []);
});

test("the next-line form cannot switch the rule off", () => {
  assert.deepEqual(
    lint("// eslint-disable-next-line conclave/no-comments -- sneaky\nconst a = 1; // hidden\n", "a.ts"),
    [{ line: 1, messageId: "selfDisable" }],
  );
});
