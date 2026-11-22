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

`gh pr diff --name-only` lists every file. `gh pr list --json files` stops at 100 files per PR.

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

Drop every record whose `file` is in `/tmp/open-pr-files.txt`, and every record with a non-null `allowed`.

## 3. Classify each comment

Read the code around every comment, and the symbols it names, before you judge it. Give each comment exactly one category:

- **Tautology:** it repeats what the code already shows, through names, types or the next line.
- **Excuse:** it justifies or apologises for a hacky, temporary or "for now" implementation. Workarounds, TODOs, FIXMEs, "too risky to change", "hack", "temporary", "we should" and "until X" belong here, as do suppressions that silence a real bug-catching lint or type rule. The hack needs a real fix.
- **Stale:** it describes code, behavior, files or decisions that no longer match the code. Check it against the current code.
- **Decision record:** it documents an important, non-obvious decision. That means why the code is this way, what was rejected, or an outside constraint (protocol, browser, vendor or platform) the code can't express. Ask whether a careful new maintainer would get the code wrong without it. A long explanation of our own code's behavior that a rename or a type could carry is a Tautology or an Excuse.
- **Keep tooling:** a directive a tool reads. This means `eslint-disable` with a ` -- reason` for a style-only rule, `@ts-expect-error` with a description for a third-party type bug, `prettier-ignore`, `/// <reference>`, `@vitest-environment`, `#!` shebangs, `sourceMappingURL`, and `// swift-tools-version`. Swift `MARK:` is a Tautology unless a tool depends on it.
- **Keep license:** a legal, license or attribution notice at the top of a file.

Be honest: most comments are tautologies. When in doubt between a decision record and a tautology, ask the maintainer question again.

Some files say GENERATED or "do not edit". Fix their comments in the generator, regenerate, and run that generator's `--check` script. Hashes the build depends on are Keep tooling.

## 4. Act on each category

- **Tautology, Stale:** delete it, with the blank lines it leaves behind. When a name was the reason for the comment, rename the symbol instead.
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
pnpm comments:prune
```

This runs `eslint --prune-suppressions` at the root and in `apps/web`, then `ratchet.mjs --update`. Both only lower counts.

ESLint fails when a file has fewer comments than its suppression, so every TS/JS deletion needs the prune in the same change. The ratchet passes on a lower count and prints a reminder to update.

Never run `eslint --suppress-rule` or `--suppress-all`, and never raise a count by hand. The ratchet compares all three baselines with the merge base of `origin/staging` (or `$COMMENT_RATCHET_BASE`) and fails on any rise. A moved file counts as a new file, so delete its comments when you move it.

## 6. Run the gate

```sh
pnpm install --frozen-lockfile && pnpm -C apps/web exec next typegen && pnpm check && pnpm build
swift build --package-path apps/conclave-skip
```

Run the Swift build when the pass touched `apps/conclave-skip`. Commit one area per Conventional Commit, such as `refactor(sfu): delete tautological comments`. In the PR, link the ADRs and issues the pass created.
