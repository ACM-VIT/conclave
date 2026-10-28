import Foundation
import Observation

// S60 14 and 0.5 (ACT-9): the session-owned shared browser presenter behind the browser card on the stage (S20 owns
// the card; `ActivitySession.browser` holds it, HD request B8-T1 R1). Controller and viewer modes over ONE load-state
// contract (`BrowserLoadState`): viewers render only the WebRTC track of the remote browser (the
// `shared-browser-video:` producer, a screen-type consumer); the controller adds a scoped noVNC input layer, a
// transparent web view over the same aspect-locked box; without a video track (Kitesurf, or a Chromium service with
// video off) the noVNC or Live View page is the visible surface, interactive only for the controller. Every failure
// (page load, TLS, renderer process, 20 s without a first frame) shows the same failure state; the call continues.
//
// The card body observes only `model` (S60 14 k). Pushed inputs from the core (`BrowserStageInputs`), equality-guarded
// publishing, no self-observation; client-local commands go back through `onCommand` (navigate, audio, close, refresh)
// and the platform web view reports its load events with the session id and reload serial they were started for.
// App-owned copy never travels as text: typed enums and raw values only, mapped by `BrowserCopy` on each platform
// (`BrowserSurface+iOS.swift`, `K/ui/browser/BrowserCopy.kt`).

enum BrowserLoadState: String, CaseIterable, Equatable {
    case starting, loading, live, failed, reconnecting
}

/// Why the surface failed (tests and readouts); every case shows the one failure copy (S60 14 f).
enum BrowserLoadIssue: String, CaseIterable, Equatable {
    case none, pageFailed, sslFailed, rendererGone, videoTimedOut
}

/// What the card body draws.
enum BrowserSurfaceKind: String, CaseIterable, Equatable {
    /// No video producer and no page URL yet (starting).
    case none
    /// The WebRTC track of the remote browser, in an aspect-locked box (Chromium with video).
    case video
    /// The noVNC or Live View page is the visible surface (Kitesurf, a Chromium service without video, fixtures).
    case liveView
}

/// The platform web view this person holds for the session (L6-15): none (viewers of a video surface), the hidden
/// input layer (the controller over video) or the visible page (everyone on a `liveView` surface).
enum BrowserWebViewRole: String, CaseIterable, Equatable {
    case none, input, liveView
}

enum BrowserStageCommandKind: String, CaseIterable, Equatable {
    case navigate, toggleAudio, close, refresh
}

/// What the core performs (the S1 `onCommand` pattern); `text` is the URL for `navigate`.
struct BrowserStageCommand: Equatable {
    let kind: BrowserStageCommandKind
    let text: String

    static func make(_ kind: BrowserStageCommandKind, text: String = "") -> BrowserStageCommand {
        return BrowserStageCommand(kind: kind, text: text)
    }
}

