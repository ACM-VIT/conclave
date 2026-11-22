import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { extractComments, pythonScannerFallback } from "./extract.mjs";

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

test("Skip transpiler directives are allowed in Swift and nowhere else", () => {
  const source = [
    "// SKIP SYMBOLFILE",
    "// SKIP INSERT: @Suppress(\"UNCHECKED_CAST\")",
    "// SKIP DECLARE: class Bridge: Base",
    "// SKIP REPLACE: fun f() = Unit",
    "// SKIP NOWARN",
    "// SKIP @nobridge",
    "// SKIP this is prose, not a directive",
    "// skip the rest",
    "let a = 1",
  ].join("\n");
  assert.deepEqual(
    extractComments(source, "Bridge+Android.swift").map((comment) => comment.allowed),
    ["skip-directive", "skip-directive", "skip-directive", "skip-directive", "skip-directive", "skip-directive", null, null],
  );
  assert.deepEqual(
    extractComments("// SKIP SYMBOLFILE\nval a = 1\n", "a.kt").map((comment) => comment.allowed),
    [null],
  );
  assert.deepEqual(
    extractComments("// SKIP SYMBOLFILE\nconst a = 1;\n", "a.ts").map((comment) => comment.allowed),
    [null],
  );
});

test("generated provenance hashes are allowed, prose beside a hash is not", () => {
  const hash = "a8f815b7cd4ceb7bf9c5d04f6fed8528a3cf77981e3994e91cace24d6e25b541";
  const source = [
    `// Profile material-rounded-24-absolute-v1; manifest SHA256 ${hash}; generator SHA256 ${hash}.`,
    "val a = 1",
    `    // mic.fill1; input SHA256 ${hash}.`,
    `// We pinned this because the upstream glyph moved; input SHA256 ${hash}.`,
    `// input SHA256 ${hash.slice(1)}.`,
  ].join("\n");
  assert.deepEqual(
    extractComments(source, "Icons.kt").map((comment) => comment.allowed),
    ["provenance-hash", "provenance-hash", null, null],
  );
  assert.deepEqual(
    extractComments(`// mic.fill1; input SHA256 ${hash}.\nconst a = 1;\n`, "a.ts").map((comment) => comment.allowed),
    [null],
  );
});

test("an attribution header may follow a directive prologue", () => {
  const source = [
    '"use client";',
    "",
    '// Ported (and trimmed) from AI SDK Elements (elements.ai-sdk.dev) "PromptInput".',
    "",
    "import { a } from \"a\";",
    "// Ported from somewhere, but not at the top.",
  ].join("\n");
  assert.deepEqual(
    extractComments(source, "prompt-input.tsx").map((comment) => comment.allowed),
    ["license-header", null],
  );
  const apache = ["// Material Symbols by Google.", "// Apache-2.0, complete text: LICENSE", "package a"].join("\n");
  assert.deepEqual(
    extractComments(apache, "Icons.kt").map((comment) => comment.allowed),
    ["license-header", "license-header"],
  );
  assert.deepEqual(
    extractComments('const a = "use client";\n// Copyright 2024 Example\n', "a.ts").map((comment) => comment.allowed),
    [null],
  );
});

test("Swift regex literals hide comment markers", () => {
  const source = [
    "let url = #/https?://example\\.com/#",
    "let wide = ##/a/#b/##",
    "let multi = #/",
    "  // inside an extended literal",
    "  /#",
    "let bare = /a\\/*b/",
    "let slashes = try Regex(/[/]+x/)",
    "let half = total / 2 // real one",
    "let ratio = a / b / c",
    "// real two",
  ].join("\n");
  assert.deepEqual(texts(source, "Patterns.swift"), ["// real one", "// real two"]);
});

test("a directive is never part of a license header", () => {
  const source = [
    "// SPDX-License-Identifier: MIT",
    "/* eslint-disable conclave/no-comments -- copyright notice below */",
    "// Copyright 2024 Example Inc.",
    "/* eslint conclave/no-comments: \"off\" */",
    "export {};",
  ].join("\n");
  assert.deepEqual(
    extractComments(source, "a.ts").map((comment) => comment.allowed),
    ["license-header", null, "license-header", null],
  );
  const onlyDirectives = ["/* eslint-disable no-console -- SPDX-License-Identifier: MIT */", "// hidden", "export {};"].join("\n");
  assert.deepEqual(
    extractComments(onlyDirectives, "b.ts").map((comment) => comment.allowed),
    ["eslint-directive", null],
  );
});

test("shell here-strings, arithmetic shifts and escaped heredoc delimiters", () => {
  const source = [
    "#!/bin/bash",
    "cat <<< hello",
    "# after here-string",
    "x=$((1 << 4))",
    "(( y = x << 2 ))",
    "# after arithmetic",
    "python3 - <<\\PY",
    "# inside the escaped heredoc",
    "PY",
    "cat <<'EOF'",
    "# inside the quoted heredoc",
    "EOF",
    "echo done # trailing",
  ].join("\n");
  assert.deepEqual(texts(source, "run.sh").slice(1), ["# after here-string", "# after arithmetic", "# trailing"]);
});

test("Kotlin multi-dollar strings interpolate only with the full dollar run", () => {
  const source = [
    'val a = $$"""value ${ /* literal */ } and $${ x /* real one */ }"""',
    'val b = "plain ${ y /* real two */ }"',
    'val c = $$"price ${1}"',
  ].join("\n");
  assert.deepEqual(texts(source, "a.kt"), ["/* real one */", "/* real two */"]);
});

