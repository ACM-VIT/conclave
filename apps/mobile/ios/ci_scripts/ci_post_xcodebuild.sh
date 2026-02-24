#!/bin/zsh

set -euo pipefail

# Xcode Cloud runs this script after xcodebuild.
# Generate missing dSYMs for prebuilt RN frameworks so symbol upload can succeed.

ARCHIVE_PATH="${CI_ARCHIVE_PATH:-/Volumes/workspace/build.xcarchive}"

if [[ ! -d "${ARCHIVE_PATH}" ]]; then
  echo "Archive not found at ${ARCHIVE_PATH}; skipping dSYM generation."
  exit 0
fi

APP_BUNDLE="$(find "${ARCHIVE_PATH}/Products/Applications" -maxdepth 1 -name '*.app' | head -n 1)"

if [[ -z "${APP_BUNDLE}" || ! -d "${APP_BUNDLE}" ]]; then
  echo "App bundle not found in archive; skipping dSYM generation."
  exit 0
fi

FRAMEWORKS_DIR="${APP_BUNDLE}/Frameworks"
DSYMS_DIR="${ARCHIVE_PATH}/dSYMs"

if [[ ! -d "${FRAMEWORKS_DIR}" ]]; then
  echo "Frameworks directory not found at ${FRAMEWORKS_DIR}; skipping dSYM generation."
  exit 0
fi

mkdir -p "${DSYMS_DIR}"

FRAMEWORKS=(
  "React.framework"
  "ReactNativeDependencies.framework"
  "hermes.framework"
)

for FRAMEWORK in "${FRAMEWORKS[@]}"; do
  BINARY_NAME="${FRAMEWORK%.framework}"
  BINARY_PATH="${FRAMEWORKS_DIR}/${FRAMEWORK}/${BINARY_NAME}"
  DSYM_PATH="${DSYMS_DIR}/${FRAMEWORK}.dSYM"

  if [[ ! -f "${BINARY_PATH}" ]]; then
    echo "Framework binary not found for ${FRAMEWORK}; skipping."
    continue
  fi

  echo "Generating dSYM for ${FRAMEWORK}..."
  if ! xcrun dsymutil "${BINARY_PATH}" -o "${DSYM_PATH}" >/dev/null 2>&1; then
    echo "Failed to create dSYM for ${FRAMEWORK}."
    continue
  fi

  if [[ -d "${DSYM_PATH}" ]]; then
    BINARY_UUIDS="$(xcrun dwarfdump --uuid "${BINARY_PATH}" | awk '{print $2}' | tr '\n' ' ')"
    DSYM_UUIDS="$(xcrun dwarfdump --uuid "${DSYM_PATH}" | awk '{print $2}' | tr '\n' ' ')"
    echo "${FRAMEWORK} binary UUIDs: ${BINARY_UUIDS}"
    echo "${FRAMEWORK} dSYM UUIDs:   ${DSYM_UUIDS}"
  else
    echo "Failed to create dSYM for ${FRAMEWORK}."
  fi
done

echo "Completed framework dSYM generation."
