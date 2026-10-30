import Foundation
import Observation

struct PremeetingRouteTarget: Equatable {
    let routeId: Int
    let kind: PremeetingRouteKind
    let intent: LobbyIntent
    let roomId: String
    let title: String
    let joinMode: JoinMode
    let meetingInviteCode: String?
    let webinarInviteCode: String?
    let clientId: String?
    let allowRoomCreation: Bool

    var route: PremeetingRoute { PremeetingRoute(id: routeId, kind: kind, roomId: roomId) }
}

@MainActor
@Observable
final class PremeetingPresenter {
    private(set) var path: [PremeetingRoute] = []
    private(set) var home: HomeSnapshot = HomeSnapshot.empty
    private(set) var root: PremeetingRootDecision = PremeetingRootDecision.home
    private(set) var lobbyStatus: LobbyStatusSnapshot? = nil

    private(set) var lobbyMedia: LobbyMediaSnapshot? = nil
    private(set) var lobbyPresence: LobbyPresenceSnapshot? = nil
    private(set) var lobbyIdentity: LobbyIdentitySnapshot? = nil
    private(set) var lobbyLink: LobbyLinkSnapshot? = nil
    private(set) var lobbyAudio: LobbyAudioSnapshot? = nil
    private(set) var outcome: OutcomeModel? = nil

    private(set) var webinar: WebinarLandingSnapshot? = nil

    private(set) var isJoinSheetPresented = false
    private(set) var isAccountSheetPresented = false

    private(set) var isUpdatePromptPresented = false
    private(set) var switchPrompt: RoomSwitchPrompt? = nil

    private(set) var isStopAskingPresented = false

    private(set) var promotionRoute: PremeetingRoute? = nil

    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    let account = AccountPresenter()

    @ObservationIgnored var onCommand: ((PremeetingCommand) -> Void)? = nil

