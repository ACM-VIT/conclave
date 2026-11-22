import Foundation

struct CrashReportingConfig: Equatable {
    let projectKey: String
    let host: String
    let isDebugBuild: Bool
    let debugOptIn: Bool
    let userAllows: Bool
}

enum CrashReportingPolicy {
    static let projectKeyKey = "POSTHOG_PROJECT_KEY"
    static let hostKey = "POSTHOG_HOST"
    static let debugOptInKey = "CONCLAVE_CRASH_REPORTS_IN_DEBUG"
    static let defaultHost = "https://eu.i.posthog.com"
    static let batchLimit = 20

    static func endpoint(_ config: CrashReportingConfig) -> String? {
        if !config.userAllows { return nil }
        if config.projectKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        if config.isDebugBuild && !config.debugOptIn { return nil }
        var host = config.host.trimmingCharacters(in: .whitespacesAndNewlines)
        if host.isEmpty { host = defaultHost }
        while host.hasSuffix("/") {
            host = String(host.dropLast())
        }
        let lowered = host.lowercased()
        let isSecure = lowered.hasPrefix("https://") && lowered.count > 8
        let isLocalDebug = config.isDebugBuild && lowered.hasPrefix("http://") && lowered.count > 7
        if !isSecure && !isLocalDebug { return nil }
        return host + "/batch/"
    }
}

struct CrashReportContext: Equatable {
    let installId: String
    let platform: String
    let appVersion: String
    let osVersion: String
    let deviceClass: String
}

struct CrashReportFrame: Equatable {
    let function: String
    let module: String
    let filename: String
    let line: Int
    let inApp: Bool
    /// The frame's program counter (`0x4e8b8`), relative to its image when the source gives that, else empty.
    var address: String = ""
    /// A Java or Kotlin stack trace element, whose module is a class name; every other frame's module is a binary.
    var classFrame: Bool = false
}

struct CrashReportException: Equatable {
    let type: String
    let frames: [CrashReportFrame]
}

/// Character checks alone do not make text safe to upload, so uploads take text fields from a fixed key list and
/// reduce exception names and stack frames to code-symbol characters. Paths fail closed: a frame keeps a module or
/// file name only when it exactly matches a known name, and anything else, such as a user folder, becomes `[path]`.
enum CrashReportPrivacy {
    static let uploadedTextKeys: [String] = [
        "reason", "summaryPhase", "appVersion", "osVersion", "appBuild", "architecture", "exceptionName", "exceptionKind",
    ]
    static let symbolCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.$:<>()[]+-#/ ,?"
    static let maxSymbolLength = 160
    static let pathPlaceholder = "[path]"

