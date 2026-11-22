import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractComments, iconGeneratorOutputs, listSourceFiles } from "./extract.mjs";
import { configuresNoComments } from "./policy.mjs";


const swiftMissing = spawnSync("swift", ["--version"]).error ? "swift is not on PATH" : false;
const python312Missing =
  spawnSync("python3", ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)"]).status === 0
    ? false
    : "python3 3.12 or newer is not on PATH";

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

test("shebangs are reported as allowed directives in every language", { skip: python312Missing }, () => {
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
      [2, null],
      [3, null],
      [5, null],
      [7, null],
    ],
  );
});

test("Swift raw, multiline and interpolated strings hide comment markers", { skip: swiftMissing }, () => {
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

test("Python strings hide hash marks", { skip: python312Missing }, () => {
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

test("Skip transpiler directives are allowed in Swift and nowhere else", { skip: swiftMissing }, () => {
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

test("a license notice may follow a directive prologue, an attribution is a comment", () => {
  const source = [
    '"use client";',
    "",
    "// SPDX-License-Identifier: MIT",
    '// Ported (and trimmed) from AI SDK Elements (elements.ai-sdk.dev) "PromptInput".',
    "",
    "import { a } from \"a\";",
  ].join("\n");
  assert.deepEqual(extractComments(source, "prompt-input.tsx").map((comment) => comment.allowed), ["license-header", null]);
  const apache = ["/* Licensed under the Apache License, Version 2.0: Material Symbols by Google. */", "package a"].join("\n");
  assert.deepEqual(extractComments(apache, "Icons.kt").map((comment) => comment.allowed), [null]);
  assert.deepEqual(
    extractComments('const a = "use client";\n// Copyright 2024 Example\n', "a.ts").map((comment) => comment.allowed),
    [null],
  );
});

test("Swift regex literals hide comment markers", { skip: swiftMissing }, () => {
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

test("Python f-string replacement fields can hold comments, format specs cannot", { skip: python312Missing }, () => {
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

test("Swift raw strings take any number of hashes", { skip: swiftMissing }, () => {
  const hashes = "#".repeat(12);
  const source = [`let s = ${hashes}"// not a comment "${"#".repeat(11)} still raw"${hashes}`, "// real"].join("\n");
  assert.deepEqual(texts(source, "Raw.swift"), ["// real"]);
});

test("Skip directives follow the pinned skipstone grammar in line and block form", { skip: swiftMissing }, () => {
  const source = [
    "// SKIP INSERT: val x = 1",
    "// val y = 2",
    "// SKIP TODO remove this workaround",
    "// continuation of nothing",
    "/* SKIP INSERT: println(\"hello\") */",
    "/* SKIP REPLACE:",
    "fun f() = Unit",
    "*/",
    "// SKIP NOWARN(EXTENSION_MERGING)",
    "// SKIP NOWARNING",
    "// SKIP EXTERN",
    "let a = 1 // SKIP NOWARN",
  ].join("\n");
  assert.deepEqual(
    extractComments(source, "Bridge.swift").map((comment) => comment.allowed),
    ["skip-directive", "skip-directive", null, null, "skip-directive", "skip-directive", "skip-directive", null, "skip-directive", null],
  );
});

test("a license header needs a real marker and covers only the top block", () => {
  const todo = ["// TODO revisit the copyright dialog", "// and the licensed under review copy", "export {};"].join("\n");
  assert.deepEqual(extractComments(todo, "a.ts").map((c) => c.allowed), [null, null]);
  const split = ["// Copyright (c) 2024 Example Inc.", "", "// Narrative about the module.", "export {};"].join("\n");
  assert.deepEqual(extractComments(split, "b.ts").map((c) => c.allowed), ["license-header", null]);
  for (const notice of ["// SPDX-License-Identifier: MIT", "// SPDX-License-Identifier: Apache-2.0 OR MIT", "// Copyright 2024-2026 Example Inc.", "// Copyright (c) 2026 ACM-VIT"]) {
    assert.deepEqual(extractComments(`${notice}\nexport {};\n`, "c.ts").map((c) => c.allowed), ["license-header"], notice);
  }
  for (const prose of ["// © 2024 Example", "// Licensed under the Apache License, Version 2.0", "// MIT License", "// SPDX-License-Identifier: MIT, see LICENSE"]) {
    assert.deepEqual(extractComments(`${prose}\nexport {};\n`, "d.ts").map((c) => c.allowed), [null], prose);
  }
});

test("NOWARN takes only skipstone's diagnostic ids, and trailing spaces are trimmed", { skip: swiftMissing }, () => {
  const source = [
    "// SKIP NOWARN   ",
    "// SKIP NOWARN(free text)",
    "// SKIP NOWARN( EXTENSION_MERGING , EXTENSION_MERGING )",
    "// SKIP NOWARN()",
    "let a = 1",
  ].join("\n");
  assert.deepEqual(
    extractComments(source, "Bridge.swift").map((comment) => comment.allowed),
    ["skip-directive", null, "skip-directive", null],
  );
});

test("provenance hashes are allowed only in files the icon generator writes", () => {
  const hash = "a8f815b7cd4ceb7bf9c5d04f6fed8528a3cf77981e3994e91cace24d6e25b541";
  const header = `// Profile material-rounded-24-absolute-v1; manifest SHA256 ${hash}; generator SHA256 ${hash}.`;
  const vector = `    // mic.fill1; input SHA256 ${hash}.`;
  const generated = "apps/conclave-skip/Sources/Conclave/Skip/ui/icons/ConclaveIcons.kt";
  const source = `${header}\npackage a\n${vector}\n// a sentence ending in SHA256 ${hash}.\n`;
  assert.deepEqual(extractComments(source, generated).map((c) => c.allowed), ["provenance-hash", "provenance-hash", null]);
  assert.deepEqual(
    extractComments(source, "apps/conclave-skip/Sources/Conclave/Skip/Other.kt").map((c) => c.allowed),
    [null, null, null],
  );
});

test("the icon generator's output list is read from the generator", () => {
  assert.deepEqual([...iconGeneratorOutputs()].sort(), [
    "apps/conclave-skip/Sources/Conclave/DesignSystem/iOS/Icons/ConclaveSymbols.swift",
    "apps/conclave-skip/Sources/Conclave/DesignSystem/iOS/Icons/NativeSymbolCatalog.swift",
    "apps/conclave-skip/Sources/Conclave/Skip/ui/icons/ConclaveIcons.kt",
    "apps/conclave-skip/Sources/Conclave/Skip/ui/icons/NativeConvertedIconFixtures.kt",
    "apps/conclave-skip/Sources/Conclave/Skip/ui/icons/NativeIconCatalog.kt",
  ]);
});

test("a license block counts only comments that are notices themselves", () => {
  const todo = ["// TODO change the MIT License dialog", "// and the copy next to it", "export {};"].join("\n");
  assert.deepEqual(extractComments(todo, "a.ts").map((c) => c.allowed), [null, null]);
  const spdx = ["// SPDX-License-Identifier: MIT", "/* TODO clean this module up */", "export {};"].join("\n");
  assert.deepEqual(extractComments(spdx, "b.ts").map((c) => c.allowed), ["license-header", null]);
  const facehash = ["/**", " * Copyright (c) Cossistant team: face geometry from facehash 0.1.0.", " * MIT License", " */", "export {};"].join("\n");
  assert.deepEqual(extractComments(facehash, "c.ts").map((c) => c.allowed), [null]);
  const block = ["/*", " * SPDX-License-Identifier: MIT", " * Copyright 2026 Example Inc.", " */", "export {};"].join("\n");
  assert.deepEqual(extractComments(block, "e.ts").map((c) => c.allowed), ["license-header"]);
});

test("inline config that enables the rule is not a bypass, escaped names are decoded", () => {
  const source = [
    '/* eslint conclave/no-comments: "error" */',
    '/* eslint "conclave\\u002fno-comments": "off" */',
    "/* eslint conclave/no-comments: [0] */",
    "export {};",
  ].join("\n");
  assert.deepEqual(extractComments(source, "a.ts").map((c) => c.allowed), [null, null, null]);
  assert.deepEqual(
    [configuresNoComments('/* eslint conclave/no-comments: "error" */'), configuresNoComments('/* eslint "conclave\\u002fno-comments": "off" */'), configuresNoComments("/* eslint conclave/no-comments: [0] */")],
    [false, true, true],
  );
});

test("escapes in CSS, shell and Kotlin never open a comment", () => {
  assert.deepEqual(texts("a { background: url(a\\)b/*literal*/x); }\n/* real */\n", "a.css"), ["/* real */"]);
  assert.deepEqual(texts('.a\\"b { color: red; }\n/* real */\n.c { content: "x"; }\n', "b.css"), ["/* real */"]);
  assert.deepEqual(texts("echo word\\ #suffix\necho one\\ #literal # real\n", "a.sh"), ["# real"]);
  assert.deepEqual(texts('val `a"b` = 1 // real\nval c = "x"\n', "a.kt"), ["// real"]);
  assert.deepEqual(texts('val d = $$"""$$${ 1 /* real */ }"""\n', "b.kt"), ["/* real */"]);
});

test("Python comments come from tokenize, so format specs stay code", { skip: python312Missing }, () => {
  assert.deepEqual(texts('print(f"{1:=#6x}")  # real\n', "a.py"), ["# real"]);
});

test("Python 3.12 comments inside a multiline f-string field", { skip: python312Missing }, () => {
  assert.deepEqual(texts('value = f"""{\n    total  # inside\n}"""\n', "a.py"), ["# inside"]);
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
  const run = spawnSync("bash", ["-c", source], {
    encoding: "utf8",
    env: { PATH: `${process.env.PATH}${path.delimiter}/usr/bin${path.delimiter}/bin` },
  });
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

test("a # inside ${...} and a comment after a line continuation, run by bash", (t) => {
  if (spawnSync("bash", ["--version"]).error) {
    t.skip("bash is not installed");
    return;
  }
  const source = [
    "printf '%s\\n' ${GREETING:-hello #world}",
    "echo one \\",
    "  two # it's a comment",
    "echo three",
    "# last",
  ].join("\n");
  const run = spawnSync("bash", ["-c", source], { encoding: "utf8", env: { PATH: `${process.env.PATH}${path.delimiter}/usr/bin${path.delimiter}/bin` } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.split("\n").filter(Boolean), ["hello", "#world", "one two", "three"]);
  assert.deepEqual(texts(source, "fixture.sh"), ["# it's a comment", "# last"]);
});

test("a license notice must start its comment", () => {
  const source = [
    "// SPDX-License-Identifier: MIT",
    "// TODO: Update the Copyright 2026 label in Settings.",
    "export {};",
  ].join("\n");
  assert.deepEqual(extractComments(source, "a.ts").map((c) => c.allowed), ["license-header", null]);
  const later = ["// Copyright 2026 Example Inc.", "// Notes on the Copyright (c) dialog", "export {};"].join("\n");
  assert.deepEqual(extractComments(later, "b.ts").map((c) => c.allowed), ["license-header", null]);
  const dialog = ["// SPDX-License-Identifier: MIT", "// Copyright Dialog uses the same layout as Settings.", "export {};"].join("\n");
  assert.deepEqual(extractComments(dialog, "c.ts").map((c) => c.allowed), ["license-header", null]);
});

test("a Swift raw string #\"\"\"# holds one quote and does not open a multiline string", { skip: swiftMissing }, () => {
  assert.deepEqual(texts('let a = #"""#\n// real\nlet b = ##"""##\n// two\n', "A.swift"), ["// real", "// two"]);
  assert.deepEqual(texts('let c = #"""\n  // inside\n  """#\n// three\n', "B.swift"), ["// three"]);
  assert.deepEqual(texts('let r = /=a"b/ // real\n', "R.swift"), ["// real"]);
});

test("an unquoted CSS url() is scanned to its closing paren however much whitespace it has", () => {
  assert.deepEqual(texts(`a { b: url(${" ".repeat(60)}img/*large*/x.png); }\n/* real */\n`, "a.css"), ["/* real */"]);
});

test("a # license notice in shell or Python is recognised", { skip: python312Missing }, () => {
  for (const [file, source] of [
    ["a.sh", "# SPDX-License-Identifier: MIT\necho\n"],
    ["b.sh", "#!/bin/sh\n# SPDX-License-Identifier: MIT\necho\n"],
    ["a.py", "# SPDX-License-Identifier: MIT\nx = 1\n"],
  ]) {
    assert.equal(extractComments(source, file).at(-1).allowed, "license-header", file);
  }
});

test("bash continuations, arithmetic and command substitution in parameter defaults, run by bash", (t) => {
  if (spawnSync("bash", ["--version"]).error) {
    t.skip("bash is not installed");
    return;
  }
  const source = [
    "echo word\\",
    "\\",
    "#literal",
    'echo "${GREETING:-$((1 << 4))}"',
    'echo "${GREETING:-`echo backtick`}"',
    "echo tag ${tag:-Issue #123}",
    "echo \\",
    "# Don't restart yet",
    "echo after",
    "# last",
  ].join("\n");
  const run = spawnSync("bash", ["-c", source], { encoding: "utf8", env: { PATH: `${process.env.PATH}${path.delimiter}/usr/bin${path.delimiter}/bin` } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.split("\n").filter(Boolean), ["word#literal", "16", "backtick", "tag Issue #123", "after"]);
  assert.deepEqual(texts(source, "fixture.sh"), ["# Don't restart yet", "# last"]);
});

test("an f-string with reused quotes reads the same as Python 3.12 does", { skip: python312Missing }, () => {
  assert.deepEqual(texts('label = f"{labels["#primary"]}"\n# real\n', "a.py"), ["# real"]);
});

const olderPython = () => {
  for (const candidate of ["python3.11", "python3.10", "/usr/bin/python3"]) {
    const probe = spawnSync(candidate, ["-c", "import sys; print(sys.version_info < (3, 12), sys.executable)"], { encoding: "utf8" });
    const [older, executable] = (probe.stdout ?? "").trim().split(" ");
    if (!probe.error && older === "True") return executable;
  }
  return undefined;
};

test("with only a Python older than 3.12 the extractor fails instead of guessing", (t) => {
  const older = olderPython();
  if (!older) {
    t.skip("no Python older than 3.12 is installed");
    return;
  }
  const bin = mkdtempSync(path.join(tmpdir(), "old-python-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  symlinkSync(older, path.join(bin, "python3"));
  const script = `import(${JSON.stringify(new URL("./extract.mjs", import.meta.url).href)}).then(({ extractComments }) => extractComments('label = f"{labels["#primary"]}"\\n', "a.py"))`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Python 3\.12 or newer is required to read Python comments/);
});

test("the sweep finds a file whose scanner stops before the end", async (t) => {
  const { filesMissingEndMarker } = await import("./sweep.mjs");
  const repo = mkdtempSync(path.join(tmpdir(), "comment-sweep-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(path.join(repo, "ok.ts"), "export const a = 1; // fine\n");
  writeFileSync(path.join(repo, "unterminated.css"), "a { content: '/* x */ }\n/* no end");
  assert.deepEqual(filesMissingEndMarker(repo, ["ok.ts", "unterminated.css"]), ["unterminated.css"]);
});

test("a license notice after a shebang and a blank line is still the leading block", () => {
  assert.deepEqual(
    extractComments("#!/bin/sh\n\n# Copyright 2026 Example Inc.\necho hi\n", "run.sh").map((comment) => comment.allowed),
    ["shebang", "license-header"],
  );
  assert.deepEqual(
    extractComments("#!/usr/bin/env node\n\n// SPDX-License-Identifier: MIT\n\n// prose\nrun();\n", "run.mjs").map((comment) => comment.allowed),
    ["shebang", "license-header", null],
  );
});

test("a tracked file deleted from the working tree does not break listing or the sweep", async (t) => {
  const { filesMissingEndMarker } = await import("./sweep.mjs");
  const repo = mkdtempSync(path.join(tmpdir(), "comment-deleted-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(path.join(repo, "kept.ts"), "export const a = 1;\n");
  writeFileSync(path.join(repo, "gone.ts"), "export const b = 2;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  rmSync(path.join(repo, "gone.ts"));
  assert.deepEqual(listSourceFiles(repo), ["kept.ts"]);
  assert.deepEqual(filesMissingEndMarker(repo), []);
});