    @ObservationIgnored var store: RecentMeetingsStore? = nil
    @ObservationIgnored var nowMillis: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }

    @ObservationIgnored var lobbyHooks: LobbyCoreHooks? = nil

    @ObservationIgnored var generateRoomCode: () -> String = { EntryPolicies.generateRoomCode() }

    @ObservationIgnored var presenceIntervalMillis: Double = LobbyPresencePolicy.pollIntervalMillis

    @ObservationIgnored var slowNoticeDelayMillis: Double = EntrySlowNoticePolicy.delayMillis

    @ObservationIgnored var webinarHooks: WebinarLandingHooks? = nil

    @ObservationIgnored var webinarRefetchIntervalMillis: Double = WebinarLandingPolicy.refetchIntervalMillis

    @ObservationIgnored var webinarCalendarResolverDisabled = false

    @ObservationIgnored private var inputs = PremeetingInputs.make()
    @ObservationIgnored private var records: [RecentMeetingRecord] = []
    @ObservationIgnored private var targets: [PremeetingRouteTarget] = []
    @ObservationIgnored private var nextRouteId = 1
    @ObservationIgnored private var pendingTarget: PremeetingRouteTarget? = nil
    @ObservationIgnored private var pendingSwitchTarget: NativeJoinLinkTarget? = nil
    @ObservationIgnored private var awaitingHomeTarget: NativeJoinLinkTarget? = nil
    @ObservationIgnored private var queuedLink = ""
    @ObservationIgnored private var nextPromptId = 1
    @ObservationIgnored private var localNotice: HomeNoticeKind = .none
    @ObservationIgnored private var dismissedSessionNoticeKey = ""
    @ObservationIgnored private var dismissedOutcomeId = 0
    @ObservationIgnored private var recordedCallSession = 0
    @ObservationIgnored private var recordedRecordId = ""
    @ObservationIgnored private var recordedOutcomeId = 0
    @ObservationIgnored private var sessionRoomId = ""
    @ObservationIgnored private var sessionRoomCallSession = 0
    @ObservationIgnored private var lastPreCallWasWaiting = false
    @ObservationIgnored private var rejoinExpiryTask: Task<Void, Never>? = nil
    @ObservationIgnored private var scheduledRejoinKey = ""
    @ObservationIgnored private var publishCount = 0

    @ObservationIgnored private var device = LobbyDeviceInputs.initial
    @ObservationIgnored private var lobbyRouteId = 0
    @ObservationIgnored private var visibleLobbyRouteId = 0
    @ObservationIgnored private var guestNameDraft = ""
    @ObservationIgnored private var inviteCodeDraft = ""
    @ObservationIgnored private var formIssue = LobbyFormIssue.none
    @ObservationIgnored private var formIssueBaselineKey = ""
    @ObservationIgnored private var appliedFormIssueKey = ""
    @ObservationIgnored private var chosenOutputKind = ""
    @ObservationIgnored private var chosenInputId = ""
    @ObservationIgnored private var presenceHasResult = false
    @ObservationIgnored private var presenceCount: Int? = nil
    @ObservationIgnored private var presenceRoomId = ""
    @ObservationIgnored private var presenceTask: Task<Void, Never>? = nil
    @ObservationIgnored private var collisionTask: Task<Void, Never>? = nil
    @ObservationIgnored private var isStarting = false
    @ObservationIgnored private var previewRequested = false
    @ObservationIgnored private var previewHandedOff = false
    @ObservationIgnored private var presenceFetches = 0
    @ObservationIgnored private var joinRequests = 0

    @ObservationIgnored private var slowNoticeTask: Task<Void, Never>? = nil
    @ObservationIgnored private var slowNoticeShown = false
    @ObservationIgnored private var pendingRejoinRouteId = 0
    @ObservationIgnored private var rejoinCommands = 0

    @ObservationIgnored private var lobbyRouteIsPromotion = false

    @ObservationIgnored private var webinarRouteId = 0
    @ObservationIgnored private var visibleWebinarRouteId = 0
    @ObservationIgnored private var webinarSceneActive = true
    @ObservationIgnored private var webinarAnswer: WebinarLookupAnswer? = nil
    @ObservationIgnored private var webinarNameDraft = ""
    @ObservationIgnored private var webinarInviteDraft = ""
    @ObservationIgnored private var webinarNeedsInviteCode = false
    @ObservationIgnored private var webinarInviteInvalid = false

    @ObservationIgnored private var webinarFormUnavailable = false

    @ObservationIgnored private var webinarAttempted = false

    @ObservationIgnored private var webinarJoinPending = false

    @ObservationIgnored private var webinarFormBaselineKey = ""

    @ObservationIgnored private var webinarSilentRetry = false
    @ObservationIgnored private var webinarRefetchTask: Task<Void, Never>? = nil
    @ObservationIgnored private var webinarOpenWakeTask: Task<Void, Never>? = nil
    @ObservationIgnored private var webinarWakeAtMillis: Double = 0.0
    @ObservationIgnored private var webinarLastFetchMillis: Double = 0.0
    @ObservationIgnored private var webinarRevision = 0
    @ObservationIgnored private var webinarLookups = 0
    @ObservationIgnored private var webinarJoinRequests = 0

    @ObservationIgnored private var webinarSessionSlug = ""
    @ObservationIgnored private var webinarSessionTitle = ""

    init() {

        account.onFeedback = { [weak self] kind in
            self?.advanceFeedback(kind)
        }
    }

    var currentInputs: PremeetingInputs { inputs }

    var snapshotPublishCount: Int { publishCount }

    var liveTaskCount: Int {
        (rejoinExpiryTask == nil ? 0 : 1) + (presenceTask == nil ? 0 : 1) + (collisionTask == nil ? 0 : 1)
            + (slowNoticeTask == nil ? 0 : 1) + webinarTaskCount
    }

    var webinarTaskCount: Int {
        (webinarRefetchTask == nil ? 0 : 1) + (webinarOpenWakeTask == nil ? 0 : 1)
    }

    var webinarLookupCount: Int { webinarLookups }
    var webinarJoinRequestCount: Int { webinarJoinRequests }

    var webinarNameText: String { webinarNameDraft }
    var webinarInviteText: String { webinarInviteDraft }
    var recentRecords: [RecentMeetingRecord] { records }

    var presenceFetchCount: Int { presenceFetches }
    var joinRequestCount: Int { joinRequests }
    var isStartInFlight: Bool { collisionTask != nil }
    var currentDeviceInputs: LobbyDeviceInputs { device }

    var rejoinCommandCount: Int { rejoinCommands }

    func target(forRoute id: Int) -> PremeetingRouteTarget? {
        for target in targets where target.routeId == id {
            return target
        }
        return nil
    }

    func bootstrap(user: AppState.User?, recents: [RecentMeetingRecord]) {
        var capped: [RecentMeetingRecord] = []
        for record in recents where capped.count < RecentMeetingsPolicy.cap {
            capped.append(record)
        }
        records = capped

        inputs = inputs.withIdentity(
            isSignedIn: PremeetingPresenter.isSignedIn(user),
            accountName: PremeetingPresenter.accountName(user),
            accountSeed: user?.id ?? ""
        )
        republishHome()
    }

    static func isSignedIn(_ user: AppState.User?) -> Bool {
        guard let user else { return false }
        return user.provider != AppState.AuthProvider.guest && user.provider != AppState.AuthProvider.none
    }

    static func accountName(_ user: AppState.User?) -> String {
        guard let user else { return "" }
        let name = (user.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        return (user.email ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func apply(_ next: PremeetingInputs) {
        guard next != inputs else { return }
        let previous = inputs
        inputs = next

        if previous.isSignedIn && !next.isSignedIn {

            records = []
            store?.clear()
        }
        if next.callSession != previous.callSession {
            lastPreCallWasWaiting = false
        }
        if next.phase == .waiting {
            lastPreCallWasWaiting = true
        } else if next.phase == .entering {
            lastPreCallWasWaiting = false
        }
        if next.phase != previous.phase || next.callSession != previous.callSession {

            cancelSlowNotice()
            slowNoticeShown = false
        }
        trackSessionRoom(next)
        recordRecents(next)

        let previousRoot = root
        var decision = PremeetingRootPolicy.decide(
            phase: next.phase,
            hasBeenAdmittedThisSession: next.hasBeenAdmittedThisSession,
            outcomeKind: next.outcomeKind,
            entryOrigin: next.entryOrigin,
            lastPreCallWasWaiting: lastPreCallWasWaiting
        )
        if decision.showsOutcome && next.outcomeId != 0 && next.outcomeId == dismissedOutcomeId {
            decision = PremeetingRootDecision.home
        }
        publishRoot(decision)
        refreshOutcome(next, decision: decision)
        if decision.root == .call && previousRoot.root != .call {

            handOffPreview()
        } else if previousRoot.root == .call && decision.root == .premeeting {
            previewHandedOff = false
            lobbyHooks?.resetPreviewLatch?()
        }

        if decision.showsOutcome {

            setPathValue([])
        } else if previousRoot.root == .call && decision.root == .premeeting {

            setPathValue([])
        }
        if decision.pushesLobby {
            pushLobbyIfAbsent(next)
        }
        if let target = awaitingHomeTarget {
            if decision.showsOutcome {
                awaitingHomeTarget = nil
            } else if decision.root == .premeeting && !MeetingRoomSwitchPolicy.isBusy(phase: next.phase, lobby: .none) {

                awaitingHomeTarget = nil
                setPathValue([makeTarget(from: target, intent: .join).route])
            }
        }
        if !previous.isAppActive && next.isAppActive && visibleLobbyRouteId != 0 {

            lobbyHooks?.refreshDevices?()
        }
        refreshLobby()

        let homeInputsChanged = previous.isSignedIn != next.isSignedIn
            || previous.accountName != next.accountName
            || previous.accountSeed != next.accountSeed
            || previous.updateRequired != next.updateRequired
            || previous.storeURL != next.storeURL
            || previous.phase != next.phase
            || previous.notice != next.notice
            || previous.noticeText != next.noticeText
            || previous.callSession != next.callSession
            || (!previous.isAppActive && next.isAppActive)
        if homeInputsChanged {
            republishHome()
        }
        if !previous.isAppActive && next.isAppActive {

            account.appDidBecomeActive()
        }
        if previous.isSigningIn && !next.isSigningIn && !queuedLink.isEmpty {

            let link = queuedLink
            queuedLink = ""
            handleIncomingURL(link)
        }
    }

    func showHomeNotice(_ kind: HomeNoticeKind) {
        localNotice = kind
        republishHome()
    }

    func setPath(_ routes: [PremeetingRoute]) {

        let landingRouteId = webinarRouteId
        let landingJoinInFlight = landingRouteId != 0 && isWebinarJoinInFlight()
        let landingFailureShowing = landingRouteId != 0 && isWebinarFailureShowing()
        var accepted: [PremeetingRoute] = []
        for route in routes {
            if target(forRoute: route.id) != nil {
                accepted.append(route)
            } else if let prepared = targetFromRecentRoute(route) {
                targets.append(prepared)
                accepted.append(prepared.route)
            }
        }
        setPathValue(accepted)
        refreshLobby()
        if landingRouteId != 0 && !PremeetingPresenter.routesContain(accepted, routeId: landingRouteId) {
            if landingJoinInFlight {

                onCommand?(.leave)
            } else if landingFailureShowing {

                onCommand?(.dismissOutcome)
            }
        }
    }

    func newMeeting() {
        guard !blockedByUpdate() else { return }
        let code = generateRoomCode()
        openOrQueue(PremeetingRouteTarget(routeId: allocateRouteId(), kind: .lobby, intent: .newMeeting, roomId: code,
                                           title: code, joinMode: .meeting, meetingInviteCode: nil,
                                           webinarInviteCode: nil, clientId: nil, allowRoomCreation: true))
    }

    func openJoinSheet() {
        guard !blockedByUpdate() else { return }
        setJoinSheet(true)
    }

    func submitJoinInput(_ raw: String) {
        let parsed = EntryPolicies.parseJoinInput(raw)
        guard !parsed.roomId.isEmpty else {
            advanceFeedback(.validationFailed)
            return
        }
        pendingTarget = makeTarget(from: parsed, intent: .join)
        setJoinSheet(false)
    }

    func dismissJoinSheet() {
        setJoinSheet(false)
    }

    func joinSheetDidDismiss() {
        setJoinSheet(false)
        flushPendingTarget()
    }

    func dismissAccountSheet() {
        setAccountSheet(false)
    }

    func accountSheetDidDismiss() {
        setAccountSheet(false)

        account.didDismiss()
        flushPendingTarget()
    }

    func openRecent(id: String) {
        guard !blockedByUpdate() else { return }
        for record in records where record.id == id {
            openOrQueue(targetFromRecord(record, routeId: allocateRouteId(), intent: .join))
            return
        }
    }

    func removeRecent(id: String) {
        let next = RecentMeetingsPolicy.remove(records, id: id)
        guard next != records else { return }
        records = next
        store?.save(records)
        republishHome()
    }

    func rejoin() {
        guard !blockedByUpdate() else { return }
        guard let card = home.rejoin else { return }
        for record in records where record.id == card.recentId {
            let target = targetFromRecord(record, routeId: allocateRouteId(), intent: .rejoin)
            let connects = canRejoin(roomId: record.roomId)
            let queued = isJoinSheetPresented || isAccountSheetPresented
            openOrQueue(target)
            if connects {
                if queued {
                    pendingRejoinRouteId = target.routeId
                } else {
                    sendRejoin()
                }
            }
            return
        }
    }

    func dismissHomeNotice() {
        if localNotice != .none {
            localNotice = .none
        } else if PremeetingRootPolicy.homeNotice(inputs.notice) != .none {
            dismissedSessionNoticeKey = sessionNoticeKey(inputs)
            onCommand?(.dismissOutcome)
        }
        republishHome()
    }

    func openAccount() {

        if let status = lobbyStatus, status.issue == LobbyIssue.signInRequired {
            self.account.setContext(AccountContext.signInRequired)
        }
        self.account.didPresent()
        #if SKIP
        let accountTarget = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .account, intent: .join, roomId: "",
                                                  title: "", joinMode: .meeting, meetingInviteCode: nil,
                                                  webinarInviteCode: nil, clientId: nil, allowRoomCreation: false)
        targets.append(accountTarget)
        setPathValue(path + [accountTarget.route])
        #else
        setAccountSheet(true)
        #endif
    }

    func openPrivacyPolicy() {
        let privacy = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .privacyPolicy, intent: .join, roomId: "",
                                            title: "", joinMode: .meeting, meetingInviteCode: nil,
                                            webinarInviteCode: nil, clientId: nil, allowRoomCreation: false)
        targets.append(privacy)
        setPathValue(path + [privacy.route])
    }

    func openAppSettings() {
        let settings = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .settings, intent: .join, roomId: "",
                                             title: "", joinMode: .meeting, meetingInviteCode: nil,
                                             webinarInviteCode: nil, clientId: nil, allowRoomCreation: false)
        targets.append(settings)
        setPathValue(path + [settings.route])
    }

    func openStoreListing() {
        setUpdatePrompt(false)
    }

    func dismissUpdatePrompt() {
        setUpdatePrompt(false)
    }

    func cancelJoin() {
        let onLanding = webinarRouteId != 0
        if onLanding {
            webinarJoinPending = false
            webinarSilentRetry = false
            webinarAttempted = false
        }
        onCommand?(.leave)
        if onLanding {
            refreshWebinar()
        }
    }

    func openPromotionLobby(roomId: String, title: String) {
        let room = roomId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !room.isEmpty else { return }
        if let open = promotionRoute { removeTarget(routeId: open.id) }
        let target = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .lobby, intent: LobbyIntent.promotion,
                                           roomId: room, title: title.isEmpty ? room : title, joinMode: JoinMode.meeting,
                                           meetingInviteCode: nil, webinarInviteCode: nil, clientId: nil,
                                           allowRoomCreation: false)
        targets.append(target)
        lobbyRouteIsPromotion = true
        promotionRoute = target.route
        publishCount += 1
        refreshLobby()
    }

    func closePromotionLobby() {
        guard let open = promotionRoute else { return }
        promotionRoute = nil
        publishCount += 1
        removeTarget(routeId: open.id)
        if visibleLobbyRouteId == open.id { visibleLobbyRouteId = 0 }
        refreshLobby()
        lobbyRouteIsPromotion = false
        updatePreviewDemand()
    }

    func cancelPromotion() {
        guard promotionRoute != nil else { return }
        onCommand?(.cancelPromotion)
    }

    private func removeTarget(routeId: Int) {
        var kept: [PremeetingRouteTarget] = []
        for target in targets where target.routeId != routeId {
            kept.append(target)
        }
        targets = kept
    }

    func lobbyDidAppear(routeId: Int) {
        guard let target = topLobbyTarget(), target.routeId == routeId else { return }
        visibleLobbyRouteId = routeId
        lobbyHooks?.refreshDevices?()
        refreshLobby()
    }

    func lobbyDidDisappear(routeId: Int) {
        guard visibleLobbyRouteId == routeId else { return }
        visibleLobbyRouteId = 0
        stopPresencePolling()
        cancelSlowNotice()

        if LobbyPermissionCleanupPolicy.cancelsRequests(mode: root.lobbyMode ?? LobbyMode.editing,
                                                        isCallRoot: root.root == .call, handedOff: previewHandedOff) {
            lobbyHooks?.cancelPermissionRequests?()
        }
        updatePreviewDemand()
    }

    func setMicIntent(_ on: Bool) {
        guard lobbyStatus != nil else { return }
        if on && !mayTurnOn(LobbyMediaKind.microphone) {
            return
        }
        lobbyHooks?.setEntryMediaIntent?(on, inputs.cameraIntentOn)
    }

    func setCameraIntent(_ on: Bool) {
        guard lobbyStatus != nil else { return }
        if on && !mayTurnOn(LobbyMediaKind.camera) {
            return
        }
        lobbyHooks?.setEntryMediaIntent?(inputs.micIntentOn, on)
    }

    func flipCamera() {
        lobbyHooks?.flipPreview?()
    }

    func setGuestName(_ name: String) {
        let capped = DisplayNamePolicy.capped(name)
        guard capped != guestNameDraft else { return }
        guestNameDraft = capped
        refreshLobby()
    }

    func setInviteCode(_ code: String) {
        guard code != inviteCodeDraft else { return }
        inviteCodeDraft = code
        if formIssue.inviteCodeInvalid {
            formIssue = LobbyFormIssue(issue: .none, needsInviteCode: formIssue.needsInviteCode, inviteCodeInvalid: false)
            refreshLobby()
        }
    }

    func startOrJoin() {
        guard let target = topLobbyTarget(), let status = lobbyStatus, status.routeId == target.routeId else { return }
        guard status.mode == .editing || status.mode == .failed, !isStarting else { return }
        guard !blockedByUpdate() else { return }
        if target.intent == .promotion {

            guard !inputs.isNetworkOffline else { return }
            joinRequests += 1
            onCommand?(.joinAsSpeaker)
            refreshLobby()
            return
        }
        if target.intent == .rejoin && canRejoin(roomId: target.roomId) {

            guard !inputs.isNetworkOffline else { return }
            joinRequests += 1
            sendRejoin()
            refreshLobby()
            return
        }
        guard primaryReason(for: target) == .none else { return }
        if target.intent == .newMeeting && lobbyHooks?.fetchPresence != nil {
            isStarting = true
            let routeId = target.routeId
            collisionTask = Task { @MainActor [weak self] in
                await self?.runCollisionCheck(routeId: routeId)
            }
            refreshLobby()
            return
        }
        submitJoin(target)
    }

    func retryJoin() {
        startOrJoin()
    }

    func requestStopAsking() {
        guard let status = lobbyStatus, status.mode == .waiting else { return }
        setStopAsking(true)
    }

    func keepWaiting() {
        setStopAsking(false)
    }

    func stopAsking() {
        guard isStopAskingPresented else { return }
        setStopAsking(false)
        cancelJoin()
    }

    func requestPermission(_ kind: String) {
        lobbyHooks?.requestPermission?(kind)
    }

    func openSystemSettings() {
        lobbyHooks?.openSystemSettings?()
    }

    func openEffects() {
        guard lobbyMedia?.showsEffects == true else { return }
        lobbyHooks?.openEffects?()
    }

    func selectAudioOutput(kind: String) {
        guard lobbyStatus != nil else { return }
        chosenOutputKind = kind
        lobbyHooks?.setPrejoinAudioRouteIntent?(kind, chosenInputId)
        refreshAudioSnapshot()
    }

    func selectAudioInput(id: String) {
        guard lobbyStatus != nil else { return }
        chosenInputId = id
        lobbyHooks?.setPrejoinAudioRouteIntent?(chosenOutputKind, id)
        refreshAudioSnapshot()
    }

    func routePickerDidDismiss() {
        let before = device.currentOutputId
        lobbyHooks?.refreshDevices?()
        guard device.currentOutputId != before else { return }
        for option in device.outputs where option.id == device.currentOutputId {
            selectAudioOutput(kind: option.kind.rawValue)
        }
    }

    func applyPreview(state: PreviewState, sessionId: Int, isFrontCamera: Bool, interruption: PreviewInterruption) {
        let next = device.withPreview(state: state, sessionId: sessionId, isFrontCamera: isFrontCamera,
                                      interruption: interruption)
        guard next != device else { return }
        device = next
        refreshMediaSnapshot()
    }

    func applyPermissions(microphone: MediaPermissionState, camera: MediaPermissionState,
                          canAskAgainMicrophone: Bool, canAskAgainCamera: Bool) {
        let next = device.withPermissions(microphone: microphone, camera: camera,
                                          canAskAgainMicrophone: canAskAgainMicrophone,
                                          canAskAgainCamera: canAskAgainCamera)
        guard next != device else { return }
        device = next
        refreshMediaSnapshot()
        updatePreviewDemand()
    }

    func applyAudioRoutes(outputs: [AudioRouteOption], currentOutputId: String, inputOptions: [AudioRouteOption],
                          currentInputId: String) {
        let next = device.withRoutes(outputs: outputs, currentOutputId: currentOutputId, inputs: inputOptions,
                                     currentInputId: currentInputId)
        guard next != device else { return }
        device = next
        refreshAudioSnapshot()
    }

    func applyEffects(available: Bool, active: Bool) {
        let next = device.withEffects(available: available, active: active)
        guard next != device else { return }
        device = next
        refreshMediaSnapshot()
    }

    func permissionRequestFinished(kind: String, granted: Bool) {
        guard !granted, lobbyStatus != nil else { return }
        if kind == LobbyMediaKind.microphone.rawValue && inputs.micIntentOn {
            lobbyHooks?.setEntryMediaIntent?(false, inputs.cameraIntentOn)
        } else if kind == LobbyMediaKind.camera.rawValue && inputs.cameraIntentOn {
            lobbyHooks?.setEntryMediaIntent?(inputs.micIntentOn, false)
        }
    }

    private func mayTurnOn(_ kind: LobbyMediaKind) -> Bool {
        let permission = kind == .camera ? device.cameraPermission : device.micPermission
        let canAskAgain = kind == .camera ? device.canAskAgainCamera : device.canAskAgainMicrophone
        switch permission {
        case .granted:
            return true
        case .notDetermined:
            lobbyHooks?.requestPermission?(kind.rawValue)
            return true
        case .denied:
            guard canAskAgain, lobbyHooks?.requestPermission != nil else { return false }
            lobbyHooks?.requestPermission?(kind.rawValue)
            return true
        case .restricted, .unavailable:
            return false
        }
    }

    func webinarDidAppear(routeId: Int) {
        guard let target = topWebinarTarget(), target.routeId == routeId else { return }
        visibleWebinarRouteId = routeId
        refreshWebinar()
    }

    func webinarDidDisappear(routeId: Int) {
        guard visibleWebinarRouteId == routeId else { return }
        visibleWebinarRouteId = 0
        refreshWebinar()
    }

    func webinarSceneDidChange(isActive: Bool) {
        guard isActive != webinarSceneActive else { return }
        webinarSceneActive = isActive
        refreshWebinar()
    }

    func setWebinarName(_ name: String) {
        let capped = DisplayNamePolicy.capped(name)
        guard capped != webinarNameDraft else { return }
        webinarNameDraft = capped
        refreshWebinar()
    }

    func setWebinarInviteCode(_ code: String) {
        guard code != webinarInviteDraft else { return }
        webinarInviteDraft = code
        webinarInviteInvalid = false
        refreshWebinar()
    }

    func startWatching() {
        guard let target = topWebinarTarget(), let snapshot = webinar, snapshot.routeId == target.routeId,
              snapshot.status == .openNow, snapshot.isPrimaryEnabled else { return }
        guard !blockedByUpdate() else { return }
        sendWebinarJoin(target, silent: false)
    }

    func retryWebinar() {
        guard let target = topWebinarTarget(), let snapshot = webinar, snapshot.routeId == target.routeId,
              snapshot.status == .failed else { return }
        if snapshot.failure == .join {
            guard !blockedByUpdate() else { return }
            sendWebinarJoin(target, silent: false)
            return
        }
        webinarAnswer = nil
        webinarLastFetchMillis = 0.0
        stopWebinarRefetch()
        refreshWebinar()
    }

    func webinarBackHome() {
        setPath([])
    }

    func performOutcomeAction(_ action: OutcomeAction) {
        switch action {
        case .backHome, .none:
            dismissOutcome()
        case .rejoin, .tryAgain:
            let room = inputs.rejoinRoomId
            guard !room.isEmpty else {
                dismissOutcome()
                return
            }
            guard !blockedByUpdate() else { return }
            if inputs.outcomeId != 0 {
                dismissedOutcomeId = inputs.outcomeId
            }
            publishOutcome(nil)
            if root.showsOutcome {
                publishRoot(PremeetingRootDecision.home)
            }
            let target = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .lobby, intent: .rejoin, roomId: room,
                                               title: room, joinMode: inputs.currentJoinMode, meetingInviteCode: nil,
                                               webinarInviteCode: nil, clientId: nil, allowRoomCreation: false)
            targets.append(target)
            setPathValue([target.route])
            refreshLobby()
            sendRejoin()
        }
    }

    func dismissOutcome() {
        if inputs.outcomeId != 0 {
            dismissedOutcomeId = inputs.outcomeId
        }
        publishOutcome(nil)
        if root.showsOutcome {
            publishRoot(PremeetingRootDecision.home)
        }
        setPathValue([])
        refreshLobby()
        onCommand?(.dismissOutcome)
    }

    func handleIncomingURL(_ raw: String) {
        let kind = NativeJoinLinkParser.classify(raw)
        switch kind {
        case .notConclave, .webOnly:
            return
        case .invalidConclave:
            reportInvalidLink()
            return
        case .meeting, .webinar:
            break
        }
        let parsed = NativeJoinLinkParser.parse(raw, allowRoomCreationForURLs: true)
        guard !parsed.roomId.isEmpty else {
            reportInvalidLink()
            return
        }
        let lobbyTarget = topLobbyTarget()
        let lobby = EntryPolicies.switchLobby(isLobbyOnTop: lobbyTarget != nil, mode: lobbyStatus?.mode ?? LobbyMode.editing)
        let busy = MeetingRoomSwitchPolicy.isBusy(phase: inputs.phase, lobby: lobby)
        var isSameRoom = false
        var currentJoinMode = inputs.currentJoinMode
        if busy {
            let currentRoom = inputs.currentRoomId.isEmpty ? inputs.roomLabel : inputs.currentRoomId
            isSameRoom = MeetingRoomSwitchPolicy.isSameRoom(currentRoomId: currentRoom, aliases: inputs.roomAliases,
                                                            targetRoomId: parsed.roomId)
        } else if let lobbyTarget {
            isSameRoom = MeetingRoomSwitchPolicy.isSameRoom(currentRoomId: lobbyTarget.roomId, aliases: [],
                                                            targetRoomId: parsed.roomId)
            currentJoinMode = lobbyTarget.joinMode
        }
        let decision = MeetingRoomSwitchPolicy.decide(MeetingRoomSwitchInputs.make(
            phase: inputs.phase,
            lobby: lobby,
            isSigningIn: inputs.isSigningIn,
            isSameRoom: isSameRoom,
            currentJoinMode: currentJoinMode,
            targetKind: EntryPolicies.switchTargetKind(kind),
            targetJoinMode: parsed.joinMode
        ))
        switch decision {
        case .openLobby, .openWebinarLanding:
            guard !blockedByUpdate() else { return }
            openForLink(parsed)
        case .replaceLobby:
            guard !blockedByUpdate() else { return }
            setPathValue([makeTarget(from: parsed, intent: .join).route])
            refreshLobby()
        case .prompt:
            let current = busy
                ? EntryPolicies.roomLabel(inputs.roomLabel.isEmpty ? inputs.currentRoomId : inputs.roomLabel)
                : EntryPolicies.roomLabel(lobbyTarget?.roomId ?? "")
            pendingSwitchTarget = parsed
            publishSwitchPrompt(RoomSwitchPrompt(id: nextPromptId, currentLabel: current,
                                             targetLabel: EntryPolicies.roomLabel(parsed.roomId)))
            nextPromptId += 1
        case .ignore:
            return
        case .queue:
            queuedLink = raw
        case .invalidLink:
            reportInvalidLink()
        }
    }

    func reportInvalidLink() {
        localNotice = .invalidLink
        republishHome()
    }

    func confirmSwitch(id: Int) {
        guard let prompt = switchPrompt, prompt.id == id, let target = pendingSwitchTarget else { return }
        publishSwitchPrompt(nil)
        pendingSwitchTarget = nil
        awaitingHomeTarget = target
        if MeetingRoomSwitchPolicy.isBusy(phase: inputs.phase, lobby: .none) {
            onCommand?(.leave)
        } else {
            awaitingHomeTarget = nil
            setPathValue([makeTarget(from: target, intent: .join).route])
            refreshLobby()
        }
    }

    func stay(id: Int) {
        guard let prompt = switchPrompt, prompt.id == id else { return }
        publishSwitchPrompt(nil)
        pendingSwitchTarget = nil
    }

    private func openForLink(_ parsed: NativeJoinLinkTarget) {
        if root.showsOutcome {
            dismissOutcome()
        }
        openOrQueue(makeTarget(from: parsed, intent: .join))
    }

    private func openOrQueue(_ target: PremeetingRouteTarget) {
        guard isJoinSheetPresented || isAccountSheetPresented else {
            openFromHome(target)
            return
        }
        if self.target(forRoute: target.routeId) == nil {
            targets.append(target)
        }
        pendingTarget = target
        setJoinSheet(false)
        setAccountSheet(false)
    }

    private func flushPendingTarget() {
        guard let target = pendingTarget else { return }
        pendingTarget = nil
        openFromHome(target)
        if pendingRejoinRouteId != 0 && pendingRejoinRouteId == target.routeId {
            pendingRejoinRouteId = 0
            if canRejoin(roomId: target.roomId) {
                sendRejoin()
            }
        }
    }

    private func canRejoin(roomId: String) -> Bool {
        guard inputs.phase == .home || inputs.phase == .outcome else { return false }
        return RejoinContextPolicy.matches(rejoinRoomId: inputs.rejoinRoomId, roomId: roomId)
    }

    private func sendRejoin() {
        rejoinCommands += 1
        onCommand?(.rejoinLastMeeting)
    }

    private func openFromHome(_ target: PremeetingRouteTarget) {
        if self.target(forRoute: target.routeId) == nil {
            targets.append(target)
        }
        setPathValue([target.route])
        refreshLobby()
    }

    private func makeTarget(from parsed: NativeJoinLinkTarget, intent: LobbyIntent) -> PremeetingRouteTarget {
        let target = PremeetingRouteTarget(
            routeId: allocateRouteId(),
            kind: EntryPolicies.routeKind(for: parsed),
            intent: intent,
            roomId: parsed.roomId,
            title: parsed.roomId,
            joinMode: parsed.joinMode,
            meetingInviteCode: parsed.meetingInviteCode,
            webinarInviteCode: parsed.webinarInviteCode,
            clientId: parsed.clientId,
            allowRoomCreation: parsed.allowRoomCreation
        )
        targets.append(target)
        return target
    }

    private func targetFromRecord(_ record: RecentMeetingRecord, routeId: Int, intent: LobbyIntent) -> PremeetingRouteTarget {
        let joinMode: JoinMode = record.isWebinar ? JoinMode.webinarAttendee : JoinMode.meeting
        return PremeetingRouteTarget(routeId: routeId, kind: record.isWebinar ? PremeetingRouteKind.webinarLanding : PremeetingRouteKind.lobby, intent: intent,
                                     roomId: record.roomId, title: record.title, joinMode: joinMode,
                                     meetingInviteCode: nil, webinarInviteCode: nil, clientId: nil,
                                     allowRoomCreation: false)
    }

    private func targetFromRecentRoute(_ route: PremeetingRoute) -> PremeetingRouteTarget? {
        let index = route.id - PremeetingRoute.recentRouteIdBase
        guard index >= 0, index < records.count else { return nil }
        let record = records[index]
        guard record.roomId == route.roomId else { return nil }
        return targetFromRecord(record, routeId: route.id, intent: .join)
    }

    private func topWebinarTarget() -> PremeetingRouteTarget? {
        guard let top = path.last, top.kind == .webinarLanding else { return nil }
        return target(forRoute: top.id)
    }

    private static func routesContain(_ routes: [PremeetingRoute], routeId: Int) -> Bool {
        for route in routes where route.id == routeId {
            return true
        }
        return false
    }

    private func topLobbyTarget() -> PremeetingRouteTarget? {

        if let promotion = promotionRoute { return target(forRoute: promotion.id) }
        guard let top = path.last, top.kind == .lobby else { return nil }
        return target(forRoute: top.id)
    }

    private func pushLobbyIfAbsent(_ next: PremeetingInputs) {
        if let top = path.last, top.kind == .lobby || top.kind == .webinarLanding {
            return
        }
        let callRoom = next.currentRoomId.isEmpty ? next.roomLabel : next.currentRoomId
        let roomId = next.resumeInFlight && !next.resumeRoomId.isEmpty ? next.resumeRoomId : callRoom
        let target = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .lobby,
                                           intent: next.resumeInFlight ? LobbyIntent.resume : LobbyIntent.join, roomId: roomId,
                                           title: next.roomLabel.isEmpty ? roomId : next.roomLabel,
                                           joinMode: next.currentJoinMode, meetingInviteCode: nil,
                                           webinarInviteCode: nil, clientId: nil, allowRoomCreation: false)
        targets.append(target)

        setPathValue([target.route])
    }

    private func allocateRouteId() -> Int {
        let id = nextRouteId
        nextRouteId += 1
        return id
    }

    private func blockedByUpdate() -> Bool {
        guard inputs.updateRequired else { return false }
        setUpdatePrompt(true)
        return true
    }

    private func trackSessionRoom(_ next: PremeetingInputs) {
        let room = next.currentRoomId.isEmpty ? next.roomLabel : next.currentRoomId
        if next.callSession != sessionRoomCallSession {
            sessionRoomCallSession = next.callSession
            sessionRoomId = ""
        }
        if !room.isEmpty {
            sessionRoomId = room
        }
    }

    private func recordRecents(_ next: PremeetingInputs) {
        let now = nowMillis()
        var changed = false
        if next.phase == .inCall && next.callSession != recordedCallSession && !sessionRoomId.isEmpty {
            recordedCallSession = next.callSession

            let fromLanding = (next.isWebinarAttendee || next.currentJoinMode == .webinarAttendee) && !webinarSessionSlug.isEmpty
            let roomId = fromLanding ? webinarSessionSlug : sessionRoomId
            let id = RecentMeetingsPolicy.recordId(roomId: roomId, joinMode: next.currentJoinMode)
            recordedRecordId = id
            let role: RecentRole = (next.isWebinarAttendee || fromLanding) ? RecentRole.attendee
                : (next.isLocalHost ? RecentRole.host : RecentRole.participant)
            var title = next.roomLabel.isEmpty ? sessionRoomId : next.roomLabel
            if fromLanding {
                title = webinarSessionTitle.isEmpty ? webinarSessionSlug : webinarSessionTitle
            }
            webinarSessionSlug = ""
            webinarSessionTitle = ""
            records = RecentMeetingsPolicy.upsert(records, RecentMeetingRecord(
                id: id, roomId: roomId, title: title, joinMode: next.currentJoinMode.rawValue, role: role.rawValue,
                lastJoinedAtMillis: now, endedAtMillis: 0, end: ""))
            changed = true
        }
        if let kind = next.outcomeKind, next.outcomeId != 0, next.outcomeId != recordedOutcomeId {
            recordedOutcomeId = next.outcomeId
            let end = PremeetingRootPolicy.recentEnd(kind)
            if recordedCallSession == next.callSession && !recordedRecordId.isEmpty {
                records = RecentMeetingsPolicy.end(records, id: recordedRecordId, end: end, atMillis: now)
                changed = true
            } else if kind == .denied && !sessionRoomId.isEmpty {
                let id = RecentMeetingsPolicy.recordId(roomId: sessionRoomId, joinMode: next.currentJoinMode)
                records = RecentMeetingsPolicy.upsert(records, RecentMeetingRecord(
                    id: id, roomId: sessionRoomId, title: sessionRoomId, joinMode: next.currentJoinMode.rawValue,
                    role: RecentRole.participant.rawValue, lastJoinedAtMillis: now, endedAtMillis: now,
                    end: RecentEnd.denied.rawValue))
                changed = true
            }
        }
        if changed {
            store?.save(records)
            republishHome()
        }
    }

    private func sessionNoticeKey(_ value: PremeetingInputs) -> String {
        String(value.callSession) + ":" + value.notice.rawValue + ":" + value.noticeText
    }

    private func currentNoticeKind() -> HomeNoticeKind {
        if localNotice != .none { return localNotice }
        guard inputs.phase == .home else { return .none }
        let kind = PremeetingRootPolicy.homeNotice(inputs.notice)
        guard kind != .none, sessionNoticeKey(inputs) != dismissedSessionNoticeKey else { return .none }
        return kind
    }

    private func republishHome() {
        let now = nowMillis()
        let candidate = RecentMeetingsPolicy.rejoinCandidate(records, nowMillis: now)
        var rows: [RecentMeetingRow] = []
        for index in 0..<records.count {
            let record = records[index]
            if let candidate, candidate.id == record.id {
                continue
            }
            rows.append(RecentMeetingRow(
                id: record.id,
                roomId: record.roomId,
                routeId: PremeetingRoute.recentRouteIdBase + index,
                routeKind: record.isWebinar ? PremeetingRouteKind.webinarLanding : PremeetingRouteKind.lobby,
                title: record.title,
                relativeTime: PremeetingTimeFormatting.relative(millis: record.lastJoinedAtMillis, nowMillis: now),
                role: record.recentRole,
                end: record.recentEnd ?? RecentEnd.left,
                avatarSeed: RecentMeetingRowPolicy.avatarSeed(roomId: record.roomId),
                code: RecentMeetingRowPolicy.code(title: record.title, roomId: record.roomId)
            ))
        }
        var card: RejoinCard? = nil
        if let candidate {
            card = RejoinCard(recentId: candidate.id, title: candidate.title,
                              endedAtText: PremeetingTimeFormatting.clockTime(millis: candidate.endedAtMillis),
                              end: candidate.recentEnd ?? RecentEnd.left)
        }
        let noticeKind = currentNoticeKind()
        let noticeText = noticeKind != HomeNoticeKind.none && noticeKind == PremeetingRootPolicy.homeNotice(inputs.notice) ? inputs.noticeText : ""
        let next = HomeSnapshot(
            revision: home.revision,
            noticeKind: noticeKind,
            noticeText: noticeText,
            rejoin: card,
            recents: rows,
            isSignedIn: inputs.isSignedIn,
            accountName: inputs.accountName,
            accountSeed: inputs.accountSeed,
            updateRequired: inputs.updateRequired,
            storeURL: inputs.storeURL
        )
        if next != home {
            home = HomeSnapshot(revision: home.revision + 1, noticeKind: next.noticeKind, noticeText: next.noticeText,
                                rejoin: next.rejoin, recents: next.recents, isSignedIn: next.isSignedIn,
                                accountName: next.accountName, accountSeed: next.accountSeed,
                                updateRequired: next.updateRequired, storeURL: next.storeURL)
            publishCount += 1
        }
        scheduleRejoinExpiry(candidate)
    }

    private func scheduleRejoinExpiry(_ candidate: RecentMeetingRecord?) {
        guard let candidate else {
            rejoinExpiryTask?.cancel()
            rejoinExpiryTask = nil
            scheduledRejoinKey = ""
            return
        }
        let key = candidate.id + ":" + String(candidate.endedAtMillis)
        guard key != scheduledRejoinKey || rejoinExpiryTask == nil else { return }
        rejoinExpiryTask?.cancel()
        scheduledRejoinKey = key
        let delayMillis = max(0.0, RecentMeetingsPolicy.rejoinExpiryMillis(candidate) - nowMillis())
        rejoinExpiryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delayMillis * 1_000_000.0))
            guard !Task.isCancelled else { return }
            self?.rejoinCardExpired()
        }
    }

    private func rejoinCardExpired() {
        rejoinExpiryTask = nil
        scheduledRejoinKey = ""
        republishHome()
    }

    private func refreshOutcome(_ next: PremeetingInputs, decision: PremeetingRootDecision) {
        guard decision.showsOutcome, let kind = next.outcomeKind,
              let variant = PremeetingRootPolicy.outcomeVariant(kind, entryOrigin: next.entryOrigin) else {
            publishOutcome(nil)
            return
        }

        let failure = EntryFailurePolicy.issue(category: next.joinFailureCategory, diagnosticCode: next.joinFailureCode,
                                               serverText: next.outcomeServerText)
        publishOutcome(OutcomeModelPolicy.model(id: next.outcomeId, variant: variant, hasRejoinContext: !next.rejoinRoomId.isEmpty,
                                            serverText: next.outcomeServerText, failure: failure))
    }

    private func refreshLobby() {

        refreshWebinar()
        guard let target = topLobbyTarget() else {
            clearLobby()
            return
        }
        if target.routeId != lobbyRouteId {
            beginLobby(target)
        }
        updateFormIssue()
        let mode = root.lobbyMode ?? LobbyMode.editing
        var issue = LobbyIssue.none
        var issueServerText = ""
        if inputs.updateRequired {
            issue = .updateRequired
        } else if mode == .failed {

            issue = EntryFailurePolicy.issue(category: inputs.joinFailureCategory, diagnosticCode: inputs.joinFailureCode,
                                             serverText: inputs.outcomeServerText)
            if issue == .failedServerText {
                issueServerText = MeetingErrorClassifier.cleanServerText(inputs.outcomeServerText)
            }
        } else if inputs.isNetworkOffline && (mode == .editing || mode == .connecting) {

            issue = .offline
        } else if mode == .editing && formIssue.issue != .none {
            issue = formIssue.issue
            if issue == .failedServerText {
                issueServerText = MeetingErrorClassifier.cleanServerText(inputs.noticeText)
            }
        }
        var waiting = WaitingKind.standard
        var waitingText = ""
        if mode == .waiting {

            waiting = WaitingKindPolicy.classify(waitingMessage: inputs.phase == .waiting ? inputs.noticeText : "",
                                                 isNetworkOffline: inputs.isNetworkOffline,
                                                 serverRestartText: inputs.serverRestartText,
                                                 isReconnecting: root.showsReconnecting)
            if waiting == .serverRestarting {
                waitingText = MeetingErrorClassifier.cleanServerText(inputs.serverRestartText)
            }
        } else if root.showsReconnecting {
            waiting = .reconnecting
        }
        if mode != .waiting {

            setStopAsking(false)
        }
        updateSlowNotice(mode: mode, routeId: target.routeId)
        let reason = primaryReason(for: target)
        publishLobbyStatus(LobbyStatusSnapshot(
            routeId: target.routeId,
            intent: target.intent,
            mode: mode,
            issue: issue,
            issueServerText: issueServerText,
            isPrimaryEnabled: (root.root == .premeeting || target.intent == .promotion)
                && LobbyPrimaryPolicy.isEnabled(mode: mode, reason: reason, isStarting: isStarting),
            primaryReason: LobbyPrimaryPolicy.snapshotValue(reason),
            showsSlowNotice: mode == .connecting && slowNoticeShown,
            waitingKind: waiting,
            isPrimaryPending: isStarting,
            waitingText: waitingText
        ))
        refreshMediaSnapshot()
        refreshPresenceSnapshot()
        publishLobbyIdentity(LobbySnapshotPolicy.identity(
            routeId: target.routeId,
            isSignedIn: inputs.isSignedIn,
            accountName: inputs.accountName,
            accountSeed: inputs.accountSeed,
            guestName: guestNameDraft,
            formIssue: formIssue
        ))
        publishLobbyLink(LobbySnapshotPolicy.link(routeId: target.routeId, intent: target.intent, roomId: target.roomId,
                                              title: target.title, clientId: target.clientId))
        refreshAudioSnapshot()
        updatePresencePolling()
        updatePreviewDemand()
    }

    private func primaryReason(for target: PremeetingRouteTarget) -> LobbyPrimaryReason {
        let reason = LobbyPrimaryPolicy.reason(intent: target.intent, isSignedIn: inputs.isSignedIn, guestName: guestNameDraft,
                                               isOffline: inputs.isNetworkOffline, updateRequired: inputs.updateRequired)

        if target.intent == .rejoin && canRejoin(roomId: target.roomId)
            && (reason == .nameMissingJoin || reason == .nameMissingStart) {
            return LobbyPrimaryReason.none
        }

        if target.intent == .promotion && (reason == .nameMissingJoin || reason == .nameMissingStart) {
            return LobbyPrimaryReason.none
        }
        return reason
    }

    private func beginLobby(_ target: PremeetingRouteTarget) {
        cancelLobbyTasks()
        lobbyRouteId = target.routeId
        guestNameDraft = inputs.isSignedIn ? "" : DisplayNamePolicy.capped(inputs.accountName)
        inviteCodeDraft = ""
        formIssue = LobbyFormIssue.none
        formIssueBaselineKey = inputs.notice == .formError ? sessionNoticeKey(inputs) : ""
        appliedFormIssueKey = ""
        chosenOutputKind = ""
        chosenInputId = ""
        presenceHasResult = false
        presenceCount = nil
        presenceRoomId = ""
        isStarting = false
    }

    private func clearLobby() {
        cancelLobbyTasks()
        isStarting = false
        if lobbyRouteId != 0 {
            lobbyRouteId = 0
        }
        visibleLobbyRouteId = 0
        setStopAsking(false)
        publishLobbyStatus(nil)
        publishLobbyMedia(nil)
        publishLobbyPresence(nil)
        publishLobbyIdentity(nil)
        publishLobbyLink(nil)
        publishLobbyAudio(nil)
        updatePreviewDemand()
    }

    private func cancelLobbyTasks() {
        stopPresencePolling()
        collisionTask?.cancel()
        collisionTask = nil
        cancelSlowNotice()
        slowNoticeShown = false
    }

    private func updateSlowNotice(mode: LobbyMode, routeId: Int) {
        let runs = EntrySlowNoticePolicy.runs(mode: mode,
                                              isLobbyVisible: visibleLobbyRouteId == routeId && root.root == .premeeting,
                                              alreadyShown: slowNoticeShown)
        guard runs else {
            cancelSlowNotice()
            return
        }
        guard slowNoticeTask == nil else { return }
        let delay = slowNoticeDelayMillis
        slowNoticeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(1.0, delay) * 1_000_000.0))
            guard !Task.isCancelled else { return }
            self?.slowNoticeFired(routeId: routeId)
        }
    }

    private func slowNoticeFired(routeId: Int) {
        slowNoticeTask = nil
        guard lobbyRouteId == routeId, let status = lobbyStatus, status.mode == .connecting else { return }
        slowNoticeShown = true
        advanceFeedback(.stillConnecting)
        refreshLobby()
    }

    private func cancelSlowNotice() {
        slowNoticeTask?.cancel()
        slowNoticeTask = nil
    }

    private func updateFormIssue() {
        if inputs.phase == .entering || inputs.phase == .waiting {
            if formIssue.issue != .none || formIssue.inviteCodeInvalid {
                formIssue = LobbyFormIssue(issue: .none, needsInviteCode: formIssue.needsInviteCode, inviteCodeInvalid: false)
            }
            return
        }
        guard inputs.phase == .home, inputs.notice == .formError else { return }
        let key = sessionNoticeKey(inputs)
        guard key != formIssueBaselineKey, key != appliedFormIssueKey else { return }
        appliedFormIssueKey = key
        let classified = LobbyIssuePolicy.classify(formError: inputs.noticeText, enteredInviteCode: inviteCodeDraft)
        formIssue = LobbyFormIssue(issue: classified.issue,
                                   needsInviteCode: classified.needsInviteCode || formIssue.needsInviteCode,
                                   inviteCodeInvalid: classified.inviteCodeInvalid)
    }

    private func refreshMediaSnapshot() {
        guard lobbyRouteId != 0 else { return }
        let name = LobbySnapshotPolicy.avatarName(isSignedIn: inputs.isSignedIn, accountName: inputs.accountName,
                                                  guestName: guestNameDraft)
        publishLobbyMedia(LobbySnapshotPolicy.media(
            routeId: lobbyRouteId,
            micIntentOn: inputs.micIntentOn,
            cameraIntentOn: inputs.cameraIntentOn,
            device: device,
            avatarName: name,
            avatarSeed: inputs.isSignedIn ? inputs.accountSeed : ""
        ))
    }

    private func refreshPresenceSnapshot() {
        guard lobbyRouteId != 0, let target = self.target(forRoute: lobbyRouteId) else { return }
        let mode = root.lobbyMode ?? LobbyMode.editing
        let kind = LobbyPresencePolicy.kind(hasResult: presenceHasResult, count: presenceCount, intent: target.intent,
                                            mode: mode)
        publishLobbyPresence(LobbyPresenceSnapshot(routeId: lobbyRouteId, kind: kind,
                                               count: kind == .count ? (presenceCount ?? 0) : 0))
    }

    private func refreshAudioSnapshot() {
        guard lobbyRouteId != 0 else { return }
        publishLobbyAudio(LobbyAudioPolicy.snapshot(routeId: lobbyRouteId, device: device, chosenOutputKind: chosenOutputKind,
                                                chosenInputId: chosenInputId))
    }

    private func updatePresencePolling() {
        guard let target = topLobbyTarget(), lobbyHooks?.fetchPresence != nil else {
            stopPresencePolling()
            return
        }
        let mode = root.lobbyMode ?? LobbyMode.editing
        let wanted = root.root == .premeeting && LobbyPresencePolicy.polls(
            intent: target.intent, mode: mode, isVisible: visibleLobbyRouteId == target.routeId,
            isAppActive: inputs.isAppActive, roomId: target.roomId)
        guard wanted else {
            stopPresencePolling()
            return
        }
        if presenceTask != nil && presenceRoomId == target.roomId {
            return
        }
        stopPresencePolling()
        presenceRoomId = target.roomId
        let routeId = target.routeId
        let roomId = target.roomId
        presenceTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let presenter = self else { return }
                await presenter.pollPresenceOnce(routeId: routeId, roomId: roomId)
                let interval = presenter.presenceIntervalMillis
                try? await Task.sleep(nanoseconds: UInt64(max(1.0, interval) * 1_000_000.0))
            }
        }
    }

    private func stopPresencePolling() {
        presenceTask?.cancel()
        presenceTask = nil
        presenceRoomId = ""
    }

    private func pollPresenceOnce(routeId: Int, roomId: String) async {
        guard let fetch = lobbyHooks?.fetchPresence else { return }
        presenceFetches += 1
        let count = await fetch(roomId, presenceClientId(routeId: routeId))
        guard !Task.isCancelled, lobbyRouteId == routeId else { return }
        presenceHasResult = true
        presenceCount = count
        refreshPresenceSnapshot()
    }

    private func presenceClientId(routeId: Int) -> String {
        if let clientId = target(forRoute: routeId)?.clientId, !clientId.isEmpty {
            return clientId
        }
        return lobbyHooks?.resolvedClientId?() ?? ""
    }

    private func updatePreviewDemand() {
        guard let hooks = lobbyHooks else { return }
        var wanted = false
        if let target = topLobbyTarget(), visibleLobbyRouteId == target.routeId {

            let callOwnsCamera = (root.root == .call && target.intent != .promotion) || previewHandedOff
            wanted = LocalPreviewPolicy.isWanted(cameraIntentOn: inputs.cameraIntentOn, permission: device.cameraPermission,
                                                 isLobbyVisible: true,
                                                 isCallOwningCamera: callOwnsCamera)
        }
        if wanted && !previewRequested {
            previewRequested = true
            hooks.startPreview?(device.isFrontCamera ? LocalCameraFacing.front : LocalCameraFacing.back)
        } else if !wanted && previewRequested {
            previewRequested = false
            if (root.root != .call || promotionRoute != nil || lobbyRouteIsPromotion) && !previewHandedOff {
                hooks.stopPreview?()
            }
        }
    }

    private func handOffPreview() {
        previewHandedOff = true
        previewRequested = false
        let running = device.previewState == .live || device.previewState == .starting
            || device.previewState == .interrupted
        if running {
            lobbyHooks?.handOffPreview?()
        }
    }

    private func runCollisionCheck(routeId: Int) async {
        var attempt = 1
        while !Task.isCancelled {
            guard let target = self.target(forRoute: routeId), let fetch = lobbyHooks?.fetchPresence else { break }
            let count = await fetch(target.roomId, presenceClientId(routeId: routeId))
            if Task.isCancelled { return }
            guard LobbyCollisionPolicy.shouldRegenerate(count: count, attempt: attempt) else { break }
            replaceTargetRoom(routeId: routeId, roomId: generateRoomCode())
            attempt += 1
        }
        if Task.isCancelled { return }
        collisionTask = nil
        isStarting = false
        guard let target = self.target(forRoute: routeId), topLobbyTarget()?.routeId == routeId else {
            refreshLobby()
            return
        }
        submitJoin(target)
    }

    private func replaceTargetRoom(routeId: Int, roomId: String) {
        var next: [PremeetingRouteTarget] = []
        for target in targets {
            if target.routeId == routeId {
                next.append(PremeetingRouteTarget(routeId: target.routeId, kind: target.kind, intent: target.intent,
                                                  roomId: roomId, title: roomId, joinMode: target.joinMode,
                                                  meetingInviteCode: target.meetingInviteCode,
                                                  webinarInviteCode: target.webinarInviteCode,
                                                  clientId: target.clientId,
                                                  allowRoomCreation: target.allowRoomCreation))
            } else {
                next.append(target)
            }
        }
        targets = next
        refreshLobby()
    }

    private func submitJoin(_ target: PremeetingRouteTarget) {
        let request = LobbyJoinCoordinator.makeRequest(
            target: target,
            isSignedIn: inputs.isSignedIn,
            accountName: inputs.accountName,
            guestName: guestNameDraft,
            enteredInviteCode: inviteCodeDraft,
            needsInviteCode: formIssue.needsInviteCode,
            resolvedClientId: lobbyHooks?.resolvedClientId?() ?? MeetingLinkBuilder.defaultClientId,
            facing: device.isFrontCamera ? LocalCameraFacing.front : LocalCameraFacing.back
        )
        guard let request else {
            refreshLobby()
            return
        }
        formIssue = LobbyFormIssue(issue: .none, needsInviteCode: formIssue.needsInviteCode, inviteCodeInvalid: false)
        joinRequests += 1
        lobbyHooks?.join?(request)
        refreshLobby()
    }

    private func advanceFeedback(_ kind: FeedbackKind) {
        let token = FeedbackToken(sequence: feedbackState.token.sequence + 1, kind: kind)
        feedbackState = MeetingShellFeedbackState(session: feedbackState.session, token: token)
        publishCount += 1
    }

    private func refreshWebinar() {
        guard let target = topWebinarTarget() else {
            clearWebinar()
            return
        }
        if target.routeId != webinarRouteId {
            beginWebinar(target)
        }
        if webinarJoinPending && inputs.phase != .home && inputs.phase != .outcome {

            webinarJoinPending = false
        }
        updateWebinarFormIssue()
        let now = nowMillis()
        let status = webinarStatus(now: now)
        var failure = WebinarLandingFailure.none
        if status == .failed {
            failure = isWebinarFailureShowing() ? WebinarLandingFailure.join : WebinarLandingFailure.lookup
        }
        let answer = webinarAnswer
        let needsName = WebinarLandingPolicy.needsName(isSignedIn: inputs.isSignedIn, accountName: inputs.accountName)
        let linkCode = (target.webinarInviteCode ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        let needsInviteCode = webinarNeedsInviteCode || (answer?.requiresInviteCode == true && linkCode.isEmpty)
        let primaryEnabled = root.root == .premeeting && WebinarLandingPolicy.isPrimaryEnabled(
            status: status, needsName: needsName, nameDraft: webinarNameDraft, needsInviteCode: needsInviteCode,
            inviteDraft: webinarInviteDraft, linkHasInviteCode: !linkCode.isEmpty && !webinarNeedsInviteCode)
        setWebinarSnapshot(WebinarLandingSnapshot(
            revision: 0,
            routeId: target.routeId,
            slug: target.roomId,
            status: status,
            tag: WebinarLandingPolicy.tag(status: status, answer: answer, nowMillis: now),
            title: answer?.title ?? "",
            hostName: answer?.hostName ?? "",
            startsAtMillis: answer?.startsAtMillis ?? 0.0,
            endsAtMillis: answer?.endsAtMillis ?? 0.0,
            earlyEntryMinutes: answer?.earlyEntryMinutes ?? 0,
            needsName: needsName,
            nameLimit: DisplayNamePolicy.limit,
            needsInviteCode: needsInviteCode,
            inviteCodeInvalid: webinarInviteInvalid,
            isPrimaryEnabled: primaryEnabled,
            action: WebinarLandingPolicy.action(status),
            failure: failure,
            link: WebinarLandingPolicy.shareLink(slug: target.roomId, serverLink: answer?.link ?? "")
        ))
        updateWebinarRefetch(status: status)
        updateWebinarWake(status: status, now: now)
    }

    private func webinarStatus(now: Double) -> WebinarLandingStatus {
        let lookup = WebinarLandingPolicy.lookupStatus(webinarAnswer, nowMillis: now)
        if let join = webinarJoinStatus() {
            if join == .waitingForHost && (lookup == .ended || lookup == .cancelled) {
                return lookup
            }
            return join
        }
        if webinarFormUnavailable {
            return .unavailable
        }
        return lookup
    }

    private func webinarJoinStatus() -> WebinarLandingStatus? {
        guard webinarAttempted else { return nil }
        if isWebinarJoinInFlight() || inputs.phase == .inCall {
            if webinarSilentRetry {
                return .waitingForHost
            }
            return inputs.entrySocketConnected ? WebinarLandingStatus.almostThere : WebinarLandingStatus.joining
        }
        if isWebinarFailureShowing() {
            return WebinarLandingPolicy.joinFailureStatus(category: inputs.joinFailureCategory,
                                                          diagnosticCode: inputs.joinFailureCode,
                                                          serverText: inputs.outcomeServerText)
        }
        return nil
    }

    private func isWebinarJoinInFlight() -> Bool {
        guard webinarAttempted else { return false }
        switch inputs.phase {
        case .home, .outcome:
            return webinarJoinPending
        case .entering, .waiting:
            return true
        case .recovering:
            return !inputs.hasBeenAdmittedThisSession
        case .inCall, .leaving:
            return false
        }
    }

    private func isWebinarFailureShowing() -> Bool {
        webinarAttempted && !webinarJoinPending && inputs.phase == .outcome && inputs.outcomeKind == .joinFailed
    }

    private func updateWebinarFormIssue() {
        guard webinarAttempted, inputs.phase == .home, inputs.notice == .formError else { return }
        let key = sessionNoticeKey(inputs)
        guard key != webinarFormBaselineKey else { return }
        webinarFormBaselineKey = key
        webinarAttempted = false
        webinarJoinPending = false
        webinarSilentRetry = false
        if WebinarLandingPolicy.isInviteCodeError(inputs.noticeText) {
            webinarNeedsInviteCode = true
            webinarInviteInvalid = WebinarLandingPolicy.isInviteCodeInvalid(inputs.noticeText)
            webinarFormUnavailable = false
        } else {
            webinarFormUnavailable = true
        }
    }

    private func beginWebinar(_ target: PremeetingRouteTarget) {
        stopWebinarRefetch()
        stopWebinarWake()
        webinarRouteId = target.routeId
        webinarAnswer = nil
        webinarNameDraft = ""
        webinarInviteDraft = ""
        webinarNeedsInviteCode = false
        webinarInviteInvalid = false
        webinarFormUnavailable = false
        webinarAttempted = false
        webinarJoinPending = false
        webinarSilentRetry = false
        webinarFormBaselineKey = inputs.notice == .formError ? sessionNoticeKey(inputs) : ""
        webinarLastFetchMillis = 0.0
        if target.intent == .rejoin && canRejoin(roomId: target.roomId) {
            webinarAttempted = true
            webinarJoinPending = true
            webinarSessionSlug = target.roomId
            webinarSessionTitle = target.title
        }
    }

    private func clearWebinar() {
        stopWebinarRefetch()
        stopWebinarWake()
        if webinarRouteId != 0 {
            webinarRouteId = 0
            webinarAnswer = nil
            webinarNameDraft = ""
            webinarInviteDraft = ""
            webinarNeedsInviteCode = false
            webinarInviteInvalid = false
            webinarFormUnavailable = false
            webinarAttempted = false
            webinarJoinPending = false
            webinarSilentRetry = false
            webinarFormBaselineKey = ""
            webinarLastFetchMillis = 0.0

            webinarSessionSlug = ""
            webinarSessionTitle = ""
        }
        visibleWebinarRouteId = 0
        setWebinarSnapshot(nil)
    }

    private func sendWebinarJoin(_ target: PremeetingRouteTarget, silent: Bool) {
        let typedCode = webinarInviteDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let linkCode = (target.webinarInviteCode ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var inviteCode: String? = nil
        if !typedCode.isEmpty {
            inviteCode = typedCode
        } else if !linkCode.isEmpty {
            inviteCode = linkCode
        }
        let title = webinarAnswer?.title ?? ""
        let request = WebinarJoinRequest(
            routeId: target.routeId,
            slug: target.roomId,
            displayName: WebinarLandingPolicy.displayName(isSignedIn: inputs.isSignedIn, accountName: inputs.accountName,
                                                          nameDraft: webinarNameDraft),
            isGuest: !inputs.isSignedIn,
            webinarInviteCode: inviteCode,
            clientId: target.clientId,
            title: title
        )
        webinarAttempted = true
        webinarJoinPending = true
        webinarSilentRetry = silent
        webinarFormUnavailable = false
        webinarInviteInvalid = false
        webinarFormBaselineKey = inputs.notice == .formError ? sessionNoticeKey(inputs) : ""

        webinarSessionSlug = target.roomId
        webinarSessionTitle = title.isEmpty ? target.title : title
        webinarJoinRequests += 1
        webinarHooks?.join?(request)
        refreshWebinar()
    }

    private func retryWaitingForHostIfOpen() {
        guard let target = topWebinarTarget(), let snapshot = webinar, snapshot.routeId == target.routeId,
              snapshot.status == .waitingForHost, !isWebinarJoinInFlight() else { return }
        guard WebinarLandingPolicy.lookupStatus(webinarAnswer, nowMillis: nowMillis()) == .openNow else { return }
        guard root.root == .premeeting, !inputs.updateRequired else { return }
        sendWebinarJoin(target, silent: true)
    }

    private func updateWebinarRefetch(status: WebinarLandingStatus) {
        let visible = visibleWebinarRouteId != 0 && visibleWebinarRouteId == webinarRouteId
        let wanted = visible && webinarSceneActive && inputs.isAppActive && root.root == .premeeting
            && webinarHooks?.lookup != nil && WebinarLandingPolicy.refetches(status)
        guard wanted else {
            stopWebinarRefetch()
            return
        }
        guard webinarRefetchTask == nil else { return }
        let routeId = webinarRouteId
        webinarRefetchTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let presenter = self else { return }
                let wait = presenter.webinarRefetchWaitMillis()
                if wait <= 0.0 {
                    await presenter.lookUpWebinarOnce(routeId: routeId)
                } else {
                    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000.0))
                }
            }
        }
    }

    private func webinarRefetchWaitMillis() -> Double {
        guard webinarLastFetchMillis > 0.0 else { return 0.0 }
        return max(0.0, webinarLastFetchMillis + max(1.0, webinarRefetchIntervalMillis) - nowMillis())
    }

    private func stopWebinarRefetch() {
        webinarRefetchTask?.cancel()
        webinarRefetchTask = nil
    }

    private func lookUpWebinarOnce(routeId: Int) async {
        webinarLastFetchMillis = max(1.0, nowMillis())
        guard let lookup = webinarHooks?.lookup, let target = self.target(forRoute: routeId) else { return }
        webinarLookups += 1
        let answer = await lookup(target.roomId, target.clientId ?? "")
        guard webinarRouteId == routeId else { return }
        guard !Task.isCancelled else {
            if webinarAnswer == nil {
                webinarLastFetchMillis = 0.0
            }
            return
        }

        if answer.outcome == WebinarLookupOutcome.failed && webinarAnswer != nil {
            return
        }
        webinarAnswer = answer
        refreshWebinar()
        retryWaitingForHostIfOpen()
    }

    private func updateWebinarWake(status: WebinarLandingStatus, now: Double) {
        let visible = visibleWebinarRouteId != 0 && visibleWebinarRouteId == webinarRouteId
        guard visible, webinarSceneActive, inputs.isAppActive, root.root == .premeeting, status == .early,
              let answer = webinarAnswer,
              let delay = WebinarLandingPolicy.openWakeDelayMillis(answer, nowMillis: now) else {
            stopWebinarWake()
            return
        }
        let opensAt = WebinarLandingPolicy.opensAtMillis(answer)
        if webinarOpenWakeTask != nil && webinarWakeAtMillis == opensAt {
            return
        }
        stopWebinarWake()
        webinarWakeAtMillis = opensAt
        let routeId = webinarRouteId
        webinarOpenWakeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(1.0, delay) * 1_000_000.0))
            guard !Task.isCancelled else { return }
            self?.webinarOpenWakeFired(routeId: routeId)
        }
    }

    private func webinarOpenWakeFired(routeId: Int) {
        webinarOpenWakeTask = nil
        webinarWakeAtMillis = 0.0
        guard webinarRouteId == routeId else { return }
        refreshWebinar()
    }

    private func stopWebinarWake() {
        webinarOpenWakeTask?.cancel()
        webinarOpenWakeTask = nil
        webinarWakeAtMillis = 0.0
    }

    private func setWebinarSnapshot(_ value: WebinarLandingSnapshot?) {
        guard let value else {
            guard webinar != nil else { return }
            webinar = nil
            publishCount += 1
            return
        }
        if let current = webinar, current.withRevision(0) == value.withRevision(0) {
            return
        }
        webinarRevision += 1
        webinar = value.withRevision(webinarRevision)
        publishCount += 1
    }

    private func setPathValue(_ routes: [PremeetingRoute]) {
        guard routes != path else { return }
        let hadAccount = PremeetingPresenter.containsAccount(path)
        path = routes
        publishCount += 1
        if hadAccount && !PremeetingPresenter.containsAccount(routes) {

            account.didDismiss()
        }
        var kept: [PremeetingRouteTarget] = []
        for target in targets {
            var inPath = false
            for route in routes where route.id == target.routeId {
                inPath = true
            }
            let isPending = pendingTarget?.routeId == target.routeId
            if inPath || isPending {
                kept.append(target)
            }
        }
        targets = kept
    }

    private static func containsAccount(_ routes: [PremeetingRoute]) -> Bool {
        for route in routes where route.kind == .account {
            return true
        }
        return false
    }

    private func publishRoot(_ value: PremeetingRootDecision) {
        guard value != root else { return }
        root = value
        publishCount += 1
    }

    private func publishOutcome(_ value: OutcomeModel?) {
        guard value != outcome else { return }
        outcome = value
        publishCount += 1
    }

    private func publishLobbyStatus(_ value: LobbyStatusSnapshot?) {
        guard value != lobbyStatus else { return }
        lobbyStatus = value
        publishCount += 1
    }

    private func publishLobbyMedia(_ value: LobbyMediaSnapshot?) {
        guard value != lobbyMedia else { return }
        lobbyMedia = value
        publishCount += 1
    }

    private func publishLobbyPresence(_ value: LobbyPresenceSnapshot?) {
        guard value != lobbyPresence else { return }
        lobbyPresence = value
        publishCount += 1
    }

    private func publishLobbyIdentity(_ value: LobbyIdentitySnapshot?) {
        guard value != lobbyIdentity else { return }
        lobbyIdentity = value
        publishCount += 1
    }

    private func publishLobbyLink(_ value: LobbyLinkSnapshot?) {
        guard value != lobbyLink else { return }
        lobbyLink = value
        publishCount += 1
    }

    private func publishLobbyAudio(_ value: LobbyAudioSnapshot?) {
        guard value != lobbyAudio else { return }
        lobbyAudio = value
        publishCount += 1
    }

    private func setJoinSheet(_ value: Bool) {
        guard value != isJoinSheetPresented else { return }
        isJoinSheetPresented = value
        publishCount += 1
    }

    private func setAccountSheet(_ value: Bool) {
        guard value != isAccountSheetPresented else { return }
        isAccountSheetPresented = value
        publishCount += 1
    }

    private func setUpdatePrompt(_ value: Bool) {
        guard value != isUpdatePromptPresented else { return }
        isUpdatePromptPresented = value
        publishCount += 1
    }

    private func setStopAsking(_ value: Bool) {
        guard value != isStopAskingPresented else { return }
        isStopAskingPresented = value
        publishCount += 1
    }

    private func publishSwitchPrompt(_ value: RoomSwitchPrompt?) {
        guard value != switchPrompt else { return }
        switchPrompt = value
        publishCount += 1
    }
}