    /// Binaries a frame may name: Conclave's own on both platforms, then the system ones crashes pass through.
    static let knownModules: Set<String> = [
        "Conclave", "Conclave.debug.dylib", "Mediasoup", "WebRTC",
        "libmediasoupclient_so.so", "libjingle_peerconnection_so.so", "libdotlottie_player.so", "libdlplayer.so",
        "libandroidx.graphics.path.so", "libimage_processing_util_jni.so", "libsurface_util_jni.so",
        "base.apk", "base.odex", "base.vdex", "base.art",
        "libc.so", "libm.so", "libdl.so", "liblog.so", "libc++.so", "libz.so", "libart.so", "libartbase.so", "libbase.so",
        "libutils.so", "libcutils.so", "libbinder.so", "libbinder_ndk.so", "libandroid_runtime.so", "libandroid.so",
        "libhwui.so", "libgui.so", "libui.so", "libEGL.so", "libGLESv2.so", "libGLESv3.so", "libvulkan.so",
        "libmedia.so", "libmediandk.so", "libaudioclient.so", "libaaudio.so", "libOpenSLES.so", "libcamera2ndk.so",
        "libnativebridge.so", "libnativeloader.so", "libjavacore.so", "libopenjdk.so", "libopenjdkjvm.so",
        "libssl.so", "libcrypto.so", "libsqlite.so", "libicuuc.so", "libicui18n.so", "libunwindstack.so",
        "linker", "linker64", "app_process32", "app_process64",
        "boot.oat", "boot-framework.oat", "boot-core-libart.oat", "framework.jar", "core-oj.jar", "core-libart.jar",
        "UIKit", "UIKitCore", "Foundation", "CoreFoundation", "SwiftUI", "SwiftUICore", "Combine", "QuartzCore",
        "CoreGraphics", "CoreText", "CoreImage", "ImageIO", "Metal", "MetalKit", "CoreVideo", "CoreMedia",
        "AVFoundation", "AVFAudio", "AVKit", "AudioToolbox", "CoreAudio", "MediaToolbox", "VideoToolbox",
        "CoreHaptics", "CallKit", "PushKit", "Network", "CFNetwork", "Security", "MetricKit", "GraphicsServices",
        "FrontBoardServices", "BackBoardServices", "RunningBoardServices", "BaseBoard", "UIFoundation", "Accelerate",
        "dyld", "libobjc.A.dylib", "libdyld.dylib", "libdispatch.dylib", "libc++.1.dylib", "libc++abi.dylib",
        "libxpc.dylib",
    ]
    /// libSystem's re-exported dylibs, exactly as the iOS SDK lists them (`usr/lib/libSystem.B.tbd`).
    static let appleSystemLibraries: Set<String> = [
        "libsystem_asl.dylib", "libsystem_blocks.dylib", "libsystem_c.dylib", "libsystem_collections.dylib",
        "libsystem_configuration.dylib", "libsystem_containermanager.dylib", "libsystem_coreservices.dylib",
        "libsystem_darwin.dylib", "libsystem_darwindirectory.dylib", "libsystem_dnssd.dylib",
        "libsystem_eligibility.dylib", "libsystem_featureflags.dylib", "libsystem_info.dylib",
        "libsystem_kernel.dylib", "libsystem_m.dylib", "libsystem_malloc.dylib", "libsystem_networkextension.dylib",
        "libsystem_notify.dylib", "libsystem_platform.dylib", "libsystem_pthread.dylib", "libsystem_sandbox.dylib",
        "libsystem_sanitizers.dylib", "libsystem_symptoms.dylib", "libsystem_trace.dylib", "libsystem_trial.dylib",
        "libSystem.B.dylib", "libcache.dylib", "libcommonCrypto.dylib", "libcompiler_rt.dylib", "libcopyfile.dylib",
        "libcorecrypto.dylib", "libmacho.dylib", "libremovefile.dylib", "libunwind.dylib",
    ]
    /// The Swift runtime and overlay dylibs, exactly as the iOS SDK ships them (`usr/lib/swift`).
    static let swiftRuntimeLibraries: Set<String> = [
        "libswiftARKit.dylib", "libswiftAVFoundation.dylib", "libswiftAccelerate.dylib",
        "libswiftAppleArchive.dylib", "libswiftAssetsLibrary.dylib", "libswiftCallKit.dylib",
        "libswiftCarPlay.dylib", "libswiftCloudKit.dylib", "libswiftCompatibilitySpan.dylib",
        "libswiftCompression.dylib", "libswiftContacts.dylib", "libswiftCore.dylib", "libswiftCoreAudio.dylib",
        "libswiftCoreData.dylib", "libswiftCoreFoundation.dylib", "libswiftCoreGraphics.dylib",
        "libswiftCoreImage.dylib", "libswiftCoreLocation.dylib", "libswiftCoreMIDI.dylib", "libswiftCoreML.dylib",
        "libswiftCoreMedia.dylib", "libswiftCoreNFC.dylib", "libswiftCryptoTokenKit.dylib", "libswiftDarwin.dylib",
        "libswiftDataDetection.dylib", "libswiftDemangle.dylib", "libswiftDispatch.dylib",
        "libswiftDistributed.dylib", "libswiftExtensionFoundation.dylib", "libswiftExtensionKit.dylib",
        "libswiftFileProvider.dylib", "libswiftFoundation.dylib", "libswiftGLKit.dylib", "libswiftGameplayKit.dylib",
        "libswiftHealthKit.dylib", "libswiftHomeKit.dylib", "libswiftIdentityLookup.dylib", "libswiftIntents.dylib",
        "libswiftMLCompute.dylib", "libswiftMapKit.dylib", "libswiftMediaPlayer.dylib", "libswiftMetal.dylib",
        "libswiftMetalKit.dylib", "libswiftMetricKit.dylib", "libswiftModelIO.dylib",
        "libswiftNaturalLanguage.dylib", "libswiftNearbyInteraction.dylib", "libswiftNetwork.dylib",
        "libswiftOSLog.dylib", "libswiftObjectiveC.dylib", "libswiftObservation.dylib", "libswiftPassKit.dylib",
        "libswiftPencilKit.dylib", "libswiftPhotos.dylib", "libswiftPhotosUI.dylib", "libswiftQuartzCore.dylib",
        "libswiftQuickLook.dylib", "libswiftRegexBuilder.dylib", "libswiftRemoteMirror.dylib",
        "libswiftSceneKit.dylib", "libswiftShazamKit.dylib", "libswiftSoundAnalysis.dylib",
        "libswiftSoundAnalysis_Private.dylib", "libswiftSpatial.dylib", "libswiftSpeech.dylib",
        "libswiftSpriteKit.dylib", "libswiftSwiftOnoneSupport.dylib", "libswiftSynchronization.dylib",
        "libswiftSystem.dylib", "libswiftSystem_Foundation.dylib", "libswiftUIKit.dylib",
        "libswiftUniformTypeIdentifiers.dylib", "libswiftVideoToolbox.dylib", "libswiftVision.dylib",
        "libswiftXPC.dylib", "libswift_Builtin_float.dylib", "libswift_Concurrency.dylib",
        "libswift_DarwinFoundation1.dylib", "libswift_DarwinFoundation2.dylib", "libswift_DarwinFoundation3.dylib",
        "libswift_RegexParser.dylib", "libswift_StringProcessing.dylib", "libswift_Volatile.dylib",
        "libswift_errno.dylib", "libswift_math.dylib", "libswift_signal.dylib", "libswift_stdio.dylib",
        "libswift_time.dylib", "libswiftos.dylib", "libswiftsimd.dylib", "libswiftsys_time.dylib",
        "libswiftunistd.dylib",
    ]
    /// Package roots of the code a Java or Kotlin frame names as its module (`conclave.module.WebRTCClient`).
    static let knownCodePackages: [String] = [
        "java.", "javax.", "jdk.", "sun.", "kotlin.", "kotlinx.", "android.", "androidx.", "com.android.", "dalvik.",
        "libcore.", "org.json.", "org.webrtc.", "org.mediasoup.", "com.mediasfu.", "io.socket.", "okhttp3.", "okio.",
        "com.google.", "com.lottiefiles.", "com.skydoves.", "coil.", "coil3.", "skip.", "conclave.",
    ]
    static let sourceFileSuffixes: [String] = [".kt", ".java", ".swift", ".m", ".mm", ".c", ".cc", ".cpp", ".h"]
    static let knownSourceLocations: [String] = ["Native Method", "Unknown Source", "SourceFile"]
    static let codeNameCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$."
    static let sourceFileCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$+-."
    /// A `/` right after one of these belongs to a relative path, whose start cannot be told from the text around it.
    static let pathWordCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.+-~$"
    static let nameEnders = [" ", "(", ")", "[", "]", ",", "\"", "'", ":", ";", "\t", "\n"]

    static func symbol(_ text: String) -> String {
        var kept = ""
        for character in withoutPaths(text) where symbolCharacters.contains(character) {
            kept += String(character)
        }
        var tokens: [String] = []
        for token in kept.components(separatedBy: " ") where !token.isEmpty {
            tokens.append(token)
        }
        let joined = tokens.joined(separator: " ")
        if joined.contains("/") { return pathPlaceholder }
        return joined.count > maxSymbolLength ? String(joined.prefix(maxSymbolLength)) : joined
    }

