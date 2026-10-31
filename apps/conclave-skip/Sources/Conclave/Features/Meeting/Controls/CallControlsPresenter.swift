import Foundation
import Observation

@MainActor
@Observable
final class CallControlsPresenter {

    private(set) var bar: ControlBarSnapshot = ControlBarSnapshot.empty

    private(set) var leaveState: LeaveSnapshot = LeaveSnapshot.idle

    private(set) var explanation: ControlExplanation? = nil

    private(set) var permissionPrompt: ControlPermissionPrompt? = nil

    private(set) var more: MoreSnapshot = MoreSnapshot.empty

    private(set) var moreMetrics: MoreMenuMetrics = MoreMenuMetrics.empty

    private(set) var reactions: ReactionPaletteSnapshot = ReactionPaletteSnapshot.empty

    private(set) var commands: CallCommandsSnapshot = CallCommandsSnapshot.empty

    private(set) var shortcuts: MediaShortcutSnapshot = MediaShortcutSnapshot.empty

    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    @ObservationIgnored var routeOwner: AudioRouteOwner = AudioRouteOwner.shared

    @ObservationIgnored let shell: MeetingShellPresenter

    @ObservationIgnored let stage: StagePresenter

    @ObservationIgnored var onExplain: ((ControlExplanation) -> Void)? = nil

    @ObservationIgnored var onCommand: ((CallControlsCommand) -> Void)? = nil

    @ObservationIgnored var onRequest: ((CallControlsRequest) -> Bool)? = nil

    @ObservationIgnored var onRecap: ((RecapCommandKind) -> Bool)? = nil

    @ObservationIgnored private(set) var recap = RecapControlsState.none

    @ObservationIgnored private(set) var recapRequestCount = 0
    @ObservationIgnored private(set) var endNowCount = 0

    @ObservationIgnored private(set) var inputs = CallControlsInputs.make()
    @ObservationIgnored private(set) var windowWidth = ControlsWindowClass.compact
    @ObservationIgnored private(set) var windowHeight = ControlsWindowClass.regular
    @ObservationIgnored private(set) var isPhone = true

    @ObservationIgnored private(set) var compositionOverride: ControlBarComposition? = nil

    @ObservationIgnored private(set) var overflowIds: [String] = []

    @ObservationIgnored private(set) var fitReadout = "none"

    @ObservationIgnored private(set) var applyCount = 0
    @ObservationIgnored private(set) var barPublishCount = 0
    @ObservationIgnored private(set) var explainCount = 0
    @ObservationIgnored private(set) var promptCount = 0
    @ObservationIgnored private(set) var commandCount = 0
    @ObservationIgnored private var nextExplanationId = 0
    @ObservationIgnored private var nextPromptId = 0

    @ObservationIgnored private(set) var endRequestCount = 0
    @ObservationIgnored private(set) var endDispatchCount = 0
    @ObservationIgnored private(set) var endingNoticeCount = 0
    @ObservationIgnored private(set) var endFailedNoticeCount = 0

    @ObservationIgnored private(set) var endingNoticeId = ""

    @ObservationIgnored private var endResultOwed = false

    @ObservationIgnored private var isConfirmingEnd = false
    @ObservationIgnored private var nextEndingNoticeSerial = 0

    @ObservationIgnored private(set) var reactionCount = 0
    @ObservationIgnored private(set) var panelRequestCount = 0
    @ObservationIgnored private(set) var captionsRequestCount = 0
    @ObservationIgnored private(set) var layoutRequestCount = 0
    @ObservationIgnored private(set) var flipRequestCount = 0
    @ObservationIgnored private(set) var lockRequestCount = 0
    @ObservationIgnored private(set) var copyLinkCount = 0
    @ObservationIgnored private(set) var inviteCount = 0
    @ObservationIgnored private(set) var systemEffectsRequestCount = 0
    @ObservationIgnored private(set) var keyboardCommandCount = 0

    @ObservationIgnored private(set) var moreSheetDismissCount = 0