/// The schema boundary between the core and the presenter (S60 14 j inputs), built by the view model's
/// `makeBrowserStageInputs()` from MeetingState's browser fields, the browser video producer and the resolved noVNC URL.
struct BrowserStageInputs: Equatable {
    let callSession: Int
    let isActive: Bool
    /// An admin who is not an observer: navigate and close follow the server's admin rule.
    let isHost: Bool
    let isAttendee: Bool
    /// The page the remote browser shows.
    let url: String
    /// `resolvedBrowserNoVncURL()`, resolved by the core once per URL change (never per render, INM H1 6).
    let inputBaseURL: String
    let controllerName: String
    let isYouController: Bool
    /// Server provider id ("chromium", "kitesurf"); the copy maps it (S60 Q3).
    let provider: String
    let hasAudio: Bool
    let isAudioMuted: Bool
    /// The core's navigate in flight (any surface: the card or the Activities launcher).
    let isNavigating: Bool
    /// The `shared-browser-video:<channel>` producer user id; "" while there is no video producer.
    let videoUserId: String
    /// The consumer behind it (changes with a new consumer, so the renderer resolves the track again); "" until consumed.
    let videoTrackKey: String
    /// Socket recovery: the last frame stays, input is disabled, the card shows "Reconnecting".
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

/// S60 14 j `BrowserStageModel`. One cold value: every field changes at user pace (a load, a navigation, a mute, a
/// frame-size change), never per frame; the page progress is a platform leaf of the web view, not part of this model.
struct BrowserStageModel: Equatable {
    let revision: Int
    let isActive: Bool
    /// Client-local, one per activation of the shared browser in this call; the platform registry keys its one web view
    /// by it (L6-15), so a new browser session always gets a fresh engine.
    let browserSessionId: String
    let hostLabel: String
    /// The current page URL (the controller's address field draft starts from it).
    let pageURL: String
    let provider: String
    let sharedByName: String
    let isYouSharing: Bool
    let load: BrowserLoadState
    /// `loadFailed` for a page, TLS or renderer failure, `timedOut` for no first frame; `none` otherwise.
    let failure: BrowserFailure
    let issue: BrowserLoadIssue
    let surface: BrowserSurfaceKind
    let webViewRole: BrowserWebViewRole
    /// Whether this person's web view takes touches and keys (the controller, not while reconnecting).
    let inputInteractive: Bool
    /// Input ownership: exactly one person (the controller).
    let canControl: Bool
    /// Hosts can navigate per the server's admin rule (the address row is the controller's; other hosts use the launcher).
    let canNavigate: Bool
    let showsAddressRow: Bool
    /// Go pending ("Navigating"): this card's navigate or one from the launcher.
    let navigatePending: Bool
    let validation: BrowserValidation
    /// `navigateFailed` after a failed navigate from this card (inline under the field); `none` otherwise.
    let commandFailure: BrowserFailure
    let hasAudio: Bool
    /// The audio switch: browser audio present, never for Kitesurf (S60 14 f).
    let showsAudioControl: Bool
    let isAudioMuted: Bool
    let canClose: Bool
    let closePending: Bool
    let videoUserId: String
    let videoTrackKey: String
    /// The remote framebuffer (the video track's decoded frame size), 0 until the first frame; the box is 16:9 until then.
    let framebufferWidth: Int
    let framebufferHeight: Int
    /// A first video frame (video surface) or a first page load (live view surface) arrived for this session.
    let hasSurface: Bool
    /// What the web view loads: the input layer URL with the four noVNC parameters, or the visible page URL; "" for
    /// viewers of a video surface and in fixtures (which load the bundled static page).
    let inputURL: String
    let isKitesurf: Bool
    /// Bumps on Try Again: the registry creates a fresh web view for the same session.
    let reloadSerial: Int
    /// Bumps on Keyboard: the view runs the one bundled focus script once.
    let keyboardSerial: Int
    /// Whether the platform may hold a web view now (never in the failure state: Try Again creates a fresh one).
    let wantsWebView: Bool
    /// Debug fixtures load `BrowserFixturePage.html` (a local static page; no network).
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
    /// `hostActionFailed` after a failed navigate or close (S60 14 e). Nothing on audio (local).
    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    /// Core only: navigate, audio, close and refresh over the existing view model paths.
    @ObservationIgnored var onCommand: ((BrowserStageCommand) -> Void)? = nil
    /// The platform registry releases its web view for an ended browser session (end, reset, terminal call end), so no
    /// hidden web view keeps running after the browser or the call is gone (S60 14 l).
    @ObservationIgnored var onSessionEnded: ((String) -> Void)? = nil
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }
    /// Debug fixtures show the registry readouts (`browser.inputViews`, L6-12).
    @ObservationIgnored var showsDebugReadouts = false

    @ObservationIgnored private(set) var inputs = BrowserStageInputs.make()
    /// Diagnostics for tests (never observed): the commands sent, by kind.
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

    /// The renderer slot id the browser video reports its frame size under (`StagePresenter.frameSizes`, "stage:browser").
    static let videoSlotId = "browser"
    /// A navigate or close with no answer from the core stops showing pending (longer than the 45 s command ack).
    static let hostActionSafetyMillis = Double(SharedBrowserTimeouts.commandAckMillis + 5000)

    init() {}

    // MARK: Core hooks

    /// Core only: the browser fields, role and connection (S60 14 j). Equality guarded.
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
            // A new page URL or a new controller: the web view loads again for this person.
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

    /// Core only: the navigate this card sent failed (inline "Couldn't open that page. Try again." and the outcome).
    func navigateFailed() {
        if !navigatePending { return }
        navigatePending = false
        commandFailure = BrowserFailure.navigateFailed
        cancelSafetyIfIdle()
        publishFeedback(FeedbackKind.hostActionFailed)
        rebuild()
    }

    /// Core only: the core refused the command before sending it (an admin action already in flight). Silent.
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

    /// Core only: the close failed ("Close Shared Browser…" returns; outcome `hostActionFailed`).
    func closeFailed() {
        if !closePending { return }
        closePending = false
        cancelSafetyIfIdle()
        publishFeedback(FeedbackKind.hostActionFailed)
        rebuild()
    }

    // MARK: Platform hooks (the web view and the renderer)

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