    static func isKnownModule(_ name: String) -> Bool {
        knownModules.contains(name) || appleSystemLibraries.contains(name) || swiftRuntimeLibraries.contains(name)
    }

    static let hexCharacters = "0123456789abcdefABCDEF"
    static let hexDigits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"]

    /// Lowercase hex digits of a non-negative offset.
    static func hex(_ value: Int) -> String {
        if value <= 0 { return "0" }
        var rest = value
        var text = ""
        while rest > 0 {
            text = hexDigits[rest % 16] + text
            rest = rest / 16
        }
        return text
    }

    /// `0x` plus the hex digits of a program counter, or empty when the text is not one.
    static func address(_ hex: String) -> String {
        let digits = hex.hasPrefix("0x") ? String(hex.dropFirst(2)) : hex
        if digits.isEmpty || digits.count > 16 { return "" }
        for character in digits where !hexCharacters.contains(character) {
            return ""
        }
        return "0x" + digits
    }

    static func isKnownCodeName(_ name: String) -> Bool {
        if name.contains("..") || name.hasSuffix(".") { return false }
        for character in name where !codeNameCharacters.contains(character) {
            return false
        }
        for root in knownCodePackages where name.hasPrefix(root) {
            return true
        }
        return false
    }

    static func isSourceFileName(_ name: String) -> Bool {
        if knownSourceLocations.contains(name) { return true }
        for character in name where !sourceFileCharacters.contains(character) {
            return false
        }
        for suffix in sourceFileSuffixes where name.count > suffix.count && name.hasSuffix(suffix) {
            return true
        }
        return false
    }

    /// A binary's name (a native, MetricKit or dynamic-linker frame's module): only an exact known module survives.
    static func binaryName(_ name: String) -> String {
        if name.isEmpty || isKnownModule(name) { return name }
        return pathPlaceholder
    }

    /// A Java or Kotlin class frame's module: only a class in a known package survives.
    static func className(_ name: String) -> String {
        if name.isEmpty || isKnownCodeName(name) { return name }
        return pathPlaceholder
    }

    /// A frame's module from the full path of its mapping, never a pre-stripped name: the path must be absolute and
    /// the name after its last separator (`/` or `\`) must be a known module. A bare name must be known itself.
    static func moduleNameFromPath(_ path: String) -> String {
        if path.isEmpty { return "" }
        var characters: [String] = []
        for character in path {
            characters.append(String(character))
        }
        var lastSeparator = -1
        var index = 0
        while index < characters.count {
            if characters[index] == "/" || characters[index] == "\\" { lastSeparator = index }
            index += 1
        }
        if lastSeparator < 0 { return isKnownModule(path) ? path : pathPlaceholder }
        if characters[0] != "/" { return pathPlaceholder }
        var name = ""
        index = lastSeparator + 1
        while index < characters.count {
            name += characters[index]
            index += 1
        }
        return isKnownModule(name) ? name : pathPlaceholder
    }

    static func fileName(_ name: String) -> String {
        if name.isEmpty || isKnownModule(name) || isSourceFileName(name) { return name }
        return pathPlaceholder
    }

    /// Fails closed, counting `\` as a separator like `/`. A relative path's start is unknowable, so its text becomes
    /// `[path]` whole. An absolute path keeps only the name after its last separator, and only when that name is a
    /// known module (a dotted or spaced folder such as `/Users/Jane.so Smith` never is), else `[path]`. Nothing after
    /// the path survives: `libc.so (Jane Smith)` can be one file name, so a trailing group is never read as a symbol.
    static func withoutPaths(_ text: String) -> String {
        var characters: [String] = []
        for character in text {
            characters.append(String(character))
        }
        var firstSlash = -1
        var lastSlash = -1
        var index = 0
        while index < characters.count {
            if characters[index] == "/" || characters[index] == "\\" {
                if firstSlash < 0 { firstSlash = index }
                lastSlash = index
            }
            index += 1
        }
        if firstSlash < 0 { return text }
        if firstSlash > 0 && pathWordCharacters.contains(characters[firstSlash - 1]) { return pathPlaceholder }
        var result = ""
        index = 0
        while index < firstSlash {
            result += characters[index]
            index += 1
        }
        var name = ""
        index = lastSlash + 1
        while index < characters.count && !nameEnders.contains(characters[index]) {
            name += characters[index]
            index += 1
        }
        if !isKnownModule(name) { return result + pathPlaceholder }
        return result + name
    }

    static func frame(_ frame: CrashReportFrame) -> CrashReportFrame {
        CrashReportFrame(function: symbol(frame.function),
                         module: frame.classFrame ? className(frame.module) : binaryName(frame.module),
                         filename: fileName(frame.filename), line: frame.line, inApp: frame.inApp,
                         address: address(frame.address), classFrame: frame.classFrame)
    }
}

enum CrashReportKind: String, Equatable {
    case crash, nativeCrash, appNotResponding, hang, appExit, diagnostic
}

enum CrashReportEventBuilder {
    static let exceptionEvent = "$exception"
    static let appExitEvent = "native_app_exit"
    static let diagnosticEvent = "native_diagnostic"
    static let maxFrames = 64
    static let maxBreadcrumbs = 20

    static let reportedExitReasons: [String] = [
        "crash", "crashNative", "anr", "lowMemory", "excessiveResourceUsage", "initializationFailure",
    ]

    static func kind(of payload: DiagnosticsStoredPayload) -> CrashReportKind? {
        guard let kind = DiagnosticsPayloadKind(rawValue: payload.kind) else { return nil }
        switch kind {
        case .crash:
            return CrashReportKind.crash
        case .hang:
            return CrashReportKind.hang
        case .cpuException, .diskWriteException, .appLaunch:
            return CrashReportKind.diagnostic
        case .exitReason:
            let reason = textField(payload, "reason")
            if !reportedExitReasons.contains(reason) { return nil }
            if reason == "crashNative" { return CrashReportKind.nativeCrash }
            if reason == "anr" { return CrashReportKind.appNotResponding }
            return CrashReportKind.appExit
        }
    }

