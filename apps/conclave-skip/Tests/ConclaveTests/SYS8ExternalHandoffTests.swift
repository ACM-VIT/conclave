#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// SYS-8 (OUT/PLAN-screens.md section 5; S70 8; RECONCILE R25; S40 Q16; S30 0.8 CC15): leaving Conclave mid-call.
/// `cameraContinuesInBackground` (S70 8 l1 truth table) and the camera line it drives, the hand-off suppression table
/// (every external activity except Settings), the link routing by scheme, and source scans of the Android launcher.
/// The Robolectric half (suppression count and reason, Settings never suppresses) is in T/Skip/SYS4PipBridgeTests.kt.
/// Not run in the heads-down push.
@MainActor
struct SYS8ExternalHandoffTests {
    // MARK: S70 8 l1

    @Test func cameraContinuityFollowsMultitaskingAccessOnIOSAndTheServiceTypeOnAndroid() {
        func continues(cameraOn: Bool = true, multitasking: Bool = false, pip: PipAvailability = .notEligible,
                       serviceCamera: Bool = false) -> Bool {
            CameraContinuityPolicy.continuesInBackground(isCameraOn: cameraOn, multitaskingCameraAccessEnabled: multitasking,
                                                         pip: pip, foregroundServiceHoldsCamera: serviceCamera)
        }
        // iOS: multitasking camera access AND PiP eligible (or showing).
        #expect(continues(multitasking: true, pip: .eligible))
        #expect(continues(multitasking: true, pip: .active))
        #expect(!continues(multitasking: true, pip: .notEligible))
        #expect(!continues(multitasking: true, pip: .unsupported))
        #expect(!continues(multitasking: true, pip: .disabledByUser))
        #expect(!continues(multitasking: false, pip: .eligible))
        // Android: the call service holds the camera type (held or refused).
        #expect(continues(serviceCamera: true))
        #expect(!continues(serviceCamera: false))
        // Camera off: never (an attendee has no camera).
        #expect(!continues(cameraOn: false, multitasking: true, pip: .eligible, serviceCamera: true))
    }

    @Test func theCameraLineShowsOnlyWithTheCameraOnAndNoContinuity() {
        #expect(CameraContinuityPolicy.showsCameraLine(isCameraOn: true, cameraContinuesInBackground: false))
        #expect(!CameraContinuityPolicy.showsCameraLine(isCameraOn: true, cameraContinuesInBackground: true))
        #expect(!CameraContinuityPolicy.showsCameraLine(isCameraOn: false, cameraContinuesInBackground: false))
    }

    // MARK: S70 8 d and the slice rule

    @Test func everyExternalActivitySuppressesAutoEnterExceptSettings() {
        for kind in ExternalHandoffKind.allCases {
            #expect(ExternalHandoffPolicy.suppressesAutoEnter(kind) == (kind != .systemSettings), "\(kind.rawValue)")
        }
        // The legacy reasons stay (CE E12); the new hand-offs get their own.
        #expect(ExternalHandoffPolicy.reason(.webLink) == "chat_link")
        #expect(ExternalHandoffPolicy.reason(.meetingShare) == "meeting_share")
        #expect(ExternalHandoffPolicy.reason(.transcriptShare) == "transcript_share")
        #expect(ExternalHandoffPolicy.reason(.photoPicker) == "photo_picker")
        #expect(ExternalHandoffPolicy.reason(.mediaProjectionConsent) == "media_projection")
        #expect(ExternalHandoffPolicy.reason(.permissionDialog) == "permission")
        #expect(ExternalHandoffPolicy.reason(.otherApp) == "external_app")
        #expect(ExternalHandoffPolicy.readout(count: 0, lastReason: "") == "0 none")
        #expect(ExternalHandoffPolicy.readout(count: 2, lastReason: "chat_link") == "2 chat_link")
    }

    @Test func webLinksUseCustomTabsAndOtherSchemesTheirOwnApp() {
        #expect(ExternalHandoffPolicy.kind(url: "https://example.com/a") == .webLink)
        #expect(ExternalHandoffPolicy.kind(url: "HTTP://example.com") == .webLink)
        #expect(ExternalHandoffPolicy.kind(url: "mailto:avery@example.com") == .otherApp)
        #expect(ExternalHandoffPolicy.kind(url: "tel:+15550100") == .otherApp)
        #expect(ExternalHandoffPolicy.kind(url: "spotify:track:1") == .otherApp)
    }

    // MARK: CallPresence (HD request B5-T4 R1: CallPresenceSync reads the policy and stores the target)

