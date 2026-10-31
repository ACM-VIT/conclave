#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct SYS8ExternalHandoffTests {

    @Test func cameraContinuityFollowsMultitaskingAccessOnIOSAndTheServiceTypeOnAndroid() {
        func continues(cameraOn: Bool = true, multitasking: Bool = false, pip: PipAvailability = .notEligible,
                       serviceCamera: Bool = false) -> Bool {
            CameraContinuityPolicy.continuesInBackground(isCameraOn: cameraOn, multitaskingCameraAccessEnabled: multitasking,
                                                         pip: pip, foregroundServiceHoldsCamera: serviceCamera)
        }

        #expect(continues(multitasking: true, pip: .eligible))
        #expect(continues(multitasking: true, pip: .active))
        #expect(!continues(multitasking: true, pip: .notEligible))
        #expect(!continues(multitasking: true, pip: .unsupported))
        #expect(!continues(multitasking: true, pip: .disabledByUser))
        #expect(!continues(multitasking: false, pip: .eligible))

        #expect(continues(serviceCamera: true))
        #expect(!continues(serviceCamera: false))

        #expect(!continues(cameraOn: false, multitasking: true, pip: .eligible, serviceCamera: true))
    }

    @Test func theCameraLineShowsOnlyWithTheCameraOnAndNoContinuity() {
        #expect(CameraContinuityPolicy.showsCameraLine(isCameraOn: true, cameraContinuesInBackground: false))
        #expect(!CameraContinuityPolicy.showsCameraLine(isCameraOn: true, cameraContinuesInBackground: true))
        #expect(!CameraContinuityPolicy.showsCameraLine(isCameraOn: false, cameraContinuesInBackground: false))
    }

    @Test func everyExternalActivitySuppressesAutoEnterExceptSettings() {
        for kind in ExternalHandoffKind.allCases {
            #expect(ExternalHandoffPolicy.suppressesAutoEnter(kind) == (kind != .systemSettings), "\(kind.rawValue)")
        }

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

    @Test func presenceDerivesCameraContinuityAndCarriesThePipTarget() {
        let presence = CallPresence()
        presence.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .entering, roomLabel: "lily-zoro-iris"))
        presence.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .inCall, roomLabel: "lily-zoro-iris",
                                               isMuted: false, isCameraOff: false, multitaskingCameraAccessEnabled: true))

        presence.reportPictureInPicture(active: false, availability: .notEligible)
        #expect(!presence.snapshot.cameraContinuesInBackground)
        presence.reportPictureInPicture(active: false, availability: .eligible)
        #expect(presence.snapshot.cameraContinuesInBackground)

        let android = CallPresence()
        android.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .entering, roomLabel: "lily-zoro-iris"))
        android.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .inCall, roomLabel: "lily-zoro-iris",
                                              isMuted: false, isCameraOff: false))
        #expect(!android.snapshot.cameraContinuesInBackground)
        android.reportForegroundServiceTypes(microphone: true, camera: true)
        #expect(android.snapshot.cameraContinuesInBackground)

        let target = PipTargetFrame(slotId: "p:r1", left: 0, top: 100, right: 360, bottom: 740, videoWidth: 720, videoHeight: 1280)
        android.reportPipTarget(target)
        #expect(android.snapshot.pipTarget == target)
        let revision = android.snapshot.revision
        android.reportPipTarget(target)
        #expect(android.snapshot.revision == revision)
        android.reportPipTarget(nil)
        #expect(android.snapshot.pipTarget == nil)
    }

    @Test func requestedHandOffHooksAreWired() throws {
        let yml = try sys8Source("Sources/Conclave/Skip/skip.yml")
        #expect(yml.components(separatedBy: "implementation(\"androidx.browser:browser:").count - 1 == 1)
        let manifest = try sys8Source("Android/app/src/main/AndroidManifest.xml")
        #expect(manifest.contains("android.support.customtabs.action.CustomTabsService"))
    }
}

private func sys8PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func sys8Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: sys8PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}
#endif
