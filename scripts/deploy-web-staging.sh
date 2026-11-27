#!/usr/bin/env bash
# Builds apps/web from the staging branch and deploys it to the
# conclave-web-staging Worker (staging.conclave.acmvit.in). Production is the
# top-level wrangler config and is never touched here. Runbook:
# docs/ops/staging.md.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "staging" && "${STAGING_ALLOW_ANY_BRANCH:-}" != "1" ]]; then
  echo "Staging deploys come from the staging branch (this checkout is on ${branch})." >&2
  echo "Set STAGING_ALLOW_ANY_BRANCH=1 to deploy this branch to staging anyway." >&2
  exit 1
fi
if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
  echo "The checkout has uncommitted changes; commit or stash them first." >&2
  exit 1
fi

# NEXT_PUBLIC_* values are compiled into the client bundle, so they are set
# for the build as well as in the Worker vars.
export NEXT_PUBLIC_APP_URL="https://staging.conclave.acmvit.in"
export NEXT_PUBLIC_SITE_URL="https://staging.conclave.acmvit.in"

cd "${ROOT_DIR}/apps/web"
echo "Building $(git rev-parse --short HEAD) for staging..."
pnpm exec opennextjs-cloudflare build --config wrangler.jsonc --env staging
node scripts/prune-open-next-og.mjs
pnpm exec wrangler deploy --config wrangler.jsonc --env staging "$@"
