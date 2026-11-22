#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct CrashReportingTests {
    final class RecordingTransport: CrashReportTransport {
        var bodies: [String] = []
        var endpoints: [String] = []
        var succeeds = true
        var onSend: (() async -> Void)? = nil

        func send(endpoint: String, body: String) async -> Bool {
            endpoints.append(endpoint)
            bodies.append(body)
            await onSend?()
            return succeeds
        }
    }

    /// The store's clock, an hour after the fixed capture times below, so retention never depends on today's date.
    static let storeNow = 1_795_000_000_000.0 + 3_600_000.0

    /// The compiled-class manifest the Android build would write for the classes these tests name.
    static let compiledClasses: Set<String> = [
        "conclave.module.WebRTCClient\tWebRTCClient+Android.kt", "conclave.module.MeetingViewModel\tMeetingViewModel.kt",
    ]

    init() {
        CrashReportPrivacy.isCompiledAppClass = { Self.compiledClasses.contains($0) }
    }

    static let context = CrashReportContext(installId: "install-1", platform: "android", appVersion: "2.0.0 (64)",
                                            osVersion: "Android 16 (API 36)", deviceClass: "phone")

    private func temporaryStore() -> DiagnosticsFileStore {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("crash-" + UUID().uuidString, isDirectory: true)
        return DiagnosticsFileStore(directoryPath: base.appendingPathComponent("store").path,
                                    exportDirectoryPath: base.appendingPathComponent("exports").path,
                                    wallClock: { Self.storeNow })
    }

    private func config(key: String = "phc_test", host: String = "https://eu.i.posthog.com", debug: Bool = false,
                        optIn: Bool = false, allows: Bool = true) -> CrashReportingConfig {
        CrashReportingConfig(projectKey: key, host: host, isDebugBuild: debug, debugOptIn: optIn, userAllows: allows)
    }

    private func json(_ text: String) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    private func crashPayload(createdAtMillis: Double = 1_795_000_000_000) -> DiagnosticsStoredPayload {
        CrashCaptureRecord.payload(
            exceptions: [
                CrashReportException(type: "java.lang.IllegalStateException", frames: [
                    CrashReportFrame(function: "startProducingAudio", module: "conclave.module.WebRTCClient",
                                     filename: "WebRTCClient+Android.kt", line: 2140, inApp: true, classFrame: true),
                    CrashReportFrame(function: "invokeSuspend", module: "conclave.module.MeetingViewModel",
                                     filename: "MeetingViewModel.kt", line: 361, inApp: true, classFrame: true),
                ]),
                CrashReportException(type: "java.io.IOException", frames: []),
            ],
            breadcrumbs: ["join.socketConnected", "not a code", "audio.unmuted"],
            phase: "live",
            createdAtMillis: createdAtMillis
        )
    }

    private func exitRecord(_ reason: String, trace: String = "") -> DiagnosticsStoredPayload {
        DiagnosticsPayloadFactory.exitRecord(reason: reason, timestampMillis: 1_795_000_000_000, importance: 100, status: 0,
                                             pssKb: 0.0, rssKb: 0.0, summarySession: 2, summaryPhase: "connecting",
                                             traceJSON: trace)
    }

    @Test func reportsLeaveTheDeviceOnlyWithAKeyConsentAndAReleaseOrOptedInDebugBuild() {
        #expect(CrashReportingPolicy.endpoint(config()) == "https://eu.i.posthog.com/batch/")
        #expect(CrashReportingPolicy.endpoint(config(host: "https://eu.i.posthog.com/")) == "https://eu.i.posthog.com/batch/")
        #expect(CrashReportingPolicy.endpoint(config(host: "")) == "https://eu.i.posthog.com/batch/")
        #expect(CrashReportingPolicy.endpoint(config(key: "")) == nil)
        #expect(CrashReportingPolicy.endpoint(config(key: "  ")) == nil)
        #expect(CrashReportingPolicy.endpoint(config(allows: false)) == nil)
        #expect(CrashReportingPolicy.endpoint(config(debug: true)) == nil)
        #expect(CrashReportingPolicy.endpoint(config(debug: true, optIn: true)) == "https://eu.i.posthog.com/batch/")
        #expect(CrashReportingPolicy.endpoint(config(host: "http://10.0.2.2:4790")) == nil)
        #expect(CrashReportingPolicy.endpoint(config(host: "http://10.0.2.2:4790", debug: true, optIn: true))
                == "http://10.0.2.2:4790/batch/")
        #expect(CrashReportingPolicy.endpoint(config(host: "ftp://example.com")) == nil)
    }

    @Test func anUncaughtCrashBecomesAPostHogExceptionWithoutPersonalData() throws {
        let text = try #require(CrashReportEventBuilder.event(
            for: crashPayload(),
            eventId: CrashReportEventBuilder.eventId(forPayloadName: "payload-6B3F1C2A-1B2C-4D5E-8F90-0123456789AB.json"),
            context: Self.context
        ))
        let event = try json(text)
        #expect(event["event"] as? String == "$exception")
        #expect(event["uuid"] as? String == "6b3f1c2a-1b2c-4d5e-8f90-0123456789ab")
        #expect(event["distinct_id"] as? String == "install-1")
        #expect(event["timestamp"] as? String == DiagnosticsTimePolicy.iso8601(epochMillis: 1_795_000_000_000))
        let properties = try #require(event["properties"] as? [String: Any])
        #expect(properties["$process_person_profile"] as? Bool == false)
        #expect(properties["$geoip_disable"] as? Bool == true)
        #expect(properties["$exception_level"] as? String == "fatal")
        #expect(properties["$os"] as? String == "Android")
        #expect(properties["call_phase"] as? String == "live")
        #expect(properties["breadcrumbs"] as? [String] == ["join.socketConnected", "audio.unmuted"])
        let exceptions = try #require(properties["$exception_list"] as? [[String: Any]])
        #expect(exceptions.count == 2)
        #expect(exceptions[0]["type"] as? String == "java.lang.IllegalStateException")
        #expect(exceptions[0]["value"] as? String == "")
        #expect(exceptions[1]["type"] as? String == "java.io.IOException")
        let stack = try #require(exceptions[0]["stacktrace"] as? [String: Any])
        let frames = try #require(stack["frames"] as? [[String: Any]])
        #expect(frames.map { $0["function"] as? String } == ["invokeSuspend", "startProducingAudio"])
        #expect(frames[1]["lineno"] as? Int == 2140)
        #expect(frames[1]["module"] as? String == "conclave.module.WebRTCClient")
        #expect(frames[1]["lang"] as? String == "java")
        #expect(frames[1]["in_app"] as? Bool == true)
    }

    @Test func anAnrBecomesAFreezeExceptionWithTheMainThreadStack() throws {
        let trace = """
        {"traceLines":["\\"Signal Catcher\\" daemon prio=10 tid=2 Runnable","at java.lang.Object.wait(Native Method)",\
        "\\"main\\" prio=5 tid=1 Blocked","at kotlinx.coroutines.BlockingCoroutine.joinBlocking(Builders.kt:122)",\
        "at conclave.module.WebRTCClient.onProduce(WebRTCClient+Android.kt:7216)","native: #00 pc 000000 /system/lib64/libc.so (syscall+28)",\
        "\\"RenderThread\\" prio=7 tid=12 Native","at android.view.ThreadedRenderer.nSyncAndDrawFrame(Native Method)"]}
        """
        let text = try #require(CrashReportEventBuilder.event(for: exitRecord("anr", trace: trace), eventId: "id-1",
                                                               context: Self.context))
        let properties = try #require(try json(text)["properties"] as? [String: Any])
        #expect(properties["$exception_level"] as? String == "fatal")
        #expect(properties["call_phase"] as? String == "connecting")
        #expect(properties["diag_reason"] as? String == "anr")
        let exception = try #require((properties["$exception_list"] as? [[String: Any]])?.first)
        #expect(exception["type"] as? String == "ApplicationNotResponding")
        #expect((exception["mechanism"] as? [String: Any])?["type"] as? String == "freeze")
        let frames = try #require((exception["stacktrace"] as? [String: Any])?["frames"] as? [[String: Any]])
        #expect(frames.map { $0["function"] as? String } == ["?", "?", "?"])
        #expect(frames[0]["module"] as? String == "libc.so")
        #expect(frames[1]["filename"] as? String == "WebRTCClient+Android.kt" && frames[1]["lineno"] as? Int == 7216)
        #expect(frames[1]["in_app"] as? Bool == true && frames[2]["in_app"] as? Bool == false)
    }

    @Test func exitReasonsMapToReportsOnlyWhenTheyAreFailures() throws {
        #expect(CrashReportEventBuilder.kind(of: exitRecord("crashNative")) == .nativeCrash)
        #expect(CrashReportEventBuilder.kind(of: exitRecord("anr")) == .appNotResponding)
        #expect(CrashReportEventBuilder.kind(of: exitRecord("lowMemory")) == .appExit)
        #expect(CrashReportEventBuilder.kind(of: exitRecord("crash")) == .appExit)
        for normal in ["userRequested", "exitSelf", "userStopped", "packageUpdated"] {
            #expect(CrashReportEventBuilder.event(for: exitRecord(normal), eventId: "id", context: Self.context) == nil, "\(normal)")
        }
        let native = try json(try #require(CrashReportEventBuilder.event(for: exitRecord("crashNative"), eventId: "id",
                                                                          context: Self.context)))
        let nativeException = (native["properties"] as? [String: Any])?["$exception_list"] as? [[String: Any]]
        #expect(nativeException?.first?["type"] as? String == "NativeCrash")
        let lowMemory = try json(try #require(CrashReportEventBuilder.event(for: exitRecord("lowMemory"), eventId: "id",
                                                                             context: Self.context)))
        #expect(lowMemory["event"] as? String == "native_app_exit")
    }

    @Test func aMetricKitSignalCrashKeepsTheCrashedThreadsFrames() throws {
        let tree = """
        {"callStackPerThread":true,"callStacks":[\
        {"threadAttributed":false,"callStackRootFrames":[{"binaryName":"libsystem_kernel.dylib","offsetIntoBinaryTextSegment":10}]},\
        {"threadAttributed":true,"callStackRootFrames":[{"binaryName":"Conclave","offsetIntoBinaryTextSegment":4096,\
        "subFrames":[{"binaryName":"SwiftUI","offsetIntoBinaryTextSegment":77}]}]}]}
        """
        let payload = DiagnosticsPayloadFactory.payload(kind: .crash, createdAtMillis: 1_795_000_000_000,
                                                        fields: [DiagnosticsPayloadFactory.number("signal", 5.0)],
                                                        detailJSON: tree)
        let ios = CrashReportContext(installId: "install-2", platform: "ios", appVersion: "2.0.0 (64)", osVersion: "iOS 26.1",
                                     deviceClass: "phone")
        let text = try #require(CrashReportEventBuilder.event(for: payload, eventId: "id", context: ios))
        let event = try json(text)
        let properties = try #require(event["properties"] as? [String: Any])
        let exception = try #require((properties["$exception_list"] as? [[String: Any]])?.first)
        #expect(exception["type"] as? String == "Signal5")
        let frames = try #require((exception["stacktrace"] as? [String: Any])?["frames"] as? [[String: Any]])
        #expect(frames.map { $0["function"] as? String } == ["SwiftUI + 77", "Conclave + 4096"])
        #expect(frames[1]["in_app"] as? Bool == true && frames[1]["lang"] as? String == "swift")
    }

    @Test func iOSExceptionFramesComeFromTheDynamicLinkerNotSymbolText() {
        let frames = CrashCaptureRecord.addressFrames(Thread.callStackReturnAddresses)
        #expect(frames.count >= 2)
        #expect(frames.allSatisfy { $0.module == "[path]" || CrashReportPrivacy.isKnownModule($0.module) })
        #expect(frames.contains { CrashReportPrivacy.isKnownModule($0.module) && $0.function != "?" })
        let unresolved = CrashCaptureRecord.addressFrames([NSNumber(value: 1)])
        #expect(unresolved.map { $0.function } == ["?"] && unresolved.map { $0.module } == ["[path]"])
    }

    @Test func plannerSkipsReportedAndUnreportablePayloadsAndBatchesTheRest() {
        var loaded: [DiagnosticsLoadedPayload] = []
        for index in 0..<25 {
            loaded.append(DiagnosticsLoadedPayload(name: "payload-\(index).json", byteCount: 10, payload: crashPayload()))
        }
        loaded.append(DiagnosticsLoadedPayload(name: "payload-normal.json", byteCount: 10, payload: exitRecord("userRequested")))
        let plan = CrashReportPlanner.plan(loaded, reported: ["payload-0.json", "payload-1.json"], projectKey: "phc_test",
                                           context: Self.context)
        #expect(plan.batches.map { $0.names.count } == [20, 3])
        #expect(!plan.batches[0].names.contains("payload-0.json"))
        #expect(plan.skipped == ["payload-normal.json"])
        #expect(plan.batches[0].body.contains("\"api_key\": \"phc_test\""))
    }

    @Test func eachStoredReportIsSentOnceAndAFailedUploadRetriesLater() async throws {
        let store = temporaryStore()
        #expect(store.writePayload(crashPayload()))
        #expect(store.writePayload(exitRecord("anr")))
        #expect(store.writePayload(exitRecord("userRequested")))
        let uploader = CrashReportUploader()
        let transport = RecordingTransport()
        transport.succeeds = false

        #expect(await uploader.upload(store: store, config: config(), context: Self.context, transport: transport) == 0)
        #expect(transport.bodies.count == 1)

        transport.succeeds = true
        #expect(await uploader.upload(store: store, config: config(), context: Self.context, transport: transport) == 2)
        #expect(transport.endpoints.last == "https://eu.i.posthog.com/batch/")
        let batch = try json(try #require(transport.bodies.last))
        let events = try #require(batch["batch"] as? [[String: Any]])
        #expect(Set(events.compactMap { $0["event"] as? String }) == ["$exception"])
        #expect(CrashReportLedger(store: store).reportedNames().count == 3)

        #expect(await uploader.upload(store: store, config: config(), context: Self.context, transport: transport) == 0)
        #expect(transport.bodies.count == 2)

        #expect(store.writePayload(crashPayload()))
        #expect(await uploader.upload(store: store, config: config(allows: false), context: Self.context,
                                      transport: transport) == 0)
        #expect(transport.bodies.count == 2)
        #expect(await uploader.upload(store: store, config: config(), context: Self.context, transport: transport) == 1)
        #expect(store.loadPayloads().count == 4)
    }

    @Test func turningReportsOffMidUploadStopsTheNextBatch() async throws {
        let store = temporaryStore()
        for _ in 0..<25 {
            #expect(store.writePayload(crashPayload()))
        }
        let uploader = CrashReportUploader()
        let transport = RecordingTransport()
        var allowed = true
        transport.onSend = { allowed = false }
        #expect(await uploader.upload(store: store, config: config(), context: Self.context, transport: transport,
                                      allowsSending: { allowed }) == 20)
        #expect(transport.bodies.count == 1)
        #expect(CrashReportLedger(store: store).reportedNames().count == 20)
    }

    @Test func aReportStoredDuringAnUploadGoesOutInTheSameRun() async throws {
        let store = temporaryStore()
        #expect(store.writePayload(crashPayload()))
        let uploader = CrashReportUploader()
        let transport = RecordingTransport()
        transport.onSend = {
            transport.onSend = nil
            #expect(store.writePayload(self.exitRecord("anr")))
            #expect(await uploader.upload(store: store, config: self.config(), context: Self.context, transport: transport) == 0)
        }
        #expect(await uploader.upload(store: store, config: config(), context: Self.context, transport: transport) == 2)
        #expect(transport.bodies.count == 2)
    }

    @Test func uploadsKeepOnlyKnownTextFieldsAndCodeSymbols() throws {
        let payload = DiagnosticsPayloadFactory.payload(
            kind: .crash, createdAtMillis: 1_795_000_000_000,
            fields: [
                try #require(DiagnosticsPayloadFactory.text("exceptionName", "NSInvalidArgumentException")),
                try #require(DiagnosticsPayloadFactory.text("roomLabel", "Alice weekly sync")),
                DiagnosticsPayloadFactory.number("signal", 6.0),
            ],
            detailJSON: CrashCaptureRecord.detailJSON(
                exceptions: [CrashReportException(type: "java.lang.IllegalStateException\n\"quoted\"", frames: [
                    CrashReportFrame(function: "load", module: "/data/user/0/com.acmvit.conclave/files/Alice/x.so",
                                     filename: "", line: 0, inApp: false),
                ])],
                breadcrumbs: [], phase: "live")
        )
        let text = try #require(CrashReportEventBuilder.event(for: payload, eventId: "id", context: Self.context))
        let properties = try #require(try json(text)["properties"] as? [String: Any])
        #expect(properties["diag_exceptionName"] as? String == "NSInvalidArgumentException")
        #expect(properties["diag_signal"] as? Int == 6)
        #expect(properties["diag_roomLabel"] == nil)
        #expect(!text.contains("Alice weekly") && !text.contains("/data/user"))
        let exception = try #require((properties["$exception_list"] as? [[String: Any]])?.first)
        #expect(exception["type"] as? String == "java.lang.IllegalStateExceptionquoted")
        let frame = try #require(((exception["stacktrace"] as? [String: Any])?["frames"] as? [[String: Any]])?.first)
        #expect(frame["module"] as? String == "[path]")
    }

    @Test func pathsKeepOnlyFileNamesAndDropDirectories() {
        #expect(CrashReportPrivacy.symbol("#00 pc 000000 /system/lib64/libc.so (syscall+28)") == "#00 pc 000000 libc.so")
        #expect(CrashReportPrivacy.symbol("at (/Users/Jane Doe/private/notes") == "at ([path]")
        #expect(!CrashReportPrivacy.symbol("load /Users/Jane").contains("Jane"))
        #expect(CrashReportPrivacy.symbol("conclave.module.WebRTCClient$onProduce$1") == "conclave.module.WebRTCClient$onProduce$1")
    }

    /// The raise site and its callers, as the dynamic linker names them: Conclave frames at these image offsets.
    static let raiseStack = [0x1000, 0x2000]

    private func uncaughtObjectiveCCrash(atMillis: Double, stack: [Int] = raiseStack) -> DiagnosticsStoredPayload {
        var frames: [CrashReportFrame] = [
            CrashReportFrame(function: "__exceptionPreprocess", module: "CoreFoundation", filename: "", line: 0, inApp: false,
                             address: "0x51a8"),
        ]
        for offset in stack {
            frames.append(CrashReportFrame(function: "-[ConclaveRoom join]", module: "Conclave", filename: "", line: 0,
                                           inApp: true, address: "0x" + String(offset, radix: 16)))
        }
        return CrashCaptureRecord.payload(
            exceptions: [CrashReportException(type: "NSInvalidArgumentException", frames: frames)],
            breadcrumbs: [], phase: "live", createdAtMillis: atMillis, appVersion: "2.0.0 (63)"
        )
    }

    /// MetricKit's crash stack: the terminate path in system frames, then the same app frames.
    private func metricKitTree(_ stack: [Int]) throws -> String {
        var frame: [String: Any]? = nil
        for offset in stack.reversed() {
            var next: [String: Any] = ["binaryName": "Conclave", "offsetIntoBinaryTextSegment": offset]
            if let frame { next["subFrames"] = [frame] }
            frame = next
        }
        for (binary, offset) in [("libc++abi.dylib", 0x9f10), ("libsystem_kernel.dylib", 0x1234)] {
            var next: [String: Any] = ["binaryName": binary, "offsetIntoBinaryTextSegment": offset]
            if let frame { next["subFrames"] = [frame] }
            frame = next
        }
        let tree: [String: Any] = ["callStacks": [["threadAttributed": true, "callStackRootFrames": [frame ?? [:]]]]]
        return String(decoding: try JSONSerialization.data(withJSONObject: tree), as: UTF8.self)
    }

    private func metricKitCrash(name: String, windowStart: Double, delivered: Double, build: String = "63",
                                stack: [Int] = raiseStack) throws -> DiagnosticsStoredPayload {
        DiagnosticsPayloadFactory.payload(
            kind: .crash, createdAtMillis: delivered,
            fields: [
                try #require(DiagnosticsPayloadFactory.text("exceptionName", name)),
                DiagnosticsPayloadFactory.number("signal", 6.0),
                DiagnosticsPayloadFactory.number("windowStartMillis", windowStart),
                try #require(DiagnosticsPayloadFactory.text("appVersion", "2.0.0")),
                try #require(DiagnosticsPayloadFactory.text("appBuild", build)),
            ],
            detailJSON: try metricKitTree(stack)
        )
    }

    private func exceptionTypes(_ plan: CrashReportPlan) throws -> [String] {
        var types: [String] = []
        for batch in plan.batches {
            let body = try json(batch.body)
            for event in body["batch"] as? [[String: Any]] ?? [] {
                let properties = event["properties"] as? [String: Any]
                let list = properties?["$exception_list"] as? [[String: Any]]
                types.append(list?.first?["type"] as? String ?? "")
            }
        }
        return types
    }

    @Test func anObjectiveCCrashThatMetricKitReportsAgainUploadsOnce() throws {
        let crashAt = 1_795_000_000_000.0
        let loaded = [
            DiagnosticsLoadedPayload(name: "payload-uncaught.json", byteCount: 10, payload: uncaughtObjectiveCCrash(atMillis: crashAt)),
            DiagnosticsLoadedPayload(name: "payload-metrickit.json", byteCount: 10,
                                     payload: try metricKitCrash(name: "NSInvalidArgumentException", windowStart: crashAt - 3_600_000,
                                                                 delivered: crashAt + 7_200_000)),
        ]
        let plan = CrashReportPlanner.plan(loaded, reported: [], projectKey: "phc_test", context: Self.context)
        #expect(try exceptionTypes(plan) == ["NSInvalidArgumentException"])
        #expect(plan.skipped.isEmpty && plan.duplicates == ["payload-metrickit.json"])

        let alreadySent = CrashReportPlanner.plan(loaded, reported: ["payload-uncaught.json"], projectKey: "phc_test",
                                                  context: Self.context)
        #expect(alreadySent.batches.isEmpty && alreadySent.skipped.isEmpty && alreadySent.duplicates == ["payload-metrickit.json"])
    }

    /// Two crashes can share the exception name, build and window; only the same app frames make one a repeat, and a
    /// stack that cannot be compared never deletes anything.
    @Test func aMetricKitCrashWithADifferentStackIsNotARepeat() async throws {
        let crashAt = 1_795_000_000_000.0
        let otherStack = CrashReportPlanner.plan([
            DiagnosticsLoadedPayload(name: "payload-uncaught.json", byteCount: 10, payload: uncaughtObjectiveCCrash(atMillis: crashAt)),
            DiagnosticsLoadedPayload(name: "payload-other.json", byteCount: 10,
                                     payload: try metricKitCrash(name: "NSInvalidArgumentException", windowStart: crashAt - 3_600_000,
                                                                 delivered: crashAt + 7_200_000, stack: [0x3000, 0x2000])),
        ], reported: [], projectKey: "phc_test", context: Self.context)
        #expect(try exceptionTypes(otherStack).count == 2 && otherStack.duplicates.isEmpty)

        let noAppFrames = CrashReportPlanner.plan([
            DiagnosticsLoadedPayload(name: "payload-uncaught.json", byteCount: 10, payload: uncaughtObjectiveCCrash(atMillis: crashAt,
                                                                                                                    stack: [])),
            DiagnosticsLoadedPayload(name: "payload-bare.json", byteCount: 10,
                                     payload: try metricKitCrash(name: "NSInvalidArgumentException", windowStart: crashAt - 3_600_000,
                                                                 delivered: crashAt + 7_200_000, stack: [])),
        ], reported: [], projectKey: "phc_test", context: Self.context)
        #expect(try exceptionTypes(noAppFrames).count == 2 && noAppFrames.duplicates.isEmpty)

        let store = temporaryStore()
        #expect(store.writePayload(uncaughtObjectiveCCrash(atMillis: crashAt)))
        #expect(store.writePayload(try metricKitCrash(name: "NSInvalidArgumentException", windowStart: crashAt - 3_600_000,
                                                      delivered: crashAt + 7_200_000, stack: [0x3000, 0x2000])))
        #expect(await CrashReportUploader().upload(store: store, config: config(), context: Self.context,
                                                   transport: RecordingTransport()) == 2)
        #expect(store.loadPayloads().count == 2)
    }

    /// Java and Kotlin frames keep our own class and file only when the compiled app lists that exact pair; a system
    /// class drops to its exact package, and anything else becomes `[path]` with function `?`.
    @Test func classFramesKeepOnlyCompiledClassesAndExactSystemPackages() throws {
        func scrub(_ module: String, _ filename: String, function: String = "start") -> CrashReportFrame {
            CrashReportPrivacy.frame(CrashReportFrame(function: function, module: module, filename: filename, line: 7,
                                                      inApp: module.hasPrefix("conclave."), classFrame: true))
        }
        let own = scrub("conclave.module.WebRTCClient", "WebRTCClient+Android.kt", function: "onProduce")
        #expect(own.module == "conclave.module.WebRTCClient" && own.filename == "WebRTCClient+Android.kt" && own.function == "onProduce")
        for (module, filename) in [("conclave.PrivateRoomCedar", "DeviceCedar.kt"), ("conclave.module.WebRTCClient", "DeviceCedar.kt"),
                                   ("conclave.PrivateRoomCedar", "WebRTCClient+Android.kt"), ("skip.ui.Jane", "Jane.kt"),
                                   ("conclave.module.WebRTCClient", ""), ("android.Jane.Smith", "Smith.java"),
                                   ("com.google.DeviceCedar", "DeviceCedar.java"), ("Jane", "Jane.kt")] {
            let frame = scrub(module, filename)
            #expect(frame.module == "[path]" && frame.filename.isEmpty && frame.function == "?", "\(module) \(filename)")
        }
        let system = scrub("android.os.Handler$Callback", "Handler.java", function: "dispatchMessage")
        #expect(system.module == "android.os" && system.filename.isEmpty && system.function == "dispatchMessage")

        let trace = try JSONSerialization.data(withJSONObject: ["traceLines": [
            "\"main\" prio=5 tid=1 Blocked", "at conclave.PrivateRoomCedar.start(DeviceCedar.kt:1)",
            "at java.lang.Thread.run(Thread.java:1012)",
        ]])
        let text = try #require(CrashReportEventBuilder.event(for: exitRecord("anr", trace: String(decoding: trace, as: UTF8.self)),
                                                               eventId: "id-1", context: Self.context))
        #expect(!text.contains("Cedar") && !text.contains("PrivateRoom") && !text.contains("Thread.java"))
        #expect(text.contains("java.lang"))
    }

    /// MetricKit names a binary by its image name; one that is not a known module never reaches the endpoint, even
    /// when it looks like a Java package.
    @Test func unknownMetricKitBinariesNeverUpload() throws {
        let names = ["com.google.UserPrivate.dylib", "com.google.DeviceCedar.dylib", "conclave.Jane.dylib", "android.Jane Smith",
                     "java.private.Notes", "Jane.framework", "libsystem_Jane.dylib"]
        var frame: [String: Any] = ["binaryName": "Conclave", "offsetIntoBinaryTextSegment": 0x1000]
        for name in names.reversed() {
            frame = ["binaryName": name, "offsetIntoBinaryTextSegment": 0x10, "subFrames": [frame]]
        }
        let tree: [String: Any] = ["callStacks": [["threadAttributed": true, "callStackRootFrames": [frame]]]]
        let hang = DiagnosticsPayloadFactory.payload(kind: .hang, createdAtMillis: 1_795_000_000_000,
                                                     fields: [], detailJSON: String(decoding: try JSONSerialization.data(withJSONObject: tree),
                                                                                    as: UTF8.self))
        let text = try #require(CrashReportEventBuilder.event(for: hang, eventId: "id", context: Self.context))
        for leaked in ["UserPrivate", "DeviceCedar", "Cedar", "Jane", "Smith", "private", "Notes", "com.google", "conclave.Jane"] {
            #expect(!text.contains(leaked), "\(leaked)")
        }
        let frames = CrashReportEventBuilder.metricKitFrames(try #require(
            try JSONSerialization.jsonObject(with: try JSONSerialization.data(withJSONObject: tree)) as? [String: Any]))
        #expect(frames.prefix(names.count).allSatisfy { $0.module == "[path]" && $0.function == "[path] + 16" })
        #expect(frames.last?.module == "Conclave")
    }

    /// A MetricKit crash from another build with the same exception inside the window is a different crash, and a
    /// repeat that dedupe holds back is never recorded as sent.
    @Test func aMetricKitCrashFromAnotherBuildUploadsAndARepeatIsNeverRecordedAsSent() async throws {
        let crashAt = 1_795_000_000_000.0
        let loaded = [
            DiagnosticsLoadedPayload(name: "payload-uncaught.json", byteCount: 10, payload: uncaughtObjectiveCCrash(atMillis: crashAt)),
            DiagnosticsLoadedPayload(name: "payload-build64.json", byteCount: 10,
                                     payload: try metricKitCrash(name: "NSInvalidArgumentException", windowStart: crashAt - 3_600_000,
                                                                 delivered: crashAt + 7_200_000, build: "64")),
        ]
        let plan = CrashReportPlanner.plan(loaded, reported: [], projectKey: "phc_test", context: Self.context)
        #expect(try exceptionTypes(plan) == ["NSInvalidArgumentException", "NSInvalidArgumentException"])

        let store = temporaryStore()
        #expect(store.writePayload(uncaughtObjectiveCCrash(atMillis: crashAt)))
        #expect(store.writePayload(try metricKitCrash(name: "NSInvalidArgumentException", windowStart: crashAt - 3_600_000,
                                                      delivered: crashAt + 7_200_000)))
        let transport = RecordingTransport()
        #expect(await CrashReportUploader().upload(store: store, config: config(), context: Self.context,
                                                   transport: transport) == 1)
        let remaining = store.loadPayloads()
        #expect(remaining.count == 1 && CrashReportEventBuilder.numberField(remaining[0].payload, "uncaught") == 1.0)
        #expect(CrashReportLedger(store: store).reportedNames() == [remaining[0].name])
    }

    @Test func aDifferentOrLaterMetricKitCrashStillUploads() throws {
        let crashAt = 1_795_000_000_000.0
        let loaded = [
            DiagnosticsLoadedPayload(name: "payload-uncaught.json", byteCount: 10, payload: uncaughtObjectiveCCrash(atMillis: crashAt)),
            DiagnosticsLoadedPayload(name: "payload-other.json", byteCount: 10,
                                     payload: try metricKitCrash(name: "NSRangeException", windowStart: crashAt - 3_600_000,
                                                                 delivered: crashAt + 7_200_000)),
            DiagnosticsLoadedPayload(name: "payload-later.json", byteCount: 10,
                                     payload: try metricKitCrash(name: "NSInvalidArgumentException", windowStart: crashAt + 60_000,
                                                                 delivered: crashAt + 7_200_000)),
        ]
        let plan = CrashReportPlanner.plan(loaded, reported: [], projectKey: "phc_test", context: Self.context)
        #expect(try exceptionTypes(plan).count == 3)
        #expect(plan.skipped.isEmpty)
    }

    final class TestClock: @unchecked Sendable {
        var now: Double
        init(now: Double) { self.now = now }
    }

    /// Dedupe has to outlive the original: once the uncaught record expires and is pruned, its MetricKit repeat must
    /// still not upload as a second crash.
    @Test func aDeduplicatedRepeatNeverUploadsAfterItsOriginalExpires() async throws {
        let crashAt = 1_795_000_000_000.0
        let clock = TestClock(now: crashAt + 3 * 3_600_000)
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("crash-" + UUID().uuidString, isDirectory: true)
        let store = DiagnosticsFileStore(directoryPath: base.appendingPathComponent("store").path,
                                         exportDirectoryPath: base.appendingPathComponent("exports").path,
                                         wallClock: { clock.now })
        #expect(store.writePayload(uncaughtObjectiveCCrash(atMillis: crashAt)))
        #expect(store.writePayload(try metricKitCrash(name: "NSInvalidArgumentException", windowStart: crashAt - 3_600_000,
                                                      delivered: crashAt + 7_200_000)))
        let uploader = CrashReportUploader()
        let transport = RecordingTransport()
        #expect(await uploader.upload(store: store, config: config(), context: Self.context, transport: transport) == 1)

        clock.now = crashAt + 7.0 * 24.0 * 3_600_000 + 3_600_000
        store.prune(nowMillis: clock.now)
        #expect(await uploader.upload(store: store, config: config(), context: Self.context, transport: transport) == 0)
        #expect(transport.bodies.count == 1)
    }

    /// MetricKit can deliver a week or more later. Once the original was sent and pruned, a matching copy that arrives
    /// afterwards is still recognized from the sent-signature ledger, deleted, and never sent.
    @Test func aMetricKitCopyArrivingAfterItsOriginalWasPrunedNeverUploads() async throws {
        let crashAt = 1_795_000_000_000.0
        let clock = TestClock(now: crashAt + 3_600_000)
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("crash-" + UUID().uuidString, isDirectory: true)
        let store = DiagnosticsFileStore(directoryPath: base.appendingPathComponent("store").path,
                                         exportDirectoryPath: base.appendingPathComponent("exports").path,
                                         wallClock: { clock.now })
        #expect(store.writePayload(uncaughtObjectiveCCrash(atMillis: crashAt)))
        let uploader = CrashReportUploader()
        let transport = RecordingTransport()
        #expect(await uploader.upload(store: store, config: config(), context: Self.context, transport: transport) == 1)

        clock.now = crashAt + 7.0 * 24.0 * 3_600_000 + 3_600_000
        store.prune(nowMillis: clock.now)
        #expect(store.loadPayloads().isEmpty)
        #expect(store.writePayload(try metricKitCrash(name: "NSInvalidArgumentException", windowStart: crashAt - 3_600_000,
                                                      delivered: clock.now)))
        #expect(await uploader.upload(store: store, config: config(), context: Self.context, transport: transport) == 0)
        #expect(transport.bodies.count == 1)
        #expect(store.loadPayloads().isEmpty)

        clock.now = crashAt + 31.0 * 24.0 * 3_600_000
        #expect(CrashSignatureLedger(store: store).entries().isEmpty)
    }

    /// Retention holds with no further crash: launch housekeeping removes expired signatures from disk, and a read
    /// rewrites the file without them.
    @Test func expiredCrashSignaturesLeaveTheDiskAtLaunch() throws {
        let crashAt = 1_795_000_000_000.0
        let clock = TestClock(now: crashAt)
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("crash-" + UUID().uuidString, isDirectory: true)
        let store = DiagnosticsFileStore(directoryPath: base.appendingPathComponent("store").path,
                                         exportDirectoryPath: base.appendingPathComponent("exports").path,
                                         wallClock: { clock.now })
        let ledgerFile = store.fileURL(CrashSignatureLedger.fileName).path
        let old = CrashSignatureEntry(name: "NSInvalidArgumentException", release: "2.0.0 (63)", stack: "Conclave@0x1000",
                                      crashedAtMillis: crashAt)
        let recent = CrashSignatureEntry(name: "NSRangeException", release: "2.0.0 (63)", stack: "Conclave@0x2000",
                                         crashedAtMillis: crashAt + 20.0 * 24.0 * 3_600_000)
        #expect(CrashSignatureLedger(store: store).record([old]))
        #expect(FileManager.default.fileExists(atPath: ledgerFile))

        let launchAt = crashAt + 31.0 * 24.0 * 3_600_000
        _ = store.launchHousekeeping(nowMillis: launchAt)
        #expect(!FileManager.default.fileExists(atPath: ledgerFile))

        clock.now = crashAt + 20.0 * 24.0 * 3_600_000
        #expect(CrashSignatureLedger(store: store).record([old, recent]))
        clock.now = launchAt
        #expect(CrashSignatureLedger(store: store).entries() == [recent])
        let onDisk = try JSONDecoder().decode(CrashSignatureLedgerFile.self, from: Data(contentsOf: URL(fileURLWithPath: ledgerFile)))
        #expect(onDisk.signatures == [recent])
    }

    @Test func aReportNamesTheReleaseThatCrashedNotTheOneUploading() throws {
        let uploader = CrashReportContext(installId: "install-1", platform: "ios", appVersion: "2.0.1 (64)",
                                          osVersion: "iOS 26.1", deviceClass: "phone")
        let uncaught = try json(try #require(CrashReportEventBuilder.event(for: uncaughtObjectiveCCrash(atMillis: 1.0),
                                                                            eventId: "id", context: uploader)))
        #expect((uncaught["properties"] as? [String: Any])?["$app_version"] as? String == "2.0.0 (63)")

        let metricKit = DiagnosticsPayloadFactory.payload(
            kind: .hang, createdAtMillis: 1.0,
            fields: [try #require(DiagnosticsPayloadFactory.text("appVersion", "2.0.0")),
                     try #require(DiagnosticsPayloadFactory.text("appBuild", "63"))],
            detailJSON: "{}"
        )
        let hang = try json(try #require(CrashReportEventBuilder.event(for: metricKit, eventId: "id", context: uploader)))
        #expect((hang["properties"] as? [String: Any])?["$app_version"] as? String == "2.0.0 (63)")

        let unknown = try json(try #require(CrashReportEventBuilder.event(for: crashPayload(), eventId: "id", context: uploader)))
        #expect((unknown["properties"] as? [String: Any])?["$app_version"] as? String == "unknown")
        let unstampedExit = try json(try #require(CrashReportEventBuilder.event(for: exitRecord("anr"), eventId: "id",
                                                                                 context: uploader)))
        #expect((unstampedExit["properties"] as? [String: Any])?["$app_version"] as? String == "unknown")
    }

    @Test func aPathWithSpacesAndDotsNeverLeaksItsDirectories() {
        let cleaned = CrashReportPrivacy.symbol("native: /Users/Jane.Doe Smith/private/libc.so")
        #expect(cleaned == "native: libc.so")
        #expect(CrashReportPrivacy.symbol("native: /Users/Jane.Doe Smith/private/libExample.so") == "native: [path]")
        let frame = CrashReportPrivacy.symbol(
            "#00 pc 0001 /data/app/~~a==/com.acmvit.conclave-b==/lib/arm64/libmediasoupclient_so.so (Produce+8)")
        #expect(frame == "#00 pc 0001 libmediasoupclient_so.so")
        for leaked in ["Jane", "Doe", "Smith", "private", "/data/app"] {
            #expect(!cleaned.contains(leaked) && !frame.contains(leaked), "\(leaked)")
        }
        #expect(CrashReportPrivacy.symbol("kotlin.collections.ArrayList.get") == "kotlin.collections.ArrayList.get")
    }

    @Test func aPathKeepsOnlyALibraryOrBinaryNameAndOtherwiseDropsEverythingAfterIt() {
        let dottedFolder = CrashReportPrivacy.symbol("native: /Users/Jane.Doe Smith")
        #expect(dottedFolder == "native: [path]")
        let spacedLibrary = CrashReportPrivacy.symbol(
            "#03 pc 0004 /data/user/0/com.acmvit.conclave/files/Jane Doe Plugins/libmediasoupclient_so.so (run+4)")
        #expect(spacedLibrary == "#03 pc 0004 libmediasoupclient_so.so")
        let unknownLibrary = CrashReportPrivacy.symbol(
            "#03 pc 0004 /data/user/0/com.acmvit.conclave/files/Jane Doe Plugins/libplugin.so (run+4)")
        #expect(unknownLibrary == "#03 pc 0004 [path]")
        let dottedFile = CrashReportPrivacy.symbol("open /data/user/0/com.acmvit.conclave/files/Jane.Doe Smith.json")
        #expect(dottedFile == "open [path]")
        let relative = CrashReportPrivacy.symbol("load Users/Jane.Doe/notes.txt")
        #expect(relative == "[path]")
        for (text, leaked) in [(dottedFolder, "Jane"), (dottedFolder, "Smith"), (spacedLibrary, "Doe"), (spacedLibrary, "user"),
                               (unknownLibrary, "plugin"), (dottedFile, "Jane"), (dottedFile, "Smith"), (relative, "Jane")] {
            #expect(!text.contains(leaked), "\(leaked) in \(text)")
        }
        #expect(CrashReportPrivacy.symbol("at /System/Library/Frameworks/UIKit.framework/UIKit (run)") == "at UIKit")
        #expect(CrashReportPrivacy.symbol("/private/var/containers/Bundle/Application/A1/Conclave.app/Conclave") == "Conclave")
        #expect(CrashReportPrivacy.symbol("/usr/lib/system/libsystem_kernel.dylib") == "libsystem_kernel.dylib")
    }

    @Test func onlyExactKnownModulesSurviveAndEverythingElseBecomesAPathPlaceholder() throws {
        #expect(CrashReportPrivacy.symbol("native: Users/Jane.Doe Smith") == "[path]")
        #expect(CrashReportPrivacy.symbol("native: /Users/Jane.so Smith") == "native: [path]")
        #expect(CrashReportPrivacy.symbol("native: /data/x/libc.so Smith") == "native: libc.so")
        for name in ["Jane.so", "Jane.Doe", "Jane.so Smith", "/data/user/0/com.acmvit.conclave/libc.so", "libsystem_../x.dylib",
                     "com.google.UserPrivate.dylib", "conclave.module.WebRTCClient"] {
            #expect(CrashReportPrivacy.binaryName(name) == "[path]", "\(name)")
        }
        for name in ["libc.so", "libmediasoupclient_so.so", "Conclave", "UIKitCore", "libsystem_pthread.dylib",
                     "libswift_Concurrency.dylib"] {
            #expect(CrashReportPrivacy.binaryName(name) == name, "\(name)")
        }
        #expect(CrashReportPrivacy.binaryName("Jane Doe") == "[path]")

        let folder = try #require(CrashReportEventBuilder.traceFrame("native: #01 pc 0002 /Users/Jane.so Smith (Jane+4)"))
        #expect(folder.function == "?" && folder.module == "[path]")
        let known = try #require(CrashReportEventBuilder.traceFrame(
            "native: #00 pc 000000000004e8b8  /apex/com.android.runtime/lib64/bionic/libc.so (syscall+28) (BuildId: ab12)"))
        #expect(known.function == "?" && known.module == "libc.so")

        let trace = """
        {"traceLines":["\\"main\\" prio=5 tid=1 Blocked","native: #00 pc 0001 /Users/Jane.so Smith/notes (Jane+1)",\
        "native: #01 pc 0002 Users/Jane.Doe Smith","at conclave.module.WebRTCClient.onProduce(WebRTCClient+Android.kt:7216)"]}
        """
        let text = try #require(CrashReportEventBuilder.event(for: exitRecord("anr", trace: trace), eventId: "id-1",
                                                               context: Self.context))
        #expect(!text.contains("Jane") && !text.contains("Smith") && !text.contains("notes") && !text.contains("/Users"))
        #expect(text.contains("conclave.module.WebRTCClient") && !text.contains("onProduce"))
    }

    /// The ANR an external review captured on a loopback PostHog, with a Unix and a Windows home path and a native
    /// line naming a folder like a library.
    @Test func aReviewedAnrCaptureUploadsNoPrivateText() throws {
        let lines = ["\"main\" prio=5", "at conclave.Camera.start(/Users/Control Name/private/Source.kt:1)",
                     #"at conclave.Camera.start(C:\Users\Cedar Finch\private\Source.kt:1)"#,
                     "native: #01 pc 000123 /Users/lib.so Cedar Finch"]
        let trace = try JSONSerialization.data(withJSONObject: ["traceLines": lines, "message": "CONTROL_SECRET_CHAT",
                                                                "room": "CONTROL_ROOM"])
        let text = try #require(CrashReportEventBuilder.event(for: exitRecord("anr", trace: String(decoding: trace, as: UTF8.self)),
                                                               eventId: "id-1", context: Self.context))
        for leaked in ["Control", "Cedar", "Finch", "CONTROL_SECRET_CHAT", "CONTROL_ROOM", "Users", "private"] {
            #expect(!text.contains(leaked), "\(leaked)")
        }
        let properties = try #require(try json(text)["properties"] as? [String: Any])
        let exception = try #require((properties["$exception_list"] as? [[String: Any]])?.first)
        let frames = try #require((exception["stacktrace"] as? [String: Any])?["frames"] as? [[String: Any]])
        #expect(frames.map { $0["function"] as? String } == ["?", "?", "?"])
        #expect(frames.map { $0["module"] as? String } == ["[path]", "[path]", "[path]"])
        #expect(frames.allSatisfy { $0["filename"] == nil })
    }

    /// A mapping can end in a parenthesized name, so a trailing group is never uploaded as the frame's function.
    @Test func aParenthesizedNameAfterAKnownModuleNeverBecomesTheFunction() throws {
        let mapping = "/data/user/0/com.acmvit.conclave/files/libc.so (Jane Smith)"
        #expect(CrashReportPrivacy.symbol(mapping) == "libc.so")
        let frame = try #require(CrashReportEventBuilder.traceFrame("native: #00 pc 0001 " + mapping))
        #expect(frame.function == "?" && frame.module == "libc.so")
        let trace = try JSONSerialization.data(withJSONObject: ["traceLines": ["\"main\" prio=5 tid=1 Blocked",
                                                                              "native: #00 pc 0001 " + mapping]])
        let text = try #require(CrashReportEventBuilder.event(for: exitRecord("anr", trace: String(decoding: trace, as: UTF8.self)),
                                                               eventId: "id-1", context: Self.context))
        #expect(!text.contains("Jane") && !text.contains("Smith"))
        let properties = try #require(try json(text)["properties"] as? [String: Any])
        let exception = try #require((properties["$exception_list"] as? [[String: Any]])?.first)
        let frames = try #require((exception["stacktrace"] as? [String: Any])?["frames"] as? [[String: Any]])
        #expect(frames.map { $0["function"] as? String } == ["?"] && frames.map { $0["module"] as? String } == ["libc.so"])
    }

    @Test func onlyExactSdkNamesPassForSwiftAndSystemLibraries() {
        for name in ["libswiftReviewFixture.dylib", "libsystem_Jane.dylib", "libswift.dylib", "libsystem_.dylib"] {
            #expect(CrashReportPrivacy.binaryName(name) == "[path]", "\(name)")
            #expect(CrashReportPrivacy.moduleNameFromPath("/usr/lib/swift/" + name) == "[path]", "\(name)")
        }
        for name in ["libswiftCore.dylib", "libswift_Concurrency.dylib", "libsystem_kernel.dylib", "libsystem_pthread.dylib"] {
            #expect(CrashReportPrivacy.binaryName(name) == name, "\(name)")
        }
    }

    /// ANR native lines are free text: every parenthesized group (`(deleted)`, `(offset 0x1234)`, a symbol, a name) is
    /// dropped unread, the frame keeps its pc, and its module is a known one or `[path]`.
    @Test func anrNativeFramesKeepOnlyTheirPcAndAKnownModule() throws {
        let fixtures: [(line: String, module: String, address: String)] = [
            ("native: #00 pc 0001234 /data/app/~~x==/com.acmvit.conclave-y==/base.apk (offset 0x1234) (SomeFunction+12)",
             "base.apk", "0x0001234"),
            ("native: #01 pc 000789 /system/lib64/libc.so (deleted)", "libc.so", "0x000789"),
            ("native: #02 pc 0001 /data/user/0/com.acmvit.conclave/files/libc.so (Jane Smith)", "libc.so", "0x0001"),
            ("native: #03 pc 000456 /usr/lib/swift/libswiftReviewFixture.dylib", "[path]", "0x000456"),
            ("native: #04 pc 0002 Users/Jane.Doe Smith", "[path]", "0x0002"),
            ("native: #05 pc 0003 /Users/Jane.so Smith", "[path]", "0x0003"),
            ("native: #06 pc 0004 a.so room-1234", "[path]", "0x0004"),
        ]
        for fixture in fixtures {
            let frame = try #require(CrashReportEventBuilder.traceFrame(fixture.line))
            #expect(frame.function == "?" && frame.module == fixture.module && frame.address == fixture.address,
                    "\(fixture.line)")
        }
        var lines = ["\"main\" prio=5 tid=1 Blocked"]
        for fixture in fixtures {
            lines.append(fixture.line)
        }
        let trace = try JSONSerialization.data(withJSONObject: ["traceLines": lines])
        let text = try #require(CrashReportEventBuilder.event(for: exitRecord("anr", trace: String(decoding: trace, as: UTF8.self)),
                                                               eventId: "id-1", context: Self.context))
        for leaked in ["Jane", "Smith", "room-1234", "SomeFunction", "deleted", "ReviewFixture", "Users", "offset"] {
            #expect(!text.contains(leaked), "\(leaked)")
        }
        let properties = try #require(try json(text)["properties"] as? [String: Any])
        let exception = try #require((properties["$exception_list"] as? [[String: Any]])?.first)
        let frames = try #require((exception["stacktrace"] as? [String: Any])?["frames"] as? [[String: Any]])
        #expect(frames.count == fixtures.count)
        #expect(frames.last?["module"] as? String == "base.apk" && frames.last?["instruction_addr"] as? String == "0x0001234")
        #expect(frames.allSatisfy { $0["function"] as? String == "?" })
    }

    @Test func theStoreMeasuresRetentionAgainstItsOwnClock() {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("crash-" + UUID().uuidString, isDirectory: true)
        let eightDaysLater = 1_795_000_000_000.0 + 8.0 * 24.0 * 3_600_000.0
        let later = DiagnosticsFileStore(directoryPath: base.appendingPathComponent("later").path,
                                         exportDirectoryPath: base.appendingPathComponent("exports").path,
                                         wallClock: { eightDaysLater })
        #expect(later.writePayload(crashPayload()))
        #expect(later.loadPayloads().isEmpty)
        let store = temporaryStore()
        #expect(store.writePayload(crashPayload()))
        #expect(store.loadPayloads().count == 1)
    }

    @Test func theLedgerForgetsReportsRetentionDeleted() {
        let store = temporaryStore()
        let ledger = CrashReportLedger(store: store)
        #expect(ledger.record(["payload-a.json", "payload-b.json"], present: []))
        #expect(ledger.reportedNames() == ["payload-a.json", "payload-b.json"])
        #expect(ledger.record(["payload-c.json"], present: ["payload-b.json"]))
        #expect(ledger.reportedNames() == ["payload-b.json", "payload-c.json"])
        #expect(store.loadPayloads().isEmpty)
    }

    @Test func theShareCrashReportsSettingDefaultsOnAndPersists() throws {
        let suite = "crash-reports-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(SettingsPreferences.shareCrashReports(defaults: defaults))
        let settings = SettingsPresenter(scope: .app, platform: .ios, defaults: defaults)
        #expect(settings.general.shareCrashReports)
        settings.setShareCrashReports(false)
        #expect(!SettingsPreferences.shareCrashReports(defaults: defaults))
        #expect(!settings.general.shareCrashReports)
        #expect(!CrashReporting.currentConfig(defaults: defaults).userAllows)
    }

    @Test func theInstallIdIsRandomAndStable() throws {
        let suite = "crash-install-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = CrashReporting.installId(defaults: defaults)
        #expect(UUID(uuidString: first) != nil)
        #expect(CrashReporting.installId(defaults: defaults) == first)
    }
}
#endif