    static func event(for payload: DiagnosticsStoredPayload, eventId: String, context: CrashReportContext) -> String? {
        guard let kind = kind(of: payload) else { return nil }
        let detail = parseDetail(payload.detailJSON)
        var properties: [String] = baseProperties(payload, kind: kind, context: context)
        let breadcrumbs = breadcrumbCodes(detail)
        if !breadcrumbs.isEmpty {
            properties.append(DiagnosticsJSON.string("breadcrumbs") + ": " + stringArray(breadcrumbs))
        }
        let phase = DiagnosticsRedactionPolicy.sanitizedPhase(detail?["phase"] as? String ?? "")
        let summaryPhase = textField(payload, "summaryPhase")
        let callPhase = summaryPhase.isEmpty ? phase : summaryPhase
        if callPhase != DiagnosticsRedactionPolicy.otherPhase {
            properties.append(DiagnosticsJSON.string("call_phase") + ": " + DiagnosticsJSON.string(callPhase))
        }

        let eventName: String
        switch kind {
        case .crash, .nativeCrash, .appNotResponding, .hang:
            eventName = exceptionEvent
            let level = kind == CrashReportKind.hang ? "error" : "fatal"
            properties.append(DiagnosticsJSON.string("$exception_level") + ": " + DiagnosticsJSON.string(level))
            properties.append(DiagnosticsJSON.string("$exception_list") + ": "
                + exceptionList(exceptions(kind: kind, payload: payload, detail: detail), kind: kind,
                                lang: context.platform == "ios" ? "swift" : "java"))
        case .appExit:
            eventName = appExitEvent
        case .diagnostic:
            eventName = diagnosticEvent
        }

        return "{ " + DiagnosticsJSON.string("event") + ": " + DiagnosticsJSON.string(eventName)
            + ", " + DiagnosticsJSON.string("uuid") + ": " + DiagnosticsJSON.string(eventId)
            + ", " + DiagnosticsJSON.string("distinct_id") + ": " + DiagnosticsJSON.string(context.installId)
            + ", " + DiagnosticsJSON.string("timestamp") + ": "
            + DiagnosticsJSON.string(DiagnosticsTimePolicy.iso8601(epochMillis: payload.createdAtMillis))
            + ", " + DiagnosticsJSON.string("properties") + ": { " + properties.joined(separator: ", ") + " } }"
    }

    static func batch(projectKey: String, events: [String]) -> String {
        "{ " + DiagnosticsJSON.string("api_key") + ": " + DiagnosticsJSON.string(projectKey) + ", "
            + DiagnosticsJSON.string("batch") + ": [" + events.joined(separator: ", ") + "] }"
    }

    /// The UUID PostHog dedupes a retried upload on: the store names each payload `payload-<UUID>.json`.
    static func eventId(forPayloadName name: String) -> String {
        var stem = name
        if stem.hasPrefix(DiagnosticsFileStore.payloadPrefix) {
            stem = String(stem.dropFirst(DiagnosticsFileStore.payloadPrefix.count))
        }
        if stem.hasSuffix(".json") {
            stem = String(stem.dropLast(5))
        }
        return UUID(uuidString: stem)?.uuidString.lowercased() ?? UUID().uuidString.lowercased()
    }

    static func exceptions(kind: CrashReportKind, payload: DiagnosticsStoredPayload,
                           detail: [String: Any]?) -> [CrashReportException] {
        if let captured = capturedExceptions(detail), !captured.isEmpty {
            return captured
        }
        let frames: [CrashReportFrame]
        if let tree = detail, tree["callStacks"] != nil {
            frames = metricKitFrames(tree)
        } else {
            frames = mainThreadTraceFrames(detail)
        }
        return [CrashReportException(type: fallbackType(kind: kind, payload: payload), frames: frames)]
    }

    static func fallbackType(kind: CrashReportKind, payload: DiagnosticsStoredPayload) -> String {
        switch kind {
        case .nativeCrash:
            return "NativeCrash"
        case .appNotResponding:
            return "ApplicationNotResponding"
        case .hang:
            return "AppHang"
        default:
            let name = textField(payload, "exceptionName")
            if !name.isEmpty { return name }
            let signal = numberField(payload, "signal")
            if signal > 0.0 { return "Signal" + DiagnosticsJSON.number(signal) }
            return "Crash"
        }
    }

    static func capturedExceptions(_ detail: [String: Any]?) -> [CrashReportException]? {
        guard let list = detail?["exceptions"] as? [Any] else { return nil }
        var result: [CrashReportException] = []
        for item in list {
            guard let entry = item as? [String: Any], let type = entry["type"] as? String, !type.isEmpty else { continue }
            var frames: [CrashReportFrame] = []
            for rawFrame in entry["frames"] as? [Any] ?? [] {
                guard let frame = rawFrame as? [String: Any] else { continue }
                frames.append(CrashReportFrame(
                    function: frame["function"] as? String ?? "",
                    module: frame["module"] as? String ?? "",
                    filename: frame["filename"] as? String ?? "",
                    line: intValue(frame["line"]),
                    inApp: frame["inApp"] as? Bool ?? false,
                    address: frame["address"] as? String ?? "",
                    classFrame: frame["classFrame"] as? Bool ?? false
                ))
                if frames.count >= maxFrames { break }
            }
            result.append(CrashReportException(type: type, frames: frames))
        }
        return result
    }

