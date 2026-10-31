import Foundation

enum DiagnosticsClock {
    static func monotonicMillis() -> Double {
        #if SKIP
        return NativePerformanceDiagnostics.monotonicMillis()
        #else
        return ProcessInfo.processInfo.systemUptime * 1000.0
        #endif
    }

    static func wallMillis() -> Double {
        Date().timeIntervalSince1970 * 1000.0
    }
}

enum DiagnosticsBuild {
    static var isDebug: Bool {
        #if SKIP
        return NativePerformanceDiagnostics.isDebuggable()
        #elseif DEBUG
        return true
        #else
        return false
        #endif
    }
}

enum DiagnosticsExportPolicy {
    static let isOffered = true
}

@MainActor
final class DiagnosticsPlatformHooks {

    var beginInterval: (String, Int, Int) -> Void = { _, _, _ in }
    var endInterval: (String, Int, Int) -> Void = { _, _, _ in }

    var emitEvent: (String, Int) -> Void = { _, _ in }

    var log: (String, String, String) -> Void = { _, _, _ in }

    var processState: (Int, String) -> Void = { _, _ in }

    var installListeners: (DiagnosticsFileStore) -> Void = { _ in }
    var counters: () -> [DiagnosticsCounter] = { [] }
    var info: () -> DiagnosticsPlatformInfo = { DiagnosticsPlatformInfo.host }
    var monotonicMillis: () -> Double = { DiagnosticsClock.monotonicMillis() }
    var wallMillis: () -> Double = { DiagnosticsClock.wallMillis() }

    var debugBlockMainThread: (Int) -> Void = { _ in }

    var debugLaunchForcesRedactionFailure: () -> Bool = { false }

    init() {
    }

    static func platform() -> DiagnosticsPlatformHooks {
        #if SKIP
        return DiagnosticsPlatformHooks.android()
        #elseif os(iOS)
        return CallDiagnosticsIOS.makeHooks()
        #else
        return DiagnosticsPlatformHooks()
        #endif
    }

    #if SKIP

    static func android() -> DiagnosticsPlatformHooks {
        let hooks = DiagnosticsPlatformHooks()
        hooks.beginInterval = { name, id, _ in
            NativePerformanceDiagnostics.traceBegin(name, cookie: id)
        }
        hooks.endInterval = { name, id, _ in
            NativePerformanceDiagnostics.traceEnd(name, cookie: id)
        }
        hooks.emitEvent = { name, _ in
            NativePerformanceDiagnostics.traceInstant(name)
        }
        hooks.log = { category, code, phase in
            NativePerformanceDiagnostics.logCode(category, code: code, phase: phase)
        }
        hooks.processState = { session, phase in
            NativePerformanceDiagnostics.stampProcessState(session, phase: phase)
        }
        hooks.installListeners = { store in
            NativePerformanceDiagnostics.installDiagnosticsListeners(store)
        }
        hooks.counters = {
            [
                DiagnosticsCounter(key: "frame.monitorActive", value: NativePerformanceDiagnostics.frameMonitorActive() ? 1.0 : 0.0),
                DiagnosticsCounter(key: "frame.slow", value: Double(NativePerformanceDiagnostics.slowFrameCount())),
                DiagnosticsCounter(key: "frame.verySlow", value: Double(NativePerformanceDiagnostics.verySlowFrameCount())),
                DiagnosticsCounter(key: AudioRoutingReadout.setCommunicationDeviceKey,
                                   value: Double(NativePerformanceDiagnostics.setCommunicationDeviceCount())),
                DiagnosticsCounter(key: AudioRoutingReadout.volumeStreamKey,
                                   value: Double(NativePerformanceDiagnostics.volumeStream())),
            ]
        }
        hooks.info = {
            DiagnosticsPlatformInfo(platform: "android", appVersion: NativePerformanceDiagnostics.appVersion(),
                                    osVersion: NativePerformanceDiagnostics.osVersion(),
                                    deviceClass: NativePerformanceDiagnostics.deviceClass())
        }
        hooks.monotonicMillis = {
            NativePerformanceDiagnostics.monotonicMillis()
        }
        hooks.debugBlockMainThread = { millis in
            NativePerformanceDiagnostics.debugBlockMainThread(millis)
        }
        hooks.debugLaunchForcesRedactionFailure = {
            NativePerformanceDiagnostics.debugForcesRedactionFailure()
        }
        return hooks
    }
    #endif
}

