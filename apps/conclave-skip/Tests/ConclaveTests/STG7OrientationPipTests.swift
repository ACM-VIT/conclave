#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct STG7OrientationPipTests {
    static func person(_ id: String, local: Bool = false, cameraOn: Bool = true, serial: Int, sharing: Bool = false) -> StageParticipantInput {
        StageParticipantInput.make(userId: id, displayName: id, isLocal: local, isMuted: false, isCameraOff: !cameraOn,
                                   isScreenSharing: sharing, joinSerial: serial, videoKey: cameraOn ? "probe:" + id : "",
                                   shareVideoKey: sharing ? "probe:share:" + id : "")
    }

    static func layout(pinned: String = "", featured: String = "") -> StageLayoutSnapshot {
        StageLayoutSnapshot(revision: 1, kind: StageKind.grid, slots: [], overflowCount: 0, overflowSeeds: [], capacity: StageCapacity.zero,
                            pinnedUserId: pinned, featuredUserId: featured, presenterUserId: "", isLocalPresenting: false,
                            selfMode: "auto", selfCorner: "bottom-right", activityKind: "", hiddenActivityKind: "",
                            showsVideoOverActivity: false, isAloneConfirmed: false, meetingLink: "")
    }

    static func inputs(_ people: [StageParticipantInput], share: String = "", localSharing: Bool = false, pinned: String = "",
                       attendee: Bool = false, webinarSpeaker: String = "") -> StageInputs {
        StageInputs.make(callSession: 1, isInCall: true, localUserId: "you", participants: people, pinnedUserId: pinned,
                         screenShareUserId: share, isLocalScreenSharing: localSharing, isWebinarAttendee: attendee,
                         webinarSpeakerUserId: webinarSpeaker)
    }

    static let roster = [person("you", local: true, serial: 0), person("r1", cameraOn: false, serial: 1),
                         person("r2", serial: 2), person("r3", serial: 3)]

    @Test func pipTargetFollowsTheContentOrderAndNeverPicksYou() {

        let sharing = [Self.person("you", local: true, serial: 0), Self.person("r1", serial: 1, sharing: true), Self.person("r2", serial: 2)]
        let share = PipTargetPolicy.choose(inputs: Self.inputs(sharing, share: "r1", pinned: "r2"), layout: Self.layout(pinned: "r2"))
        #expect(share == PipTargetChoice(slotId: "share:r1", userId: "r1", isShare: true))

        let pinned = PipTargetPolicy.choose(inputs: Self.inputs(Self.roster, pinned: "r1"), layout: Self.layout(pinned: "r1", featured: "r3"))
        #expect(pinned == PipTargetChoice(slotId: "p:r1", userId: "r1", isShare: false))

        let featured = PipTargetPolicy.choose(inputs: Self.inputs(Self.roster), layout: Self.layout(featured: "r3"))
        #expect(featured.userId == "r3")
        let featuredCameraOff = PipTargetPolicy.choose(inputs: Self.inputs(Self.roster), layout: Self.layout(featured: "r1"))

        #expect(featuredCameraOff.userId == "r2")

        let cameraless = [Self.person("you", local: true, serial: 0), Self.person("r2", cameraOn: false, serial: 2), Self.person("r1", cameraOn: false, serial: 1)]
        #expect(PipTargetPolicy.choose(inputs: Self.inputs(cameraless), layout: Self.layout()).userId == "r1")

        let mine = PipTargetPolicy.choose(inputs: Self.inputs(Self.roster, share: "you", localSharing: true, pinned: "you"),
                                          layout: Self.layout(pinned: "you", featured: "you"))
        #expect(mine.userId == "r2" && !mine.isShare)
        let alone = PipTargetPolicy.choose(inputs: Self.inputs([Self.person("you", local: true, serial: 0)]), layout: Self.layout())
        #expect(alone == PipTargetChoice.none && alone.isEmpty)

        let leaving = [Self.person("you", local: true, serial: 0),
                       StageParticipantInput.make(userId: "r1", isCameraOff: false, isLeaving: true, joinSerial: 1, videoKey: "probe:r1"),
                       Self.person("r2", cameraOn: false, serial: 2)]
        #expect(PipTargetPolicy.choose(inputs: Self.inputs(leaving), layout: Self.layout()).userId == "r2")

        let attendee = PipTargetPolicy.choose(inputs: Self.inputs(Self.roster, attendee: true, webinarSpeaker: "r3"), layout: Self.layout())
        #expect(attendee.userId == "r3")
    }

    @Test func presenterLayoutFeedsThePolicyAtTheWorkedSize() {

        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.setViewport(StageViewport(width: 390, height: 844, insetTop: 103, insetBottom: 98, insetLeading: 0, insetTrailing: 0,
                                        widthClass: StageSizeClass.compact, heightClass: StageSizeClass.regular, placement: .bottomBar))
        stage.apply(Self.inputs(Self.roster))
        let choice = PipTargetPolicy.choose(inputs: stage.inputs, layout: stage.layout)
        #expect(!choice.isEmpty && choice.userId != "you")
        #expect(stage.layout.slot(id: choice.slotId) != nil)
    }

    @Test func frameConvertsCanvasUnitsMirrorsRightToLeftAndCarriesTheDecodedSize() {
        let frames = [StageFrame(slotId: "p:r2", x: 10, y: 20, width: 100, height: 50)]
        let choice = PipTargetChoice(slotId: "p:r2", userId: "r2", isShare: false)
        let size = RendererFrameSize(width: 720, height: 1280)

        let ltr = PipTargetPolicy.frame(choice: choice, frames: frames, canvasWidth: 400, originX: 0, originY: 0, scale: 1,
                                        isRightToLeft: false, frameSize: size)
        #expect(ltr == PipTargetFrame(slotId: "p:r2", left: 10, top: 20, right: 110, bottom: 70, videoWidth: 720, videoHeight: 1280))

        let rtl = PipTargetPolicy.frame(choice: choice, frames: frames, canvasWidth: 400, originX: 0, originY: 0, scale: 1,
                                        isRightToLeft: true, frameSize: size)
        #expect(rtl?.left == 290 && rtl?.right == 390)

        let px = PipTargetPolicy.frame(choice: choice, frames: frames, canvasWidth: 400, originX: 0, originY: 24, scale: 2.5,
                                       isRightToLeft: false, frameSize: RendererFrameSize.zero)
        #expect(px == PipTargetFrame(slotId: "p:r2", left: 25, top: 74, right: 275, bottom: 199, videoWidth: 0, videoHeight: 0))

        let hidden = PipTargetPolicy.frame(choice: PipTargetChoice(slotId: "p:r9", userId: "r9", isShare: false), frames: frames,
                                           canvasWidth: 400, originX: 0, originY: 0, scale: 1, isRightToLeft: false, frameSize: size)
        #expect(hidden == PipTargetFrame(slotId: "p:r9", left: 0, top: 0, right: 0, bottom: 0, videoWidth: 720, videoHeight: 1280))
        #expect(PipTargetPolicy.frame(choice: PipTargetChoice.none, frames: frames, canvasWidth: 400, originX: 0, originY: 0, scale: 1,
                                      isRightToLeft: false, frameSize: size) == nil)
    }

    @Test func aFrameSizeChangeRepublishesOnceAndAnEqualOneNever() {
        let store = RendererFrameSizeStore()
        #expect(store.revision == 0 && store.size(slotId: "p:r1") == RendererFrameSize.zero)
        #expect(store.report(slotId: "p:r1", width: 1280, height: 720))
        #expect(store.revision == 1 && store.size(slotId: "p:r1") == RendererFrameSize(width: 1280, height: 720))

        #expect(!store.report(slotId: "p:r1", width: 1280, height: 720))
        #expect(store.revision == 1 && store.reportCount == 1)

        #expect(store.report(slotId: "p:r1", width: 720, height: 1280))
        #expect(store.revision == 2)

        #expect(!store.report(slotId: "", width: 10, height: 10) && !store.report(slotId: "p:r2", width: 0, height: 10))
        #expect(store.revision == 2)
        store.remove(slotId: "p:r9")
        #expect(store.revision == 2)
        store.remove(slotId: "p:r1")
        #expect(store.revision == 3 && store.size(slotId: "p:r1") == RendererFrameSize.zero)
        _ = store.report(slotId: "share:r2", width: 1920, height: 1080)
        store.removeAll()
        #expect(store.revision == 5)
        store.removeAll()
        #expect(store.revision == 5)

        #expect(RendererFrameSizeStore.slotId(rendererKey: "stage:p:r1") == "p:r1")
        #expect(RendererFrameSizeStore.slotId(rendererKey: "stage:share:r2") == "share:r2")
        #expect(RendererFrameSizeStore.slotId(rendererKey: "pip:3:r1:track") == "")
        #expect(RendererFrameSizeStore.slotId(rendererKey: "meeting") == "")
    }

    @Test func iPhoneDropsUpsideDownAndIPadKeepsAllFour() throws {
        let data = try Data(contentsOf: stg7PackageRoot().appendingPathComponent("Darwin/Info.plist"))
        let plist = try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        let iPhone = try #require(plist["UISupportedInterfaceOrientations"] as? [String])
        #expect(iPhone == ["UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight", "UIInterfaceOrientationPortrait"])
        let iPad = try #require(plist["UISupportedInterfaceOrientations~ipad"] as? [String])
        #expect(Set(iPad) == ["UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight",
                              "UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown"])

        #expect(plist["UIRequiresFullScreen"] == nil)
    }

    @Test func theAppSceneStopsShrinkingAtTheCompactBarMinimum() throws {
        let main = stg7Normalized(try stg7Source("Darwin/Sources/Main.swift"))
        #expect(main.contains(".frame(minWidth: CGFloat(ConclaveWindowMetrics.minimumWidth), maxWidth: .infinity, maxHeight: .infinity)"))
        #expect(main.contains(".windowResizability(.contentMinSize)"))
        #expect(ConclaveWindowMetrics.minimumWidth == 276)
    }

    @Test func theAnchorIsOneStableViewAndRenderersReportOffTheFrameCallback() throws {
        let anchor = stg7Normalized(try stg7Source("Sources/Conclave/Features/Meeting/Stage/PipAnchor+iOS.swift"))
        #expect(anchor.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(anchor.contains("struct StagePipAnchorView: UIViewRepresentable {"))
        #expect(anchor.contains("func updateUIView(_ uiView: UIView, context: Context) {}"))
        #expect(anchor.contains("view.isUserInteractionEnabled = false") && anchor.contains("view.isAccessibilityElement = false"))
        #expect(anchor.contains(".allowsHitTesting(false) .accessibilityHidden(true)"))
        #expect(anchor.contains("let choice = stage.pipTarget"))
        let video = stg7Normalized(try stg7Source("Sources/Conclave/Core/WebRTC/VideoView.swift"))
        #expect(video.contains("final class RendererFrameSizeObserver: NSObject, RTCVideoViewDelegate {"))
        #expect(video.contains("func videoView(_ videoView: RTCVideoRenderer, didChangeVideoSize size: CGSize) {"))
        let observer = try #require(video.range(of: "final class RendererFrameSizeObserver"))
        let observerEnd = try #require(video.range(of: "struct VideoGridItem: View {", range: observer.upperBound..<video.endIndex))
        let observerBody = String(video[observer.upperBound..<observerEnd.lowerBound])
        #expect(!observerBody.contains("addSink") && !observerBody.contains(".add(") && !observerBody.contains(".remove(view"))
        let renderer = stg7Normalized(try stg7Source("Sources/Conclave/Skip/VideoRenderer.kt"))
        #expect(renderer.contains("internal val LocalRendererFrameSizes = staticCompositionLocalOf<RendererFrameSizeStore?> { null }"))
        #expect(renderer.contains("post { updateLayoutAspectRatio() reportFrameSize() }"))
        #expect(renderer.contains("val frameSlotId = RendererFrameSizeStore.slotId(rendererKey = rendererLifecycleKey.toString())"))
        let onFrame = try #require(renderer.range(of: "override fun onFrame(frame: VideoFrame) {"))
        let onFrameEnd = try #require(renderer.range(of: "override fun onSurfaceTextureAvailable", range: onFrame.upperBound..<renderer.endIndex))
        let frameBody = String(renderer[onFrame.upperBound..<onFrameEnd.lowerBound])
        #expect(!frameBody.contains("removeSink") && !frameBody.contains("addSink") && !frameBody.contains("ledger"))

        let post = try #require(frameBody.range(of: "post {"))
        let report = try #require(frameBody.range(of: "reportFrameSize()"))
        #expect(post.lowerBound < report.lowerBound)

        let policy = try stg7Source("Sources/Conclave/Features/Meeting/Stage/PipTargetPolicy.swift")
        #expect(!policy.contains("#if") && !policy.contains("\u{2014}") && !policy.contains("\u{2013}"))
    }
}

private func stg7PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func stg7Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: stg7PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func stg7Normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif
