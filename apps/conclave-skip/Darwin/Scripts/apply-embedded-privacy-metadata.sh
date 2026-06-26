#!/bin/sh
set -eu

FRAMEWORKS_DIR="${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH:-${WRAPPER_NAME}/Frameworks}"
APP_RESOURCES_DIR="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:-${WRAPPER_NAME}}"
MANIFEST_DIR="${SRCROOT}/PrivacyManifests"

if [ ! -d "${FRAMEWORKS_DIR}" ] && [ ! -d "${APP_RESOURCES_DIR}" ]; then
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

set_media_purpose_strings() {
  plist_path="$1"

  set_plist_string "${plist_path}" "NSCameraUsageDescription" "Conclave uses the camera so you can turn on your video in a meeting."
  set_plist_string "${plist_path}" "NSMicrophoneUsageDescription" "Conclave uses the microphone so you can be heard in a meeting."
  set_plist_string "${plist_path}" "NSLocalNetworkUsageDescription" "Conclave uses the local network to connect meeting audio and video to other people, for faster and more reliable meetings."
}

set_file_purpose_strings() {
  plist_path="$1"

  set_plist_string "${plist_path}" "NSDocumentsFolderUsageDescription" "Conclave accesses files in Documents only when you choose a file to share or attach in a meeting."
  set_plist_string "${plist_path}" "NSDownloadsFolderUsageDescription" "Conclave accesses files in Downloads only when you choose a file to share or attach in a meeting."
  set_plist_string "${plist_path}" "NSDesktopFolderUsageDescription" "Conclave accesses files on the Desktop only when you choose a file to share or attach in a meeting."
  set_plist_string "${plist_path}" "NSNetworkVolumesUsageDescription" "Conclave accesses network volumes only when you choose a file from one to share or attach in a meeting."
  set_plist_string "${plist_path}" "NSRemovableVolumesUsageDescription" "Conclave accesses removable volumes only when you choose a file from one to share or attach in a meeting."
}

set_temporary_location_purpose_string() {
  plist_path="$1"

  /usr/libexec/PlistBuddy -c "Add :NSLocationTemporaryUsageDescriptionDictionary dict" "${plist_path}" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Set :NSLocationTemporaryUsageDescriptionDictionary:MeetingLocationSharing Conclave uses precise location only when you explicitly choose to share your current location in a meeting." "${plist_path}" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Add :NSLocationTemporaryUsageDescriptionDictionary:MeetingLocationSharing string Conclave uses precise location only when you explicitly choose to share your current location in a meeting." "${plist_path}"
}

