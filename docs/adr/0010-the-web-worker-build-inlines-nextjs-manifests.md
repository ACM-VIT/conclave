# 0010. The web Worker build inlines every Next.js manifest

- Status: Accepted
- Date: 2026-11-22

## Context

The web app runs on a Cloudflare Worker, which has no filesystem. Next.js reads its build manifests from disk at run time.

## Decision

Every Next.js manifest read is inlined at build time. The test patches the real Next.js manifest loader (`next/dist/server/load-manifest.external.js`), not a hand-written stand-in, so it follows changes in both Next.js and the adapter.

## Consequences

- A Next.js upgrade that adds a manifest read fails the test instead of failing in production.

## Alternatives considered

- **Mocking the loader:** rejected because a mock would not notice a new manifest read.

## Code

- `scripts/cloudflare-manifests.test.mjs`
- `package.json`: `test:cloudflare-manifests`
