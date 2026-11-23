---
name: delete-comment
description: Run a Conclave comment-deletion pass. List comments with the extractor, classify each one, delete it, move decisions into ADRs and hacks into issues, then shrink the ratchet baselines. Use for "delete comments", "comment audit", "/delete-comment", or when conclave/no-comments or the comment ratchet fails.
---

# Delete comments

Conclave keeps no code comments. `conclave/no-comments` (ESLint, TS/JS) and `scripts/quality/comments/ratchet.mjs` (Swift, Kotlin, CSS, shell, Python) fail `pnpm check` on any new comment. The comments that predate the rule are counted per file in three baselines, and those counts only go down:

- `eslint-suppressions.json` for TS/JS outside `apps/web`;
- `apps/web/eslint-suppressions.json` for `apps/web`;
- `scripts/quality/comments/baseline.json` for the other languages.

A pass deletes comments, keeps what matters in ADRs and issues, and lowers those counts.

## Threat model

Committers are trusted. `conclave/no-comments` and the ratchet are a guardrail that stops comments drifting back in by accident, not a security boundary against a committer who sets out to hide one. That sets the bar: the extractor must never report executable input as a comment, because deleting it would change code, and must never lose track of the rest of a file. The allowlists must not exempt ordinary prose because it sits next to a real directive or notice. A deliberate bypass, such as prose written to look like a license notice or a comment smuggled into a Skip INSERT body, is out of scope; review catches it.

Known limits under that bar:

- A `// ` line that continues an open `SKIP INSERT:`, `REPLACE:`, `DECLARE:` or attributes directive is allowed whatever it says. Skip treats it as Kotlin source, and the extractor cannot tell code from prose there.
- Every language's comments come from its real tokenizer, through one entry point that first turns CRLF and bare CR into LF: TS/JS from `typescript-eslint`, CSS from `@csstools/css-tokenizer`, shell from `sh-syntax` (mvdan/sh), Swift from swift-syntax 604.0.0 trivia (`scripts/quality/comments/swift-trivia`), Kotlin from the Kotlin compiler's `KotlinLexer` (2.4.21, `scripts/quality/comments/kotlin-lexer`, needs a JDK 17+; jars come from the Gradle cache or the tool cache and are checked against pinned SHA-256s), and Python from `tokenize` on Python 3.12 or newer. There are no hand-written scanners. A missing or broken tool for a file that is being checked, or a file its parser rejects (the Swift helper exits non-zero on any syntax error), fails with the file and the reason. A tool whose launcher runs but exits non-zero counts as missing. Deleted files and files outside the diff are never parsed. `pnpm check` never touches the network: run `pnpm comments:tools` once per machine to fetch the Kotlin jars from Maven Central (when the Gradle cache lacks them) and to fetch and build swift-syntax, and a check that needs one that is missing fails and names that command.
- The base is resolved, never guessed, and never fetched by the check: the ratchet reads it with Git's lazy fetch off (`GIT_NO_LAZY_FETCH=1`). A missing `origin/<branch>` base, or a base file a partial clone does not hold, stops the ratchet with a message naming `pnpm comments:fetch-base`, which fetches exactly the base ref and the base files the check reads. CI runs `pnpm comments:tools` and `pnpm comments:fetch-base` before the lint job's tasks. A shallow clone with no shared history stops with a `git fetch --unshallow origin` hint. Nothing widens to a full scan except `pnpm comments:sweep`.

## 1. Scope the pass to files no open PR touches

Deleting a comment in a file an open PR also edits makes a merge conflict for its author. Skip those files.

```sh
for n in $(gh pr list --state open --limit 200 --json number --jq '.[].number'); do
  gh pr diff "$n" --name-only
done | sort -u > /tmp/open-pr-files.txt
```

`gh pr diff --name-only` lists every file. `gh pr list --json files` stops at 100 files per PR. Compare whole paths (`grep -x`), since a bare substring match treats `eslint.config.mjs` as `apps/web/eslint.config.mjs`.

A file that changed since a classification was made shifts its line numbers. Re-extract and re-check those files instead of trusting old line numbers.

## 2. List the comments

```sh
pnpm -s comments:list > /tmp/comments.jsonl
node scripts/quality/comments/extract.mjs packages/sfu apps/web/src > /tmp/comments.jsonl
```

Pass paths to narrow the pass. Each line is one comment with these fields:

- `file`, `line`, `endLine`;
- `ownLines`: true when nothing else shares its lines;
- `linesShed`: the lines deleting it removes;
- `allowed`: the allowlist kind, such as `shebang`, `eslint-directive` or `license-header`, or `null`;
- `text`.

Drop every record whose `file` is in `/tmp/open-pr-files.txt`. Keep the allowlisted records in the list and classify them too: `allowed` only says the lint lets a comment through, not that it should stay. An annotated `eslint-disable` or `@ts-expect-error` that silences a bug-catching rule is still an Excuse. Drop an allowlisted record only after step 3 calls it Keep tooling or Keep license.

## 3. Classify each comment

Read the code around every comment, and the symbols it names, before you judge it. Give each comment exactly one category:

- **Tautology:** it repeats what the code already shows, through names, types or the next line.
- **Excuse:** it justifies or apologises for a hacky, temporary or "for now" implementation. Workarounds, TODOs, FIXMEs, "too risky to change", "hack", "temporary", "we should" and "until X" belong here, as do suppressions that silence a real bug-catching lint or type rule. The hack needs a real fix.
- **Stale:** it describes code, behavior, files or decisions that no longer match the code. Check it against the current code.
- **Decision record:** it documents an important, non-obvious decision. That means why the code is this way, what was rejected, or an outside constraint (protocol, browser, vendor or platform) the code can't express. Ask whether a careful new maintainer would get the code wrong without it. A long explanation of our own code's behavior that a rename or a type could carry is a Tautology or an Excuse.
- **Keep tooling:** a directive a tool reads. This means `eslint-disable` with a ` -- reason` for a style-only rule, `@ts-expect-error` with a description for a third-party type bug, `prettier-ignore`, `/// <reference>`, `@vitest-environment`, `#!` shebangs, `sourceMappingURL`, `// swift-tools-version`, Skip transpiler directives in Swift, and the provenance hash lines the native icon generator writes. Never delete a Skip directive: the Android build depends on it. The policy mirrors the pinned skipstone parser (`StatementExtras.decode` in `.build/checkouts/skip/skipstone`): an own-line `// SKIP` or `/* SKIP ... */` followed by `@`, `ATTRIBUTES:`, `INSERT:`, `REPLACE:`, `DECLARE:`, `NOWARN` (bare or with IDs), `EXTERN` or `SYMBOLFILE`, plus the `// ` lines that continue an open INSERT, REPLACE, DECLARE or attributes directive. Anything else that starts `// SKIP`, such as `// SKIP TODO`, is not a directive. Re-read that parser when Skip is upgraded. Provenance hashes need the icon generator's exact `// Profile ...; manifest SHA256 ...; generator SHA256 ....` first line. A license header is the comment block at the very top of the file (after a shebang, a Python encoding line or a `"use client"` prologue) that is a license notice: SPDX lines, Copyright lines with a year, or a known license text either inside one comment or spread over line comments in which every line belongs to that text. The known texts are the SPDX license list templates for MIT, ISC, BSD-2-Clause, BSD-3-Clause and the Apache-2.0 header (`scripts/quality/comments/license-templates.json`, SPDX v3.29.0), matched the SPDX way: case, whitespace and quote style do not matter, and the template's variable and optional parts match what SPDX lets them match. Lines that belong next to a matched text, such as Copyright lines, "All rights reserved.", the license title and a bare URL, are part of the notice. Any other line, before, after or inside the comment, makes that comment ordinary. The first comment that is not part of the notice ends the header. Attributions such as "Ported from ..." are ordinary comments and are counted; keep them, do not delete a legal notice. `SKIP NOWARN(...)` takes only the diagnostic ids skipstone knows (`EXTENSION_MERGING` in Skip 1.9.21). Provenance hashes are allowed only in the files `gen-native-icons.py` writes, which the extractor reads from the generator. Swift `MARK:` is a Tautology unless a tool depends on it. A `swiftlint:` directive is Stale, because SwiftLint is not configured or run in this repo.
- **Keep license:** a legal, license or attribution notice at the top of a file. Only SPDX and Copyright lines are allowed by the rule; a longer notice or attribution stays in the file and in the baseline.

Be honest: most comments are tautologies. When in doubt between a decision record and a tautology, ask the maintainer question again.

