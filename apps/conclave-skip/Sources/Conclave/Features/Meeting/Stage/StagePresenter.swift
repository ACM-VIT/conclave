import Foundation
import Observation

/// S20 0.5 (SL3): the one session-owned stage presenter, created with the S1 `MeetingShellPresenter` and reset with
/// it (S1C 3.2, 3.3 TEAR). The core pushes `StageInputs` through `apply(_:)` on its own refresh path (SC1) and the hot
/// values through `speakerChanged` and `reactionsChanged`; the presenter never observes the core (SkipModel has no
/// `withObservationTracking`). Every hot or narrowly read value is its own stored property and per-tile state lives in
/// the SL4 stores, so a speaker change, a mute, a consumer swap or a reaction re-evaluates only the leaf that shows it.
///
/// Extension points for later slices (keep per-feature state here, not in the views): STG-5 adds `banner`, `toast`,
/// `queuedToasts` and turns `recentEvents` into notices; STG-6 adds `meetingInfo`; STG-8 adds `attendee`; STG-2 adds
/// the tile menu and pin announcements. Requests against this file name the property they add.
@MainActor
@Observable
final class StagePresenter {
    private(set) var kind: StageKind = StageKind.solo
    private(set) var layout: StageLayoutSnapshot = StageLayoutSnapshot.empty
    private(set) var capsule: StageCapsuleModel = StageCapsuleModel.empty
    private(set) var localHand: LocalHandState = LocalHandState.lowered
    private(set) var autoHideBlocker: AutoHideBlocker = AutoHideBlocker.none
    private(set) var chrome: StageChromeSnapshot = StageChromeSnapshot.empty
    private(set) var reactions: StageReactionsSnapshot = StageReactionsSnapshot.empty
    private(set) var announcement: StageAnnouncement? = nil
    /// Stage outcome tokens (S1 shape); this presenter is the only publisher of the S20 kinds (RECONCILE R12).
    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    @ObservationIgnored let tileChrome = TileChromeStore()
    @ObservationIgnored let speaking = TileSpeakingStore()
    @ObservationIgnored let bindings = RendererBindingStore()
    @ObservationIgnored let shell: MeetingShellPresenter

    /// Core only: the view model performs pin, self view and camera actions (the S1 `onCommand` pattern).
    @ObservationIgnored var onCommand: ((StageCommand) -> Void)? = nil
    /// Core only: SC6 consumer policy and SC7 obscured flag, called once per changed report.
    @ObservationIgnored var onVisibilityChanged: ((StageVisibilityReport) -> Void)? = nil
    /// Injectable clock and sleep (SL2) so the promotion timing is testable.
    @ObservationIgnored var now: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    @ObservationIgnored private(set) var inputs = StageInputs.make()
    @ObservationIgnored private(set) var viewport = StageViewport.zero
    @ObservationIgnored private(set) var visibility = StageVisibilityReport.none
    /// True once a mounted native canvas reported (SC6): until then the core keeps its legacy visible set.
    @ObservationIgnored private(set) var hasVisibilityReport = false
    /// Diagnostics for readouts and tests (never observed).
    @ObservationIgnored private(set) var applyCount = 0
    @ObservationIgnored private(set) var viewportChangeCount = 0
    @ObservationIgnored private(set) var promotionTasksStarted = 0
    @ObservationIgnored private(set) var pendingPromotionCandidate = ""
    @ObservationIgnored private(set) var pendingPromotionDelayMillis = 0.0
    @ObservationIgnored private(set) var recentEvents: [StageEvent] = []
    @ObservationIgnored private(set) var announcementLog: [String] = []

    @ObservationIgnored private var remoteOrder: [String] = []
    @ObservationIgnored private var featuredUserId = ""
    @ObservationIgnored private var currentSpeakerId = ""
    @ObservationIgnored private var speakerSinceMillis = 0.0
    @ObservationIgnored private var lastSwapMillis = StageOrderPolicy.neverSwappedMillis
    @ObservationIgnored private var lastSpokeAt: [String: Double] = [:]
    @ObservationIgnored private var fitOverrides: [String: String] = [:]
    @ObservationIgnored private var showsVideoOverActivity = false
    @ObservationIgnored private var transientIds: [String] = []
    @ObservationIgnored private var promotionTask: Task<Void, Never>? = nil
    @ObservationIgnored private var reactionIds: [String: Int] = [:]
    @ObservationIgnored private var nextReactionId = 0
    @ObservationIgnored private var nextAnnouncementId = 0
    @ObservationIgnored private var announcedEntrySession = -1
    @ObservationIgnored private var lastGameActive = false
    @ObservationIgnored private var lastLiveNotes = LiveNotesState.off

