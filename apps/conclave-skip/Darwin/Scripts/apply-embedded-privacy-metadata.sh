#!/bin/sh
set -eu

# Copies the checked-in privacy manifests into the embedded Conclave, WebRTC and
# Mediasoup frameworks, then re-signs each framework it touched.
#
# Purpose strings are not written here (SYS-14, S70 14 c and SY12): Darwin/Info.plist
# declares only the keys the app uses and Darwin/InfoPlist.xcstrings localizes them,
# so the catalog is the single source. Never patch purpose strings into the built
# app, framework, bundle or extension plists from this phase.

FRAMEWORKS_DIR="${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH:-${WRAPPER_NAME}/Frameworks}"
MANIFEST_DIR="${SRCROOT}/PrivacyManifests"

if [ ! -d "${FRAMEWORKS_DIR}" ]; then
  exit 0
fi

resign_code_bundle_if_needed() {
  bundle_path="$1"

  if [ "${CODE_SIGNING_ALLOWED:-YES}" = "NO" ] || [ "${CODE_SIGNING_REQUIRED:-NO}" = "NO" ]; then
    return
  fi

  identity="${EXPANDED_CODE_SIGN_IDENTITY:-}"
  if [ -z "${identity}" ] || [ "${identity}" = "-" ]; then
    echo "warning: skipping privacy metadata re-sign for ${bundle_path}; no code signing identity is available"
    return
  fi

  /usr/bin/codesign \
    --force \
    --sign "${identity}" \
    --preserve-metadata=identifier,entitlements,flags \
    --timestamp=none \
    "${bundle_path}"
}

apply_framework_privacy_manifest() {
  framework_name="$1"
  manifest_name="$2"
  framework_path="${FRAMEWORKS_DIR}/${framework_name}"
  manifest_path="${MANIFEST_DIR}/${manifest_name}"

  if [ ! -d "${framework_path}" ] || [ ! -f "${manifest_path}" ]; then
    return
  fi

  cp "${manifest_path}" "${framework_path}/PrivacyInfo.xcprivacy"
  resign_code_bundle_if_needed "${framework_path}"
}

apply_framework_privacy_manifest "Conclave.framework" "ConclaveFramework.xcprivacy"
apply_framework_privacy_manifest "WebRTC.framework" "WebRTCFramework.xcprivacy"
apply_framework_privacy_manifest "Mediasoup.framework" "MediasoupFramework.xcprivacy"
