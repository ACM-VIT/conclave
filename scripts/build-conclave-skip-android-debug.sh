#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CONCLAVE_SKIP_DIR="${ROOT}/apps/conclave-skip"
ANDROID_DIR="${CONCLAVE_SKIP_DIR}/Android"
SKIP_BIN_DIR="${CONCLAVE_SKIP_DIR}/.build/artifacts/skip/skip/skip.artifactbundle/bin"
SKIP_BIN="${SKIP_BIN_DIR}/skip"

if [[ ! -x "${SKIP_BIN}" ]]; then
  echo "Preparing bundled Skip CLI artifact..." >&2
  swift build --package-path "${CONCLAVE_SKIP_DIR}" >/dev/null
fi

if [[ ! -x "${SKIP_BIN}" ]]; then
  echo "Skip CLI artifact not found at ${SKIP_BIN}" >&2
  exit 1
fi

if command -v gradle >/dev/null 2>&1; then
  GRADLE_BIN="$(command -v gradle)"
elif [[ -x /opt/homebrew/bin/gradle ]]; then
  GRADLE_BIN="/opt/homebrew/bin/gradle"
else
  echo "Gradle not found on PATH or at /opt/homebrew/bin/gradle" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  set -- :app:assembleDebug
fi

PATH="${SKIP_BIN_DIR}:${PATH}" "${GRADLE_BIN}" -p "${ANDROID_DIR}" "$@"