Some files say GENERATED or "do not edit". Fix their comments in the generator, regenerate, and run that generator's `--check` script. Hashes the build depends on are Keep tooling. Keep a GENERATED header only where a check reads it: `gen-native-icons.py` finds its Android drawable outputs by the header in the XML, but nothing reads the header in its Swift or Kotlin outputs. Editing `gen-native-icons.py` changes the generator SHA-256 inside every output, so regenerate and commit all of them together. Skip a generator whose output is in an open PR.

## 4. Act on each category

- **Tautology, Stale:** delete it, with the blank lines it leaves behind. When a name was the reason for the comment, rename the symbol instead. A block left empty becomes `catch {}` (the lint config allows empty catches); check Swift `case` bodies, which must keep a statement. A trailing comment that ends a line after an operator (`? // note`) leaves the operator dangling, so join it to the next line.
- **Excuse:** delete it and file one issue per hack. Group every comment about the same hack into one issue:

  ```sh
  gh label create comment-excuse --color D93F0B --description "A hack a deleted comment excused" 2>/dev/null || true
  gh issue create --label comment-excuse --title "<the hack to fix>" --body-file /tmp/issue.md
  ```

  The body names the hack, every `file:line`, why it is a hack, and what a real fix looks like.
- **Decision record:** delete it and move it into an ADR under `docs/adr`, following `docs/adr/README.md`. Group comments on one topic into one record. Add the record's files and symbols to its Code section and the index. Then carry the decision in code without a comment, through an identifier that names it or a test named `ADR NNNN: ...`.
- **Keep tooling, Keep license:** leave them, because the rule allows them. Add a ` -- reason` to a bare `eslint-disable`, and a description to a bare `@ts-expect-error`. A blanket `eslint-disable` must name its rules.

## 5. Sweep the whole tree and shrink the baselines

```sh
pnpm -C apps/web exec next typegen
pnpm comments:sweep
```

Run `next typegen` first: without the generated route types, the typed web lint fails and the sweep stops before it writes anything.

`pnpm check` (and so the pre-push path) only reads the files changed since the base, and loads a language's parser only when that language is in the diff. A web-only change never needs Swift, Python or sh-syntax; a change to a `.swift` file without a Swift toolchain fails and names the file and the missing tool. `pnpm comments:sweep` is the explicit full-tree pass and needs every parser:

1. `sweep.mjs` appends an end marker to every tracked file and fails if any scanner stops before it.
2. `ratchet.mjs --full` checks every tracked file against the baselines.
3. `eslint --prune-suppressions` at the root and in `apps/web`, then `ratchet.mjs --update`, lower the baselines. Both only lower counts. `pnpm comments:prune` is an alias.

`pnpm comments:tools` fetches swift-syntax and builds the Swift parser once per machine into `~/Library/Caches/conclave/swift-trivia/swift-syntax-<version>` (or `$XDG_CACHE_HOME`, `~/.cache`, or `$CONCLAVE_CACHE_DIR`), so every worktree reuses it. The first build takes a few CPU minutes; later runs are a no-op check of a few seconds.

`pnpm lint` runs ESLint with `--pass-on-unpruned-suppressions`, so a change that deletes comments passes without a prune, and so does the ratchet. A count left high cannot be refilled: the ratchet compares each changed file's comment count with the base commit and fails on any rise. Prune anyway in a comment pass, so the baselines show what is left.

Never run `eslint --suppress-rule` or `--suppress-all`, and never raise a count by hand. The ratchet compares all three baselines, and every changed file's comment count, with a base commit and fails on any rise. The base is the merge base with `$COMMENT_RATCHET_BASE` (default `origin/staging`). CI sets it to the PR's base branch on pull requests (merge base). On pushes it sets `COMMENT_RATCHET_MODE=exact` and compares with the previous tip itself, so a force push is measured against what it replaced; when that tip is gone it compares with `HEAD^1` and says so. A clean checkout that sits on the base branch compares with `HEAD^1`. Inline config that switches the rule off (`/* eslint conclave/no-comments: "off" */`, a blanket `eslint-disable`, or a disable that names the rule) fails the ratchet wherever it sits, license header included. A moved file counts as a new file, so delete its comments when you move it.

## 6. Run the gate

```sh
pnpm install --frozen-lockfile && pnpm -C apps/web exec next typegen && pnpm check && pnpm build
swift build --package-path apps/conclave-skip
```

Run the Swift build when the pass touched `apps/conclave-skip`. Commit one area per Conventional Commit, such as `refactor(sfu): delete tautological comments`. In the PR, link the ADRs and issues the pass created.