@MainActor
final class CallDiagnostics {
    static let shared = CallDiagnostics(store: DiagnosticsFileStore.standard(), hooks: DiagnosticsPlatformHooks.platform())

    let store: DiagnosticsFileStore
    let hooks: DiagnosticsPlatformHooks

    var sensitiveValues: (() -> [String])? = nil

    var debugForcesRedactionFailure = false

    private let ring = DiagnosticsBreadcrumbRing(capacity: DiagnosticsLimits.breadcrumbCapacity)
    private var openSpans: [DiagnosticsSpanToken] = []
    private var nextSpanId = 0
    private var previousEvents: [DiagnosticsBreadcrumb] = []
    private var previousWrittenAtMillis = 0.0
    private var launchedAtMillis = 0.0

    private(set) var listenerCount = 0
    private(set) var installCallCount = 0

    private(set) var currentAttempt = 0

    private(set) var currentPhase = "launch"

    private(set) var rejectedCount = 0
    private(set) var flushCount = 0
    private(set) var exportCount = 0

    private(set) var spanBeginCount = 0
    private(set) var spanEndCount = 0
    private(set) var presenceAdapterCount = 0

    init(store: DiagnosticsFileStore, hooks: DiagnosticsPlatformHooks) {
        self.store = store
        self.hooks = hooks
    }

    var bufferCount: Int { ring.count }
    var bufferCapacity: Int { ring.capacity }
    var droppedCount: Int { ring.droppedCount }
    var openSpanCount: Int { openSpans.count }

    var events: [DiagnosticsBreadcrumb] { ring.snapshot() }

    var previousProcessEvents: [DiagnosticsBreadcrumb] { previousEvents }

    func readoutValue(_ key: String) -> String {
        if key == DiagnosticsReadout.listenersKey { return "\(listenerCount)" }
        if key == DiagnosticsReadout.bufferKey { return "\(ring.count)" }
        if key == DiagnosticsReadout.openSpansKey { return "\(openSpans.count)" }
        return ""
    }

    func install() {
        installCallCount += 1
        guard listenerCount == 0 else { return }
        listenerCount = 1
        launchedAtMillis = hooks.wallMillis()
        if DiagnosticsBuild.isDebug && hooks.debugLaunchForcesRedactionFailure() {
            debugForcesRedactionFailure = true
        }
        hooks.installListeners(store)
        appendEvent(code: "app.launch", phase: "launch", kind: DiagnosticsEventKind.event, durationMillis: -1.0,
                    attempt: 0, detail: "")
        let store = self.store
        let now = launchedAtMillis
        Task { @MainActor in
            let previous = await Task.detached(priority: TaskPriority.utility) {
                store.launchHousekeeping(nowMillis: now)
            }.value
            self.adoptPrevious(previous)
        }
    }

    func adoptPrevious(_ file: DiagnosticsBreadcrumbFile?) {
        guard let file = file else { return }
        var clean: [DiagnosticsBreadcrumb] = []
        for event in file.events where DiagnosticsRedactionPolicy.isClean(event) {
            clean.append(event)
        }
        while clean.count > ring.capacity {
            clean.removeFirst()
        }
        previousEvents = clean
        previousWrittenAtMillis = file.writtenAtMillis
    }

    func applicationDidEnterBackground(completion: (() -> Void)? = nil) {
        appendEvent(code: "lifecycle.background", phase: currentPhase, kind: DiagnosticsEventKind.event,
                    durationMillis: -1.0, attempt: currentAttempt, detail: "")
        flush(completion: completion)
    }

