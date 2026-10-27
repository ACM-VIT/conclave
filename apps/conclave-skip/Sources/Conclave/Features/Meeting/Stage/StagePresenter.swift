import Foundation
import Observation

/// S20 0.5 (SL3): the one session-owned stage presenter, created with the S1 `MeetingShellPresenter` and reset with
/// it (S1C 3.2, 3.3 TEAR). The core pushes `StageInputs` through `apply(_:)` on its own refresh path (SC1) and the hot
/// values through `speakerChanged` and `reactionsChanged`; the presenter never observes the core (SkipModel has no
/// `withObservationTracking`). Every hot or narrowly read value is its own stored property and per-tile state lives in
/// the SL4 stores, so a speaker change, a mute, a consumer swap or a reaction re-evaluates only the leaf that shows it.
///
/// Extension points for later slices (keep per-feature state here, not in the views): STG-6 adds `meetingInfo`; STG-8
/// adds `attendee`; STG-2 adds the tile menu and pin announcements. Requests against this file name the property they
/// add. STG-5 (S20 10) added the notice lanes: `banner`, `toast`, `queuedToasts` and `noticeGeometry` from the
/// `MeetingNoticeCenter` (state through `applyNotices`, events through `post`, presenter toasts through `postLocal`),
/// the host notice sounds (`sounds`) and, with TRN-1, the captions leaf (`captions`, `captionsActive`).
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
    /// S20 13 d, SC11 (STG-7): the slot the system PiP window shows (share > pin > featured speaker with camera > first
    /// remote with video > first remote; never you). The visibility reporters and the iOS PiP anchor read it; it
    /// republishes only when the choice changes.
    private(set) var pipTarget: PipTargetChoice = PipTargetChoice.none
    /// STG-5 (S20 10, SL10): the one banner and the one toast the lanes show, and how many toasts wait. Each lane
    /// observes only its own property (S20 10 k).
    private(set) var banner: MeetingNotice? = nil
    private(set) var toast: MeetingNotice? = nil
    private(set) var queuedToasts: Int = 0
    /// Where the lanes sit (cold: it changes with the viewport, the status chips and a bottom-corner self view).
    private(set) var noticeGeometry: NoticeLaneGeometry = NoticeLaneGeometry.zero
    /// TRN-1 (SC13): captions are on and live notes are live for a non-attendee in the call, so the strip mounts.
    private(set) var captionsActive: Bool = false
    /// Stage outcome tokens (S1 shape); this presenter is the only publisher of the S20 kinds (RECONCILE R12).
    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    @ObservationIgnored let tileChrome = TileChromeStore()
    @ObservationIgnored let speaking = TileSpeakingStore()
    @ObservationIgnored let bindings = RendererBindingStore()
    /// S20 SC11, S70 R70-10 (STG-7): decoded frame sizes per renderer slot, reported by the platform renderers through
    /// `EnvironmentValues.rendererFrameSizes` (iOS) and `LocalRendererFrameSizes` (Android), which the call root provides.
    @ObservationIgnored let frameSizes = RendererFrameSizeStore()
    @ObservationIgnored let shell: MeetingShellPresenter
    /// STG-5: the notice queue, banner choice and dismissals (pure rules in `MeetingNoticePolicy`).
    @ObservationIgnored let notices = MeetingNoticeCenter()
    /// SC24: host knock and hand chimes; plays only through an output the native call root installs on the live route.
    @ObservationIgnored let sounds = NoticeSoundPlayer()
    /// TRN-1 (S60 5): the captions strip's leaf; fed by `captionChanged(_:)`.
    @ObservationIgnored let captions = CaptionLineFeed()

    /// Core only: the view model performs pin, self view and camera actions (the S1 `onCommand` pattern).
    @ObservationIgnored var onCommand: ((StageCommand) -> Void)? = nil
    /// Core only: SC6 consumer policy and SC7 obscured flag, called once per changed report.
    @ObservationIgnored var onVisibilityChanged: ((StageVisibilityReport) -> Void)? = nil
    /// Core only (STG-9): the activity on the card after each rebuild ("" while none or while video shows); the
    /// activity session forwards it to the launcher's Now Playing `isOnStage`. Called only when it changes.
    @ObservationIgnored var onActivityResolved: ((String) -> Void)? = nil
    /// Core only (STG-5): notice actions the view model performs (admit, audio-only, Retry Now, settings, resume, ...).
    @ObservationIgnored var onNoticeCommand: ((NoticeCommand) -> Void)? = nil
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
    /// STG-9: the local Show choice on the Now Playing chip or the Activities panel (presenter-local, reset when that
    /// activity ends), the live set the announcements compare against, and the last card reported to the core.
    @ObservationIgnored private var preferredActivityKind = ""
    @ObservationIgnored private var lastLiveActivities: [String] = []
    @ObservationIgnored private var hasActivityBaseline = false
    @ObservationIgnored private var lastResolvedOnStage = "~"
    @ObservationIgnored private var lastActivityAppId = ""
    @ObservationIgnored private var lastActivityGameName = ""
    @ObservationIgnored private var transientIds: [String] = []
    @ObservationIgnored private var promotionTask: Task<Void, Never>? = nil
    @ObservationIgnored private var reactionIds: [String: Int] = [:]
    @ObservationIgnored private var nextReactionId = 0
    @ObservationIgnored private var nextAnnouncementId = 0
    @ObservationIgnored private var announcedEntrySession = -1
    @ObservationIgnored private var lastGameActive = false
    @ObservationIgnored private var lastLiveNotes = LiveNotesState.off
    @ObservationIgnored private var noticeExpiryTask: Task<Void, Never>? = nil
    @ObservationIgnored private var noticeExpiryDeadline = 0.0
    /// Diagnostics: how many notice input sets were accepted (equal sets are skipped).
    @ObservationIgnored private(set) var noticeApplyCount = 0

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
        // STG-2: "Pinned %@" and "%@ left. Spotlight follows the speaker." (TileFeaturePolicy; never on the first
        // snapshot of a call, so the entry announcement keeps the one-shot channel).
        let pinAnnouncement = TileFeaturePolicy.pinAnnouncement(previous: inputs, next: next)
        inputs = next
        rebuild()
        publishFeedbackTransitions()
        publishEntryAnnouncement()
        if !pinAnnouncement.kind.isEmpty {
            announce(kind: pinAnnouncement.kind, name: pinAnnouncement.name)
        }
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

    /// Core only (SC18): one-shot events. The recent ones stay for the readout; the notice center turns them into toasts
    /// (suppression, coalescing and the Q4 thresholds live in `MeetingNoticePolicy`), moderation and role events
    /// publish their outcome tokens, a new remote hand may request a chime, and `hostNotice` latches the host banner.
    func post(_ event: StageEvent) {
        recentEvents.append(event)
        if recentEvents.count > StagePresenter.recentEventLimit {
            recentEvents.removeFirst()
        }
        if let token = MeetingNoticePolicy.feedbackKind(forEvent: event.kind) {
            advanceFeedback(token)
        }
        requestChimes(notices.post(event, nowMillis: now()))
        publishNotices()
    }

    /// Core only: the S1 panel snapshot changed (open, close, replace). Folds a panel into the blocker and clears the
    /// bar hold when a panel opens (S30 CC16).
    func panelSnapshotChanged() {
        if shell.panels.snapshot.current != nil {
            removeTransient(ChromeAutoHidePolicy.barHold)
        }
        recomputeBlocker()
        notices.setCurrentPanel(shell.panels.snapshot.current?.panel.rawValue ?? "", nowMillis: now())
        publishNotices()
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
        if let onCommand = onCommand { onCommand(StageCommand(kind: StageCommandKind.togglePin, userId: userId, value: "")) }
    }

    func clearPin() {
        if let onCommand = onCommand { onCommand(StageCommand(kind: StageCommandKind.clearPin, userId: "", value: "")) }
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
        if let onCommand = onCommand { onCommand(StageCommand(kind: StageCommandKind.setSelfViewMode, userId: "", value: raw)) }
    }

    func moveSelfView(toCorner raw: String) {
        onCommand?(StageCommand(kind: StageCommandKind.moveSelfView, userId: "", value: raw))
    }

    func flipCamera() {
        if let onCommand = onCommand { onCommand(StageCommand(kind: StageCommandKind.flipCamera, userId: "", value: "")) }
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

    /// The Now Playing chip's Show (S20 11 c): brings the card back while video shows, else moves the hidden activity
    /// onto the card for this person only.
    func showHiddenActivity() {
        let resolution = resolveActivities()
        preferredActivityKind = ActivityStagePolicy.preferenceAfterShowingHidden(resolution, currentPreference: preferredActivityKind)
        showsVideoOverActivity = false
        rebuild()
    }

    /// The Activities panel's Show for one running activity (S60 7 c, `ActivitiesPanel+iOS.swift`, `ActivitiesPage.kt`).
    func showActivity(kind: String) {
        if !ActivityStagePolicy.liveKinds(inputs).contains(kind) { return }
        preferredActivityKind = kind
        showsVideoOverActivity = false
        rebuild()
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
        frameSizes.removeAll()
        if !pipTarget.isEmpty { pipTarget = PipTargetChoice.none }
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
        preferredActivityKind = ""
        lastLiveActivities = []
        hasActivityBaseline = false
        lastResolvedOnStage = "~"
        lastActivityAppId = ""
        lastActivityGameName = ""
        transientIds = []
        reactionIds = [:]
        recentEvents = []
        announcementLog = []
        announcedEntrySession = -1
        lastGameActive = false
        lastLiveNotes = LiveNotesState.off
        cancelNoticeExpiry()
        notices.reset()
        sounds.reset()
        captions.reset()
        publishNotices()
        if captionsActive { captionsActive = false }
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
        let activityResolution = resolveActivities()
        var nextKind = StageLayoutPolicy.kind(inputs, showsVideoOverActivity: activityResolution.showsVideoOverActivity)
        if nextKind.isActivity, let card = activityResolution.stageKind { nextKind = card }
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
            activityKind: activityResolution.activityKind,
            hiddenActivityKind: activityResolution.hiddenActivityKind,
            showsVideoOverActivity: activityResolution.showsVideoOverActivity,
            isAloneConfirmed: inputs.isAloneConfirmed,
            meetingLink: inputs.meetingLink
        )
        if candidate != layout {
            layout = candidate.withRevision(layout.revision + 1)
        }
        if kind != nextKind { kind = nextKind }
        let nextPip = PipTargetPolicy.choose(inputs: inputs, layout: layout)
        if nextPip != pipTarget { pipTarget = nextPip }

        for participant in present {
            tileChrome.write(tileModel(participant))
        }
        tileChrome.prune(keeping: presentIds)
        speaking.prune(keeping: presentIds)
        writeBindings(plan.slots, present: present)

        let nextCapsule = capsuleModel(present)
        if nextCapsule != capsule { capsule = nextCapsule }
        let nextChrome = chromeSnapshot(present, chip: activityResolution.chip)
        if nextChrome != chrome.withRevision(0) {
            chrome = nextChrome.withRevision(chrome.revision + 1)
        }
        let hand = StagePresenter.handState(isRaised: inputs.isHandRaised, inFlight: inputs.handToggleInFlight)
        if hand != localHand { localHand = hand }
        recomputeBlocker()
        let chips = statusChipsVisible(present)
        let geometry = NoticeLaneGeometryPolicy.geometry(viewport: viewport, frames: currentFrames(), slots: layout.slots,
                                                         chipsVisible: chips)
        if geometry != noticeGeometry { noticeGeometry = geometry }
        updateCaptionsActive()
        publishActivityChanges(activityResolution)
    }

    /// The status chips row under the top chrome (hand, Now Playing, Share Invite; S20 7): the banner sits below it.
    private func statusChipsVisible(_ present: [StageParticipantInput]) -> Bool {
        if localHand != LocalHandState.lowered || chrome.nowPlaying != nil { return true }
        if layout.kind == StageKind.solo && layout.isAloneConfirmed && !layout.meetingLink.isEmpty {
            let local = StageOrderPolicy.participant(inputs.localUserId, in: present)
            return !(local?.isCameraOff ?? true)
        }
        return false
    }

    /// TRN-1 (S60 5 f): the strip mounts only while captions are on and notes are live; it never mounts for attendees.
    private func updateCaptionsActive() {
        let active = inputs.isInCall && !inputs.isWebinarAttendee && inputs.captionsOn && inputs.liveNotes == LiveNotesState.live
        if active == captionsActive { return }
        captionsActive = active
        if active {
            captions.begin()
        } else {
            captions.reset()
        }
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

    private func chromeSnapshot(_ present: [StageParticipantInput], chip: NowPlayingChip?) -> StageChromeSnapshot {
        let local = StageOrderPolicy.participant(inputs.localUserId, in: present)
        let cameraOn = !(local?.isCameraOff ?? true)
        return StageChromeSnapshot(revision: 0, canFlipCamera: inputs.canFlipCamera && cameraOn, isFrontCamera: inputs.isFrontCamera,
                                   nowPlaying: chip, routeKind: inputs.routeKind, routeName: inputs.routeName,
                                   isAttendee: inputs.isWebinarAttendee)
    }

    /// STG-9 (S20 11): app, then browser, then game (D17), but a lower activity is never silently hidden (the chip
    /// names it), and the local Show and Show Video choices reset when their activity ends.
    private func resolveActivities() -> ActivityStageResolution {
        let live = ActivityStagePolicy.liveKinds(inputs)
        preferredActivityKind = ActivityStagePolicy.normalizedPreference(preferredActivityKind, live: live)
        showsVideoOverActivity = ActivityStagePolicy.normalizedShowsVideo(showsVideoOverActivity, live: live)
        return ActivityStagePolicy.resolve(live: live, preferredKind: preferredActivityKind,
                                           showsVideoOverActivity: showsVideoOverActivity,
                                           names: ActivityStageNames(appId: inputs.activeAppId, gameName: inputs.gameName))
    }

    /// One polite announcement per activity start and end (S20 11 g, i; never for what was already live when the
    /// stage first showed), and the card reported to the core when it changes.
    private func publishActivityChanges(_ resolution: ActivityStageResolution) {
        if hasActivityBaseline {
            let changes = ActivityStagePolicy.transitions(previous: lastLiveActivities, next: resolution.liveKinds)
            let names = ActivityStageNames(appId: inputs.activeAppId, gameName: inputs.gameName)
            for endedKind in changes.ended {
                let previousNames = ActivityStageNames(appId: lastActivityAppId, gameName: lastActivityGameName)
                announce(kind: ActivityStagePolicy.endedAnnouncement,
                         name: ActivityStagePolicy.announcementName(kind: endedKind, names: previousNames))
            }
            for startedKind in changes.started {
                announce(kind: ActivityStagePolicy.startedAnnouncement,
                         name: ActivityStagePolicy.announcementName(kind: startedKind, names: names))
            }
        } else if inputs.isInCall {
            hasActivityBaseline = true
        }
        lastLiveActivities = resolution.liveKinds
        if !inputs.activeAppId.isEmpty { lastActivityAppId = inputs.activeAppId }
        if !inputs.gameName.isEmpty { lastActivityGameName = inputs.gameName }
        if resolution.onStageKind != lastResolvedOnStage {
            lastResolvedOnStage = resolution.onStageKind
            onActivityResolved?(resolution.onStageKind)
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

    // MARK: Notices (STG-5: S20 10, SC5, SC18, SC24; TRN-1 captions)

    /// Core only (SC5): the notice state inputs, on the stage refresh path. Equal inputs are skipped.
    func applyNotices(_ next: StageNoticeInputs) {
        let previous = notices.inputs
        if next == previous && noticeApplyCount > 0 { return }
        noticeApplyCount += 1
        if previous.callSession != 0 && next.callSession != previous.callSession {
            cancelNoticeExpiry()
            notices.reset()
            sounds.reset()
        }
        let chimes = notices.applyState(next, nowMillis: now())
        requestChimes(chimes)
        // S70 R70-1: one-shot announcements when recovery starts (not within the foreground grace) and ends.
        if !previous.isRecovering && next.isRecovering && !next.isResumingFromBackground {
            announce(kind: StageNoticeAnnouncementKind.reconnecting, name: "")
        } else if previous.isRecovering && !next.isRecovering && noticeApplyCount > 1 {
            announce(kind: StageNoticeAnnouncementKind.reconnected, name: "")
        }
        publishNotices()
    }

    /// S30 CC7 and S50 PL14: presenter-originated toasts (blocked explanations, End progress and failures, route, lock
    /// and share failures, Link copied). A caller id is kept, so the caller can clear the notice later.
    func postLocal(_ notice: MeetingNotice) {
        notices.postLocal(notice, nowMillis: now())
        publishNotices()
    }

    /// The toast host when a toast leaves (timed out, acted on, swiped), and a banner's Dismiss. Progress toasts stay
    /// until their owner clears them.
    func dismissNotice(id: String) {
        let wasHostNotice = banner?.id == id && banner?.kind == NoticeKind.hostNotice
        notices.dismiss(id: id, nowMillis: now())
        if wasHostNotice {
            onNoticeCommand?(NoticeCommand(actionId: NoticeCommand.dismissHostNotice, noticeKind: NoticeKind.hostNotice,
                                           userId: "", detail: ""))
        }
        publishNotices()
    }

    /// The owner of a local notice removes it (an `endingForEveryone` progress toast once End resolves).
    func clearLocalNotice(id: String) {
        notices.clear(id: id)
        publishNotices()
    }

    /// One action on the banner or the toast (S20 10 j). People, Transcript, Activities, Chat and the S1 intents run
    /// here; the rest goes to the core through `onNoticeCommand`. A toast leaves after its action.
    func performNoticeAction(noticeId: String, actionId: String) {
        var target: MeetingNotice? = nil
        if let shown = banner, shown.id == noticeId { target = shown }
        if let shown = toast, shown.id == noticeId { target = shown }
        guard let notice = target, notice.hasAction(actionId) else { return }
        switch actionId {
        case NoticeAction.view:
            if notice.kind == NoticeKind.knock {
                openPeople(destination: PanelDestination.peopleWaiting)
            } else if notice.kind == NoticeKind.handRaised {
                openPeople(destination: PanelDestination.peopleRaisedHands)
            } else if notice.kind == NoticeKind.chatPreview {
                shell.panels.present(MeetingPanel.chat, from: PanelInvoker.call, destination: PanelDestination.chatMessage,
                                     targetId: notice.messageId)
            }
        case NoticeAction.catchUp:
            openTranscript(destination: PanelDestination.transcriptMinutes)
            notices.dismiss(id: notice.id, nowMillis: now())
        case NoticeAction.vote:
            openActivities(destination: PanelDestination.activitiesVote, targetId: "")
        case NoticeAction.stopSharing:
            shell.toggleScreenShare()
        case NoticeAction.notNow:
            notices.dismiss(id: notice.id, nowMillis: now())
        case NoticeAction.expand:
            return
        case NoticeAction.retry:
            retry(notice)
        default:
            onNoticeCommand?(NoticeCommand(actionId: actionId, noticeKind: notice.kind, userId: notice.userId,
                                           detail: notice.detail))
        }
        if notice.lane == NoticeLane.toast {
            notices.dismiss(id: notice.id, nowMillis: now())
        }
        publishNotices()
    }

    /// RECONCILE R3: the view reports whether a compact-width sheet or an Android full overlay covers the stage.
    func setToastLaneSuspended(_ suspended: Bool) {
        if suspended == notices.isToastLaneSuspended { return }
        notices.setToastLaneSuspended(suspended)
        publishNotices()
    }

    /// The native call root names its platform once (`NoticePlatform`).
    func setNoticePlatform(_ platform: String) {
        notices.setPlatform(platform, nowMillis: now())
        publishNotices()
    }

    /// TRN-1 hot hook (S60 5 j): the newest caption line from the transcript stream. Writes only the captions leaf, and
    /// only while the strip is mounted.
    func captionChanged(_ line: CaptionLine) {
        if !captionsActive { return }
        captions.update(line)
    }

    /// Ends the host notice once its visible time ran out (the expiry task calls it; tests call it after advancing the
    /// injected clock). A small tolerance absorbs a wake a hair before the deadline.
    func expireNoticeIfDue() {
        if notices.expireIfDue(nowMillis: now() + StagePresenter.noticeExpiryToleranceMillis) {
            publishNotices()
        }
    }

    static let noticeExpiryToleranceMillis = 250.0

    /// The `stage.notices` readout: banner and toast kinds, the queue and dropped counts.
    func noticesReadout() -> String {
        let shownBanner = banner?.kind ?? "none"
        let shownToast = toast?.kind ?? "none"
        return "banner=" + shownBanner + " toast=" + shownToast + " queued=" + String(queuedToasts) + " dropped="
            + String(notices.droppedToasts) + " suspended=" + (notices.isToastLaneSuspended ? "1" : "0") + " chimes="
            + String(sounds.playCount)
    }

    private func retry(_ notice: MeetingNotice) {
        if notice.kind == NoticeKind.actionFailed {
            switch notice.detail {
            case "hand":
                shell.toggleHand()
                return
            case "microphone":
                shell.toggleMicrophone()
                return
            case "camera":
                shell.toggleCamera()
                return
            case "screenShare":
                shell.toggleScreenShare()
                return
            default:
                break
            }
        }
        if notice.kind == NoticeKind.endFailed {
            // Retry re-requests the confirmation; End never runs without a fresh confirm (S30 4).
            shell.requestEndForEveryone(from: MeetingConfirmationInvoker.call)
            return
        }
        onNoticeCommand?(NoticeCommand(actionId: NoticeAction.retry, noticeKind: notice.kind, userId: notice.userId,
                                       detail: notice.detail))
    }

    private func requestChimes(_ kinds: [String]) {
        if kinds.isEmpty { return }
        let gate = NoticeSoundGate.from(notices.inputs)
        for kind in kinds {
            sounds.request(kind, gate: gate)
        }
    }

    /// Mirrors the center into the published properties (equality guarded) and keeps the one expiry task in step with
    /// the shown banner.
    private func publishNotices() {
        let nextBanner = notices.banner
        if nextBanner != banner { banner = nextBanner }
        let nextToast = notices.toast
        if nextToast != toast { toast = nextToast }
        let waiting = notices.queue.count
        if waiting != queuedToasts { queuedToasts = waiting }
        let deadline = nextBanner?.expiresAtMillis ?? 0.0
        if deadline != noticeExpiryDeadline {
            cancelNoticeExpiry()
            noticeExpiryDeadline = deadline
            if deadline > 0 { armNoticeExpiry(deadline) }
        }
    }

    private func armNoticeExpiry(_ deadline: Double) {
        let wait = max(0.0, deadline - now())
        let delay = sleep
        noticeExpiryTask = Task { @MainActor [weak self] in
            await delay(wait)
            if Task.isCancelled { return }
            guard let self = self else { return }
            self.noticeExpiryTask = nil
            self.expireNoticeIfDue()
        }
    }

    private func cancelNoticeExpiry() {
        noticeExpiryTask?.cancel()
        noticeExpiryTask = nil
        noticeExpiryDeadline = 0.0
    }

    var hasLiveNoticeExpiryTask: Bool { noticeExpiryTask != nil }

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
            // STG-2: never while pinned, never the current featured speaker, and a camera-off speaker only when no
            // remote has video. Timing stays in the single promotion task (1.2 s hold, 8 s interval).
            return TileFeaturePolicy.spotlightCandidate(speakerUserId: id, featuredUserId: featuredUserId,
                                                        pinnedUserId: inputs.pinnedUserId,
                                                        participants: inputs.presentParticipants)
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
