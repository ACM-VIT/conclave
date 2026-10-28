import Foundation
import Observation

// S60 0.5 and 13 j (ACT-7): the session-owned app host presenter behind the SDK app card on the stage (S20 owns the
// card). Native chrome around one versioned, scoped web renderer per active app (D14): status, host lock and close,
// opening and failure, the Whiteboard tools. Two stored properties, each its own observation unit: `model` (cold: the
// phase, lock, tag and header counts) and `toolbar` (the embed's status and pending commands), so a tool change never
// rebuilds the header and a status burst never rebuilds the failure states. Yjs and awareness never reach this
// presenter (C6-18): the non-observable `ActiveAppSession` relays them. App-owned copy travels as raw values and typed
// enums; each platform maps them through its copy file (`NativeAppHost+iOS.swift` `AppHostCopy`,
// `K/ui/apps/AppHostCopy.kt`). Wheel and Watch land with ACT-8; until then they show the version mismatch state.

enum AppHostPhase: String, CaseIterable, Equatable {
    case opening, ready, readOnly, failed, versionMismatch, closing
}

enum AppHostIssue: String, CaseIterable, Equatable {
    case none, loadFailed, timedOut, versionMismatch, rendererGone
}

/// The card tag under the header (S60 13 f, g).
enum AppHostTag: String, CaseIterable, Equatable {
    case none, viewOnly, lockedForOthers, reconnecting
}

/// Bridge commands (C6-19, S60 13 j). Wheel and Watch commands are ACT-8.
enum AppHostCommandKind: String, CaseIterable, Equatable {
    case setTool, setColor, setStrokeWidth, setFill, undo, redo, setPage, addPage, renamePage, deletePage, zoomToFit, export
}

/// Core actions over the existing view model paths: Close (`closeActiveApp()`) and Lock Editing (`toggleAppsLock()`).
enum AppHostCoreCommandKind: String, CaseIterable, Equatable {
    case close, setLocked
}

struct AppHostCoreCommand: Equatable {
    let kind: AppHostCoreCommandKind
    let flag: Bool
}

/// The Whiteboard ink colors: the SDK's flat palette (`apps/whiteboard/shared/constants/tools.ts` TOOL_COLORS). User
/// content, not app palette (S60 13 e, S60R 25); the raw value is the color the embed draws with.
enum AppInkColor: String, CaseIterable, Equatable {
    case white = "#ffffff"
    case mist = "#e3e3e8"
    case gray = "#71717a"
    case charcoal = "#1e1e1e"
    case lightRed = "#f87171"
    case red = "#ef4444"
    case rose = "#fb7185"
    case pink = "#ec4899"
    case lightOrange = "#fb923c"
    case orange = "#f97316"
    case yellow = "#facc15"
    case amber = "#fbbf24"
    case lightGreen = "#4ade80"
    case green = "#22c55e"
    case teal = "#2dd4bf"
    case darkTeal = "#14b8a6"
    case lightBlue = "#60a5fa"
    case blue = "#3b82f6"
    case lavender = "#a8a5ff"
    case purple = "#c084fc"
}

/// Stroke widths (the web's `[` and `]` steps, WhiteboardWebApp.tsx).
enum AppStrokeWidths {
    static let steps: [Int] = [2, 3, 5, 8, 12]
}

/// The Shape menu's fill choice.
enum AppShapeFill: String, CaseIterable, Equatable {
    case outline, filled
}

struct AppHostInputs: Equatable {
    let callSession: Int
    let appId: String
    let isHost: Bool
    let isAttendee: Bool
    let isLocked: Bool
    let isReconnecting: Bool

    static func make(callSession: Int = 0, appId: String = "", isHost: Bool = false, isAttendee: Bool = false,
                     isLocked: Bool = false, isReconnecting: Bool = false) -> AppHostInputs {
        return AppHostInputs(callSession: callSession, appId: appId, isHost: isHost, isAttendee: isAttendee,
                             isLocked: isLocked, isReconnecting: isReconnecting)
    }
}