    static func metricKitFrames(_ tree: [String: Any]) -> [CrashReportFrame] {
        guard let stacks = tree["callStacks"] as? [Any] else { return [] }
        var chosen: [String: Any]? = nil
        for item in stacks {
            guard let stack = item as? [String: Any] else { continue }
            if chosen == nil { chosen = stack }
            if stack["threadAttributed"] as? Bool == true {
                chosen = stack
                break
            }
        }
        var frames: [CrashReportFrame] = []
        var next = (chosen?["callStackRootFrames"] as? [Any])?.first as? [String: Any]
        while next != nil && frames.count < maxFrames {
            let frame = next ?? [:]
            let binary = CrashReportPrivacy.binaryName(frame["binaryName"] as? String ?? "")
            let offset = intValue(frame["offsetIntoBinaryTextSegment"])
            frames.append(CrashReportFrame(function: binary + " + " + String(offset), module: binary, filename: "",
                                           line: 0, inApp: binary == "Conclave",
                                           address: offset > 0 ? CrashReportPrivacy.address(CrashReportPrivacy.hex(offset)) : ""))
            next = (frame["subFrames"] as? [Any])?.first as? [String: Any]
        }
        return frames
    }

    static func mainThreadTraceFrames(_ detail: [String: Any]?) -> [CrashReportFrame] {
        guard let lines = detail?["traceLines"] as? [Any] else { return [] }
        var frames: [CrashReportFrame] = []
        var inMain = false
        for item in lines {
            guard let line = item as? String else { continue }
            if line.hasPrefix("\"") {
                if inMain { break }
                inMain = line.hasPrefix("\"main\"")
                continue
            }
            if !inMain { continue }
            if let frame = traceFrame(line) {
                frames.append(frame)
                if frames.count >= maxFrames { break }
            }
        }
        return frames
    }

    /// Parses `at a.b.Class.method(File.kt:12)` and `native: #00 pc ... (symbol+8)` trace lines. They are free text, so
    /// a frame from them never carries a function name (`?`); only a function from a structured field (a tombstone's
    /// `function_name`, a stack trace element, a dynamic-linker symbol) is uploaded.
    static func traceFrame(_ line: String) -> CrashReportFrame? {
        if line.hasPrefix("native: ") {
            return nativeTraceFrame(String(line.dropFirst(8)))
        }
        guard line.hasPrefix("at ") else { return nil }
        let body = String(line.dropFirst(3))
        var qualified = body
        var location = ""
        let callParts = body.components(separatedBy: "(")
        if callParts.count >= 2 && body.hasSuffix(")") {
            qualified = callParts[0]
            location = String(callParts.dropFirst().joined(separator: "(").dropLast())
        }
        let nameParts = qualified.components(separatedBy: ".")
        let module = nameParts.count > 1 ? nameParts.dropLast().joined(separator: ".") : ""
        let locationParts = location.components(separatedBy: ":")
        var filename = location
        var lineNumber = 0
        if locationParts.count >= 2 {
            filename = locationParts.dropLast().joined(separator: ":")
            lineNumber = Int(locationParts[locationParts.count - 1]) ?? 0
        }
        return CrashReportFrame(function: unknownFunction, module: module, filename: filename, line: lineNumber,
                                inApp: module.hasPrefix("conclave."), classFrame: true)
    }

    static let unknownFunction = "?"

    /// `#00 pc 000000000004e8b8  /apex/.../libc.so (syscall+28) (BuildId: ab12)`: the frame keeps its pc, and its module
    /// is read from the text before the first ` (` only when that is an absolute path ending in a known module. Every
    /// parenthesized group (`(deleted)`, `(offset 0x1234)`, a symbol) is dropped unread.
    static func nativeTraceFrame(_ body: String) -> CrashReportFrame {
        var parts: [String] = []
        for part in body.components(separatedBy: " ") where !part.isEmpty {
            parts.append(part)
        }
        if parts.count < 4 || !parts[0].hasPrefix("#") || parts[1] != "pc" {
            return CrashReportFrame(function: unknownFunction, module: CrashReportPrivacy.pathPlaceholder, filename: "",
                                    line: 0, inApp: false)
        }
        let mapping = Array(parts.dropFirst(3)).joined(separator: " ").components(separatedBy: " (")[0]
        return CrashReportFrame(function: unknownFunction, module: CrashReportPrivacy.moduleNameFromPath(mapping),
                                filename: "", line: 0, inApp: mapping.contains("com.acmvit.conclave"),
                                address: CrashReportPrivacy.address(parts[2]))
    }

    static func exceptionList(_ exceptions: [CrashReportException], kind: CrashReportKind, lang: String) -> String {
        let mechanism = kind == CrashReportKind.hang || kind == CrashReportKind.appNotResponding ? "freeze" : "crash"
        var parts: [String] = []
        for exception in exceptions {
            var frames: [String] = []
            for frame in exception.frames.reversed() {
                frames.append(frameObject(CrashReportPrivacy.frame(frame), lang: lang))
            }
            parts.append("{ " + DiagnosticsJSON.string("type") + ": "
                + DiagnosticsJSON.string(CrashReportPrivacy.symbol(exception.type))
                + ", " + DiagnosticsJSON.string("value") + ": " + DiagnosticsJSON.string("")
                + ", " + DiagnosticsJSON.string("mechanism") + ": { " + DiagnosticsJSON.string("type") + ": "
                + DiagnosticsJSON.string(mechanism) + ", " + DiagnosticsJSON.string("handled") + ": false, "
                + DiagnosticsJSON.string("synthetic") + ": false }"
                + ", " + DiagnosticsJSON.string("stacktrace") + ": { " + DiagnosticsJSON.string("type") + ": "
                + DiagnosticsJSON.string("raw") + ", " + DiagnosticsJSON.string("frames") + ": ["
                + frames.joined(separator: ", ") + "] } }")
        }
        return "[" + parts.joined(separator: ", ") + "]"
    }

