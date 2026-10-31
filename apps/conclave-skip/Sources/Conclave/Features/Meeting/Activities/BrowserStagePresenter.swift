import Foundation
import Observation

enum BrowserLoadState: String, CaseIterable, Equatable {
    case starting, loading, live, failed, reconnecting
}

enum BrowserLoadIssue: String, CaseIterable, Equatable {
    case none, pageFailed, sslFailed, rendererGone, videoTimedOut
}

enum BrowserSurfaceKind: String, CaseIterable, Equatable {

    case none

    case video

    case liveView
}

enum BrowserWebViewRole: String, CaseIterable, Equatable {
    case none, input, liveView
}

enum BrowserStageCommandKind: String, CaseIterable, Equatable {
    case navigate, toggleAudio, close, refresh
}

struct BrowserStageCommand: Equatable {
    let kind: BrowserStageCommandKind
    let text: String

    static func make(_ kind: BrowserStageCommandKind, text: String = "") -> BrowserStageCommand {
        return BrowserStageCommand(kind: kind, text: text)
    }
}

struct BrowserStageInputs: Equatable {
    let callSession: Int
    let isActive: Bool

    let isHost: Bool
    let isAttendee: Bool

    let url: String

    let inputBaseURL: String
    let controllerName: String
    let isYouController: Bool

    let provider: String
    let hasAudio: Bool
    let isAudioMuted: Bool

    let isNavigating: Bool

    let videoUserId: String

    let videoTrackKey: String

    let isReconnecting: Bool

    static func make(callSession: Int = 0, isActive: Bool = false, isHost: Bool = false, isAttendee: Bool = false, url: String = "",
                     inputBaseURL: String = "", controllerName: String = "", isYouController: Bool = false, provider: String = "",
                     hasAudio: Bool = false, isAudioMuted: Bool = false, isNavigating: Bool = false, videoUserId: String = "",
                     videoTrackKey: String = "", isReconnecting: Bool = false) -> BrowserStageInputs {
        return BrowserStageInputs(callSession: callSession, isActive: isActive, isHost: isHost, isAttendee: isAttendee, url: url,
                                  inputBaseURL: inputBaseURL, controllerName: controllerName, isYouController: isYouController,
                                  provider: provider, hasAudio: hasAudio, isAudioMuted: isAudioMuted, isNavigating: isNavigating,
                                  videoUserId: videoUserId, videoTrackKey: videoTrackKey, isReconnecting: isReconnecting)
    }
}

struct BrowserStageModel: Equatable {
    let revision: Int
    let isActive: Bool

    let browserSessionId: String
    let hostLabel: String

    let pageURL: String
    let provider: String
    let sharedByName: String
    let isYouSharing: Bool
    let load: BrowserLoadState

    let failure: BrowserFailure
    let issue: BrowserLoadIssue
    let surface: BrowserSurfaceKind
    let webViewRole: BrowserWebViewRole

    let inputInteractive: Bool

    let canControl: Bool

    let canNavigate: Bool
    let showsAddressRow: Bool

    let navigatePending: Bool
    let validation: BrowserValidation

    let commandFailure: BrowserFailure
    let hasAudio: Bool

    let showsAudioControl: Bool
    let isAudioMuted: Bool
    let canClose: Bool
    let closePending: Bool
    let videoUserId: String
    let videoTrackKey: String

    let framebufferWidth: Int
    let framebufferHeight: Int

    let hasSurface: Bool

    let inputURL: String
    let isKitesurf: Bool

    let reloadSerial: Int

    let keyboardSerial: Int

    let wantsWebView: Bool

    let usesFixturePage: Bool

    static let empty = BrowserStageModel(
        revision: 0, isActive: false, browserSessionId: "", hostLabel: "", pageURL: "", provider: "", sharedByName: "",
        isYouSharing: false, load: BrowserLoadState.starting, failure: BrowserFailure.none, issue: BrowserLoadIssue.none,
        surface: BrowserSurfaceKind.none, webViewRole: BrowserWebViewRole.none, inputInteractive: false, canControl: false,
        canNavigate: false, showsAddressRow: false, navigatePending: false, validation: BrowserValidation.none,
        commandFailure: BrowserFailure.none, hasAudio: false, showsAudioControl: false, isAudioMuted: false, canClose: false,
        closePending: false, videoUserId: "", videoTrackKey: "", framebufferWidth: 0, framebufferHeight: 0, hasSurface: false,
        inputURL: "", isKitesurf: false, reloadSerial: 0, keyboardSerial: 0, wantsWebView: false, usesFixturePage: false)
}