    /// A main-frame load failure, a TLS failure (surfaced, never cancelled silently) or a dead renderer process.
    func webViewFailed(browserSessionId id: String, reloadSerial serial: Int, issue next: BrowserLoadIssue) {
        if !isCurrent(id, serial) || next == BrowserLoadIssue.none { return }
        if issue != BrowserLoadIssue.none { return }
        pageLoading = false
        issue = next
        cancelFirstFrameTimer()
        rebuild()
    }

    /// The browser video renderer reported a decoded frame size (main thread, never inside a frame callback).
    func videoFrameArrived(width: Int, height: Int) {
        if browserSessionId.isEmpty || width <= 0 || height <= 0 { return }
        if videoFrameSeen && framebufferWidth == width && framebufferHeight == height { return }
        videoFrameSeen = true
        framebufferWidth = width
        framebufferHeight = height
        rebuild()
    }

    // MARK: Actions (views)

    /// Go or Return on the address row (controller). Validates like the launcher; pending until the core's navigate ends.
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

    /// The field changed: the inline validation or failure line goes away.
    func clearValidation() {
        if validation == BrowserValidation.none && commandFailure == BrowserFailure.none { return }
        validation = BrowserValidation.none
        commandFailure = BrowserFailure.none
        rebuild()
    }

    /// Mute or unmute browser audio for this person only (local; no feedback).
    @discardableResult
    func toggleAudio() -> ActivityTapResult {
        if !model.showsAudioControl { return ActivityTapResult.explained }
        send(BrowserStageCommand.make(BrowserStageCommandKind.toggleAudio))
        return ActivityTapResult.dispatched
    }

    /// Close for everyone (host, after the confirmation the view owns). Duplicate guarded.
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

    /// Try Again on the failure state: a fresh web view for the same session, the first-frame timer again and a state
    /// refresh from the server (which also notices a session that ended remotely).
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

    /// The Keyboard toggle (controller): the view runs the one bundled focus script (no arbitrary JavaScript).
    @discardableResult
    func focusKeyboard() -> ActivityTapResult {
        if !model.inputInteractive || model.webViewRole == BrowserWebViewRole.none || !model.hasSurface {
            return ActivityTapResult.explained
        }
        keyboardSerial += 1
        rebuild()
        return ActivityTapResult.dispatched
    }

    /// Debug fixtures: the web view loads the bundled static page instead of noVNC, and the stage shows no live video.
    func useFixturePage(_ on: Bool) {
        if usesFixturePage == on { return }
        usesFixturePage = on
        rebuild()
    }

    /// With the S1 reset: nothing pending survives into the next call, and the registry drops its web view.
    func reset() {
        endSession()
        resetLocal()
        inputs = BrowserStageInputs.make()
        rebuild()
    }

    /// True while the first-frame timer is armed (tests and readouts).
    var hasFirstFrameTimer: Bool {
        return firstFrameTask != nil
    }

    // MARK: Pure rules

    static func surface(isActive: Bool, videoUserId: String, inputBaseURL: String, usesFixturePage: Bool) -> BrowserSurfaceKind {
        if !isActive { return BrowserSurfaceKind.none }
        if usesFixturePage { return BrowserSurfaceKind.liveView }
        if !videoUserId.isEmpty { return BrowserSurfaceKind.video }
        if !inputBaseURL.isEmpty { return BrowserSurfaceKind.liveView }
        return BrowserSurfaceKind.none
    }

    /// Viewers of a video surface hold no web view (`browser.inputViews = 0`, S60 14 l).
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

    /// The box the renderer and the input layer share: the framebuffer's aspect, 16:9 until the first frame.
    static func aspectRatio(width: Int, height: Int) -> Double {
        if width <= 0 || height <= 0 { return 16.0 / 9.0 }
        return Double(width) / Double(height)
    }

    // MARK: Private

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

    /// The 20 s first-frame timeout (a test seam, like `AppHostPresenter.fireReadyTimeout`): the failure state when the
    /// session it was armed for still has no surface. While reconnecting it waits for the recovery instead.
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

// MARK: Load-state and navigation rules (the one contract both web views feed)

/// Maps each platform's web view errors onto `BrowserLoadIssue` (S60 14 c, d). TLS failures are surfaced as
/// `sslFailed` (never cancelled silently); a cancelled or superseded load is not a failure.
enum BrowserLoadIssuePolicy {
    static let urlErrorDomain = "NSURLErrorDomain"
    static let webKitErrorDomain = "WebKitErrorDomain"
    /// NSURLErrorCancelled: a newer load replaced this one, or a navigation policy cancelled it.
    static let urlErrorCancelled = -999
    /// NSURLErrorSecureConnectionFailed (-1200) through NSURLErrorClientCertificateRequired (-1206).
    static let urlErrorTLSFirst = -1206
    static let urlErrorTLSLast = -1200
    /// WebKitErrorFrameLoadInterruptedByPolicyChange and WebKitErrorPlugInWillHandleLoad.
    static let webKitFrameLoadInterrupted = 102
    static let webKitPlugInWillHandleLoad = 204
    /// Android WebViewClient.ERROR_FAILED_SSL_HANDSHAKE.
    static let androidFailedSSLHandshake = -11

