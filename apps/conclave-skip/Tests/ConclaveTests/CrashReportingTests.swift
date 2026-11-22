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

    static let context = CrashReportContext(installId: "install-1", platform: "android", appVersion: "2.0.0 (64)",
                                            osVersion: "Android 16 (API 36)", deviceClass: "phone")

    private func temporaryStore() -> DiagnosticsFileStore {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("crash-" + UUID().uuidString, isDirectory: true)
        return DiagnosticsFileStore(directoryPath: base.appendingPathComponent("store").path,
                                    exportDirectoryPath: base.appendingPathComponent("exports").path)
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
                                     filename: "WebRTCClient+Android.kt", line: 2140, inApp: true),
                    CrashReportFrame(function: "invokeSuspend", module: "conclave.module.MeetingViewModel",
                                     filename: "MeetingViewModel.kt", line: 361, inApp: true),
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
        #expect(frames.map { $0["function"] as? String } == [
            "#00 pc 000000 libc.so (syscall+28)", "onProduce", "joinBlocking",
        ])
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

    @Test func iOSExceptionSymbolsParseIntoFrames() {
        let frames = CrashCaptureRecord.symbolFrames([
            "0   CoreFoundation                      0x00000001804b10ec __exceptionPreprocess + 160",
            "3   Conclave.debug.dylib                0x0000000104a2b1c8 $s8Conclave12CrashCaptureV5forceyyF + 120",
            "short line",
        ])
        #expect(frames.count == 2)
        #expect(frames[0].function == "__exceptionPreprocess" && frames[0].module == "CoreFoundation" && !frames[0].inApp)
        #expect(frames[1].function == "$s8Conclave12CrashCaptureV5forceyyF" && frames[1].inApp)
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
        #expect(frame["module"] as? String == "x.so")
    }

    @Test func pathsKeepOnlyFileNamesAndDropDirectories() {
        #expect(CrashReportPrivacy.symbol("#00 pc 000000 /system/lib64/libc.so (syscall+28)") == "#00 pc 000000 libc.so (syscall+28)")
        #expect(CrashReportPrivacy.symbol("at (/Users/Jane Doe/private/notes") == "at (")
        #expect(!CrashReportPrivacy.symbol("load /Users/Jane").contains("Jane"))
        #expect(CrashReportPrivacy.symbol("conclave.module.WebRTCClient$onProduce$1") == "conclave.module.WebRTCClient$onProduce$1")
    }

    private func uncaughtObjectiveCCrash(atMillis: Double) -> DiagnosticsStoredPayload {
        CrashCaptureRecord.payload(
            exceptions: [CrashReportException(type: "NSInvalidArgumentException", frames: [
                CrashReportFrame(function: "-[ConclaveRoom join]", module: "Conclave", filename: "", line: 0, inApp: true),
            ])],
            breadcrumbs: [], phase: "live", createdAtMillis: atMillis, appVersion: "2.0.0 (63)"
        )
    }

    private func metricKitCrash(name: String, windowStart: Double, delivered: Double) throws -> DiagnosticsStoredPayload {
        DiagnosticsPayloadFactory.payload(
            kind: .crash, createdAtMillis: delivered,
            fields: [
                try #require(DiagnosticsPayloadFactory.text("exceptionName", name)),
                DiagnosticsPayloadFactory.number("signal", 6.0),
                DiagnosticsPayloadFactory.number("windowStartMillis", windowStart),
            ],
            detailJSON: "{}"
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
        #expect(plan.skipped == ["payload-metrickit.json"])

        let alreadySent = CrashReportPlanner.plan(loaded, reported: ["payload-uncaught.json"], projectKey: "phc_test",
                                                  context: Self.context)
        #expect(alreadySent.batches.isEmpty && alreadySent.skipped == ["payload-metrickit.json"])
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
        #expect((unknown["properties"] as? [String: Any])?["$app_version"] as? String == "2.0.1 (64)")
    }

    @Test func aPathWithSpacesAndDotsNeverLeaksItsDirectories() {
        let cleaned = CrashReportPrivacy.symbol("native: /Users/Jane.Doe Smith/private/libExample.so")
        #expect(cleaned == "native: libExample.so")
        let frame = CrashReportPrivacy.symbol(
            "#00 pc 0001 /data/app/~~a==/com.acmvit.conclave-b==/lib/arm64/libmediasoupclient_so.so (Produce+8)")
        #expect(frame == "#00 pc 0001 libmediasoupclient_so.so (Produce+8)")
        for leaked in ["Jane", "Doe", "Smith", "private", "/data/app"] {
            #expect(!cleaned.contains(leaked) && !frame.contains(leaked), "\(leaked)")
        }
        #expect(CrashReportPrivacy.symbol("kotlin.collections.ArrayList.get") == "kotlin.collections.ArrayList.get")
    }

    @Test func aPathKeepsOnlyALibraryOrBinaryNameAndOtherwiseDropsEverythingAfterIt() {
        let dottedFolder = CrashReportPrivacy.symbol("native: /Users/Jane.Doe Smith")
        #expect(dottedFolder == "native:")
        let spacedLibrary = CrashReportPrivacy.symbol(
            "#03 pc 0004 /data/user/0/com.acmvit.conclave/files/Jane Doe Plugins/libplugin.so (run+4)")
        #expect(spacedLibrary == "#03 pc 0004 libplugin.so (run+4)")
        let dottedFile = CrashReportPrivacy.symbol("open /data/user/0/com.acmvit.conclave/files/Jane.Doe Smith.json")
        #expect(dottedFile == "open")
        let relative = CrashReportPrivacy.symbol("load Users/Jane.Doe/notes.txt")
        #expect(relative == "load")
        for (text, leaked) in [(dottedFolder, "Jane"), (dottedFolder, "Smith"), (spacedLibrary, "Doe"), (spacedLibrary, "user"),
                               (dottedFile, "Jane"), (dottedFile, "Smith"), (relative, "Jane")] {
            #expect(!text.contains(leaked), "\(leaked) in \(text)")
        }
        #expect(CrashReportPrivacy.symbol("at /System/Library/Frameworks/UIKit.framework/UIKit (run)") == "at UIKit.framework (run)")
        #expect(CrashReportPrivacy.symbol("/private/var/containers/Bundle/Application/A1/Conclave.app/Conclave") == "Conclave")
        #expect(CrashReportPrivacy.symbol("/usr/lib/system/libsystem_kernel.dylib") == "libsystem_kernel.dylib")
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