    static func frameObject(_ frame: CrashReportFrame, lang: String) -> String {
        var fields: [String] = [
            DiagnosticsJSON.string("platform") + ": " + DiagnosticsJSON.string("custom"),
            DiagnosticsJSON.string("lang") + ": " + DiagnosticsJSON.string(lang),
            DiagnosticsJSON.string("function") + ": " + DiagnosticsJSON.string(frame.function),
            DiagnosticsJSON.string("resolved") + ": true",
            DiagnosticsJSON.string("in_app") + ": " + (frame.inApp ? "true" : "false"),
        ]
        if !frame.module.isEmpty {
            fields.append(DiagnosticsJSON.string("module") + ": " + DiagnosticsJSON.string(frame.module))
        }
        if !frame.filename.isEmpty {
            fields.append(DiagnosticsJSON.string("filename") + ": " + DiagnosticsJSON.string(frame.filename))
        }
        if frame.line > 0 {
            fields.append(DiagnosticsJSON.string("lineno") + ": " + String(frame.line))
        }
        if !frame.address.isEmpty {
            fields.append(DiagnosticsJSON.string("instruction_addr") + ": " + DiagnosticsJSON.string(frame.address))
        }
        return "{ " + fields.joined(separator: ", ") + " }"
    }

    /// A record whose release was never stamped (an exit from a build before stamping) uploads as this, never as the
    /// uploading release.
    static let unknownAppVersion = "unknown"

    /// The release that was running: stored with the record, or MetricKit's version and build. Empty when unknown.
    static func recordedAppVersion(_ payload: DiagnosticsStoredPayload) -> String {
        let version = textField(payload, "appVersion")
        let build = textField(payload, "appBuild")
        if version.isEmpty || build.isEmpty || version.contains("(") { return version }
        return version + " (" + build + ")"
    }

    /// MetricKit re-reports, a launch or more later, an Objective-C exception the uncaught handler already stored.
    /// It is the same crash only with the same release (version and build), the same exception name, the stored crash
    /// inside MetricKit's reporting window, and the same stack signature. Anything less certain uploads both.
    static func repeatsUncaughtCrash(_ payload: DiagnosticsStoredPayload, uncaught: [DiagnosticsStoredPayload],
                                     sent: [CrashSignatureEntry] = []) -> Bool {
        if payload.kind != DiagnosticsPayloadKind.crash.rawValue || numberField(payload, "uncaught") > 0.0 { return false }
        let name = textField(payload, "exceptionName")
        let windowStart = numberField(payload, "windowStartMillis")
        let release = recordedAppVersion(payload)
        let stack = stackSignature(metricKitFrames(parseDetail(payload.detailJSON) ?? [:])).joined(separator: ",")
        if name.isEmpty || windowStart <= 0.0 || release.isEmpty || stack.isEmpty { return false }
        var originals = sent
        for crash in uncaught {
            if let signature = sentSignature(crash) { originals.append(signature) }
        }
        for original in originals where original.crashedAtMillis >= windowStart
            && original.crashedAtMillis <= payload.createdAtMillis {
            if original.name == name && original.release == release && original.stack == stack { return true }
        }
        return false
    }

    /// What an uploaded uncaught crash leaves in the sent-signature ledger, or nil without a release or app frames.
    static func sentSignature(_ payload: DiagnosticsStoredPayload) -> CrashSignatureEntry? {
        if payload.kind != DiagnosticsPayloadKind.crash.rawValue || numberField(payload, "uncaught") <= 0.0 { return nil }
        let release = recordedAppVersion(payload)
        guard !release.isEmpty, let exception = capturedExceptions(parseDetail(payload.detailJSON))?.first else { return nil }
        let stack = stackSignature(exception.frames)
        if stack.isEmpty { return nil }
        return CrashSignatureEntry(name: exception.type, release: release, stack: stack.joined(separator: ","),
                                   crashedAtMillis: payload.createdAtMillis)
    }

    /// Conclave's own binaries, where an uncaught exception's stack and MetricKit's report of the same crash agree;
    /// the system frames around them differ (MetricKit's stack runs on into the terminate path).
    static let appModules: [String] = ["Conclave", "Conclave.debug.dylib", "Mediasoup", "WebRTC"]

    /// The app frames of a stack as `module@offset`, innermost first, from structured fields only. Empty when the stack
    /// has none, which never matches.
    static func stackSignature(_ frames: [CrashReportFrame]) -> [String] {
        var signature: [String] = []
        for frame in frames where appModules.contains(frame.module) && !frame.address.isEmpty {
            signature.append(frame.module + "@" + frame.address)
        }
        return signature
    }

    static func baseProperties(_ payload: DiagnosticsStoredPayload, kind: CrashReportKind,
                               context: CrashReportContext) -> [String] {
        let crashedVersion = CrashReportPrivacy.symbol(recordedAppVersion(payload))
        var properties: [String] = [
            DiagnosticsJSON.string("$lib") + ": " + DiagnosticsJSON.string("conclave-native"),
            DiagnosticsJSON.string("$process_person_profile") + ": false",
            DiagnosticsJSON.string("$geoip_disable") + ": true",
            DiagnosticsJSON.string("$os") + ": " + DiagnosticsJSON.string(context.platform == "ios" ? "iOS" : "Android"),
            DiagnosticsJSON.string("$os_version") + ": " + DiagnosticsJSON.string(context.osVersion),
            DiagnosticsJSON.string("$app_version") + ": "
                + DiagnosticsJSON.string(crashedVersion.isEmpty ? unknownAppVersion : crashedVersion),
            DiagnosticsJSON.string("platform") + ": " + DiagnosticsJSON.string(context.platform),
            DiagnosticsJSON.string("device_class") + ": " + DiagnosticsJSON.string(context.deviceClass),
            DiagnosticsJSON.string("report_kind") + ": " + DiagnosticsJSON.string(kind.rawValue),
            DiagnosticsJSON.string("diagnostic_kind") + ": " + DiagnosticsJSON.string(payload.kind),
        ]
        for field in payload.fields where DiagnosticsRedactionPolicy.isAllowedKey(field.key) {
            let value: String
            if field.isNumber {
                value = DiagnosticsJSON.number(field.number)
            } else if CrashReportPrivacy.uploadedTextKeys.contains(field.key)
                        && DiagnosticsRedactionPolicy.isAllowedFieldText(field.text) {
                value = DiagnosticsJSON.string(CrashReportPrivacy.symbol(field.text))
            } else {
                continue
            }
            properties.append(DiagnosticsJSON.string("diag_" + field.key) + ": " + value)
        }
        return properties
    }

