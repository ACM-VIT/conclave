#!/bin/sh
set -eu

FRAMEWORKS_DIR="${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH:-${WRAPPER_NAME}/Frameworks}"
MANIFEST_DIR="${SRCROOT}/PrivacyManifests"

if [ ! -d "${FRAMEWORKS_DIR}" ]; then
  exit 0
fi

set_plist_string() {
  plist_path="$1"
  key="$2"
  value="$3"

  /usr/libexec/PlistBuddy -c "Set :${key} ${value}" "${plist_path}" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Add :${key} string ${value}" "${plist_path}"
}

copy_privacy_manifest() {
  manifest_name="$1"
  framework_path="$2"
  manifest_path="${MANIFEST_DIR}/${manifest_name}"

  if [ -f "${manifest_path}" ]; then
    cp "${manifest_path}" "${framework_path}/PrivacyInfo.xcprivacy"
  fi
}

resign_framework_if_needed() {
  framework_path="$1"

  if [ "${CODE_SIGNING_ALLOWED:-YES}" = "NO" ] || [ "${CODE_SIGNING_REQUIRED:-NO}" = "NO" ]; then
    return
  fi

  identity="${EXPANDED_CODE_SIGN_IDENTITY:-}"
  if [ -z "${identity}" ] || [ "${identity}" = "-" ]; then
    echo "warning: skipping privacy metadata re-sign for ${framework_path}; no code signing identity is available"
    return
  fi

  /usr/bin/codesign \
    --force \
    --sign "${identity}" \
    --preserve-metadata=identifier,entitlements,flags \
    --timestamp=none \
    "${framework_path}"
}

patch_conclave_framework() {
  framework_path="${FRAMEWORKS_DIR}/Conclave.framework"
  plist_path="${framework_path}/Info.plist"

  if [ ! -f "${plist_path}" ]; then
    return
  fi

  set_plist_string "${plist_path}" "NSCameraUsageDescription" "Conclave uses the camera so you can turn on your video in a meeting."
  set_plist_string "${plist_path}" "NSMicrophoneUsageDescription" "Conclave uses the microphone so you can be heard in a meeting."
  set_plist_string "${plist_path}" "NSBluetoothAlwaysUsageDescription" "Conclave uses Bluetooth so you can route meeting audio through supported headphones and speakers."
  set_plist_string "${plist_path}" "NSBluetoothPeripheralUsageDescription" "Conclave uses Bluetooth so you can route meeting audio through supported headphones and speakers."
  set_plist_string "${plist_path}" "NSLocalNetworkUsageDescription" "Conclave uses the local network to connect meeting audio and video to other people, for faster and more reliable meetings."
  set_plist_string "${plist_path}" "NSScreenCaptureUsageDescription" "Conclave uses screen capture so you can share your screen in a meeting."
  set_plist_string "${plist_path}" "NSPhotoLibraryUsageDescription" "Conclave uses photo library access only when you choose an image from your library."
  set_plist_string "${plist_path}" "NSPhotoLibraryAddUsageDescription" "Conclave saves images to your photo library only when you choose to save them."
  set_plist_string "${plist_path}" "NSLocationWhenInUseUsageDescription" "Conclave uses your location only when you explicitly choose to share it."
  set_plist_string "${plist_path}" "NSLocationAlwaysAndWhenInUseUsageDescription" "Conclave uses background location only while a location-sharing action you started remains active."
  set_plist_string "${plist_path}" "NSLocationAlwaysUsageDescription" "Conclave uses background location only while a location-sharing action you started remains active."
  set_plist_string "${plist_path}" "NSFaceIDUsageDescription" "Conclave uses Face ID only when you choose biometric verification for account access."

  copy_privacy_manifest "ConclaveFramework.xcprivacy" "${framework_path}"
  resign_framework_if_needed "${framework_path}"
}

patch_webrtc_framework() {
  framework_path="${FRAMEWORKS_DIR}/WebRTC.framework"
  plist_path="${framework_path}/Info.plist"

  if [ ! -f "${plist_path}" ]; then
    return
  fi

  set_plist_string "${plist_path}" "NSCameraUsageDescription" "Conclave uses the camera so you can turn on your video in a meeting."
  set_plist_string "${plist_path}" "NSMicrophoneUsageDescription" "Conclave uses the microphone so you can be heard in a meeting."
  set_plist_string "${plist_path}" "NSLocalNetworkUsageDescription" "Conclave uses the local network to connect meeting audio and video to other people, for faster and more reliable meetings."

  copy_privacy_manifest "WebRTCFramework.xcprivacy" "${framework_path}"
  resign_framework_if_needed "${framework_path}"
}

patch_mediasoup_framework() {
  framework_path="${FRAMEWORKS_DIR}/Mediasoup.framework"
  plist_path="${framework_path}/Info.plist"

  if [ ! -f "${plist_path}" ]; then
    return
  fi

  set_plist_string "${plist_path}" "NSCameraUsageDescription" "Conclave uses the camera so you can turn on your video in a meeting."
  set_plist_string "${plist_path}" "NSMicrophoneUsageDescription" "Conclave uses the microphone so you can be heard in a meeting."
  set_plist_string "${plist_path}" "NSLocalNetworkUsageDescription" "Conclave uses the local network to connect meeting audio and video to other people, for faster and more reliable meetings."

  resign_framework_if_needed "${framework_path}"
}

patch_conclave_framework
patch_webrtc_framework
patch_mediasoup_framework