    func flush(completion: (() -> Void)? = nil) {
        flushCount += 1
        let file = DiagnosticsBreadcrumbFile(version: DiagnosticsLimits.fileVersion, writtenAtMillis: hooks.wallMillis(),
                                             events: ring.snapshot())
        let store = self.store
        Task { @MainActor in
            _ = await Task.detached(priority: TaskPriority.utility) {
                store.writeBreadcrumbs(file)
            }.value
            completion?()
        }
    }

    func record(code: String, phase: String = "") {
        let safeCode = sanitizedCode(code)
        let safePhase = phase.isEmpty ? currentPhase : DiagnosticsRedactionPolicy.sanitizedPhase(phase)
        appendEvent(code: safeCode, phase: safePhase, kind: DiagnosticsEventKind.event, durationMillis: -1.0,
                    attempt: currentAttempt, detail: "")
        hooks.log(DiagnosticsRedactionPolicy.category(forCode: safeCode).rawValue, safeCode, safePhase)
    }

    func recordFailure(_ error: ClassifiedError) {
        let safeCode = sanitizedCode(error.diagnosticCode)
        appendEvent(code: safeCode, phase: currentPhase, kind: DiagnosticsEventKind.event, durationMillis: -1.0,
                    attempt: currentAttempt, detail: error.context.rawValue)
        hooks.log(DiagnosticsRedactionPolicy.category(forCode: safeCode).rawValue, safeCode, currentPhase)
    }

    @discardableResult
    func span(_ name: String, callSession: Int = -1) -> DiagnosticsSpanToken {
        guard DiagnosticsSpanKind(rawValue: name) != nil else {
            rejectedCount += 1
            return DiagnosticsSpanToken.inert
        }
        let session = callSession >= 0 ? callSession : currentAttempt
        if let existing = openSpans.first(where: { $0.kind == name && $0.callSession == session }) {
            return existing
        }
        if openSpans.count >= DiagnosticsLimits.maxOpenSpans {
            let dropped = openSpans.removeFirst()
            spanEndCount += 1
            hooks.endInterval(dropped.kind, dropped.id, dropped.callSession)
            appendEvent(code: "diag.spanDropped", phase: currentPhase, kind: DiagnosticsEventKind.event,
                        durationMillis: -1.0, attempt: dropped.callSession, detail: "span." + dropped.kind)
        }
        nextSpanId += 1
        let token = DiagnosticsSpanToken(id: nextSpanId, kind: name, callSession: session,
                                         startedAtMillis: hooks.monotonicMillis())
        openSpans.append(token)
        spanBeginCount += 1
        appendEvent(code: "span." + name, phase: currentPhase, kind: DiagnosticsEventKind.spanStart, durationMillis: -1.0,
                    attempt: session, detail: "")
        hooks.beginInterval(name, token.id, session)
        return token
    }

    @discardableResult
    func end(_ token: DiagnosticsSpanToken, code: String = "") -> Double {
        if token.isInert { return -1.0 }
        guard let index = openSpans.firstIndex(where: { $0.id == token.id }) else { return -1.0 }
        openSpans.remove(at: index)
        let elapsed = hooks.monotonicMillis() - token.startedAtMillis
        let duration = elapsed > 0.0 ? elapsed : 0.0
        let outcome = code.isEmpty ? "" : sanitizedCode(code)
        spanEndCount += 1
        appendEvent(code: "span." + token.kind, phase: currentPhase, kind: DiagnosticsEventKind.spanEnd,
                    durationMillis: duration, attempt: token.callSession, detail: outcome)
        hooks.endInterval(token.kind, token.id, token.callSession)
        return duration
    }

    func endOpen(_ kind: DiagnosticsSpanKind, code: String = "") {
        var matching: [DiagnosticsSpanToken] = []
        for candidate in openSpans where candidate.kind == kind.rawValue {
            matching.append(candidate)
        }
        for candidate in matching {
            end(candidate, code: code)
        }
    }

