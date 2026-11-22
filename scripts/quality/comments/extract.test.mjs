import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractComments, iconGeneratorOutputs, listSourceFiles, toolWorks } from "./extract.mjs";
import { configuresNoComments, languageOf } from "./policy.mjs";


const missing = (command, args) => {
  const probe = toolWorks(command, args);
  return probe.ok ? false : probe.reason;
};
const TOOL_REASONS = {
  swift: missing("swift", ["--version"]),
  jdk: missing("java", ["-version"]) || missing("javac", ["-version"]),
  python312: (() => {
    const probe = spawnSync("python3", ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 3)"]);
    if (probe.error) return "`python3` is not on PATH";
    return probe.status === 0 ? false : "python3 is older than 3.12";
  })(),
  bash: missing("bash", ["--version"]),
};
const TOOL_FOR_LANGUAGE = { swift: "swift", kotlin: "jdk", python: "python312" };

const requires = (tools) => {
  const reasons = tools.filter((tool) => TOOL_REASONS[tool]).map((tool) => `${tool}: ${TOOL_REASONS[tool]}`);
  return reasons.length > 0 ? `needs ${reasons.join("; ")}` : false;
};

let declaredTools = null;

const toolTest = (name, tools, fn) =>
  test(name, { skip: requires(tools) }, async (t) => {
    declaredTools = new Set(tools);
    try {
      await fn(t);
    } finally {
      declaredTools = null;
    }
  });

const toolsFor = (file) => (TOOL_FOR_LANGUAGE[languageOf(file)] ? [TOOL_FOR_LANGUAGE[languageOf(file)]] : []);

const assertDeclared = (file) => {
  const tool = TOOL_FOR_LANGUAGE[languageOf(file)];
  if (tool && !declaredTools?.has(tool)) throw new Error(`${file} needs ${tool}, which this test does not declare`);
};

const ENDINGS = [
  ["CRLF", (source) => source.replace(/\n/g, "\r\n")],
  ["CR", (source) => source.replace(/\n/g, "\r")],
];

const comparable = (comments) => comments.map(({ line, endLine, ownLines, linesShed, allowed, text }) => ({ line, endLine, ownLines, linesShed, allowed, text }));

const extract = (source, file) => {
  assertDeclared(file);
  const lf = extractComments(source, file);
  for (const [name, convert] of ENDINGS) {
    assert.deepEqual(comparable(extractComments(convert(source), file)), comparable(lf), `${file} differs with ${name} line endings`);
  }
  return lf;
};

const texts = (source, file) => extract(source, file).map((comment) => comment.text);
const disallowed = (source, file) =>
  extract(source, file)
    .filter((comment) => !comment.allowed)
    .map((comment) => comment.text);