    /// iOS: a main-frame `didFail` or `didFailProvisionalNavigation` error.
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

    /// Android: a main-frame `onReceivedError` error code.
    static func androidErrorIssue(_ code: Int) -> BrowserLoadIssue {
        return code == androidFailedSSLHandshake ? BrowserLoadIssue.sslFailed : BrowserLoadIssue.pageFailed
    }

    /// Both: a main-frame HTTP response (iOS navigation response, Android `onReceivedHttpError`).
    static func httpIssue(_ status: Int) -> BrowserLoadIssue {
        return status >= 400 ? BrowserLoadIssue.pageFailed : BrowserLoadIssue.none
    }
}

/// Which schemes the browser web view may load (the noVNC page, the Live View page, the fixture's `about:blank`).
/// Everything else (app links, `intent:`, `javascript:`, files) is cancelled; pop-up windows are never created.
enum BrowserNavigationPolicy {
    static let allowedSchemes: [String] = ["https", "http", "about"]

    static func allows(scheme: String) -> Bool {
        return allowedSchemes.contains(scheme.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }
}

// MARK: Bundled scripts (one fixed set, no arbitrary JavaScript)

/// The input layer's only scripts (S60 14 c, d): the noVNC canvas draws nothing (the WebRTC video shows the pixels) while
/// the page stays hittable, and the Keyboard toggle focuses noVNC's own keyboard input. No `$` in either (Kotlin string
/// templates).
enum BrowserInputScripts {
    static let styleElementId = "conclave-input-layer"

    static let hiddenCanvasCSS = "canvas { opacity: 0 !important; } "
        + "html, body, #noVNC_container, #noVNC_screen { background: transparent !important; } "
        + "#noVNC_control_bar_anchor, #noVNC_status, #noVNC_transition { display: none !important; }"

    /// Installs the CSS once per document (iOS: a document-end user script; Android: after each page finishes).
    static let installHiddenCanvas = "(function () {"
        + " if (document.getElementById('" + styleElementId + "')) { return; }"
        + " var style = document.createElement('style');"
        + " style.id = '" + styleElementId + "';"
        + " style.textContent = '" + hiddenCanvasCSS + "';"
        + " (document.head || document.documentElement).appendChild(style);"
        + " })();"

    /// Focuses noVNC's keyboard input (its hidden text field), else the canvas.
    static let focusKeyboard = "(function () {"
        + " var input = document.getElementById('noVNC_keyboardinput');"
        + " if (input) { input.focus(); return 'keyboard'; }"
        + " var canvas = document.querySelector('canvas');"
        + " if (canvas) { canvas.focus(); return 'canvas'; }"
        + " return 'none';"
        + " })();"
}

// MARK: Fixtures (L6-12)

/// `browser-*` fixture states for the S20 SL14 stage fixture (HD request B8-T1 R3 routes them through
/// `ActivityFixtureScript` and `StageFixtureState`). No socket, network, audio or capture: the web view loads
/// `BrowserFixturePage.html` (a local static page), commands land in a recording owner, and no live video renders.
enum BrowserStageFixtureState: String, CaseIterable, Equatable {
    case controller = "browser-controller"
    case viewer = "browser-viewer"
    case starting = "browser-starting"
    case failed = "browser-failed"
    case rendererGone = "browser-renderer-gone"
    case reconnecting = "browser-reconnecting"
    case kitesurf = "browser-kitesurf"
}

/// Records what a real core would perform.
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

/// The one local static page fixtures load (no network, no script).
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

    /// The stage layer: the browser is live (presence only, S20 11 j); `browser-reconnecting` recovers.
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

    /// The scripted core inputs for a state. `browser-starting` has no page URL and no video producer yet.
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

    /// Binds the presenter to the recording owner and scripts the state. `browser-starting` loads no page: it shows
    /// "Starting browser" and, 20 s later, the first-frame timeout's failure state (the S60 14 timeout cell);
    /// `browser-failed` (a TLS failure) and `browser-renderer-gone` fail at once.
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