test("CSS unquoted url() is not a comment", () => {
  const source = ["a { background: url(img/*2x*/a.png); }", "/* real */", 'b { background: URL( "x/*y" ); }'].join("\n");
  assert.deepEqual(texts(source, "a.css"), ["/* real */"]);
});

test("Python f-string replacement fields can hold comments, format specs cannot", () => {
  const source = [
    'value = f"""{',
    "    total  # inside a replacement field",
    '}"""',
    'hexed = f"{x:#x} {{#not}}"',
    "raw = rf\"{y}\\\"#not\"",
    "# real",
  ].join("\n");
  assert.deepEqual(texts(source, "a.py"), ["# inside a replacement field", "# real"]);
});

test("Swift raw strings take any number of hashes", () => {
  const hashes = "#".repeat(12);
  const source = [`let s = ${hashes}"// not a comment "${"#".repeat(11)} still raw"${hashes}`, "// real"].join("\n");
  assert.deepEqual(texts(source, "Raw.swift"), ["// real"]);
});

test("Skip directives follow the pinned skipstone grammar in line and block form", () => {
  const source = [
    "// SKIP INSERT: val x = 1",
    "// val y = 2",
    "// SKIP TODO remove this workaround",
    "// continuation of nothing",
    "/* SKIP INSERT: println(\"hello\") */",
    "/* SKIP REPLACE:",
    "fun f() = Unit",
    "*/",
    "// SKIP NOWARN(conversion)",
    "// SKIP NOWARNING",
    "// SKIP EXTERN",
    "let a = 1 // SKIP NOWARN",
  ].join("\n");
  assert.deepEqual(
    extractComments(source, "Bridge.swift").map((comment) => comment.allowed),
    ["skip-directive", "skip-directive", null, null, "skip-directive", "skip-directive", "skip-directive", null, "skip-directive", null],
  );
});

test("provenance hashes are allowed only under the icon generator's exact header", () => {
  const hash = "a8f815b7cd4ceb7bf9c5d04f6fed8528a3cf77981e3994e91cace24d6e25b541";
  const header = `// Profile material-rounded-24-absolute-v1; manifest SHA256 ${hash}; generator SHA256 ${hash}.`;
  const vector = `    // mic.fill1; input SHA256 ${hash}.`;
  assert.deepEqual(
    extractComments(`${header}\npackage a\n${vector}\n// a sentence ending in SHA256 ${hash}.\n`, "Icons.kt").map((c) => c.allowed),
    ["provenance-hash", "provenance-hash", null],
  );
  assert.deepEqual(
    extractComments(`package a\n${vector}\n// We pinned it; input SHA256 ${hash}.\n`, "Other.kt").map((c) => c.allowed),
    [null, null],
  );
});

test("a license header needs a real marker and covers only the top block", () => {
  const todo = ["// TODO revisit the copyright dialog", "// and the licensed under review copy", "export {};"].join("\n");
  assert.deepEqual(extractComments(todo, "a.ts").map((c) => c.allowed), [null, null]);
  const split = ["// Copyright (c) 2024 Example Inc.", "", "// Narrative about the module.", "export {};"].join("\n");
  assert.deepEqual(extractComments(split, "b.ts").map((c) => c.allowed), ["license-header", null]);
  for (const marker of ["// SPDX-License-Identifier: MIT", "// © 2024 Example", "// Licensed under the Apache License, Version 2.0"]) {
    assert.deepEqual(extractComments(`${marker}\nexport {};\n`, "c.ts").map((c) => c.allowed), ["license-header"], marker);
  }
});

test("escapes in CSS, shell and Kotlin never open a comment", () => {
  assert.deepEqual(texts("a { background: url(a\\)b/*literal*/x); }\n/* real */\n", "a.css"), ["/* real */"]);
  assert.deepEqual(texts('.a\\"b { color: red; }\n/* real */\n.c { content: "x"; }\n', "b.css"), ["/* real */"]);
  assert.deepEqual(texts("echo word\\ #suffix\necho one\\ #literal # real\n", "a.sh"), ["# real"]);
  assert.deepEqual(texts('val `a"b` = 1 // real\nval c = "x"\n', "a.kt"), ["// real"]);
  assert.deepEqual(texts('val d = $$"""$$${ 1 /* real */ }"""\n', "b.kt"), ["/* real */"]);
  assert.deepEqual(texts('let r = /=a"b/ // real\n', "R.swift"), ["// real"]);
});

test("Python comments come from tokenize, so format specs stay code", () => {
  assert.equal(pythonScannerFallback(), undefined);
  assert.deepEqual(texts('print(f"{1:=#6x}")  # real\nvalue = f"""{\n    total  # inside\n}"""\n', "a.py"), ["# real", "# inside"]);
});

test("shell fixtures that bash runs agree with the extractor", (t) => {
  const bash = spawnSync("bash", ["--version"]);
  if (bash.error) {
    t.skip("bash is not installed");
    return;
  }
  const source = [
    'echo "$((1 << 2))"',
    "# after quoted arithmetic",
    'cat <<E"O"F',
    "# heredoc body, not a comment",
    "EOF",
    "echo word\\ #suffix",
    "echo one\\ #literal # real",
    "cat <<< here",
    "x=$((1 << 4)); echo \"$x\"",
    "# last",
  ].join("\n");
  const run = spawnSync("bash", ["-c", source], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.split("\n").filter(Boolean), [
    "4",
    "# heredoc body, not a comment",
    "word #suffix",
    "one #literal",
    "here",
    "16",
  ]);
  assert.deepEqual(texts(source, "fixture.sh"), ["# after quoted arithmetic", "# real", "# last"]);
});