    @ObservationIgnored private(set) var menuHeightReadout = "none"

    @ObservationIgnored private(set) var handIntent = MeetingActionDirection.none

    @ObservationIgnored private(set) var routeRequestCount = 0
    @ObservationIgnored private(set) var bluetoothAccessRequestCount = 0
    @ObservationIgnored private(set) var inputRequestCount = 0
    @ObservationIgnored private(set) var speakerRequestCount = 0
    @ObservationIgnored private(set) var audioSettingsCount = 0
    @ObservationIgnored private(set) var routeFailureCount = 0
    @ObservationIgnored private(set) var routeRetryCount = 0
    @ObservationIgnored private(set) var routePickerCloseCount = 0
    @ObservationIgnored private(set) var inputPickerCount = 0
    @ObservationIgnored private(set) var micModesRequestCount = 0

    init(shell: MeetingShellPresenter, stage: StagePresenter) {
        self.shell = shell
        self.stage = stage
    }

    func apply(_ next: CallControlsInputs) {
        applyCount += 1
        absorb(next)
    }

    func setWindow(width: ControlsWindowClass, height: ControlsWindowClass, isPhone: Bool) {
        if width == windowWidth && height == windowHeight && isPhone == self.isPhone { return }
        windowWidth = width
        windowHeight = height
        self.isPhone = isPhone
        recompute()
    }

    func setCompositionOverride(_ composition: ControlBarComposition?) {
        if composition == compositionOverride { return }
        compositionOverride = composition
        recompute()
    }

    func setOverflow(ids: [String]) {
        if ids == overflowIds { return }
        overflowIds = ids
        recompute()
    }

    func reportMenuHeight(_ readout: String) {
        if readout != menuHeightReadout { menuHeightReadout = readout }
    }

    func noteMoreSheetDismissed() {
        moreSheetDismissCount += 1
    }

    func reportFit(_ readout: String) {
        if readout != fitReadout { fitReadout = readout }
    }

    var layout: ControlBarLayout {
        let picked = ControlBarPolicy.layout(width: windowWidth, height: windowHeight, isPhone: isPhone,
                                             isAttendee: inputs.isWebinarAttendee)
        if let forced = compositionOverride, !inputs.isWebinarAttendee {
            return ControlBarLayout(composition: forced, axis: picked.axis)
        }
        return picked
    }

    func model(_ kind: CallControlKind) -> CallControlModel? {
        let composition = layout.composition
        if let shown = bar.control(kind) { return shown }
        return ControlBarPolicy.control(kind, inputs: inputs, composition: composition)
    }

    @discardableResult
    func tap(_ kind: CallControlKind) -> ControlTapResult {
        stage.noteControlAction()
        guard let current = model(kind) else { return ControlTapResult.ignored }
        if current.isBlocked {
            return explainBlocked(current)
        }
        switch kind {
        case .microphone:
            return result(shell.toggleMicrophone(), kind: kind)
        case .camera:
            return result(shell.toggleCamera(), kind: kind)
        case .screenShare:
            return result(shell.toggleScreenShare(), kind: kind)
        case .hand:
            return toggleHand(current.isOn)
        case .chat, .participants, .qa:
            guard let panel = ControlBarPolicy.panel(kind) else { return ControlTapResult.ignored }
            shell.panels.toggle(panel, from: PanelInvoker.call)
            return ControlTapResult.dispatched
        case .more:

            return ControlTapResult.dispatched
        case .leave:
            return leave()
        }
    }

    @discardableResult
    func leave() -> ControlTapResult {
        stage.noteControlAction()
        let dispatch = shell.leave()
        refreshFromShell()
        switch dispatch {
        case .dispatched: return ControlTapResult.dispatched
        default: return ControlTapResult.ignored
        }
    }

    func requestEndForEveryone(from invoker: String) {
        stage.noteControlAction()
        endRequestCount += 1
        shell.requestEndForEveryone(from: invoker)
        refreshFromShell()
    }