set_extended_purpose_strings() {
  plist_path="$1"

  set_plist_string "${plist_path}" "NSBluetoothAlwaysUsageDescription" "Conclave uses Bluetooth so you can route meeting audio through supported headphones and speakers."
  set_plist_string "${plist_path}" "NSBluetoothPeripheralUsageDescription" "Conclave uses Bluetooth so you can route meeting audio through supported headphones and speakers."
  set_plist_string "${plist_path}" "NSScreenCaptureUsageDescription" "Conclave uses screen capture so you can share your screen in a meeting."
  set_plist_string "${plist_path}" "NSPhotoLibraryUsageDescription" "Conclave uses photo library access only when you choose an image from your library."
  set_plist_string "${plist_path}" "NSPhotoLibraryAddUsageDescription" "Conclave saves images to your photo library only when you choose to save them."
  set_plist_string "${plist_path}" "NSLocationWhenInUseUsageDescription" "Conclave uses your location only when you explicitly choose to share it."
  set_plist_string "${plist_path}" "NSLocationAlwaysAndWhenInUseUsageDescription" "Conclave uses background location only while a location-sharing action you started remains active."
  set_plist_string "${plist_path}" "NSLocationAlwaysUsageDescription" "Conclave uses background location only while a location-sharing action you started remains active."
  set_plist_string "${plist_path}" "NSLocationUsageDescription" "Conclave uses your location only when you explicitly choose to share it."
  set_plist_string "${plist_path}" "NSFaceIDUsageDescription" "Conclave uses Face ID only when you choose biometric verification for account access."
  set_plist_string "${plist_path}" "NSContactsUsageDescription" "Conclave uses contacts only when you choose to select someone to invite to a meeting."
  set_plist_string "${plist_path}" "NSCalendarsUsageDescription" "Conclave uses calendar access only when you choose to create or view meeting calendar events."
  set_plist_string "${plist_path}" "NSCalendarsFullAccessUsageDescription" "Conclave uses calendar access only when you choose to create or view meeting calendar events."
  set_plist_string "${plist_path}" "NSCalendarsWriteOnlyAccessUsageDescription" "Conclave can add meeting events to your calendar only when you choose to save them."
  set_plist_string "${plist_path}" "NSRemindersUsageDescription" "Conclave uses reminders only when you choose to create a meeting reminder."
  set_plist_string "${plist_path}" "NSRemindersFullAccessUsageDescription" "Conclave uses reminders only when you choose to create a meeting reminder."
  set_plist_string "${plist_path}" "NSSpeechRecognitionUsageDescription" "Conclave uses speech recognition only when you choose a meeting voice feature such as transcription."
  set_plist_string "${plist_path}" "NSSiriUsageDescription" "Conclave uses Siri only when you choose a voice shortcut or Siri action for Conclave."
  set_plist_string "${plist_path}" "NSFocusStatusUsageDescription" "Conclave uses Focus status only to respect notification and call availability settings you enable."
  set_plist_string "${plist_path}" "NSMotionUsageDescription" "Conclave uses device motion only when needed to keep meeting video oriented correctly."
  set_plist_string "${plist_path}" "NSSensorKitUsageDescription" "Conclave uses sensor data only when you explicitly choose a sensor-based meeting feature."
  set_plist_string "${plist_path}" "NSUserTrackingUsageDescription" "Conclave does not track you across apps or websites."
  set_plist_string "${plist_path}" "NSUserNotificationsUsageDescription" "Conclave sends notifications for meeting calls, reminders, and updates you enable."
  set_plist_string "${plist_path}" "NFCReaderUsageDescription" "Conclave uses NFC only when you choose an NFC-based join or sharing action."
  set_plist_string "${plist_path}" "NSAppleMusicUsageDescription" "Conclave uses media library access only when you choose media to share in a meeting."
  set_plist_string "${plist_path}" "NSNearbyInteractionUsageDescription" "Conclave uses nearby interaction only when you choose a nearby-device meeting action."
  set_plist_string "${plist_path}" "NSVideoSubscriberAccountUsageDescription" "Conclave uses video subscriber account access only when you choose an account-based video feature."
  set_plist_string "${plist_path}" "NSHomeKitUsageDescription" "Conclave uses HomeKit only when you choose a home-device meeting action."
  set_plist_string "${plist_path}" "NSGKFriendListUsageDescription" "Conclave uses Game Center friends only when you choose to invite them to a meeting."
  set_plist_string "${plist_path}" "NSHealthShareUsageDescription" "Conclave uses health data only when you explicitly choose a health-sharing action."
  set_plist_string "${plist_path}" "NSHealthClinicalHealthRecordsShareUsageDescription" "Conclave uses clinical health records only when you explicitly choose a health-record sharing action."
  set_plist_string "${plist_path}" "NSHealthUpdateUsageDescription" "Conclave updates health data only when you explicitly choose a health-sharing action."
  set_temporary_location_purpose_string "${plist_path}"
}

set_all_purpose_strings() {
  plist_path="$1"

  set_media_purpose_strings "${plist_path}"
  set_extended_purpose_strings "${plist_path}"
  set_file_purpose_strings "${plist_path}"
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

  set_all_purpose_strings "${plist_path}"

  copy_privacy_manifest "ConclaveFramework.xcprivacy" "${framework_path}"
  resign_framework_if_needed "${framework_path}"
}

patch_webrtc_framework() {
  framework_path="${FRAMEWORKS_DIR}/WebRTC.framework"
  plist_path="${framework_path}/Info.plist"

  if [ ! -f "${plist_path}" ]; then
    return
  fi

  set_all_purpose_strings "${plist_path}"

  copy_privacy_manifest "WebRTCFramework.xcprivacy" "${framework_path}"
  resign_framework_if_needed "${framework_path}"
}

patch_mediasoup_framework() {
  framework_path="${FRAMEWORKS_DIR}/Mediasoup.framework"
  plist_path="${framework_path}/Info.plist"

  if [ ! -f "${plist_path}" ]; then
    return
  fi

  set_all_purpose_strings "${plist_path}"

  copy_privacy_manifest "MediasoupFramework.xcprivacy" "${framework_path}"
  resign_framework_if_needed "${framework_path}"
}

patch_remaining_frameworks() {
  for framework_path in "${FRAMEWORKS_DIR}"/*.framework; do
    if [ ! -d "${framework_path}" ]; then
      continue
    fi

    framework_name="$(basename "${framework_path}")"
    case "${framework_name}" in
      Conclave.framework|WebRTC.framework|Mediasoup.framework)
        continue
        ;;
    esac

    plist_path="${framework_path}/Info.plist"
    if [ ! -f "${plist_path}" ]; then
      continue
    fi

    set_all_purpose_strings "${plist_path}"
    resign_framework_if_needed "${framework_path}"
  done
}

patch_embedded_bundles() {
  if [ ! -d "${APP_RESOURCES_DIR}" ]; then
    return
  fi

  find "${APP_RESOURCES_DIR}" \
    -path "${FRAMEWORKS_DIR}/*" -prune -o \
    -path "${APP_RESOURCES_DIR}/PlugIns/*" -prune -o \
    -path "*.bundle/Info.plist" -print |
    while IFS= read -r plist_path; do
      set_all_purpose_strings "${plist_path}"
    done
}

patch_conclave_framework
patch_webrtc_framework
patch_mediasoup_framework
patch_remaining_frameworks
patch_embedded_bundles
