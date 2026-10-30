import Foundation
import Observation

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

    private(set) var pipTarget: PipTargetChoice = PipTargetChoice.none

    private(set) var banner: MeetingNotice? = nil
    private(set) var toast: MeetingNotice? = nil
    private(set) var queuedToasts: Int = 0

    private(set) var noticeGeometry: NoticeLaneGeometry = NoticeLaneGeometry.zero

    private(set) var chipRowVisible: Bool = false

    private(set) var alone: StageAloneSnapshot? = nil

    private(set) var captionsActive: Bool = false

    private(set) var meetingInfo: MeetingInfoSnapshot? = nil

    private(set) var attendee: AttendeeViewerSnapshot? = nil

    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    @ObservationIgnored let tileChrome = TileChromeStore()
    @ObservationIgnored let speaking = TileSpeakingStore()
    @ObservationIgnored let bindings = RendererBindingStore()

    @ObservationIgnored let frameSizes = RendererFrameSizeStore()
    @ObservationIgnored let shell: MeetingShellPresenter

    @ObservationIgnored let notices = MeetingNoticeCenter()

    @ObservationIgnored let sounds = NoticeSoundPlayer()

    @ObservationIgnored let captions = CaptionLineFeed()

    @ObservationIgnored let layoutPanel = LayoutPanelPresenter()

    @ObservationIgnored let effects = EffectsPresenter(scope: EffectsScope.call)

    @ObservationIgnored var effectsPlatform: EffectsPlatform = EffectsPlatform.current

    @ObservationIgnored var onCommand: ((StageCommand) -> Void)? = nil

    @ObservationIgnored var onVisibilityChanged: ((StageVisibilityReport) -> Void)? = nil

    @ObservationIgnored var onActivityResolved: ((String) -> Void)? = nil

    @ObservationIgnored var onNoticeCommand: ((NoticeCommand) -> Void)? = nil

    @ObservationIgnored weak var people: PeoplePresenter? = nil

    @ObservationIgnored var chatPreviewsEnabled: () -> Bool = { VoicePreferences.showsChatPreviews() }

    @ObservationIgnored var now: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    @ObservationIgnored private(set) var inputs = StageInputs.make()
    @ObservationIgnored private(set) var viewport = StageViewport.zero
    @ObservationIgnored private(set) var toastHeight = 0.0
    @ObservationIgnored private(set) var visibility = StageVisibilityReport.none

    @ObservationIgnored private(set) var hasVisibilityReport = false

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

    @ObservationIgnored private(set) var noticeApplyCount = 0

    @ObservationIgnored private(set) var details = StageDetailsInputs.make()
    @ObservationIgnored private(set) var detailsApplyCount = 0
    @ObservationIgnored private(set) var connectionLabel = ConnectionQualityLabel.measuring
    @ObservationIgnored private(set) var attendeeFeed = AttendeeFeed.none
    @ObservationIgnored private var lastAttendeeState = ""
    @ObservationIgnored private var announcedWebinarLiveSession = -1
    @ObservationIgnored private var meetingInfoOpening = false

    @ObservationIgnored private(set) var isEffectsPanelShown = false

    static let recentEventLimit = 20

    init(shell: MeetingShellPresenter) {
        self.shell = shell
    }

    func apply(_ next: StageInputs) {
        applyCount += 1

        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            reset()
        }

        let pinAnnouncement = TileFeaturePolicy.pinAnnouncement(previous: inputs, next: next)

        let shareToken = ShareAnnouncementPolicy.localShareFeedback(previous: inputs, next: next)
        let startedPresenter = ShareAnnouncementPolicy.startedPresenterName(previous: inputs, next: next)

        let demoted = AttendeeViewerPolicy.isDemotion(previous: inputs, next: next)
        inputs = next
        rebuild()
        publishFeedbackTransitions()
        publishEntryAnnouncement()
        if !pinAnnouncement.kind.isEmpty {
            announce(kind: pinAnnouncement.kind, name: pinAnnouncement.name)
        }
        if let token = shareToken {
            advanceFeedback(token)
        }
        if !startedPresenter.isEmpty {
            announce(kind: ShareAnnouncementPolicy.presentingKind, name: startedPresenter)
        }
        if demoted {
            announce(kind: AttendeeViewerPolicy.demotedAnnouncement, name: "")
        }
    }

    func speakerChanged(_ canonicalUserId: String?, atMillis: Double) {
        let id = canonicalUserId ?? ""
        if id == currentSpeakerId { return }
        currentSpeakerId = id
        speakerSinceMillis = atMillis
        speaking.setSpeaker(id)
        if !id.isEmpty { lastSpokeAt[id] = atMillis }
        if inputs.hideTilesWithoutVideo {

            rebuild()
        }
        evaluatePromotion()
    }

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

    func post(_ event: StageEvent) {
        recentEvents.append(event)
        if recentEvents.count > StagePresenter.recentEventLimit {
            recentEvents.removeFirst()
        }
        if let token = MeetingNoticePolicy.feedbackKind(forEvent: event.kind) {
            advanceFeedback(token)
        }
        let showsPreviews = event.kind == StageEventKind.chatPreview ? chatPreviewsEnabled() : true
        requestChimes(notices.post(event, nowMillis: now(), showsChatPreviews: showsPreviews))
        publishNotices()
    }

    func clearChatPreviews() {
        notices.clearChatPreviews()
        publishNotices()
    }

    func dropChatPreviews(fromUserId userId: String) {
        notices.dropChatPreviews(fromUserId: userId)
        publishNotices()
    }

    func chatPreviewReadout() -> String {
        ChatPreviewPolicy.readout(toast)
    }

    func panelSnapshotChanged() {
        if shell.panels.snapshot.current != nil {
            removeTransient(ChromeAutoHidePolicy.barHold)
        }
        recomputeBlocker()
        notices.setCurrentPanel(shell.panels.snapshot.current?.panel.rawValue ?? "", nowMillis: now())
        publishNotices()

        refreshMeetingInfo()

        let snapshot = shell.panels.snapshot
        let effectsShown = snapshot.current?.panel == MeetingPanel.effects && !snapshot.isDismissing
        if effectsShown != isEffectsPanelShown {
            isEffectsPanelShown = effectsShown
            rebuild()
        }
    }

    func setViewport(_ next: StageViewport) {
        if next == viewport { return }
        viewport = next
        viewportChangeCount += 1
        rebuild()
    }

    func reportVisibility(_ report: StageVisibilityReport) {
        if report == visibility && hasVisibilityReport { return }
        hasVisibilityReport = true
        visibility = report
        onVisibilityChanged?(report)
    }

    func currentFrames() -> [StageFrame] {
        StageLayoutPolicy.frames(viewport: viewport, kind: layout.kind, slots: layout.slots, selfCorner: layout.selfCorner)
    }

    func layoutReadout() -> String {
        "rev=" + String(layout.revision) + " hash=" + String(StageLayoutPolicy.frameHash(currentFrames()))
    }

    func togglePin(userId: String) {
        if let onCommand = onCommand { onCommand(StageCommand(kind: StageCommandKind.togglePin, userId: userId, value: "")) }
    }

    func clearPin() {
        if let onCommand = onCommand { onCommand(StageCommand(kind: StageCommandKind.clearPin, userId: "", value: "")) }
    }

    func setFit(_ fit: StageVideoFit, userId: String) {
        setSlotFit(fit, slotId: StageSlot.participantId(userId))
    }

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

    func openMeetingInfo() {
        meetingInfoOpening = true
        refreshMeetingInfo()
        meetingInfoOpening = false
        shell.panels.present(MeetingPanel.meetingInfo, from: PanelInvoker.call)
    }

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

    func setTransientChrome(id: String, open: Bool) {
        if open {
            if transientIds.contains(id) { return }
            transientIds.append(id)
            recomputeBlocker()
        } else {
            removeTransient(id)
        }
    }

    var transientChromeSummary: String {
        if transientIds.isEmpty { return "none" }
        return transientIds.sorted().joined(separator: " ")
    }

    func stageTapped() {
        removeTransient(ChromeAutoHidePolicy.barHold)
    }

    func noteControlAction() {
        removeTransient(ChromeAutoHidePolicy.barHold)
    }

    func setShowsVideoOverActivity(_ on: Bool) {
        if showsVideoOverActivity == on { return }
        showsVideoOverActivity = on
        rebuild()
    }

    func showHiddenActivity() {
        let resolution = resolveActivities()
        preferredActivityKind = ActivityStagePolicy.preferenceAfterShowingHidden(resolution, currentPreference: preferredActivityKind)
        showsVideoOverActivity = false
        rebuild()
    }

    func showActivity(kind: String) {
        if !ActivityStagePolicy.liveKinds(inputs).contains(kind) { return }
        preferredActivityKind = kind
        showsVideoOverActivity = false
        rebuild()
    }

    func lowerHand() {
        if localHand == LocalHandState.raised {
            shell.toggleHand()
        }
    }

    var recentJoinHoldUntilMillis: Double {
        inputs.joinedAtMillis > 0 ? inputs.joinedAtMillis + ChromeAutoHidePolicy.recentJoinHoldMillis : 0.0
    }

    var speakerUserId: String { currentSpeakerId }

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
        details = StageDetailsInputs.make()
        detailsApplyCount = 0
        connectionLabel = ConnectionQualityLabel.measuring
        attendeeFeed = AttendeeFeed.none
        lastAttendeeState = ""
        announcedWebinarLiveSession = -1
        meetingInfoOpening = false
        isEffectsPanelShown = false
        if meetingInfo != nil { meetingInfo = nil }
        if attendee != nil { attendee = nil }
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
        if alone != nil { alone = nil }
        if chipRowVisible { chipRowVisible = false }
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

        attendeeFeed = inputs.isWebinarAttendee ? AttendeeViewerPolicy.feed(inputs) : AttendeeFeed.none
        if inputs.isWebinarAttendee { nextKind = AttendeeViewerPolicy.kind(attendeeFeed) }
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

        let corner = EffectsSelfViewPolicy.corner(selfViewCorner: inputs.selfViewCorner,
                                                  lifted: EffectsSelfViewPolicy.liftsSelfView(platform: effectsPlatform,
                                                                                              isEffectsOpen: inputs.isEffectsOpen || isEffectsPanelShown))

        let attendeeSlots = AttendeeViewerPolicy.slots(attendeeFeed, fitOverrides: fitOverrides)
        let candidate = StageLayoutSnapshot(
            revision: layout.revision,
            kind: nextKind,
            slots: inputs.isWebinarAttendee ? attendeeSlots : plan.slots,
            overflowCount: inputs.isWebinarAttendee ? 0 : plan.overflowCount,
            overflowSeeds: inputs.isWebinarAttendee ? [] : plan.overflowSeeds,
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
        let nextAlone = StageAlonePolicy.snapshot(inputs, kind: nextKind)
        if nextAlone != alone { alone = nextAlone }
        let nextPip = PipTargetPolicy.choose(inputs: inputs, layout: layout)
        if nextPip != pipTarget { pipTarget = nextPip }

        for participant in present {
            tileChrome.write(tileModel(participant))
        }
        tileChrome.prune(keeping: presentIds)
        speaking.prune(keeping: presentIds)
        writeBindings(layout.slots, present: present)

        let nextCapsule = capsuleModel(present)
        if nextCapsule != capsule { capsule = nextCapsule }
        let nextChrome = chromeSnapshot(present, chip: activityResolution.chip)
        if nextChrome != chrome.withRevision(0) {
            chrome = nextChrome.withRevision(chrome.revision + 1)
        }
        let hand = StagePresenter.handState(isRaised: inputs.isHandRaised, inFlight: inputs.handToggleInFlight)
        if hand != localHand {

            if localHand == LocalHandState.raising && hand == LocalHandState.raised {
                announce(kind: StageAnnouncement.handRaisedKind, name: "")
            } else if localHand == LocalHandState.lowering && hand == LocalHandState.lowered {
                announce(kind: StageAnnouncement.handLoweredKind, name: "")
            }
            localHand = hand
        }
        recomputeBlocker()
        let chips = statusChipsVisible()
        if chips != chipRowVisible { chipRowVisible = chips }
        refreshNoticeGeometry()
        updateCaptionsActive()
        publishActivityChanges(activityResolution)
        refreshAttendee()
        refreshMeetingInfo()

        layoutPanel.apply(layoutPanelInputs())
    }

    func layoutPanelInputs() -> LayoutPanelInputs {
        var selfFloating = false
        for slot in layout.slots where slot.userId == inputs.localUserId {
            if slot.role == StageSlotRole.selfFloating || slot.role == StageSlotRole.selfMinimized { selfFloating = true }
        }
        let phone = viewport.isEmpty || StageLayoutPolicy.isCompactPortrait(viewport) || StageLayoutPolicy.isCompactHeight(viewport)
        let pinned = !inputs.pinnedUserId.isEmpty && inputs.participant(inputs.pinnedUserId) != nil
        return LayoutPanelInputs.make(callSession: inputs.callSession, viewMode: inputs.viewMode, viewMaxTiles: inputs.viewMaxTiles,
                                      hideTilesWithoutVideo: inputs.hideTilesWithoutVideo, selfViewMode: inputs.selfViewMode,
                                      selfViewCorner: inputs.selfViewCorner, isAudioOnly: notices.inputs.isAudioOnly,
                                      isPhone: phone, isPinActive: pinned, isSelfFloating: selfFloating,
                                      isAttendee: inputs.isWebinarAttendee)
    }

    private func statusChipsVisible() -> Bool {
        localHand != LocalHandState.lowered || chrome.nowPlaying != nil
    }

    func setToastHeight(_ height: Double) {
        let next = max(0.0, height)
        if next == toastHeight { return }
        toastHeight = next
        refreshNoticeGeometry()
    }

    private func refreshNoticeGeometry() {
        let frames = currentFrames()
        let lanes = NoticeLaneGeometryPolicy.geometry(viewport: viewport, frames: frames, slots: layout.slots,
                                                      chipsVisible: chipRowVisible)
        let untagged = StageViewportPolicy.untaggedSoloSlotId(inputs, kind: layout.kind)
        let toastBottom = StageViewportPolicy.toastBottom(viewport: viewport, toastHeight: toastHeight, kind: layout.kind,
                                                          frames: frames, slots: layout.slots, untaggedSlotId: untagged)
        let geometry = NoticeLaneGeometry(bannerTop: lanes.bannerTop, chipsVisible: lanes.chipsVisible,
                                          toastBottom: max(lanes.toastBottom, toastBottom), toastLeading: lanes.toastLeading,
                                          toastTrailing: lanes.toastTrailing)
        if geometry != noticeGeometry { noticeGeometry = geometry }
    }

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
        if inputs.isWebinarAttendee {

            return StageCapsuleModel(title: details.webinarTitle, subtitleKind: AttendeeViewerPolicy.capsuleLiveKind,
                                     subtitleName: "", count: count, isLocked: false, captionsOn: false,
                                     liveNotes: LiveNotesState.off)
        }
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
                                   isFlipInFlight: inputs.isFlipInFlight && cameraOn, isCameraPaused: inputs.isCameraPaused && cameraOn,
                                   nowPlaying: chip, routeKind: inputs.routeKind, routeName: inputs.routeName,
                                   isAttendee: inputs.isWebinarAttendee)
    }

    private func resolveActivities() -> ActivityStageResolution {
        let live = ActivityStagePolicy.liveKinds(inputs)
        preferredActivityKind = ActivityStagePolicy.normalizedPreference(preferredActivityKind, live: live)
        showsVideoOverActivity = ActivityStagePolicy.normalizedShowsVideo(showsVideoOverActivity, live: live)
        return ActivityStagePolicy.resolve(live: live, preferredKind: preferredActivityKind,
                                           showsVideoOverActivity: showsVideoOverActivity,
                                           names: ActivityStageNames(appId: inputs.activeAppId, gameName: inputs.gameName))
    }

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

        if inputs.isWebinarAttendee { return !attendeeFeed.userId.isEmpty }
        if !inputs.screenShareUserId.isEmpty { return true }
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

        layoutPanel.apply(layoutPanelInputs())

        if !previous.isRecovering && next.isRecovering && !next.isResumingFromBackground {
            announce(kind: StageNoticeAnnouncementKind.reconnecting, name: "")
        } else if previous.isRecovering && !next.isRecovering && noticeApplyCount > 1 {
            announce(kind: StageNoticeAnnouncementKind.reconnected, name: "")
        }
        publishNotices()
    }

    func postLocal(_ notice: MeetingNotice) {
        notices.postLocal(notice, nowMillis: now())
        publishNotices()
    }

    func dismissNotice(id: String) {
        let wasHostNotice = banner?.id == id && banner?.kind == NoticeKind.hostNotice
        notices.dismiss(id: id, nowMillis: now())
        if wasHostNotice {
            onNoticeCommand?(NoticeCommand(actionId: NoticeCommand.dismissHostNotice, noticeKind: NoticeKind.hostNotice,
                                           userId: "", detail: ""))
        }
        publishNotices()
    }

    func clearLocalNotice(id: String) {
        notices.clear(id: id)
        publishNotices()
    }

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
        case NoticeAction.admit:

            if let owner = people {
                owner.admitFromStage(pendingId: notice.userId)
            } else {
                onNoticeCommand?(NoticeCommand(actionId: actionId, noticeKind: notice.kind, userId: notice.userId,
                                               detail: notice.detail))
            }
        case NoticeAction.admitAll:
            if let owner = people {
                owner.admitAllFromStage()
            } else {
                onNoticeCommand?(NoticeCommand(actionId: actionId, noticeKind: notice.kind, userId: notice.userId,
                                               detail: notice.detail))
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
            if notice.kind == NoticeKind.notificationsOff {

                SystemNotifications.shared.dismissPriming()
            }
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

    func setKnockActionsPending(_ pending: Bool) {
        if pending == notices.knockActionsPending { return }
        notices.setKnockActionsPending(pending, nowMillis: now())
        publishNotices()
    }

    func setToastLaneSuspended(_ suspended: Bool) {
        if suspended == notices.isToastLaneSuspended { return }
        notices.setToastLaneSuspended(suspended)
        publishNotices()
    }

    func setNoticePlatform(_ platform: String) {
        notices.setPlatform(platform, nowMillis: now())
        publishNotices()
    }

    func captionChanged(_ line: CaptionLine) {
        if !captionsActive { return }
        captions.update(line)
    }

    func expireNoticeIfDue() {
        if notices.expireIfDue(nowMillis: now() + StagePresenter.noticeExpiryToleranceMillis) {
            publishNotices()
        }
    }

    static let noticeExpiryToleranceMillis = 250.0

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
            case "flipCamera":
                _ = StageCameraFlip.perform(self)
                return
            default:
                break
            }
        }
        if notice.kind == NoticeKind.endFailed {

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

    func applyDetails(_ next: StageDetailsInputs) {
        if next == details && detailsApplyCount > 0 { return }
        if details.callSession != 0 && next.callSession != details.callSession {
            connectionLabel = ConnectionQualityLabel.measuring
        }
        detailsApplyCount += 1
        details = next
        let label = ConnectionQualityLabelPolicy.label(next.connectionQuality, hasSample: next.connectionHasSample,
                                                       statsFailed: next.connectionStatsFailed)
        connectionLabel = ConnectionQualityLabelPolicy.stable(previous: connectionLabel, next: label,
                                                              isRecovering: inputs.isRecovering)
        if inputs.isWebinarAttendee {

            rebuild()
        } else {
            refreshMeetingInfo()
        }
    }

    private var isMeetingInfoShowing: Bool {
        meetingInfoOpening || shell.panels.isShowingOrQueued(MeetingPanel.meetingInfo)
    }

    private func refreshMeetingInfo() {
        if !isMeetingInfoShowing {
            if meetingInfo != nil { meetingInfo = nil }
            return
        }
        let next = MeetingInfoPolicy.snapshot(inputs: inputs, details: details, connection: connectionLabel)
        if next != meetingInfo { meetingInfo = next }
    }

    private func refreshAttendee() {
        if !inputs.isWebinarAttendee || !inputs.isInCall {
            if attendee != nil { attendee = nil }
            lastAttendeeState = ""
            return
        }
        let next = AttendeeViewerPolicy.snapshot(inputs: inputs, details: details, feed: attendeeFeed, hand: localHand)
        if let current = attendee {
            if next != current.withRevision(0) { attendee = next.withRevision(current.revision + 1) }
        } else {
            attendee = next.withRevision(1)
        }
        if lastAttendeeState == AttendeeViewerPolicy.waitingState && next.state == AttendeeViewerPolicy.liveState
            && announcedWebinarLiveSession != inputs.callSession {
            announcedWebinarLiveSession = inputs.callSession
            announce(kind: AttendeeViewerPolicy.webinarLiveAnnouncement, name: "")
        }
        lastAttendeeState = next.state
    }

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

struct StageDetailsInputs: Equatable {
    let callSession: Int

    let roomCode: String

    let requiresInviteCode: Bool

    let isWebinarEnabled: Bool
    let isWebinarPublicAccess: Bool

    let webinarLinkURL: String

    let webinarTitle: String

    let webinarAttendeeCount: Int

    let isWebinarQaEnabled: Bool
    let webinarQaUnseen: Int

    let attendeeCanRaiseHand: Bool

    let connectionQuality: ConnectionQuality
    let connectionHasSample: Bool
    let connectionStatsFailed: Bool

    static func make(
        callSession: Int = 0,
        roomCode: String = "",
        requiresInviteCode: Bool = false,
        isWebinarEnabled: Bool = false,
        isWebinarPublicAccess: Bool = false,
        webinarLinkURL: String = "",
        webinarTitle: String = "",
        webinarAttendeeCount: Int = 0,
        isWebinarQaEnabled: Bool = false,
        webinarQaUnseen: Int = 0,
        attendeeCanRaiseHand: Bool = false,
        connectionQuality: ConnectionQuality = ConnectionQuality.unknown,
        connectionHasSample: Bool = false,
        connectionStatsFailed: Bool = false
    ) -> StageDetailsInputs {
        StageDetailsInputs(callSession: callSession, roomCode: roomCode, requiresInviteCode: requiresInviteCode,
                           isWebinarEnabled: isWebinarEnabled, isWebinarPublicAccess: isWebinarPublicAccess,
                           webinarLinkURL: webinarLinkURL, webinarTitle: webinarTitle,
                           webinarAttendeeCount: webinarAttendeeCount, isWebinarQaEnabled: isWebinarQaEnabled,
                           webinarQaUnseen: webinarQaUnseen, attendeeCanRaiseHand: attendeeCanRaiseHand,
                           connectionQuality: connectionQuality, connectionHasSample: connectionHasSample,
                           connectionStatsFailed: connectionStatsFailed)
    }
}

struct MeetingInfoSnapshot: Equatable {
    let roomCode: String
    let link: String
    let roomLabel: String
    let isLocked: Bool
    let liveNotes: LiveNotesState
    let captionsOn: Bool
    let hostNames: [String]
    let joinedAtMillis: Double
    let connection: ConnectionQualityLabel
    let isHost: Bool
    let requiresInviteCode: Bool
    let isWebinarEnabled: Bool
    let webinarLink: String
    let isWebinarPublic: Bool
    let isAttendee: Bool
    let webinarTitle: String
    let isRecovering: Bool
}

enum MeetingInfoSection: String, CaseIterable, Equatable {
    case room, status, webinar, details, host, attendee, settings
}

enum MeetingInfoRowID: String, CaseIterable, Equatable {
    case roomCode, copyCode, meetingLink, shareInvite, copyLink
    case meetingLocked, liveNotes, captions, inviteCodeRequired
    case shareWebinarLink, copyWebinarLink
    case hosts, started, connection
    case hostControls
    case webinarTitle, settings
}

struct MeetingInfoRow: Equatable, Identifiable {
    let row: MeetingInfoRowID
    let section: MeetingInfoSection

    var id: String { row.rawValue }
}

enum MeetingInfoPolicy {

    static let copiedMillis = 2000.0

    static let systemCopyConfirmationApi = 33

    static func snapshot(inputs: StageInputs, details: StageDetailsInputs, connection: ConnectionQualityLabel) -> MeetingInfoSnapshot {
        let local = inputs.participant(inputs.localUserId)
        return MeetingInfoSnapshot(
            roomCode: details.roomCode,
            link: inputs.meetingLink,
            roomLabel: inputs.roomLabel,
            isLocked: inputs.isRoomLocked,
            liveNotes: inputs.liveNotes,
            captionsOn: inputs.captionsOn,
            hostNames: hostNames(inputs.participants),
            joinedAtMillis: inputs.joinedAtMillis,
            connection: connection,
            isHost: local?.isHost ?? false,
            requiresInviteCode: details.requiresInviteCode,
            isWebinarEnabled: details.isWebinarEnabled,
            webinarLink: details.webinarLinkURL,
            isWebinarPublic: details.isWebinarPublicAccess,
            isAttendee: inputs.isWebinarAttendee,
            webinarTitle: details.webinarTitle,
            isRecovering: inputs.isRecovering
        )
    }

    static func hostNames(_ participants: [StageParticipantInput]) -> [String] {
        var remotes: [StageParticipantInput] = []
        var localName = ""
        for participant in participants {
            if participant.isLeaving || !participant.isHost { continue }
            let name = participant.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            if name.isEmpty { continue }
            if participant.isLocal {
                localName = name
            } else {
                remotes.append(participant)
            }
        }
        let ordered = remotes.sorted { a, b in
            if a.joinSerial != b.joinSerial {
                if a.joinSerial == 0 { return false }
                if b.joinSerial == 0 { return true }
                return a.joinSerial < b.joinSerial
            }
            return a.userId < b.userId
        }
        var result: [String] = []
        for participant in ordered {
            result.append(participant.displayName.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if !localName.isEmpty { result.append(localName) }
        return result
    }

    static func rows(_ snapshot: MeetingInfoSnapshot) -> [MeetingInfoRow] {
        var result: [MeetingInfoRow] = []
        if snapshot.isAttendee {
            result.append(MeetingInfoRow(row: MeetingInfoRowID.webinarTitle, section: MeetingInfoSection.attendee))
            if !snapshot.hostNames.isEmpty {
                result.append(MeetingInfoRow(row: MeetingInfoRowID.hosts, section: MeetingInfoSection.attendee))
            }
            if snapshot.isWebinarPublic && !snapshot.webinarLink.isEmpty {
                result.append(MeetingInfoRow(row: MeetingInfoRowID.shareWebinarLink, section: MeetingInfoSection.attendee))
            }
            result.append(MeetingInfoRow(row: MeetingInfoRowID.settings, section: MeetingInfoSection.settings))
            return result
        }
        if !snapshot.roomCode.isEmpty {
            result.append(MeetingInfoRow(row: MeetingInfoRowID.roomCode, section: MeetingInfoSection.room))
            result.append(MeetingInfoRow(row: MeetingInfoRowID.copyCode, section: MeetingInfoSection.room))
        }
        if !snapshot.link.isEmpty {
            result.append(MeetingInfoRow(row: MeetingInfoRowID.meetingLink, section: MeetingInfoSection.room))
            result.append(MeetingInfoRow(row: MeetingInfoRowID.shareInvite, section: MeetingInfoSection.room))
            result.append(MeetingInfoRow(row: MeetingInfoRowID.copyLink, section: MeetingInfoSection.room))
        }
        result.append(MeetingInfoRow(row: MeetingInfoRowID.meetingLocked, section: MeetingInfoSection.status))
        result.append(MeetingInfoRow(row: MeetingInfoRowID.liveNotes, section: MeetingInfoSection.status))
        if snapshot.captionsOn {
            result.append(MeetingInfoRow(row: MeetingInfoRowID.captions, section: MeetingInfoSection.status))
        }
        if snapshot.isHost && snapshot.requiresInviteCode {
            result.append(MeetingInfoRow(row: MeetingInfoRowID.inviteCodeRequired, section: MeetingInfoSection.status))
        }
        if snapshot.isHost && snapshot.isWebinarEnabled {
            result.append(MeetingInfoRow(row: MeetingInfoRowID.shareWebinarLink, section: MeetingInfoSection.webinar))
            result.append(MeetingInfoRow(row: MeetingInfoRowID.copyWebinarLink, section: MeetingInfoSection.webinar))
        }
        if !snapshot.hostNames.isEmpty {
            result.append(MeetingInfoRow(row: MeetingInfoRowID.hosts, section: MeetingInfoSection.details))
        }
        if snapshot.joinedAtMillis > 0 {
            result.append(MeetingInfoRow(row: MeetingInfoRowID.started, section: MeetingInfoSection.details))
        }
        result.append(MeetingInfoRow(row: MeetingInfoRowID.connection, section: MeetingInfoSection.details))
        if snapshot.isHost {
            result.append(MeetingInfoRow(row: MeetingInfoRowID.hostControls, section: MeetingInfoSection.host))
        }
        return result
    }

    static func rowIds(_ snapshot: MeetingInfoSnapshot) -> [String] {
        var ids: [String] = []
        for row in rows(snapshot) {
            ids.append(row.id)
        }
        return ids
    }

    static func sections(_ snapshot: MeetingInfoSnapshot) -> [MeetingInfoSection] {
        var result: [MeetingInfoSection] = []
        for row in rows(snapshot) {
            if !result.contains(row.section) { result.append(row.section) }
        }
        return result
    }

    static func sectionRows(_ snapshot: MeetingInfoSnapshot, section: MeetingInfoSection) -> [MeetingInfoRow] {
        var result: [MeetingInfoRow] = []
        for row in rows(snapshot) {
            if row.section == section { result.append(row) }
        }
        return result
    }

    static func isHostControlsEnabled(_ snapshot: MeetingInfoSnapshot) -> Bool {
        !snapshot.isRecovering
    }

    static func isWebinarLinkActionEnabled(_ snapshot: MeetingInfoSnapshot) -> Bool {
        !snapshot.webinarLink.isEmpty || !snapshot.isRecovering
    }

    static func showsCopySnackbar(sdkInt: Int) -> Bool {
        sdkInt < systemCopyConfirmationApi
    }

    static func liveNotesCatalogKey(_ state: LiveNotesState) -> String {
        switch state {
        case .off: return "Off"
        case .starting: return "Starting"
        case .live: return "On"
        case .paused: return "Paused"
        case .needsAttention: return "Needs Attention"
        }
    }

    static func liveNotesAndroidName(_ state: LiveNotesState) -> String {
        switch state {
        case .off: return "stg_off"
        case .starting: return "stg_state_starting"
        case .live: return "stg_on"
        case .paused: return "stg_state_paused"
        case .needsAttention: return "stg_state_needs_attention"
        }
    }
}

struct AttendeeFeed: Equatable {
    let userId: String
    let isShare: Bool
    let insetUserId: String

    static let none = AttendeeFeed(userId: "", isShare: false, insetUserId: "")
}

struct AttendeeViewerSnapshot: Equatable {
    let revision: Int

    let state: String

    let title: String
    let waitingCount: Int
    let feedUserId: String
    let feedName: String
    let isShareFeed: Bool
    let insetUserId: String
    let hand: LocalHandState
    let canRaiseHand: Bool
    let qaEnabled: Bool

    let webinarQaUnseen: Int

    func withRevision(_ next: Int) -> AttendeeViewerSnapshot {
        AttendeeViewerSnapshot(revision: next, state: state, title: title, waitingCount: waitingCount, feedUserId: feedUserId,
                               feedName: feedName, isShareFeed: isShareFeed, insetUserId: insetUserId, hand: hand,
                               canRaiseHand: canRaiseHand, qaEnabled: qaEnabled, webinarQaUnseen: webinarQaUnseen)
    }

    var isLive: Bool { state == AttendeeViewerPolicy.liveState }
}

enum AttendeeViewerPolicy {
    static let waitingState = "waiting"
    static let liveState = "live"

    static let capsuleLiveKind = "live"

    static let demotedAnnouncement = "demoted"
    static let webinarLiveAnnouncement = "webinarLive"

    static func feed(_ inputs: StageInputs) -> AttendeeFeed {
        let local = inputs.localUserId
        let share = inputs.screenShareUserId
        if !share.isEmpty && share != local, let presenter = inputs.participant(share) {
            return AttendeeFeed(userId: share, isShare: true, insetUserId: presenter.isCameraOff ? "" : share)
        }
        let speaker = inputs.webinarSpeakerUserId
        if !speaker.isEmpty && speaker != local && inputs.participant(speaker) != nil {
            return AttendeeFeed(userId: speaker, isShare: false, insetUserId: "")
        }
        var best: StageParticipantInput? = nil
        for participant in inputs.presentParticipants {
            if participant.isLocal || participant.isCameraOff { continue }
            if let current = best {
                if participant.joinSerial > 0 && (current.joinSerial == 0 || participant.joinSerial < current.joinSerial) {
                    best = participant
                }
            } else {
                best = participant
            }
        }
        if let chosen = best {
            return AttendeeFeed(userId: chosen.userId, isShare: false, insetUserId: "")
        }
        return AttendeeFeed.none
    }

    static func kind(_ feed: AttendeeFeed) -> StageKind {
        feed.userId.isEmpty ? StageKind.attendeeWaiting : StageKind.attendeeLive
    }

    static func slots(_ feed: AttendeeFeed, fitOverrides: [String: String]) -> [StageSlot] {
        if feed.userId.isEmpty { return [] }
        var result: [StageSlot] = []
        if feed.isShare {
            let shareId = StageSlot.shareId(feed.userId)
            result.append(StageSlot(id: shareId, role: StageSlotRole.programFeed, userId: feed.userId,
                                    fit: resolvedFit(fitOverrides[shareId], fallback: StageVideoFit.fit)))
            if !feed.insetUserId.isEmpty {
                result.append(StageSlot(id: StageSlot.participantId(feed.insetUserId), role: StageSlotRole.speakerInset,
                                        userId: feed.insetUserId, fit: StageVideoFit.fill))
            }
            return result
        }
        let id = StageSlot.participantId(feed.userId)
        result.append(StageSlot(id: id, role: StageSlotRole.programFeed, userId: feed.userId,
                                fit: resolvedFit(fitOverrides[id], fallback: StageVideoFit.fill)))
        return result
    }

    static func resolvedFit(_ raw: String?, fallback: StageVideoFit) -> StageVideoFit {
        if let value = raw, let parsed = StageVideoFit(rawValue: value) { return parsed }
        return fallback
    }

    static func snapshot(inputs: StageInputs, details: StageDetailsInputs, feed: AttendeeFeed,
                         hand: LocalHandState) -> AttendeeViewerSnapshot {
        let name = feed.userId.isEmpty ? "" : (inputs.participant(feed.userId)?.displayName ?? "")
        return AttendeeViewerSnapshot(
            revision: 0,
            state: feed.userId.isEmpty ? waitingState : liveState,
            title: details.webinarTitle,
            waitingCount: max(0, details.webinarAttendeeCount),
            feedUserId: feed.userId,
            feedName: name,
            isShareFeed: feed.isShare,
            insetUserId: feed.insetUserId,
            hand: hand,
            canRaiseHand: details.attendeeCanRaiseHand,
            qaEnabled: details.isWebinarQaEnabled,
            webinarQaUnseen: details.isWebinarQaEnabled ? max(0, details.webinarQaUnseen) : 0
        )
    }

    static func showsWaitingCount(_ count: Int) -> Bool {
        count > 1
    }

    static func isDemotion(previous: StageInputs, next: StageInputs) -> Bool {
        previous.callSession != 0 && previous.callSession == next.callSession && previous.isInCall && next.isInCall
            && !previous.isWebinarAttendee && next.isWebinarAttendee
    }
}