    @discardableResult
    func confirmEndForEveryone(id: Int, postRecap: Bool) -> ControlTapResult {
        if postRecap && leaveState.offersRecap && id != 0 && leaveState.confirmationId == id, let handler = onRecap {
            stage.noteControlAction()
            shell.cancelConfirmation(id: id)
            recapRequestCount += 1
            let accepted = handler(RecapCommandKind.postAndEnd)
            refreshFromShell()
            if !accepted { return finishRecapAndEnd() }
            return ControlTapResult.dispatched
        }
        stage.noteControlAction()
        isConfirmingEnd = true
        let dispatch = shell.confirmEndForEveryone(id: id)
        isConfirmingEnd = false
        if dispatch == MeetingDispatch.dispatched {
            endDispatchCount += 1
            endResultOwed = true
        }
        refreshFromShell()
        switch dispatch {
        case .dispatched: return ControlTapResult.dispatched
        default: return ControlTapResult.ignored
        }
    }

    @discardableResult
    func finishRecapAndEnd() -> ControlTapResult {
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.call)
        let id = shell.session.confirmation?.id ?? 0
        if id == 0 {
            refreshFromShell()
            return ControlTapResult.ignored
        }
        endRequestCount += 1
        isConfirmingEnd = true
        let dispatch = shell.confirmEndForEveryone(id: id)
        isConfirmingEnd = false
        if dispatch == MeetingDispatch.dispatched {
            endDispatchCount += 1
            endResultOwed = true
        }
        refreshFromShell()
        return dispatch == MeetingDispatch.dispatched ? ControlTapResult.dispatched : ControlTapResult.ignored
    }

    @discardableResult
    func endNowDuringRecap() -> ControlTapResult {
        stage.noteControlAction()
        guard leaveState.endPhase == EndPhase.postingRecap, let handler = onRecap else { return ControlTapResult.ignored }
        endNowCount += 1
        return handler(RecapCommandKind.endNow) ? ControlTapResult.dispatched : ControlTapResult.ignored
    }

    func applyRecap(_ next: RecapControlsState) {
        if next == recap { return }
        recap = next
        recompute()
    }

    func cancelEnd(id: Int) {
        stage.noteControlAction()
        shell.cancelConfirmation(id: id)
        refreshFromShell()
    }

    @discardableResult
    func selectLeaveMenuItem(_ id: String) -> ControlTapResult {
        if id == LeaveControlPolicy.leaveItemId {
            return leave()
        }
        if id == LeaveControlPolicy.endItemId {
            if !LeaveControlPolicy.offersEndAction(leaveState) {
                stage.noteControlAction()
                return ControlTapResult.ignored
            }
            requestEndForEveryone(from: MeetingConfirmationInvoker.call)
            return leaveState.confirmationId != 0 ? ControlTapResult.dispatched : ControlTapResult.ignored
        }
        return ControlTapResult.ignored
    }

    @discardableResult
    func select(_ id: MoreItemID) -> ControlTapResult {
        stage.noteControlAction()
        guard let item = more.item(id), item.isEnabled else { return ControlTapResult.ignored }
        switch id {
        case .reactions:

            return ControlTapResult.ignored
        case .moreReactions:
            return reactions.art.isEmpty ? ControlTapResult.ignored : ControlTapResult.dispatched
        case .hand:

            return toggleHand(item.isOn)
        case .screenShare:
            return result(shell.toggleScreenShare(), kind: CallControlKind.screenShare)
        case .captions:
            return setCaptions(!item.isOn)
        case .flipCamera:
            flipRequestCount += 1
            return submit(CallControlsRequest.make(CallControlsRequestKind.flipCamera))
        case .systemVideoEffects:
            systemEffectsRequestCount += 1
            return submit(CallControlsRequest.make(CallControlsRequestKind.showSystemVideoEffects))
        case .chat, .participants, .activities, .transcript, .qa, .layout, .effects, .settings, .meetingDetails, .hostControls:
            guard let panel = MoreMenuPolicy.panel(id) else { return ControlTapResult.ignored }
            panelRequestCount += 1
            return shell.panels.presentFromMore(panel) ? ControlTapResult.dispatched : ControlTapResult.ignored
        case .invite:

            inviteCount += 1
            return ControlTapResult.dispatched
        case .copyLink:
            return copyLink(postsToast: true)
        case .lockMeeting:

            lockRequestCount += 1
            return submit(CallControlsRequest.make(CallControlsRequestKind.setRoomLock,
                                                    value: item.isOn ? CallControlsRequest.off : CallControlsRequest.on))
        case .endForEveryone:
            requestEndForEveryone(from: MeetingConfirmationInvoker.more)
            return MoreMenuPolicy.presentsEndDialog(leaveState) ? ControlTapResult.dispatched : ControlTapResult.ignored
        }
    }

    @discardableResult
    func setCaptions(_ on: Bool) -> ControlTapResult {
        stage.noteControlAction()
        if inputs.phase == MeetingPhaseKind.leaving || inputs.isWebinarAttendee { return ControlTapResult.ignored }
        captionsRequestCount += 1
        return submit(CallControlsRequest.make(CallControlsRequestKind.setCaptions,
                                                value: on ? CallControlsRequest.on : CallControlsRequest.off))
    }

    @discardableResult
    func setLayoutMode(_ raw: String) -> ControlTapResult {
        stage.noteControlAction()
        if !MoreMenuPolicy.layoutModes.contains(raw) || raw == inputs.layoutMode { return ControlTapResult.ignored }
        layoutRequestCount += 1
        return submit(CallControlsRequest.make(CallControlsRequestKind.setLayoutMode, value: raw))
    }

    @discardableResult
    func copyLink(postsToast: Bool) -> ControlTapResult {
        stage.noteControlAction()
        guard let item = more.item(MoreItemID.copyLink), item.isEnabled else { return ControlTapResult.ignored }
        copyLinkCount += 1
        if postsToast {
            stage.postLocal(MeetingNotice.make(kind: NoticeKind.linkCopied))
        }
        return ControlTapResult.dispatched
    }

    @discardableResult
    func perform(_ command: CallCommandID) -> ControlTapResult {
        guard let item = commands.item(command), item.isVisible, item.isEnabled else { return ControlTapResult.ignored }
        keyboardCommandCount += 1
        switch command {
        case .microphone: return tap(CallControlKind.microphone)
        case .camera: return tap(CallControlKind.camera)
        case .hand: return tap(CallControlKind.hand)
        case .screenShare: return tap(CallControlKind.screenShare)
        case .chat, .participants:
            stage.noteControlAction()
            let panel = command == CallCommandID.chat ? MeetingPanel.chat : MeetingPanel.participants
            shell.panels.present(panel, from: PanelInvoker.call)
            return ControlTapResult.dispatched
        case .lockMeeting:
            return select(MoreItemID.lockMeeting)
        }
    }

    var route: AudioRouteSnapshot { routeOwner.route }

    @discardableResult
    func requestRoute(id: String) -> ControlTapResult {
        stage.noteControlAction()
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || inputs.phase == MeetingPhaseKind.leaving { return ControlTapResult.ignored }
        let current = routeOwner.route
        if RoutePickerPolicy.isAccessRow(trimmed) {
            if current.bluetoothAccess == BluetoothRouteAccess.notNeeded { return ControlTapResult.ignored }
            bluetoothAccessRequestCount += 1
            routeOwner.requestBluetoothAccess()
            return ControlTapResult.dispatched
        }
        var known = false
        for option in current.options {
            if option.id == trimmed { known = true }
        }
        if !known { return ControlTapResult.ignored }
        routeRequestCount += 1
        routeOwner.requestRoute(id: trimmed)
        return ControlTapResult.dispatched
    }

    @discardableResult
    func retryRoute(id: String) -> ControlTapResult {
        routeRetryCount += 1
        return requestRoute(id: id)
    }

    @discardableResult
    func requestInput(id: String) -> ControlTapResult {
        stage.noteControlAction()
        let current = routeOwner.route
        if id.isEmpty || id == current.currentInputId || inputs.phase == MeetingPhaseKind.leaving { return ControlTapResult.ignored }
        var known = false
        for input in current.inputs {
            if input.id == id { known = true }
        }
        if !known { return ControlTapResult.ignored }
        inputRequestCount += 1
        routeOwner.requestInput(id: id)
        return ControlTapResult.dispatched
    }

    @discardableResult
    func setSpeaker(_ on: Bool) -> ControlTapResult {
        stage.noteControlAction()
        let current = routeOwner.route
        if !current.canToggleSpeaker || current.isSpeakerOn == on || inputs.phase == MeetingPhaseKind.leaving {
            return ControlTapResult.ignored
        }
        speakerRequestCount += 1
        routeOwner.setSpeaker(on)
        return ControlTapResult.dispatched
    }

    @discardableResult
    func openAudioSettings() -> ControlTapResult {
        stage.noteControlAction()
        if !MoreMenuPolicy.isLanded(MeetingPanel.settings) || inputs.phase == MeetingPhaseKind.leaving { return ControlTapResult.ignored }
        audioSettingsCount += 1
        shell.panels.present(MeetingPanel.settings, from: PanelInvoker.call, destination: PanelDestination.settingsAudio)
        return ControlTapResult.dispatched
    }

    func setRoutePickerOpen(_ open: Bool) {
        stage.setTransientChrome(id: ChromeAutoHidePolicy.routePicker, open: open)
        if !open {
            routePickerCloseCount += 1
            routeOwner.noteSystemRoutePickerDismissed()
        }
    }

    func routeFailed(id: String) {
        routeFailureCount += 1
        stage.postLocal(RoutePickerPolicy.failureNotice(routeId: id))
        feedbackState = MeetingShellFeedbackState(session: inputs.callSession,
                                                  token: FeedbackToken(sequence: feedbackState.token.sequence + 1,
                                                                       kind: FeedbackKind.routeSwitchFailed))
    }

    func microphoneShortcuts(chooser: MicrophoneInputChooser) -> [MediaShortcutItem] {
        MediaShortcutPolicy.microphoneItems(route: routeOwner.route, chooser: chooser,
                                            opensAudioSettings: MoreMenuPolicy.isLanded(MeetingPanel.settings),
                                            isLeaving: inputs.phase == MeetingPhaseKind.leaving)
    }

    @discardableResult
    func selectShortcut(_ kind: MediaShortcutItemID) -> ControlTapResult {
        switch kind {
        case .flipCamera, .effects, .systemVideoEffects:
            stage.noteControlAction()
            guard let item = shortcuts.cameraItem(kind), item.isEnabled else { return ControlTapResult.ignored }
            if kind == MediaShortcutItemID.flipCamera {
                flipRequestCount += 1
                return submit(CallControlsRequest.make(CallControlsRequestKind.flipCamera))
            }
            if kind == MediaShortcutItemID.effects {
                panelRequestCount += 1
                shell.panels.present(MeetingPanel.effects, from: PanelInvoker.call)
                return ControlTapResult.dispatched
            }
            systemEffectsRequestCount += 1
            return submit(CallControlsRequest.make(CallControlsRequestKind.showSystemVideoEffects))
        case .speaker:
            return setSpeaker(!routeOwner.route.isSpeakerOn)
        case .chooseMicrophone:
            stage.noteControlAction()
            if routeOwner.route.inputs.isEmpty || inputs.phase == MeetingPhaseKind.leaving { return ControlTapResult.ignored }
            inputPickerCount += 1
            return ControlTapResult.dispatched
        case .microphone, .audioSettings:

            return openAudioSettings()
        case .micMode:
            stage.noteControlAction()
            if !routeOwner.route.canShowMicModes || inputs.phase == MeetingPhaseKind.leaving { return ControlTapResult.ignored }
            micModesRequestCount += 1
            return submit(CallControlsRequest.make(CallControlsRequestKind.showSystemMicrophoneModes))
        }
    }

    @discardableResult
    func sendReaction(id: String) -> ControlTapResult {
        stage.noteControlAction()
        guard reactions.isAvailable, ReactionPalettePolicy.offers(reactions, id: id), ReactionPalettePolicy.option(id: id) != nil else {
            return ControlTapResult.ignored
        }
        let sent = submit(CallControlsRequest.make(CallControlsRequestKind.sendReaction, value: id))
        if sent == ControlTapResult.dispatched { reactionCount += 1 }
        return sent
    }

    var handState: LocalHandState {
        guard let row = inputs.row(MeetingControlID.hand) else { return LocalHandState.lowered }
        let intent = handIntent == MeetingActionDirection.none ? "" : handIntent.rawValue
        return MoreMenuPolicy.handState(isOn: row.isOn, isPending: row.isPending, intent: intent)
    }

    private func toggleHand(_ isOn: Bool) -> ControlTapResult {
        if inputs.row(MeetingControlID.hand)?.isPending ?? false {

            return result(shell.toggleHand(), kind: CallControlKind.hand)
        }
        let previous = handIntent
        handIntent = isOn ? MeetingActionDirection.lower : MeetingActionDirection.raise
        let dispatch = shell.toggleHand()
        if dispatch != MeetingDispatch.dispatched {
            handIntent = previous
            recompute()
        }
        return result(dispatch, kind: CallControlKind.hand)
    }

    func dismissPermissionPrompt(id: Int) {
        guard let prompt = permissionPrompt, prompt.id == id else { return }
        permissionPrompt = nil
    }

    func reset() {
        inputs = CallControlsInputs.make()
        clearOneShots()
        clearEndTracking()
        overflowIds = []
        fitReadout = "none"
        menuHeightReadout = "none"
        handIntent = MeetingActionDirection.none
        recap = RecapControlsState.none
        recompute()
    }

    private func absorb(_ next: CallControlsInputs) {
        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            clearOneShots()
            clearEndTracking()
        }
        inputs = next
        recompute()
    }

    private func refreshFromShell() {
        absorb(inputs.refreshed(from: shell))
    }

    private func recompute() {
        var candidate = ControlBarPolicy.bar(inputs: inputs, layout: layout, revision: bar.revision)

        if ControlBarPolicy.chatMovedWithUnread(inputs: inputs, overflowIds: overflowIds) {
            candidate = ControlBarPolicy.withMoreDot(candidate)
        }
        if candidate != bar {
            bar = candidate.withRevision(bar.revision + 1)
            barPublishCount += 1
        }

        let leaveCandidate = RecapPolicy.leaveSnapshot(ControlBarPolicy.leaveSnapshot(inputs: inputs, revision: leaveState.revision),
                                                       recap: recap)
        if leaveCandidate != leaveState {
            let wasPosting = leaveState.endPhase == EndPhase.postingRecap
            leaveState = leaveCandidate.withRevision(leaveState.revision + 1)
            if leaveState.endPhase == EndPhase.postingRecap && !wasPosting {

                feedbackState = MeetingShellFeedbackState(session: inputs.callSession,
                                                          token: FeedbackToken(sequence: feedbackState.token.sequence + 1,
                                                                               kind: FeedbackKind.recapPostingStarted))
            }

            stage.setTransientChrome(id: ChromeAutoHidePolicy.endDialog, open: leaveState.confirmationId != 0)
        }

        let reactionsCandidate = ReactionPalettePolicy.snapshot(inputs: inputs, artShipped: ReactionPalettePolicy.artShipped,
                                                                revision: reactions.revision)
        if reactionsCandidate != reactions {
            reactions = reactionsCandidate.withRevision(reactions.revision + 1)
        }
        let composition = layout.composition
        if !(inputs.row(MeetingControlID.hand)?.isPending ?? false) {
            handIntent = MeetingActionDirection.none
        }
        let moreCandidate = MoreMenuPolicy.snapshot(inputs: inputs, composition: composition, overflowIds: overflowIds,
                                                    reactions: reactions, revision: more.revision, handIntent: handIntent)
        if moreCandidate != more {
            more = moreCandidate.withRevision(more.revision + 1)
        }
        let metricsCandidate = MoreMenuPolicy.metrics(more)
        if metricsCandidate != moreMetrics {
            moreMetrics = metricsCandidate
        }
        let commandsCandidate = MoreMenuPolicy.commands(inputs: inputs, composition: composition,
                                                        lock: more.item(MoreItemID.lockMeeting), revision: commands.revision)
        if commandsCandidate != commands {
            commands = commandsCandidate.withRevision(commands.revision + 1)
        }

        let shortcutsCandidate = MediaShortcutSnapshot(revision: shortcuts.revision, camera: MediaShortcutPolicy.cameraItems(inputs: inputs))
        if shortcutsCandidate != shortcuts {
            shortcuts = shortcutsCandidate.withRevision(shortcuts.revision + 1)
        }
        followEndResult()
    }

    private func submit(_ next: CallControlsRequest) -> ControlTapResult {
        guard let handler = onRequest else { return ControlTapResult.ignored }
        return handler(next) ? ControlTapResult.dispatched : ControlTapResult.ignored
    }

    private func followEndResult() {
        if !endResultOwed || isConfirmingEnd { return }
        switch leaveState.endPhase {
        case .ending:
            if endingNoticeId.isEmpty {
                nextEndingNoticeSerial += 1
                endingNoticeId = LeaveControlPolicy.endingNoticePrefix + String(nextEndingNoticeSerial)
                endingNoticeCount += 1
                stage.postLocal(LeaveControlPolicy.endingNotice(id: endingNoticeId))
            }
        case .failed:
            endResultOwed = false

            endingNoticeId = ""
            endFailedNoticeCount += 1
            stage.postLocal(LeaveControlPolicy.endFailedNotice())
        case .idle, .confirming, .postingRecap:
            endResultOwed = false
            clearEndingNotice()
        }
    }

    private func clearEndTracking() {
        endResultOwed = false
        clearEndingNotice()
    }

    private func clearEndingNotice() {
        if endingNoticeId.isEmpty { return }
        let id = endingNoticeId
        endingNoticeId = ""
        stage.clearLocalNotice(id: id)
    }

    private func clearOneShots() {
        if explanation != nil { explanation = nil }
        if permissionPrompt != nil { permissionPrompt = nil }
    }

    private func result(_ dispatch: MeetingDispatch, kind: CallControlKind) -> ControlTapResult {
        switch dispatch {
        case .dispatched:
            return ControlTapResult.dispatched
        case .duplicate:
            return ControlTapResult.ignored
        case .unavailable:
            guard let fresh = ControlBarPolicy.control(kind, inputs: inputs, composition: layout.composition) else {
                return ControlTapResult.ignored
            }
            return explainBlocked(fresh)
        }
    }

    private func explainBlocked(_ model: CallControlModel) -> ControlTapResult {
        switch model.reason {
        case .permissionDenied:
            nextPromptId += 1
            promptCount += 1
            let kind = model.kind == CallControlKind.camera ? ControlPermissionKind.camera : ControlPermissionKind.microphone
            permissionPrompt = ControlPermissionPrompt(id: nextPromptId, kind: kind)
            return ControlTapResult.explained
        case .permissionUndetermined:
            commandCount += 1
            onCommand?(model.kind == CallControlKind.camera ? CallControlsCommand.requestCameraPermission
                                                            : CallControlsCommand.requestMicrophonePermission)
            return ControlTapResult.explained
        default:
            guard ControlBarPolicy.explains(model.reason) else { return ControlTapResult.ignored }
            nextExplanationId += 1
            explainCount += 1
            let next = ControlExplanation(id: nextExplanationId, kind: model.kind, reason: model.reason, reasonName: model.reasonName,
                                          actionId: ControlBarPolicy.explanationActionId(model.reason))
            explanation = next

            stage.postLocal(ControlBarPolicy.explanationNotice(next))
            onExplain?(next)
            return ControlTapResult.explained
        }
    }
}
