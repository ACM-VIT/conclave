import Foundation
import Observation

// S20 SL14 Debug stage fixture (STG-1, STG-4): `CONCLAVE_STAGE_FIXTURE=<state>` (iOS launch environment) and the
// intent extra `conclave.stageFixture` (Android, Debug only, FLAG_DEBUGGABLE checked like `conclave.hostingPreview`).
// It builds a standalone S1 shell and stage presenter with scripted rosters, speakers, events and reactions; slots
// render `RendererProbe` (PS 7.5, 8.9) with a static or live test pattern, both counted by `RendererIdentityLedger`.
// No WebRTC, audio, capture or network. The script is shared (transpiled) so both platforms and both test hosts read
// the same states. Later slices add states here through requests (keep one state enum, per-feature scripts).

/// The probe's drawing (SL14): none (the WP1 strip), a static test pattern drawn once and then no frames (the idle
/// cells), or a live pattern that keeps updating the renderer surface (the renderer-driven frame cells).
enum RendererProbePattern: String, CaseIterable, Equatable {
    case none
    case staticPattern = "static"
    case livePattern = "live"
}

/// Fixture states. Raw values are the launch values.
enum StageFixtureState: String, CaseIterable, Equatable {
    case soloCameraOff = "solo-cameraOff"
    case soloCameraOn = "solo-cameraOn"
    case soloUnconfirmed = "solo-unconfirmed"
    case oneOnOne = "oneOnOne"
    case grid3 = "grid-3"
    case grid4 = "grid-4"
    case grid6 = "grid-6"
    case grid8 = "grid-8"
    case grid12 = "grid-12"
    case grid16 = "grid-16"
    case grid6LockedCaptions = "grid-6-locked-captions"
    case audioOnly = "audio-only"
    case spotlight = "spotlight"
    case presentation = "presentation"
    case pinned = "pinned"
    case rolesSweep = "roles-sweep"
    case recovering = "recovering"
    case handRaising = "hand-raising"
    case handRaised = "hand-raised"
    case nowPlaying = "now-playing"
    case liveNotesPaused = "liveNotes-paused"
    case liveNotesAttention = "liveNotes-attention"
    case reactionsBurst25 = "reactions-burst-25"
    case reactionsBurst40 = "reactions-burst-40"
    case hideTiles = "hide-tiles"
}

/// Pure scripts per state, shared by the fixture roots and both test hosts.
enum StageFixtureScript {
    static let roomLabel = "abc-defg-hij"
    static let localUserId = "you"
    static let meetingLink = "https://conclave.acmvit.in/abc-defg-hij"
    /// Fixed and long past (2023-11-14 UTC), so the recent-join hold never delays the auto-hide cells.
    static let joinedAtMillis = 1700000000000.0
    static let names = ["Avery", "Ben", "Cai", "Dev", "Eli", "Fen", "Gia", "Hal", "Ivo", "Jun", "Kai", "Lia", "Mo", "Nia",
                        "Oli", "Pax", "Quin", "Rae", "Sol", "Tao"]

    static func state(named raw: String) -> StageFixtureState? {
        StageFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func pattern(named raw: String?) -> RendererProbePattern {
        guard let raw = raw else { return RendererProbePattern.staticPattern }
        return RendererProbePattern(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines)) ?? RendererProbePattern.staticPattern
    }

    static func remoteId(_ index: Int) -> String {
        "r" + String(index + 1)
    }

    static func remoteName(_ index: Int) -> String {
        if index < names.count { return names[index] }
        return "Guest " + String(index + 1)
    }

    /// `count` people including you: you first in the array (order never matters to the stage), then remotes with join
    /// serials 1...count-1. Remote cameras are on unless `remoteCamerasOn` is false.
    static func roster(count: Int, remoteCamerasOn: Bool = true, localCameraOn: Bool = false, localMuted: Bool = true,
                       localHandRaised: Bool = false) -> [StageParticipantInput] {
        var result: [StageParticipantInput] = []
        result.append(StageParticipantInput.make(userId: localUserId, displayName: "You", isLocal: true, isMuted: localMuted,
                                                 isCameraOff: !localCameraOn, isHandRaised: localHandRaised, joinSerial: 0,
                                                 videoKey: localCameraOn ? "probe:" + localUserId : ""))
        var index = 0
        while index < count - 1 {
            let id = remoteId(index)
            result.append(StageParticipantInput.make(userId: id, displayName: remoteName(index), isMuted: index % 3 == 1,
                                                     isCameraOff: !remoteCamerasOn, joinSerial: index + 1,
                                                     videoKey: remoteCamerasOn ? "probe:" + id : ""))
            index += 1
        }
        return result
    }

    static func base(count: Int, remoteCamerasOn: Bool = true, localCameraOn: Bool = false) -> StageInputs {
        StageInputs.make(callSession: 1, isInCall: true, localUserId: localUserId, roomLabel: roomLabel, meetingLink: meetingLink,
                         participants: roster(count: count, remoteCamerasOn: remoteCamerasOn, localCameraOn: localCameraOn),
                         isAloneConfirmed: count == 1, canFlipCamera: true, routeKind: "speaker", routeName: "Speaker",
                         joinedAtMillis: joinedAtMillis)
    }

    // swiftlint:disable:next cyclomatic_complexity
    static func inputs(for state: StageFixtureState) -> StageInputs {
        switch state {
        case .soloCameraOff:
            return base(count: 1)
        case .soloCameraOn:
            return base(count: 1, localCameraOn: true)
        case .soloUnconfirmed:
            return copy(base(count: 1), isAloneConfirmed: false)
        case .oneOnOne:
            return base(count: 2, localCameraOn: true)
        case .grid3:
            return base(count: 3)
        case .grid4:
            return base(count: 4)
        case .grid6:
            return base(count: 6)
        case .grid8:
            return base(count: 8)
        case .grid12:
            return base(count: 12)
        case .grid16:
            return base(count: 16)
        case .grid6LockedCaptions:
            return copy(base(count: 6), isRoomLocked: true, captionsOn: true)
        case .audioOnly:
            return base(count: 4, remoteCamerasOn: false)
        case .spotlight:
            return copy(base(count: 6), viewMode: "spotlight")
        case .presentation:
            var shared = roster(count: 4)
            shared[1] = StageParticipantInput.make(userId: remoteId(0), displayName: remoteName(0), isMuted: false,
                                                   isCameraOff: false, isScreenSharing: true, joinSerial: 1,
                                                   videoKey: "probe:" + remoteId(0), shareVideoKey: "probe:share:" + remoteId(0))
            return copy(base(count: 4), participants: shared, screenShareUserId: remoteId(0))
        case .pinned:
            return copy(base(count: 6), pinnedUserId: remoteId(1))
        case .rolesSweep:
            return rolesSweepStep(0)
        case .recovering:
            return copy(base(count: 4), isRecovering: true)
        case .handRaising:
            return copy(base(count: 4), handToggleInFlight: true)
        case .handRaised:
            return copy(base(count: 4), participants: roster(count: 4, localHandRaised: true), isHandRaised: true)
        case .nowPlaying:
            return copy(base(count: 4), isGameActive: true, gameName: "Trivia")
        case .liveNotesPaused:
            return copy(base(count: 4), liveNotes: LiveNotesState.paused)
        case .liveNotesAttention:
            return copy(base(count: 4), liveNotes: LiveNotesState.needsAttention)
        case .reactionsBurst25:
            return base(count: 6)
        case .reactionsBurst40:
            return base(count: 40)
        case .hideTiles:
            // r2 speaks with the camera off; hiding tiles without video must keep their tile and their audio (SC6).
            var rows = roster(count: 6)
            rows[2] = StageParticipantInput.make(userId: remoteId(1), displayName: remoteName(1), isMuted: false,
                                                 isCameraOff: true, joinSerial: 2)
            rows[3] = StageParticipantInput.make(userId: remoteId(2), displayName: remoteName(2), isMuted: false,
                                                 isCameraOff: true, joinSerial: 3)
            return copy(base(count: 6), participants: rows, hideTilesWithoutVideo: true)
        }
    }

    /// The roles sweep (S20 2 l4): one id (yours) moves through grid, rail, spotlight main, floating and minimized while
    /// its slot id and renderer stay the same.
    static let rolesSweepStepCount = 5

    static func rolesSweepStep(_ step: Int) -> StageInputs {
        switch step % rolesSweepStepCount {
        case 0:
            return copy(base(count: 3, localCameraOn: true), selfViewMode: "tile")
        case 1:
            return copy(base(count: 3, localCameraOn: true), viewMode: "spotlight", selfViewMode: "tile")
        case 2:
            return copy(base(count: 3, localCameraOn: true), viewMode: "spotlight", selfViewMode: "tile",
                        pinnedUserId: localUserId)
        case 3:
            return copy(base(count: 2, localCameraOn: true), selfViewMode: "floating")
        default:
            return copy(base(count: 2, localCameraOn: true), selfViewMode: "minimized")
        }
    }

    /// Who speaks in the fixture's speaker script: 20 changes over the visible remotes (S20 2 l3: zero layout changes
    /// while everyone fits).
    static func speakerScript(for state: StageFixtureState) -> [String] {
        let present = inputs(for: state).presentParticipants
        var remotes: [String] = []
        for participant in present {
            if !participant.isLocal { remotes.append(participant.userId) }
        }
        var result: [String] = []
        if remotes.isEmpty { return result }
        var index = 0
        while result.count < 20 {
            result.append(remotes[index % min(remotes.count, 4)])
            index += 1
        }
        return result
    }

    /// The last remote, hidden past the cap in grid-12 (the featured swap cell).
    static func hiddenSpeaker(for state: StageFixtureState) -> String {
        let count = inputs(for: state).presentParticipants.count
        return count > 1 ? remoteId(count - 2) : ""
    }

    /// `count` scripted reactions from alternating senders.
    static func reactions(count: Int) -> [StageReactionInput] {
        var result: [StageReactionInput] = []
        var index = 0
        while index < count {
            let emoji = MeetingReactionConstants.emojiOptions[index % MeetingReactionConstants.emojiOptions.count]
            result.append(StageReactionInput(sourceId: "fixture-" + String(index), senderName: index % 5 == 0 ? "" : remoteName(index),
                                             isLocal: index % 7 == 0, kind: "emoji", value: emoji, label: emoji))
            index += 1
        }
        return result
    }

    static func reactionCount(for state: StageFixtureState) -> Int {
        switch state {
        case .reactionsBurst25, .reactionsBurst40: return 25
        default: return 0
        }
    }

    /// One-field edits of fixture inputs (every field defaulted to the source's value).
    static func copy(_ source: StageInputs, participants: [StageParticipantInput]? = nil, viewMode: String? = nil,
                     hideTilesWithoutVideo: Bool? = nil, selfViewMode: String? = nil, pinnedUserId: String? = nil,
                     isGameActive: Bool? = nil, gameName: String? = nil, screenShareUserId: String? = nil,
                     isRoomLocked: Bool? = nil, captionsOn: Bool? = nil, liveNotes: LiveNotesState? = nil,
                     isAloneConfirmed: Bool? = nil, isHandRaised: Bool? = nil, handToggleInFlight: Bool? = nil,
                     isRecovering: Bool? = nil, isFrontCamera: Bool? = nil) -> StageInputs {
        StageInputs.make(
            callSession: source.callSession, isInCall: source.isInCall, localUserId: source.localUserId,
            roomLabel: source.roomLabel, meetingLink: source.meetingLink,
            participants: participants ?? source.participants, viewMode: viewMode ?? source.viewMode,
            viewMaxTiles: source.viewMaxTiles, hideTilesWithoutVideo: hideTilesWithoutVideo ?? source.hideTilesWithoutVideo,
            selfViewMode: selfViewMode ?? source.selfViewMode, selfViewCorner: source.selfViewCorner,
            pinnedUserId: pinnedUserId ?? source.pinnedUserId, activeAppId: source.activeAppId,
            activeAppName: source.activeAppName, isBrowserActive: source.isBrowserActive,
            isGameActive: isGameActive ?? source.isGameActive, gameName: gameName ?? source.gameName,
            screenShareUserId: screenShareUserId ?? source.screenShareUserId,
            isLocalScreenSharing: source.isLocalScreenSharing, isWebinarAttendee: source.isWebinarAttendee,
            webinarSpeakerUserId: source.webinarSpeakerUserId, isRoomLocked: isRoomLocked ?? source.isRoomLocked,
            captionsOn: captionsOn ?? source.captionsOn, liveNotes: liveNotes ?? source.liveNotes,
            isAloneConfirmed: isAloneConfirmed ?? source.isAloneConfirmed, canFlipCamera: source.canFlipCamera,
            isFrontCamera: isFrontCamera ?? source.isFrontCamera, routeKind: source.routeKind, routeName: source.routeName,
            isHandRaised: isHandRaised ?? source.isHandRaised,
            handToggleInFlight: handToggleInFlight ?? source.handToggleInFlight,
            isRecovering: isRecovering ?? source.isRecovering, isMediaPending: source.isMediaPending,
            joinedAtMillis: source.joinedAtMillis, alwaysShowControls: source.alwaysShowControls,
            isEffectsOpen: source.isEffectsOpen)
    }

    /// The S1 inputs that put the standalone shell in the call (or in recovery after admission).
    static func shellInputs(_ stage: StageInputs, isMuted: Bool, isCameraOff: Bool) -> MeetingShellInputs {
        MeetingShellInputs.make(
            identity: MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "stage-fixture"),
            connectionState: stage.isRecovering ? ConnectionState.reconnecting : ConnectionState.joined,
            isRecoveringConnection: stage.isRecovering,
            roomId: roomLabel,
            displayName: "You",
            isMuted: isMuted,
            isCameraOff: isCameraOff,
            isHandRaised: stage.isHandRaised,
            handToggleInFlight: stage.handToggleInFlight
        )
    }
}

/// `stage.counters` (SL14). Plain, never observed: readouts refresh on demand so counting never perturbs the stage.
@MainActor
final class StageFixtureCounters {
    private(set) var toggleMicrophone = 0
    private(set) var minimize = 0
    private(set) var leave = 0
    private(set) var renderTargetResize = 0
    private(set) var generateWebinarLink = 0
    private(set) var commands: [String] = []

    func recordMicrophone() { toggleMicrophone += 1 }
    func recordMinimize() { minimize += 1 }
    func recordLeave() { leave += 1 }
    func recordRenderTargetResize() { renderTargetResize += 1 }
    func recordCommand(_ name: String) {
        commands.append(name)
        if commands.count > 10 { commands.removeFirst() }
    }

    func summary(setViewport: Int) -> String {
        "toggleMicrophone=" + String(toggleMicrophone) + " minimize=" + String(minimize) + " leave=" + String(leave)
            + " setViewport=" + String(setViewport) + " renderTargetResize=" + String(renderTargetResize)
            + " generateWebinarLink=" + String(generateWebinarLink)
    }
}

/// One fixture run: the standalone presenters, the ledger and the scripted command handling, shared by the iOS and
/// Android fixture roots so both behave the same. Never touches `MeetingViewModel`.
@MainActor
final class StageFixtureSession {
    let state: StageFixtureState
    let pattern: RendererProbePattern
    let forceScreenReader: Bool
    let shell: MeetingShellPresenter
    let stage: StagePresenter
    let renderers = RendererIdentityLedger()
    let counters = StageFixtureCounters()
    private(set) var inputs: StageInputs
    private(set) var rolesSweepStep = 0
    private var isMuted = true
    private var isCameraOff = true

    init(state: StageFixtureState, pattern: RendererProbePattern = RendererProbePattern.staticPattern,
         forceScreenReader: Bool = false) {
        self.state = state
        self.pattern = pattern
        self.forceScreenReader = forceScreenReader
        let owner = MeetingShellPresenter()
        shell = owner
        stage = StagePresenter(shell: owner)
        inputs = StageFixtureScript.inputs(for: state)
        let local = inputs.participant(StageFixtureScript.localUserId)
        isMuted = local?.isMuted ?? true
        isCameraOff = local?.isCameraOff ?? true
        shell.onCommand = { [weak self] command, ticket in
            self?.handle(command, ticket: ticket)
        }
        stage.onCommand = { [weak self] command in
            self?.handle(command)
        }
        shell.panels.onSnapshotChanged = { [weak self] in
            self?.stage.panelSnapshotChanged()
        }
        if inputs.isRecovering {
            // Admission first, so the recovery keeps the stage (S10 0.4).
            shell.apply(StageFixtureScript.shellInputs(StageFixtureScript.copy(inputs, isRecovering: false), isMuted: isMuted,
                                                       isCameraOff: isCameraOff))
        }
        shell.apply(StageFixtureScript.shellInputs(inputs, isMuted: isMuted, isCameraOff: isCameraOff))
        stage.apply(inputs)
        if state == StageFixtureState.nowPlaying {
            stage.setShowsVideoOverActivity(true)
        }
        let reactionCount = StageFixtureScript.reactionCount(for: state)
        if reactionCount > 0 {
            stage.reactionsChanged(StageFixtureScript.reactions(count: reactionCount))
        }
    }

    /// The Magic Tap closure and its fixture button (S20 1 l4): exactly the same call.
    func magicTap() {
        shell.toggleMicrophone()
    }