    static func breadcrumbCodes(_ detail: [String: Any]?) -> [String] {
        guard let list = detail?["breadcrumbs"] as? [Any] else { return [] }
        var codes: [String] = []
        for item in list {
            guard let code = item as? String, DiagnosticsRedactionPolicy.isAllowedCode(code) else { continue }
            codes.append(code)
        }
        while codes.count > maxBreadcrumbs {
            codes.removeFirst()
        }
        return codes
    }

    static func parseDetail(_ json: String) -> [String: Any]? {
        guard DiagnosticsJSON.isRawJSON(json) else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
    }

    static func stringArray(_ values: [String]) -> String {
        var parts: [String] = []
        for value in values {
            parts.append(DiagnosticsJSON.string(value))
        }
        return "[" + parts.joined(separator: ", ") + "]"
    }

    static func textField(_ payload: DiagnosticsStoredPayload, _ key: String) -> String {
        for field in payload.fields where field.key == key && !field.isNumber {
            return field.text
        }
        return ""
    }

    static func numberField(_ payload: DiagnosticsStoredPayload, _ key: String) -> Double {
        for field in payload.fields where field.key == key && field.isNumber {
            return field.number
        }
        return 0.0
    }

    static func intValue(_ value: Any?) -> Int {
        if let number = value as? Int { return number }
        if let number = value as? Double, number.isFinite { return Int(number) }
        if let text = value as? String { return Int(text) ?? 0 }
        return 0
    }
}

/// The crash-time record both platforms' uncaught-exception handlers store, in the shape
/// `CrashReportEventBuilder.capturedExceptions` reads back on the next launch.
enum CrashCaptureRecord {
    static func detailJSON(exceptions: [CrashReportException], breadcrumbs: [String], phase: String) -> String {
        var exceptionParts: [String] = []
        for exception in exceptions {
            var frames: [String] = []
            for frame in exception.frames {
                if frames.count >= CrashReportEventBuilder.maxFrames { break }
                frames.append("{ " + DiagnosticsJSON.string("function") + ": " + DiagnosticsJSON.string(frame.function)
                    + ", " + DiagnosticsJSON.string("module") + ": " + DiagnosticsJSON.string(frame.module)
                    + ", " + DiagnosticsJSON.string("filename") + ": " + DiagnosticsJSON.string(frame.filename)
                    + ", " + DiagnosticsJSON.string("line") + ": " + String(frame.line)
                    + ", " + DiagnosticsJSON.string("inApp") + ": " + (frame.inApp ? "true" : "false")
                    + ", " + DiagnosticsJSON.string("address") + ": " + DiagnosticsJSON.string(frame.address)
                    + ", " + DiagnosticsJSON.string("classFrame") + ": " + (frame.classFrame ? "true" : "false") + " }")
            }
            exceptionParts.append("{ " + DiagnosticsJSON.string("type") + ": " + DiagnosticsJSON.string(exception.type)
                + ", " + DiagnosticsJSON.string("frames") + ": [" + frames.joined(separator: ", ") + "] }")
        }
        var codes: [String] = []
        for code in breadcrumbs where DiagnosticsRedactionPolicy.isAllowedCode(code) {
            codes.append(code)
        }
        while codes.count > CrashReportEventBuilder.maxBreadcrumbs {
            codes.removeFirst()
        }
        return "{ " + DiagnosticsJSON.string("exceptions") + ": [" + exceptionParts.joined(separator: ", ") + "], "
            + DiagnosticsJSON.string("breadcrumbs") + ": " + CrashReportEventBuilder.stringArray(codes) + ", "
            + DiagnosticsJSON.string("phase") + ": "
            + DiagnosticsJSON.string(DiagnosticsRedactionPolicy.sanitizedPhase(phase)) + " }"
    }

    #if !SKIP
    /// Frames for an exception's return addresses. The image path and symbol come from the dynamic linker (`dladdr`),
    /// never from parsing `callStackSymbols` text; the image counts only when its full path ends in a known module.
    static func addressFrames(_ addresses: [NSNumber]) -> [CrashReportFrame] {
        var frames: [CrashReportFrame] = []
        for number in addresses {
            if frames.count >= CrashReportEventBuilder.maxFrames { break }
            var info = Dl_info()
            guard let address = UnsafeRawPointer(bitPattern: number.uintValue), dladdr(address, &info) != 0 else {
                frames.append(CrashReportFrame(function: CrashReportEventBuilder.unknownFunction,
                                               module: CrashReportPrivacy.pathPlaceholder, filename: "", line: 0, inApp: false))
                continue
            }
            let image = info.dli_fname.map { String(cString: $0) } ?? ""
            let module = CrashReportPrivacy.moduleNameFromPath(image)
            let symbol = info.dli_sname.map { String(cString: $0) } ?? CrashReportEventBuilder.unknownFunction
            let base = UInt(bitPattern: info.dli_fbase)
            let pc = UInt(bitPattern: address)
            let offset = base > 0 && pc >= base ? CrashReportPrivacy.address(String(pc - base, radix: 16)) : ""
            frames.append(CrashReportFrame(function: symbol, module: module, filename: "", line: 0,
                                           inApp: module.hasPrefix("Conclave"), address: offset))
        }
        return frames
    }
    #endif

