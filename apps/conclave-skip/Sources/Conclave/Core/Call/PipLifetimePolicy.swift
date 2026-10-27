import Foundation

// S70 3 c (SYS-4, SY6; SX11 `PipLifetimePolicy`; RECONCILE R28) and PS 9.4 (S70 R70-7): the lifetime of the iOS
// video-call PiP controller and of its sample-buffer sink, plus the feedback suspension rule both platforms apply.
// Pure and transpiled, so the host tests script a whole call (construction once at the first live, kept through
// recovery and target switches, stopped before release at ending; a reopened app stops PiP once and restores once).
// The iOS adapter (VideoCallPictureInPicture+iOS.swift) executes the actions in the order they are returned.

/// The scene state the iOS adapter reads from the app lifecycle.
enum PipScenePhase: String, CaseIterable, Equatable {
    case active, inactive, background
}

/// One step the iOS adapter performs, in order.
enum PipLifetimeAction: String, CaseIterable, Equatable {
    /// Build the one `AVPictureInPictureController` of this call over the stage root's stable anchor.
    case createController
    /// The anchor view changed (the call root remounted): reassign `contentSource` (settable since iOS 15) instead
    /// of building a new controller.
    case updateSource
    /// Swap the sample-buffer sink to the new target's track (added and removed off the frame callback).
    case retargetSink
    /// `preferredContentSize` follows the decoded frame size of the target.
    case resizeContent
    /// Start converting frames into the display layer (the scene became inactive during a live call).
    case attachSink
    /// Stop converting frames (PiP stopped, or the app is active without PiP).
    case detachSink
    /// `canStartPictureInPictureAutomaticallyFromInline = false` before anything is stopped or released (A-05).
    case disableAutomaticStart
    case stopPictureInPicture
    /// `contentSource = nil`, then the controller is released.
    case releaseController
    /// `handle(.returnToCall, source: .pictureInPicture, ...)`: the call root with the same panel.
    case restoreCall
    /// PS 9.4: feedback delivery suspended while PiP shows ...
    case suspendFeedback
    /// ... and rebaselined (never replayed) when it ends.
    case resumeFeedback
}

enum PipLifetimePolicy {
    /// PS 9.4 and S70 3 e: feedback delivery is suspended while the window is in PiP or transitioning into it
    /// (Android API 35 `isTransitioningToPip`); the delivery cursor rebaselines when it resumes, so nothing replays.
    static func suspendsFeedback(isInPictureInPicture: Bool, isTransitioningToPip: Bool) -> Bool {
        isInPictureInPicture || isTransitioningToPip
    }

    /// The controller exists from the first live phase until the call ends; a same-room redirect (presence keeps the
    /// call in `connecting`) and recovery keep it.
    static func keepsController(_ phase: CallPresencePhase) -> Bool {
        phase != .ending && phase != .idle
    }
}

/// The iOS controller and sink state machine (S70 3 c). One instance per process, reset by the call ending. Holds
/// only scalars; the platform objects live in the adapter, which mirrors `hasController` and `isSinkAttached`.
final class PipLifetimeMachine {
    private(set) var hasController = false
    private(set) var isSinkAttached = false
    private(set) var isPictureInPictureActive = false
    /// A stop is under way (the restore button, our own stop, or the system's will-stop): a scene activation in
    /// between neither stops again nor restores twice.
    private(set) var isStopping = false
    private(set) var scene = PipScenePhase.active
    private(set) var phase = CallPresencePhase.idle
    private(set) var targetSlotId = ""
    private(set) var videoWidth = 0
    private(set) var videoHeight = 0
    private(set) var anchorRevision = 0
    /// Diagnostics read by the host tests and the `sys.pip` readout.
    private(set) var constructions = 0
    private(set) var releases = 0
    private(set) var stopRequests = 0
    private(set) var restores = 0
    private(set) var sinkSwaps = 0

    /// A presence snapshot reached the adapter. `anchorRevision` counts anchor registrations (0: no anchor yet), so
    /// a remounted call root is a source update, never a second controller.
    func presenceChanged(phase: CallPresencePhase, targetSlotId: String, videoWidth: Int, videoHeight: Int,
                         anchorRevision: Int) -> [PipLifetimeAction] {
        let anchorChanged = anchorRevision != self.anchorRevision
        self.phase = phase
        self.anchorRevision = anchorRevision
        if hasController && !PipLifetimePolicy.keepsController(phase) {
            self.targetSlotId = targetSlotId
            return releaseActions()
        }
        var actions: [PipLifetimeAction] = []
        var created = false
        if !hasController && PipParamsPolicy.isEligiblePhase(phase) && anchorRevision > 0 {
            hasController = true
            created = true
            constructions += 1
            actions.append(PipLifetimeAction.createController)
            if scene == .inactive {
                // The anchor arrived while the app was already resigning: start converting now.
                isSinkAttached = true
                actions.append(PipLifetimeAction.attachSink)
            }
        } else if hasController && anchorChanged && anchorRevision > 0 {
            actions.append(PipLifetimeAction.updateSource)
        }
        if targetSlotId != self.targetSlotId {
            self.targetSlotId = targetSlotId
            if hasController && isSinkAttached && !created {
                sinkSwaps += 1
                actions.append(PipLifetimeAction.retargetSink)
            }
        }
        // A size of 0 (no frame yet) keeps the last size.
        var resized = false
        if videoWidth > 0 && videoHeight > 0 && (videoWidth != self.videoWidth || videoHeight != self.videoHeight) {
            self.videoWidth = videoWidth
            self.videoHeight = videoHeight
            resized = true
        }
        if hasController && (resized || (created && self.videoWidth > 0 && self.videoHeight > 0)) {
            actions.append(PipLifetimeAction.resizeContent)
        }
        return actions
    }

    /// The scene moved (UIApplication will-resign-active, did-become-active, did-enter-background).
    func sceneChanged(_ next: PipScenePhase) -> [PipLifetimeAction] {
        var actions: [PipLifetimeAction] = []
        scene = next
        switch next {
        case .inactive:
            if hasController && PipParamsPolicy.isEligiblePhase(phase) && !isSinkAttached {
                isSinkAttached = true
                actions.append(PipLifetimeAction.attachSink)
            }
        case .active:
            if isPictureInPictureActive {
                // While a stop is already under way (the restore button brings the call forward itself) nothing more
                // happens; the sink detaches after the stop callback either way.
                if !isStopping {
                    // Reopened from the Home Screen or the app switcher while PiP shows: the call never sits in a
                    // PiP window over its own stage.
                    isStopping = true
                    stopRequests += 1
                    restores += 1
                    actions.append(PipLifetimeAction.stopPictureInPicture)
                    actions.append(PipLifetimeAction.restoreCall)
                }
            } else if isSinkAttached {
                isSinkAttached = false
                actions.append(PipLifetimeAction.detachSink)
            }
        case .background:
            break
        }
        return actions
    }

    func pictureInPictureStarted() -> [PipLifetimeAction] {
        if isPictureInPictureActive { return [] }
        isPictureInPictureActive = true
        isStopping = false
        return [PipLifetimeAction.suspendFeedback]
    }

    /// `pictureInPictureControllerWillStopPictureInPicture`.
    func pictureInPictureWillStop() {
        if isPictureInPictureActive { isStopping = true }
    }

    /// The window closed (restore, the system close, our own stop). Frames are converted only while PiP is possible
    /// or showing, so the sink detaches; the next resign attaches it again.
    func pictureInPictureStopped() -> [PipLifetimeAction] {
        var actions: [PipLifetimeAction] = []
        isStopping = false
        if isPictureInPictureActive {
            isPictureInPictureActive = false
            actions.append(PipLifetimeAction.resumeFeedback)
        }
        if isSinkAttached {
            isSinkAttached = false
            actions.append(PipLifetimeAction.detachSink)
        }
        return actions
    }

    /// The system restore button (`restoreUserInterfaceForPictureInPictureStop`).
    func restoreRequested() -> [PipLifetimeAction] {
        if isPictureInPictureActive { isStopping = true }
        restores += 1
        return [PipLifetimeAction.restoreCall]
    }

    /// Starting PiP failed: nothing shows, so nothing is suspended; the sink stays until the app is active again.
    func pictureInPictureFailedToStart() -> [PipLifetimeAction] {
        isStopping = false
        if !isPictureInPictureActive { return [] }
        isPictureInPictureActive = false
        return [PipLifetimeAction.resumeFeedback]
    }

    /// The call ended: no automatic start, stop a showing window first, then release (A-05). The feedback
    /// suspension ends here too, because a released controller may not deliver its stop callback.
    private func releaseActions() -> [PipLifetimeAction] {
        var actions: [PipLifetimeAction] = [PipLifetimeAction.disableAutomaticStart]
        isStopping = false
        if isPictureInPictureActive {
            isPictureInPictureActive = false
            stopRequests += 1
            actions.append(PipLifetimeAction.stopPictureInPicture)
            actions.append(PipLifetimeAction.resumeFeedback)
        }
        if isSinkAttached {
            isSinkAttached = false
            actions.append(PipLifetimeAction.detachSink)
        }
        actions.append(PipLifetimeAction.releaseController)
        hasController = false
        releases += 1
        videoWidth = 0
        videoHeight = 0
        return actions
    }
}