toolTest("strings, templates and regexes that look like comments are code", [], (t) => {
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

toolTest("JSX text is not a comment but a JSX comment expression is", [], (t) => {
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

toolTest("positions report lines, ownership and the lines a deletion sheds", [], (t) => {
  const source = ["const a = 1;", "/**", " * block", " */", "const b = 2; // tail", "  // own"].join("\n");
  const comments = extract(source, "a.ts").map(({ line, endLine, ownLines, linesShed }) => ({
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

for (const [file, source] of [
  ["run.mjs", "#!/usr/bin/env node\n// note\nrun();\n"],
  ["run.sh", "#!/bin/sh\n# note\nrun\n"],
  ["run.py", "#!/usr/bin/env python3\n# note\nrun()\n"],
]) {
  toolTest(`a shebang is an allowed directive in ${file}`, toolsFor(file), () => {
    const [shebang, note] = extract(source, file);
    assert.equal(shebang.allowed, "shebang");
    assert.equal(shebang.line, 1);
    assert.equal(note.allowed, null);
  });
}

toolTest("only the allowlisted script directives are allowed", [], (t) => {
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
    extract(source, "a.test.ts").map((comment) => comment.allowed),
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

toolTest("a license header is allowed only at the very top of the file", [], (t) => {
  const header = ["// Copyright 2024 Example Inc.", "// Licensed under the MIT License.", "// See LICENSE."].join("\n");
  const source = `${header}\n\n// Narrative about the module.\nconst a = 1;\n// Copyright notice in the middle.\n`;
  assert.deepEqual(
    extract(source, "a.ts").map((comment) => [comment.line, comment.allowed]),
    [
      [1, "license-header"],
      [2, null],
      [3, null],
      [5, null],
      [7, null],
    ],
  );
});

toolTest("Swift raw, multiline and interpolated strings hide comment markers", ["swift"], (t) => {
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

toolTest("Kotlin raw strings, templates and char literals hide comment markers", ["jdk"], (t) => {
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

toolTest("shell # is a comment only at the start of a word outside quotes", [], (t) => {
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

toolTest("Python strings hide hash marks", ["python312"], (t) => {
  const source = ['a = "# not"', "b = '''", "# docstring line", "'''", 'c = f"{x}#"  # real'].join("\n");
  assert.deepEqual(texts(source, "tool.py"), ["# real"]);
});

toolTest("CSS strings hide comment markers and sourceMappingURL is allowed", [], (t) => {
  const source = ['a::after { content: "/* not */"; }', "/* real */", "/*# sourceMappingURL=app.css.map */"].join("\n");
  assert.deepEqual(
    extract(source, "app.css").map((comment) => [comment.text, comment.allowed]),
    [
      ["/* real */", null],
      ["/*# sourceMappingURL=app.css.map */", "source-map-url"],
    ],
  );
});

toolTest("Skip transpiler directives are allowed in Swift", ["swift"], () => {
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
    extract(source, "Bridge+Android.swift").map((comment) => comment.allowed),
    ["skip-directive", "skip-directive", "skip-directive", "skip-directive", "skip-directive", "skip-directive", null, null],
  );
});

for (const [file, source] of [
  ["a.kt", "// SKIP SYMBOLFILE\nval a = 1\n"],
  ["a.ts", "// SKIP SYMBOLFILE\nconst a = 1;\n"],
]) {
  toolTest(`a Skip directive is an ordinary comment in ${file}`, toolsFor(file), () => {
    assert.deepEqual(extract(source, file).map((comment) => comment.allowed), [null]);
  });
}

toolTest("a license notice may follow a directive prologue, an attribution is a comment", [], () => {
  const source = [
    '"use client";',
    "",
    "// SPDX-License-Identifier: MIT",
    '// Ported (and trimmed) from AI SDK Elements (elements.ai-sdk.dev) "PromptInput".',
    "",
    "import { a } from \"a\";",
  ].join("\n");
  assert.deepEqual(extract(source, "prompt-input.tsx").map((comment) => comment.allowed), ["license-header", null]);
  assert.deepEqual(
    extract('const a = "use client";\n// Copyright 2024 Example\n', "a.ts").map((comment) => comment.allowed),
    [null],
  );
});

toolTest("a Kotlin attribution that only names a license is a comment", ["jdk"], () => {
  const apache = ["/* Licensed under the Apache License, Version 2.0: Material Symbols by Google. */", "package a"].join("\n");
  assert.deepEqual(extract(apache, "Icons.kt").map((comment) => comment.allowed), [null]);
});

toolTest("Swift regex literals hide comment markers", ["swift"], (t) => {
  const source = [
    "let url = #/https?://example\\.com/#",
    "let wide = ##/a/#b/##",
    "let multi = #/",
    "  // inside an extended literal",
    "  /#",
    "let bare = /a\\/*b/",
    "let slashes = try Regex(/[\\/]+x/)",
    "let half = total / 2 // real one",
    "let ratio = a / b / c",
    "// real two",
  ].join("\n");
  assert.deepEqual(texts(source, "Patterns.swift"), ["// real one", "// real two"]);
});

toolTest("a directive is never part of a license header", [], (t) => {
  const source = [
    "// SPDX-License-Identifier: MIT",
    "/* eslint-disable conclave/no-comments -- copyright notice below */",
    "// Copyright 2024 Example Inc.",
    "/* eslint conclave/no-comments: \"off\" */",
    "export {};",
  ].join("\n");
  assert.deepEqual(
    extract(source, "a.ts").map((comment) => comment.allowed),
    ["license-header", null, "license-header", null],
  );
  const onlyDirectives = ["/* eslint-disable no-console -- SPDX-License-Identifier: MIT */", "// hidden", "export {};"].join("\n");
  assert.deepEqual(
    extract(onlyDirectives, "b.ts").map((comment) => comment.allowed),
    ["eslint-directive", null],
  );
});

toolTest("shell here-strings, arithmetic shifts and escaped heredoc delimiters", [], (t) => {
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

toolTest("Kotlin multi-dollar strings interpolate only with the full dollar run", ["jdk"], (t) => {
  const source = [
    'val a = $$"""value ${ /* literal */ } and $${ x /* real one */ }"""',
    'val b = "plain ${ y /* real two */ }"',
    'val c = $$"price ${1}"',
  ].join("\n");
  assert.deepEqual(texts(source, "a.kt"), ["/* real one */", "/* real two */"]);
});

toolTest("CSS unquoted url() is not a comment", [], (t) => {
  const source = ["a { background: url(img/*2x*/a.png); }", "/* real */", 'b { background: URL( "x/*y" ); }'].join("\n");
  assert.deepEqual(texts(source, "a.css"), ["/* real */"]);
});

toolTest("Python f-string replacement fields can hold comments, format specs cannot", ["python312"], (t) => {
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

toolTest("Swift raw strings take any number of hashes", ["swift"], (t) => {
  const hashes = "#".repeat(12);
  const source = [`let s = ${hashes}"// not a comment "${"#".repeat(11)} still raw"${hashes}`, "// real"].join("\n");
  assert.deepEqual(texts(source, "Raw.swift"), ["// real"]);
});

toolTest("Skip directives follow the pinned skipstone grammar in line and block form", ["swift"], (t) => {
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
    extract(source, "Bridge.swift").map((comment) => comment.allowed),
    ["skip-directive", "skip-directive", null, null, "skip-directive", "skip-directive", "skip-directive", null, "skip-directive", null],
  );
});

toolTest("a license header needs a real marker and covers only the top block", [], (t) => {
  const todo = ["// TODO revisit the copyright dialog", "// and the licensed under review copy", "export {};"].join("\n");
  assert.deepEqual(extract(todo, "a.ts").map((c) => c.allowed), [null, null]);
  const split = ["// Copyright (c) 2024 Example Inc.", "", "// Narrative about the module.", "export {};"].join("\n");
  assert.deepEqual(extract(split, "b.ts").map((c) => c.allowed), ["license-header", null]);
  for (const notice of ["// SPDX-License-Identifier: MIT", "// SPDX-License-Identifier: Apache-2.0 OR MIT", "// Copyright 2024-2026 Example Inc.", "// Copyright (c) 2026 ACM-VIT"]) {
    assert.deepEqual(extract(`${notice}\nexport {};\n`, "c.ts").map((c) => c.allowed), ["license-header"], notice);
  }
  for (const prose of ["// © 2024 Example", "// Licensed under the Apache License, Version 2.0", "// MIT License", "// SPDX-License-Identifier: MIT, see LICENSE"]) {
    assert.deepEqual(extract(`${prose}\nexport {};\n`, "d.ts").map((c) => c.allowed), [null], prose);
  }
});

toolTest("NOWARN takes only skipstone's diagnostic ids, and trailing spaces are trimmed", ["swift"], (t) => {
  const source = [
    "// SKIP NOWARN   ",
    "// SKIP NOWARN(free text)",
    "// SKIP NOWARN( EXTENSION_MERGING , EXTENSION_MERGING )",
    "// SKIP NOWARN()",
    "let a = 1",
  ].join("\n");
  assert.deepEqual(
    extract(source, "Bridge.swift").map((comment) => comment.allowed),
    ["skip-directive", null, "skip-directive", null],
  );
});

toolTest("provenance hashes are allowed only in files the icon generator writes", ["jdk"], (t) => {
  const hash = "a8f815b7cd4ceb7bf9c5d04f6fed8528a3cf77981e3994e91cace24d6e25b541";
  const header = `// Profile material-rounded-24-absolute-v1; manifest SHA256 ${hash}; generator SHA256 ${hash}.`;
  const vector = `    // mic.fill1; input SHA256 ${hash}.`;
  const generated = "apps/conclave-skip/Sources/Conclave/Skip/ui/icons/ConclaveIcons.kt";
  const source = `${header}\npackage a\n${vector}\n// a sentence ending in SHA256 ${hash}.\n`;
  assert.deepEqual(extract(source, generated).map((c) => c.allowed), ["provenance-hash", "provenance-hash", null]);
  assert.deepEqual(
    extract(source, "apps/conclave-skip/Sources/Conclave/Skip/Other.kt").map((c) => c.allowed),
    [null, null, null],
  );
});

toolTest("the icon generator's output list is read from the generator", [], (t) => {
  assert.deepEqual([...iconGeneratorOutputs()].sort(), [
    "apps/conclave-skip/Sources/Conclave/DesignSystem/iOS/Icons/ConclaveSymbols.swift",
    "apps/conclave-skip/Sources/Conclave/DesignSystem/iOS/Icons/NativeSymbolCatalog.swift",
    "apps/conclave-skip/Sources/Conclave/Skip/ui/icons/ConclaveIcons.kt",
    "apps/conclave-skip/Sources/Conclave/Skip/ui/icons/NativeConvertedIconFixtures.kt",
    "apps/conclave-skip/Sources/Conclave/Skip/ui/icons/NativeIconCatalog.kt",
  ]);
});

toolTest("a license block counts only comments that are notices themselves", [], (t) => {
  const todo = ["// TODO change the MIT License dialog", "// and the copy next to it", "export {};"].join("\n");
  assert.deepEqual(extract(todo, "a.ts").map((c) => c.allowed), [null, null]);
  const spdx = ["// SPDX-License-Identifier: MIT", "/* TODO clean this module up */", "export {};"].join("\n");
  assert.deepEqual(extract(spdx, "b.ts").map((c) => c.allowed), ["license-header", null]);
  const facehash = ["/**", " * Copyright (c) Cossistant team: face geometry from facehash 0.1.0.", " * MIT License", " */", "export {};"].join("\n");
  assert.deepEqual(extract(facehash, "c.ts").map((c) => c.allowed), [null]);
  const block = ["/*", " * SPDX-License-Identifier: MIT", " * Copyright 2026 Example Inc.", " */", "export {};"].join("\n");
  assert.deepEqual(extract(block, "e.ts").map((c) => c.allowed), ["license-header"]);
});

toolTest("inline config that enables the rule is not a bypass, escaped names are decoded", [], (t) => {
  const source = [
    '/* eslint conclave/no-comments: "error" */',
    '/* eslint "conclave\\u002fno-comments": "off" */',
    "/* eslint conclave/no-comments: [0] */",
    "export {};",
  ].join("\n");
  assert.deepEqual(extract(source, "a.ts").map((c) => c.allowed), [null, null, null]);
  assert.deepEqual(
    [configuresNoComments('/* eslint conclave/no-comments: "error" */'), configuresNoComments('/* eslint "conclave\\u002fno-comments": "off" */'), configuresNoComments("/* eslint conclave/no-comments: [0] */")],
    [false, true, true],
  );
});

toolTest("escapes in CSS and shell never open a comment", [], () => {
  assert.deepEqual(texts("a { background: url(a\\)b/*literal*/x); }\n/* real */\n", "a.css"), ["/* real */"]);
  assert.deepEqual(texts('.a\\"b { color: red; }\n/* real */\n.c { content: "x"; }\n', "b.css"), ["/* real */"]);
  assert.deepEqual(texts("echo word\\ #suffix\necho one\\ #literal # real\n", "a.sh"), ["# real"]);
});

toolTest("Kotlin backtick names and multi-dollar strings never open a comment", ["jdk"], () => {
  assert.deepEqual(texts('val `a"b` = 1 // real\nval c = "x"\n', "a.kt"), ["// real"]);
  assert.deepEqual(texts('val d = $$"""$$${ 1 /* real */ }"""\n', "b.kt"), ["/* real */"]);
});

toolTest("Python comments come from tokenize, so format specs stay code", ["python312"], (t) => {
  assert.deepEqual(texts('print(f"{1:=#6x}")  # real\n', "a.py"), ["# real"]);
});

toolTest("Python 3.12 comments inside a multiline f-string field", ["python312"], (t) => {
  assert.deepEqual(texts('value = f"""{\n    total  # inside\n}"""\n', "a.py"), ["# inside"]);
});

toolTest("shell fixtures that bash runs agree with the extractor", ["bash"], (t) => {
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

toolTest("a # inside ${...} and a comment after a line continuation, run by bash", ["bash"], (t) => {
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

toolTest("a license notice must start its comment", [], (t) => {
  const source = [
    "// SPDX-License-Identifier: MIT",
    "// TODO: Update the Copyright 2026 label in Settings.",
    "export {};",
  ].join("\n");
  assert.deepEqual(extract(source, "a.ts").map((c) => c.allowed), ["license-header", null]);
  const later = ["// Copyright 2026 Example Inc.", "// Notes on the Copyright (c) dialog", "export {};"].join("\n");
  assert.deepEqual(extract(later, "b.ts").map((c) => c.allowed), ["license-header", null]);
  const dialog = ["// SPDX-License-Identifier: MIT", "// Copyright Dialog uses the same layout as Settings.", "export {};"].join("\n");
  assert.deepEqual(extract(dialog, "c.ts").map((c) => c.allowed), ["license-header", null]);
});

toolTest("a Swift raw string #\"\"\"# holds one quote and does not open a multiline string", ["swift"], (t) => {
  assert.deepEqual(texts('let a = #"""#\n// real\nlet b = ##"""##\n// two\n', "A.swift"), ["// real", "// two"]);
  assert.deepEqual(texts('let c = #"""\n  // inside\n  """#\n// three\n', "B.swift"), ["// three"]);
  assert.deepEqual(texts('let r = /=a"b/ // real\n', "R.swift"), ["// real"]);
});

toolTest("an unquoted CSS url() is scanned to its closing paren however much whitespace it has", [], (t) => {
  assert.deepEqual(texts(`a { b: url(${" ".repeat(60)}img/*large*/x.png); }\n/* real */\n`, "a.css"), ["/* real */"]);
});

for (const [file, source] of [
  ["a.sh", "# SPDX-License-Identifier: MIT\necho\n"],
  ["b.sh", "#!/bin/sh\n# SPDX-License-Identifier: MIT\necho\n"],
  ["a.py", "# SPDX-License-Identifier: MIT\nx = 1\n"],
]) {
  toolTest(`a # license notice is recognised in ${file}`, toolsFor(file), () => {
    assert.equal(extract(source, file).at(-1).allowed, "license-header");
  });
}

toolTest("bash continuations, arithmetic and command substitution in parameter defaults, run by bash", ["bash"], (t) => {
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

toolTest("an f-string with reused quotes reads the same as Python 3.12 does", ["python312"], (t) => {
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

toolTest("with only a Python older than 3.12 the extractor fails instead of guessing", [], (t) => {
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

toolTest("the sweep finds a file whose scanner stops before the end", [], async (t) => {
  const { filesMissingEndMarker } = await import("./sweep.mjs");
  const repo = mkdtempSync(path.join(tmpdir(), "comment-sweep-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(path.join(repo, "ok.ts"), "export const a = 1; // fine\n");
  writeFileSync(path.join(repo, "unterminated.css"), "a { content: '/* x */ }\n/* no end");
  assert.deepEqual(filesMissingEndMarker(repo, ["ok.ts", "unterminated.css"]), ["unterminated.css"]);
});

toolTest("a license notice after a shebang and a blank line is still the leading block", [], (t) => {
  assert.deepEqual(
    extract("#!/bin/sh\n\n# Copyright 2026 Example Inc.\necho hi\n", "run.sh").map((comment) => comment.allowed),
    ["shebang", "license-header"],
  );
  assert.deepEqual(
    extract("#!/usr/bin/env node\n\n// SPDX-License-Identifier: MIT\n\n// prose\nrun();\n", "run.mjs").map((comment) => comment.allowed),
    ["shebang", "license-header", null],
  );
});

toolTest("a tracked file deleted from the working tree does not break listing or the sweep", [], async (t) => {
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

toolTest("CSS comments come from the CSS tokenizer, so url() bodies stay data", [], (t) => {
  assert.deepEqual(texts("a { b: u\\72l(icon/*crop*/x.svg) }\n/* real */\n", "a.css"), ["/* real */"]);
  assert.deepEqual(texts("a { b: u\\72l(img/*2x*/x.png) }\n", "b.css"), []);
  assert.deepEqual(texts("a { --x: #url(/* real */ red) }\n", "c.css"), ["/* real */"]);
  assert.deepEqual(texts("a { --image: αurl(/* note */ 1px) }\n", "d.css"), ["/* note */"]);
});

const FACEHASH_NOTICE = readFileSync(new URL("../../../apps/web/src/lib/avatar-faces.ts", import.meta.url), "utf8")
  .split("\n")
  .slice(0, 21)
  .join("\n");

toolTest("the repo's facehash MIT notice is a license header in a new file", [], (t) => {
  assert.match(FACEHASH_NOTICE, /^\/\*\*[\s\S]*Permission is hereby granted[\s\S]*\*\/$/);
  assert.deepEqual(extract(`${FACEHASH_NOTICE}\nexport const a = 1;\n// prose\n`, "new.ts").map((c) => c.allowed), ["license-header", null]);
});

for (const [file, marker, code] of [
  ["a.ts", "//", "export {};"],
  ["a.sh", "#", "echo a"],
  ["a.py", "#", "a = 1"],
  ["A.swift", "//", "let a = 1"],
]) {
  toolTest(`an SPDX and Copyright header passes in ${file} with every line ending`, toolsFor(file), () => {
    const source = `${marker} SPDX-License-Identifier: MIT\n${marker} Copyright 2026 Example Inc.\n${code}\n`;
    assert.deepEqual(extract(source, file).map((c) => c.allowed), ["license-header", "license-header"]);
  });
}

toolTest("a license header may follow a Swift shebang", ["swift"], () => {
  assert.deepEqual(extract("#!/usr/bin/env swift\n// SPDX-License-Identifier: MIT\nprint(1)\n", "tool.swift").map((c) => c.allowed), ["license-header"]);
});

toolTest("a license header may follow a Python encoding line", ["python312"], () => {
  assert.deepEqual(
    extract("#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n# SPDX-License-Identifier: MIT\nx = 1\n", "tool.py").map((c) => c.allowed),
    ["shebang", "encoding-declaration", "license-header"],
  );
});

toolTest("standard license texts in line comments are one notice, prose is not", [], (t) => {
  const isc = [
    "// Copyright 2026 Example Inc.",
    "//",
    "// Permission to use, copy, modify, and/or distribute this software for any",
    "// purpose with or without fee is hereby granted, provided that the above",
    "// copyright notice and this permission notice appear in all copies.",
    "//",
    '// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES',
    "// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF",
    "// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR",
    "// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES",
    "// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN",
    "// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF",
    "// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.",
    "// TODO tidy this module",
    "export {};",
  ].join("\n");
  const verdicts = extract(isc, "isc.ts").map((c) => c.allowed);
  assert.deepEqual(verdicts.slice(0, -1), Array(verdicts.length - 1).fill("license-header"));
  assert.equal(verdicts.at(-1), null);
  assert.deepEqual(extract("// TODO change the MIT License dialog\n// Permission is hereby granted\nexport {};\n", "todo.ts").map((c) => c.allowed), [null, null]);
  const apache = [
    "# Licensed under the Apache License, Version 2.0 (the \"License\");",
    "# you may not use this file except in compliance with the License.",
    "# You may obtain a copy of the License at",
    "#",
    "#     http://www.apache.org/licenses/LICENSE-2.0",
    "#",
    "# Unless required by applicable law or agreed to in writing, software",
    "# distributed under the License is distributed on an \"AS IS\" BASIS,",
    "# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.",
    "# See the License for the specific language governing permissions and",
    "# limitations under the License.",
    "echo hi",
  ].join("\n");
  assert.ok(extract(apache, "apache.sh").every((c) => c.allowed === "license-header"));
});

toolTest("a Kotlin file with bare CR line endings is read line by line", ["jdk"], () => {
  assertDeclared("Main.kt");
  assert.deepEqual(extractComments('fun main() {\r    println("x")\r}\r// actual\r', "Main.kt").map((c) => [c.line, c.text]), [[4, "// actual"]]);
});

toolTest("a Python file with bare CR line endings is read line by line", ["python312"], () => {
  assertDeclared("a.py");
  assert.deepEqual(extractComments("x = 1\r# actual\r", "a.py").map((c) => [c.line, c.text]), [[2, "# actual"]]);
});

toolTest("the Swift helper refuses a file swift-syntax cannot parse", ["swift"], (t) => {
  assertDeclared("Broken.swift");
  assert.throws(() => extractComments('let s = """\n  unterminated\n// after\n', "Broken.swift"), /cannot read the comments in Broken\.swift: swift-syntax reported syntax errors/);
});

const ISC_NOTICE = [
  "Copyright 2026 Example Inc.",
  "",
  "Permission to use, copy, modify, and/or distribute this software for any",
  "purpose with or without fee is hereby granted, provided that the above",
  "copyright notice and this permission notice appear in all copies.",
  "",
  'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES',
  "WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF",
  "MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR",
  "ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES",
  "WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN",
  "ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF",
  "OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.",
];

toolTest("text outside a matched license notice is an ordinary comment", [], () => {
  const block = (extra) => ["/*", ...[...ISC_NOTICE, ...extra].map((line) => ` * ${line}`.trimEnd()), " */"].join("\n");
  assert.deepEqual(extract(`${block([])}\nexport {};\n`, "plain.ts").map((c) => c.allowed), ["license-header"]);
  assert.deepEqual(extract(`${block(["TODO: replace the temporary cache."])}\nexport {};\n`, "same.ts").map((c) => c.allowed), [null]);
  const lines = ISC_NOTICE.map((line) => `// ${line}`.trimEnd());
  const before = ["// TODO: replace the temporary cache.", ...lines, "export {};"].join("\n");
  const beforeVerdicts = extract(before, "before.ts").map((c) => c.allowed);
  assert.equal(beforeVerdicts[0], null);
  assert.ok(beforeVerdicts.slice(1).every((verdict) => verdict === "license-header"));
  const after = [...lines, "// TODO: replace the temporary cache.", "export {};"].join("\n");
  const afterVerdicts = extract(after, "after.ts").map((c) => c.allowed);
  assert.equal(afterVerdicts.at(-1), null);
  assert.ok(afterVerdicts.slice(0, -1).every((verdict) => verdict === "license-header"));
});

toolTest("a fixture whose language needs an undeclared tool fails in every environment", [], () => {
  assert.throws(() => extract("x = 1\n", "a.py"), /a\.py needs python312, which this test does not declare/);
  assert.throws(() => extract("let a = 1\n", "A.swift"), /A\.swift needs swift, which this test does not declare/);
  assert.throws(() => extract("val a = 1\n", "A.kt"), /A\.kt needs jdk, which this test does not declare/);
});