/// S60 13 j `AppHostModel`, cold part. `reloadSerial` bumps on Try Again: the platform registry then recreates the web
/// view for the same app session (`app.reloads`); everything else keeps the registered instance (`app.registrySerial`).
struct AppHostModel: Equatable {
    let revision: Int
    let appId: String
    let appSessionId: String
    let phase: AppHostPhase
    let issue: AppHostIssue
    let isLocked: Bool
    let canEdit: Bool
    let canClose: Bool
    let canLock: Bool
    let closePending: Bool
    let lockPending: Bool
    let tag: AppHostTag
    let bundleVersion: String
    let editorCount: Int
    /// Wheel and Watch counts and playback (ACT-8); 0 and "none" until then.
    let nameCount: Int
    let playback: String
    let hasEmbed: Bool
    let reloadSerial: Int
    /// Whether the platform host may hold a web view now (opening, ready, read-only, closing). On a failure the host
    /// releases it, and Try Again creates a fresh one.
    let wantsWebView: Bool

    static let empty = AppHostModel(revision: 0, appId: "", appSessionId: "", phase: AppHostPhase.opening, issue: AppHostIssue.none,
                                    isLocked: false, canEdit: false, canClose: false, canLock: false, closePending: false,
                                    lockPending: false, tag: AppHostTag.none, bundleVersion: "", editorCount: 0, nameCount: 0,
                                    playback: "none", hasEmbed: false, reloadSerial: 0, wantsWebView: false)
}

/// S60 13 j, hot part: the embed's status and the commands awaiting their `ack`.
struct AppToolbarModel: Equatable {
    let revision: Int
    let tool: String
    let previousTool: String
    let color: String
    let strokeWidth: Int
    let filled: Bool
    let canUndo: Bool
    let canRedo: Bool
    let pageId: String
    let pageName: String
    let pages: [AppPageModel]
    let elementCount: Int
    /// `AppHostCommandKind` raw values awaiting an ack (the control shows pending).
    let pendingKinds: [String]
    /// Bumps when an exported PNG is ready (`AppHostPresenter.takeExport()`).
    let exportSequence: Int
    let exportFailed: Bool

    func isPending(_ kind: AppHostCommandKind) -> Bool {
        return pendingKinds.contains(kind.rawValue)
    }

    static let empty = AppToolbarModel(revision: 0, tool: AppWhiteboardTool.pen.rawValue, previousTool: AppWhiteboardTool.pen.rawValue,
                                       color: AppInkColor.mist.rawValue, strokeWidth: 3, filled: false, canUndo: false,
                                       canRedo: false, pageId: "", pageName: "", pages: [], elementCount: 0, pendingKinds: [],
                                       exportSequence: 0, exportFailed: false)
}

struct AppHostPendingCommand: Equatable {
    let requestId: String
    let kind: AppHostCommandKind
    let value: String
}

@MainActor
@Observable
final class AppHostPresenter {
    private(set) var model: AppHostModel = AppHostModel.empty
    private(set) var toolbar: AppToolbarModel = AppToolbarModel.empty
    /// `hostActionFailed` for a failed lock or close (S60 13 e, h).
    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    /// Core only: Close and Lock Editing (the S1 `onCommand` pattern).
    @ObservationIgnored var onCommand: ((AppHostCoreCommand) -> Void)? = nil
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }
    /// The relay the platform host attaches its web view to (`ActivityWebViewRegistry`, L6-15).
    @ObservationIgnored private(set) var session: ActiveAppSession? = nil
    /// Debug fixtures show the registry readouts (`app.registrySerial`, `app.reloads`, L6-12).
    @ObservationIgnored var showsDebugReadouts = false

    @ObservationIgnored private(set) var inputs = AppHostInputs.make()
    /// Diagnostics for tests (never observed): commands sent, by kind and request id.
    @ObservationIgnored private(set) var commandLog: [String] = []

    @ObservationIgnored private var appSessionId = ""
    @ObservationIgnored private var issue = AppHostIssue.none
    @ObservationIgnored private var bundleVersion = ""
    @ObservationIgnored private var embedReady = false
    @ObservationIgnored private var embedStatus = AppEmbedStatus.empty
    @ObservationIgnored private var previousTool = AppWhiteboardTool.pen.rawValue
    @ObservationIgnored private var closePending = false
    @ObservationIgnored private var lockPending = false
    @ObservationIgnored private var lockTarget = false
    @ObservationIgnored private var reloadSerial = 0
    @ObservationIgnored private var pending: [AppHostPendingCommand] = []
    @ObservationIgnored private var nextRequestNumber = 0
    @ObservationIgnored private var exportSequence = 0
    @ObservationIgnored private var exportFailed = false
    @ObservationIgnored private var exportPNGBase64 = ""
    @ObservationIgnored private var readyTimeoutTask: Task<Void, Never>? = nil
    @ObservationIgnored private var pendingSafetyTask: Task<Void, Never>? = nil
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var toolbarRevision = 0

    /// A close or lock with no answer from the core (an admin action already in flight) stops showing pending.
    static let hostActionSafetyMillis = 15000.0

    init() {}

    // MARK: Core hooks

    /// Core only: the relay this presenter drives. Installs the session's event hook.
    func bind(session: ActiveAppSession) {
        self.session = session
        session.onEvent = { [weak self] event in
            self?.apply(event: event)
        }
        followSession()
        rebuild()
    }

    /// Core only: the app, role, lock and connection (S60 13 j inputs). Equality guarded.
    func apply(_ next: AppHostInputs) {
        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            resetLocal()
        }
        let sessionChanged = (session?.appSessionId ?? "") != appSessionId
        if next == inputs && !sessionChanged { return }
        let previous = inputs
        inputs = next
        if lockPending && next.isLocked == lockTarget { finishLock() }
        if closePending && next.appId.isEmpty { closePending = false }
        if next.appId != previous.appId { exportPNGBase64 = "" }
        followSession()
        rebuild()
    }

    /// Core only: the close failed (S60 13 f "closing" returns to the menu item; outcome `hostActionFailed`).
    func closeFailed() {
        if !closePending { return }
        closePending = false
        cancelSafety()
        publishFeedback(FeedbackKind.hostActionFailed)
        rebuild()
    }

    /// Core only: the lock change failed.
    func lockFailed() {
        if !lockPending { return }
        finishLock()
        publishFeedback(FeedbackKind.hostActionFailed)
        rebuild()
    }

    /// Session events (ready, failures, the embed's status and acks).
    func apply(event: ActiveAppEvent) {
        switch event.kind {
        case .lifecycle:
            followSession()
            rebuild()
        case .loadStarted:
            followSession()
            if event.appSessionId != appSessionId { return }
            embedReady = false
            issue = AppHostIssue.none
            startReadyTimer()
            rebuild()
        case .ready:
            if event.appSessionId != appSessionId { return }
            embedReady = true
            issue = AppHostIssue.none
            bundleVersion = event.bundleVersion
            cancelReadyTimer()
            rebuild()
        case .failed:
            if event.appSessionId != appSessionId { return }
            embedReady = false
            issue = event.issue
            if !event.bundleVersion.isEmpty { bundleVersion = event.bundleVersion }
            cancelReadyTimer()
            pending = []
            rebuild()
            rebuildToolbar()
        case .status:
            if event.appSessionId != appSessionId { return }
            if event.status.tool != embedStatus.tool { previousTool = embedStatus.tool }
            let editorsChanged = event.status.editorCount != embedStatus.editorCount
            embedStatus = event.status
            rebuildToolbar()
            if editorsChanged { rebuild() }
        case .ack:
            if event.appSessionId != appSessionId { return }
            acknowledge(requestId: event.requestId, ok: event.ok, pngBase64: event.pngBase64)
        }
    }

    // MARK: Actions (views)

    /// Try Again: a fresh web view for the same app session (the registry recreates it on the new `reloadSerial`).
    func retry() {
        if model.hasEmbed == false { return }
        issue = AppHostIssue.none
        embedReady = false
        pending = []
        reloadSerial += 1
        cancelReadyTimer()
        rebuild()
        rebuildToolbar()
    }

    /// Close (host, after the confirmation the view owns, R09/D12). Duplicate guarded.
    @discardableResult
    func confirmClose() -> ActivityTapResult {
        if !model.canClose { return ActivityTapResult.explained }
        if closePending { return ActivityTapResult.ignored }
        closePending = true
        startSafety()
        rebuild()
        onCommand?(AppHostCoreCommand(kind: AppHostCoreCommandKind.close, flag: false))
        return ActivityTapResult.dispatched
    }

    /// Lock Editing (host). Pending until the room's lock matches or the core reports a failure.
    @discardableResult
    func setLocked(_ locked: Bool) -> ActivityTapResult {
        if !model.canLock { return ActivityTapResult.explained }
        if lockPending || locked == inputs.isLocked { return ActivityTapResult.ignored }
        lockPending = true
        lockTarget = locked
        startSafety()
        rebuild()
        onCommand?(AppHostCoreCommand(kind: AppHostCoreCommandKind.setLocked, flag: locked))
        return ActivityTapResult.dispatched
    }

    /// One bridge command with a client-local request id; the control shows pending until the matching `ack` (or the
    /// 10 s timeout). `value` and `extra` carry the tool, color, width, fill, page id and page name.
    @discardableResult
    func perform(_ kind: AppHostCommandKind, value: String = "", extra: String = "") -> ActivityTapResult {
        guard let session = session else { return ActivityTapResult.explained }
        if model.phase != AppHostPhase.ready && model.phase != AppHostPhase.readOnly { return ActivityTapResult.explained }
        if AppHostPresenter.isEditCommand(kind) && !model.canEdit { return ActivityTapResult.explained }
        if toolbar.isPending(kind) { return ActivityTapResult.ignored }
        if kind == AppHostCommandKind.setTool && value == toolbar.tool { return ActivityTapResult.ignored }
        if kind == AppHostCommandKind.undo && !toolbar.canUndo { return ActivityTapResult.ignored }
        if kind == AppHostCommandKind.redo && !toolbar.canRedo { return ActivityTapResult.ignored }
        guard let payload = AppHostPresenter.payload(kind, value: value, extra: extra) else { return ActivityTapResult.ignored }
        nextRequestNumber += 1
        let requestId = "h-" + String(nextRequestNumber)
        if !session.sendCommand(AppHostPresenter.outboundType(kind), requestId: requestId, payload: payload) {
            return ActivityTapResult.explained
        }
        commandLog.append(kind.rawValue + ":" + requestId)
        if commandLog.count > 40 { commandLog.removeFirst() }
        if kind == AppHostCommandKind.export { exportFailed = false }
        pending.append(AppHostPendingCommand(requestId: requestId, kind: kind, value: value))
        startCommandTimer(requestId: requestId)
        rebuildToolbar()
        return ActivityTapResult.dispatched
    }

    /// S60 13 c: an Apple Pencil tap or squeeze. Tool switches dispatch here; the menus open in the iOS view.
    @discardableResult
    func pencil(_ response: AppPencilResponse) -> ActivityTapResult {
        switch response {
        case .toggleEraser:
            let target = toolbar.tool == AppWhiteboardTool.eraser.rawValue
                ? (toolbar.previousTool == AppWhiteboardTool.eraser.rawValue ? AppWhiteboardTool.pen.rawValue : toolbar.previousTool)
                : AppWhiteboardTool.eraser.rawValue
            return perform(AppHostCommandKind.setTool, value: target)
        case .previousTool:
            return perform(AppHostCommandKind.setTool, value: toolbar.previousTool)
        case .none, .colorMenu, .strokeMenu, .toolPalette:
            return ActivityTapResult.ignored
        }
    }

    /// The exported PNG (base64) once; "" when none is waiting.
    func takeExport() -> String {
        let value = exportPNGBase64
        exportPNGBase64 = ""
        return value
    }

    /// With the S1 reset: nothing pending survives into the next call.
    func reset() {
        resetLocal()
        inputs = AppHostInputs.make()
        rebuild()
        rebuildToolbar()
    }

    // MARK: Pure rules

    static func isEditCommand(_ kind: AppHostCommandKind) -> Bool {
        switch kind {
        case .setPage, .zoomToFit, .export: return false
        default: return true
        }
    }

    static func canEdit(isAttendee: Bool, isHost: Bool, isLocked: Bool) -> Bool {
        return !isAttendee && (!isLocked || isHost)
    }

    static func phase(hasApp: Bool, hasEmbed: Bool, issue: AppHostIssue, embedReady: Bool, closePending: Bool,
                      canEdit: Bool) -> AppHostPhase {
        if closePending { return AppHostPhase.closing }
        if !hasApp { return AppHostPhase.opening }
        if !hasEmbed || issue == AppHostIssue.versionMismatch { return AppHostPhase.versionMismatch }
        if issue != AppHostIssue.none { return AppHostPhase.failed }
        if !embedReady { return AppHostPhase.opening }
        return canEdit ? AppHostPhase.ready : AppHostPhase.readOnly
    }

    static func tag(isReconnecting: Bool, isLocked: Bool, isHost: Bool) -> AppHostTag {
        if isReconnecting { return AppHostTag.reconnecting }
        if isLocked { return isHost ? AppHostTag.lockedForOthers : AppHostTag.viewOnly }
        return AppHostTag.none
    }

    static func outboundType(_ kind: AppHostCommandKind) -> AppBridgeOutboundType {
        switch kind {
        case .setTool: return AppBridgeOutboundType.setTool
        case .setColor: return AppBridgeOutboundType.setColor
        case .setStrokeWidth: return AppBridgeOutboundType.setStrokeWidth
        case .setFill: return AppBridgeOutboundType.setFill
        case .undo: return AppBridgeOutboundType.undo
        case .redo: return AppBridgeOutboundType.redo
        case .setPage: return AppBridgeOutboundType.setPage
        case .addPage: return AppBridgeOutboundType.addPage
        case .renamePage: return AppBridgeOutboundType.renamePage
        case .deletePage: return AppBridgeOutboundType.deletePage
        case .zoomToFit: return AppBridgeOutboundType.zoomToFit
        case .export: return AppBridgeOutboundType.export
        }
    }

    /// The command payload, or nil when the value is not one the embed accepts (validated here so nothing malformed
    /// crosses the bridge).
    static func payload(_ kind: AppHostCommandKind, value: String, extra: String) -> [String: Any]? {
        switch kind {
        case .setTool:
            if AppWhiteboardTool(rawValue: value) == nil { return nil }
            return ["tool": value]
        case .setColor:
            if AppInkColor(rawValue: value) == nil { return nil }
            return ["color": value]
        case .setStrokeWidth:
            guard let width = Int(value), AppStrokeWidths.steps.contains(width) else { return nil }
            return ["width": width]
        case .setFill:
            guard let fill = AppShapeFill(rawValue: value) else { return nil }
            return ["filled": fill == AppShapeFill.filled]
        case .setPage, .deletePage:
            if !AppBridgeCodec.isValidIdentifier(value) { return nil }
            return ["pageId": value]
        case .renamePage:
            let name = extra.trimmingCharacters(in: .whitespacesAndNewlines)
            if !AppBridgeCodec.isValidIdentifier(value) || name.isEmpty { return nil }
            return ["pageId": value, "name": AppBridgeCodec.clipped(name, AppBridgeProtocol.pageNameLimit)]
        case .undo, .redo, .addPage, .zoomToFit, .export:
            return [:]
        }
    }

    // MARK: Private

    private func followSession() {
        let current = session?.appSessionId ?? ""
        if current == appSessionId { return }
        appSessionId = current
        issue = AppHostIssue.none
        bundleVersion = ""
        embedReady = false
        embedStatus = AppEmbedStatus.empty
        previousTool = AppWhiteboardTool.pen.rawValue
        pending = []
        exportPNGBase64 = ""
        exportFailed = false
        cancelReadyTimer()
        rebuildToolbar()
    }

    private func acknowledge(requestId: String, ok: Bool, pngBase64: String) {
        guard let index = pending.firstIndex(where: { $0.requestId == requestId }) else { return }
        let entry = pending[index]
        pending.remove(at: index)
        if entry.kind == AppHostCommandKind.export {
            if ok && !pngBase64.isEmpty {
                exportPNGBase64 = pngBase64
                exportSequence += 1
            } else {
                exportFailed = true
            }
        }
        rebuildToolbar()
    }

    private func startCommandTimer(requestId: String) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.sleep(AppBridgeProtocol.commandTimeoutMillis)
            self.fireCommandTimeout(requestId: requestId)
        }
    }

    /// The 10 s command timeout (a test seam, like `GameStagePresenter.fireTimeout`): the control stops showing pending;
    /// an export that never answered shows its inline failure.
    func fireCommandTimeout(requestId: String) {
        guard let index = pending.firstIndex(where: { $0.requestId == requestId }) else { return }
        let entry = pending[index]
        pending.remove(at: index)
        if entry.kind == AppHostCommandKind.export { exportFailed = true }
        rebuildToolbar()
    }

    private func startReadyTimer() {
        readyTimeoutTask?.cancel()
        let expectedSession = appSessionId
        let expectedReload = reloadSerial
        readyTimeoutTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.sleep(AppBridgeProtocol.readyTimeoutMillis)
            if Task.isCancelled { return }
            self.fireReadyTimeout(appSessionId: expectedSession, reloadSerial: expectedReload)
        }
    }

    /// The 15 s ready timeout (a test seam): "Couldn't Open" when the load it was started for still has no `ready`.
    func fireReadyTimeout(appSessionId expectedSession: String, reloadSerial expectedReload: Int) {
        if appSessionId != expectedSession || reloadSerial != expectedReload { return }
        if embedReady || issue != AppHostIssue.none { return }
        issue = AppHostIssue.timedOut
        readyTimeoutTask = nil
        rebuild()
    }

    /// True while a ready timeout is armed (tests and the fixture readouts).
    var hasReadyTimer: Bool {
        return readyTimeoutTask != nil
    }

    private func cancelReadyTimer() {
        readyTimeoutTask?.cancel()
        readyTimeoutTask = nil
    }

    private func startSafety() {
        pendingSafetyTask?.cancel()
        pendingSafetyTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.sleep(AppHostPresenter.hostActionSafetyMillis)
            if Task.isCancelled { return }
            self.pendingSafetyTask = nil
            if self.closePending || self.lockPending {
                self.closePending = false
                self.lockPending = false
                self.rebuild()
            }
        }
    }

    private func cancelSafety() {
        if closePending || lockPending { return }
        pendingSafetyTask?.cancel()
        pendingSafetyTask = nil
    }

    private func finishLock() {
        lockPending = false
        cancelSafety()
    }

    private func resetLocal() {
        cancelReadyTimer()
        pendingSafetyTask?.cancel()
        pendingSafetyTask = nil
        appSessionId = session?.appSessionId ?? ""
        issue = AppHostIssue.none
        bundleVersion = ""
        embedReady = false
        embedStatus = AppEmbedStatus.empty
        previousTool = AppWhiteboardTool.pen.rawValue
        closePending = false
        lockPending = false
        pending = []
        exportPNGBase64 = ""
        exportFailed = false
        commandLog = []
    }

    private func rebuild() {
        let hasApp = !inputs.appId.isEmpty && !inputs.isAttendee
        let hasEmbed = hasApp && !AppBridgeProtocol.entryFile(appId: inputs.appId).isEmpty
        let canEdit = hasApp && AppHostPresenter.canEdit(isAttendee: inputs.isAttendee, isHost: inputs.isHost, isLocked: inputs.isLocked)
        let phase = AppHostPresenter.phase(hasApp: hasApp, hasEmbed: hasEmbed, issue: issue, embedReady: embedReady,
                                           closePending: closePending, canEdit: canEdit)
        let wantsWebView = hasEmbed && !appSessionId.isEmpty
            && (phase == AppHostPhase.opening || phase == AppHostPhase.ready || phase == AppHostPhase.readOnly || phase == AppHostPhase.closing)
        let next = AppHostModel(
            revision: revision,
            appId: hasApp ? inputs.appId : "",
            appSessionId: hasApp ? appSessionId : "",
            phase: phase,
            issue: hasApp && !hasEmbed ? AppHostIssue.versionMismatch : issue,
            isLocked: inputs.isLocked,
            canEdit: canEdit,
            canClose: hasApp && inputs.isHost,
            canLock: hasApp && inputs.isHost,
            closePending: closePending,
            lockPending: lockPending,
            tag: hasApp ? AppHostPresenter.tag(isReconnecting: inputs.isReconnecting, isLocked: inputs.isLocked, isHost: inputs.isHost) : AppHostTag.none,
            bundleVersion: bundleVersion,
            editorCount: embedStatus.editorCount,
            nameCount: 0,
            playback: "none",
            hasEmbed: hasEmbed,
            reloadSerial: reloadSerial,
            wantsWebView: wantsWebView
        )
        if AppHostPresenter.sameModel(next, model) { return }
        revision += 1
        model = AppHostModel(revision: revision, appId: next.appId, appSessionId: next.appSessionId, phase: next.phase,
                             issue: next.issue, isLocked: next.isLocked, canEdit: next.canEdit, canClose: next.canClose,
                             canLock: next.canLock, closePending: next.closePending, lockPending: next.lockPending, tag: next.tag,
                             bundleVersion: next.bundleVersion, editorCount: next.editorCount, nameCount: next.nameCount,
                             playback: next.playback, hasEmbed: next.hasEmbed, reloadSerial: next.reloadSerial,
                             wantsWebView: next.wantsWebView)
    }

    private func rebuildToolbar() {
        var kinds: [String] = []
        for entry in pending {
            if !kinds.contains(entry.kind.rawValue) { kinds.append(entry.kind.rawValue) }
        }
        let next = AppToolbarModel(revision: toolbarRevision, tool: embedStatus.tool, previousTool: previousTool,
                                   color: embedStatus.color, strokeWidth: embedStatus.strokeWidth, filled: embedStatus.filled,
                                   canUndo: embedStatus.canUndo, canRedo: embedStatus.canRedo, pageId: embedStatus.pageId,
                                   pageName: embedStatus.pageName, pages: embedStatus.pages,
                                   elementCount: embedStatus.elementCount, pendingKinds: kinds, exportSequence: exportSequence,
                                   exportFailed: exportFailed)
        if AppHostPresenter.sameToolbar(next, toolbar) { return }
        toolbarRevision += 1
        toolbar = AppToolbarModel(revision: toolbarRevision, tool: next.tool, previousTool: next.previousTool, color: next.color,
                                  strokeWidth: next.strokeWidth, filled: next.filled, canUndo: next.canUndo, canRedo: next.canRedo,
                                  pageId: next.pageId, pageName: next.pageName, pages: next.pages, elementCount: next.elementCount,
                                  pendingKinds: next.pendingKinds, exportSequence: next.exportSequence,
                                  exportFailed: next.exportFailed)
    }

    /// Equal apart from the revision.
    static func sameModel(_ a: AppHostModel, _ b: AppHostModel) -> Bool {
        return a.appId == b.appId && a.appSessionId == b.appSessionId && a.phase == b.phase && a.issue == b.issue
            && a.isLocked == b.isLocked && a.canEdit == b.canEdit && a.canClose == b.canClose && a.canLock == b.canLock
            && a.closePending == b.closePending && a.lockPending == b.lockPending && a.tag == b.tag
            && a.bundleVersion == b.bundleVersion && a.editorCount == b.editorCount && a.nameCount == b.nameCount
            && a.playback == b.playback && a.hasEmbed == b.hasEmbed && a.reloadSerial == b.reloadSerial
            && a.wantsWebView == b.wantsWebView
    }

    static func sameToolbar(_ a: AppToolbarModel, _ b: AppToolbarModel) -> Bool {
        return a.tool == b.tool && a.previousTool == b.previousTool && a.color == b.color && a.strokeWidth == b.strokeWidth
            && a.filled == b.filled && a.canUndo == b.canUndo && a.canRedo == b.canRedo && a.pageId == b.pageId
            && a.pageName == b.pageName && a.pages == b.pages && a.elementCount == b.elementCount
            && a.pendingKinds == b.pendingKinds && a.exportSequence == b.exportSequence && a.exportFailed == b.exportFailed
    }

    private func publishFeedback(_ kind: FeedbackKind) {
        feedbackState = MeetingShellFeedbackState(session: inputs.callSession,
                                                  token: FeedbackToken(sequence: feedbackState.token.sequence + 1, kind: kind))
    }
}

// MARK: Fixtures (L6-12)

/// `app-*` fixture states for the S20 SL14 stage fixture (layered on `app-opening` by HD request B7-T1 R5). No socket,
/// network, audio or capture: a fixture `ActiveAppSession` answers sync with an empty document and records the bytes
/// the embed would send. The real bundled embed loads from the app bundle (local assets only).
enum AppHostFixtureState: String, CaseIterable, Equatable {
    case whiteboardReady = "app-whiteboard-ready"
    case whiteboardViewOnly = "app-whiteboard-view-only"
    case whiteboardLockedHost = "app-whiteboard-locked-host"
    case whiteboardReconnecting = "app-whiteboard-reconnecting"
    case versionMismatch = "app-version-mismatch"
    case rendererGone = "app-renderer-gone"
}

@MainActor
final class AppHostFixtureOwner {
    private(set) var updates = 0
    private(set) var awareness = 0
    private(set) var syncs = 0
    private(set) var coreCommands: [String] = []

    func record(_ command: AppHostCoreCommand) {
        coreCommands.append(command.kind.rawValue + (command.kind == AppHostCoreCommandKind.setLocked ? (command.flag ? ":on" : ":off") : ""))
    }

    func recordUpdate() { updates += 1 }
    func recordAwareness() { awareness += 1 }
    func recordSync() { syncs += 1 }
}

enum AppHostFixtures {
    static func state(named raw: String) -> AppHostFixtureState? {
        return AppHostFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func isFixture(_ raw: String) -> Bool {
        return state(named: raw) != nil
    }

    /// Binds `presenter` to a fixture relay and scripts the state. Returns the relay (the caller keeps it alive with the
    /// fixture session).
    @discardableResult
    static func apply(named raw: String, presenter: AppHostPresenter, owner: AppHostFixtureOwner) -> ActiveAppSession? {
        guard let state = state(named: raw) else { return nil }
        let relay = ActiveAppSession()
        relay.syncTransport = { [weak owner] _, _ in
            owner?.recordSync()
            return AppsSyncResponse(syncMessage: Data(), stateVector: nil, awarenessUpdate: nil)
        }
        relay.updateTransport = { [weak owner] _, _ in owner?.recordUpdate() }
        relay.awarenessTransport = { [weak owner] _, _, _ in owner?.recordAwareness() }
        presenter.onCommand = { [weak owner] command in owner?.record(command) }
        presenter.showsDebugReadouts = true
        presenter.bind(session: relay)
        let host = state != .whiteboardViewOnly
        let locked = state == .whiteboardViewOnly || state == .whiteboardLockedHost
        relay.begin(appId: "whiteboard", callSessionId: "fixture-call", isReadOnly: locked && !host)
        relay.setUser(id: "fixture-you", name: "You")
        presenter.apply(AppHostInputs.make(callSession: 1, appId: "whiteboard", isHost: host, isLocked: locked,
                                           isReconnecting: state == .whiteboardReconnecting))
        if state == .whiteboardReconnecting { relay.setConnection(live: false) }
        if state == .versionMismatch {
            presenter.apply(event: ActiveAppEvent.make(kind: ActiveAppEventKind.failed, appSessionId: relay.appSessionId,
                                                       lifecycle: ActiveAppLifecycle.failed, issue: AppHostIssue.versionMismatch,
                                                       bundleVersion: "2.0.0"))
        } else if state == .rendererGone {
            relay.embedFailed(appSessionId: relay.appSessionId, issue: AppHostIssue.rendererGone)
        }
        return relay
    }
}