    static func payload(exceptions: [CrashReportException], breadcrumbs: [String], phase: String,
                        createdAtMillis: Double, appVersion: String = "") -> DiagnosticsStoredPayload {
        var fields: [DiagnosticsField] = [DiagnosticsPayloadFactory.number("uncaught", 1.0)]
        if let version = DiagnosticsPayloadFactory.text("appVersion", appVersion) {
            fields.append(version)
        }
        return DiagnosticsPayloadFactory.payload(kind: DiagnosticsPayloadKind.crash, createdAtMillis: createdAtMillis,
                                          fields: fields,
                                          detailJSON: detailJSON(exceptions: exceptions, breadcrumbs: breadcrumbs,
                                                                 phase: phase))
    }
}

struct CrashReportLedgerFile: Codable, Equatable {
    let names: [String]
}

final class CrashReportLedger {
    static let fileName = "reported-payloads.json"

    let store: DiagnosticsFileStore

    init(store: DiagnosticsFileStore) {
        self.store = store
    }

    func reportedNames() -> [String] {
        guard let data = try? Data(contentsOf: store.fileURL(CrashReportLedger.fileName)),
              let file = try? JSONDecoder().decode(CrashReportLedgerFile.self, from: data) else { return [] }
        return file.names
    }

    @discardableResult
    func record(_ names: [String], present: [String]) -> Bool {
        var kept: [String] = []
        for name in reportedNames() where present.contains(name) && !kept.contains(name) {
            kept.append(name)
        }
        for name in names where !kept.contains(name) {
            kept.append(name)
        }
        guard store.ensureDirectory(store.directoryPath),
              let data = try? JSONEncoder().encode(CrashReportLedgerFile(names: kept)) else { return false }
        do {
            try data.write(to: store.fileURL(CrashReportLedger.fileName), options: Data.WritingOptions.atomic)
            return true
        } catch {
            return false
        }
    }
}

struct CrashReportBatch: Equatable {
    let body: String
    let names: [String]
    /// Signatures of the uncaught crashes in this batch, recorded once it is delivered.
    let signatures: [CrashSignatureEntry]
}

/// A crash already sent: exception name, release, app-frame stack signature, and when it happened.
struct CrashSignatureEntry: Codable, Equatable {
    let name: String
    let release: String
    let stack: String
    let crashedAtMillis: Double
}

struct CrashSignatureLedgerFile: Codable, Equatable {
    let signatures: [CrashSignatureEntry]
}

/// Signatures of sent uncaught crashes, kept 30 days (longer than MetricKit takes to deliver a report) whatever
/// happens to the payloads, so a MetricKit copy that arrives after its original was pruned is still recognized.
final class CrashSignatureLedger {
    static let fileName = "sent-crash-signatures.json"
    static let retentionMillis: Double = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0

    let store: DiagnosticsFileStore

    init(store: DiagnosticsFileStore) {
        self.store = store
    }

    func entries() -> [CrashSignatureEntry] {
        guard let data = try? Data(contentsOf: store.fileURL(CrashSignatureLedger.fileName)),
              let file = try? JSONDecoder().decode(CrashSignatureLedgerFile.self, from: data) else { return [] }
        let now = store.wallClock()
        var kept: [CrashSignatureEntry] = []
        for entry in file.signatures where now - entry.crashedAtMillis <= CrashSignatureLedger.retentionMillis {
            kept.append(entry)
        }
        return kept
    }

    @discardableResult
    func record(_ signatures: [CrashSignatureEntry]) -> Bool {
        var kept = entries()
        for signature in signatures where !kept.contains(signature) {
            kept.append(signature)
        }
        guard store.ensureDirectory(store.directoryPath),
              let data = try? JSONEncoder().encode(CrashSignatureLedgerFile(signatures: kept)) else { return false }
        do {
            try data.write(to: store.fileURL(CrashSignatureLedger.fileName), options: Data.WritingOptions.atomic)
            return true
        } catch {
            return false
        }
    }
}

enum CrashReportPlanner {
    /// `skipped` lists payloads with nothing worth reporting, so the ledger stops reconsidering them. A MetricKit repeat
    /// of a stored uncaught crash goes in `duplicates` instead: the uploader deletes it, so it cannot upload once the
    /// original expires, and it is never recorded as sent.
    static func plan(_ loaded: [DiagnosticsLoadedPayload], reported: [String], sent: [CrashSignatureEntry] = [],
                     projectKey: String, context: CrashReportContext) -> CrashReportPlan {
        var batches: [CrashReportBatch] = []
        var signatures: [CrashSignatureEntry] = []
        var skipped: [String] = []
        var duplicates: [String] = []
        var events: [String] = []
        var names: [String] = []
        var uncaught: [DiagnosticsStoredPayload] = []
        for item in loaded where CrashReportEventBuilder.numberField(item.payload, "uncaught") > 0.0 {
            uncaught.append(item.payload)
        }
        for item in loaded where !reported.contains(item.name) {
            if CrashReportEventBuilder.repeatsUncaughtCrash(item.payload, uncaught: uncaught, sent: sent) {
                duplicates.append(item.name)
                continue
            }
            guard let event = CrashReportEventBuilder.event(
                for: item.payload,
                eventId: CrashReportEventBuilder.eventId(forPayloadName: item.name),
                context: context
            ) else {
                skipped.append(item.name)
                continue
            }
            events.append(event)
            names.append(item.name)
            if let signature = CrashReportEventBuilder.sentSignature(item.payload) { signatures.append(signature) }
            if events.count >= CrashReportingPolicy.batchLimit {
                batches.append(CrashReportBatch(body: CrashReportEventBuilder.batch(projectKey: projectKey, events: events),
                                                names: names, signatures: signatures))
                events = []
                names = []
                signatures = []
            }
        }
        if !events.isEmpty {
            batches.append(CrashReportBatch(body: CrashReportEventBuilder.batch(projectKey: projectKey, events: events),
                                            names: names, signatures: signatures))
        }
        return CrashReportPlan(batches: batches, skipped: skipped, duplicates: duplicates)
    }
}

struct CrashReportPlan: Equatable {
    let batches: [CrashReportBatch]
    let skipped: [String]
    let duplicates: [String]
}