    func milestone(_ name: String, callSession: Int = -1, atMillis: Double = -1.0) {
        guard DiagnosticsMilestone(rawValue: name) != nil else {
            rejectedCount += 1
            return
        }
        let session = callSession >= 0 ? callSession : currentAttempt
        let at = atMillis >= 0.0 ? atMillis : hooks.monotonicMillis()
        var sinceJoin = -1.0
        if let join = openSpans.first(where: { $0.kind == DiagnosticsSpanKind.join.rawValue && $0.callSession == session }) {
            let elapsed = at - join.startedAtMillis
            sinceJoin = elapsed > 0.0 ? elapsed : 0.0
        }
        appendEvent(code: "join." + name, phase: currentPhase, kind: DiagnosticsEventKind.milestone,
                    durationMillis: sinceJoin, attempt: session, detail: "", atMillis: at)
        hooks.emitEvent(name, session)
    }

    func makePresenceAdapter() -> CallPresenceAdapter {
        presenceAdapterCount += 1
        return CallPresenceAdapter(name: "diagnostics", presenceDidChange: { [weak self] old, new in
            self?.presenceDidChange(from: old, to: new)
        })
    }

    func withPresenceAdapter(_ base: CallPresenceAdapters) -> CallPresenceAdapters {
        CallPresenceAdapters(base.adapters + [makePresenceAdapter()])
    }

    func presenceDidChange(from old: CallPresenceSnapshot, to new: CallPresenceSnapshot) {
        if new.callSession > 0 {
            currentAttempt = new.callSession
        }
        if old.phase != new.phase {
            currentPhase = new.phase.rawValue
            appendEvent(code: "phase." + new.phase.rawValue, phase: currentPhase, kind: DiagnosticsEventKind.event,
                        durationMillis: -1.0, attempt: currentAttempt, detail: "")
            hooks.processState(currentAttempt, currentPhase)
            applyPhaseSpans(new.phase, endReason: new.endReason)
        }
        if old.isInPictureInPicture != new.isInPictureInPicture {
            if new.isInPictureInPicture {
                span(DiagnosticsSpanKind.pip.rawValue, callSession: currentAttempt)
            } else {
                endOpen(DiagnosticsSpanKind.pip)
            }
        }
        if old.interruption != new.interruption && new.interruption != AudioInterruptionKind.none {
            record(code: "audio.interruption." + new.interruption.rawValue)
        }
        if old.surfaceStatus != new.surfaceStatus && new.surfaceStatus != CallSurfaceStatus.inactive {
            record(code: "call.surface." + new.surfaceStatus.rawValue)
        }
        if old.isMuted != new.isMuted && new.phase != CallPresencePhase.idle {
            record(code: new.isMuted ? "audio.muted" : "audio.unmuted")
        }
    }

    private func applyPhaseSpans(_ phase: CallPresencePhase, endReason: CallEndReason) {
        switch phase {
        case .connecting:
            span(DiagnosticsSpanKind.join.rawValue, callSession: currentAttempt)
        case .waiting:
            endOpen(DiagnosticsSpanKind.join, code: "join.waiting")
        case .live:
            endOpen(DiagnosticsSpanKind.join)
            endOpen(DiagnosticsSpanKind.recovery)
        case .recovering:
            span(DiagnosticsSpanKind.recovery.rawValue, callSession: currentAttempt)
        case .onHold:
            break
        case .ending:
            endOpen(DiagnosticsSpanKind.join, code: "join.abandoned")
            endOpen(DiagnosticsSpanKind.recovery, code: "recovery.abandoned")
            span(DiagnosticsSpanKind.cleanup.rawValue, callSession: currentAttempt)
        case .idle:
            endOpen(DiagnosticsSpanKind.cleanup)
            endOpen(DiagnosticsSpanKind.join, code: "join.failed")
            for kind in [DiagnosticsSpanKind.recovery, DiagnosticsSpanKind.pip, DiagnosticsSpanKind.mute,
                         DiagnosticsSpanKind.route] {
                endOpen(kind, code: "span.abandoned")
            }
            if endReason != CallEndReason.none {
                record(code: "call.end." + endReason.rawValue)
            }
        }
    }

