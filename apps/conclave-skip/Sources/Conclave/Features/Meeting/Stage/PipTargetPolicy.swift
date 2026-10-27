import Foundation
import Observation

// S20 13 d and SC11 (STG-7; RECONCILE R28; S70 R70-10): what the system Picture in Picture window shows and the frame
// WP3 builds its window from. The stage decides the content; SYS-4 (S70 3) builds the windows: iOS sizes
// `preferredContentSize` from the decoded frame size and uses the stage root's stable anchor (PipAnchor+iOS.swift) as
// its source view; Android sets the aspect ratio from the frame size and `sourceRectHint` from the slot bounds. Shared
// (transpiled): Skip Lite shapes only.

/// The slot the PiP window shows. `slotId` is "p:<canonical id>" or "share:<canonical id>"; empty when nobody else is
/// there (alone, the window shows the S20 solo card text).
struct PipTargetChoice: Equatable {
    let slotId: String
    let userId: String
    let isShare: Bool

    static let none = PipTargetChoice(slotId: "", userId: "", isShare: false)

    var isEmpty: Bool { slotId.isEmpty }
}

/// A renderer's decoded frame size after rotation (S70 R70-10); zero until its first frame.
struct RendererFrameSize: Equatable {
    let width: Int
    let height: Int

    static let zero = RendererFrameSize(width: 0, height: 0)
}

enum PipTargetPolicy {
    /// S20 13 d: the live share (someone else's) > the pinned person > the featured speaker with camera on > the first
    /// remote with video > the first remote; never you (a local share or pin of yourself is skipped). A webinar
    /// attendee follows the program feed's speaker after a share (S20 12). Remotes are ordered by join serial (PH19),
    /// so the fallback never jumps between equal candidates.
    static func choose(inputs: StageInputs, layout: StageLayoutSnapshot) -> PipTargetChoice {
        let local = inputs.localUserId
        let share = inputs.screenShareUserId
        if !share.isEmpty && share != local && !inputs.isLocalScreenSharing {
            if let presenter = inputs.participant(share), !presenter.isLocal {
                return PipTargetChoice(slotId: StageSlot.shareId(share), userId: share, isShare: true)
            }
        }
        if inputs.isWebinarAttendee && !inputs.webinarSpeakerUserId.isEmpty && inputs.webinarSpeakerUserId != local {
            return person(inputs.webinarSpeakerUserId)
        }
        let pinned = layout.pinnedUserId.isEmpty ? inputs.pinnedUserId : layout.pinnedUserId
        if !pinned.isEmpty && pinned != local, let row = inputs.participant(pinned), !row.isLocal {
            return person(pinned)
        }
        let featured = layout.featuredUserId
        if !featured.isEmpty && featured != local, let row = inputs.participant(featured), !row.isLocal, hasVideo(row) {
            return person(featured)
        }
        let remotes = remotesInJoinOrder(inputs, localUserId: local)
        for row in remotes {
            if hasVideo(row) { return person(row.userId) }
        }
        if let first = remotes.first {
            return person(first.userId)
        }
        return PipTargetChoice.none
    }

    /// Camera on with a bound track (the legacy target policy waits for the track unless the camera is off).
    static func hasVideo(_ row: StageParticipantInput) -> Bool {
        !row.isCameraOff && !row.videoKey.isEmpty
    }

    /// The S70 0.5 `PipTargetFrame` for a choice: the laid-out slot bounds converted to window units (pt on iOS, px on
    /// Android: `scale` is 1 on iOS and the density on Android; `originX`/`originY` place the canvas in the window) plus
    /// the decoded frame size. Canvas frames are measured from the leading edge, so a right-to-left layout mirrors x.
    /// A target that is not laid out (behind an activity, past the cap) keeps zero bounds, which SYS-4 reads as "no
    /// source rectangle". Nil when there is no target.
    static func frame(choice: PipTargetChoice, frames: [StageFrame], canvasWidth: Double, originX: Double, originY: Double,
                      scale: Double, isRightToLeft: Bool, frameSize: RendererFrameSize) -> PipTargetFrame? {
        if choice.isEmpty { return nil }
        guard let slot = StageLayoutPolicy.find(choice.slotId, in: frames) else {
            return PipTargetFrame(slotId: choice.slotId, left: 0, top: 0, right: 0, bottom: 0,
                                  videoWidth: frameSize.width, videoHeight: frameSize.height)
        }
        let leading = isRightToLeft ? canvasWidth - slot.maxX : slot.x
        let left = originX + leading * scale
        let top = originY + slot.y * scale
        return PipTargetFrame(slotId: choice.slotId, left: left, top: top, right: left + slot.width * scale,
                              bottom: top + slot.height * scale, videoWidth: frameSize.width, videoHeight: frameSize.height)
    }

    private static func person(_ userId: String) -> PipTargetChoice {
        PipTargetChoice(slotId: StageSlot.participantId(userId), userId: userId, isShare: false)
    }

    private static func remotesInJoinOrder(_ inputs: StageInputs, localUserId: String) -> [StageParticipantInput] {
        var remotes: [StageParticipantInput] = []
        for row in inputs.presentParticipants {
            if !row.isLocal && row.userId != localUserId { remotes.append(row) }
        }
        return remotes.sorted { $0.joinSerial < $1.joinSerial }
    }
}

/// The decoded frame size of each stage renderer slot (S20 SC11, S70 R70-10), reported on the main thread by the
/// platform renderers (iOS `RTCVideoViewDelegate.videoView(_:didChangeVideoSize:)`, Android the texture renderer's
/// frame callback hop) and read by the PiP target frame. One store per stage, cleared with it. `revision` is the only
/// observed value: it bumps once per real size change, so a reader re-evaluates once per change and an equal report
/// publishes nothing.
@MainActor
@Observable
final class RendererFrameSizeStore {
    private(set) var revision = 0
    @ObservationIgnored private var sizes: [String: RendererFrameSize] = [:]
    @ObservationIgnored private(set) var reportCount = 0

    static let stageKeyPrefix = "stage:"

    /// Equality guarded; ignores empty ids and sizes that are not positive. Returns true when the size changed.
    @discardableResult
    func report(slotId: String, width: Int, height: Int) -> Bool {
        if slotId.isEmpty || width <= 0 || height <= 0 { return false }
        let next = RendererFrameSize(width: width, height: height)
        if sizes[slotId] == next { return false }
        sizes[slotId] = next
        reportCount += 1
        revision += 1
        return true
    }

    func size(slotId: String) -> RendererFrameSize {
        sizes[slotId] ?? RendererFrameSize.zero
    }

    /// A renderer left its slot (released, recreated for another slot).
    func remove(slotId: String) {
        if sizes[slotId] == nil { return }
        sizes.removeValue(forKey: slotId)
        revision += 1
    }

    func removeAll() {
        if sizes.isEmpty { return }
        sizes = [:]
        revision += 1
    }

    /// Stage renderer keys are "stage:<slotId>" (S20 SC10); every other key (PiP, mini tile, legacy views) is not a
    /// stage slot and reports nothing.
    static func slotId(rendererKey: String) -> String {
        if !rendererKey.hasPrefix(stageKeyPrefix) { return "" }
        return String(rendererKey.dropFirst(stageKeyPrefix.count))
    }
}