    /// Android Back with no panel (S20 1 l3): counted, never a leave.
    func minimize() {
        counters.recordMinimize()
    }

    /// 20 scripted speaker changes over the visible remotes at the injected clock.
    func runSpeakerScript() {
        var at = stage.now()
        for id in StageFixtureScript.speakerScript(for: state) {
            stage.speakerChanged(id, atMillis: at)
            at += 300.0
        }
    }

    /// The featured-swap cell: a hidden participant starts speaking now; the promotion task decides in real time.
    func speakHiddenParticipant() {
        stage.speakerChanged(StageFixtureScript.hiddenSpeaker(for: state), atMillis: stage.now())
    }

    func nextRolesSweepStep() {
        rolesSweepStep += 1
        inputs = StageFixtureScript.rolesSweepStep(rolesSweepStep)
        stage.apply(inputs)
    }

    func replayReactions() {
        stage.reactionsChanged([])
        stage.reactionsChanged(StageFixtureScript.reactions(count: max(1, StageFixtureScript.reactionCount(for: state))))
    }

    // MARK: Readouts (outside the stage subtree, PS 7.6)

    func renderersReadout() -> String { renderers.summary() }

    func layoutReadout() -> String { stage.layoutReadout() }

    func countersReadout() -> String { counters.summary(setViewport: stage.viewportChangeCount) }

    func announcementsReadout() -> String {
        stage.announcementLog.isEmpty ? "none" : stage.announcementLog.joined(separator: " | ")
    }

    func panelReadout() -> String {
        guard let current = shell.panels.snapshot.current else { return "none" }
        return "panel=" + current.panel.rawValue + " invoker=" + current.invoker.rawValue + " destination=" + current.destination.rawValue
    }

    func recomposeReadout() -> String { renderers.compositionSummary() }

    func chromeReadout() -> String {
        "blocker=" + stage.autoHideBlocker.rawValue + " transient=" + stage.transientChromeSummary
    }

    // MARK: Scripted core

    private func handle(_ command: MeetingShellCommand, ticket: MeetingActionTicket?) {
        switch command {
        case .toggleMicrophone:
            counters.recordMicrophone()
            isMuted = !isMuted
            replaceLocal()
        case .toggleCamera:
            isCameraOff = !isCameraOff
            replaceLocal()
        case .toggleHand:
            let raised = !inputs.isHandRaised
            inputs = StageFixtureScript.copy(inputs, isHandRaised: raised, handToggleInFlight: false)
            replaceLocal()
            if let ticket = ticket {
                _ = shell.finish(ticket, MeetingActionResult.completed)
            }
        case .leave:
            counters.recordLeave()
        default:
            counters.recordCommand(command.rawValue)
        }
    }

    private func handle(_ command: StageCommand) {
        counters.recordCommand(command.kind.rawValue)
        switch command.kind {
        case .togglePin:
            let next = inputs.pinnedUserId == command.userId ? "" : command.userId
            inputs = StageFixtureScript.copy(inputs, pinnedUserId: next)
            stage.apply(inputs)
        case .clearPin:
            inputs = StageFixtureScript.copy(inputs, pinnedUserId: "")
            stage.apply(inputs)
        case .setSelfViewMode:
            inputs = StageFixtureScript.copy(inputs, selfViewMode: command.value)
            stage.apply(inputs)
        case .moveSelfView:
            counters.recordCommand("corner:" + command.value)
        case .flipCamera:
            inputs = StageFixtureScript.copy(inputs, isFrontCamera: !inputs.isFrontCamera)
            stage.apply(inputs)
        }
    }

    /// Rewrites your roster row from the scripted mic, camera and hand, then pushes both presenters.
    private func replaceLocal() {
        var roster: [StageParticipantInput] = []
        for participant in inputs.participants {
            if participant.isLocal {
                roster.append(StageParticipantInput.make(userId: participant.userId, displayName: participant.displayName,
                                                         isLocal: true, isMuted: isMuted, isCameraOff: isCameraOff,
                                                         isHandRaised: inputs.isHandRaised, joinSerial: participant.joinSerial,
                                                         videoKey: isCameraOff ? "" : "probe:" + participant.userId))
            } else {
                roster.append(participant)
            }
        }
        inputs = StageFixtureScript.copy(inputs, participants: roster)
        shell.apply(StageFixtureScript.shellInputs(inputs, isMuted: isMuted, isCameraOff: isCameraOff))
        stage.apply(inputs)
    }
}