    func exportRedacted() async throws -> URL {
        exportCount += 1
        let input = makeExportInput()
        let store = self.store
        let outcome = await Task.detached(priority: TaskPriority.userInitiated) {
            store.export(input)
        }.value
        if outcome.path.isEmpty {
            record(code: outcome.failure == DiagnosticsExportFailure.redactionCheckFailed ? "diag.exportRefused" : "diag.exportFailed")
            throw DiagnosticsExportError(failure: outcome.failure)
        }
        record(code: "diag.exported")
        return URL(fileURLWithPath: outcome.path)
    }

    func makeExportInput() -> DiagnosticsExportInput {
        let info = hooks.info()
        let safeInfo = DiagnosticsPlatformInfo(
            platform: DiagnosticsRedactionPolicy.sanitizedFieldText(info.platform),
            appVersion: DiagnosticsRedactionPolicy.sanitizedFieldText(info.appVersion),
            osVersion: DiagnosticsRedactionPolicy.sanitizedFieldText(info.osVersion),
            deviceClass: DiagnosticsRedactionPolicy.sanitizedFieldText(info.deviceClass)
        )
        var counters: [DiagnosticsCounter] = [
            DiagnosticsCounter(key: DiagnosticsReadout.listenersKey, value: Double(listenerCount)),
            DiagnosticsCounter(key: DiagnosticsReadout.bufferKey, value: Double(ring.count)),
            DiagnosticsCounter(key: DiagnosticsReadout.openSpansKey, value: Double(openSpans.count)),
            DiagnosticsCounter(key: "diag.dropped", value: Double(ring.droppedCount)),
            DiagnosticsCounter(key: "diag.rejected", value: Double(rejectedCount)),
            DiagnosticsCounter(key: "diag.flushes", value: Double(flushCount)),
        ]
        for counter in hooks.counters() {
            counters.append(counter)
        }
        let values = sensitiveValues?() ?? []
        return DiagnosticsExportInput(
            info: safeInfo,
            exportedAtMillis: hooks.wallMillis(),
            launchedAtMillis: launchedAtMillis,
            monotonicNowMillis: hooks.monotonicMillis(),
            events: ring.snapshot(),
            previousEvents: previousEvents,
            previousWrittenAtMillis: previousWrittenAtMillis,
            openSpans: openSpans,
            counters: counters,
            markers: DiagnosticsRedactionPolicy.markers(values),
            forcesRedactionFailure: debugForcesRedactionFailure && DiagnosticsBuild.isDebug
        )
    }

    func debugRecordClassifiedError() {
        guard DiagnosticsBuild.isDebug else { return }
        recordFailure(MeetingErrorClassifier.classify(serverMessage: "Request timed out", context: MeetingErrorContext.join))
    }

    func debugSimulateHang(milliseconds: Int) {
        guard DiagnosticsBuild.isDebug, milliseconds > 0 else { return }
        record(code: "test.hang")
        hooks.debugBlockMainThread(milliseconds)
    }

    private func sanitizedCode(_ code: String) -> String {
        if DiagnosticsRedactionPolicy.isAllowedCode(code) { return code }
        rejectedCount += 1
        return DiagnosticsRedactionPolicy.rejectedCode
    }

    private func appendEvent(code: String, phase: String, kind: DiagnosticsEventKind, durationMillis: Double, attempt: Int,
                             detail: String, atMillis: Double = -1.0) {
        let at = atMillis >= 0.0 ? atMillis : hooks.monotonicMillis()
        let duration = durationMillis < 0.0 ? -1.0 : durationMillis.rounded()
        let safeDetail = DiagnosticsRedactionPolicy.isAllowedDetail(detail) ? detail : ""
        ring.append(DiagnosticsBreadcrumb(code: code, phase: phase, kind: kind.rawValue, atMillis: at.rounded(),
                                          attempt: attempt, durationMillis: duration, detail: safeDetail))
    }
}
