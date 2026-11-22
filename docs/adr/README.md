# Architecture decision records

An ADR records one decision the code cannot express: why the code is shaped this way, what we rejected, or an outside constraint (a protocol, browser, vendor or platform rule) the code has to obey. A careful new maintainer who has not read it would get the code wrong.

Conclave keeps no code comments. `conclave/no-comments` and the comment ratchet (`scripts/quality/comments/`) block new ones, so these records are where the reasons live.

## When to write one

Write an ADR when:

- you would otherwise need a comment to stop someone undoing a choice;
- a constraint comes from outside our code, such as a mediasoup, WebRTC, Safari, Android or App Store rule;
- you rejected an alternative that looks obviously better;
- a comment audit classifies a comment as a decision record.

Do not write one for:

- what the code already says through names, types or tests;
- a temporary hack. File an issue with the `comment-excuse` label instead, and fix the hack.

## Numbering and files

- Files are `NNNN-kebab-case-title.md`, numbered from `0001` in the order they are written. `0000-template.md` is the template.
- Numbers are never reused or changed. A replaced decision keeps its file, sets its status to `Superseded by NNNN`, and links to the new record.
- Status is one of `Proposed`, `Accepted`, `Superseded by NNNN` or `Deprecated`.
- One decision per file. Merge related comments into one record by topic, not one record per comment.

## Template

Copy [`0000-template.md`](0000-template.md). It is MADR-lite:

- **Context:** the forces and constraints, with links to specs, bugs or measurements.
- **Decision:** what we do, stated plainly.
- **Consequences:** what gets easier, what gets harder, and what would make us revisit it.
- **Alternatives considered:** each one with the reason we rejected it.
- **Code:** the files and symbols that carry the decision.

## Replacing comments

A comment stops working the moment the code next to it changes. A record works when someone can reach it from the code and reach the code from it.

From the code, without a comment:

- Name the decision in an identifier, such as `ONE_FRAMERATE_PER_SIMULCAST_PROFILE` or `resumeConsumerWithAckRetry`, so the name states the rule.
- Put the decision in a test named after it, such as `test("ADR 0003: an attendee never receives panelist audio tracks", ...)`. The test enforces the decision and `git grep "ADR 0003"` finds it.
- Prefer a type that makes the wrong state unrepresentable over a sentence that warns against it.

From the record, list every file and symbol in its **Code** section and in the index below. Then each of these finds the record:

```sh
grep -rn "packages/sfu/server/rooms.ts" docs/adr
grep -rn "resumeConsumerWithAckRetry" docs/adr
```

When you rename a symbol or move a file named in a record, update the record in the same change.

## Index

Keep this table sorted by number. Code lists the paths and symbols, so a search by file or symbol lands here.

| ADR | Title | Status | Code |
| --- | --- | --- | --- |
