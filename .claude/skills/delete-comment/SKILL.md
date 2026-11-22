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
- **Keep tooling:** a directive a tool reads. This means `eslint-disable` with a ` -- reason` for a style-only rule, `@ts-expect-error` with a description for a third-party type bug, `prettier-ignore`, `/// <reference>`, `@vitest-environment`, `#!` shebangs, `sourceMappingURL`, `// swift-tools-version`, Skip transpiler directives in Swift (`// SKIP SYMBOLFILE`, `// SKIP INSERT:`, `// SKIP DECLARE:`, `// SKIP REPLACE:`, `// SKIP NOWARN`, `// SKIP @...`), and the provenance hash lines the native icon generator writes. Never delete a Skip directive: the Android build depends on it. Swift `MARK:` is a Tautology unless a tool depends on it. A `swiftlint:` directive is Stale, because SwiftLint is not configured or run in this repo.
- **Keep license:** a legal, license or attribution notice at the top of a file.

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

## 5. Shrink the baselines

```sh
pnpm -C apps/web exec next typegen
pnpm comments:prune
```

Run `next typegen` first: without the generated route types, the typed web lint fails and the prune stops before it writes anything.

This runs `eslint --prune-suppressions` at the root and in `apps/web`, then `ratchet.mjs --update`. Both only lower counts.

`pnpm lint` runs ESLint with `--pass-on-unpruned-suppressions`, so a change that deletes comments passes without a prune, and so does the ratchet. A count left high cannot be refilled: the ratchet compares each changed file's comment count with the base commit and fails on any rise. Prune anyway in a comment pass, so the baselines show what is left.

Never run `eslint --suppress-rule` or `--suppress-all`, and never raise a count by hand. The ratchet compares all three baselines, and every changed file's comment count, with a base commit and fails on any rise. The base is the merge base with `$COMMENT_RATCHET_BASE` (default `origin/staging`). CI sets it to the PR's base branch on pull requests and to the previous tip on pushes, and a clean checkout that sits on the base branch compares with `HEAD^1`. Inline config that switches the rule off (`/* eslint conclave/no-comments: "off" */`, a blanket `eslint-disable`, or a disable that names the rule) fails the ratchet wherever it sits, license header included. A moved file counts as a new file, so delete its comments when you move it.

## 6. Run the gate

```sh
pnpm install --frozen-lockfile && pnpm -C apps/web exec next typegen && pnpm check && pnpm build
swift build --package-path apps/conclave-skip
```

Run the Swift build when the pass touched `apps/conclave-skip`. Commit one area per Conventional Commit, such as `refactor(sfu): delete tautological comments`. In the PR, link the ADRs and issues the pass created.