    static let recentEventLimit = 20

    init(shell: MeetingShellPresenter) {
        self.shell = shell
    }

    // MARK: Core hooks

    /// Core only (SC1 E3): the whole cold input set, equality guarded per published property.
    func apply(_ next: StageInputs) {
        applyCount += 1
        // A new call session starts from a clean stage (S1C SES): the stores, the order, the promotion task and the
        // transient set never carry over from the previous call.
        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            reset()
        }
        inputs = next
        rebuild()
        publishFeedbackTransitions()
        publishEntryAnnouncement()
    }

    /// Core hot hook only (SC1 E5): writes the speaking store and the order policy, never the layout while everyone
    /// fits. Past the cap or in spotlight, the single promotion task decides after 1.2 s and at most once per 8 s.
    func speakerChanged(_ canonicalUserId: String?, atMillis: Double) {
        let id = canonicalUserId ?? ""
        if id == currentSpeakerId { return }
        currentSpeakerId = id
        speakerSinceMillis = atMillis
        speaking.setSpeaker(id)
        if !id.isEmpty { lastSpokeAt[id] = atMillis }
        if inputs.hideTilesWithoutVideo {
            // The featured speaker keeps a tile even with the camera off (web STG-41).
            rebuild()
        }
        evaluatePromotion()
    }

    /// Core hot hook only: writes only `reactions`. Source ids map to stable bubble ids for the session.
    func reactionsChanged(_ items: [StageReactionInput]) {
        var events: [ReactionEvent] = []
        var keep: [String: Int] = [:]
        var start = 0
        if items.count > MeetingReactionConstants.maxActiveReactions {
            start = items.count - MeetingReactionConstants.maxActiveReactions
        }
        var index = 0
        for item in items {
            if index >= start {
                var id = reactionIds[item.sourceId] ?? 0
                if id == 0 {
                    nextReactionId += 1
                    id = nextReactionId
                }
                keep[item.sourceId] = id
                events.append(ReactionEvent(id: id, senderName: item.senderName, isLocal: item.isLocal, kind: item.kind,
                                            value: item.value, label: item.label))
            }
            index += 1
        }
        reactionIds = keep
        let limit = StageReactionPolicy.renderLimit(participantCount: inputs.presentParticipants.count)
        let candidate = StageReactionsSnapshot(revision: reactions.revision, events: events, renderLimit: limit)
        if candidate != reactions {
            reactions = StageReactionsSnapshot(revision: reactions.revision + 1, events: events, renderLimit: limit)
        }
    }

    /// Core only (SC18): one-shot events. STG-1 keeps the recent ones for the readout; STG-5's notice policy turns them
    /// into toasts (suppression, coalescing and the Q4 thresholds live there).
    func post(_ event: StageEvent) {
        recentEvents.append(event)
        if recentEvents.count > StagePresenter.recentEventLimit {
            recentEvents.removeFirst()
        }
    }

    /// Core only: the S1 panel snapshot changed (open, close, replace). Folds a panel into the blocker and clears the
    /// bar hold when a panel opens (S30 CC16).
    func panelSnapshotChanged() {
        if shell.panels.snapshot.current != nil {
            removeTransient(ChromeAutoHidePolicy.barHold)
        }
        recomputeBlocker()
    }

    // MARK: Canvas

    /// Canvas only; equality guarded, so chrome toggles never reach it (reserved insets are constant).
    func setViewport(_ next: StageViewport) {
        if next == viewport { return }
        viewport = next
        viewportChangeCount += 1
        rebuild()
    }

    /// Equality guarded; feeds the consumer policy (SC6) and the obscured flag (SC7).
    func reportVisibility(_ report: StageVisibilityReport) {
        if report == visibility && hasVisibilityReport { return }
        hasVisibilityReport = true
        visibility = report
        onVisibilityChanged?(report)
    }

    /// The frames the canvas lays out for the current layout and viewport (SL1, identical to what the canvas uses).
    func currentFrames() -> [StageFrame] {
        StageLayoutPolicy.frames(viewport: viewport, kind: layout.kind, slots: layout.slots, selfCorner: layout.selfCorner)
    }

    /// `stage.layout` readout: revision plus a hash of the slot frames.
    func layoutReadout() -> String {
        "rev=" + String(layout.revision) + " hash=" + String(StageLayoutPolicy.frameHash(currentFrames()))
    }

    // MARK: Actions (views)

    func togglePin(userId: String) {
        onCommand?(StageCommand(kind: StageCommandKind.togglePin, userId: userId, value: ""))
    }

    func clearPin() {
        onCommand?(StageCommand(kind: StageCommandKind.clearPin, userId: "", value: ""))
    }

    /// SC4: a per-session fit override, kept across kind changes and cleared on reset.
    func setFit(_ fit: StageVideoFit, userId: String) {
        setSlotFit(fit, slotId: StageSlot.participantId(userId))
    }

    /// The same override for any slot id (a share slot, `share:<id>`, STG-3).
    func setSlotFit(_ fit: StageVideoFit, slotId: String) {
        if fitOverrides[slotId] == fit.rawValue { return }
        fitOverrides[slotId] = fit.rawValue
        rebuild()
    }

    func setSelfViewMode(_ raw: String) {
        onCommand?(StageCommand(kind: StageCommandKind.setSelfViewMode, userId: "", value: raw))
    }

    func moveSelfView(toCorner raw: String) {
        onCommand?(StageCommand(kind: StageCommandKind.moveSelfView, userId: "", value: raw))
    }

    func flipCamera() {
        onCommand?(StageCommand(kind: StageCommandKind.flipCamera, userId: "", value: ""))
    }

    /// The capsule opens Meeting Details (S20 7 a), invoker `.call`.
    func openMeetingInfo() {
        shell.panels.present(MeetingPanel.meetingInfo, from: PanelInvoker.call)
    }

    /// "+N" and the knock banner open People (S20 2 a).
    func openPeople(destination: PanelDestination) {
        shell.panels.present(MeetingPanel.participants, from: PanelInvoker.call, destination: destination)
    }

    func openChat(privateTo userId: String) {
        shell.panels.present(MeetingPanel.chat, from: PanelInvoker.call, destination: PanelDestination.chatPrivate, targetId: userId)
    }

    func openTranscript(destination: PanelDestination) {
        shell.panels.present(MeetingPanel.transcript, from: PanelInvoker.call, destination: destination)
    }

    func openActivities(destination: PanelDestination, targetId: String) {
        shell.panels.present(MeetingPanel.activities, from: PanelInvoker.call, destination: destination, targetId: targetId)
    }

    /// S30 CC16: an equality-guarded set of open transient ids folded into `autoHideBlocker`; cleared on reset.
    func setTransientChrome(id: String, open: Bool) {
        if open {
            if transientIds.contains(id) { return }
            transientIds.append(id)
            recomputeBlocker()
        } else {
            removeTransient(id)
        }
    }

    /// The `chrome.transient` readout: open ids sorted, or "none".
    var transientChromeSummary: String {
        if transientIds.isEmpty { return "none" }
        return transientIds.sorted().joined(separator: " ")
    }

    /// A tap on the stage background and the next control action both clear the bar hold (S30 CC16).
    func stageTapped() {
        removeTransient(ChromeAutoHidePolicy.barHold)
    }

    func noteControlAction() {
        removeTransient(ChromeAutoHidePolicy.barHold)
    }

    /// Show Video over an activity hides the activity behind the Now Playing chip (S20 11).
    func setShowsVideoOverActivity(_ on: Bool) {
        if showsVideoOverActivity == on { return }
        showsVideoOverActivity = on
        rebuild()
    }

    func showHiddenActivity() {
        setShowsVideoOverActivity(false)
    }

    /// The hand chip's Lower (S20 7): delegates to the S1 hand ticket while the hand is up.
    func lowerHand() {
        if localHand == LocalHandState.raised {
            shell.toggleHand()
        }
    }

    /// The recent-join hold the auto-hide timer respects (S20 8 f "within 8 s of joining"); 0 before joining.
    var recentJoinHoldUntilMillis: Double {
        inputs.joinedAtMillis > 0 ? inputs.joinedAtMillis + ChromeAutoHidePolicy.recentJoinHoldMillis : 0.0
    }

    /// The canonical id currently speaking (rotor and tests); empty when nobody is.
    var speakerUserId: String { currentSpeakerId }

    /// Tile chrome models for the slots on stage, in slot order (rotors, readouts).
    func slotModels() -> [TileChromeModel] {
        var result: [TileChromeModel] = []
        for slot in layout.slots {
            if slot.id.hasPrefix("p:") && tileChrome.contains(slot.userId) {
                result.append(tileChrome.entry(for: slot.userId).model)
            }
        }
        return result
    }

    var hasLivePromotionTask: Bool { promotionTask != nil }

    /// With the S1 reset: cancels the promotion task and clears the stores (S1C 3.3 TEAR). The viewport is a view fact
    /// and stays; revisions keep growing so a view never mistakes a reset for "unchanged".
    func reset() {
        cancelPromotion()
        tileChrome.removeAll()
        speaking.removeAll()
        bindings.removeAll()
        inputs = StageInputs.make()
        visibility = StageVisibilityReport.none
        hasVisibilityReport = false
        remoteOrder = []
        featuredUserId = ""
        currentSpeakerId = ""
        speakerSinceMillis = 0.0
        lastSwapMillis = StageOrderPolicy.neverSwappedMillis
        lastSpokeAt = [:]
        fitOverrides = [:]
        showsVideoOverActivity = false
        transientIds = []
        reactionIds = [:]
        recentEvents = []
        announcementLog = []
        announcedEntrySession = -1
        lastGameActive = false
        lastLiveNotes = LiveNotesState.off
        if kind != StageKind.solo { kind = StageKind.solo }
        if layout.withRevision(0) != StageLayoutSnapshot.empty {
            layout = StageLayoutSnapshot.empty.withRevision(layout.revision + 1)
        }
        if capsule != StageCapsuleModel.empty { capsule = StageCapsuleModel.empty }
        if localHand != LocalHandState.lowered { localHand = LocalHandState.lowered }
        if autoHideBlocker != AutoHideBlocker.none { autoHideBlocker = AutoHideBlocker.none }
        if chrome.withRevision(0) != StageChromeSnapshot.empty {
            chrome = StageChromeSnapshot.empty.withRevision(chrome.revision + 1)
        }
        if !reactions.events.isEmpty {
            reactions = StageReactionsSnapshot(revision: reactions.revision + 1, events: [], renderLimit: reactions.renderLimit)
        }
        if announcement != nil { announcement = nil }
    }

    // MARK: Rebuild

    private func rebuild() {
        let present = inputs.presentParticipants
        var presentIds: [String] = []
        for participant in present {
            presentIds.append(participant.userId)
        }
        remoteOrder = StageOrderPolicy.reconcile(previous: remoteOrder, participants: present)
        if !featuredUserId.isEmpty && !remoteOrder.contains(featuredUserId) {
            featuredUserId = ""
        }
        if featuredUserId.isEmpty {
            featuredUserId = StageOrderPolicy.defaultFeatured(remoteOrder: remoteOrder, presenterUserId: inputs.screenShareUserId,
                                                              localUserId: inputs.localUserId)
        }
        let nextKind = StageLayoutPolicy.kind(inputs, showsVideoOverActivity: showsVideoOverActivity)
        let capacity = StageLayoutPolicy.capacity(viewport: viewport, kind: nextKind, count: present.count,
                                                  viewMaxTiles: inputs.viewMaxTiles)
        let keepSpeaker = currentSpeakerId.isEmpty ? featuredUserId : currentSpeakerId
        let filtered = StageOrderPolicy.applyHideFilter(remoteOrder, participants: present,
                                                        hideTilesWithoutVideo: inputs.hideTilesWithoutVideo,
                                                        featuredUserId: keepSpeaker, pinnedUserId: inputs.pinnedUserId)
        let plan = StageOrderPolicy.plan(StageSlotPlanInputs(
            kind: nextKind,
            isCompactPortrait: StageLayoutPolicy.isCompactPortrait(viewport),
            capacity: capacity,
            localUserId: inputs.localUserId,
            remoteOrder: filtered,
            participants: present,
            pinnedUserId: inputs.pinnedUserId,
            featuredUserId: featuredUserId,
            presenterUserId: inputs.screenShareUserId,
            selfViewMode: inputs.selfViewMode,
            webinarSpeakerUserId: inputs.webinarSpeakerUserId,
            fitOverrides: fitOverrides
        ))
        let activity = activityKind()
        let corner = inputs.isEffectsOpen ? "top-right" : inputs.selfViewCorner
        let candidate = StageLayoutSnapshot(
            revision: layout.revision,
            kind: nextKind,
            slots: plan.slots,
            overflowCount: plan.overflowCount,
            overflowSeeds: plan.overflowSeeds,
            capacity: capacity,
            pinnedUserId: inputs.pinnedUserId,
            featuredUserId: featuredUserId,
            presenterUserId: inputs.screenShareUserId,
            isLocalPresenting: inputs.isLocalScreenSharing,
            selfMode: inputs.selfViewMode,
            selfCorner: corner,
            activityKind: activity,
            hiddenActivityKind: showsVideoOverActivity ? activity : "",
            showsVideoOverActivity: showsVideoOverActivity,
            isAloneConfirmed: inputs.isAloneConfirmed,
            meetingLink: inputs.meetingLink
        )
        if candidate != layout {
            layout = candidate.withRevision(layout.revision + 1)
        }
        if kind != nextKind { kind = nextKind }

        for participant in present {
            tileChrome.write(tileModel(participant))
        }
        tileChrome.prune(keeping: presentIds)
        speaking.prune(keeping: presentIds)
        writeBindings(plan.slots, present: present)

        let nextCapsule = capsuleModel(present)
        if nextCapsule != capsule { capsule = nextCapsule }
        let nextChrome = chromeSnapshot(present, activity: activity)
        if nextChrome != chrome.withRevision(0) {
            chrome = nextChrome.withRevision(chrome.revision + 1)
        }
        let hand = StagePresenter.handState(isRaised: inputs.isHandRaised, inFlight: inputs.handToggleInFlight)
        if hand != localHand { localHand = hand }
        recomputeBlocker()
    }

    private func writeBindings(_ slots: [StageSlot], present: [StageParticipantInput]) {
        var slotIds: [String] = []
        for slot in slots {
            if !slot.role.hostsRenderer || slot.userId.isEmpty { continue }
            slotIds.append(slot.id)
            let row = StageOrderPolicy.participant(slot.userId, in: present)
            let key = slot.id.hasPrefix("share:") ? (row?.shareVideoKey ?? "") : (row?.videoKey ?? "")
            bindings.write(slotId: slot.id, videoKey: key)
        }
        bindings.prune(keeping: slotIds)
    }

    private func tileModel(_ participant: StageParticipantInput) -> TileChromeModel {
        TileChromeModel(
            userId: participant.userId,
            displayName: participant.displayName,
            avatarSeed: FacehashPresentation.seed(name: participant.displayName, id: participant.userId),
            isLocal: participant.isLocal,
            isMuted: participant.isMuted,
            isCameraOff: participant.isCameraOff,
            isHandRaised: participant.isHandRaised,
            isPinned: !inputs.pinnedUserId.isEmpty && participant.userId == inputs.pinnedUserId,
            isPresenting: !inputs.screenShareUserId.isEmpty && participant.userId == inputs.screenShareUserId,
            isWeakConnection: participant.isWeakConnection,
            isReconnecting: participant.isReconnecting,
            reconnectReason: participant.reconnectReason,
            isHost: participant.isHost,
            isVoiceAgent: participant.isVoiceAgent
        )
    }

    private func capsuleModel(_ present: [StageParticipantInput]) -> StageCapsuleModel {
        let count = max(1, present.count)
        var kind = StageCapsuleModel.countKind
        var name = ""
        if inputs.isLocalScreenSharing {
            kind = StageCapsuleModel.youPresentingKind
        } else if !inputs.screenShareUserId.isEmpty && inputs.screenShareUserId != inputs.localUserId {
            kind = StageCapsuleModel.presentingKind
            name = StageOrderPolicy.participant(inputs.screenShareUserId, in: present)?.displayName ?? ""
        } else if count <= 1 {
            kind = StageCapsuleModel.aloneKind
        }
        return StageCapsuleModel(title: inputs.roomLabel, subtitleKind: kind, subtitleName: name, count: count,
                                 isLocked: inputs.isRoomLocked, captionsOn: inputs.captionsOn, liveNotes: inputs.liveNotes)
    }

    private func chromeSnapshot(_ present: [StageParticipantInput], activity: String) -> StageChromeSnapshot {
        let local = StageOrderPolicy.participant(inputs.localUserId, in: present)
        let cameraOn = !(local?.isCameraOff ?? true)
        var nowPlaying: NowPlayingChip? = nil
        if showsVideoOverActivity && !activity.isEmpty {
            nowPlaying = NowPlayingChip(kind: activity, name: activityName(activity))
        }
        return StageChromeSnapshot(revision: 0, canFlipCamera: inputs.canFlipCamera && cameraOn, isFrontCamera: inputs.isFrontCamera,
                                   nowPlaying: nowPlaying, routeKind: inputs.routeKind, routeName: inputs.routeName,
                                   isAttendee: inputs.isWebinarAttendee)
    }

    /// The highest-priority running activity (D17: app, then shared browser, then game).
    private func activityKind() -> String {
        if !inputs.activeAppId.isEmpty { return "app" }
        if inputs.isBrowserActive { return "browser" }
        if inputs.isGameActive { return "game" }
        return ""
    }

    private func activityName(_ activity: String) -> String {
        switch activity {
        case "app": return inputs.activeAppName
        case "game": return inputs.gameName
        default: return ""
        }
    }

    static func handState(isRaised: Bool, inFlight: Bool) -> LocalHandState {
        if inFlight { return isRaised ? LocalHandState.lowering : LocalHandState.raising }
        return isRaised ? LocalHandState.raised : LocalHandState.lowered
    }

    /// The presenter's half of `AutoHideBlocker` (S20 8 f, j); the view adds the screen reader and keyboard focus.
    private func recomputeBlocker() {
        let next = presenterBlocker()
        if next != autoHideBlocker { autoHideBlocker = next }
    }

    private func presenterBlocker() -> AutoHideBlocker {
        if inputs.alwaysShowControls { return AutoHideBlocker.alwaysShow }
        if shell.panels.snapshot.current != nil || !transientIds.isEmpty { return AutoHideBlocker.panelOpen }
        if inputs.isRecovering { return AutoHideBlocker.reconnecting }
        if inputs.isMediaPending { return AutoHideBlocker.mediaPending }
        if inputs.isLocalScreenSharing { return AutoHideBlocker.presenting }
        if !hasRemoteVideoOrShare() { return AutoHideBlocker.noRemoteVideo }
        return AutoHideBlocker.none
    }

    private func hasRemoteVideoOrShare() -> Bool {
        if !inputs.screenShareUserId.isEmpty { return true }
        if inputs.isWebinarAttendee && !inputs.webinarSpeakerUserId.isEmpty { return true }
        for participant in inputs.participants {
            if !participant.isLocal && !participant.isLeaving && !participant.isCameraOff { return true }
        }
        return false
    }

    private func removeTransient(_ id: String) {
        if !transientIds.contains(id) { return }
        var next: [String] = []
        for existing in transientIds {
            if existing != id { next.append(existing) }
        }
        transientIds = next
        recomputeBlocker()
    }

    // MARK: Announcements and outcome tokens

    /// "Joined %@" once per call session when the stage first shows (S20 1 g).
    private func publishEntryAnnouncement() {
        if !inputs.isInCall || announcedEntrySession == inputs.callSession { return }
        announcedEntrySession = inputs.callSession
        announce(kind: StageAnnouncement.joinedKind, name: inputs.roomLabel)
    }

    func announce(kind: String, name: String) {
        nextAnnouncementId += 1
        announcement = StageAnnouncement(id: nextAnnouncementId, kind: kind, name: name)
        announcementLog.append(kind + ":" + name)
        if announcementLog.count > 5 { announcementLog.removeFirst() }
    }

    /// `gameStarted` when game presence becomes true; `transcriptionStarted` when live notes become live from off or
    /// starting; `transcriptionStopped` when they leave live (S20 0.5 token table, RECONCILE R12).
    private func publishFeedbackTransitions() {
        if inputs.isGameActive && !lastGameActive {
            advanceFeedback(FeedbackKind.gameStarted)
        }
        lastGameActive = inputs.isGameActive
        let notes = inputs.liveNotes
        if notes != lastLiveNotes {
            if notes == LiveNotesState.live && (lastLiveNotes == LiveNotesState.off || lastLiveNotes == LiveNotesState.starting) {
                advanceFeedback(FeedbackKind.transcriptionStarted)
            } else if lastLiveNotes == LiveNotesState.live {
                advanceFeedback(FeedbackKind.transcriptionStopped)
            }
            lastLiveNotes = notes
        }
    }

    private func advanceFeedback(_ kind: FeedbackKind) {
        feedbackState = MeetingShellFeedbackState(session: inputs.callSession,
                                                  token: FeedbackToken(sequence: feedbackState.token.sequence + 1, kind: kind))
    }

    // MARK: Promotion (SL2: one cancellable task, injectable clock and sleep)

    private func evaluatePromotion() {
        cancelPromotion()
        let candidate = promotionCandidate()
        if candidate.isEmpty { return }
        let delay = StageOrderPolicy.promotionDelay(nowMillis: now(), speakerSinceMillis: speakerSinceMillis,
                                                    lastSwapMillis: lastSwapMillis)
        pendingPromotionCandidate = candidate
        pendingPromotionDelayMillis = delay
        promotionTasksStarted += 1
        let wait = sleep
        promotionTask = Task { @MainActor [weak self] in
            await wait(delay)
            if Task.isCancelled { return }
            guard let self = self else { return }
            self.promotionTask = nil
            self.firePendingPromotion()
        }
    }

    /// What the promotion task runs after its sleep (tests call it after advancing the injected clock).
    func firePendingPromotion() {
        let candidate = pendingPromotionCandidate
        pendingPromotionCandidate = ""
        if candidate.isEmpty || candidate != currentSpeakerId || promotionCandidate() != candidate { return }
        let at = now()
        if !StageOrderPolicy.mayPromote(nowMillis: at, speakerSinceMillis: speakerSinceMillis, lastSwapMillis: lastSwapMillis) {
            evaluatePromotion()
            return
        }
        if layout.kind == StageKind.grid {
            let visible = StageOrderPolicy.visibleRemoteIds(layout.slots, localUserId: inputs.localUserId)
            let target = StageOrderPolicy.swapTarget(visibleRemoteIds: visible, lastSpokeAt: lastSpokeAt,
                                                     participants: inputs.presentParticipants,
                                                     protected: [inputs.pinnedUserId, inputs.screenShareUserId])
            guard let demote = target else { return }
            remoteOrder = StageOrderPolicy.swapped(remoteOrder, promote: candidate, demote: demote)
        } else {
            featuredUserId = candidate
        }
        lastSwapMillis = at
        rebuild()
    }

    /// The speaker who should move: a hidden remote in an overflowing grid of 4 or more, or a remote who is not the
    /// featured speaker in spotlight or sidebar without a pin. Empty when nobody should.
    private func promotionCandidate() -> String {
        let id = currentSpeakerId
        if id.isEmpty || id == inputs.localUserId || inputs.participant(id) == nil { return "" }
        switch layout.kind {
        case .grid:
            if layout.overflowCount == 0 || inputs.presentParticipants.count < StageOrderPolicy.minimumParticipantsForSwap {
                return ""
            }
            let visible = StageOrderPolicy.visibleRemoteIds(layout.slots, localUserId: inputs.localUserId)
            return visible.contains(id) ? "" : id
        case .spotlight, .sidebar:
            if !inputs.pinnedUserId.isEmpty { return "" }
            return id == featuredUserId ? "" : id
        default:
            return ""
        }
    }

    private func cancelPromotion() {
        promotionTask?.cancel()
        promotionTask = nil
        pendingPromotionCandidate = ""
    }
}
