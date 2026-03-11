#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ENV_FILE="${ENV_FILE:-${ROOT}/.env}"
ENV_FILE_MOBILE="${ROOT}/apps/mobile/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

if [[ -f "${ENV_FILE_MOBILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE_MOBILE}"
  set +a
fi

: "${ANDROID_VERSION_NAME:?Missing ANDROID_VERSION_NAME in .env}"
: "${ANDROID_VERSION_CODE:?Missing ANDROID_VERSION_CODE in .env}"
: "${ANDROID_KEYSTORE_PATH:?Missing ANDROID_KEYSTORE_PATH in .env}"
: "${ANDROID_KEYSTORE_ALIAS:?Missing ANDROID_KEYSTORE_ALIAS in .env}"
: "${ANDROID_KEYSTORE_PASSWORD:?Missing ANDROID_KEYSTORE_PASSWORD in .env}"
: "${ANDROID_KEY_PASSWORD:?Missing ANDROID_KEY_PASSWORD in .env}"

VERSION_NAME="${ANDROID_VERSION_NAME}"
VERSION_CODE="${ANDROID_VERSION_CODE}"
BUILD_NUMBER="${IOS_BUILD_NUMBER:-${ANDROID_VERSION_CODE}}"
KEYSTORE_PATH="${ANDROID_KEYSTORE_PATH/#\~/$HOME}"
KEY_ALIAS="${ANDROID_KEYSTORE_ALIAS}"
KEYSTORE_PASSWORD="${ANDROID_KEYSTORE_PASSWORD}"
KEY_PASSWORD="${ANDROID_KEY_PASSWORD}"

APP_JSON="${ROOT}/apps/mobile/app.json"
GRADLE_FILE="${ROOT}/apps/mobile/android/app/build.gradle"
ANDROID_DIR="${ROOT}/apps/mobile/android"
MOBILE_DIR="${ROOT}/apps/mobile"

if [[ ! -f "${KEYSTORE_PATH}" ]]; then
  echo "Keystore not found at ${KEYSTORE_PATH}" >&2
  exit 1
fi

export APP_JSON VERSION_NAME VERSION_CODE BUILD_NUMBER GRADLE_FILE
python3 - <<'PY'
import json
import os

app_json = os.environ["APP_JSON"]
version = os.environ["VERSION_NAME"]
version_code = int(os.environ["VERSION_CODE"])
build_number = os.environ["BUILD_NUMBER"]

with open(app_json, "r", encoding="utf-8") as f:
    data = json.load(f)

data["expo"]["version"] = version
data["expo"]["android"]["versionCode"] = version_code
data["expo"]["ios"]["buildNumber"] = str(build_number)

with open(app_json, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

(cd "${MOBILE_DIR}" && npx expo prebuild --platform android)

python3 - <<'PY'
import os
import re

gradle_file = os.environ["GRADLE_FILE"]
version = os.environ["VERSION_NAME"]
version_code = os.environ["VERSION_CODE"]

with open(gradle_file, "r", encoding="utf-8") as f:
    text = f.read()

text = re.sub(r"versionCode\\s+\\d+", f"versionCode {version_code}", text)
text = re.sub(r'versionName\\s+"[^"]+"', f'versionName "{version}"', text)

with open(gradle_file, "w", encoding="utf-8") as f:
    f.write(text)
PY

(cd "${ANDROID_DIR}" && \
  ./gradlew :app:bundleRelease \
    -PACM_UPLOAD_STORE_FILE="${KEYSTORE_PATH}" \
    -PACM_UPLOAD_STORE_PASSWORD="${KEYSTORE_PASSWORD}" \
    -PACM_UPLOAD_KEY_ALIAS="${KEY_ALIAS}" \
    -PACM_UPLOAD_KEY_PASSWORD="${KEY_PASSWORD}")

AAB_SRC="${ANDROID_DIR}/app/build/outputs/bundle/release/app-release.aab"
AAB_DST="${ROOT}/app-release.aab"

if [[ ! -f "${AAB_SRC}" ]]; then
  echo "AAB not found at ${AAB_SRC}" >&2
  exit 1
fi

cp -f "${AAB_SRC}" "${AAB_DST}"
echo "AAB copied to ${AAB_DST}"
