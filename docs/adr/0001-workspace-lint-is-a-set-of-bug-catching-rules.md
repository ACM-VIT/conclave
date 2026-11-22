# 0001. Workspace lint is a set of bug-catching rules

- Status: Accepted
- Date: 2026-11-22

## Context

The TypeScript workspace packages (the SFU, ai, meeting-core, apps-sdk, shared-browser and ui-tokens) share one ESLint config. `apps/web` has its own config that follows the same approach. A broad stylistic preset would flood a codebase this size with noise and bury the findings that matter.

The SFU is a long-lived Node process. A promise that nobody awaits there is a silent failure or an unhandled rejection in production, and neither `tsc` nor a grep can see it.

## Decision

The config is a hand-picked list of rules, each of which catches a bug class or a real smell. Every rule is an error, because the packages are clean on all of them and CI should block regressions. Type-aware async rules (`no-floating-promises`, `no-misused-promises` and friends) run on every package that has a tsconfig. Untrusted network input (express `req.body`, socket payloads, fetched JSON) is narrowed once at the boundary through `packages/sfu/utilities/untrusted.ts` instead of flowing through as `any`.

## Consequences

- Lint output is short and every finding is worth reading.
- A new rule needs the packages to be clean on it first, since there are no warnings.
- `packages/ui-tokens` has no tsconfig, so it only gets the syntax-level rules. An issue tracks adding one.

## Alternatives considered

- **A recommended or stylistic preset:** rejected because it reports thousands of style findings and hides the bug-class rules.
- **Warnings for new rules:** rejected because warnings are ignored and do not gate CI.

## Code

- `eslint.config.mjs`: `baseRules`, `typedRules`
- `packages/sfu/utilities/untrusted.ts`: `asRecord`, `readString`, `readCoercedNumber`
