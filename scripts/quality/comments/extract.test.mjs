import assert from "node:assert/strict";
import test from "node:test";
import { extractComments } from "./extract.mjs";

const texts = (source, file) => extractComments(source, file).map((comment) => comment.text);
const disallowed = (source, file) =>
  extractComments(source, file)
    .filter((comment) => !comment.allowed)
    .map((comment) => comment.text);

test("strings, templates and regexes that look like comments are code", () => {
  const source = [
    'const url = "https://example.com/a";',
    "const glob = 'public/*.css';",
    "const href = `https://${host}/path // not a comment`;",
    "const nested = `${items.map((item) => `//${item}`).join(\"/*\")}`;",
    "const slashes = /\\/\\/+/g;",
    "const star = /a\\/*b/;",
    "const real = 1; // trailing",
  ].join("\n");
  assert.deepEqual(texts(source, "a.ts"), ["// trailing"]);
});

test("JSX text is not a comment but a JSX comment expression is", () => {
  const source = [
    "export const View = () => (",
    "  <div title=\"//x\">",
    "    // shown as text",
    "    {/* hidden note */}",
    "    https://example.com",
    "  </div>",
    ");",
  ].join("\n");
  assert.deepEqual(texts(source, "view.tsx"), ["/* hidden note */"]);
});

test("positions report lines, ownership and the lines a deletion sheds", () => {
  const source = ["const a = 1;", "/**", " * block", " */", "const b = 2; // tail", "  // own"].join("\n");
  const comments = extractComments(source, "a.ts").map(({ line, endLine, ownLines, linesShed }) => ({
    line,
    endLine,
    ownLines,
    linesShed,
  }));
  assert.deepEqual(comments, [
    { line: 2, endLine: 4, ownLines: true, linesShed: 3 },
    { line: 5, endLine: 5, ownLines: false, linesShed: 0 },
    { line: 6, endLine: 6, ownLines: true, linesShed: 1 },
  ]);
});

test("shebangs are reported as allowed directives in every language", () => {
  for (const [file, source] of [
    ["run.mjs", "#!/usr/bin/env node\n// note\nrun();\n"],
    ["run.sh", "#!/bin/sh\n# note\nrun\n"],
    ["run.py", "#!/usr/bin/env python3\n# note\nrun()\n"],
  ]) {
    const [shebang, note] = extractComments(source, file);
    assert.equal(shebang.allowed, "shebang", file);
    assert.equal(shebang.line, 1, file);
    assert.equal(note.allowed, null, file);
  }
});

test("only the allowlisted script directives are allowed", () => {
  const source = [
    "/// <reference types=\"vite/client\" />",
    "// @vitest-environment happy-dom",
    "/* eslint-disable no-console -- the CLI prints its report */",
    "/* eslint-disable no-console */",
    "// @ts-expect-error the vendor type omits this overload",
    "// @ts-expect-error",
    "// @ts-ignore broken",
    "// prettier-ignore",
    "//# sourceMappingURL=app.js.map",
    "/* eslint-disable -- everything */",
    "// eslint-disable-next-line conclave/no-comments -- sneaky",
    "const a = 1;",
  ].join("\n");
  assert.deepEqual(
    extractComments(source, "a.test.ts").map((comment) => comment.allowed),
    [
      "triple-slash-reference",
      "vitest-environment",
      "eslint-directive",
      null,
      "ts-expect-error",
      null,
      null,
      "prettier-ignore",
      "source-map-url",
      null,
      null,
    ],
  );
});

test("a license header is allowed only at the very top of the file", () => {
  const header = ["// Copyright 2024 Example Inc.", "// Licensed under the MIT License.", "// See LICENSE."].join("\n");
  const source = `${header}\n\n// Narrative about the module.\nconst a = 1;\n// Copyright notice in the middle.\n`;
  assert.deepEqual(
    extractComments(source, "a.ts").map((comment) => [comment.line, comment.allowed]),
    [
      [1, "license-header"],
      [2, "license-header"],
      [3, "license-header"],
      [5, null],
      [7, null],
    ],
  );
});

test("Swift raw, multiline and interpolated strings hide comment markers", () => {
  const source = [
    "// swift-tools-version: 5.9",
    'let raw = #"// not a comment "quoted" "#',
    'let raw2 = ##"a "# /* still raw */ b"##',
    'let multi = """',
    "  // inside a multiline string",
    '  "quotes" and /* markers */',
    '  """',
    'let nested = "\\(path("//x")) /* text */"',
    'let rawInterp = #"\\#(f("//y")) // raw text"#',
    "let x = 1 // real line",
    "/* outer /* inner */ still outer */ let y = 2",
  ].join("\n");
  assert.deepEqual(texts(source, "Package.swift"), [
    "// swift-tools-version: 5.9",
    "// real line",
    "/* outer /* inner */ still outer */",
  ]);
  assert.deepEqual(disallowed(source, "Package.swift").length, 2);
});

test("Kotlin raw strings, templates and char literals hide comment markers", () => {
  const source = [
    'val raw = """// not a comment /* nor this */"""',
    'val quoteRun = """ends with quotes"""" // real one',
    'val template = "${map["//key"]} /* text */"',
    "val quote = '\"' // real two",
    "val apostrophe = '\\'' // real three",
    "/* a /* nested */ b */ val after = 1",
  ].join("\n");
  assert.deepEqual(texts(source, "Build.kt"), [
    "// real one",
    "// real two",
    "// real three",
    "/* a /* nested */ b */",
  ]);
});

test("shell # is a comment only at the start of a word outside quotes", () => {
  const source = [
    "#!/usr/bin/env bash",
    'echo "# not a comment" \'# nor this\' a#b ${#items[@]} $#',
    'echo "$(printf "%s" "# inside a substitution")"',
    "echo $'it\\'s # quoted'",
    "count=1 # real one",
    "cat <<'EOF'",
    "# heredoc body",
    "EOF",
    "  # real two",
  ].join("\n");
  assert.deepEqual(texts(source, "run.sh"), ["#!/usr/bin/env bash", "# real one", "# real two"]);
});

test("Python strings hide hash marks", () => {
  const source = ['a = "# not"', "b = '''", "# docstring line", "'''", 'c = f"{x}#"  # real'].join("\n");
  assert.deepEqual(texts(source, "tool.py"), ["# real"]);
});

test("CSS strings hide comment markers and sourceMappingURL is allowed", () => {
  const source = ['a::after { content: "/* not */"; }', "/* real */", "/*# sourceMappingURL=app.css.map */"].join("\n");
  assert.deepEqual(
    extractComments(source, "app.css").map((comment) => [comment.text, comment.allowed]),
    [
      ["/* real */", null],
      ["/*# sourceMappingURL=app.css.map */", "source-map-url"],
    ],
  );
});