@MainActor
@Observable
final class BrowserStagePresenter {
    private(set) var model: BrowserStageModel = BrowserStageModel.empty

    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    @ObservationIgnored var onCommand: ((BrowserStageCommand) -> Void)? = nil

    @ObservationIgnored var onSessionEnded: ((String) -> Void)? = nil
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    @ObservationIgnored var showsDebugReadouts = false

    @ObservationIgnored private(set) var inputs = BrowserStageInputs.make()

    @ObservationIgnored private(set) var commandLog: [String] = []

    @ObservationIgnored private var sessionSerial = 0
    @ObservationIgnored private var browserSessionId = ""
    @ObservationIgnored private var issue = BrowserLoadIssue.none
    @ObservationIgnored private var videoFrameSeen = false
    @ObservationIgnored private var pageLoaded = false
    @ObservationIgnored private var pageLoading = false
    @ObservationIgnored private var framebufferWidth = 0
    @ObservationIgnored private var framebufferHeight = 0
    @ObservationIgnored private var navigatePending = false
    @ObservationIgnored private var validation = BrowserValidation.none
    @ObservationIgnored private var commandFailure = BrowserFailure.none
    @ObservationIgnored private var closePending = false
    @ObservationIgnored private var reloadSerial = 0
    @ObservationIgnored private var keyboardSerial = 0
    @ObservationIgnored private var usesFixturePage = false
    @ObservationIgnored private var firstFrameTask: Task<Void, Never>? = nil
    @ObservationIgnored private var firstFrameKey = ""
    @ObservationIgnored private var safetyTask: Task<Void, Never>? = nil

    static let videoSlotId = "browser"

    static let hostActionSafetyMillis = Double(SharedBrowserTimeouts.commandAckMillis + 5000)

    init() {}