    @Test func presenceDerivesCameraContinuityAndCarriesThePipTarget() {
        let presence = CallPresence()
        presence.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .entering, roomLabel: "lily-zoro-iris"))
        presence.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .inCall, roomLabel: "lily-zoro-iris",
                                               isMuted: false, isCameraOff: false, multitaskingCameraAccessEnabled: true))
        // iOS without a PiP window: multitasking access alone does not keep the camera.
        presence.reportPictureInPicture(active: false, availability: .notEligible)
        #expect(!presence.snapshot.cameraContinuesInBackground)
        presence.reportPictureInPicture(active: false, availability: .eligible)
        #expect(presence.snapshot.cameraContinuesInBackground)
        // Android: the camera service type alone.
        let android = CallPresence()
        android.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .entering, roomLabel: "lily-zoro-iris"))
        android.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .inCall, roomLabel: "lily-zoro-iris",
                                              isMuted: false, isCameraOff: false))
        #expect(!android.snapshot.cameraContinuesInBackground)
        android.reportForegroundServiceTypes(microphone: true, camera: true)
        #expect(android.snapshot.cameraContinuesInBackground)
        // The stage's PiP target reaches the snapshot once; an equal report changes nothing.
        let target = PipTargetFrame(slotId: "p:r1", left: 0, top: 100, right: 360, bottom: 740, videoWidth: 720, videoHeight: 1280)
        android.reportPipTarget(target)
        #expect(android.snapshot.pipTarget == target)
        let revision = android.snapshot.revision
        android.reportPipTarget(target)
        #expect(android.snapshot.revision == revision)
        android.reportPipTarget(nil)
        #expect(android.snapshot.pipTarget == nil)
    }

    // MARK: Source scans

    @Test func theAndroidHandOffsSuppressAndRestore() throws {
        let share = try sys8Source("Sources/Conclave/Skip/NativeMeetingShare.kt")
        #expect(share.contains("PipManager.suppressNextAutoEnter(\"meeting_share\")"))
        #expect(share.contains("PipManager.suppressNextAutoEnter(\"transcript_share\")"))
        #expect(share.components(separatedBy: "putExtra(Intent.EXTRA_TITLE, title)").count - 1 == 2)
        #expect(share.contains("conclaveStringOf(context, \"ds_share_subject\")"))
        #expect(!share.contains("EXTRA_IS_SENSITIVE"))
        #expect(share.contains("object NativeExternalHandoff {"))
        #expect(share.contains("CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, uri)"))
        #expect(share.contains("PipManager.suppressForExternalHandoff(ExternalHandoffKind.webLink)"))
        #expect(share.contains("fun openSettings(intent: Intent): Boolean = start(intent, ExternalHandoffKind.systemSettings)"))
        #expect(share.contains("\"tel\" -> Intent.ACTION_DIAL"))
        #expect(share.contains("\"mailto\" -> Intent.ACTION_SENDTO"))
        #expect(share.components(separatedBy: "PipManager.restoreAutoEnterAfterExternalActivity()").count - 1 >= 4)
        let manager = try sys8Source("Sources/Conclave/Skip/PipManager.kt")
        #expect(manager.contains("if (!ExternalHandoffPolicy.suppressesAutoEnter(kind)) return"))
        #expect(manager.contains("PipController.recordSuppression(reason)"))
        let controller = try sys8Source("Sources/Conclave/Skip/PipController.kt")
        #expect(controller.contains("ExternalHandoffPolicy.readout(count = suppressionCount, lastReason = lastSuppressionReason)"))
    }

    /// The hooks HD/requests/B5-T4.md asks other owners for (skip.yml, manifest, capture, permissions, chat links).
    /// Fails until the batch 5 integrator applies them.
    @Test func requestedHandOffHooksAreWired() throws {
        let yml = try sys8Source("Sources/Conclave/Skip/skip.yml")
        #expect(yml.components(separatedBy: "implementation(\"androidx.browser:browser:").count - 1 == 1)
        let manifest = try sys8Source("Android/app/src/main/AndroidManifest.xml")
        #expect(manifest.contains("android.support.customtabs.action.CustomTabsService"))
        let capture = try sys8Source("Sources/Conclave/Skip/ScreenCaptureManager.kt")
        #expect(capture.contains("PipManager.suppressForExternalHandoff(ExternalHandoffKind.mediaProjectionConsent)"))
        let permissions = try sys8Source("Sources/Conclave/Skip/PermissionHelper.kt")
        #expect(permissions.contains("PipManager.suppressForExternalHandoff(ExternalHandoffKind.permissionDialog)"))
        // http and https: Custom Tabs with the chat_link suppression (B5-T6's ChatLinkLauncher or NativeExternalHandoff).
        let snapshots = try sys8Source("Sources/Conclave/Skip/ui/chat/ChatSnapshots.kt")
        #expect(snapshots.contains("PipManager.suppressNextAutoEnter(\"chat_link\")") || snapshots.contains("NativeExternalHandoff.openWebLink("))
        // Other apps after the confirmation, and the camera line from the presenter input (R25, R70-5).
        let chat = try sys8Source("Sources/Conclave/Skip/ui/chat/ChatPanel.kt")
        #expect(chat.contains("NativeExternalHandoff.openExternalApp("))
        #expect(chat.contains("actions.presenter.showsCameraLine"))
        let iosChat = try sys8Source("Sources/Conclave/Features/Meeting/Chat/ChatPanel+iOS.swift")
        #expect(iosChat.contains("actions.chat.showsCameraLine"))
        let notices = try sys8Source("Sources/Conclave/Skip/ui/call/stage/NoticeLanes.kt")
        #expect(!notices.contains("suppressNextAutoEnter(\"notice_settings\")"), "Settings never suppresses")
    }
}

private func sys8PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func sys8Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: sys8PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}
#endif