    func apply(_ next: BrowserStageInputs) {
        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            endSession()
            resetLocal()
        }
        if next == inputs && (next.isActive == !browserSessionId.isEmpty) { return }
        let previous = inputs
        inputs = next
        if next.isActive && browserSessionId.isEmpty {
            beginSession()
        } else if !next.isActive && !browserSessionId.isEmpty {
            endSession()
        }
        if next.inputBaseURL != previous.inputBaseURL || next.isYouController != previous.isYouController {

            pageLoaded = false
            pageLoading = false
        }
        if navigatePending && previous.isNavigating && !next.isNavigating {
            navigatePending = false
            cancelSafetyIfIdle()
        }
        if closePending && !next.isActive {
            closePending = false
            cancelSafetyIfIdle()
        }
        if !next.isYouController && previous.isYouController {
            validation = BrowserValidation.none
            commandFailure = BrowserFailure.none
        }
        rebuild()
    }

    func navigateFailed() {
        if !navigatePending { return }
        navigatePending = false
        commandFailure = BrowserFailure.navigateFailed
        cancelSafetyIfIdle()
        publishFeedback(FeedbackKind.hostActionFailed)
        rebuild()
    }

    func commandRejected(_ kind: BrowserStageCommandKind) {
        if kind == BrowserStageCommandKind.navigate && navigatePending {
            navigatePending = false
        } else if kind == BrowserStageCommandKind.close && closePending {
            closePending = false
        } else {
            return
        }
        cancelSafetyIfIdle()
        rebuild()
    }

    func closeFailed() {
        if !closePending { return }
        closePending = false
        cancelSafetyIfIdle()
        publishFeedback(FeedbackKind.hostActionFailed)
        rebuild()
    }

    func webViewLoadStarted(browserSessionId id: String, reloadSerial serial: Int) {
        if !isCurrent(id, serial) { return }
        if pageLoading { return }
        pageLoading = true
        rebuild()
    }

    func webViewLoadFinished(browserSessionId id: String, reloadSerial serial: Int) {
        if !isCurrent(id, serial) { return }
        if !pageLoading && pageLoaded { return }
        pageLoading = false
        pageLoaded = true
        rebuild()
    }

    func webViewFailed(browserSessionId id: String, reloadSerial serial: Int, issue next: BrowserLoadIssue) {
        if !isCurrent(id, serial) || next == BrowserLoadIssue.none { return }
        if self.issue != BrowserLoadIssue.none { return }
        pageLoading = false
        self.issue = next
        cancelFirstFrameTimer()
        rebuild()
    }

    func videoFrameArrived(width: Int, height: Int) {
        if browserSessionId.isEmpty || width <= 0 || height <= 0 { return }
        if videoFrameSeen && framebufferWidth == width && framebufferHeight == height { return }
        videoFrameSeen = true
        framebufferWidth = width
        framebufferHeight = height
        rebuild()
    }

    @discardableResult
    func navigate(_ text: String) -> ActivityTapResult {
        if !model.showsAddressRow { return ActivityTapResult.explained }
        if navigatePending || inputs.isNavigating { return ActivityTapResult.ignored }
        let result = BrowserURLValidationPolicy.validate(text)
        validation = result
        commandFailure = BrowserFailure.none
        if result != BrowserValidation.none {
            rebuild()
            return ActivityTapResult.explained
        }
        navigatePending = true
        startSafety()
        rebuild()
        send(BrowserStageCommand.make(BrowserStageCommandKind.navigate, text: text.trimmingCharacters(in: .whitespacesAndNewlines)))
        return ActivityTapResult.dispatched
    }

    func clearValidation() {
        if validation == BrowserValidation.none && commandFailure == BrowserFailure.none { return }
        validation = BrowserValidation.none
        commandFailure = BrowserFailure.none
        rebuild()
    }

    @discardableResult
    func toggleAudio() -> ActivityTapResult {
        if !model.showsAudioControl { return ActivityTapResult.explained }
        send(BrowserStageCommand.make(BrowserStageCommandKind.toggleAudio))
        return ActivityTapResult.dispatched
    }

    @discardableResult
    func confirmClose() -> ActivityTapResult {
        if !model.canClose { return ActivityTapResult.explained }
        if closePending { return ActivityTapResult.ignored }
        closePending = true
        startSafety()
        rebuild()
        send(BrowserStageCommand.make(BrowserStageCommandKind.close))
        return ActivityTapResult.dispatched
    }

    @discardableResult
    func retryLoad() -> ActivityTapResult {
        if issue == BrowserLoadIssue.none { return ActivityTapResult.ignored }
        issue = BrowserLoadIssue.none
        pageLoaded = false
        pageLoading = false
        reloadSerial += 1
        cancelFirstFrameTimer()
        rebuild()
        send(BrowserStageCommand.make(BrowserStageCommandKind.refresh))
        return ActivityTapResult.dispatched
    }

    @discardableResult
    func focusKeyboard() -> ActivityTapResult {
        if !model.inputInteractive || model.webViewRole == BrowserWebViewRole.none || !model.hasSurface {
            return ActivityTapResult.explained
        }
        keyboardSerial += 1
        rebuild()
        return ActivityTapResult.dispatched
    }

    func useFixturePage(_ on: Bool) {
        if usesFixturePage == on { return }
        usesFixturePage = on
        rebuild()
    }

    func reset() {
        endSession()
        resetLocal()
        inputs = BrowserStageInputs.make()
        rebuild()
    }

    var hasFirstFrameTimer: Bool {
        return firstFrameTask != nil
    }

    static func surface(isActive: Bool, videoUserId: String, inputBaseURL: String, usesFixturePage: Bool) -> BrowserSurfaceKind {
        if !isActive { return BrowserSurfaceKind.none }
        if usesFixturePage { return BrowserSurfaceKind.liveView }
        if !videoUserId.isEmpty { return BrowserSurfaceKind.video }
        if !inputBaseURL.isEmpty { return BrowserSurfaceKind.liveView }
        return BrowserSurfaceKind.none
    }

    static func webViewRole(surface: BrowserSurfaceKind, canControl: Bool) -> BrowserWebViewRole {
        switch surface {
        case .none: return BrowserWebViewRole.none
        case .video: return canControl ? BrowserWebViewRole.input : BrowserWebViewRole.none
        case .liveView: return BrowserWebViewRole.liveView
        }
    }

    static func load(issue: BrowserLoadIssue, isReconnecting: Bool, hasSurface: Bool, isPageLoading: Bool) -> BrowserLoadState {
        if issue != BrowserLoadIssue.none { return BrowserLoadState.failed }
        if isReconnecting { return BrowserLoadState.reconnecting }
        if !hasSurface { return BrowserLoadState.starting }
        if isPageLoading { return BrowserLoadState.loading }
        return BrowserLoadState.live
    }

    static func failure(_ issue: BrowserLoadIssue) -> BrowserFailure {
        switch issue {
        case .none: return BrowserFailure.none
        case .videoTimedOut: return BrowserFailure.timedOut
        case .pageFailed, .sslFailed, .rendererGone: return BrowserFailure.loadFailed
        }
    }

    static func aspectRatio(width: Int, height: Int) -> Double {
        if width <= 0 || height <= 0 { return 16.0 / 9.0 }
        return Double(width) / Double(height)
    }

    private func isCurrent(_ id: String, _ serial: Int) -> Bool {
        return !browserSessionId.isEmpty && id == browserSessionId && serial == reloadSerial
    }

    private func beginSession() {
        sessionSerial += 1
        browserSessionId = "browser-" + String(inputs.callSession) + "-" + String(sessionSerial)
        issue = BrowserLoadIssue.none
        videoFrameSeen = false
        pageLoaded = false
        pageLoading = false
        framebufferWidth = 0
        framebufferHeight = 0
        validation = BrowserValidation.none
        commandFailure = BrowserFailure.none
        keyboardSerial = 0
        cancelFirstFrameTimer()
    }

    private func endSession() {
        let ended = browserSessionId
        browserSessionId = ""
        cancelFirstFrameTimer()
        issue = BrowserLoadIssue.none
        videoFrameSeen = false
        pageLoaded = false
        pageLoading = false
        framebufferWidth = 0
        framebufferHeight = 0
        if !ended.isEmpty { onSessionEnded?(ended) }
    }

    private func resetLocal() {
        cancelFirstFrameTimer()
        safetyTask?.cancel()
        safetyTask = nil
        navigatePending = false
        closePending = false
        validation = BrowserValidation.none
        commandFailure = BrowserFailure.none
        commandLog = []
    }

    private func send(_ command: BrowserStageCommand) {
        commandLog.append(command.kind.rawValue)
        if commandLog.count > 40 { commandLog.removeFirst() }
        onCommand?(command)
    }

    private func startSafety() {
        safetyTask?.cancel()
        safetyTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.sleep(BrowserStagePresenter.hostActionSafetyMillis)
            if Task.isCancelled { return }
            self.safetyTask = nil
            if self.navigatePending || self.closePending {
                self.navigatePending = false
                self.closePending = false
                self.rebuild()
            }
        }
    }

    private func cancelSafetyIfIdle() {
        if navigatePending || closePending { return }
        safetyTask?.cancel()
        safetyTask = nil
    }

    private func armFirstFrameTimerIfNeeded() {
        let wanted = model.isActive && !model.hasSurface && issue == BrowserLoadIssue.none && !usesFixturePage
        if !wanted {
            cancelFirstFrameTimer()
            return
        }
        let key = browserSessionId + "#" + String(reloadSerial)
        if firstFrameTask != nil && firstFrameKey == key { return }
        firstFrameTask?.cancel()
        firstFrameKey = key
        let expectedSession = browserSessionId
        let expectedReload = reloadSerial
        firstFrameTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.sleep(Double(SharedBrowserTimeouts.firstFrameMillis))
            if Task.isCancelled { return }
            self.fireFirstFrameTimeout(browserSessionId: expectedSession, reloadSerial: expectedReload)
        }
    }

    func fireFirstFrameTimeout(browserSessionId id: String, reloadSerial serial: Int) {
        if !isCurrent(id, serial) { return }
        firstFrameTask = nil
        firstFrameKey = ""
        if model.hasSurface || issue != BrowserLoadIssue.none || usesFixturePage { return }
        if inputs.isReconnecting {
            rebuild()
            return
        }
        issue = BrowserLoadIssue.videoTimedOut
        rebuild()
    }

    private func cancelFirstFrameTimer() {
        firstFrameTask?.cancel()
        firstFrameTask = nil
        firstFrameKey = ""
    }

    private func rebuild() {
        let candidate = makeModel(revision: model.revision)
        if candidate != model {
            model = makeModel(revision: model.revision + 1)
        }
        armFirstFrameTimerIfNeeded()
    }

    private func makeModel(revision: Int) -> BrowserStageModel {
        let active = inputs.isActive && !inputs.isAttendee && !browserSessionId.isEmpty
        let canControl = active && inputs.isYouController
        let canNavigate = active && inputs.isHost
        let surface = BrowserStagePresenter.surface(isActive: active, videoUserId: inputs.videoUserId,
                                                    inputBaseURL: inputs.inputBaseURL, usesFixturePage: usesFixturePage)
        let role = BrowserStagePresenter.webViewRole(surface: surface, canControl: canControl)
        let hasSurface = surface == BrowserSurfaceKind.video ? videoFrameSeen
            : (surface == BrowserSurfaceKind.liveView ? pageLoaded : false)
        let loadState = active
            ? BrowserStagePresenter.load(issue: issue, isReconnecting: inputs.isReconnecting, hasSurface: hasSurface,
                                         isPageLoading: pageLoading && role != BrowserWebViewRole.none && canControl)
            : BrowserLoadState.starting
        var inputURL = ""
        if active && !usesFixturePage {
            if role == BrowserWebViewRole.input {
                inputURL = BrowserInputURLPolicy.inputURL(inputs.inputBaseURL)
            } else if role == BrowserWebViewRole.liveView {
                inputURL = inputs.inputBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        let wantsWebView = active && issue == BrowserLoadIssue.none && role != BrowserWebViewRole.none
            && (usesFixturePage || !inputURL.isEmpty)
        let kitesurf = BrowserProviderPolicy.isKitesurf(inputs.provider)
        return BrowserStageModel(
            revision: revision,
            isActive: active,
            browserSessionId: active ? browserSessionId : "",
            hostLabel: active ? BrowserHostLabelPolicy.hostLabel(inputs.url) : "",
            pageURL: active ? inputs.url : "",
            provider: inputs.provider,
            sharedByName: active ? inputs.controllerName : "",
            isYouSharing: canControl,
            load: loadState,
            failure: active ? BrowserStagePresenter.failure(issue) : BrowserFailure.none,
            issue: active ? issue : BrowserLoadIssue.none,
            surface: surface,
            webViewRole: role,
            inputInteractive: canControl && !inputs.isReconnecting && issue == BrowserLoadIssue.none,
            canControl: canControl,
            canNavigate: canNavigate,
            showsAddressRow: canControl && canNavigate,
            navigatePending: active && (navigatePending || inputs.isNavigating),
            validation: canControl ? validation : BrowserValidation.none,
            commandFailure: canControl ? commandFailure : BrowserFailure.none,
            hasAudio: active && inputs.hasAudio,
            showsAudioControl: active && inputs.hasAudio && !kitesurf,
            isAudioMuted: inputs.isAudioMuted,
            canClose: canNavigate,
            closePending: active && closePending,
            videoUserId: surface == BrowserSurfaceKind.video ? inputs.videoUserId : "",
            videoTrackKey: surface == BrowserSurfaceKind.video ? inputs.videoTrackKey : "",
            framebufferWidth: surface == BrowserSurfaceKind.video ? framebufferWidth : 0,
            framebufferHeight: surface == BrowserSurfaceKind.video ? framebufferHeight : 0,
            hasSurface: hasSurface,
            inputURL: inputURL,
            isKitesurf: kitesurf,
            reloadSerial: reloadSerial,
            keyboardSerial: keyboardSerial,
            wantsWebView: wantsWebView,
            usesFixturePage: usesFixturePage
        )
    }

    private func publishFeedback(_ kind: FeedbackKind) {
        feedbackState = MeetingShellFeedbackState(session: inputs.callSession,
                                                  token: FeedbackToken(sequence: feedbackState.token.sequence + 1, kind: kind))
    }
}

enum BrowserLoadIssuePolicy {
    static let urlErrorDomain = "NSURLErrorDomain"
    static let webKitErrorDomain = "WebKitErrorDomain"

    static let urlErrorCancelled = -999

    static let urlErrorTLSFirst = -1206
    static let urlErrorTLSLast = -1200

    static let webKitFrameLoadInterrupted = 102
    static let webKitPlugInWillHandleLoad = 204

    static let androidFailedSSLHandshake = -11

    static func errorIssue(domain errorDomain: String, code: Int) -> BrowserLoadIssue {
        if errorDomain == urlErrorDomain {
            if code == urlErrorCancelled { return BrowserLoadIssue.none }
            if code >= urlErrorTLSFirst && code <= urlErrorTLSLast { return BrowserLoadIssue.sslFailed }
            return BrowserLoadIssue.pageFailed
        }
        if errorDomain == webKitErrorDomain && (code == webKitFrameLoadInterrupted || code == webKitPlugInWillHandleLoad) {
            return BrowserLoadIssue.none
        }
        return BrowserLoadIssue.pageFailed
    }

    static func androidErrorIssue(_ code: Int) -> BrowserLoadIssue {
        return code == androidFailedSSLHandshake ? BrowserLoadIssue.sslFailed : BrowserLoadIssue.pageFailed
    }

    static func httpIssue(_ status: Int) -> BrowserLoadIssue {
        return status >= 400 ? BrowserLoadIssue.pageFailed : BrowserLoadIssue.none
    }
}

enum BrowserNavigationPolicy {
    static let allowedSchemes: [String] = ["https", "http", "about"]

    static func allows(scheme: String) -> Bool {
        return allowedSchemes.contains(scheme.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }
}

enum BrowserInputScripts {
    static let styleElementId = "conclave-input-layer"

    static let hiddenCanvasCSS = "canvas { opacity: 0 !important; } "
        + "html, body, #noVNC_container, #noVNC_screen { background: transparent !important; } "
        + "#noVNC_control_bar_anchor, #noVNC_status, #noVNC_transition { display: none !important; }"

    static let installHiddenCanvas = "(function () {"
        + " if (document.getElementById('" + styleElementId + "')) { return; }"
        + " var style = document.createElement('style');"
        + " style.id = '" + styleElementId + "';"
        + " style.textContent = '" + hiddenCanvasCSS + "';"
        + " (document.head || document.documentElement).appendChild(style);"
        + " })();"

    static let focusKeyboard = "(function () {"
        + " var input = document.getElementById('noVNC_keyboardinput');"
        + " if (input) { input.focus(); return 'keyboard'; }"
        + " var canvas = document.querySelector('canvas');"
        + " if (canvas) { canvas.focus(); return 'canvas'; }"
        + " return 'none';"
        + " })();"
}

enum BrowserStageFixtureState: String, CaseIterable, Equatable {
    case controller = "browser-controller"
    case viewer = "browser-viewer"
    case starting = "browser-starting"
    case failed = "browser-failed"
    case rendererGone = "browser-renderer-gone"
    case reconnecting = "browser-reconnecting"
    case kitesurf = "browser-kitesurf"
}

@MainActor
final class BrowserFixtureOwner {
    private(set) var commands: [String] = []

    func record(_ command: BrowserStageCommand) {
        commands.append(command.text.isEmpty ? command.kind.rawValue : command.kind.rawValue + " " + command.text)
    }

    func readout() -> String {
        if commands.isEmpty { return "none" }
        return String(commands.count) + " last=" + (commands.last ?? "")
    }
}

enum BrowserFixturePage {
    static let html = "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        + "<style>:root { color-scheme: dark; } html, body { margin: 0; height: 100%; background: Canvas; color: CanvasText;"
        + " font-family: system-ui, sans-serif; } main { display: flex; height: 100%; align-items: center;"
        + " justify-content: center; text-align: center; }</style></head><body><main><p>example.com</p></main></body></html>"
}

enum BrowserStageFixtures {
    static func state(named raw: String) -> BrowserStageFixtureState? {
        return BrowserStageFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func isFixture(_ raw: String) -> Bool {
        return state(named: raw) != nil
    }

    static func stageInputs(named raw: String, base: StageInputs) -> StageInputs {
        let recovering = state(named: raw) == BrowserStageFixtureState.reconnecting
        return StageInputs.make(
            callSession: base.callSession, isInCall: base.isInCall, localUserId: base.localUserId, roomLabel: base.roomLabel,
            meetingLink: base.meetingLink, participants: base.participants, viewMode: base.viewMode, viewMaxTiles: base.viewMaxTiles,
            hideTilesWithoutVideo: base.hideTilesWithoutVideo, selfViewMode: base.selfViewMode, selfViewCorner: base.selfViewCorner,
            pinnedUserId: base.pinnedUserId, activeAppId: "", activeAppName: "", isBrowserActive: true, isGameActive: false,
            gameName: "", screenShareUserId: base.screenShareUserId, isLocalScreenSharing: base.isLocalScreenSharing,
            isWebinarAttendee: false, webinarSpeakerUserId: "", isRoomLocked: base.isRoomLocked, captionsOn: base.captionsOn,
            liveNotes: base.liveNotes, isAloneConfirmed: base.isAloneConfirmed, canFlipCamera: base.canFlipCamera,
            isFrontCamera: base.isFrontCamera, isFlipInFlight: base.isFlipInFlight, isCameraPaused: base.isCameraPaused,
            routeKind: base.routeKind, routeName: base.routeName, isHandRaised: base.isHandRaised,
            handToggleInFlight: base.handToggleInFlight, isRecovering: recovering, isMediaPending: base.isMediaPending,
            joinedAtMillis: base.joinedAtMillis, alwaysShowControls: base.alwaysShowControls, isEffectsOpen: base.isEffectsOpen)
    }

    static func inputs(_ state: BrowserStageFixtureState) -> BrowserStageInputs {
        let controller = state == BrowserStageFixtureState.controller || state == BrowserStageFixtureState.failed
            || state == BrowserStageFixtureState.rendererGone || state == BrowserStageFixtureState.starting
            || state == BrowserStageFixtureState.kitesurf
        return BrowserStageInputs.make(
            callSession: 1, isActive: true, isHost: controller, url: "https://example.com/docs",
            inputBaseURL: state == BrowserStageFixtureState.starting ? "" : "https://browser.fixture.invalid/vnc.html?path=websockify",
            controllerName: controller ? "You" : "Avery", isYouController: controller,
            provider: state == BrowserStageFixtureState.kitesurf ? BrowserProviderPolicy.kitesurf : BrowserProviderPolicy.chromium,
            hasAudio: state != BrowserStageFixtureState.kitesurf, isAudioMuted: false, isNavigating: false,
            videoUserId: "", videoTrackKey: "", isReconnecting: state == BrowserStageFixtureState.reconnecting)
    }

    @MainActor
    static func apply(named raw: String, presenter: BrowserStagePresenter, owner: BrowserFixtureOwner) {
        guard let state = state(named: raw) else { return }
        presenter.onCommand = { [weak owner] command in owner?.record(command) }
        presenter.showsDebugReadouts = true
        presenter.useFixturePage(state != BrowserStageFixtureState.starting)
        presenter.apply(inputs(state))
        let id = presenter.model.browserSessionId
        let serial = presenter.model.reloadSerial
        switch state {
        case .controller, .viewer, .reconnecting, .kitesurf:
            presenter.webViewLoadFinished(browserSessionId: id, reloadSerial: serial)
        case .starting:
            break
        case .failed:
            presenter.webViewFailed(browserSessionId: id, reloadSerial: serial, issue: BrowserLoadIssue.sslFailed)
        case .rendererGone:
            presenter.webViewFailed(browserSessionId: id, reloadSerial: serial, issue: BrowserLoadIssue.rendererGone)
        }
    }
}
